'use strict';

const { expect } = require('chai');
const { selfConsumptionRatio } = require('./lib/billing');

// Swiss ZEV proportional self-consumption allocation: every apartment meter's own
// consumption is split solar/grid using the same building-wide ratio for that day,
// since Solar-Log has no way to attribute individual electrons to a meter.
describe('selfConsumptionRatio', () => {
    it('is 100% when production covers or exceeds consumption', () => {
        expect(selfConsumptionRatio(5000, 3000)).to.equal(1);
        expect(selfConsumptionRatio(3000, 3000)).to.equal(1);
    });

    it('is the production/consumption fraction when production is lower', () => {
        expect(selfConsumptionRatio(1500, 3000)).to.equal(0.5);
        expect(selfConsumptionRatio(0, 3000)).to.equal(0);
    });

    it('is 0 when there is no consumption to allocate against (avoids division by zero)', () => {
        expect(selfConsumptionRatio(5000, 0)).to.equal(0);
        expect(selfConsumptionRatio(5000, null)).to.equal(0);
        expect(selfConsumptionRatio(5000, undefined)).to.equal(0);
    });

    it('never exceeds 100% even with implausible input (production >> consumption)', () => {
        const ratio = selfConsumptionRatio(1_000_000, 100);
        expect(ratio).to.equal(1);
    });
});
