'use strict';

const { expect } = require('chai');
const ExcelJS = require('exceljs');
const { buildReportWorkbook, buildReportFileName } = require('./lib/report');

describe('buildReportFileName', () => {
    it('builds a descriptive, filesystem-safe name', () => {
        expect(buildReportFileName('monthly', '2026-08')).to.equal('abrechnung_monthly_2026-08.xlsx');
    });

    it('sanitizes characters that are unsafe in filenames', () => {
        expect(buildReportFileName('quarterly', '2026 Q3/x')).to.equal('abrechnung_quarterly_2026_Q3_x.xlsx');
    });
});

describe('buildReportWorkbook', () => {
    it('produces a readable .xlsx with the expected sheets and row counts', async () => {
        const meterRows = [
            {
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
            },
        ];
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
        // header row + 1 data row
        expect(meterSheet.rowCount).to.equal(2);
        expect(buildingSheet.rowCount).to.equal(2);
        expect(meterSheet.getRow(2).getCell(1).value).to.equal('WHG 1');
        expect(meterSheet.getRow(2).getCell(10).value).to.equal(2.32);
    });
});
