'use strict';

const { expect } = require('chai');
const { formatSwissDate, formatGermanPeriodLabel, GERMAN_MONTH_NAMES } = require('./lib/dates');

describe('formatSwissDate', () => {
    it('converts ISO YYYY-MM-DD to Swiss DD-MM-YYYY', () => {
        expect(formatSwissDate('2026-08-31')).to.equal('31-08-2026');
    });

    it('handles single-digit-looking (already zero-padded) days/months correctly', () => {
        expect(formatSwissDate('2026-01-05')).to.equal('05-01-2026');
    });
});

describe('formatGermanPeriodLabel', () => {
    it('converts a monthly "YYYY-MM" label to a spelled-out German month/year', () => {
        expect(formatGermanPeriodLabel('2026-08')).to.equal('August 2026');
        expect(formatGermanPeriodLabel('2026-01')).to.equal('Januar 2026');
        expect(formatGermanPeriodLabel('2026-12')).to.equal('Dezember 2026');
    });

    it('leaves a quarterly "YYYY-Qn" label unchanged', () => {
        expect(formatGermanPeriodLabel('2026-Q3')).to.equal('2026-Q3');
    });

    it('leaves a yearly "YYYY" label unchanged', () => {
        expect(formatGermanPeriodLabel('2026')).to.equal('2026');
    });
});

describe('GERMAN_MONTH_NAMES', () => {
    it('has exactly 12 entries, January through December', () => {
        expect(GERMAN_MONTH_NAMES).to.have.lengthOf(12);
        expect(GERMAN_MONTH_NAMES[0]).to.equal('Januar');
        expect(GERMAN_MONTH_NAMES[11]).to.equal('Dezember');
    });
});
