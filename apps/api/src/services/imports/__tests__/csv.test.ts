import { describe, expect, it } from 'vitest';

import { parseCsv, parseDay, parseDecimal, sniffDelimiter, splitCells } from '../csv';

/** Pure CSV plumbing (§13.4 V4-P8): delimiter sniffing, quoting, messy numbers/dates. */

describe('sniffDelimiter', () => {
  it('prefers the delimiter that splits the header most often', () => {
    expect(sniffDelimiter('Datum;Typ;ISIN')).toBe(';');
    expect(sniffDelimiter('Date,Type,Symbol')).toBe(',');
    expect(sniffDelimiter('Date\tType\tSymbol')).toBe('\t');
  });

  it('ignores delimiters inside quotes', () => {
    expect(sniffDelimiter('"a;b",c,d')).toBe(',');
  });
});

describe('splitCells', () => {
  it('splits plain cells and trims whitespace', () => {
    expect(splitCells('a; b ;c', ';')).toEqual(['a', 'b', 'c']);
  });

  it('honors quotes with embedded delimiters and "" escapes', () => {
    expect(splitCells('"a;b";"say ""hi""";c', ';')).toEqual(['a;b', 'say "hi"', 'c']);
  });

  it('keeps empty cells positional', () => {
    expect(splitCells('a;;;d', ';')).toEqual(['a', '', '', 'd']);
  });
});

describe('parseCsv', () => {
  it('separates header from records, skipping blank lines but keeping physical line numbers', () => {
    const parsed = parseCsv('A;B\n\n1;2\r\n3;4\n');
    expect(parsed.delimiter).toBe(';');
    expect(parsed.header?.cells).toEqual(['A', 'B']);
    expect(parsed.records.map((r) => r.line)).toEqual([3, 4]);
    expect(parsed.records[0]?.cells).toEqual(['1', '2']);
    expect(parsed.records[0]?.raw).toBe('1;2');
  });

  it('strips a UTF-8 BOM before the header', () => {
    const parsed = parseCsv('﻿A;B\n1;2');
    expect(parsed.header?.cells).toEqual(['A', 'B']);
  });

  it('returns no header for an empty file', () => {
    expect(parseCsv('').header).toBeNull();
    expect(parseCsv('\n\n').header).toBeNull();
  });
});

describe('parseDecimal', () => {
  it('parses German notation (comma decimal, dot thousands)', () => {
    expect(parseDecimal('1.234,56')).toBe(1234.56);
    expect(parseDecimal('0,5')).toBe(0.5);
    expect(parseDecimal('-751,00')).toBe(-751);
  });

  it('parses plain notation', () => {
    expect(parseDecimal('1234.56')).toBe(1234.56);
    expect(parseDecimal('5')).toBe(5);
    expect(parseDecimal('-3')).toBe(-3);
  });

  it('refuses grouping-dot integers without a decimal comma (ambiguous notation)', () => {
    // `1.000` is German 1000 or plain 1.0 — guessing wrong books ~1000× off.
    expect(parseDecimal('1.000')).toBeNull();
    expect(parseDecimal('12.345')).toBeNull();
    expect(parseDecimal('1.234.567')).toBeNull();
    // With a decimal comma or a non-3-digit fraction there is no ambiguity.
    expect(parseDecimal('1.000,00')).toBe(1000);
    expect(parseDecimal('1234.5')).toBe(1234.5);
    expect(parseDecimal('1.2345')).toBe(1.2345);
  });

  it('survives currency suffixes and returns null for junk', () => {
    expect(parseDecimal('-751,00 EUR')).toBe(-751);
    expect(parseDecimal('€ 12,50')).toBe(12.5);
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('-')).toBeNull();
    expect(parseDecimal('1.2.3,4,5')).toBeNull();
  });
});

describe('parseDay', () => {
  it('parses ISO and German days, anchored at 12:00 UTC', () => {
    expect(parseDay('2024-01-15')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(parseDay('15.01.2024')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(parseDay('2024-01-15T09:30:00')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('rejects impossible or unrecognizable dates', () => {
    expect(parseDay('31.02.2024')).toBeNull();
    expect(parseDay('2024-13-01')).toBeNull();
    expect(parseDay('not a date')).toBeNull();
    expect(parseDay('')).toBeNull();
  });
});
