import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';
import { ibkrMapper, parseEnglishDecimal } from '../mappers/ibkr';
import { createMapperRegistry } from '../registry';
import { ALL_MAPPERS } from '../mappers';

/**
 * IBKR Activity Statement mapper (§13.4 V4-P8, issue #508): the multi-section
 * anonymized fixture normalizes to its exact golden row set (incl. a non-EUR
 * trade), metadata/summary/ClosedLot lines are skipped rather than errored,
 * malformed rows fail individually, and English number notation never runs
 * through the German-notation framework parser.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const IBKR_FIXTURE = readFileSync(path.join(fixtureDir, 'ibkr.csv'), 'utf8');
const TRADE_REPUBLIC_FIXTURE = readFileSync(path.join(fixtureDir, 'trade-republic.csv'), 'utf8');

const TRADES_HEADER =
  'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code';
const DIVIDENDS_HEADER = 'Dividends,Header,Currency,Date,Description,Amount';
const CASH_HEADER = 'Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount';

describe('parseEnglishDecimal', () => {
  it('parses dot-decimal, comma-grouped English notation', () => {
    expect(parseEnglishDecimal('1,234.56')).toBe(1234.56);
    expect(parseEnglishDecimal('1,200')).toBe(1200);
    expect(parseEnglishDecimal('185.50')).toBe(185.5);
    expect(parseEnglishDecimal('-5')).toBe(-5);
    expect(parseEnglishDecimal('  -1.02 ')).toBe(-1.02);
  });

  it('refuses empty, non-numeric and mis-grouped values', () => {
    expect(parseEnglishDecimal('')).toBeNull();
    expect(parseEnglishDecimal('ten')).toBeNull();
    // German-notation decimals must never be misread as grouping.
    expect(parseEnglishDecimal('1,20')).toBeNull();
    expect(parseEnglishDecimal('1,23,4')).toBeNull();
    expect(parseEnglishDecimal('1.234,56')).toBeNull();
  });
});

describe('ibkrMapper.detect', () => {
  it('scores the fixture at 1 and autodetects through the registry', () => {
    const csv = parseCsv(IBKR_FIXTURE);
    expect(ibkrMapper.detect(csv)).toBe(1);
    expect(createMapperRegistry(ALL_MAPPERS).detect(csv)?.id).toBe('ibkr');
  });

  it('scores flat (non-section) files and unsupported-section statements at 0', () => {
    expect(ibkrMapper.detect(parseCsv(TRADE_REPUBLIC_FIXTURE))).toBe(0);
    const generic = parseCsv('Date,Type,Symbol,Quantity,Price\n2024-01-01,BUY,AAPL,1,100');
    expect(ibkrMapper.detect(generic)).toBe(0);
    // Section-shaped but nothing importable → fall back to the manual picker
    // instead of staging an empty preview.
    const unsupportedOnly = parseCsv(
      'Open Positions,Header,Currency,Symbol,Quantity\nOpen Positions,Data,USD,ACME,10',
    );
    expect(ibkrMapper.detect(unsupportedOnly)).toBe(0);
  });
});

describe('ibkrMapper.map — golden fixture', () => {
  it('normalizes the anonymized fixture to its exact row set, skipping non-transaction lines', () => {
    const lines = ibkrMapper.map(parseCsv(IBKR_FIXTURE));
    // 19 physical lines, 6 transactions — metadata, section headers, Totals,
    // SubTotals and the Dividends/Deposits summary rows are not emitted.
    expect(lines).toHaveLength(6);
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
      amountEur: 2500,
      currency: 'EUR',
      note: 'Cash Transfer SEPA',
    });
    expect(rows[1]).toEqual({
      kind: 'withdrawal',
      executedAt: new Date('2024-06-03T12:00:00.000Z'),
      isin: null,
      symbol: null,
      name: null,
      quantity: null,
      price: null,
      fee: null,
      amountEur: 400,
      currency: 'EUR',
      note: 'Disbursement',
    });
    // The non-EUR trade (§13.4 acceptance): USD stays the row currency; the
    // commission column's negative cash effect becomes the fee magnitude.
    expect(rows[2]).toEqual({
      kind: 'buy',
      executedAt: new Date('2024-01-16T12:00:00.000Z'),
      isin: null,
      symbol: 'ACME',
      name: null,
      quantity: 10,
      price: 185.5,
      fee: 1,
      amountEur: null,
      currency: 'USD',
      note: null,
    });
    expect(rows[3]).toMatchObject({
      kind: 'buy',
      executedAt: new Date('2024-02-20T12:00:00.000Z'),
      symbol: 'MTA',
      quantity: 4,
      price: 51.25,
      fee: 1.25,
      currency: 'EUR',
    });
    // Negative Quantity = sell.
    expect(rows[4]).toMatchObject({
      kind: 'sell',
      executedAt: new Date('2024-05-10T12:00:00.000Z'),
      symbol: 'ACME',
      quantity: 5,
      price: 200,
      fee: 1.02,
      currency: 'USD',
    });
    // Dividend: symbol + ISIN extracted from the description, EUR gross.
    expect(rows[5]).toEqual({
      kind: 'dividend',
      executedAt: new Date('2024-03-15T12:00:00.000Z'),
      isin: 'DE0001234567',
      symbol: 'MTA',
      name: null,
      quantity: null,
      price: null,
      fee: null,
      amountEur: 2,
      currency: 'EUR',
      note: null,
    });
  });
});

describe('ibkrMapper.map — per-row errors and skips', () => {
  const mapTrades = (line: string) => ibkrMapper.map(parseCsv(`${TRADES_HEADER}\n${line}`));
  const mapDividends = (line: string) => ibkrMapper.map(parseCsv(`${DIVIDENDS_HEADER}\n${line}`));
  const mapCash = (line: string) => ibkrMapper.map(parseCsv(`${CASH_HEADER}\n${line}`));

  it('fails a non-stock trade but keeps line number + raw text', () => {
    const [result] = mapTrades(
      'Trades,Data,Order,Forex,USD,EUR.USD,"2024-01-16, 09:32:11",1000,1.09,,,-2,,,,',
    );
    expect(result!.ok).toBe(false);
    expect(!result!.ok && result!.error).toContain('Forex');
    expect(result!.line).toBe(2);
  });

  it('skips ClosedLot legs — they re-state the Order rows that closed them', () => {
    const lines = mapTrades(
      'Trades,Data,ClosedLot,Stocks,USD,ACME,"2024-01-16, 09:32:11",5,185.50,,,,,,,',
    );
    expect(lines).toHaveLength(0);
  });

  it('fails malformed trade values individually', () => {
    const rows = [
      'Trades,Data,Order,Stocks,USD,ACME,gestern,10,185.50,,,-1,,,,', // date
      'Trades,Data,Order,Stocks,USD,ACME,"2024-01-16, 09:32:11",0,185.50,,,-1,,,,', // zero qty
      'Trades,Data,Order,Stocks,USD,ACME,"2024-01-16, 09:32:11","1,20",185.50,,,-1,,,,', // ambiguous qty
      'Trades,Data,Order,Stocks,USD,ACME,"2024-01-16, 09:32:11",10,zehn,,,-1,,,,', // price
      'Trades,Data,Order,Stocks,EURO,ACME,"2024-01-16, 09:32:11",10,185.50,,,-1,,,,', // currency
      'Trades,Data,Order,Stocks,USD,,"2024-01-16, 09:32:11",10,185.50,,,-1,,,,', // no symbol
    ];
    for (const row of rows) {
      const [result] = mapTrades(row);
      expect(result!.ok).toBe(false);
    }
  });

  it('parses thousands-grouped quantities correctly (1,200 shares, not 1.2)', () => {
    const [result] = mapTrades(
      'Trades,Data,Order,Stocks,USD,ACME,"2024-01-16, 09:32:11","1,200",2.50,,,-1,,,,',
    );
    expect(result!.ok).toBe(true);
    expect(result!.ok && result!.row.quantity).toBe(1200);
  });

  it('fails non-EUR dividends and cash rows (the cash ledger is EUR-only)', () => {
    const [dividend] = mapDividends(
      'Dividends,Data,USD,2024-03-15,ACME(US0000000001) Cash Dividend USD 0.24 per Share,2.40',
    );
    expect(dividend!.ok).toBe(false);
    expect(!dividend!.ok && dividend!.error).toContain('EUR');
    const [cash] = mapCash('Deposits & Withdrawals,Data,USD,2024-01-02,Wire In,1000');
    expect(cash!.ok).toBe(false);
    expect(!cash!.ok && cash!.error).toContain('EUR');
  });

  it('fails a negative dividend amount instead of booking a positive dividend', () => {
    const [result] = mapDividends(
      'Dividends,Data,EUR,2024-03-15,MTA(DE0001234567) Cash Dividend — reversal,-2',
    );
    expect(result!.ok).toBe(false);
  });

  it('falls back to the whole description as a name when it has no SYMBOL(ISIN) shape', () => {
    const [result] = mapDividends('Dividends,Data,EUR,2024-03-15,Sonderdividende Muster AG,3');
    expect(result!.ok).toBe(true);
    expect(result!.ok && result!.row).toMatchObject({
      symbol: null,
      isin: null,
      name: 'Sonderdividende Muster AG',
    });
  });

  it('skips Total summary rows in the cash and dividend sections', () => {
    expect(mapCash('Deposits & Withdrawals,Data,Total,,,2100')).toHaveLength(0);
    expect(mapCash('Deposits & Withdrawals,Data,Total in EUR,,,2100')).toHaveLength(0);
    expect(mapDividends('Dividends,Data,Total,,,2')).toHaveLength(0);
  });
});
