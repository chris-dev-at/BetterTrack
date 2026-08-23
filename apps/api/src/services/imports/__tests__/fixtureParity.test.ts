import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';
import { extractRowFields, mapColumns, type MappableField } from '../columnMapping';
import { flatexMapper } from '../mappers/flatex';
import { georgeMapper } from '../mappers/george';
import { ibkrMapper } from '../mappers/ibkr';
import { tradeRepublicMapper } from '../mappers/tradeRepublic';
import { ersteGeorgeMapper, n26Mapper, raiffeisenElbaMapper, revolutMapper } from '../expenseBank';
import { parseLocalizedDecimal, parseLocalizedDay, sniffTable } from '../table';

/**
 * Fixture parity (§16 2026-07-31 acceptance): the GENERIC sniff + column
 * mapping must resolve every committed fixture to the same fields the
 * hardcoded mapper for that broker/bank uses — proven field-by-field below,
 * plus value-level round-trips through the locale-aware parsers against the
 * hardcoded mappers' normalized rows.
 *
 * The IBKR Activity Statement is MULTI-SECTION: one physical file embeds
 * several tables, each with its own Header row, so there is no single
 * `headerRowIndex` for the whole file. The parity harness slices each section
 * (dropping the `Section,RowType,` discriminator columns) and runs the generic
 * pipeline per section — exactly what a sectioned-statement front-end composes
 * from these same pure pieces later.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name: string): string => readFileSync(path.join(fixtureDir, name), 'utf8');

interface Expected {
  header: string;
  field: MappableField | 'unmapped';
  /** Must be the field's WINNER (defaults true when unambiguous). */
  winner?: boolean;
}

const PARITY: Record<string, Expected[]> = {
  // mappers/tradeRepublic.ts: Datum/Typ/Wertpapier/ISIN/Anzahl/Kurs/Gebühr/Betrag/Währung all used.
  'trade-republic.csv': [
    { header: 'Datum', field: 'date' },
    { header: 'Typ', field: 'kindHint' },
    { header: 'Wertpapier', field: 'description' },
    { header: 'ISIN', field: 'isin' },
    { header: 'Anzahl', field: 'quantity' },
    { header: 'Kurs', field: 'price' },
    { header: 'Gebühr', field: 'fee' },
    { header: 'Betrag', field: 'amount' },
    { header: 'Währung', field: 'currency' },
  ],
  // mappers/george.ts: all nine columns used.
  'george.csv': [
    { header: 'Buchungsdatum', field: 'date' },
    { header: 'Auftragsart', field: 'kindHint' },
    { header: 'Titel', field: 'description' },
    { header: 'ISIN', field: 'isin' },
    { header: 'Stück', field: 'quantity' },
    { header: 'Kurs', field: 'price' },
    { header: 'Betrag', field: 'amount' },
    { header: 'Spesen', field: 'fee' },
    { header: 'Währung', field: 'currency' },
  ],
  // mappers/flatex.ts securities export: Buchtag is THE row date; Valuta is read but ignored.
  'flatex-securities.csv': [
    { header: 'Buchtag', field: 'date' },
    { header: 'Valuta', field: 'date', winner: false },
    { header: 'ISIN', field: 'isin' },
    { header: 'Bezeichnung', field: 'description' },
    { header: 'Nominale', field: 'quantity' },
    { header: 'Kurs', field: 'price' },
    { header: 'Währung', field: 'currency' },
    { header: 'Provision', field: 'fee' },
    { header: 'Endbetrag', field: 'amount' },
    { header: 'Buchungsinformationen', field: 'kindHint' },
  ],
  // mappers/flatex.ts cash export: date=Buchtag, amount=Betrag, info names the kind.
  'flatex-cash.csv': [
    { header: 'Buchtag', field: 'date' },
    { header: 'Valuta', field: 'date', winner: false },
    { header: 'Buchungsinformationen', field: 'kindHint' },
    { header: 'TA-Nr.', field: 'ignore' },
    { header: 'Betrag', field: 'amount' },
  ],
  // expenseBank/erste-george.ts: description = Partnername ?? Verwendungszweck.
  'erste-george.csv': [
    { header: 'Buchungsdatum', field: 'date' },
    { header: 'Valutadatum', field: 'date', winner: false },
    { header: 'Partnername', field: 'description' },
    { header: 'Verwendungszweck', field: 'description', winner: false },
    { header: 'Betrag', field: 'amount' },
    { header: 'Währung', field: 'currency' },
  ],
  // expenseBank/raiffeisen-elba.ts: description = Buchungstext.
  'raiffeisen-elba.csv': [
    { header: 'Kontonummer', field: 'ignore' },
    { header: 'Buchungsdatum', field: 'date' },
    { header: 'Valutadatum', field: 'date', winner: false },
    { header: 'Buchungstext', field: 'description' },
    { header: 'Betrag', field: 'amount' },
    { header: 'Währung', field: 'currency' },
  ],
  // expenseBank/n26.ts: description = Payee ?? reference ?? type; Amount (EUR) only.
  'n26.csv': [
    { header: 'Date', field: 'date' },
    { header: 'Payee', field: 'description' },
    { header: 'Account number', field: 'ignore' },
    { header: 'Transaction type', field: 'kindHint' },
    { header: 'Payment reference', field: 'description', winner: false },
    { header: 'Amount (EUR)', field: 'amount' },
    { header: 'Amount (Foreign Currency)', field: 'ignore' },
    { header: 'Type Foreign Currency', field: 'ignore' },
    { header: 'Exchange Rate', field: 'ignore' },
  ],
  // expenseBank/revolut.ts: date = Completed ?? Started; description = Description ?? Type.
  'revolut.csv': [
    { header: 'Type', field: 'kindHint' },
    { header: 'Product', field: 'unmapped' },
    { header: 'Started Date', field: 'date', winner: false },
    { header: 'Completed Date', field: 'date' },
    { header: 'Description', field: 'description' },
    { header: 'Amount', field: 'amount' },
    { header: 'Fee', field: 'fee' },
    { header: 'Currency', field: 'currency' },
    { header: 'State', field: 'ignore' },
    { header: 'Balance', field: 'ignore' },
  ],
};

describe('generic mapping parity with the hardcoded brokers', () => {
  for (const [fixture, expected] of Object.entries(PARITY)) {
    it(`maps ${fixture} to the fields ${fixture}’s hardcoded mapper uses`, () => {
      const table = sniffTable(Buffer.from(readFixture(fixture), 'utf8'), fixture);
      expect(table).not.toBeNull();
      const result = mapColumns(table!.headers, table!.rows);

      for (const { header, field, winner } of expected) {
        if (field === 'unmapped') {
          expect(result.unmapped).toContain(header);
          continue;
        }
        const mapping = result.mappings.find((m) => m.header === header);
        expect(mapping?.field, `${fixture}: ${header}`).toBe(field);
        if (winner !== false && field !== 'ignore') {
          expect(result.fieldWinners[field]?.header).toBe(header);
        }
      }
    });
  }
});

describe('IBKR multi-section statement — per-section generic mapping', () => {
  const raw = readFixture('ibkr.csv');

  /** Slice one section into a standalone table, dropping `Section,RowType,`. */
  function sectionTable(section: string): Buffer {
    const lines = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith(`${section},`) && /,(Header|Data),/.test(l))
      .map((l) => l.slice(l.indexOf(',', l.indexOf(',') + 1) + 1));
    return Buffer.from(lines.join('\n'), 'utf8');
  }

  function mapSection(section: string) {
    const table = sniffTable(sectionTable(section), `ibkr-${section}.csv`);
    expect(table, section).not.toBeNull();
    return { table: table!, result: mapColumns(table!.headers, table!.rows) };
  }

  it('sniffs each section to its own header row with EN/iso locales', () => {
    for (const section of ['Trades', 'Dividends', 'Deposits & Withdrawals']) {
      const { table } = mapSection(section);
      expect(table.delimiter).toBe(',');
      expect(table.headerRowIndex).toBe(1);
      expect(table.dateLocale).toBe('iso');
      expect(table.numberLocale).toBe('en');
    }
  });

  it('maps the Trades section like mappers/ibkr.ts reads it', () => {
    const { result } = mapSection('Trades');
    expect(result.unmapped).toEqual([]);
    expect(result.fieldWinners.date?.header).toBe('Date/Time');
    expect(result.fieldWinners.symbol?.header).toBe('Symbol');
    expect(result.fieldWinners.currency?.header).toBe('Currency');
    expect(result.fieldWinners.quantity?.header).toBe('Quantity');
    expect(result.fieldWinners.price?.header).toBe('T. Price');
    expect(result.fieldWinners.fee?.header).toBe('Comm/Fee');
    expect(result.fieldWinners.amount?.header).toBe('Proceeds');
    // Informational/derived columns land in ignore, never in unmapped.
    for (const noise of [
      'DataDiscriminator',
      'Asset Category',
      'C. Price',
      'Basis',
      'Realized P/L',
      'MTM P/L',
      'Code',
    ]) {
      expect(result.mappings.find((m) => m.header === noise)?.field).toBe('ignore');
    }
  });

  it('maps the Dividends and Deposits & Withdrawals sections', () => {
    for (const section of ['Dividends', 'Deposits & Withdrawals'] as const) {
      const { result } = mapSection(section);
      expect(result.unmapped).toEqual([]);
      expect(result.fieldWinners.date?.header).toBe(
        section === 'Dividends' ? 'Date' : 'Settle Date',
      );
      expect(result.fieldWinners.amount?.header).toBe('Amount');
      expect(result.fieldWinners.description?.header).toBe('Description');
      expect(result.fieldWinners.currency?.header).toBe('Currency');
    }
  });

  it('the hardcoded IBKR mapper still normalizes the raw fixture to 6 rows', () => {
    // Guard that the slicing above did not silently drift from the real file.
    const csv = parseCsv(raw);
    const lines = ibkrMapper.map(csv).filter((l) => l.ok);
    expect(lines).toHaveLength(6);
  });
});

describe('value round-trips — generic projection equals the hardcoded rows', () => {
  function project(fixture: string) {
    const text = readFixture(fixture);
    const table = sniffTable(Buffer.from(text, 'utf8'), fixture)!;
    const result = mapColumns(table.headers, table.rows);
    return table.rows.map((cells) => ({
      raw: extractRowFields(result, cells),
      table,
    }));
  }

  it('george: dates, quantities, prices, fees and dividend amounts match georgeMapper', () => {
    const projected = project('george.csv');
    const lines = georgeMapper.map(parseCsv(readFixture('george.csv')));
    expect(lines.every((l) => l.ok)).toBe(true);

    lines.forEach((line, i) => {
      if (!line.ok) return;
      const { raw, table } = projected[i]!;
      expect(parseLocalizedDay(raw.date!, table.dateLocale)?.getTime()).toBe(
        line.row.executedAt.getTime(),
      );
      if (line.row.quantity !== null) {
        expect(parseLocalizedDecimal(raw.quantity!, table.numberLocale)).toBe(line.row.quantity);
      }
      if (line.row.price !== null) {
        expect(parseLocalizedDecimal(raw.price!, table.numberLocale)).toBe(line.row.price);
      }
      if (line.row.fee !== null) {
        expect(parseLocalizedDecimal(raw.fee!, table.numberLocale)).toBe(line.row.fee);
      }
      if (line.row.amountEur !== null) {
        expect(parseLocalizedDecimal(raw.amount!, table.numberLocale)).toBe(line.row.amountEur);
      }
      expect(raw.currency).toBe(line.row.currency);
      expect(raw.isin).toBe(line.row.isin);
    });
  });

  it('trade-republic: cash and trade amounts match tradeRepublicMapper across mixed content', () => {
    const projected = project('trade-republic.csv');
    const lines = tradeRepublicMapper.map(parseCsv(readFixture('trade-republic.csv')));
    expect(lines.every((l) => l.ok)).toBe(true);

    lines.forEach((line, i) => {
      if (!line.ok) return;
      const { raw, table } = projected[i]!;
      expect(parseLocalizedDay(raw.date!, table.dateLocale)?.getTime()).toBe(
        line.row.executedAt.getTime(),
      );
      if (line.row.amountEur !== null) {
        expect(parseLocalizedDecimal(raw.amount!, table.numberLocale)).toBe(line.row.amountEur);
      }
      if (raw.kindHint !== undefined && raw.kindHint !== '') {
        expect(raw.kindHint.toLowerCase()).not.toBe('');
      }
    });
    // The deposit row's EUR magnitude survives German notation.
    expect(parseLocalizedDecimal(projected[0]!.raw.amount!, 'de')).toBe(2000);
  });

  it('flatex securities: signed Nominale parses; |value| equals the mapper quantity', () => {
    const projected = project('flatex-securities.csv');
    const sell = flatexMapper.map(parseCsv(readFixture('flatex-securities.csv')))[2];
    expect(sell && sell.ok ? sell.row.quantity : null).toBe(4);
    const parsed = parseLocalizedDecimal(projected[2]!.raw.quantity!, 'de');
    expect(parsed).toBe(-4); // sells print negative; the side comes from the booking text
    expect(Math.abs(parsed!)).toBe(sell && sell.ok ? sell.row.quantity : NaN);
  });

  it('revolut/n26/erste-george/raiffeisen: signed amounts parse under their locales', () => {
    const revolut = project('revolut.csv');
    expect(parseLocalizedDecimal(revolut[2]!.raw.amount!, 'en')).toBe(1500); // TOPUP
    expect(parseLocalizedDecimal(revolut[0]!.raw.amount!, 'en')).toBe(-9.99); // CARD_PAYMENT

    const n26 = project('n26.csv');
    expect(parseLocalizedDecimal(n26[0]!.raw.amount!, 'en')).toBe(-42.5);

    const erste = project('erste-george.csv');
    expect(parseLocalizedDecimal(erste[0]!.raw.amount!, 'de')).toBe(-38.2);
    expect(parseLocalizedDay(erste[0]!.raw.date!, erste[0]!.table.dateLocale)?.toISOString()).toBe(
      '2024-01-02T12:00:00.000Z',
    );

    const elba = project('raiffeisen-elba.csv');
    expect(parseLocalizedDecimal(elba[2]!.raw.amount!, 'de')).toBe(2100);
    expect(elba[2]!.raw.description).toBe('GEHALT ARBEITGEBER AG');
  });

  it('every bank mapper still autodetects its own fixture (no regression)', () => {
    expect(n26Mapper.detect(parseCsv(readFixture('n26.csv')))).toBeGreaterThan(0.9);
    expect(revolutMapper.detect(parseCsv(readFixture('revolut.csv')))).toBeGreaterThan(0.9);
    expect(ersteGeorgeMapper.detect(parseCsv(readFixture('erste-george.csv')))).toBe(1);
    expect(raiffeisenElbaMapper.detect(parseCsv(readFixture('raiffeisen-elba.csv')))).toBe(1);
  });
});
