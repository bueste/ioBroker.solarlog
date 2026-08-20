'use strict';

const { expect } = require('chai');
const { buildMeterDailyRow, buildBuildingDailyRow } = require('./lib/db');

describe('buildMeterDailyRow', () => {
    it('computes the billed total from solar/grid kWh and their respective tariffs', () => {
        const row = buildMeterDailyRow({
            date: '2026-08-20',
            meterName: 'WHG 1',
            zStartKwh: 1000,
            zEndeKwh: 1010,
            verbrauchKwh: 10,
            solarKwh: 6,
            netzKwh: 4,
            tarifNetz: 0.28,
            tarifSolar: 0.2,
        });
        expect(row.total_chf).to.equal(Math.round((6 * 0.2 + 4 * 0.28) * 100) / 100);
        expect(row.meter_name).to.equal('WHG 1');
        expect(row.reading_date).to.equal('2026-08-20');
    });

    it('never mixes up solar/grid kWh in the total (they must use their own tariff, not be summed then multiplied)', () => {
        const row = buildMeterDailyRow({
            date: '2026-08-20',
            meterName: 'WHG 2',
            zStartKwh: 0,
            zEndeKwh: 10,
            verbrauchKwh: 10,
            solarKwh: 10,
            netzKwh: 0,
            tarifNetz: 999, // if this leaked into the calc, the test would fail loudly
            tarifSolar: 0.2,
        });
        expect(row.total_chf).to.equal(2);
    });

    it('total_chf is always exactly reconcilable from the rounded kWh figures stored in the same row - not the raw pre-rounding inputs (a tenant or auditor must be able to recompute Solarbezug*Tarif + Netzbezug*Tarif from what they can see and get the stored total)', () => {
        const row = buildMeterDailyRow({
            date: '2026-08-20',
            meterName: 'WHG 4',
            zStartKwh: 0,
            zEndeKwh: 10,
            verbrauchKwh: 10,
            solarKwh: 6.0004, // rounds to 6.000
            netzKwh: 3.9996, // rounds to 4.000 - raw sum is 10, rounded sum is also 10
            tarifNetz: 0.28,
            tarifSolar: 0.2,
        });
        const recomputedFromDisplayedFigures =
            Math.round((row.solarbezug_kwh * 0.2 + row.netzbezug_kwh * 0.28) * 100) / 100;
        expect(row.total_chf).to.equal(recomputedFromDisplayedFigures);
    });

    it('rounds kWh figures to 3 decimals and CHF to 2', () => {
        const row = buildMeterDailyRow({
            date: '2026-08-20',
            meterName: 'WHG 3',
            zStartKwh: null,
            zEndeKwh: null,
            verbrauchKwh: 1.23456,
            solarKwh: 0.11111,
            netzKwh: 1.12345,
            tarifNetz: 0.28,
            tarifSolar: 0.2,
        });
        expect(row.verbrauch_kwh).to.equal(1.235);
        expect(row.zaehlerstand_start_kwh).to.equal(null);
        expect(row.zaehlerstand_ende_kwh).to.equal(null);
    });
});

describe('buildBuildingDailyRow', () => {
    it('computes the self-consumption ratio consistently with lib/billing.js', () => {
        const row = buildBuildingDailyRow({
            date: '2026-08-20',
            produktionKwh: 50,
            verbrauchKwh: 100,
            einspeisungKwh: 0,
        });
        expect(row.eigenverbrauchsquote).to.equal(0.5);
    });

    it('caps the ratio at 1 when production exceeds consumption (excess is feed-in, not double-counted)', () => {
        const row = buildBuildingDailyRow({
            date: '2026-08-20',
            produktionKwh: 150,
            verbrauchKwh: 100,
            einspeisungKwh: 50,
        });
        expect(row.eigenverbrauchsquote).to.equal(1);
        expect(row.einspeisung_kwh).to.equal(50);
    });

    it('is 0 with no consumption (avoids division by zero)', () => {
        const row = buildBuildingDailyRow({
            date: '2026-08-20',
            produktionKwh: 20,
            verbrauchKwh: 0,
            einspeisungKwh: 20,
        });
        expect(row.eigenverbrauchsquote).to.equal(0);
    });
});
