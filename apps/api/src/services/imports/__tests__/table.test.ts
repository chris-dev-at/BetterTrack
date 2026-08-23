import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parseEnglishDecimal,
  parseLocalizedDay,
  parseLocalizedDecimal,
  sniffTable,
  UnsupportedFileFormatError,
} from '../table';

/**
 * Universal table sniffing (§16 2026-07-31): delimiter + header-row detection
 * under preamble lines, encoding/BOM handling, data-sampled locale detection,
 * and the locale-aware parsers that consume the results.
 */

const buf = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('sniffTable — delimiter + header row', () => {
  it('finds the header on the first line of a plain export', () => {
    const table = sniffTable(buf('Datum;Typ;Betrag\n2024-01-02;Einzahlung;100,00'), 'a.csv');
    expect(table?.delimiter).toBe(';');
    expect(table?.headerRowIndex).toBe(1);
    expect(table?.headers).toEqual(['Datum', 'Typ', 'Betrag']);
    expect(table?.rows).toEqual([['2024-01-02', 'Einzahlung', '100,00']]);
    expect(table?.lineNumbers).toEqual([2]);
  });

  it('detects tab-delimited files', () => {
    const table = sniffTable(buf('Date\tAmount\n2024-01-01\t5.00'), 'b.tsv');
    expect(table?.delimiter).toBe('\t');
  });

  it('skips broker preamble lines to the real header, keeping physical line numbers', () => {
    const table = sniffTable(
      buf(
        [
          'Flatex Kontoumsätze;Depot 1234',
          'Zeitraum;01.01.2024 - 30.06.2024',
          '',
          'Buchtag;Valuta;Buchungsinformationen;TA-Nr.;Betrag',
          '02.01.2024;02.01.2024;Einzahlung;100001;500,00',
        ].join('\n'),
      ),
      'flatex.csv',
    );
    expect(table?.delimiter).toBe(';');
    expect(table?.headerRowIndex).toBe(4);
    expect(table?.headers).toEqual([
      'Buchtag',
      'Valuta',
      'Buchungsinformationen',
      'TA-Nr.',
      'Betrag',
    ]);
    expect(table?.rows).toHaveLength(1);
    expect(table?.lineNumbers).toEqual([5]);
  });

  it('treats a data-like first row as data, reporting that there is no header', () => {
    const table = sniffTable(buf('1,2\n3,4'), 'raw.csv');
    expect(table?.headerRowIndex).toBe(-1);
    expect(table?.headers).toEqual([]);
    expect(table?.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('returns null for an empty or blank file', () => {
    expect(sniffTable(buf(''), 'empty.csv')).toBeNull();
    expect(sniffTable(buf('\n \r\n'), 'blank.csv')).toBeNull();
  });
});

describe('sniffTable — encodings', () => {
  it('strips a UTF-8 BOM', () => {
    const table = sniffTable(buf('﻿Datum;Betrag\n2024-01-02;1,00'), 'bom.csv');
    expect(table?.encoding).toBe('utf-8');
    expect(table?.headers).toEqual(['Datum', 'Betrag']);
  });

  it('decodes UTF-16LE with BOM', () => {
    const table = sniffTable(Buffer.from('﻿Datum;Betrag\n02.01.2024;1,00', 'utf16le'), 'le.csv');
    expect(table?.encoding).toBe('utf-16le');
    expect(table?.headers).toEqual(['Datum', 'Betrag']);
  });

  it('refuses XLSX containers and .xlsx filenames until an XLSX front-end exists', () => {
    const zipMagic = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    expect(() => sniffTable(zipMagic, 'statement.xlsx')).toThrow(UnsupportedFileFormatError);
    expect(() => sniffTable(buf('A,B\n1,2'), 'workbook.xlsx')).toThrow(/unsupported file format/);
  });
});

describe('sniffTable — locales sampled from DATA rows', () => {
  it.each([
    // ibkr.csv is a MULTI-SECTION statement: no single header exists, so the
    // mechanical sniff lands on the first modal-width header-like row (the
    // Deposits & Withdrawals section at physical line 7). Per-section mapping
    // is proven in fixtureParity.test.ts.
    ['erste-george.csv', ';', 1, 'de', 'de', 'EUR'],
    ['flatex-cash.csv', ';', 1, 'de', 'de', 'EUR'],
    ['flatex-securities.csv', ';', 1, 'de', 'de', 'EUR'],
    ['george.csv', ';', 1, 'de', 'de', 'EUR'],
    ['ibkr.csv', ',', 7, 'iso', 'en', 'EUR'],
    ['n26.csv', ',', 1, 'iso', 'en', 'EUR'],
    ['raiffeisen-elba.csv', ';', 1, 'de', 'de', 'EUR'],
    ['revolut.csv', ',', 1, 'iso', 'en', 'EUR'],
    ['trade-republic.csv', ';', 1, 'iso', 'de', 'EUR'],
  ])(
    '%s sniffs delimiter %j, header line %s, dates %s, numbers %s, currency %s',
    (
      fixture: string,
      delimiter: string,
      headerRowIndex: number,
      dateLocale: string,
      numberLocale: string,
      defaultCurrency: string,
    ) => {
      const table = readFixtureTable(fixture);
      expect(table.delimiter).toBe(delimiter);
      expect(table.headerRowIndex).toBe(headerRowIndex);
      expect(table.dateLocale).toBe(dateLocale);
      expect(table.numberLocale).toBe(numberLocale);
      expect(table.defaultCurrency).toBe(defaultCurrency);
    },
  );

  it('detects US slash dates as their own locale', () => {
    const table = sniffTable(
      buf('Date,Description,Amount\n01/15/2024,Test,-42.50\n02/20/2024,X,10.00'),
      'us.csv',
    );
    expect(table?.dateLocale).toBe('us');
    expect(table?.numberLocale).toBe('en');
  });
});

function readFixtureTable(fixture: string): NonNullable<ReturnType<typeof sniffTable>> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const table = sniffTable(readFileSync(path.join(dir, fixture)), fixture);
  if (!table) throw new Error(`fixture ${fixture} sniffed to null`);
  return table;
}

describe('parseLocalizedDecimal', () => {
  it('parses through csv.parseDecimal under the German locale', () => {
    expect(parseLocalizedDecimal('1.234,56', 'de')).toBe(1234.56);
    expect(parseLocalizedDecimal('-751,00 EUR', 'de')).toBe(-751);
    expect(parseLocalizedDecimal('1.000', 'de')).toBeNull();
  });

  it('parses dot-decimal/comma-grouped notation under the English locale', () => {
    expect(parseLocalizedDecimal('1,234.56', 'en')).toBe(1234.56);
    expect(parseLocalizedDecimal('-42.50', 'en')).toBe(-42.5);
    expect(parseLocalizedDecimal('1,200', 'en')).toBe(1200);
  });

  it('refuses ambiguous forms in BOTH locales instead of guessing', () => {
    expect(parseLocalizedDecimal('1.000', 'en')).toBeNull();
    expect(parseLocalizedDecimal('1,20', 'en')).toBeNull();
    expect(parseEnglishDecimal('751,00-')).toBeNull();
  });
});

describe('parseLocalizedDay', () => {
  it('anchors every locale at 12:00 UTC like parseDay', () => {
    expect(parseLocalizedDay('2024-01-15', 'iso')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(parseLocalizedDay('15.01.2024', 'de')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(parseLocalizedDay('01/15/2024', 'us')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('rejects impossible dates', () => {
    expect(parseLocalizedDay('31.02.2024', 'de')).toBeNull();
    expect(parseLocalizedDay('13/45/2024', 'us')).toBeNull();
    expect(parseLocalizedDay('nicht', 'us')).toBeNull();
  });
});
