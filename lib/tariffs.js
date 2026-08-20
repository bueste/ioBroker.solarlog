'use strict';

const MAX_RANGE_MONTHS = 240; // 20 years - generous, but a hard cap against a UI slip

/**
 * Enumerates every (year, month) pair from fromYear/fromMonth through toYear/toMonth,
 * inclusive, in chronological order. Pure function - used by both the bulk tariff-set
 * message handler (main.js) and its tests.
 *
 * @param {number} fromYear
 * @param {number} fromMonth 1-12
 * @param {number} toYear
 * @param {number} toMonth 1-12
 * @returns {{year: number, month: number}[]} empty array if the range is invalid/reversed/too large
 */
function enumerateMonthRange(fromYear, fromMonth, toYear, toMonth) {
    if (
        !Number.isInteger(fromYear) ||
        !Number.isInteger(toYear) ||
        !Number.isInteger(fromMonth) ||
        !Number.isInteger(toMonth) ||
        fromMonth < 1 ||
        fromMonth > 12 ||
        toMonth < 1 ||
        toMonth > 12
    ) {
        return [];
    }
    const fromIndex = fromYear * 12 + (fromMonth - 1);
    const toIndex = toYear * 12 + (toMonth - 1);
    if (toIndex < fromIndex) {
        return [];
    }
    if (toIndex - fromIndex + 1 > MAX_RANGE_MONTHS) {
        return [];
    }
    const result = [];
    for (let i = fromIndex; i <= toIndex; i++) {
        result.push({ year: Math.floor(i / 12), month: (i % 12) + 1 });
    }
    return result;
} // END enumerateMonthRange

module.exports = { enumerateMonthRange, MAX_RANGE_MONTHS };
