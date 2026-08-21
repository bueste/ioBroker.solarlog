'use strict';

// MariaDB persistence for the daily billing journal. Row-shaping functions are pure
// (no DB connection needed) so they're unit-testable standalone; connection/query
// functions need a real `mariadb` pool and are only exercised against a live DB.

const CREATE_METER_DAILY = `
CREATE TABLE IF NOT EXISTS meter_daily (
  reading_date DATE NOT NULL,
  meter_name VARCHAR(64) NOT NULL,
  zaehlerstand_start_kwh DECIMAL(12,3),
  zaehlerstand_ende_kwh DECIMAL(12,3),
  verbrauch_kwh DECIMAL(12,3),
  solarbezug_kwh DECIMAL(12,3),
  netzbezug_kwh DECIMAL(12,3),
  tarif_netz DECIMAL(8,4),
  tarif_solar DECIMAL(8,4),
  total_chf DECIMAL(10,2),
  berechnungsmethode VARCHAR(20) NOT NULL DEFAULT 'tagesnetto',
  PRIMARY KEY (reading_date, meter_name)
)`;

const CREATE_BUILDING_DAILY = `
CREATE TABLE IF NOT EXISTS building_daily (
  reading_date DATE NOT NULL PRIMARY KEY,
  produktion_kwh DECIMAL(12,3),
  verbrauch_kwh DECIMAL(12,3),
  einspeisung_kwh DECIMAL(12,3),
  eigenverbrauchsquote DECIMAL(6,4),
  berechnungsmethode VARCHAR(20) NOT NULL DEFAULT 'tagesnetto'
)`;

// 'tagesnetto': same-day net of yieldday/consyieldday totals (the original method - a
// coarse approximation that ignores WHEN in the day production/consumption happened).
// 'integriert': true intraday integration of the yieldday/consyieldday deltas between
// consecutive fastpolls (see accumulateIntradayDelta() in main.js) - falls back to
// 'tagesnetto' automatically for a given day if fastpoll coverage was too spotty (VPN/
// ioBroker downtime) to trust the integration for that day.
const BERECHNUNGSMETHODEN = ['tagesnetto', 'integriert'];

const CREATE_METER_YEARLY_HISTORIC = `
CREATE TABLE IF NOT EXISTS meter_yearly_historic (
  reading_year INT NOT NULL,
  meter_name VARCHAR(64) NOT NULL,
  yield_kwh DECIMAL(14,3),
  PRIMARY KEY (reading_year, meter_name)
)`;

// Durable record of what tariff was configured for a given month - mirrors the
// Tarif.<year>.<month>.* ioBroker states, but as a queryable table a future web
// application can read/write directly without needing ioBroker object-tree access.
const CREATE_TARIFF_SCHEDULE = `
CREATE TABLE IF NOT EXISTS tariff_schedule (
  reading_year INT NOT NULL,
  reading_month TINYINT NOT NULL,
  netzbezug_chf_kwh DECIMAL(8,4) NOT NULL,
  solarbezug_chf_kwh DECIMAL(8,4) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (reading_year, reading_month)
)`;

// Optional, per-apartment fixed monthly cost (e.g. building maintenance, a common-area
// share) that rides alongside the energy-based Solarbezug/Netzbezug billing but is not
// itself energy-based - a flat CHF amount per meter per month, only present when
// explicitly activated for that meter.
const CREATE_METER_UMLAGEKOSTEN = `
CREATE TABLE IF NOT EXISTS meter_umlagekosten (
  reading_year INT NOT NULL,
  reading_month TINYINT NOT NULL,
  meter_name VARCHAR(64) NOT NULL,
  umlagekosten_chf DECIMAL(10,2) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (reading_year, reading_month, meter_name)
)`;

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
    return {
        reading_date: p.date,
        produktion_kwh: round3(p.produktionKwh),
        verbrauch_kwh: round3(p.verbrauchKwh),
        einspeisung_kwh: round3(p.einspeisungKwh),
        eigenverbrauchsquote: Math.round(quote * 10000) / 10000,
        berechnungsmethode,
    };
} // END buildBuildingDailyRow

/**
 * @param {import('mariadb').Pool} pool
 */
async function ensureSchema(pool) {
    await pool.query(CREATE_METER_DAILY);
    await pool.query(CREATE_BUILDING_DAILY);
    await pool.query(CREATE_METER_YEARLY_HISTORIC);
    await pool.query(CREATE_TARIFF_SCHEDULE);
    await pool.query(CREATE_METER_UMLAGEKOSTEN);
    // CREATE TABLE IF NOT EXISTS above doesn't touch already-existing tables (this
    // column was added after both tables were already live), so add it explicitly -
    // idempotent, safe to run on every startup.
    await pool.query(
        `ALTER TABLE meter_daily ADD COLUMN IF NOT EXISTS berechnungsmethode VARCHAR(20) NOT NULL DEFAULT 'tagesnetto'`,
    );
    await pool.query(
        `ALTER TABLE building_daily ADD COLUMN IF NOT EXISTS berechnungsmethode VARCHAR(20) NOT NULL DEFAULT 'tagesnetto'`,
    );
} // END ensureSchema

/**
 * @param {import('mariadb').Pool} pool
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} netzbezugChfKwh
 * @param {number} solarbezugChfKwh
 */
async function upsertTariffSchedule(pool, year, month, netzbezugChfKwh, solarbezugChfKwh) {
    await pool.query(
        `INSERT INTO tariff_schedule (reading_year, reading_month, netzbezug_chf_kwh, solarbezug_chf_kwh)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            netzbezug_chf_kwh = VALUES(netzbezug_chf_kwh),
            solarbezug_chf_kwh = VALUES(solarbezug_chf_kwh)`,
        [year, month, netzbezugChfKwh, solarbezugChfKwh],
    );
} // END upsertTariffSchedule

/**
 * @param {import('mariadb').Pool} pool
 * @param {number} year
 * @param {number} month 1-12
 * @param {string} meterName
 * @param {number} umlagekostenChf
 * @param {boolean} active
 */
async function upsertMeterUmlagekosten(pool, year, month, meterName, umlagekostenChf, active) {
    await pool.query(
        `INSERT INTO meter_umlagekosten (reading_year, reading_month, meter_name, umlagekosten_chf, active)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            umlagekosten_chf = VALUES(umlagekosten_chf),
            active = VALUES(active)`,
        [year, month, meterName, umlagekostenChf, !!active],
    );
} // END upsertMeterUmlagekosten

/**
 * @param {import('mariadb').Pool} pool
 * @param {ReturnType<typeof buildMeterDailyRow>[]} rows
 */
async function upsertMeterDaily(pool, rows) {
    for (const r of rows) {
        await pool.query(
            `INSERT INTO meter_daily (reading_date, meter_name, zaehlerstand_start_kwh, zaehlerstand_ende_kwh,
                verbrauch_kwh, solarbezug_kwh, netzbezug_kwh, tarif_netz, tarif_solar, total_chf, berechnungsmethode)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                zaehlerstand_start_kwh = VALUES(zaehlerstand_start_kwh),
                zaehlerstand_ende_kwh = VALUES(zaehlerstand_ende_kwh),
                verbrauch_kwh = VALUES(verbrauch_kwh),
                solarbezug_kwh = VALUES(solarbezug_kwh),
                netzbezug_kwh = VALUES(netzbezug_kwh),
                tarif_netz = VALUES(tarif_netz),
                tarif_solar = VALUES(tarif_solar),
                total_chf = VALUES(total_chf),
                berechnungsmethode = VALUES(berechnungsmethode)`,
            [
                r.reading_date,
                r.meter_name,
                r.zaehlerstand_start_kwh,
                r.zaehlerstand_ende_kwh,
                r.verbrauch_kwh,
                r.solarbezug_kwh,
                r.netzbezug_kwh,
                r.tarif_netz,
                r.tarif_solar,
                r.total_chf,
                r.berechnungsmethode,
            ],
        );
    }
} // END upsertMeterDaily

/**
 * @param {import('mariadb').Pool} pool
 * @param {ReturnType<typeof buildBuildingDailyRow>} row
 */
async function upsertBuildingDaily(pool, row) {
    await pool.query(
        `INSERT INTO building_daily (reading_date, produktion_kwh, verbrauch_kwh, einspeisung_kwh, eigenverbrauchsquote, berechnungsmethode)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            produktion_kwh = VALUES(produktion_kwh),
            verbrauch_kwh = VALUES(verbrauch_kwh),
            einspeisung_kwh = VALUES(einspeisung_kwh),
            eigenverbrauchsquote = VALUES(eigenverbrauchsquote),
            berechnungsmethode = VALUES(berechnungsmethode)`,
        [
            row.reading_date,
            row.produktion_kwh,
            row.verbrauch_kwh,
            row.einspeisung_kwh,
            row.eigenverbrauchsquote,
            row.berechnungsmethode,
        ],
    );
} // END upsertBuildingDaily

/**
 * @param {import('mariadb').Pool} pool
 * @param {number} year
 * @param {string} meterName
 * @param {number} yieldKwh
 */
async function upsertMeterYearlyHistoric(pool, year, meterName, yieldKwh) {
    await pool.query(
        `INSERT INTO meter_yearly_historic (reading_year, meter_name, yield_kwh)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE yield_kwh = VALUES(yield_kwh)`,
        [year, meterName, Math.round(yieldKwh * 1000) / 1000],
    );
} // END upsertMeterYearlyHistoric

/**
 * Meter rows for a billing period, one row per meter/day, ordered for report generation.
 *
 * @param {import('mariadb').Pool} pool
 * @param {string} fromDate "YYYY-MM-DD" inclusive
 * @param {string} toDate "YYYY-MM-DD" inclusive
 */
async function queryMeterPeriod(pool, fromDate, toDate) {
    return pool.query(
        `SELECT * FROM meter_daily WHERE reading_date BETWEEN ? AND ? ORDER BY reading_date, meter_name`,
        [fromDate, toDate],
    );
} // END queryMeterPeriod

/**
 * @param {import('mariadb').Pool} pool
 * @param {string} fromDate "YYYY-MM-DD" inclusive
 * @param {string} toDate "YYYY-MM-DD" inclusive
 */
async function queryBuildingPeriod(pool, fromDate, toDate) {
    return pool.query(`SELECT * FROM building_daily WHERE reading_date BETWEEN ? AND ? ORDER BY reading_date`, [
        fromDate,
        toDate,
    ]);
} // END queryBuildingPeriod

/**
 * @param {import('mariadb').Pool} pool
 * @param {number} year
 * @param {number} month 1-12
 */
async function queryTariffForMonth(pool, year, month) {
    const rows = await pool.query(`SELECT * FROM tariff_schedule WHERE reading_year = ? AND reading_month = ?`, [
        year,
        month,
    ]);
    return rows[0] || null;
} // END queryTariffForMonth

/**
 * @param {import('mariadb').Pool} pool
 * @param {string} fromDate "YYYY-MM-DD" inclusive
 * @param {string} toDate "YYYY-MM-DD" inclusive
 */
async function queryMeterUmlagekostenPeriod(pool, fromDate, toDate) {
    const fromYear = Number(fromDate.slice(0, 4));
    const fromMonth = Number(fromDate.slice(5, 7));
    const toYear = Number(toDate.slice(0, 4));
    const toMonth = Number(toDate.slice(5, 7));
    return pool.query(
        `SELECT * FROM meter_umlagekosten
         WHERE active = TRUE
           AND (reading_year > ? OR (reading_year = ? AND reading_month >= ?))
           AND (reading_year < ? OR (reading_year = ? AND reading_month <= ?))
         ORDER BY reading_year, reading_month, meter_name`,
        [fromYear, fromYear, fromMonth, toYear, toYear, toMonth],
    );
} // END queryMeterUmlagekostenPeriod

module.exports = {
    buildMeterDailyRow,
    buildBuildingDailyRow,
    ensureSchema,
    upsertMeterDaily,
    upsertBuildingDaily,
    upsertMeterYearlyHistoric,
    upsertTariffSchedule,
    upsertMeterUmlagekosten,
    queryMeterPeriod,
    queryBuildingPeriod,
    queryTariffForMonth,
    queryMeterUmlagekostenPeriod,
};
