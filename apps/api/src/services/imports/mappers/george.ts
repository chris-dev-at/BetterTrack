import { parseDay, parseDecimal, type CsvRecord, type ParsedCsv } from '../csv';
import type { BrokerMapper, MappedLine, NormalizedImportRow } from '../types';

/**
 * George (Erste Bank AT) securities-account export mapper (PROJECTPLAN.md §13.4
 * V4-P8; quirks documented in docs/imports.md). The Wertpapier export is a
 * German CSV — semicolon- (or comma-) separated, the fixture defines the
 * contract — with the columns
 *
 *   Buchungsdatum;Auftragsart;Titel;ISIN;Stück;Kurs;Betrag;Spesen;Währung
 *
 * Dates are German (`15.01.2024`) or ISO, numbers German notation (`1.234,56`).
 * Trades and dividends share the one export: `Kauf`/`Verkauf` rows carry
 * Stück/Kurs/Spesen, `Ertrag` (Ertragsgutschrift) rows carry the EUR gross in
 * `Betrag`. Instruments are ISIN + Titel — George exports no ticker symbol;
 * resolution against the local catalog is the framework's job. `Betrag` is the
 * signed EUR cash effect (buys negative) — trades re-derive their economics
 * from Stück×Kurs+Spesen, so `Betrag` is only trusted for dividend rows, and
 * there it must be positive (income is cash-in; a negative amount fails its
 * row). Cash movements live on the giro account, not in this export — there
 * are no deposit/withdrawal row types.
 */

const HEADER = {
  date: 'buchungsdatum',
  type: 'auftragsart',
  name: 'titel',
  isin: 'isin',
  quantity: 'stück',
  price: 'kurs',
  amount: 'betrag',
  fee: 'spesen',
  currency: 'währung',
} as const;

type ColumnKey = keyof typeof HEADER;

/** George `Auftragsart` values → normalized kinds (`Ertrag` = Ertragsgutschrift). */
const TYPE_MAP: Record<string, NormalizedImportRow['kind']> = {
  kauf: 'buy',
  verkauf: 'sell',
  ertrag: 'dividend',
  dividende: 'dividend',
  ausschüttung: 'dividend',
};

/** Resolve each known column to its index in this file's header (missing → -1). */
function columnIndexes(header: CsvRecord | null): Record<ColumnKey, number> {
  const cells = (header?.cells ?? []).map((c) => c.toLowerCase());
  const out = {} as Record<ColumnKey, number>;
  for (const key of Object.keys(HEADER) as ColumnKey[]) {
    out[key] = cells.indexOf(HEADER[key]);
  }
  return out;
}

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/** ISO-4217 shape. Anything else ("EURO", "EUR/USD") must fail its ROW, not the batch. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const georgeMapper: BrokerMapper = {
  id: 'george',
  label: 'George (Erste Bank)',

  // Header fingerprint: the share of George's nine columns present. A genuine
  // export scores 1; the overlap with Trade Republic (ISIN/Kurs/Betrag/Währung)
  // stays at 4/9 either way, safely under the 0.6 registry threshold.
  detect(csv: ParsedCsv): number {
    const idx = columnIndexes(csv.header);
    const keys = Object.keys(HEADER) as ColumnKey[];
    const present = keys.filter((k) => idx[k] >= 0).length;
    return present / keys.length;
  },

  map(csv: ParsedCsv): MappedLine[] {
    const idx = columnIndexes(csv.header);
    const cell = (record: CsvRecord, key: ColumnKey): string =>
      idx[key] >= 0 ? (record.cells[idx[key]] ?? '') : '';

    return csv.records.map((record): MappedLine => {
      const fail = (error: string): MappedLine => ({
        line: record.line,
        raw: record.raw,
        ok: false,
        error,
      });

      const typeRaw = cell(record, 'type');
      const kind = TYPE_MAP[typeRaw.toLowerCase()];
      if (!kind) return fail(`Unsupported row type "${typeRaw || '(empty)'}".`);

      const executedAt = parseDay(cell(record, 'date'));
      if (!executedAt) return fail(`Unparseable date "${cell(record, 'date')}".`);

      const currency = (cell(record, 'currency') || 'EUR').toUpperCase();
      if (!CURRENCY_PATTERN.test(currency)) {
        return fail(`Unrecognized currency "${cell(record, 'currency')}".`);
      }
      const isinRaw = cell(record, 'isin').toUpperCase();
      const isin = ISIN_PATTERN.test(isinRaw) ? isinRaw : null;
      const name = cell(record, 'name') || null;
      if (!isin && !name) return fail('Row without an ISIN or security title.');

      const base = {
        executedAt,
        isin,
        symbol: null,
        name,
        currency,
        note: null,
      };

      if (kind === 'buy' || kind === 'sell') {
        const quantity = parseDecimal(cell(record, 'quantity'));
        const price = parseDecimal(cell(record, 'price'));
        const fee = parseDecimal(cell(record, 'fee')) ?? 0;
        if (quantity === null || quantity <= 0) {
          return fail(`Invalid quantity "${cell(record, 'quantity')}".`);
        }
        if (price === null || price < 0) return fail(`Invalid price "${cell(record, 'price')}".`);
        if (fee < 0) return fail(`Invalid fee "${cell(record, 'fee')}".`);
        return {
          line: record.line,
          raw: record.raw,
          ok: true,
          row: { ...base, kind, quantity, price, fee, amountEur: null },
        };
      }

      // Dividend (Ertrag): the EUR gross in Betrag — income is cash-in, so the
      // amount must be positive; a negative one (a reversal booked under a
      // dividend type) fails its row instead of booking as positive income.
      const amount = parseDecimal(cell(record, 'amount'));
      if (amount === null || amount <= 0) {
        return fail(`Invalid dividend amount "${cell(record, 'amount')}".`);
      }
      if (currency !== 'EUR') {
        return fail(`Dividend rows must be EUR — got "${currency}" (the cash ledger is EUR-only).`);
      }
      return {
        line: record.line,
        raw: record.raw,
        ok: true,
        row: {
          ...base,
          kind,
          quantity: null,
          price: null,
          fee: null,
          amountEur: amount,
        },
      };
    });
  },
};
