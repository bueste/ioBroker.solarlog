'use strict';

const { expect } = require('chai');
const { MAX_AGE_DAYS, parseQueue, enqueue, remove, prune, serializeQueue, ageInDays } = require('./lib/pendingQueue');

function entry(date, extra = {}) {
    return { date, meterRows: [{ meter_name: 'WHG 1', reading_date: date }], buildingRow: { reading_date: date }, ...extra };
}

describe('pendingQueue', () => {
    it('keeps the buffer window at 90 days', () => {
        expect(MAX_AGE_DAYS).to.equal(90);
    });

    describe('parseQueue', () => {
        it('returns an empty queue for missing, empty or corrupt input instead of throwing', () => {
            expect(parseQueue(undefined)).to.deep.equal([]);
            expect(parseQueue('')).to.deep.equal([]);
            expect(parseQueue('{not json')).to.deep.equal([]);
            expect(parseQueue('{"a":1}')).to.deep.equal([]);
        });

        it('drops malformed entries but keeps valid ones', () => {
            const json = JSON.stringify([entry('2026-09-10'), { date: '2026-09-11' }, null, 'x']);
            expect(parseQueue(json).map(e => e.date)).to.deep.equal(['2026-09-10']);
        });

        it('round-trips through serializeQueue', () => {
            const q = [entry('2026-09-10'), entry('2026-09-11')];
            expect(parseQueue(serializeQueue(q))).to.deep.equal(q);
        });
    });

    describe('enqueue', () => {
        it('keeps entries sorted ascending by date so they are delivered oldest-first', () => {
            let q = [];
            q = enqueue(q, entry('2026-09-12'));
            q = enqueue(q, entry('2026-09-10'));
            q = enqueue(q, entry('2026-09-11'));
            expect(q.map(e => e.date)).to.deep.equal(['2026-09-10', '2026-09-11', '2026-09-12']);
        });

        it('replaces an existing entry for the same date instead of duplicating it', () => {
            let q = enqueue([], entry('2026-09-10', { buildingRow: { reading_date: '2026-09-10', v: 1 } }));
            q = enqueue(q, entry('2026-09-10', { buildingRow: { reading_date: '2026-09-10', v: 2 } }));
            expect(q).to.have.lengthOf(1);
            expect(q[0].buildingRow.v).to.equal(2);
        });

        it('stamps queuedAt and does not mutate the input queue', () => {
            const original = [entry('2026-09-10')];
            const q = enqueue(original, entry('2026-09-11'));
            expect(original).to.have.lengthOf(1);
            expect(q[1].queuedAt).to.be.a('string');
        });
    });

    describe('remove', () => {
        it('removes only the delivered date', () => {
            const q = remove([entry('2026-09-10'), entry('2026-09-11')], '2026-09-10');
            expect(q.map(e => e.date)).to.deep.equal(['2026-09-11']);
        });
    });

    describe('prune / ageInDays', () => {
        it('counts calendar days independent of DST changes', () => {
            expect(ageInDays('2026-10-24', '2026-10-26')).to.equal(2); // DST ends 2026-10-25
            expect(ageInDays('2026-03-27', '2026-03-29')).to.equal(2); // DST starts 2026-03-29
        });

        it('keeps an entry exactly 90 days old and drops one that is 91 days old', () => {
            const today = '2026-12-31';
            const kept90 = '2026-10-02'; // 90 days before
            const dropped91 = '2026-10-01'; // 91 days before
            expect(ageInDays(kept90, today)).to.equal(90);
            const { kept, dropped } = prune([entry(dropped91), entry(kept90)], today);
            expect(kept.map(e => e.date)).to.deep.equal([kept90]);
            expect(dropped.map(e => e.date)).to.deep.equal([dropped91]);
        });

        it('returns everything as kept when nothing is expired', () => {
            const { kept, dropped } = prune([entry('2026-09-10')], '2026-09-30');
            expect(kept).to.have.lengthOf(1);
            expect(dropped).to.have.lengthOf(0);
        });
    });
});
