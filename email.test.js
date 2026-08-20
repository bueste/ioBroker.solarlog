'use strict';

const { expect } = require('chai');
const { renderEmailTemplate, buildReportEmailContent } = require('./lib/email');

describe('renderEmailTemplate', () => {
    it('substitutes all three placeholders', () => {
        const result = renderEmailTemplate('{periode}: {von} bis {bis}', {
            periode: '2026-08',
            von: '2026-08-01',
            bis: '2026-08-31',
        });
        expect(result).to.equal('2026-08: 2026-08-01 bis 2026-08-31');
    });

    it('substitutes a repeated placeholder every time it occurs', () => {
        const result = renderEmailTemplate('{periode} - {periode}', { periode: 'X', von: '', bis: '' });
        expect(result).to.equal('X - X');
    });

    it('leaves plain text without placeholders untouched', () => {
        const result = renderEmailTemplate('Hallo, hier ist Ihre Abrechnung.', { periode: '', von: '', bis: '' });
        expect(result).to.equal('Hallo, hier ist Ihre Abrechnung.');
    });
});

describe('buildReportEmailContent', () => {
    const period = { label: '2026-08', fromDate: '2026-08-01', toDate: '2026-08-31' };

    // Switzerland uses DD-MM-YYYY / "August 2026", never ISO "2026-08-01" - these
    // placeholders are the only place a period reaches a human reader (a tenant's inbox).
    it('renders {periode} as a spelled-out German month/year, and {von}/{bis} as DD-MM-YYYY', () => {
        const content = buildReportEmailContent(period, 'Rechnung {periode}', 'Zeitraum {von} - {bis} im Anhang.');
        expect(content.subject).to.equal('Rechnung August 2026');
        expect(content.text).to.equal('Zeitraum 01-08-2026 - 31-08-2026 im Anhang.');
    });

    it('falls back to the default templates (also Swiss-formatted) when subject/body are empty', () => {
        const content = buildReportEmailContent(period, '', '');
        expect(content.subject).to.equal('Solar-Abrechnung August 2026');
        expect(content.text).to.equal('Im Anhang die Abrechnung für August 2026 (01-08-2026 bis 31-08-2026).');
    });

    it('falls back to the default templates when subject/body are undefined', () => {
        const content = buildReportEmailContent(period, undefined, undefined);
        expect(content.subject).to.equal('Solar-Abrechnung August 2026');
    });

    it('passes quarterly/yearly labels through unchanged (no natural Swiss equivalent for "2026-Q3")', () => {
        const quarterly = buildReportEmailContent({ label: '2026-Q3', fromDate: '2026-07-01', toDate: '2026-09-30' });
        expect(quarterly.subject).to.equal('Solar-Abrechnung 2026-Q3');
        const yearly = buildReportEmailContent({ label: '2026', fromDate: '2026-01-01', toDate: '2026-12-31' });
        expect(yearly.subject).to.equal('Solar-Abrechnung 2026');
    });
});
