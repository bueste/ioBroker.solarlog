'use strict';

const { expect } = require('chai');
const { emptyState, parseState, reportKey, registerDue, markSent, expirePending } = require('./lib/reportQueue');

const due = { label: '2026-09', fromDate: '2026-09-01', toDate: '2026-09-30' };

describe('reportQueue', () => {
    it('registers a due report as pending', () => {
        const { state, replaced } = registerDue(emptyState(), due, 'monthly', '2026-10-01');
        expect(state.pending.key).to.equal('monthly:2026-09');
        expect(state.pending.since).to.equal('2026-10-01');
        expect(replaced).to.equal(null);
    });

    it('does nothing on a day when no report is due', () => {
        const s = emptyState();
        expect(registerDue(s, null, 'monthly', '2026-10-02').state).to.equal(s);
    });

    it('does not register a report that was already sent', () => {
        const sent = { lastKey: 'monthly:2026-09', pending: null };
        expect(registerDue(sent, due, 'monthly', '2026-10-01').state.pending).to.equal(null);
    });

    it('keeps the original pending entry (and its start date) when the same report is due again the next hour', () => {
        const first = registerDue(emptyState(), due, 'monthly', '2026-10-01').state;
        const again = registerDue(first, due, 'monthly', '2026-10-01').state;
        expect(again).to.equal(first);
    });

    it('markSent remembers the key and clears the pending report', () => {
        const pending = registerDue(emptyState(), due, 'monthly', '2026-10-01').state;
        expect(markSent(pending)).to.deep.equal({ lastKey: 'monthly:2026-09', pending: null });
    });

    it('a failed send leaves it pending, so the next hourly run tries again (the point of this module)', () => {
        let state = registerDue(emptyState(), due, 'monthly', '2026-10-01').state; // 00:10, send fails
        state = registerDue(state, due, 'monthly', '2026-10-01').state; // 01:10
        expect(state.pending.key).to.equal('monthly:2026-09');
        state = markSent(state); // 02:10 works
        expect(state.pending).to.equal(null);
        // and it is not registered again the same day
        expect(registerDue(state, due, 'monthly', '2026-10-01').state.pending).to.equal(null);
    });

    it('a newer due report pushes out an older unsent one and reports it', () => {
        const old = registerDue(emptyState(), due, 'monthly', '2026-10-01').state;
        const next = { label: '2026-10', fromDate: '2026-10-01', toDate: '2026-10-31' };
        const { state, replaced } = registerDue(old, next, 'monthly', '2026-11-01');
        expect(state.pending.key).to.equal('monthly:2026-10');
        expect(replaced.key).to.equal('monthly:2026-09');
    });

    it('gives up on a pending report after 7 days', () => {
        const state = registerDue(emptyState(), due, 'monthly', '2026-10-01').state;
        expect(expirePending(state, '2026-10-08').expired).to.equal(null);
        const out = expirePending(state, '2026-10-09');
        expect(out.expired.key).to.equal('monthly:2026-09');
        expect(out.state.pending).to.equal(null);
    });

    it('survives a missing or corrupt persisted state', () => {
        expect(parseState(null)).to.deep.equal(emptyState());
        expect(parseState('{not json')).to.deep.equal(emptyState());
        expect(parseState('{"lastKey":5,"pending":{"nokey":1}}')).to.deep.equal(emptyState());
    });

    it('round-trips a valid state', () => {
        const state = registerDue({ lastKey: 'monthly:2026-08', pending: null }, due, 'monthly', '2026-10-01').state;
        expect(parseState(JSON.stringify(state))).to.deep.equal(state);
        expect(reportKey('quarterly', { label: '2026-Q3' })).to.equal('quarterly:2026-Q3');
    });
});
