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

    it('keeps different meters and different months as separate rows', () => {
        const rows = [
            dailyRow({ meter_name: 'WHG 1', reading_date: '2026-08-01' }),
            dailyRow({ meter_name: 'WHG 2', reading_date: '2026-08-01' }),
            dailyRow({ meter_name: 'WHG 1', reading_date: '2026-09-01' }),
        ];
        const result = aggregateMeterRowsByMonth(rows);
        expect(result).to.have.lengthOf(3);
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
        ]);

        // header row + 1 aggregated data row
        expect(meterSheet.rowCount).to.equal(2);
        const dataRow = meterSheet.getRow(2).values.slice(1);
        expect(dataRow).to.deep.equal([2026, 'August', 'WHG 1', 6, 0.2, 4, 0.28, 2.32]);
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
