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

    // The buffer is one persisted JSON value that is read, changed and written back.
    // Two such read-modify-write cycles must never interleave (the 10-minute delivery job
    // and the nightly write can run at the same time): the later save would otherwise
    // overwrite the earlier one with a stale copy and silently drop a buffered day.
    // Every queue mutation therefore re-reads the buffer INSIDE this lock.
    let lockTail = Promise.resolve();
    function withLock(fn) {
        const run = lockTail.then(() => fn());
        lockTail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    async function load() {
        const raw = await deps.loadRaw();
        const queue = parseQueue(raw);
        if (raw && raw.trim() !== '[]' && queue.length === 0) {
            // Not silent: the next save would overwrite whatever the unreadable value held.
            log.error('Database.pendingRows holds a value that could not be read - it is treated as empty.');
        }
        return queue;
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
        try {
            if (!deps.hasPool()) {
                await deps.ensurePool(); // one immediate attempt before buffering
            }
        } catch (e) {
            log.warn(`MariaDB reconnect before writing ${date} failed: ${e.message}`);
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
                await withLock(async () => {
                    const queue = await load();
                    if (queue.some(e => e.date === date)) {
                        await save(remove(queue, date));
                    }
                });
                await flushPendingDays(); // DB just proved reachable - deliver older buffered days too
                await deps.afterDelivery();
            } catch (e) {
                log.warn(`Post-write housekeeping for ${date} failed (non-fatal): ${e.message}`);
            }
            return { written: true };
        }

        const { kept, dropped } = await withLock(async () => {
            const result = prune(enqueue(await load(), { date, meterRows, buildingRow }), date);
            await save(result.kept);
            return result;
        });
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
            const queue = await withLock(async () => {
                const current = await load();
                const { kept, dropped } = prune(current, deps.today());
                if (dropped.length) {
                    logDropped(dropped);
                    await save(kept);
                }
                return kept;
            });
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
            for (const entry of queue) {
                try {
                    await deps.writeDay(entry.meterRows, entry.buildingRow);
                } catch (e) {
                    log.warn(`Delivering buffered day ${entry.date} failed (${e.message}) - will retry`);
                    break;
                }
                // Drop exactly the delivered entry from the CURRENT buffer (not from this
                // loop's snapshot): a night buffered meanwhile must survive, and so must a
                // newer re-queue of the same date (different queuedAt).
                const waiting = await withLock(async () => {
                    const current = await load();
                    const rest = current.filter(e => !(e.date === entry.date && e.queuedAt === entry.queuedAt));
                    await save(rest);
                    return rest.length;
                });
                delivered++;
                log.info(`MariaDB: delivered buffered day ${entry.date} (${waiting} still waiting)`);
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
