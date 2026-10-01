'use strict';

// Retry bookkeeping for the scheduled report e-mail. The report used to be tried exactly
// once (00:10 on the cutoff day): MariaDB or the mail server being down at that moment, or an
// adapter restart, meant the report was never sent and nobody noticed. Pure functions only;
// main.js persists the state (JSON in Export.reportState) and runs the hourly job.
//
// State: { lastKey: string|null, pending: {key, period, since} | null }
//   lastKey  key of the last report that was sent (or saved without a recipient)
//   pending  a report that is due but not yet sent; retried every hour until it works or
//            MAX_PENDING_DAYS have passed

const MAX_PENDING_DAYS = 7;

function emptyState() {
    return { lastKey: null, pending: null };
}

/** @param {string|null|undefined} json */
function parseState(json) {
    if (!json) {
        return emptyState();
    }
    try {
        const s = JSON.parse(json);
        return {
            lastKey: typeof s.lastKey === 'string' ? s.lastKey : null,
            pending: s.pending && typeof s.pending.key === 'string' && s.pending.period ? s.pending : null,
        };
    } catch {
        return emptyState();
    }
}

function reportKey(schedule, period) {
    return `${schedule}:${period.label}`;
}

/**
 * Registers the report that is due today (if any) as pending, unless it was already sent
 * or is already pending.
 *
 * @param state
 * @param due
 * @param schedule
 * @param todayStr
 * @returns {{state: object, replaced: object|null}} replaced = an older, still unsent report
 *   that this one pushed out (the caller logs it as an error)
 */
function registerDue(state, due, schedule, todayStr) {
    if (!due) {
        return { state, replaced: null };
    }
    const key = reportKey(schedule, due);
    if (key === state.lastKey || (state.pending && state.pending.key === key)) {
        return { state, replaced: null };
    }
    return {
        state: { ...state, pending: { key, period: due, since: todayStr } },
        replaced: state.pending,
    };
}

function markSent(state) {
    return { lastKey: state.pending ? state.pending.key : state.lastKey, pending: null };
}

function daysBetween(fromStr, toStr) {
    const [y1, m1, d1] = fromStr.split('-').map(Number);
    const [y2, m2, d2] = toStr.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * Drops a pending report that could not be sent for more than MAX_PENDING_DAYS days.
 *
 * @param state
 * @param todayStr
 * @param maxDays
 */
function expirePending(state, todayStr, maxDays = MAX_PENDING_DAYS) {
    if (state.pending && daysBetween(state.pending.since, todayStr) > maxDays) {
        return { state: { ...state, pending: null }, expired: state.pending };
    }
    return { state, expired: null };
}

module.exports = { MAX_PENDING_DAYS, emptyState, parseState, reportKey, registerDue, markSent, expirePending };
