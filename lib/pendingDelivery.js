'use strict';

const { parseQueue, enqueue, remove, prune, serializeQueue, MAX_AGE_DAYS } = require('./pendingQueue');

/**
 * Nightly-row delivery with an offline buffer (up to MAX_AGE_DAYS). All side effects are
 * injected so the whole behaviour is unit-testable without ioBroker or MariaDB:
 *
 * @param {object} deps
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} deps.log
 * @param {() => boolean} deps.enabled      MariaDB billing enabled in the instance config
 * @param {() => Promise<string|null>} deps.loadRaw   reads the persisted buffer (JSON string)
 * @param {(json: string, count: number) => Promise<void>} deps.saveRaw   persists it
 * @param {() => boolean} deps.hasPool      true if a usable DB pool exists right now
 * @param {() => Promise<void>} deps.ensurePool   tries to (re)establish the pool
 * @param {(meterRows: object[], buildingRow: object) => Promise<void>} deps.writeDay
 * @param {() => Promise<void>} deps.afterDelivery   e.g. regenerate the current report
 * @param {() => string} deps.today   local 'YYYY-MM-DD'
 */
function createPendingDelivery(deps) {
    const { log } = deps;
    let flushing = false;

    async function load() {
        return parseQueue(await deps.loadRaw());
    }

    async function save(queue) {
        await deps.saveRaw(serializeQueue(queue), queue.length);
    }

    function logDropped(dropped) {
        log.error(
            `Buffered billing data older than ${MAX_AGE_DAYS} days was NOT delivered and is now discarded: ${dropped.map(e => e.date).join(', ')}`,
        );
    }

    /**
     * Writes one night's rows; if MariaDB cannot take them right now they are buffered and
     * delivered later by flushPendingDays(). Never throws for a DB problem.
     */
    async function persistOrQueueDay(date, meterRows, buildingRow) {
        let written = false;
        if (!deps.hasPool()) {
            await deps.ensurePool(); // one immediate attempt before buffering
        }
        if (deps.hasPool()) {
            try {
                await deps.writeDay(meterRows, buildingRow);
                written = true;
            } catch (e) {
                log.warn(`MariaDB write failed for ${date}: ${e.message} - buffering locally for later delivery`);
            }
        } else {
            log.warn(`MariaDB not reachable for ${date} - buffering locally for later delivery`);
        }

        if (written) {
            log.info(`MariaDB: wrote ${meterRows.length} meter_daily row(s) + 1 building_daily row for ${date}`);
            try {
                const queue = await load();
                if (queue.some(e => e.date === date)) {
                    await save(remove(queue, date));
                }
                await flushPendingDays(); // DB just proved reachable - deliver older buffered days too
                await deps.afterDelivery();
            } catch (e) {
                log.warn(`Post-write housekeeping for ${date} failed (non-fatal): ${e.message}`);
            }
            return { written: true };
        }

        const { kept, dropped } = prune(enqueue(await load(), { date, meterRows, buildingRow }), date);
        await save(kept);
        if (dropped.length) {
            logDropped(dropped);
        }
        log.warn(
            `Buffered ${date} locally: ${kept.length} day(s) waiting for MariaDB (oldest ${kept[0].date}), retried every 10 minutes, kept up to ${MAX_AGE_DAYS} days.`,
        );
        return { written: false };
    }

    /** Delivers buffered days oldest-first; discards entries past the window with an error log. */
    async function flushPendingDays() {
        if (!deps.enabled() || flushing) {
            return { delivered: 0 };
        }
        flushing = true;
        let delivered = 0;
        try {
            let queue = await load();
            const { kept, dropped } = prune(queue, deps.today());
            if (dropped.length) {
                logDropped(dropped);
                queue = kept;
                await save(queue);
            }
            if (queue.length === 0) {
                return { delivered };
            }
            if (!deps.hasPool()) {
                await deps.ensurePool();
            }
            if (!deps.hasPool()) {
                log.debug(`MariaDB still unreachable - ${queue.length} buffered day(s) kept for the next attempt`);
                return { delivered };
            }
            for (const entry of [...queue]) {
                try {
                    await deps.writeDay(entry.meterRows, entry.buildingRow);
                } catch (e) {
                    log.warn(`Delivering buffered day ${entry.date} failed (${e.message}) - will retry`);
                    break;
                }
                queue = remove(queue, entry.date);
                await save(queue);
                delivered++;
                log.info(`MariaDB: delivered buffered day ${entry.date} (${queue.length} still waiting)`);
            }
            if (delivered > 0) {
                await deps.afterDelivery();
            }
        } catch (e) {
            log.warn(`flushPendingDays - Error: ${e.message}`);
        } finally {
            flushing = false;
        }
        return { delivered };
    }

    return { persistOrQueueDay, flushPendingDays };
}

module.exports = { createPendingDelivery };
