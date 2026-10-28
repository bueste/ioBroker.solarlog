'use strict';

const { expect } = require('chai');
const { MAX_DAYS, parseJournal, upsertDay, serializeJournal } = require('./lib/journal');

const row = date => ({ meter_name: 'WHG 1', date, verbrauch_kwh: 1, solarbezug_kwh: 0.5, netzbezug_kwh: 0.5 });
const entry = (date, extra = {}) => ({ date, meterRows: [row(date)], buildingRow: { date, produktion_kwh: 3 }, ...extra });

describe('journal', () => {
    it('reads an empty or missing value as an empty journal', () => {
        expect(parseJournal(null)).to.deep.equal([]);
        expect(parseJournal('')).to.deep.equal([]);
        expect(parseJournal('[]')).to.deep.equal([]);
    });

    it('treats unreadable values as empty instead of throwing', () => {
        expect(parseJournal('{kaputt')).to.deep.equal([]);
        expect(parseJournal('{"a":1}')).to.deep.equal([]);
    });

    it('drops entries without a date or meter rows', () => {
        const raw = JSON.stringify([{ date: '2026-10-01', meterRows: [] }, { meterRows: [] }, { date: '2026-10-02' }, null]);
        expect(parseJournal(raw).map(e => e.date)).to.deep.equal(['2026-10-01']);
    });

    it('adds a day and keeps the journal sorted by date', () => {
        let j = upsertDay([], entry('2026-10-02'), '2026-10-03T00:00:00Z');
        j = upsertDay(j, entry('2026-10-01'), '2026-10-03T00:00:01Z');
        expect(j.map(e => e.date)).to.deep.equal(['2026-10-01', '2026-10-02']);
        expect(j[1].writtenAt).to.equal('2026-10-03T00:00:00Z');
    });

    it('replaces the entry of the same date', () => {
        let j = upsertDay([], entry('2026-10-01'));
        j = upsertDay(j, entry('2026-10-01', { datenqualitaet: 'veraltet' }));
        expect(j).to.have.length(1);
        expect(j[0].datenqualitaet).to.equal('veraltet');
    });

    it('marks the quality ok unless it is veraltet', () => {
        expect(upsertDay([], entry('2026-10-01'))[0].datenqualitaet).to.equal('ok');
        expect(upsertDay([], entry('2026-10-01', { datenqualitaet: 'x' }))[0].datenqualitaet).to.equal('ok');
    });

    it('keeps the quality vorlaeufig of an intraday snapshot and lets the final entry replace it', () => {
        let j = upsertDay([], entry('2026-10-01', { datenqualitaet: 'vorlaeufig' }));
        expect(j[0].datenqualitaet).to.equal('vorlaeufig');
        j = upsertDay(j, entry('2026-10-01'));
        expect(j).to.have.length(1);
        expect(j[0].datenqualitaet).to.equal('ok');
    });

    it('stores a missing building row as null', () => {
        expect(upsertDay([], { date: '2026-10-01', meterRows: [row('2026-10-01')] })[0].buildingRow).to.equal(null);
    });

    it('keeps only the last MAX_DAYS days before the newest one', () => {
        let j = [];
        for (let i = 0; i < MAX_DAYS + 20; i++) {
            const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
            j = upsertDay(j, entry(d));
        }
        expect(j.length).to.equal(MAX_DAYS + 1);
        expect(j[j.length - 1].date).to.equal(new Date(Date.UTC(2026, 0, 1 + MAX_DAYS + 19)).toISOString().slice(0, 10));
    });

    it('survives a round trip through serialize and parse', () => {
        const j = upsertDay([], entry('2026-10-01'), '2026-10-02T00:00:00Z');
        expect(parseJournal(serializeJournal(j))).to.deep.equal(j);
    });
});
