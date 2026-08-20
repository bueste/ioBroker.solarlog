'use strict';

// Builds the scheduled/test report e-mail's subject and body from the user-configured
// templates (Billing tab: reportEmailSubject/reportEmailBody), with a few placeholders
// substituted in. Deliberately plain text only - the caller must only ever put the
// result into the email adapter's "text" field, never "html", so a template can never
// be rendered as markup even if someone types something that looks like a tag into it.

const DEFAULT_SUBJECT = 'Solar-Abrechnung {periode}';
const DEFAULT_BODY = 'Im Anhang die Abrechnung für {periode} ({von} bis {bis}).';

/**
 * @param {string} template
 * @param {{periode: string, von: string, bis: string}} values
 * @returns {string}
 */
function renderEmailTemplate(template, values) {
    return String(template)
        .replace(/\{periode\}/g, values.periode)
        .replace(/\{von\}/g, values.von)
        .replace(/\{bis\}/g, values.bis);
} // END renderEmailTemplate

/**
 * @param {{fromDate: string, toDate: string, label: string}} period
 * @param {string} [subjectTemplate] falls back to DEFAULT_SUBJECT when empty
 * @param {string} [bodyTemplate] falls back to DEFAULT_BODY when empty
 * @returns {{subject: string, text: string}}
 */
function buildReportEmailContent(period, subjectTemplate, bodyTemplate) {
    const values = { periode: period.label, von: period.fromDate, bis: period.toDate };
    return {
        subject: renderEmailTemplate(subjectTemplate || DEFAULT_SUBJECT, values),
        text: renderEmailTemplate(bodyTemplate || DEFAULT_BODY, values),
    };
} // END buildReportEmailContent

module.exports = { renderEmailTemplate, buildReportEmailContent, DEFAULT_SUBJECT, DEFAULT_BODY };
