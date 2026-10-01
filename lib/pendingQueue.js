'use strict';

// Offline buffer for daily billing rows (meter_daily + building_daily) that could not be
// written to MariaDB at the nightly run (tunnel/Cyon down, pool not up, ...). Pure
// functions only (no adapter/DB access) so the behaviour is unit-testable; main.js owns
// persistence (a JSON string in the Database.pendingRows state) and the delivery loop.
//
// Entry shape: { date: 'YYYY-MM-DD', meterRows: [...], buildingRow: {...}, queuedAt: ISO }
// At most one entry per date (a re-queued date replaces the older one), kept sorted by
// date so they are delivered oldest-first. Entries older than MAX_AGE_DAYS are dropped
// by prune() and reported to the caller so it can log a loud warning instead of
// silently losing billing data.

const MAX_AGE_DAYS = 90;

/** @param {string|null|undefined} json */
function parseQueue(json) {
    if (!json) {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed.filter(
        e => e && typeof e.date === 'string' && Array.isArray(e.meterRows) && e.buildingRow && typeof e.buildingRow === 'object',
    );
}

/** @returns {object[]} new array, one entry per date, sorted ascending by date */
function enqueue(queue, entry) {
    const byDate = new Map(queue.map(e => [e.date, e]));
    byDate.set(entry.date, { ...entry, queuedAt: entry.queuedAt || new Date().toISOString() });
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** @returns {object[]} new array without the delivered date */
function remove(queue, date) {
    return queue.filter(e => e.date !== date);
}

function ageInDays(dateStr, todayStr) {
    const [y1, m1, d1] = dateStr.split('-').map(Number);
    const [y2, m2, d2] = todayStr.split('-').map(Number);
    // UTC arithmetic on the calendar dates only - DST shifts must not change a day count.
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * @param {object[]} queue
 * @param {string} todayStr 'YYYY-MM-DD' (local)
 * @param {number} [maxAgeDays]
 * @returns {{kept: object[], dropped: object[]}}
 */
function prune(queue, todayStr, maxAgeDays = MAX_AGE_DAYS) {
    const kept = [];
    const dropped = [];
    for (const e of queue) {
        (ageInDays(e.date, todayStr) > maxAgeDays ? dropped : kept).push(e);
    }
    return { kept, dropped };
}

function serializeQueue(queue) {
    return JSON.stringify(queue);
}

module.exports = { MAX_AGE_DAYS, parseQueue, enqueue, remove, prune, serializeQueue, ageInDays };
