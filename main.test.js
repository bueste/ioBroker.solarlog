'use strict';

const { expect } = require('chai');
const { selfConsumptionRatio, isBillableMeter } = require('./lib/billing');

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

// Only apartment/common-area consumption meters are billed - inverters (WR*) measure
// production, not consumption, and "Gesamt" is a building-wide total that would double
// count against the individual apartment rows.
describe('isBillableMeter', () => {
    it('accepts "WHG <number>" apartment meters', () => {
        expect(isBillableMeter('WHG 1')).to.equal(true);
        expect(isBillableMeter('WHG 12')).to.equal(true);
    });

    it('accepts the common-area meter "Allgemein"', () => {
        expect(isBillableMeter('Allgemein')).to.equal(true);
    });

    it('rejects inverter meters (WR*)', () => {
        expect(isBillableMeter('WR 1')).to.equal(false);
        expect(isBillableMeter('WR 2')).to.equal(false);
        expect(isBillableMeter('WR 9')).to.equal(false);
    });

    it('rejects the building-wide total "Gesamt"', () => {
        expect(isBillableMeter('Gesamt')).to.equal(false);
    });

    it('rejects anything not matching the exact expected naming', () => {
        expect(isBillableMeter('WHG')).to.equal(false);
        expect(isBillableMeter('whg 1')).to.equal(false);
        expect(isBillableMeter('')).to.equal(false);
    });
});
