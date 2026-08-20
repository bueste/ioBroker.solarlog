'use strict';

/**
 * @param {number} n
 */
function pad2(n) {
    return String(n).padStart(2, '0');
} // END pad2

/**
 * @param {Date} d
 */
function fmt(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
} // END fmt

/**
 * @param {number} year
 * @param {number} month0 0-based month (0=January)
 */
function lastDayOfMonth(year, month0) {
    return new Date(year, month0 + 1, 0).getDate();
} // END lastDayOfMonth

/**
 * Decides whether a scheduled report should be sent on the given day, and for which
 * date range. Pure/deterministic (takes "today" as an argument) so it's fully unit
 * testable without depending on the real clock. Called once/day; returns null on every
 * day that isn't the configured cutoff day, or isn't the start of the relevant period
 * for quarterly/yearly schedules.
 *
 * @param {Date} today
 * @param {"monthly"|"quarterly"|"yearly"} schedule
 * @param {number} cutoffDay day-of-month (1-31) on which to send. Clamped to the actual
 *   number of days in the current month, so e.g. 31 reliably means "the last day of the
 *   month" every month, including February - not just in 31-day months.
 * @returns {{fromDate: string, toDate: string, label: string}|null}
 */
function determineScheduledPeriod(today, schedule, cutoffDay) {
    const effectiveCutoff = Math.min(cutoffDay, lastDayOfMonth(today.getFullYear(), today.getMonth()));
    if (today.getDate() !== effectiveCutoff) {
        return null;
    }
    const y = today.getFullYear();
    const m = today.getMonth(); // 0-based

    if (schedule === 'monthly') {
        const to = new Date(y, m, 0); // last day of the previous month
        const from = new Date(to.getFullYear(), to.getMonth(), 1);
        return { fromDate: fmt(from), toDate: fmt(to), label: `${from.getFullYear()}-${pad2(from.getMonth() + 1)}` };
    }

    if (schedule === 'quarterly') {
        if (m % 3 !== 0) {
            return null; // only fire in the first month of a new quarter (Jan/Apr/Jul/Oct)
        }
        const to = new Date(y, m, 0); // last day of the just-finished quarter
        const from = new Date(to.getFullYear(), to.getMonth() - 2, 1);
        const quarter = Math.floor(from.getMonth() / 3) + 1;
        return { fromDate: fmt(from), toDate: fmt(to), label: `${from.getFullYear()}-Q${quarter}` };
    }

    if (schedule === 'yearly') {
        if (m !== 0) {
            return null; // only fire in January
        }
        const prevYear = y - 1;
        return { fromDate: `${prevYear}-01-01`, toDate: `${prevYear}-12-31`, label: `${prevYear}` };
    }

    return null;
} // END determineScheduledPeriod

module.exports = { determineScheduledPeriod };
