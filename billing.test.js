'use strict';

const { expect } = require('chai');
const { deviceDataQuality, STALE_THRESHOLD_MS, isBillableMeter } = require('./lib/billing');

describe('deviceDataQuality', () => {
    const now = Date.UTC(2026, 8, 30, 21, 58);

    it('is ok while the last successful poll is recent', () => {
        expect(deviceDataQuality(now - 30 * 1000, now)).to.equal('ok');
        expect(deviceDataQuality(now - STALE_THRESHOLD_MS, now)).to.equal('ok');
    });

    it('is veraltet once the last poll is older than the threshold', () => {
        expect(deviceDataQuality(now - STALE_THRESHOLD_MS - 1, now)).to.equal('veraltet');
        expect(deviceDataQuality(now - 5 * 3600 * 1000, now)).to.equal('veraltet');
    });

    it('is veraltet when there is no usable poll timestamp at all', () => {
        expect(deviceDataQuality(null, now)).to.equal('veraltet');
        expect(deviceDataQuality(undefined, now)).to.equal('veraltet');
        expect(deviceDataQuality('abc', now)).to.equal('veraltet');
        expect(deviceDataQuality(0, now)).to.equal('veraltet');
    });

    it('accepts a numeric string as ioBroker may hand it back', () => {
        expect(deviceDataQuality(String(now - 1000), now)).to.equal('ok');
    });
});

describe('isBillableMeter', () => {
    it('bills apartments and Allgemein only', () => {
        expect(isBillableMeter('WHG 1')).to.equal(true);
        expect(isBillableMeter('Allgemein')).to.equal(true);
        expect(isBillableMeter('WR 1')).to.equal(false);
        expect(isBillableMeter('Gesamt')).to.equal(false);
    });
});
