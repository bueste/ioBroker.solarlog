'use strict';

const { expect } = require('chai');
const ExcelJS = require('exceljs');
const { buildReportWorkbook, buildReportFileName, aggregateMeterRowsByMonth } = require('./lib/report');

describe('buildReportFileName', () => {
    it('builds a descriptive, filesystem-safe name', () => {
        expect(buildReportFileName('monthly', '2026-08')).to.equal('abrechnung_monthly_2026-08.xlsx');
    });

    it('sanitizes characters that are unsafe in filenames', () => {
        expect(buildReportFileName('quarterly', '2026 Q3/x')).to.equal('abrechnung_quarterly_2026_Q3_x.xlsx');
    });
});

function dailyRow(overrides) {
    return {
        meter_name: 'WHG 1',
        reading_date: '2026-08-01',
        zaehlerstand_start_kwh: 100,
        zaehlerstand_ende_kwh: 110,
        verbrauch_kwh: 10,
        solarbezug_kwh: 6,
        netzbezug_kwh: 4,
        tarif_netz: 0.28,
        tarif_solar: 0.2,
        total_chf: 2.32,
        ...overrides,
    };
}

describe('aggregateMeterRowsByMonth', () => {
    it('sums multiple daily rows for the same meter/month into one row', () => {
        const rows = [
            dailyRow({ reading_date: '2026-08-01', solarbezug_kwh: 6, netzbezug_kwh: 4, total_chf: 2.32 }),
            dailyRow({ reading_date: '2026-08-02', solarbezug_kwh: 5, netzbezug_kwh: 3, total_chf: 1.84 }),
        ];
        const result = aggregateMeterRowsByMonth(rows);
        expect(result).to.have.lengthOf(1);
        expect(result[0]).to.include({ year: 2026, month: 8, meterName: 'WHG 1' });
        expect(result[0].solarbezugKwh).to.equal(11);
        expect(result[0].netzbezugKwh).to.equal(7);
        expect(result[0].totalChf).to.be.closeTo(4.16, 1e-9);
    });

    it('the monthly Total Bezug CHF always reconciles exactly with the displayed monthly Solarstrombezug/Netzbezug kWh figures - it is NOT just the sum of each day\'s own (independently rounded) total_chf, which can drift from the correct monthly total', () => {
        // 4 days of 0.125 kWh at a 0.1 CHF/kWh tariff: each day's OWN total_chf rounds
        // down to 0.01 (0.125*0.1=0.0125 -> 0.01), so naively summing daily totals gives
        // 0.04 - but the correct monthly figure, from the actual monthly kWh (0.5) times
        // the tariff, is 0.05. A report showing 0.04 next to "0.5 kWh x 0.1 CHF/kWh" would
        // not reconcile and would be indefensible to a tenant or auditor doing the maths.
        const rows = [
            dailyRow({ reading_date: '2026-08-01', solarbezug_kwh: 0.125, netzbezug_kwh: 0, tarif_solar: 0.1, total_chf: 0.01 }),
            dailyRow({ reading_date: '2026-08-02', solarbezug_kwh: 0.125, netzbezug_kwh: 0, tarif_solar: 0.1, total_chf: 0.01 }),
            dailyRow({ reading_date: '2026-08-03', solarbezug_kwh: 0.125, netzbezug_kwh: 0, tarif_solar: 0.1, total_chf: 0.01 }),
            dailyRow({ reading_date: '2026-08-04', solarbezug_kwh: 0.125, netzbezug_kwh: 0, tarif_solar: 0.1, total_chf: 0.01 }),
        ];
        const result = aggregateMeterRowsByMonth(rows);
        expect(result).to.have.lengthOf(1);
        expect(result[0].solarbezugKwh).to.equal(0.5);
        expect(result[0].totalChf).to.equal(0.05); // correct: 0.5 * 0.1
        expect(result[0].totalChf).to.not.equal(0.04); // what naively summing daily totals would give
    });

    it('keeps different meters and different months as separate rows', () => {
        const rows = [
            dailyRow({ meter_name: 'WHG 1', reading_date: '2026-08-01' }),
            dailyRow({ meter_name: 'WHG 2', reading_date: '2026-08-01' }),
            dailyRow({ meter_name: 'WHG 1', reading_date: '2026-09-01' }),
        ];
        const result = aggregateMeterRowsByMonth(rows);
        expect(result).to.have.lengthOf(3);
    });

    it('handles reading_date as a real Date object, not just a string (this is what the mariadb driver actually returns for a SQL DATE column)', () => {
        const rows = [dailyRow({ reading_date: new Date(2026, 7, 20) })]; // August 20 2026, JS months are 0-based
        const result = aggregateMeterRowsByMonth(rows);
        expect(result).to.have.lengthOf(1);
        expect(result[0]).to.include({ year: 2026, month: 8 });
    });

    it('drops non-billable meters (inverters, building total) even if they somehow ended up in the data', () => {
        const rows = [
            dailyRow({ meter_name: 'WHG 1' }),
            dailyRow({ meter_name: 'WR 1' }),
            dailyRow({ meter_name: 'WR 9' }),
            dailyRow({ meter_name: 'Gesamt' }),
            dailyRow({ meter_name: 'Allgemein' }),
        ];
        const result = aggregateMeterRowsByMonth(rows);
        expect(result.map(r => r.meterName).sort()).to.deep.equal(['Allgemein', 'WHG 1']);
    });
});

describe('buildReportWorkbook', () => {
    it('produces the exact requested columns: Jahr, Monat (spelled out), Wohnung, Solarstrombezug, Tarif Solarstrom, Netzbezug, Tarif Netzbezug, Total Bezug CHF', async () => {
        const meterRows = [dailyRow()];
        const buildingRows = [
            {
                reading_date: '2026-08-01',
                produktion_kwh: 50,
                verbrauch_kwh: 100,
                einspeisung_kwh: 0,
                eigenverbrauchsquote: 0.5,
            },
        ];

        const buffer = await buildReportWorkbook(meterRows, buildingRows, { title: 'Test Report' });
        expect(buffer).to.be.instanceOf(Buffer);
        expect(buffer.length).to.be.greaterThan(0);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const meterSheet = workbook.getWorksheet('Abrechnung');
        const buildingSheet = workbook.getWorksheet('Gebaeude');
        expect(meterSheet).to.exist;
        expect(buildingSheet).to.exist;

        const headerRow = meterSheet.getRow(1).values.slice(1);
        expect(headerRow).to.deep.equal([
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
        ]);

        // header row + 1 aggregated data row
        expect(meterSheet.rowCount).to.equal(2);
        const dataRow = meterSheet.getRow(2).values.slice(1);
        // Umlagekosten CHF and Total inkl. Umlagekosten CHF are checked exactly; the
        // Details cell is checked separately below because ExcelJS represents an empty
        // cell inconsistently depending on access pattern (null vs [null] vs undefined) -
        // not meaningful to this test, which only cares that it's empty.
        expect(dataRow.slice(0, 9)).to.deep.equal([2026, 'August', 'WHG 1', 6, 0.2, 4, 0.28, 2.32, 0]);
        expect(dataRow[10]).to.equal(2.32); // Total inkl. Umlagekosten CHF
        const detailsCell = dataRow[9];
        const isEmpty = detailsCell === null || detailsCell === undefined || detailsCell === '' ||
            (Array.isArray(detailsCell) && detailsCell.every(v => v === null || v === undefined));
        expect(isEmpty, `expected Umlagekosten Details cell to be empty, got ${JSON.stringify(detailsCell)}`).to.be.true;
    });

    it('adds itemized Umlagekosten lines to their Total Bezug CHF, keeping a human-readable details string, when umlagekostenRows are passed', async () => {
        const meterRows = [dailyRow()];
        const umlagekostenRows = [
            { reading_year: 2026, reading_month: 8, meter_name: 'WHG 1', bezeichnung: 'Zaehlerkosten', umlagekosten_chf: 5, active: true },
            { reading_year: 2026, reading_month: 8, meter_name: 'WHG 1', bezeichnung: 'Allgemeinstrom-Anteil', umlagekosten_chf: 12.5, active: true },
            // Inactive - must NOT be added.
            { reading_year: 2026, reading_month: 8, meter_name: 'WHG 1', bezeichnung: 'Storniert', umlagekosten_chf: 999, active: false },
        ];

        const buffer = await buildReportWorkbook(meterRows, [], { title: 'Test Report' }, umlagekostenRows);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const meterSheet = workbook.getWorksheet('Abrechnung');
        const dataRow = meterSheet.getRow(2).values.slice(1);
        // total_chf (2.32) + 5 + 12.5 = 19.82, the inactive 999 line must not be included.
        expect(dataRow[8]).to.equal(17.5); // Umlagekosten CHF
        expect(dataRow[9]).to.equal('Zaehlerkosten: 5.00, Allgemeinstrom-Anteil: 12.50'); // Details
        expect(dataRow[10]).to.equal(19.82); // Total inkl. Umlagekosten CHF
    });

    it('never shifts the Gebaeude sheet date by a day (regression: writing the raw local-midnight Date object let ExcelJS serialize it via UTC fields, silently rendering e.g. 2026-08-20 as 2026-08-19 in Europe/Zurich summer time)', async () => {
        const buildingRows = [
            {
                // Local midnight, exactly what the mariadb driver hands back for a DATE column.
                reading_date: new Date(2026, 7, 20, 0, 0, 0),
                produktion_kwh: 32.605,
                verbrauch_kwh: 59.312,
                einspeisung_kwh: 12.032,
                eigenverbrauchsquote: 0.3469,
            },
        ];
        const buffer = await buildReportWorkbook([], buildingRows, { title: 'Test Report' });
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const buildingSheet = workbook.getWorksheet('Gebaeude');
        const dataRow = buildingSheet.getRow(2).values.slice(1);
        expect(dataRow[0]).to.equal('2026-08-20');
    });

    it('also handles a plain "YYYY-MM-DD" string reading_date (e.g. from a test fixture, not the live mariadb driver) without shifting it', async () => {
        const buildingRows = [
            { reading_date: '2026-08-20', produktion_kwh: 32.605, verbrauch_kwh: 59.312, einspeisung_kwh: 12.032, eigenverbrauchsquote: 0.3469 },
        ];
        const buffer = await buildReportWorkbook([], buildingRows, { title: 'Test Report' });
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const buildingSheet = workbook.getWorksheet('Gebaeude');
        const dataRow = buildingSheet.getRow(2).values.slice(1);
        expect(dataRow[0]).to.equal('2026-08-20');
    });

    it('never puts a non-billable meter (WR*, Gesamt) into the Abrechnung sheet', async () => {
        const meterRows = [dailyRow({ meter_name: 'WHG 1' }), dailyRow({ meter_name: 'WR 1' })];
        const buffer = await buildReportWorkbook(meterRows, [], {});
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const meterSheet = workbook.getWorksheet('Abrechnung');
        // header row + 1 data row only (WR 1 dropped)
        expect(meterSheet.rowCount).to.equal(2);
        expect(meterSheet.getRow(2).getCell(3).value).to.equal('WHG 1');
    });
});
