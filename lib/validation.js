'use strict';

/**
 * Simple, pragmatic e-mail syntax check (not RFC 5322 in full) - just enough to catch
 * obviously wrong config values (typos, missing @, stray whitespace) before handing
 * them to the email adapter.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidEmail(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
} // END isValidEmail

/**
 * Splits a comma-separated address list (as stored in reportRecipient/reportCc) into
 * individual, trimmed addresses. Empty entries (from a trailing/doubled comma) are
 * dropped rather than treated as an invalid address.
 *
 * @param {string} value
 * @returns {string[]}
 */
function parseEmailList(value) {
    if (!value) {
        return [];
    }
    return String(value)
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
} // END parseEmailList

/**
 * @param {string} value comma-separated address list
 * @param {boolean} [allowEmpty] true for an optional field (e.g. Cc) - an empty list is
 *   then valid; every address that IS present must still be individually valid.
 * @returns {boolean}
 */
function isValidEmailList(value, allowEmpty) {
    const list = parseEmailList(value);
    if (list.length === 0) {
        return !!allowEmpty;
    }
    return list.every(isValidEmail);
} // END isValidEmailList

module.exports = { isValidEmail, parseEmailList, isValidEmailList };
