'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIdentifiers } = require('../csv-utils');

test('reads the first column, trims values, and removes duplicates', () => {
  assert.deepEqual(parseIdentifiers('  abc  ,ignored\r\ndef,also ignored\nabc\n\n'), {
    identifiers: ['abc', 'def'],
    duplicatesRemoved: 1,
    headerSkipped: false,
  });
});

test('skips recognized optional headers case-insensitively', () => {
  for (const header of ['caseId', 'CASE_ID', 'externalTag', 'ConversationId', 'conversation_id']) {
    const result = parseIdentifiers(`${header},other\r\nvalue,unused`);
    assert.deepEqual(result, {
      identifiers: ['value'],
      duplicatesRemoved: 0,
      headerSkipped: true,
    });
  }
});

test('handles a BOM, quoted commas, escaped quotes, and CRLF', () => {
  assert.deepEqual(parseIdentifiers('\ufeffcase_id,note\r\n"id,one","say ""hi"""\r\nlast,x'), {
    identifiers: ['id,one', 'last'],
    duplicatesRemoved: 0,
    headerSkipped: true,
  });
});

test('allows line breaks inside quoted fields', () => {
  assert.deepEqual(parseIdentifiers('"first\r\nsecond",ignored\r\nthird'), {
    identifiers: ['first\r\nsecond', 'third'],
    duplicatesRemoved: 0,
    headerSkipped: false,
  });
});

test('rejects malformed quotes, including in columns beyond the identifier', () => {
  for (const csv of ['"unterminated', 'ab"cd', '"closed"tail', 'ok,"broken']) {
    assert.throws(() => parseIdentifiers(csv), SyntaxError, csv);
  }
});

test('enforces input size, data record count, and identifier length limits', () => {
  assert.throws(() => parseIdentifiers('long', { maxChars: 3 }), RangeError);
  assert.throws(() => parseIdentifiers('one\ntwo', { maxRecords: 1 }), RangeError);
  assert.throws(() => parseIdentifiers('x'.repeat(257)), RangeError);
  assert.deepEqual(parseIdentifiers('a\nb', { maxRecords: 2, maxChars: 3 }).identifiers, ['a', 'b']);
});

test('rejects non-string input and invalid limits', () => {
  assert.throws(() => parseIdentifiers(null), TypeError);
  assert.throws(() => parseIdentifiers('', { maxRecords: -1 }), RangeError);
  assert.throws(() => parseIdentifiers('', { maxChars: 1.5 }), RangeError);
});
