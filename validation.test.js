'use strict';

const { expect } = require('chai');
const { isValidEmail, parseEmailList, isValidEmailList } = require('./lib/validation');

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

describe('parseEmailList', () => {
    it('splits and trims a comma-separated list', () => {
        expect(parseEmailList('a@b.com, c@d.com,  e@f.com')).to.deep.equal(['a@b.com', 'c@d.com', 'e@f.com']);
    });

    it('drops empty entries from trailing/doubled commas', () => {
        expect(parseEmailList('a@b.com,,c@d.com,')).to.deep.equal(['a@b.com', 'c@d.com']);
    });

    it('returns an empty array for empty/undefined input', () => {
        expect(parseEmailList('')).to.deep.equal([]);
        expect(parseEmailList(undefined)).to.deep.equal([]);
    });
});

describe('isValidEmailList', () => {
    it('accepts a list where every address is valid', () => {
        expect(isValidEmailList('a@b.com, c@d.com')).to.equal(true);
    });

    it('rejects the whole list if any single address is invalid', () => {
        expect(isValidEmailList('a@b.com, bullshit')).to.equal(false);
    });

    it('rejects an empty list by default (required field, e.g. recipients)', () => {
        expect(isValidEmailList('')).to.equal(false);
    });

    it('accepts an empty list when allowEmpty is true (optional field, e.g. Cc)', () => {
        expect(isValidEmailList('', true)).to.equal(true);
    });

    it('with allowEmpty still rejects a non-empty list containing an invalid address', () => {
        expect(isValidEmailList('bullshit', true)).to.equal(false);
    });
});
