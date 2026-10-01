'use strict';

const { expect } = require('chai');
const { createPendingDelivery } = require('./lib/pendingDelivery');

/** In-memory stand-in for MariaDB + the adapter state + the logger. */
function createEnv({ today = '2026-09-30' } = {}) {
    const env = {
        db: new Map(), // date -> {meterRows, buildingRow}
        raw: null, // persisted buffer JSON
        pendingCount: 0,
        pool: true, // is a pool available right now
        poolComesBackOnEnsure: false,
        failNextWrites: 0,
        ensureCalls: 0,
        afterDeliveryCalls: 0,
        logs: [],
    };
    const log = {};
    for (const level of ['info', 'warn', 'error', 'debug']) {
        log[level] = msg => env.logs.push(`${level}: ${msg}`);
    }
    env.delivery = createPendingDelivery({
        log,
        enabled: () => env.enabled !== false,
        loadRaw: async () => env.raw,
        saveRaw: async (json, count) => {
            env.raw = json;
            env.pendingCount = count;
        },
        hasPool: () => env.pool,
        ensurePool: async () => {
            env.ensureCalls++;
            if (env.poolComesBackOnEnsure) {
                env.pool = true;
            }
        },
        writeDay: async (meterRows, buildingRow) => {
            if (env.failNextWrites > 0) {
                env.failNextWrites--;
                throw new Error('simulated write failure');
            }
            env.db.set(buildingRow.reading_date, { meterRows, buildingRow });
        },
        afterDelivery: async () => {
            env.afterDeliveryCalls++;
        },
        today: () => today,
    });
    return env;
}

const rows = date => ({
    meterRows: [{ meter_name: 'WHG 1', reading_date: date, verbrauch_kwh: 1 }],
    buildingRow: { reading_date: date, produktion_kwh: 10 },
});

describe('pendingDelivery', () => {
    it('writes straight through when MariaDB is up and leaves no buffer behind', async () => {
        const env = createEnv();
        const r = rows('2026-09-30');
        const res = await env.delivery.persistOrQueueDay('2026-09-30', r.meterRows, r.buildingRow);
        expect(res.written).to.equal(true);
        expect(env.db.has('2026-09-30')).to.equal(true);
        expect(env.pendingCount).to.equal(0);
        expect(env.afterDeliveryCalls).to.equal(1);
    });

    it('buffers the night when there is no pool and the immediate reconnect attempt fails', async () => {
        const env = createEnv();
        env.pool = false;
        const r = rows('2026-09-30');
        const res = await env.delivery.persistOrQueueDay('2026-09-30', r.meterRows, r.buildingRow);
        expect(res.written).to.equal(false);
        expect(env.ensureCalls).to.equal(1);
        expect(env.db.size).to.equal(0);
        expect(env.pendingCount).to.equal(1);
        expect(env.raw).to.include('2026-09-30');
    });

    it('writes immediately if the one reconnect attempt before buffering succeeds', async () => {
        const env = createEnv();
        env.pool = false;
        env.poolComesBackOnEnsure = true;
        const r = rows('2026-09-30');
        const res = await env.delivery.persistOrQueueDay('2026-09-30', r.meterRows, r.buildingRow);
        expect(res.written).to.equal(true);
        expect(env.pendingCount).to.equal(0);
    });

    it('buffers when the pool exists but the write itself fails (tunnel dropped mid-night)', async () => {
        const env = createEnv();
        env.failNextWrites = 1;
        const r = rows('2026-09-30');
        const res = await env.delivery.persistOrQueueDay('2026-09-30', r.meterRows, r.buildingRow);
        expect(res.written).to.equal(false);
        expect(env.pendingCount).to.equal(1);
        expect(env.logs.some(l => l.startsWith('warn: MariaDB write failed for 2026-09-30'))).to.equal(true);
    });

    it('delivers all buffered days oldest-first once MariaDB is back, and empties the buffer', async () => {
        const env = createEnv();
        env.pool = false;
        for (const d of ['2026-09-12', '2026-09-10', '2026-09-11']) {
            const r = rows(d);
            await env.delivery.persistOrQueueDay(d, r.meterRows, r.buildingRow);
        }
        expect(env.pendingCount).to.equal(3);

        const order = [];
        env.pool = true;
        const origSet = env.db.set.bind(env.db);
        env.db.set = (k, v) => {
            order.push(k);
            return origSet(k, v);
        };
        const res = await env.delivery.flushPendingDays();
        expect(res.delivered).to.equal(3);
        expect(order).to.deep.equal(['2026-09-10', '2026-09-11', '2026-09-12']);
        expect(env.pendingCount).to.equal(0);
        expect(env.afterDeliveryCalls).to.equal(1);
    });

    it('re-establishes the pool itself during a flush (no restart / manual test button needed)', async () => {
        const env = createEnv();
        env.pool = false;
        const r = rows('2026-09-10');
        await env.delivery.persistOrQueueDay('2026-09-10', r.meterRows, r.buildingRow);
        env.ensureCalls = 0;
        env.poolComesBackOnEnsure = true;
        const res = await env.delivery.flushPendingDays();
        expect(env.ensureCalls).to.equal(1);
        expect(res.delivered).to.equal(1);
    });

    it('keeps everything buffered while MariaDB is still unreachable', async () => {
        const env = createEnv();
        env.pool = false;
        const r = rows('2026-09-10');
        await env.delivery.persistOrQueueDay('2026-09-10', r.meterRows, r.buildingRow);
        const res = await env.delivery.flushPendingDays();
        expect(res.delivered).to.equal(0);
        expect(env.pendingCount).to.equal(1);
    });

    it('stops at the first failing day, keeps it and the rest buffered, and delivers nothing twice', async () => {
        const env = createEnv();
        env.pool = false;
        for (const d of ['2026-09-10', '2026-09-11', '2026-09-12']) {
            const r = rows(d);
            await env.delivery.persistOrQueueDay(d, r.meterRows, r.buildingRow);
        }
        env.pool = true;
        env.failNextWrites = 0;
        // first day fine, second fails
        let calls = 0;
        const origWrite = env.db.set.bind(env.db);
        env.db.set = (k, v) => {
            calls++;
            if (calls === 2) {
                throw new Error('simulated write failure');
            }
            return origWrite(k, v);
        };
        const res1 = await env.delivery.flushPendingDays();
        expect(res1.delivered).to.equal(1);
        expect(env.pendingCount).to.equal(2);
        expect([...env.db.keys()]).to.deep.equal(['2026-09-10']);

        env.db.set = origWrite; // DB healthy again
        const res2 = await env.delivery.flushPendingDays();
        expect(res2.delivered).to.equal(2);
        expect(env.pendingCount).to.equal(0);
        expect([...env.db.keys()].sort()).to.deep.equal(['2026-09-10', '2026-09-11', '2026-09-12']);
    });

    it('re-buffering the same date replaces it instead of duplicating', async () => {
        const env = createEnv();
        env.pool = false;
        const a = rows('2026-09-10');
        await env.delivery.persistOrQueueDay('2026-09-10', a.meterRows, a.buildingRow);
        await env.delivery.persistOrQueueDay('2026-09-10', a.meterRows, { ...a.buildingRow, produktion_kwh: 99 });
        expect(env.pendingCount).to.equal(1);
        expect(env.raw).to.include('"produktion_kwh":99');
    });

    it('discards days older than 90 days with a loud error instead of delivering or silently keeping them', async () => {
        const env = createEnv({ today: '2026-12-31' });
        env.pool = false;
        const old = rows('2026-09-01'); // 121 days old
        env.raw = JSON.stringify([{ date: '2026-09-01', ...old }]);
        const fresh = rows('2026-12-30');
        await env.delivery.persistOrQueueDay('2026-12-30', fresh.meterRows, fresh.buildingRow);
        expect(env.pendingCount).to.equal(1);
        expect(env.raw).to.not.include('2026-09-01');
        expect(env.logs.some(l => l.startsWith('error:') && l.includes('2026-09-01'))).to.equal(true);
    });

    it('a successful night also delivers older buffered days (the DB just proved it is reachable)', async () => {
        const env = createEnv();
        env.pool = false;
        const old = rows('2026-09-29');
        await env.delivery.persistOrQueueDay('2026-09-29', old.meterRows, old.buildingRow);
        env.pool = true;
        const tonight = rows('2026-09-30');
        await env.delivery.persistOrQueueDay('2026-09-30', tonight.meterRows, tonight.buildingRow);
        expect([...env.db.keys()].sort()).to.deep.equal(['2026-09-29', '2026-09-30']);
        expect(env.pendingCount).to.equal(0);
    });

    it('does nothing at all when MariaDB billing is disabled', async () => {
        const env = createEnv();
        env.enabled = false;
        env.raw = JSON.stringify([{ date: '2026-09-10', ...rows('2026-09-10') }]);
        const res = await env.delivery.flushPendingDays();
        expect(res.delivered).to.equal(0);
        expect(env.ensureCalls).to.equal(0);
        expect(env.db.size).to.equal(0);
    });

    it('survives a corrupt persisted buffer (treated as empty) instead of crashing the nightly run', async () => {
        const env = createEnv();
        env.raw = '{this is not json';
        const r = rows('2026-09-30');
        const res = await env.delivery.persistOrQueueDay('2026-09-30', r.meterRows, r.buildingRow);
        expect(res.written).to.equal(true);
    });
});
