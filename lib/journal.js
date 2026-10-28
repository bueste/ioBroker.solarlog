'use strict';

// Local daily journal (state Database.dailyJournal): the finished billing rows of the last days, kept
// independently of MariaDB. The adapter iobroker.abrechnungmailcarrier reads it and delivers the days to the
// billing web application over its HTTPS API, so the nightly rows no longer depend on a database connection.
// Pure functions only (no adapter access), so the behaviour is unit-testable.
//
// Entry shape: { date: 'YYYY-MM-DD', datenqualitaet: 'ok'|'veraltet'|'vorlaeufig', meterRows: [...], buildingRow: {...}|null,
//                writtenAt: ISO }
// At most one entry per date (a re-written date replaces the older one), sorted ascending by date.

const MAX_DAYS = 120;

/**
 * @param {string|null|undefined} json
 * @returns {object[]}
 */
function parseJournal(json) {
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
    return parsed.filter(e => e && typeof e.date === 'string' && Array.isArray(e.meterRows));
}

/**
 * Adds or replaces the entry of one date and drops everything older than MAX_DAYS before the newest entry.
 *
 * @param {object[]} journal
 * @param {{ date: string, datenqualitaet?: string, meterRows: object[], buildingRow?: object|null }} entry
 * @param {string} [now] ISO timestamp, injectable for tests
 * @returns {object[]} new array
 */
function upsertDay(journal, entry, now) {
    const byDate = new Map(journal.map(e => [e.date, e]));
    byDate.set(entry.date, {
        date: entry.date,
        datenqualitaet: ['veraltet', 'vorlaeufig'].includes(entry.datenqualitaet) ? entry.datenqualitaet : 'ok',
        meterRows: entry.meterRows,
        buildingRow: entry.buildingRow || null,
        writtenAt: now || new Date().toISOString(),
    });
    const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const newest = sorted[sorted.length - 1].date;
    const limit = new Date(`${newest}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() - MAX_DAYS);
    const limitStr = limit.toISOString().slice(0, 10);
    return sorted.filter(e => e.date >= limitStr);
}

/** @param {object[]} journal */
function serializeJournal(journal) {
    return JSON.stringify(journal);
}

module.exports = { MAX_DAYS, parseJournal, upsertDay, serializeJournal };
