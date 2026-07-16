import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';
import { flatexMapper } from '../mappers/flatex';
import { createMapperRegistry } from '../registry';
import { ALL_MAPPERS } from '../mappers';

/**
 * Flatex mapper (§13.4 V4-P8, issue #508): BOTH export kinds — Wertpapierumsätze
 * (securities) and Kontoumsätze (cash) — autodetect as Flatex and normalize
 * their anonymized fixtures to exact golden row sets; malformed rows fail
 * individually; a file matching neither header shape errors per row.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SECURITIES_FIXTURE = readFileSync(path.join(fixtureDir, 'flatex-securities.csv'), 'utf8');
const CASH_FIXTURE = readFileSync(path.join(fixtureDir, 'flatex-cash.csv'), 'utf8');
const TRADE_REPUBLIC_FIXTURE = readFileSync(path.join(fixtureDir, 'trade-republic.csv'), 'utf8');
const GEORGE_FIXTURE = readFileSync(path.join(fixtureDir, 'george.csv'), 'utf8');

const SECURITIES_HEADER =
  'Buchtag;Valuta;ISIN;Bezeichnung;Nominale;Kurs;Währung;Provision;Endbetrag;Buchungsinformationen';
const CASH_HEADER = 'Buchtag;Valuta;Buchungsinformationen;TA-Nr.;Betrag';

describe('flatexMapper.detect', () => {
  it('scores BOTH export kinds at 1 and autodetects each through the registry', () => {
    const registry = createMapperRegistry(ALL_MAPPERS);
    for (const fixture of [SECURITIES_FIXTURE, CASH_FIXTURE]) {
      const csv = parseCsv(fixture);
      expect(flatexMapper.detect(csv)).toBe(1);
      expect(registry.detect(csv)?.id).toBe('flatex');
    }
  });

  it('scores other brokers and generic files below the threshold', () => {
    expect(flatexMapper.detect(parseCsv(TRADE_REPUBLIC_FIXTURE))).toBeLessThan(0.5);
    expect(flatexMapper.detect(parseCsv(GEORGE_FIXTURE))).toBeLessThan(0.5);
    const generic = parseCsv('Date,Type,Symbol,Quantity,Price\n2024-01-01,BUY,AAPL,1,100');
    expect(flatexMapper.detect(generic)).toBe(0);
  });
});

describe('flatexMapper.map — golden securities fixture', () => {
  it('normalizes the anonymized Wertpapierumsätze fixture to its exact row set', () => {
    const lines = flatexMapper.map(parseCsv(SECURITIES_FIXTURE));
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.ok)).toBe(true);
    const rows = lines.map((l) => (l.ok ? l.row : null));

    expect(rows[0]).toEqual({
      kind: 'buy',
      executedAt: new Date('2024-01-15T12:00:00.000Z'),
      isin: 'DE0001234567',
      symbol: null,
      name: 'Muster Tech AG',
      quantity: 10,
      price: 50,
      fee: 5.9,
      amountEur: null,
      currency: 'EUR',
      note: null,
    });
    expect(rows[1]).toMatchObject({
      kind: 'buy',
      executedAt: new Date('2024-02-01T12:00:00.000Z'),
      isin: 'IE0009876543',
      name: 'Beispiel World ETF',
      quantity: 2.5,
      price: 40,
      fee: 0,
    });
    // Sells print a negative Nominale — the magnitude is the quantity, the
    // side comes from the booking text.
    expect(rows[2]).toEqual({
      kind: 'sell',
      executedAt: new Date('2024-04-10T12:00:00.000Z'),
      isin: 'DE0001234567',
      symbol: null,
      name: 'Muster Tech AG',
      quantity: 4,
      price: 60,
      fee: 5.9,
      amountEur: null,
      currency: 'EUR',
      note: null,
    });
  });
});

describe('flatexMapper.map — golden cash fixture', () => {
  it('normalizes the anonymized Kontoumsätze fixture to its exact row set', () => {
    const lines = flatexMapper.map(parseCsv(CASH_FIXTURE));
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.ok)).toBe(true);
    const rows = lines.map((l) => (l.ok ? l.row : null));

    expect(rows[0]).toEqual({
      kind: 'deposit',
      executedAt: new Date('2024-01-02T12:00:00.000Z'),
      isin: null,
      symbol: null,
      name: null,
      quantity: null,
      price: null,
      fee: null,
      amountEur: 1500,
      currency: 'EUR',
      note: 'Einzahlung SEPA Ueberweisung',
    });
    // Ertragsgutschrift: dividend with ISIN + name pulled out of the text.
    expect(rows[1]).toEqual({
      kind: 'dividend',
      executedAt: new Date('2024-03-15T12:00:00.000Z'),
      isin: 'DE0001234567',
      symbol: null,
      name: 'Muster Tech AG',
      quantity: null,
      price: null,
      fee: null,
      amountEur: 12.5,
      currency: 'EUR',
      note: null,
    });
    expect(rows[2]).toEqual({
      kind: 'withdrawal',
      executedAt: new Date('2024-06-01T12:00:00.000Z'),
      isin: null,
      symbol: null,
      name: null,
      quantity: null,
      price: null,
      fee: null,
      amountEur: 250,
      currency: 'EUR',
      note: 'Auszahlung SEPA',
    });
  });
});

describe('flatexMapper.map — per-row errors and cash-text classification', () => {
  const mapOneSecurities = (line: string) => {
    const [result] = flatexMapper.map(parseCsv(`${SECURITIES_HEADER}\n${line}`));
    return result!;
  };
  const mapOneCash = (line: string) => {
    const [result] = flatexMapper.map(parseCsv(`${CASH_HEADER}\n${line}`));
    return result!;
  };

  it('fails an unsupported securities booking but keeps line number + raw text', () => {
    const result = mapOneSecurities(
      '15.01.2024;17.01.2024;DE0001234567;X AG;10;50,00;EUR;0,00;-500,00;Depotübertrag',
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('Depotübertrag');
    expect(result.line).toBe(2);
  });

  it('fails malformed securities values individually', () => {
    const rows = [
      'gestern;;DE0001234567;X AG;10;50,00;EUR;0,00;-500,00;Kauf', // date
      '15.01.2024;;DE0001234567;X AG;;50,00;EUR;0,00;-500,00;Kauf', // quantity
      '15.01.2024;;DE0001234567;X AG;0;50,00;EUR;0,00;0,00;Kauf', // zero quantity
      '15.01.2024;;DE0001234567;X AG;10;zehn;EUR;0,00;-500,00;Kauf', // price
      '15.01.2024;;;;10;50,00;EUR;0,00;-500,00;Kauf', // no instrument
      '15.01.2024;;DE0001234567;X AG;10;50,00;EURO;0,00;-500,00;Kauf', // currency
    ];
    for (const row of rows) expect(mapOneSecurities(row).ok).toBe(false);
  });

  it('reads a signed Provision as a fee magnitude', () => {
    const result = mapOneSecurities(
      '15.01.2024;;DE0001234567;X AG;10;50,00;EUR;-5,90;-505,90;Kauf Xetra',
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.row.fee).toBe(5.9);
  });

  it('fails an unsupported cash booking and malformed amounts individually', () => {
    const unsupported = mapOneCash('02.01.2024;;Depotgebühr;1;-5,90');
    expect(unsupported.ok).toBe(false);
    expect(!unsupported.ok && unsupported.error).toContain('Depotgebühr');
    expect(mapOneCash('02.01.2024;;Einzahlung;1;nix').ok).toBe(false);
    expect(mapOneCash('02.01.2024;;Einzahlung;1;0,00').ok).toBe(false);
    expect(mapOneCash('gestern;;Einzahlung;1;100,00').ok).toBe(false);
  });

  it('fails sign-contradicting reversal (Storno) rows instead of booking their magnitude', () => {
    // A Storno keeps the original booking's text but flips the amount sign —
    // booking Math.abs would double-count (original + its reversal).
    const dividendReversal = mapOneCash(
      '15.03.2024;15.03.2024;Storno Ertragsgutschrift DE0001234567 Muster Tech AG;100004;-12,50',
    );
    expect(dividendReversal.ok).toBe(false);
    expect(!dividendReversal.ok && dividendReversal.error).toContain('Storno');
    const depositReversal = mapOneCash('15.03.2024;;Storno Einzahlung SEPA;100005;-100,00');
    expect(depositReversal.ok).toBe(false);
    expect(!depositReversal.ok && depositReversal.error).toContain('Storno');
    const withdrawalReversal = mapOneCash('15.03.2024;;Storno Auszahlung SEPA;100006;250,00');
    expect(withdrawalReversal.ok).toBe(false);
  });

  it('classifies Überweisung and Zinsen by the amount sign', () => {
    const transferIn = mapOneCash('02.01.2024;;SEPA Überweisung;1;100,00');
    expect(transferIn.ok && transferIn.row.kind).toBe('deposit');
    const transferOut = mapOneCash('02.01.2024;;SEPA Überweisung;1;-100,00');
    expect(transferOut.ok && transferOut.row.kind).toBe('withdrawal');
    // Some exports transliterate the umlaut — `SEPA Ueberweisung` counts too.
    const transliterated = mapOneCash('02.01.2024;;SEPA Ueberweisung;1;-75,00');
    expect(transliterated.ok && transliterated.row.kind).toBe('withdrawal');
    const interest = mapOneCash('02.01.2024;;Zinsen Q1;1;1,25');
    expect(interest.ok && interest.row).toMatchObject({
      kind: 'deposit',
      amountEur: 1.25,
      note: 'Interest (Flatex)',
    });
    const negativeInterest = mapOneCash('02.01.2024;;Zinsen Q1;1;-1,25');
    expect(negativeInterest.ok && negativeInterest.row.kind).toBe('withdrawal');
  });

  it('maps a dividend booking without an ISIN as a name-only instrument', () => {
    const result = mapOneCash('15.03.2024;;Dividende Muster AG;1;10,00');
    expect(result.ok).toBe(true);
    expect(result.ok && result.row).toMatchObject({
      kind: 'dividend',
      isin: null,
      name: 'Muster AG',
      amountEur: 10,
    });
  });

  it('errors every row of a file matching neither Flatex header shape', () => {
    // A manual mis-pick of a foreign file costs its rows, never the batch.
    const lines = flatexMapper.map(
      parseCsv('Date,Type,Symbol\n2024-01-01,BUY,AAPL\n2024-01-02,SELL,AAPL'),
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => !l.ok && l.error.includes('Flatex'))).toBe(true);
  });
});
