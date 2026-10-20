(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CSVUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OPTIONAL_HEADERS = new Set([
    'caseid',
    'case_id',
    'externaltag',
    'conversationid',
    'conversation_id',
  ]);
  const DEFAULT_MAX_RECORDS = 1000;
  const DEFAULT_MAX_CHARS = 1048576;
  const MAX_IDENTIFIER_LENGTH = 256;

  function validateLimit(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }

  // Parse every field so malformed quoting in an unused column is rejected too.
  function parseRows(content) {
    const rows = [];
    let row = [];
    let field = '';
    let state = 'field-start';
    let rowTouched = false;

    function endField() {
      row.push(field);
      field = '';
      state = 'field-start';
    }

    function endRow() {
      endField();
      rows.push(row);
      row = [];
      rowTouched = false;
    }

    for (let i = 0; i < content.length; i += 1) {
      const ch = content[i];

      if (state === 'quoted') {
        if (ch === '"') {
          if (content[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            state = 'after-quote';
          }
        } else {
          field += ch;
        }
        rowTouched = true;
        continue;
      }

      if (state === 'after-quote') {
        if (ch === ',') {
          endField();
          rowTouched = true;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          if (ch === '\r' && content[i + 1] === '\n') i += 1;
          endRow();
          continue;
        }
        throw new SyntaxError(`Unexpected character after closing quote at position ${i}`);
      }

      if (ch === ',') {
        endField();
        rowTouched = true;
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && content[i + 1] === '\n') i += 1;
        endRow();
      } else if (ch === '"') {
        if (state !== 'field-start') {
          throw new SyntaxError(`Quote inside unquoted field at position ${i}`);
        }
        state = 'quoted';
        rowTouched = true;
      } else {
        field += ch;
        state = 'unquoted';
        rowTouched = true;
      }
    }

    if (state === 'quoted') {
      throw new SyntaxError('Unterminated quoted field');
    }
    // Do not manufacture an extra empty row for a trailing line ending.
    if (rowTouched || row.length > 0 || field.length > 0) {
      endRow();
    }
    return rows;
  }

  function parseIdentifiers(content, { maxRecords = DEFAULT_MAX_RECORDS, maxChars = DEFAULT_MAX_CHARS } = {}) {
    if (typeof content !== 'string') {
      throw new TypeError('CSV content must be a string');
    }
    validateLimit(maxRecords, 'maxRecords');
    validateLimit(maxChars, 'maxChars');
    if (content.length > maxChars) {
      throw new RangeError(`CSV content exceeds the ${maxChars} character limit`);
    }

    // A UTF-8 BOM is sometimes decoded into the first cell by browser file APIs.
    const csv = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const rows = parseRows(csv);
    let firstDataRow = 0;
    let headerSkipped = false;

    if (rows.length > 0 && OPTIONAL_HEADERS.has(rows[0][0].trim().toLowerCase())) {
      firstDataRow = 1;
      headerSkipped = true;
    }

    const dataRecordCount = rows.length - firstDataRow;
    if (dataRecordCount > maxRecords) {
      throw new RangeError(`CSV contains more than ${maxRecords} records`);
    }

    const identifiers = [];
    const seen = new Set();
    let duplicatesRemoved = 0;

    for (let i = firstDataRow; i < rows.length; i += 1) {
      const identifier = rows[i][0].trim();
      if (identifier.length === 0) continue;
      if (identifier.length > MAX_IDENTIFIER_LENGTH) {
        throw new RangeError(`Identifier in record ${i - firstDataRow + 1} exceeds ${MAX_IDENTIFIER_LENGTH} characters`);
      }
      if (seen.has(identifier)) {
        duplicatesRemoved += 1;
      } else {
        seen.add(identifier);
        identifiers.push(identifier);
      }
    }

    return { identifiers, duplicatesRemoved, headerSkipped };
  }

  return { parseIdentifiers };
});
