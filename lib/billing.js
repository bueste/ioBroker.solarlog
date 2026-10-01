'use strict';

// Billing/self-consumption math shared by main.js. Kept dependency-free (no
// adapter-core import) so it can be unit-tested standalone, outside a real
// js-controller environment.

// Self-consumption (Eigenverbrauch) is only measured building-wide (Solar-Log has no
// way to attribute which electron came from PV vs. grid per apartment meter). This is
// the standard Swiss ZEV allocation method: every meter's own consumption is split
// solar/grid using the SAME building-wide ratio for that day. min() caps the ratio at
// 100% for days where production exceeds consumption (the rest is fed into the grid,
// not attributable to any apartment's consumption).
function selfConsumptionRatio(totalProductionWh, totalConsumptionWh) {
    if (!totalConsumptionWh || totalConsumptionWh <= 0) {
        return 0;
    }
    return Math.min(totalProductionWh, totalConsumptionWh) / totalConsumptionWh;
}

// Only actual apartment/common-area consumption meters are billed - WR* are inverters
// (production, not consumption) and 'Gesamt' is a system-wide total that would double
// count against the individual apartment rows.
function isBillableMeter(name) {
    return /^WHG \d+$/.test(name) || name === 'Allgemein';
}

// The nightly run (23:58) books whatever the device last reported as the day's total. If the
// Solar-Log has not answered for longer than this, those values are from before the outage
// and the day is understated - the row is flagged 'veraltet' instead of looking normal.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * @param {number|null|undefined} lastPollTs Date.now() of the last successful fastpoll
 * @param {number} nowMs
 * @returns {'ok'|'veraltet'}
 */
function deviceDataQuality(lastPollTs, nowMs) {
    const ts = Number(lastPollTs);
    if (!Number.isFinite(ts) || ts <= 0 || nowMs - ts > STALE_THRESHOLD_MS) {
        return 'veraltet';
    }
    return 'ok';
}

module.exports = { selfConsumptionRatio, isBillableMeter, deviceDataQuality, STALE_THRESHOLD_MS };
