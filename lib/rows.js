'use strict';

// Shapes the finished daily billing figures into rows (column names of the former database tables). The rows go
// into the local daily journal (lib/journal.js), which the adapter iobroker.abrechnungmailcarrier delivers over
// the HTTPS API. Pure functions, unit-testable without ioBroker.

// 'tagesnetto': same-day net of yieldday/consyieldday totals (the original method - a
// coarse approximation that ignores WHEN in the day production/consumption happened).
// 'integriert': true intraday integration of the yieldday/consyieldday deltas between
// consecutive fastpolls (see accumulateIntradayDelta() in main.js) - falls back to
// 'tagesnetto' automatically for a given day if fastpoll coverage was too spotty (VPN/
// ioBroker downtime) to trust the integration for that day.
const BERECHNUNGSMETHODEN = ['tagesnetto', 'integriert'];

// 'ok': the device values were fresh when the row was built at 23:58.
// 'veraltet': the last successful poll of the Solar-Log was older than the staleness
// threshold at that moment, so yieldday/consyieldday/daysum are the last values seen BEFORE
// the outage, not the day's real totals. The row is still written (a flagged row is better
// than a missing one), and reports mark such days as unsafe.
// 'vorlaeufig': an intraday snapshot of the day so far (every 15 minutes, see writeProvisionalDay() in main.js);
// replaced by the final rows of the 23:58 run. It stays only if that run never happened.
const DATENQUALITAET = ['ok', 'veraltet', 'vorlaeufig'];

function checkedDatenqualitaet(fnName, value) {
    const datenqualitaet = value || 'ok';
    if (!DATENQUALITAET.includes(datenqualitaet)) {
        throw new Error(`${fnName}: unknown datenqualitaet "${datenqualitaet}"`);
    }
    return datenqualitaet;
}

/**
 * Shapes one apartment/meter's daily billing figures into a DB row. Rounds to 3
 * decimals (Wh -> kWh precision) and computes the billed total.
 *
 * @param {object} p
 * @param {string} p.date "YYYY-MM-DD"
 * @param {string} p.meterName
 * @param {number|null} p.zStartKwh
 * @param {number|null} p.zEndeKwh
 * @param {number} p.verbrauchKwh
 * @param {number} p.solarKwh
 * @param {number} p.netzKwh
 * @param {number} p.tarifNetz
 * @param {number} p.tarifSolar
 * @param {string} [p.berechnungsmethode] 'tagesnetto' (default) or 'integriert' - which
 *   method computed the solar/grid split used here (see accumulateMonthlyPerDevice()).
 * @param {string} [p.datenqualitaet] 'ok' (default) or 'veraltet' - see DATENQUALITAET.
 */
function buildMeterDailyRow(p) {
    const round3 = v => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);
    // total_chf MUST be computed from the same rounded kWh figures that end up stored/
    // displayed in this row, not the raw pre-rounding values - otherwise a tenant or
    // auditor who recomputes Solarbezug*Tarif + Netzbezug*Tarif from what they can see
    // gets a number that doesn't quite match the stored total (a real, if small,
    // reconciliation mismatch - unacceptable for a billing document).
    const solarKwhRounded = round3(p.solarKwh);
    const netzKwhRounded = round3(p.netzKwh);
    const totalChf = Math.round((solarKwhRounded * p.tarifSolar + netzKwhRounded * p.tarifNetz) * 100) / 100;
    const berechnungsmethode = p.berechnungsmethode || 'tagesnetto';
    if (!BERECHNUNGSMETHODEN.includes(berechnungsmethode)) {
        throw new Error(`buildMeterDailyRow: unknown berechnungsmethode "${berechnungsmethode}"`);
    }
    const datenqualitaet = checkedDatenqualitaet('buildMeterDailyRow', p.datenqualitaet);
    return {
        reading_date: p.date,
        meter_name: p.meterName,
        zaehlerstand_start_kwh: round3(p.zStartKwh),
        zaehlerstand_ende_kwh: round3(p.zEndeKwh),
        verbrauch_kwh: round3(p.verbrauchKwh),
        solarbezug_kwh: solarKwhRounded,
        netzbezug_kwh: netzKwhRounded,
        tarif_netz: p.tarifNetz,
        tarif_solar: p.tarifSolar,
        total_chf: totalChf,
        berechnungsmethode,
        datenqualitaet,
    };
} // END buildMeterDailyRow

/**
 * Shapes the building-wide daily production/consumption/feed-in figures into a DB row.
 *
 * @param {object} p
 * @param {string} p.date "YYYY-MM-DD"
 * @param {number} p.produktionKwh
 * @param {number} p.verbrauchKwh
 * @param {number} p.einspeisungKwh
 * @param {number} [p.selbstverbrauchtKwh] kWh of own production actually self-consumed
 *   (not exported). Defaults to min(produktionKwh, verbrauchKwh) - the original
 *   'tagesnetto' same-day-net approximation - when omitted, so every existing caller/
 *   test keeps working unchanged. Pass the true intraday-integrated figure to get a more
 *   accurate eigenverbrauchsquote (see accumulateIntradayDelta() in main.js).
 * @param {string} [p.berechnungsmethode] 'tagesnetto' (default) or 'integriert'.
 * @param {string} [p.datenqualitaet] 'ok' (default) or 'veraltet' - see DATENQUALITAET.
 */
function buildBuildingDailyRow(p) {
    const round3 = v => Math.round(v * 1000) / 1000;
    const selbstverbraucht =
        p.selbstverbrauchtKwh !== undefined ? p.selbstverbrauchtKwh : Math.min(p.produktionKwh, p.verbrauchKwh);
    const quote = p.verbrauchKwh > 0 ? selbstverbraucht / p.verbrauchKwh : 0;
    const berechnungsmethode = p.berechnungsmethode || 'tagesnetto';
    if (!BERECHNUNGSMETHODEN.includes(berechnungsmethode)) {
        throw new Error(`buildBuildingDailyRow: unknown berechnungsmethode "${berechnungsmethode}"`);
    }
    const datenqualitaet = checkedDatenqualitaet('buildBuildingDailyRow', p.datenqualitaet);
    return {
        reading_date: p.date,
        produktion_kwh: round3(p.produktionKwh),
        verbrauch_kwh: round3(p.verbrauchKwh),
        einspeisung_kwh: round3(p.einspeisungKwh),
        eigenverbrauchsquote: Math.round(quote * 10000) / 10000,
        berechnungsmethode,
        datenqualitaet,
    };
} // END buildBuildingDailyRow

module.exports = {
    buildMeterDailyRow,
    buildBuildingDailyRow,
};
