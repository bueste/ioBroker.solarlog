'use strict';

const { expect } = require('chai');
const { renderEmailTemplate, buildReportEmailContent, DEFAULT_SUBJECT, DEFAULT_BODY } = require('./lib/email');

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

    it('renders a custom subject/body template with the period values', () => {
        const content = buildReportEmailContent(period, 'Rechnung {periode}', 'Zeitraum {von} - {bis} im Anhang.');
        expect(content.subject).to.equal('Rechnung 2026-08');
        expect(content.text).to.equal('Zeitraum 2026-08-01 - 2026-08-31 im Anhang.');
    });

    it('falls back to the default templates when subject/body are empty', () => {
        const content = buildReportEmailContent(period, '', '');
        expect(content.subject).to.equal(renderEmailTemplate(DEFAULT_SUBJECT, { periode: '2026-08', von: '2026-08-01', bis: '2026-08-31' }));
        expect(content.text).to.equal(renderEmailTemplate(DEFAULT_BODY, { periode: '2026-08', von: '2026-08-01', bis: '2026-08-31' }));
    });

    it('falls back to the default templates when subject/body are undefined', () => {
        const content = buildReportEmailContent(period, undefined, undefined);
        expect(content.subject).to.equal('Solar-Abrechnung 2026-08');
    });
});
