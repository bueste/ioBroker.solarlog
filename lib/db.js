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
  PRIMARY KEY (reading_date, meter_name)
)`;

const CREATE_BUILDING_DAILY = `
CREATE TABLE IF NOT EXISTS building_daily (
  reading_date DATE NOT NULL PRIMARY KEY,
  produktion_kwh DECIMAL(12,3),
  verbrauch_kwh DECIMAL(12,3),
  einspeisung_kwh DECIMAL(12,3),
  eigenverbrauchsquote DECIMAL(6,4)
)`;

const CREATE_METER_YEARLY_HISTORIC = `
CREATE TABLE IF NOT EXISTS meter_yearly_historic (
  reading_year INT NOT NULL,
  meter_name VARCHAR(64) NOT NULL,
  yield_kwh DECIMAL(14,3),
  PRIMARY KEY (reading_year, meter_name)
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
 */
function buildMeterDailyRow(p) {
    const round3 = v => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);
    const totalChf = Math.round((p.solarKwh * p.tarifSolar + p.netzKwh * p.tarifNetz) * 100) / 100;
    return {
        reading_date: p.date,
        meter_name: p.meterName,
        zaehlerstand_start_kwh: round3(p.zStartKwh),
        zaehlerstand_ende_kwh: round3(p.zEndeKwh),
        verbrauch_kwh: round3(p.verbrauchKwh),
        solarbezug_kwh: round3(p.solarKwh),
        netzbezug_kwh: round3(p.netzKwh),
        tarif_netz: p.tarifNetz,
        tarif_solar: p.tarifSolar,
        total_chf: totalChf,
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
 */
function buildBuildingDailyRow(p) {
    const round3 = v => Math.round(v * 1000) / 1000;
    const quote = p.verbrauchKwh > 0 ? Math.min(p.produktionKwh, p.verbrauchKwh) / p.verbrauchKwh : 0;
    return {
        reading_date: p.date,
        produktion_kwh: round3(p.produktionKwh),
        verbrauch_kwh: round3(p.verbrauchKwh),
        einspeisung_kwh: round3(p.einspeisungKwh),
        eigenverbrauchsquote: Math.round(quote * 10000) / 10000,
    };
} // END buildBuildingDailyRow

/**
 * @param {import('mariadb').Pool} pool
 */
async function ensureSchema(pool) {
    await pool.query(CREATE_METER_DAILY);
    await pool.query(CREATE_BUILDING_DAILY);
    await pool.query(CREATE_METER_YEARLY_HISTORIC);
} // END ensureSchema

/**
 * @param {import('mariadb').Pool} pool
 * @param {ReturnType<typeof buildMeterDailyRow>[]} rows
 */
async function upsertMeterDaily(pool, rows) {
    for (const r of rows) {
        await pool.query(
            `INSERT INTO meter_daily (reading_date, meter_name, zaehlerstand_start_kwh, zaehlerstand_ende_kwh,
                verbrauch_kwh, solarbezug_kwh, netzbezug_kwh, tarif_netz, tarif_solar, total_chf)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                zaehlerstand_start_kwh = VALUES(zaehlerstand_start_kwh),
                zaehlerstand_ende_kwh = VALUES(zaehlerstand_ende_kwh),
                verbrauch_kwh = VALUES(verbrauch_kwh),
                solarbezug_kwh = VALUES(solarbezug_kwh),
                netzbezug_kwh = VALUES(netzbezug_kwh),
                tarif_netz = VALUES(tarif_netz),
                tarif_solar = VALUES(tarif_solar),
                total_chf = VALUES(total_chf)`,
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
        `INSERT INTO building_daily (reading_date, produktion_kwh, verbrauch_kwh, einspeisung_kwh, eigenverbrauchsquote)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            produktion_kwh = VALUES(produktion_kwh),
            verbrauch_kwh = VALUES(verbrauch_kwh),
            einspeisung_kwh = VALUES(einspeisung_kwh),
            eigenverbrauchsquote = VALUES(eigenverbrauchsquote)`,
        [row.reading_date, row.produktion_kwh, row.verbrauch_kwh, row.einspeisung_kwh, row.eigenverbrauchsquote],
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

module.exports = {
    buildMeterDailyRow,
    buildBuildingDailyRow,
    ensureSchema,
    upsertMeterDaily,
    upsertBuildingDaily,
    upsertMeterYearlyHistoric,
    queryMeterPeriod,
    queryBuildingPeriod,
};
