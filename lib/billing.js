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

module.exports = { selfConsumptionRatio };
