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

module.exports = { isValidEmail };
