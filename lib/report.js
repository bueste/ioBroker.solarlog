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
 * @returns {object[]} one row per {year, month, meterName}, sorted by year/month/meterName
 */
function aggregateMeterRowsByMonth(meterRows) {
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
 * @returns {Promise<Buffer>}
 */
async function buildReportWorkbook(meterRows, buildingRows, meta) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ioBroker.solarlog';
    workbook.created = new Date();

    const meterSheet = workbook.addWorksheet('Abrechnung');
    meterSheet.addRow(METER_HEADERS).font = { bold: true };
    for (const r of aggregateMeterRowsByMonth(meterRows)) {
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
        ]);
    }
    meterSheet.columns.forEach(col => {
        col.width = 22;
    });

    const buildingSheet = workbook.addWorksheet('Gebaeude');
    buildingSheet.addRow(BUILDING_HEADERS).font = { bold: true };
    for (const r of buildingRows) {
        buildingSheet.addRow([
            r.reading_date,
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
