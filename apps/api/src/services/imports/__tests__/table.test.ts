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
    // Unlabeled columns are reported, not silently returned as a clean table.
    expect(table?.issues.map((i) => i.kind)).toEqual(['no-header-row']);
  });

  it('picks the REAL header under a same-width preamble row, not the first label row', () => {
    // Measured trap: `Waehrung` in the preamble mapped `currency` at 0.95 with
    // no review flag while the importer actually read the booking-text column,
    // and `amount` went missing entirely.
    const text = [
      'Konto;Inhaber;Waehrung;Filiale;Typ',
      'Buchtag;Valuta;Buchungstext;TA-Nr.;Betrag',
      '02.01.2024;02.01.2024;Einzahlung SEPA;100001;500,00',
      '31.01.2024;31.01.2024;Gehalt;100003;2.500,00',
    ].join('\n');
    const table = sniffTable(buf(text), 'preamble.csv');
    expect(table?.headerRowIndex).toBe(2);
    expect(table?.headers).toEqual(['Buchtag', 'Valuta', 'Buchungstext', 'TA-Nr.', 'Betrag']);
    // The preamble line is metadata — it must not ride along as a bookable row.
    expect(table?.rows).toEqual([
      ['02.01.2024', '02.01.2024', 'Einzahlung SEPA', '100001', '500,00'],
      ['31.01.2024', '31.01.2024', 'Gehalt', '100003', '2.500,00'],
    ]);
    expect(table?.lineNumbers).toEqual([3, 4]);
    expect(table?.issues).toEqual([]);
  });

  it('rejects a candidate whose successor is also header-like, through three preamble rows', () => {
    const table = sniffTable(
      buf(
        [
          'Konto;Inhaber;Waehrung;Filiale;Typ',
          'Depot;Kunde;Berater;Zweigstelle;Art',
          'Buchtag;Valuta;Buchungstext;TA-Nr.;Betrag',
          '02.01.2024;02.01.2024;Einzahlung SEPA;100001;500,00',
        ].join('\n'),
      ),
      'stacked.csv',
    );
    expect(table?.headerRowIndex).toBe(3);
    expect(table?.rows).toHaveLength(1);
  });

  it('reports a header row NARROWER than the data rows instead of losing the file silently', () => {
    const table = sniffTable(
      buf('Datum;Betrag\n02.01.2024;Einzahlung;100001;500,00\n03.01.2024;Gehalt;100002;250,00'),
      'narrow.csv',
    );
    expect(table?.headerRowIndex).toBe(-1);
    expect(table?.headers).toEqual([]);
    const issue = table?.issues.find((i) => i.kind === 'header-width-mismatch');
    expect(issue).toBeDefined();
    expect(issue?.line).toBe(1);
    expect(issue?.message).toContain('2 column(s)');
    expect(issue?.message).toContain('4');
  });

  it('flags a trailing summary row as a phantom booking, keeping it visible in rows', () => {
    const table = sniffTable(
      buf(
        [
          'Buchtag;Buchungstext;Betrag',
          '02.01.2024;Einzahlung;500,00',
          '31.01.2024;Gehalt;2.500,00',
          'Summe;;450,00',
        ].join('\n'),
      ),
      'summe.csv',
    );
    expect(table?.rows).toHaveLength(3);
    const summaries = table?.issues.filter((i) => i.kind === 'summary-row') ?? [];
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.line).toBe(4);
    expect(summaries[0]?.row).toBe(2);
    expect(table?.rows[summaries[0]!.row]).toEqual(['Summe', '', '450,00']);
  });

  it('never mistakes an ordinary dated booking for a summary row', () => {
    const table = sniffTable(
      buf('Buchtag;Buchungstext;Betrag\n02.01.2024;Saldenmitteilung Gebuehr;-1,00'),
      'nosum.csv',
    );
    expect(table?.issues.filter((i) => i.kind === 'summary-row')).toEqual([]);
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
    expect(table?.dateLocaleAmbiguous).toBe(false);
  });

  it('detects EUROPEAN DD/MM slash dates once any day exceeds 12', () => {
    const table = sniffTable(
      buf('Date,Description,Amount\n15/02/2024,Test,-42.50\n02/03/2024,X,-10.00'),
      'eu.csv',
    );
    expect(table?.dateLocale).toBe('eu-slash');
    expect(table?.dateLocaleAmbiguous).toBe(false);
    expect(parseLocalizedDay('02/03/2024', table!.dateLocale)?.toISOString()).toBe(
      '2024-03-02T12:00:00.000Z',
    );
  });

  it('marks a slash file AMBIGUOUS when nothing in it settles DD/MM vs MM/DD', () => {
    // 1 Feb / 2 Mar / 3 Apr day-first — or 2 Jan / 3 Feb / 4 Mar month-first.
    // Defaulting to `us` silently shifted every booking by months.
    const table = sniffTable(
      buf('Date,Description,Amount\n01/02/2024,A,-1.00\n02/03/2024,B,-2.00\n03/04/2024,C,-3.00'),
      'ambiguous.csv',
    );
    expect(table?.dateLocaleAmbiguous).toBe(true);
    const issue = table?.issues.find((i) => i.kind === 'ambiguous-date-locale');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('1 February');
  });

  it('does not call an ISO or dotted-German file ambiguous', () => {
    expect(sniffTable(buf('Datum;Betrag\n02.01.2024;1,00'), 'de.csv')?.dateLocaleAmbiguous).toBe(
      false,
    );
    expect(sniffTable(buf('Date,Amount\n2024-01-02,1.00'), 'iso.csv')?.dateLocaleAmbiguous).toBe(
      false,
    );
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

  it('refuses ENGLISH grouping under the German locale instead of booking 1/1000th', () => {
    // parseDecimal reads the comma as the decimal separator: '1,234.56' → 1.23456.
    expect(parseLocalizedDecimal('1,234.56', 'de')).toBeNull();
    expect(parseLocalizedDecimal('12,345.67', 'de')).toBeNull();
    expect(parseLocalizedDecimal('1,234,567.89', 'de')).toBeNull();
    expect(parseLocalizedDecimal('-9,999.99', 'de')).toBeNull();
    // …and the mirror direction still refuses German grouping under English.
    expect(parseLocalizedDecimal('1.234,56', 'en')).toBeNull();
    expect(parseLocalizedDecimal('-1.234,56', 'en')).toBeNull();
  });

  it('still parses each locale’s own notation after the cross-notation guard', () => {
    expect(parseLocalizedDecimal('1.234,56', 'de')).toBe(1234.56);
    expect(parseLocalizedDecimal('1234,56', 'de')).toBe(1234.56);
    expect(parseLocalizedDecimal('-42.50', 'de')).toBe(-42.5);
    expect(parseLocalizedDecimal('1,234.56', 'en')).toBe(1234.56);
  });
});

describe('parseLocalizedDay', () => {
  it('anchors every locale at 12:00 UTC like parseDay', () => {
    expect(parseLocalizedDay('2024-01-15', 'iso')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(parseLocalizedDay('15.01.2024', 'de')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(parseLocalizedDay('01/15/2024', 'us')?.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('reads the two slash notations as mirror images of each other', () => {
    expect(parseLocalizedDay('01/02/2024', 'us')?.toISOString()).toBe('2024-01-02T12:00:00.000Z');
    expect(parseLocalizedDay('01/02/2024', 'eu-slash')?.toISOString()).toBe(
      '2024-02-01T12:00:00.000Z',
    );
    expect(parseLocalizedDay('15/01/2024', 'eu-slash')?.toISOString()).toBe(
      '2024-01-15T12:00:00.000Z',
    );
  });

  it('rejects impossible dates', () => {
    expect(parseLocalizedDay('31.02.2024', 'de')).toBeNull();
    expect(parseLocalizedDay('13/45/2024', 'us')).toBeNull();
    expect(parseLocalizedDay('45/13/2024', 'eu-slash')).toBeNull();
    expect(parseLocalizedDay('nicht', 'us')).toBeNull();
    expect(parseLocalizedDay('nicht', 'eu-slash')).toBeNull();
  });
});
