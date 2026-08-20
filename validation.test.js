'use strict';

const { expect } = require('chai');
const { isValidEmail } = require('./lib/validation');

describe('isValidEmail', () => {
    it('accepts a normal address', () => {
        expect(isValidEmail('mieter@example.com')).to.equal(true);
    });

    it('accepts addresses with subdomains and plus-tags', () => {
        expect(isValidEmail('user+tag@mail.example.co.uk')).to.equal(true);
    });

    it('rejects a bare word with no @', () => {
        expect(isValidEmail('bullshit')).to.equal(false);
    });

    it('rejects missing domain', () => {
        expect(isValidEmail('user@')).to.equal(false);
    });

    it('rejects missing local part', () => {
        expect(isValidEmail('@example.com')).to.equal(false);
    });

    it('rejects a domain with no dot', () => {
        expect(isValidEmail('user@localhost')).to.equal(false);
    });

    it('rejects embedded whitespace', () => {
        expect(isValidEmail('user @example.com')).to.equal(false);
    });

    it('rejects empty string', () => {
        expect(isValidEmail('')).to.equal(false);
    });

    it('rejects non-string input', () => {
        expect(isValidEmail(undefined)).to.equal(false);
    });
});
