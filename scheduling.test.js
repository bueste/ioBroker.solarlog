'use strict';

const { expect } = require('chai');
const { determineScheduledPeriod } = require('./lib/scheduling');

describe('determineScheduledPeriod', () => {
    it('returns null on any day that is not the configured cutoff day', () => {
        expect(determineScheduledPeriod(new Date(2026, 8, 4), 'monthly', 5)).to.equal(null);
    });

    describe('monthly', () => {
        it('reports the previous full month on the cutoff day', () => {
            const result = determineScheduledPeriod(new Date(2026, 8, 5), 'monthly', 5); // Sep 5
            expect(result).to.deep.equal({ fromDate: '2026-08-01', toDate: '2026-08-31', label: '2026-08' });
        });

        it('handles the year boundary correctly', () => {
            const result = determineScheduledPeriod(new Date(2026, 0, 5), 'monthly', 5); // Jan 5
            expect(result).to.deep.equal({ fromDate: '2025-12-01', toDate: '2025-12-31', label: '2025-12' });
        });
    });

    describe('quarterly', () => {
        it('only fires in the first month of a quarter', () => {
            expect(determineScheduledPeriod(new Date(2026, 1, 5), 'quarterly', 5)).to.equal(null); // February
        });

        it('reports the previous quarter on the cutoff day of a quarter-start month', () => {
            const result = determineScheduledPeriod(new Date(2026, 3, 5), 'quarterly', 5); // April 5 -> Q1
            expect(result).to.deep.equal({ fromDate: '2026-01-01', toDate: '2026-03-31', label: '2026-Q1' });
        });

        it('handles the year boundary (January reports Q4 of the previous year)', () => {
            const result = determineScheduledPeriod(new Date(2026, 0, 5), 'quarterly', 5);
            expect(result).to.deep.equal({ fromDate: '2025-10-01', toDate: '2025-12-31', label: '2025-Q4' });
        });
    });

    describe('yearly', () => {
        it('only fires in January', () => {
            expect(determineScheduledPeriod(new Date(2026, 5, 5), 'yearly', 5)).to.equal(null);
        });

        it('reports the previous full year in January', () => {
            const result = determineScheduledPeriod(new Date(2026, 0, 5), 'yearly', 5);
            expect(result).to.deep.equal({ fromDate: '2025-01-01', toDate: '2025-12-31', label: '2025' });
        });
    });

    describe('cutoffDay 31 ("last day of the month")', () => {
        it('fires on the 31st in a 31-day month', () => {
            const result = determineScheduledPeriod(new Date(2026, 7, 31), 'monthly', 31); // Aug 31
            expect(result).to.not.equal(null);
        });

        it('fires on the 30th in a 30-day month (clamped, not skipped)', () => {
            const result = determineScheduledPeriod(new Date(2026, 8, 30), 'monthly', 31); // Sep 30
            expect(result).to.not.equal(null);
        });

        it('fires on the 28th in February of a non-leap year (clamped)', () => {
            const result = determineScheduledPeriod(new Date(2026, 1, 28), 'monthly', 31); // Feb 28, 2026 (not a leap year)
            expect(result).to.not.equal(null);
        });

        it('fires on the 29th in February of a leap year (clamped)', () => {
            const result = determineScheduledPeriod(new Date(2028, 1, 29), 'monthly', 31); // Feb 29, 2028 (leap year)
            expect(result).to.not.equal(null);
        });

        it('does not fire twice in the same month (e.g. not also on the 30th when clamped to 28)', () => {
            expect(determineScheduledPeriod(new Date(2026, 1, 27), 'monthly', 31)).to.equal(null);
            expect(determineScheduledPeriod(new Date(2026, 2, 1), 'monthly', 31)).to.equal(null);
        });
    });
});
