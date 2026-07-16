import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';
import { georgeMapper } from '../mappers/george';
import { createMapperRegistry } from '../registry';
import { ALL_MAPPERS } from '../mappers';

/**
 * George (Erste Bank) mapper (§13.4 V4-P8, issue #508): the anonymized fixture
 * normalizes to its exact golden row set; malformed rows fail individually; the
 * header fingerprint autodetects — for the semicolon AND the comma variant.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GEORGE_FIXTURE = readFileSync(path.join(fixtureDir, 'george.csv'), 'utf8');
const TRADE_REPUBLIC_FIXTURE = readFileSync(path.join(fixtureDir, 'trade-republic.csv'), 'utf8');

describe('georgeMapper.detect', () => {
  it('scores the fixture header at 1 and autodetects through the registry', () => {
    const csv = parseCsv(GEORGE_FIXTURE);
    expect(georgeMapper.detect(csv)).toBe(1);
    expect(createMapperRegistry(ALL_MAPPERS).detect(csv)?.id).toBe('george');
  });

  it('scores foreign headers below the threshold', () => {
    // Trade Republic's header shares ISIN/Kurs/Betrag/Währung — still only 4/9.
    expect(georgeMapper.detect(parseCsv(TRADE_REPUBLIC_FIXTURE))).toBeLessThan(0.5);
    const generic = parseCsv('Date,Type,Symbol,Quantity,Price\n2024-01-01,BUY,AAPL,1,100');
    expect(georgeMapper.detect(generic)).toBe(0);
  });

  it('detects the comma-separated export variant too', () => {
    const csv = parseCsv(
      'Buchungsdatum,Auftragsart,Titel,ISIN,Stück,Kurs,Betrag,Spesen,Währung\n' +
        '02.01.2024,Kauf,Beispiel Bau AG,AT0000123456,5,"25,50","-127,50","0,00",EUR',
    );
    expect(georgeMapper.detect(csv)).toBe(1);
    const lines = georgeMapper.map(csv);
    expect(lines[0]).toMatchObject({
      ok: true,
      row: { kind: 'buy', quantity: 5, price: 25.5, fee: 0 },
    });
  });
});

describe('georgeMapper.map — golden fixture', () => {
  it('normalizes the anonymized fixture to its exact row set', () => {
    const lines = georgeMapper.map(parseCsv(GEORGE_FIXTURE));
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.ok)).toBe(true);
    const rows = lines.map((l) => (l.ok ? l.row : null));

    expect(rows[0]).toEqual({
      kind: 'buy',
      executedAt: new Date('2024-01-02T12:00:00.000Z'),
      isin: 'AT0000123456',
      symbol: null,
      name: 'Beispiel Bau AG',
      quantity: 12,
      price: 25.5,
      fee: 5.95,
      amountEur: null,
      currency: 'EUR',
      note: null,
    });
    expect(rows[1]).toEqual({
      kind: 'buy',
      executedAt: new Date('2024-01-15T12:00:00.000Z'),
      isin: 'IE0001234560',
      symbol: null,
      name: 'Muster Welt ETF',
      quantity: 3.5,
      price: 92,
      fee: 3.95,
      amountEur: null,
      currency: 'EUR',
      note: null,
    });
    // Ertrag rows are dividends — the Stück column is ignored for them.
    expect(rows[2]).toEqual({
      kind: 'dividend',
      executedAt: new Date('2024-04-10T12:00:00.000Z'),
      isin: 'AT0000123456',
      symbol: null,
      name: 'Beispiel Bau AG',
      quantity: null,
      price: null,
      fee: null,
      amountEur: 13.2,
      currency: 'EUR',
      note: null,
    });
    expect(rows[3]).toEqual({
      kind: 'sell',
      executedAt: new Date('2024-06-03T12:00:00.000Z'),
      isin: 'AT0000123456',
      symbol: null,
      name: 'Beispiel Bau AG',
      quantity: 5,
      price: 28.1,
      fee: 5.95,
      amountEur: null,
      currency: 'EUR',
      note: null,
    });
  });
});

describe('georgeMapper.map — per-row errors', () => {
  const HEADER = 'Buchungsdatum;Auftragsart;Titel;ISIN;Stück;Kurs;Betrag;Spesen;Währung';

  const mapOne = (line: string) => {
    const [result] = georgeMapper.map(parseCsv(`${HEADER}\n${line}`));
    return result!;
  };

  it('fails an unsupported Auftragsart but keeps the raw line + physical line number', () => {
    // George's securities export has no cash movements — those live on the giro.
    const result = mapOne('02.01.2024;Einzahlung;;;;;100,00;;EUR');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('Einzahlung');
    expect(result.line).toBe(2);
    expect(result.raw).toContain('Einzahlung');
  });

  it('fails unparseable dates, quantities, prices, fees and amounts individually', () => {
    expect(mapOne('gestern;Kauf;X AG;AT0000123456;1;10,00;-10,00;0,00;EUR').ok).toBe(false);
    expect(mapOne('02.01.2024;Kauf;X AG;AT0000123456;;10,00;-10,00;0,00;EUR').ok).toBe(false);
    expect(mapOne('02.01.2024;Kauf;X AG;AT0000123456;-1;10,00;-10,00;0,00;EUR').ok).toBe(false);
    expect(mapOne('02.01.2024;Kauf;X AG;AT0000123456;1;zehn;-10,00;0,00;EUR').ok).toBe(false);
    expect(mapOne('02.01.2024;Kauf;X AG;AT0000123456;1;10,00;-10,00;-5,95;EUR').ok).toBe(false);
    expect(mapOne('02.01.2024;Ertrag;X AG;AT0000123456;;;nix;;EUR').ok).toBe(false);
    expect(mapOne('02.01.2024;Ertrag;X AG;AT0000123456;;;0,00;;EUR').ok).toBe(false);
  });

  it('refuses the ambiguous grouping-dot integer notation (1.000)', () => {
    const result = mapOne('02.01.2024;Kauf;X AG;AT0000123456;1.000;10,00;-10,00;0,00;EUR');
    expect(result.ok).toBe(false);
  });

  it('fails a row without any instrument identity', () => {
    expect(mapOne('02.01.2024;Kauf;;;1;10,00;-10,00;0,00;EUR').ok).toBe(false);
  });

  it('fails a negative dividend amount instead of booking it as positive income', () => {
    // Reversals export as a `Storno` Auftragsart (already unsupported), but a
    // negative Betrag on an Ertrag row must not book its magnitude either.
    const result = mapOne('10.04.2024;Ertrag;X AG;AT0000123456;;;-13,20;;EUR');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('-13,20');
  });

  it('fails non-EUR dividends (the cash ledger is EUR-only)', () => {
    const result = mapOne('10.04.2024;Ertrag;X AG;AT0000123456;;;13,20;;USD');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('EUR');
  });

  it('fails a malformed Währung token instead of letting it through', () => {
    for (const currency of ['EURO', 'Euro', 'EUR/USD']) {
      const result = mapOne(`02.01.2024;Kauf;X AG;AT0000123456;1;10,00;-10,00;0,00;${currency}`);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain(currency);
    }
    // An empty cell still defaults to EUR.
    expect(mapOne('02.01.2024;Kauf;X AG;AT0000123456;1;10,00;-10,00;0,00;').ok).toBe(true);
  });

  it('accepts an unlisted ISIN column value as a name-only instrument', () => {
    const result = mapOne('02.01.2024;Kauf;Muster AG;keine-isin;1;10,00;-10,00;0,00;EUR');
    expect(result.ok).toBe(true);
    expect(result.ok && result.row.isin).toBeNull();
    expect(result.ok && result.row.name).toBe('Muster AG');
  });
});
