'use strict';

const ExcelJS = require('exceljs');
const { isBillableMeter } = require('./billing');
const { GERMAN_MONTH_NAMES } = require('./dates');

const METER_HEADERS = [
    'Jahr',
    'Monat',
    'Wohnung',
    'Solarstrombezug kWh',
    'Tarif Solarstrom CHF/kWh',
    'Netzbezug kWh',
    'Tarif Netzbezug CHF/kWh',
    'Total Bezug CHF',
    'Umlagekosten CHF',
    'Umlagekosten Details',
    'Total inkl. Umlagekosten CHF',
];

const BUILDING_HEADERS = ['Datum', 'Produktion kWh', 'Verbrauch kWh', 'Einspeisung kWh', 'Eigenverbrauchsquote'];

/**
 * Aggregates the daily meter_daily rows (one row per meter per day) up to one row per
 * meter per calendar month - the granularity a tenant billing report is actually meant
 * to show. Tariffs are set per calendar month (see main.js getTariffsForMonth()), so
 * every daily row within the same (year, month, meter) group always carries the same
 * tarif_netz/tarif_solar - taking the last one is safe, not an approximation. Silently
 * drops any row for a non-billable meter (WR*, "Gesamt") as a defensive second filter,
 * in addition to the one already applied where rows are written to MariaDB.
 *
 * @param {object[]} meterRows rows shaped like lib/db.js buildMeterDailyRow() output
 * @param {object[]} [umlagekostenRows] rows shaped like lib/db.js queryMeterUmlagekostenPeriod()
 *   output (reading_year, reading_month, meter_name, bezeichnung, umlagekosten_chf,
 *   active) - itemized flat monthly costs added on top of the energy-based total. A row
 *   with reading_year=0/reading_month=0 is a standing default applied to every month for
 *   that meter+Bezeichnung, overridden by an explicit same-month row if one exists (see
 *   the merge below). Passing nothing keeps prior behaviour (no Umlagekosten line/columns
 *   are populated).
 * @returns {object[]} one row per {year, month, meterName}, sorted by year/month/meterName
 */
function aggregateMeterRowsByMonth(meterRows, umlagekostenRows = []) {
    const groups = new Map();
    for (const r of meterRows) {
        if (!isBillableMeter(r.meter_name)) {
            continue;
        }
        const { year, month } = yearMonthOf(r.reading_date);
        const key = `${year}-${month}-${r.meter_name}`;
        if (!groups.has(key)) {
            groups.set(key, {
                year,
                month,
                meterName: r.meter_name,
                solarbezugKwh: 0,
                netzbezugKwh: 0,
                tarifSolar: Number(r.tarif_solar),
                tarifNetz: Number(r.tarif_netz),
                umlagekostenItems: [],
            });
        }
        const g = groups.get(key);
        g.solarbezugKwh += Number(r.solarbezug_kwh) || 0;
        g.netzbezugKwh += Number(r.netzbezug_kwh) || 0;
        // Tariffs are set per calendar month (see main.js getTariffsForMonth()), so every
        // daily row in the same (year, month, meter) group already carries the same
        // tarif_netz/tarif_solar - this isn't an approximation, just picking up the value.
        g.tarifSolar = Number(r.tarif_solar);
        g.tarifNetz = Number(r.tarif_netz);
    }

    // Umlagekosten are a flat MONTHLY cost, not tied to a specific day, so they're
    // attached once per (year, month, meter) group here rather than during the daily
    // loop above. A meter/month can have several itemized lines (see lib/db.js
    // meter_umlagekosten's composite primary key) - all active ones are summed into the
    // group's total and also kept as a human-readable "Bezeichnung: CHF, ..." string so
    // the report line stays auditable, not just a single opaque number.
    //
    // umlagekostenRows mixes two kinds of rows (see queryMeterUmlagekostenPeriod()):
    // standing defaults (reading_year=0, reading_month=0 - apply to every month for that
    // meter+Bezeichnung, same idea as Tarif.default) and explicit month-specific rows. A
    // default applies to every REAL group below for its meter; an explicit row for the
    // exact same meter+Bezeichnung+month then overrides the default's amount for that one
    // month (keyed by Bezeichnung so a *different* Bezeichnung is simply an additional
    // line, not a replacement) - lets a specific month be topped up or corrected without
    // touching the standing default itself.
    const defaultsByMeter = new Map(); // meterName -> Map(bezeichnung -> betrag)
    const explicitByKey = new Map(); // "${year}-${month}-${meterName}" -> Map(bezeichnung -> betrag)
    for (const u of umlagekostenRows) {
        if (!u.active) {
            continue;
        }
        const betrag = Number(u.umlagekosten_chf);
        if (Number(u.reading_year) === 0 && Number(u.reading_month) === 0) {
            if (!defaultsByMeter.has(u.meter_name)) {
                defaultsByMeter.set(u.meter_name, new Map());
            }
            defaultsByMeter.get(u.meter_name).set(u.bezeichnung, betrag);
        } else {
            const key = `${u.reading_year}-${u.reading_month}-${u.meter_name}`;
            if (!explicitByKey.has(key)) {
                explicitByKey.set(key, new Map());
            }
            explicitByKey.get(key).set(u.bezeichnung, betrag);
        }
    }
    for (const [key, g] of groups) {
        // Umlagekosten exist for a meter/month that has no energy-billing row at all
        // (e.g. set for a period with no meter_daily data yet) - nothing to attach a
        // default/override TO in that case; groups only ever contains real energy rows,
        // so that case simply never reaches this loop, same as before this change.
        const items = new Map(defaultsByMeter.get(g.meterName) || []);
        for (const [bezeichnung, betrag] of explicitByKey.get(key) || []) {
            items.set(bezeichnung, betrag);
        }
        for (const [bezeichnung, betrag] of items) {
            g.umlagekostenItems.push({ bezeichnung, betrag });
        }
    }

    // total_chf is derived here from the ROUNDED monthly kWh sums (round3, same helper
    // buildReportWorkbook uses for display) rather than summed from each day's own
    // pre-rounded total_chf. Tariffs are constant across a calendar month, so in exact
    // arithmetic both approaches agree - but summing ~30 independently-rounded daily CHF
    // amounts can drift a few Rappen from what you get multiplying the DISPLAYED monthly
    // kWh by the tariff. A billing report must show a total that reconciles exactly with
    // its own displayed usage figures, the way a real utility bill does.
    for (const g of groups.values()) {
        g.solarbezugKwh = round3(g.solarbezugKwh);
        g.netzbezugKwh = round3(g.netzbezugKwh);
        g.totalChf = round2(g.solarbezugKwh * g.tarifSolar + g.netzbezugKwh * g.tarifNetz);
        g.umlagekostenChf = round2(g.umlagekostenItems.reduce((sum, item) => sum + item.betrag, 0));
        g.umlagekostenDetails =
            g.umlagekostenItems.length > 0
                ? g.umlagekostenItems.map(item => `${item.bezeichnung}: ${item.betrag.toFixed(2)}`).join(', ')
                : null;
        g.totalMitUmlagekostenChf = round2(g.totalChf + g.umlagekostenChf);
    }
    return [...groups.values()].sort(
        (a, b) => a.year - b.year || a.month - b.month || a.meterName.localeCompare(b.meterName),
    );
} // END aggregateMeterRowsByMonth

/**
 * meter_daily.reading_date is a SQL DATE column - the mariadb driver hands it back as a
 * real JS Date object (in local time, at midnight), not the "YYYY-MM-DD" string used when
 * writing rows. Unit tests (and any other future caller) may reasonably pass either shape,
 * so this accepts both instead of assuming one.
 *
 * @param {Date|string} readingDate
 * @returns {{year: number, month: number}} month is 1-based
 */
function yearMonthOf(readingDate) {
    if (readingDate instanceof Date) {
        return { year: readingDate.getFullYear(), month: readingDate.getMonth() + 1 };
    }
    const str = String(readingDate);
    return { year: Number(str.slice(0, 4)), month: Number(str.slice(5, 7)) };
} // END yearMonthOf

/**
 * Formats a reading_date (Date object OR "YYYY-MM-DD" string - see yearMonthOf() for
 * why both shapes occur) as a plain "YYYY-MM-DD" string using LOCAL date parts
 * (getFullYear/getMonth/getDate), not UTC ones.
 *
 * Bug this fixes: passing the raw Date object straight into ExcelJS's addRow() used to
 * write it as a native Excel date cell - but ExcelJS serializes a JS Date using its UTC
 * fields, and the mariadb driver hands back reading_date as LOCAL midnight (see
 * yearMonthOf's docblock). In Europe/Zurich summer time (UTC+2), local midnight is
 * 22:00 UTC the PREVIOUS day, so every date in the Gebaeude sheet was silently shown one
 * day too early (e.g. 2026-08-20 rendered as 2026-08-19) - verified live against a known
 * row. Writing a plain string sidesteps the ambiguity entirely (also matches how the web
 * app's PHP report renders the same column, byte-for-byte, since both webapp and adapter
 * reports are meant to be the same document - see docs/ARCHITECTURE.md).
 */
function formatDateForSheet(readingDate) {
    if (readingDate instanceof Date) {
        const y = readingDate.getFullYear();
        const m = String(readingDate.getMonth() + 1).padStart(2, '0');
        const d = String(readingDate.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(readingDate).slice(0, 10);
} // END formatDateForSheet

/**
 * Builds an .xlsx workbook (two sheets: per-apartment monthly billing rows, building-wide
 * daily summary) from MariaDB row objects. Pure function - no file I/O, no DB, no adapter
 * dependency - returns a Buffer ready for adapter.writeFileAsync() or an email attachment.
 *
 * @param {object[]} meterRows rows shaped like lib/db.js buildMeterDailyRow() output
 * @param {object[]} buildingRows rows shaped like lib/db.js buildBuildingDailyRow() output
 * @param {object} meta
 * @param {string} meta.title sheet/workbook title, e.g. "Abrechnung August 2026"
 * @param {string} [meta.fromDate]
 * @param {string} [meta.toDate]
 * @param {object[]} [umlagekostenRows] see aggregateMeterRowsByMonth() - omit to leave
 *   the Umlagekosten columns at 0/empty (previous behaviour).
 * @returns {Promise<Buffer>}
 */
async function buildReportWorkbook(meterRows, buildingRows, meta, umlagekostenRows = []) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ioBroker.solarlog';
    workbook.created = new Date();

    const meterSheet = workbook.addWorksheet('Abrechnung');
    meterSheet.addRow(METER_HEADERS).font = { bold: true };
    for (const r of aggregateMeterRowsByMonth(meterRows, umlagekostenRows)) {
        // r already carries fully rounded, self-reconciling figures - see the rounding
        // step at the end of aggregateMeterRowsByMonth().
        meterSheet.addRow([
            r.year,
            GERMAN_MONTH_NAMES[r.month - 1],
            r.meterName,
            r.solarbezugKwh,
            r.tarifSolar,
            r.netzbezugKwh,
            r.tarifNetz,
            r.totalChf,
            r.umlagekostenChf,
            r.umlagekostenDetails,
            r.totalMitUmlagekostenChf,
        ]);
    }
    meterSheet.columns.forEach(col => {
        col.width = 22;
    });

    const buildingSheet = workbook.addWorksheet('Gebaeude');
    buildingSheet.addRow(BUILDING_HEADERS).font = { bold: true };
    for (const r of buildingRows) {
        buildingSheet.addRow([
            formatDateForSheet(r.reading_date),
            r.produktion_kwh,
            r.verbrauch_kwh,
            r.einspeisung_kwh,
            r.eigenverbrauchsquote,
        ]);
    }
    buildingSheet.columns.forEach(col => {
        col.width = 20;
    });

    if (meta && meta.title) {
        meterSheet.headerFooter = { oddHeader: `&C${meta.title}` };
    }

    return workbook.xlsx.writeBuffer();
} // END buildReportWorkbook

function round3(n) {
    return Math.round(n * 1000) / 1000;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

/**
 * Builds a filesystem-safe, self-explanatory report filename.
 *
 * @param {"manual"|"monthly"|"quarterly"|"yearly"} kind
 * @param {string} periodLabel e.g. "2026-08", "2026-Q3", "2026"
 */
function buildReportFileName(kind, periodLabel) {
    const safeLabel = periodLabel.replace(/[^a-zA-Z0-9-]/g, '_');
    return `abrechnung_${kind}_${safeLabel}.xlsx`;
} // END buildReportFileName

module.exports = { buildReportWorkbook, buildReportFileName, aggregateMeterRowsByMonth };
