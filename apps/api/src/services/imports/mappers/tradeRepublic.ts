import { parseDay, parseDecimal, type CsvRecord, type ParsedCsv } from '../csv';
import type { BrokerMapper, MappedLine, NormalizedImportRow } from '../types';

/**
 * Trade Republic transaction-export mapper (PROJECTPLAN.md §13.4 V4-P8; quirks
 * documented in docs/imports.md). The app's German CSV export is
 * semicolon-separated with the columns
 *
 *   Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung
 *
 * Dates are ISO or `DD.MM.YYYY`, numbers German notation (`1.234,56`).
 * Instruments are identified by **ISIN + security name only** — TR exports no
 * ticker symbol; resolution against the local catalog is the framework's job.
 * `Betrag` is the signed EUR cash effect (buys negative, sells/dividends/
 * deposits positive) — trades re-derive their economics from Anzahl×Kurs+Gebühr,
 * so `Betrag` is not trusted for them; cash rows take its magnitude.
 */

const HEADER = {
  date: 'datum',
  type: 'typ',
  name: 'wertpapier',
  isin: 'isin',
  quantity: 'anzahl',
  price: 'kurs',
  fee: 'gebühr',
  amount: 'betrag',
  currency: 'währung',
} as const;

type ColumnKey = keyof typeof HEADER;

/** TR `Typ` values → normalized kinds. `Sparplan` is a savings-plan buy; `Zinsen` is the cash-interest payout (booked as an external deposit — no instrument). */
const TYPE_MAP: Record<string, NormalizedImportRow['kind']> = {
  kauf: 'buy',
  sparplan: 'buy',
  verkauf: 'sell',
  dividende: 'dividend',
  einzahlung: 'deposit',
  auszahlung: 'withdrawal',
  zinsen: 'deposit',
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

export const tradeRepublicMapper: BrokerMapper = {
  id: 'trade_republic',
  label: 'Trade Republic',

  // Header fingerprint: the share of TR's nine columns present. A genuine
  // export scores 1; the 0.6 registry threshold tolerates a column TR might
  // add/drop across app versions without matching other brokers' headers.
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
      const isInterest = typeRaw.toLowerCase() === 'zinsen';

      const base = {
        executedAt,
        isin,
        symbol: null,
        name,
        currency,
        note: isInterest ? 'Interest payment (Trade Republic)' : null,
      };

      if (kind === 'buy' || kind === 'sell') {
        const quantity = parseDecimal(cell(record, 'quantity'));
        const price = parseDecimal(cell(record, 'price'));
        const fee = parseDecimal(cell(record, 'fee')) ?? 0;
        if (!isin && !name) return fail('Trade row without an ISIN or security name.');
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

      // Dividend / deposit / withdrawal: the signed Betrag's magnitude in EUR.
      const amount = parseDecimal(cell(record, 'amount'));
      if (amount === null || amount === 0) {
        return fail(`Invalid amount "${cell(record, 'amount')}".`);
      }
      // Dividend income is cash-IN: a negative Betrag under a dividend Typ is a
      // reversal — booking its magnitude would double-count the income (and,
      // under the AT tax mode, withhold KESt on it). George/Flatex refuse the
      // same shape; deposits/withdrawals keep the magnitude (Typ names their
      // direction, and TR prints Auszahlungen negative by design).
      if (kind === 'dividend' && amount < 0) {
        return fail(
          `Negative dividend amount "${cell(record, 'amount')}" — likely a reversal; adjust the original transaction manually.`,
        );
      }
      if (currency !== 'EUR') {
        return fail(`Cash rows must be EUR — got "${currency}" (the cash ledger is EUR-only).`);
      }
      if (kind === 'dividend' && !isin && !name) {
        return fail('Dividend row without an ISIN or security name.');
      }
      return {
        line: record.line,
        raw: record.raw,
        ok: true,
        row: {
          ...base,
          kind,
          // Interest is a plain cash inflow — never tied to an instrument.
          isin: isInterest ? null : base.isin,
          name: isInterest ? null : base.name,
          quantity: null,
          price: null,
          fee: null,
          amountEur: Math.abs(amount),
        },
      };
    });
  },
};
