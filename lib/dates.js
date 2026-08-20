'use strict';

// Switzerland uses DD-MM-YYYY (or a spelled-out "August 2026"), never ISO "2026-08-01",
// for anything a tenant or property manager actually reads. Internal storage/DB queries
// keep using ISO "YYYY-MM-DD" throughout the codebase (it sorts correctly, MariaDB DATE
// columns expect it) - these helpers are only for formatting values for display.

const GERMAN_MONTH_NAMES = [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
];

/**
 * @param {string} isoDate "YYYY-MM-DD"
 * @returns {string} "DD-MM-YYYY"
 */
function formatSwissDate(isoDate) {
    const [y, m, d] = String(isoDate).split('-');
    return `${d}-${m}-${y}`;
} // END formatSwissDate

/**
 * @param {string} periodLabel "YYYY-MM" (monthly), "YYYY-Qn" (quarterly), or "YYYY" (yearly)
 *   - the shapes lib/scheduling.js determineScheduledPeriod() produces.
 * @returns {string} e.g. "August 2026", "2026-Q3" (quarters have no natural German name,
 *   left as-is), or "2026"
 */
function formatGermanPeriodLabel(periodLabel) {
    const monthMatch = /^(\d{4})-(\d{2})$/.exec(periodLabel);
    if (monthMatch) {
        const monthIndex = Number(monthMatch[2]) - 1;
        return `${GERMAN_MONTH_NAMES[monthIndex]} ${monthMatch[1]}`;
    }
    return periodLabel;
} // END formatGermanPeriodLabel

module.exports = { GERMAN_MONTH_NAMES, formatSwissDate, formatGermanPeriodLabel };
