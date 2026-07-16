import { parseDay, type CsvRecord, type ParsedCsv } from '../csv';
import type { BrokerMapper, MappedLine } from '../types';

/**
 * Interactive Brokers (IBKR) Activity Statement mapper (PROJECTPLAN.md §13.4
 * V4-P8; quirks documented in docs/imports.md). The Activity Statement CSV is
 * MULTI-SECTION: every line starts with the section name and a row type —
 *
 *   Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,…,Comm/Fee,…
 *   Trades,Data,Order,Stocks,USD,ACME,"2024-01-16, 09:32:11",10,185.50,…
 *
 * Each section's `Header` row defines that section's columns; the mapper
 * consumes the `Data` rows of the sections that carry transactions — `Trades`
 * (DataDiscriminator `Order`, asset category `Stocks`; signed Quantity gives
 * the side, `Comm/Fee` the commission, multi-currency per row), `Dividends`
 * (EUR only — the cash ledger is EUR-only; symbol + ISIN extracted from the
 * description) and `Deposits & Withdrawals` (EUR only, signed Amount). All
 * other lines — statement metadata, `SubTotal`/`Total` summary rows,
 * `ClosedLot` legs (derived views of the same orders), unsupported sections —
 * are intentionally NOT emitted: on a statement they outnumber the
 * transactions severalfold, and erroring hundreds of non-transaction lines
 * would bury the preview. Numbers are ENGLISH notation (`1,234.56`) — parsed
 * by {@link parseEnglishDecimal}, never the German-notation framework helper.
 * Flex Query exports are a different, column-configurable format and are not
 * supported — export an Activity Statement instead.
 */

/** The row-type discriminator every Activity Statement line carries in column 2. */
const ROW_TYPES = new Set(['Header', 'Data', 'SubTotal', 'Total', 'Notes']);

const SECTION_TRADES = 'Trades';
const SECTION_DIVIDENDS = 'Dividends';
const SECTION_CASH = 'Deposits & Withdrawals';
const SUPPORTED_SECTIONS = new Set([SECTION_TRADES, SECTION_DIVIDENDS, SECTION_CASH]);

/** ISO-4217 shape. Anything else must fail (or skip) its ROW, not the batch. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** `SYMBOL(ISIN) Cash Dividend …` — the instrument identity of a dividend row. */
const DIVIDEND_INSTRUMENT = /^\s*([A-Z0-9.-]+)\s*\(([A-Z]{2}[A-Z0-9]{9}\d)\)/;

/**
 * Parse an ENGLISH-notation decimal (`1,234.56` — dot decimal, comma
 * thousands). The framework's `parseDecimal` reads a comma as the GERMAN
 * decimal separator, which would turn IBKR's `1,200` into 1.2 — a quantity
 * 1000× off — so this mapper never uses it. Grouping commas must match the
 * 3-digit pattern exactly; anything else (`1,20`) is ambiguous and refused.
 */
export function parseEnglishDecimal(input: string): number | null {
  let cleaned = input.trim();
  if (cleaned === '') return null;
  const sign = cleaned.startsWith('-') ? -1 : 1;
  cleaned = cleaned.replace(/^[+-]/, '');
  if (cleaned.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) return null;
    cleaned = cleaned.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? sign * value : null;
}

type Columns = Map<string, number>;

/** Cell by section-header column name (data rows align with their Header row). */
function cellOf(record: CsvRecord, cols: Columns, name: string): string {
  const index = cols.get(name);
  return index === undefined ? '' : (record.cells[index] ?? '');
}

/** A `Trades` Data row → trade, error, or null for non-Order/summary lines. */
function mapTradeRecord(record: CsvRecord, cols: Columns): MappedLine | null {
  const fail = (error: string): MappedLine => ({
    line: record.line,
    raw: record.raw,
    ok: false,
    error,
  });

  // ClosedLot rows re-state the Order rows they close — importing both would
  // double every covered trade; summary discriminators carry no transaction.
  if (cellOf(record, cols, 'datadiscriminator') !== 'Order') return null;

  const category = cellOf(record, cols, 'asset category');
  if (category !== 'Stocks') {
    return fail(
      `Unsupported asset category "${category || '(empty)'}" — only stock trades import.`,
    );
  }

  const currencyRaw = cellOf(record, cols, 'currency');
  const currency = currencyRaw.toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) return fail(`Unrecognized currency "${currencyRaw}".`);

  const symbol = cellOf(record, cols, 'symbol') || null;
  if (!symbol) return fail('Trade row without a symbol.');

  // `Date/Time` is `"2024-01-16, 09:32:11"` — the calendar day is before the comma.
  const dateRaw = cellOf(record, cols, 'date/time');
  const executedAt = parseDay(dateRaw.split(',')[0] ?? '');
  if (!executedAt) return fail(`Unparseable date "${dateRaw}".`);

  const quantitySigned = parseEnglishDecimal(cellOf(record, cols, 'quantity'));
  if (quantitySigned === null || quantitySigned === 0) {
    return fail(`Invalid quantity "${cellOf(record, cols, 'quantity')}".`);
  }
  const price = parseEnglishDecimal(cellOf(record, cols, 't. price'));
  if (price === null || price < 0) {
    return fail(`Invalid price "${cellOf(record, cols, 't. price')}".`);
  }
  // IBKR prints commissions as the (negative) cash effect — the fee is its magnitude.
  const fee = Math.abs(parseEnglishDecimal(cellOf(record, cols, 'comm/fee')) ?? 0);

  return {
    line: record.line,
    raw: record.raw,
    ok: true,
    row: {
      kind: quantitySigned > 0 ? 'buy' : 'sell',
      executedAt,
      isin: null,
      symbol,
      name: null,
      quantity: Math.abs(quantitySigned),
      price,
      fee,
      amountEur: null,
      currency,
      note: null,
    },
  };
}

/** A `Dividends` Data row → dividend, error, or null for the `Total` summary line. */
function mapDividendRecord(record: CsvRecord, cols: Columns): MappedLine | null {
  const fail = (error: string): MappedLine => ({
    line: record.line,
    raw: record.raw,
    ok: false,
    error,
  });

  const currencyRaw = cellOf(record, cols, 'currency');
  if (currencyRaw.startsWith('Total')) return null; // section summary rows
  const currency = currencyRaw.toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) return fail(`Unrecognized currency "${currencyRaw}".`);
  if (currency !== 'EUR') {
    return fail(
      `Non-EUR dividends cannot be imported — the cash ledger is EUR-only; record the ${currency} dividend manually.`,
    );
  }

  const executedAt = parseDay(cellOf(record, cols, 'date'));
  if (!executedAt) return fail(`Unparseable date "${cellOf(record, cols, 'date')}".`);

  const amount = parseEnglishDecimal(cellOf(record, cols, 'amount'));
  if (amount === null || amount <= 0) {
    return fail(`Invalid dividend amount "${cellOf(record, cols, 'amount')}".`);
  }

  const description = cellOf(record, cols, 'description');
  const instrument = DIVIDEND_INSTRUMENT.exec(description);
  const symbol = instrument?.[1] ?? null;
  const isin = instrument?.[2] ?? null;
  const name = instrument ? null : description || null;
  if (!symbol && !isin && !name) return fail('Dividend row without an instrument.');

  return {
    line: record.line,
    raw: record.raw,
    ok: true,
    row: {
      kind: 'dividend',
      executedAt,
      isin,
      symbol,
      name,
      quantity: null,
      price: null,
      fee: null,
      amountEur: amount,
      currency,
      note: null,
    },
  };
}

/** A `Deposits & Withdrawals` Data row → cash movement, error, or null for summaries. */
function mapCashRecord(record: CsvRecord, cols: Columns): MappedLine | null {
  const fail = (error: string): MappedLine => ({
    line: record.line,
    raw: record.raw,
    ok: false,
    error,
  });

  const currencyRaw = cellOf(record, cols, 'currency');
  if (currencyRaw.startsWith('Total')) return null; // `Total`, `Total in EUR`, …
  const currency = currencyRaw.toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) return fail(`Unrecognized currency "${currencyRaw}".`);
  if (currency !== 'EUR') {
    return fail(`Cash rows must be EUR — got "${currency}" (the cash ledger is EUR-only).`);
  }

  const executedAt = parseDay(cellOf(record, cols, 'settle date'));
  if (!executedAt) return fail(`Unparseable date "${cellOf(record, cols, 'settle date')}".`);

  const amount = parseEnglishDecimal(cellOf(record, cols, 'amount'));
  if (amount === null || amount === 0) {
    return fail(`Invalid amount "${cellOf(record, cols, 'amount')}".`);
  }

  return {
    line: record.line,
    raw: record.raw,
    ok: true,
    row: {
      kind: amount > 0 ? 'deposit' : 'withdrawal',
      executedAt,
      isin: null,
      symbol: null,
      name: null,
      quantity: null,
      price: null,
      fee: null,
      amountEur: Math.abs(amount),
      currency,
      note: cellOf(record, cols, 'description') || null,
    },
  };
}

export const ibkrMapper: BrokerMapper = {
  id: 'ibkr',
  label: 'Interactive Brokers',

  // Structure fingerprint instead of a column one: the share of lines shaped
  // `<Section>,<RowType>,…` — a genuine statement is 100% section-shaped —
  // gated on at least one section this mapper can actually import (a sectioned
  // file with no Trades/Dividends/Deposits would otherwise stage as an empty,
  // useless preview instead of falling back to the manual picker).
  detect(csv: ParsedCsv): number {
    const lines = csv.header ? [csv.header, ...csv.records] : csv.records;
    if (lines.length === 0) return 0;
    let sectionShaped = 0;
    let hasSupportedSection = false;
    for (const line of lines) {
      if (line.cells.length >= 2 && ROW_TYPES.has(line.cells[1] ?? '')) {
        sectionShaped += 1;
        if (SUPPORTED_SECTIONS.has(line.cells[0] ?? '')) hasSupportedSection = true;
      }
    }
    return hasSupportedSection ? sectionShaped / lines.length : 0;
  },

  map(csv: ParsedCsv): MappedLine[] {
    // parseCsv treats the FIRST line as "the header", but on a multi-section
    // statement that is just the first section's Header row — process it too.
    const lines = csv.header ? [csv.header, ...csv.records] : csv.records;
    const sectionColumns = new Map<string, Columns>();
    const mapped: MappedLine[] = [];

    for (const record of lines) {
      const section = record.cells[0] ?? '';
      const rowType = record.cells[1] ?? '';

      if (rowType === 'Header') {
        const cols: Columns = new Map();
        record.cells.forEach((cell, index) => {
          if (index >= 2) cols.set(cell.trim().toLowerCase(), index);
        });
        sectionColumns.set(section, cols);
        continue;
      }
      if (rowType !== 'Data') continue; // SubTotal/Total/Notes carry no transaction
      const cols = sectionColumns.get(section);
      if (!cols) continue;

      let line: MappedLine | null = null;
      if (section === SECTION_TRADES) line = mapTradeRecord(record, cols);
      else if (section === SECTION_DIVIDENDS) line = mapDividendRecord(record, cols);
      else if (section === SECTION_CASH) line = mapCashRecord(record, cols);
      if (line) mapped.push(line);
    }

    return mapped;
  },
};
