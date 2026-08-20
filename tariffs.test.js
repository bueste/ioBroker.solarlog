'use strict';

const { expect } = require('chai');
const { enumerateMonthRange } = require('./lib/tariffs');

describe('enumerateMonthRange', () => {
    it('enumerates a range within the same year', () => {
        const result = enumerateMonthRange(2026, 8, 2026, 11);
        expect(result).to.deep.equal([
            { year: 2026, month: 8 },
            { year: 2026, month: 9 },
            { year: 2026, month: 10 },
            { year: 2026, month: 11 },
        ]);
    });

    it('enumerates a range that crosses a year boundary', () => {
        const result = enumerateMonthRange(2026, 11, 2027, 2);
        expect(result).to.deep.equal([
            { year: 2026, month: 11 },
            { year: 2026, month: 12 },
            { year: 2027, month: 1 },
            { year: 2027, month: 2 },
        ]);
    });

    it('returns a single month when from equals to', () => {
        expect(enumerateMonthRange(2026, 8, 2026, 8)).to.deep.equal([{ year: 2026, month: 8 }]);
    });

    it('returns an empty array when the range is reversed', () => {
        expect(enumerateMonthRange(2026, 8, 2026, 1)).to.deep.equal([]);
        expect(enumerateMonthRange(2027, 1, 2026, 12)).to.deep.equal([]);
    });

    it('returns an empty array for an out-of-bounds month', () => {
        expect(enumerateMonthRange(2026, 0, 2026, 5)).to.deep.equal([]);
        expect(enumerateMonthRange(2026, 1, 2026, 13)).to.deep.equal([]);
    });

    it('returns an empty array for a non-integer year/month', () => {
        expect(enumerateMonthRange(2026.5, 1, 2026, 5)).to.deep.equal([]);
    });

    it('rejects a range larger than the sanity cap (guards against a UI typo bulk-editing decades)', () => {
        expect(enumerateMonthRange(2000, 1, 2030, 12)).to.deep.equal([]); // 372 months
    });
});
