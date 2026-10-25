'use strict';

/**
 * Re-creates the journal entries (state Database.dailyJournal) for days the adapter could not write at 23:58
 * (adapter stopped, Solar-Log not reachable, ...) from the continuous InfluxDB history of the same device counters
 * the nightly job reads. The adapter iobroker.abrechnungmailcarrier then delivers the days to the billing web
 * application over its HTTPS API.
 *
 * It emulates accumulateMonthlyPerDevice() (main.js) step by step and uses the adapter's own row builders, so
 * rounding/total_chf/structure are identical to a normal night:
 *   - snapshot of status.yieldday / status.consyieldday / INV.<meter>.daysum as of 23:58:00
 *   - 'integriert' only if the 30s fast-poll covered >= 95% of the day (gaps > 5 min are
 *     not bridged), otherwise 'tagesnetto' - exactly accumulateIntradayDelta()'s rules
 *   - zaehlerstand_start/ende are written as NULL (the lifetime counter cannot be
 *     reconstructed and inventing a chain would fake a control figure)
 *
 * Modes:
 *   --mode dry-run   (default) shows what would be written, writes nothing
 *   --mode write     writes the journal to --out (a file); with --merge <file> the days of an existing journal
 *                    (output of "iobroker state get solarlog.0.Database.dailyJournal", only the val) are kept
 *                    and the rebuilt days replace entries of the same date
 *
 * Usage (env):
 *   INFLUX_URL (default http://localhost:8086)  INFLUX_ORG  INFLUX_BUCKET (default iobroker)  INFLUX_TOKEN
 *   node tools/backfill-from-influx.js --from 2026-08-10 --to 2026-09-30 --meters "WHG 1,WHG 2" --mode dry-run
 *   --default-tariff 0.28,0.20   (netz,solar; only fills the tariff columns of the rows, the web application
 *                                 recomputes the amounts with its own tariff table)
 *   --out journal.json   --merge existing.json
 */

const fs = require('node:fs');
const { selfConsumptionRatio } = require('../lib/billing');
const { buildMeterDailyRow, buildBuildingDailyRow } = require('../lib/rows');
const { parseJournal, upsertDay, serializeJournal } = require('../lib/journal');

const INTRADAY_GAP_THRESHOLD_MS = 5 * 60 * 1000; // same constants as main.js
const INTRADAY_COVERAGE_THRESHOLD = 0.95;
const SNAPSHOT_HOUR = 23;
const SNAPSHOT_MINUTE = 58;

function parseArgs(argv) {
    const args = {
        mode: 'dry-run',
        meters: [],
        tariff: {},
        defaultTariff: [0.28, 0.2],
        overwrite: false,
        integratedFrom: '2026-08-22',
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--overwrite') {
            args.overwrite = true;
        } else if (a === '--meters') {
            args.meters = argv[++i].split(',').map(x => x.trim()).filter(Boolean);
        } else if (a === '--from' || a === '--to' || a === '--mode' || a === '--out' || a === '--merge') {
            args[a.slice(2)] = argv[++i];
        } else if (a === '--integrated-from') {
            args.integratedFrom = argv[++i];
        } else if (a === '--default-tariff') {
            args.defaultTariff = argv[++i].split(',').map(Number);
        } else if (a === '--tariff') {
            const [month, vals] = argv[++i].split('=');
            args.tariff[month] = vals.split(',').map(Number);
        } else {
            throw new Error(`Unknown argument ${a}`);
        }
    }
    if (!args.from || !args.to) {
        throw new Error('--from and --to (YYYY-MM-DD, inclusive) are required');
    }
    if (!['dry-run', 'write'].includes(args.mode)) {
        throw new Error('--mode must be dry-run or write');
    }
    if (args.meters.length === 0) {
        throw new Error('--meters "WHG 1,WHG 2,..." is required (the billable meter names)');
    }
    if (args.mode === 'write' && !args.out) {
        throw new Error('--mode write needs --out <file>');
    }
    return args;
}

const INFLUX_URL = process.env.INFLUX_URL || 'http://localhost:8086';
const INFLUX_ORG = process.env.INFLUX_ORG;
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'iobroker';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN;

function parseCsv(text) {
    const rows = [];
    let cols = null;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) {
            cols = null; // multi-table responses: blank line, then a new header
            continue;
        }
        if (line.startsWith('#')) {
            continue;
        }
        const parts = line.split(',');
        if (parts.includes('_time') && parts.includes('_value')) {
            cols = parts;
            continue;
        }
        if (!cols) {
            continue;
        }
        const rec = {};
        cols.forEach((c, i) => {
            rec[c] = parts[i];
        });
        rows.push(rec);
    }
    return rows;
}

async function fluxQuery(flux) {
    const res = await fetch(`${INFLUX_URL}/api/v2/query?org=${encodeURIComponent(INFLUX_ORG)}`, {
        method: 'POST',
        headers: {
            Authorization: `Token ${INFLUX_TOKEN}`,
            'Content-Type': 'application/vnd.flux',
            Accept: 'application/csv',
        },
        body: flux,
    });
    if (!res.ok) {
        throw new Error(`InfluxDB ${res.status}: ${await res.text()}`);
    }
    return parseCsv(await res.text());
}

const iso = d => d.toISOString();
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const m = (name) => `solarlog.0.${name}`;

/**
 * @param {string} dateStr local calendar day
 * @param {string[]} meters billable meter names
 * @returns {Promise<{ok: boolean, reason?: string, ...}>} snapshot + integration inputs
 */
async function loadDay(dateStr, meters) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const start = new Date(y, mo - 1, d, 0, 0, 0, 0);
    const snapAt = new Date(y, mo - 1, d, SNAPSHOT_HOUR, SNAPSHOT_MINUTE, 0, 0);
    const stop = new Date(snapAt.getTime() + 1); // range stop is exclusive: include 23:58:00.000

    const snapSet = ['status.yieldday', 'status.consyieldday', ...meters.map(n => `INV.${n}.daysum`)].map(
        s => `"${m(s)}"`,
    );
    const snapRows = await fluxQuery(
        `from(bucket: "${INFLUX_BUCKET}") |> range(start: ${iso(start)}, stop: ${iso(stop)})
         |> filter(fn: (r) => contains(value: r._measurement, set: [${snapSet.join(',')}]))
         |> last() |> keep(columns: ["_time","_value","_measurement"])`,
    );
    const snap = new Map();
    for (const r of snapRows) {
        snap.set(r._measurement, { value: Number(r._value), t: Date.parse(r._time) });
    }
    for (const key of ['status.yieldday', 'status.consyieldday', ...meters.map(n => `INV.${n}.daysum`)]) {
        const s = snap.get(m(key));
        if (!s) {
            return { ok: false, reason: `keine Daten fuer ${key}` };
        }
        if (s.t < snapAt.getTime() - 31 * 60 * 1000) {
            return { ok: false, reason: `${key}: letzter Wert ${new Date(s.t).toISOString()} zu frueh (Tag unvollstaendig)` };
        }
    }

    const series = {};
    for (const key of ['status.yieldday', 'status.consyieldday']) {
        const rows = await fluxQuery(
            `from(bucket: "${INFLUX_BUCKET}") |> range(start: ${iso(start)}, stop: ${iso(stop)})
             |> filter(fn: (r) => r._measurement == "${m(key)}") |> keep(columns: ["_time","_value"])
             |> sort(columns: ["_time"])`,
        );
        series[key] = rows.map(r => ({ t: Date.parse(r._time), v: Number(r._value) })).sort((a, b) => a.t - b.t);
    }
    // The device's own "yesterday" counters, as published shortly after midnight, give the
    // complete day total - only used as a plausibility figure (how much the 23:58 snapshot
    // is short of the full day, relevant when the raw data of that day is only 30-min dense).
    const nextDay = new Date(y, mo - 1, d + 1, 0, 0, 0, 0);
    const yRows = await fluxQuery(
        `from(bucket: "${INFLUX_BUCKET}") |> range(start: ${iso(nextDay)}, stop: ${iso(new Date(nextDay.getTime() + 3 * 3600 * 1000))})
         |> filter(fn: (r) => r._measurement == "${m('status.yieldyesterday')}" or r._measurement == "${m('status.consyieldyesterday')}")
         |> last() |> keep(columns: ["_time","_value","_measurement"])`,
    );
    const yesterday = {};
    for (const r of yRows) {
        yesterday[r._measurement] = Number(r._value);
    }
    return { ok: true, start, snapAt, snap, y: series['status.yieldday'], c: series['status.consyieldday'], yesterday };
}

/** Mirrors accumulateIntradayDelta(): consecutive yield/cons pairs <= 5 min apart. */
function integrate(y, c, snapAtMs) {
    let selfConsumedWh = 0;
    let gridDrawWh = 0;
    let feedinWh = 0;
    let coveredSeconds = 0;
    let ci = 0;
    let last = null;
    for (const yp of y) {
        while (ci < c.length - 1 && Math.abs(c[ci + 1].t - yp.t) < Math.abs(c[ci].t - yp.t)) {
            ci++;
        }
        const cp = c[ci];
        if (!cp || Math.abs(cp.t - yp.t) > 3000) {
            continue;
        }
        const cur = { t: yp.t, y: yp.v, c: cp.v };
        if (last) {
            const deltaMs = cur.t - last.t;
            if (deltaMs > 0 && deltaMs <= INTRADAY_GAP_THRESHOLD_MS) {
                const dY = Math.max(0, cur.y - last.y);
                const dC = Math.max(0, cur.c - last.c);
                selfConsumedWh += Math.min(dY, dC);
                feedinWh += Math.max(0, dY - dC);
                gridDrawWh += Math.max(0, dC - dY);
                coveredSeconds += deltaMs / 1000;
            }
        }
        last = cur;
    }
    return { selfConsumedWh, gridDrawWh, feedinWh, coveredSeconds, snapAtMs };
}

function computeRows(dateStr, day, meters, tariffs, integratedFrom) {
    const yieldWh = day.snap.get(m('status.yieldday')).value;
    const consWh = day.snap.get(m('status.consyieldday')).value;
    const intraday = integrate(day.y, day.c, day.snapAt.getTime());
    const secondsSinceMidnight = (day.snapAt.getTime() - day.start.getTime()) / 1000;
    const coverageRatio = intraday.coveredSeconds / secondsSinceMidnight;
    // The adapter only had the intraday accumulator from 2.5.14 on; before that day the
    // journal was 'tagesnetto' by construction, and the 5-minute raw data of that era is
    // too coarse to present as a true 'integriert' value.
    const integratedAvailable = dateStr >= integratedFrom;

    let ratio;
    let einspeisungWh;
    let berechnungsmethode;
    if (
        integratedAvailable &&
        coverageRatio >= INTRADAY_COVERAGE_THRESHOLD &&
        intraday.selfConsumedWh + intraday.gridDrawWh > 0
    ) {
        ratio = intraday.selfConsumedWh / (intraday.selfConsumedWh + intraday.gridDrawWh);
        einspeisungWh = intraday.feedinWh;
        berechnungsmethode = 'integriert';
    } else {
        ratio = selfConsumptionRatio(yieldWh, consWh);
        einspeisungWh = Math.max(0, yieldWh - consWh);
        berechnungsmethode = 'tagesnetto';
    }

    const meterRows = meters.map(name => {
        const daysum = day.snap.get(m(`INV.${name}.daysum`)).value;
        const solarWh = daysum * ratio;
        const row = buildMeterDailyRow({
            date: dateStr,
            meterName: name,
            zStartKwh: 0,
            zEndeKwh: 0,
            verbrauchKwh: daysum / 1000,
            solarKwh: solarWh / 1000,
            netzKwh: (daysum - solarWh) / 1000,
            tarifNetz: tariffs.netz,
            tarifSolar: tariffs.solar,
            berechnungsmethode,
        });
        row.zaehlerstand_start_kwh = null;
        row.zaehlerstand_ende_kwh = null;
        return row;
    });
    const buildingRow = buildBuildingDailyRow({
        date: dateStr,
        produktionKwh: yieldWh / 1000,
        verbrauchKwh: consWh / 1000,
        einspeisungKwh: einspeisungWh / 1000,
        selbstverbrauchtKwh: (consWh * ratio) / 1000,
        berechnungsmethode,
    });
    return { meterRows, buildingRow, coverageRatio };
}

function tariffFor(args, dateStr) {
    const [y, mo] = dateStr.split('-').map(Number);
    const key = `${y}-${pad(mo)}`;
    const tr = args.tariff[key] || args.defaultTariff;
    return { netz: tr[0], solar: tr[1], src: args.tariff[key] ? '--tariff' : '--default-tariff' };
}

async function main() {
    const args = parseArgs(process.argv);
    for (const [k, v] of Object.entries({ INFLUX_ORG, INFLUX_TOKEN })) {
        if (!v) {
            throw new Error(`Environment variable ${k} is required`);
        }
    }
    const meters = args.meters;
    let journal = args.merge ? parseJournal(fs.readFileSync(args.merge, 'utf8').trim().replace(/^"|"$/g, '')) : [];
    console.log(`Zaehler: ${meters.join(', ')} | Modus: ${args.mode} | ${args.from} .. ${args.to}`);

    const [fy, fm, fd] = args.from.split('-').map(Number);
    const [ty, tm, td] = args.to.split('-').map(Number);
    const stats = { built: 0, skipped: 0 };
    for (let d = new Date(fy, fm - 1, fd); d <= new Date(ty, tm - 1, td); d.setDate(d.getDate() + 1)) {
        const dateStr = ymd(d);
        if (journal.some(e => e.date === dateStr) && !args.overwrite) {
            console.log(`${dateStr}  im Journal vorhanden, uebersprungen (--overwrite zum Ersetzen)`);
            continue;
        }
        const day = await loadDay(dateStr, meters);
        if (!day.ok) {
            console.log(`${dateStr}  UEBERSPRUNGEN: ${day.reason}`);
            stats.skipped++;
            continue;
        }
        const tariffs = tariffFor(args, dateStr);
        const { meterRows, buildingRow, coverageRatio } = computeRows(dateStr, day, meters, tariffs, args.integratedFrom);
        const b = buildingRow;
        console.log(
            `${dateStr}  ${b.berechnungsmethode.padEnd(10)} abd=${(coverageRatio * 100).toFixed(1)}%  prod=${b.produktion_kwh} verb=${b.verbrauch_kwh} einsp=${b.einspeisung_kwh} quote=${b.eigenverbrauchsquote}`,
        );
        journal = upsertDay(journal, { date: dateStr, datenqualitaet: 'ok', meterRows, buildingRow });
        stats.built++;
    }
    if (args.mode === 'write') {
        fs.writeFileSync(args.out, serializeJournal(journal));
        console.log(`Journal mit ${journal.length} Tag(en) nach ${args.out} geschrieben.`);
        console.log('Einspielen: iobroker state set solarlog.0.Database.dailyJournal "$(cat ' + args.out + ')" --ack true');
    }
    console.log(`\nFertig: ${JSON.stringify(stats)}`);
}

main().catch(e => {
    console.error('FEHLER:', e.message);
    process.exit(1);
});
