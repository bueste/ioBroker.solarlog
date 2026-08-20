'use strict';

const ExcelJS = require('exceljs');

const METER_HEADERS = [
    'Wohnung',
    'Datum',
    'Zaehlerstand Anfang kWh',
    'Zaehlerstand Ende kWh',
    'Verbrauch kWh',
    'Solarbezug kWh',
    'Netzbezug kWh',
    'Tarif Netz CHF/kWh',
    'Tarif Solar CHF/kWh',
    'Total CHF',
];

const BUILDING_HEADERS = ['Datum', 'Produktion kWh', 'Verbrauch kWh', 'Einspeisung kWh', 'Eigenverbrauchsquote'];

/**
 * Builds an .xlsx workbook (two sheets: per-meter billing rows, building-wide daily
 * summary) from MariaDB row objects. Pure function - no file I/O, no DB, no adapter
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
    for (const r of meterRows) {
        meterSheet.addRow([
            r.meter_name,
            r.reading_date,
            r.zaehlerstand_start_kwh,
            r.zaehlerstand_ende_kwh,
            r.verbrauch_kwh,
            r.solarbezug_kwh,
            r.netzbezug_kwh,
            r.tarif_netz,
            r.tarif_solar,
            r.total_chf,
        ]);
    }
    meterSheet.columns.forEach(col => {
        col.width = 20;
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

module.exports = { buildReportWorkbook, buildReportFileName };
