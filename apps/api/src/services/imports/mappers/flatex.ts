import { parseDay, parseDecimal, type CsvRecord, type ParsedCsv } from '../csv';
import type { BrokerMapper, MappedLine, NormalizedImportRow } from '../types';

/**
 * Flatex export mapper (PROJECTPLAN.md §13.4 V4-P8; quirks documented in
 * docs/imports.md). Flatex ships TWO separate German, semicolon-separated
 * export kinds — one mapper accepts both, dispatching on the header (the
 * committed fixtures define the contract):
 *
 * Wertpapierumsätze (securities):
 *   Buchtag;Valuta;ISIN;Bezeichnung;Nominale;Kurs;Währung;Provision;Endbetrag;Buchungsinformationen
 * Kontoumsätze (cash/account movements):
 *   Buchtag;Valuta;Buchungsinformationen;TA-Nr.;Betrag
 *
 * Numbers are German notation (`1.234,56`), dates German (`15.01.2024`) or ISO;
 * `Buchtag` (booking day) is the row date, `Valuta` is ignored. Securities rows
 * carry the trade side in the `Buchungsinformationen` text (`Kauf …` /
 * `Verkauf …`); `Nominale` may be signed (sells negative) — its magnitude is
 * the quantity, the side always comes from the text. `Provision` is read as a
 * magnitude too (fee columns are printed signed in some exports). `Endbetrag`
 * is not trusted for trades (economics re-derive from Nominale×Kurs+Provision).
 * Cash rows classify by their `Buchungsinformationen` text: dividends
 * (`Ertragsgutschrift`/`Dividende …`, the instrument's ISIN + name extracted
 * from the text), deposits/withdrawals (`Einzahlung`/`Auszahlung`),
 * `Überweisung`/`Ueberweisung` and `Zinsen` by amount sign (interest gets a
 * note). The amount sign must AGREE with the text: a negative dividend or a
 * sign-contradicting deposit/withdrawal — a `Storno …` reversal keeps the
 * original booking's text but flips the sign — fails its row instead of
 * booking its magnitude (refusing costs one reported row; guessing costs
 * money). The Konto is EUR-denominated, so cash rows are always EUR.
 */

const SECURITIES_HEADER = {
  date: 'buchtag',
  valuta: 'valuta',
  isin: 'isin',
  name: 'bezeichnung',
  quantity: 'nominale',
  price: 'kurs',
  currency: 'währung',
  fee: 'provision',
  amount: 'endbetrag',
  info: 'buchungsinformationen',
} as const;

const CASH_HEADER = {
  date: 'buchtag',
  valuta: 'valuta',
  info: 'buchungsinformationen',
  reference: 'ta-nr.',
  amount: 'betrag',
} as const;

type SecuritiesKey = keyof typeof SECURITIES_HEADER;
type CashKey = keyof typeof CASH_HEADER;

function columnIndexes<K extends string>(
  header: CsvRecord | null,
  columns: Record<K, string>,
): Record<K, number> {
  const cells = (header?.cells ?? []).map((c) => c.toLowerCase());
  const out = {} as Record<K, number>;
  for (const key of Object.keys(columns) as K[]) {
    out[key] = cells.indexOf(columns[key]);
  }
  return out;
}

function fingerprint<K extends string>(header: CsvRecord | null, columns: Record<K, string>) {
  const idx = columnIndexes(header, columns);
  const keys = Object.keys(columns) as K[];
  return keys.filter((k) => idx[k] >= 0).length / keys.length;
}

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const ISIN_IN_TEXT = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;

/** ISO-4217 shape. Anything else ("EURO", "EUR/USD") must fail its ROW, not the batch. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function mapSecuritiesRecord(
  record: CsvRecord,
  cell: (record: CsvRecord, key: SecuritiesKey) => string,
): MappedLine {
  const fail = (error: string): MappedLine => ({
    line: record.line,
    raw: record.raw,
    ok: false,
    error,
  });

  const info = cell(record, 'info');
  const lowered = info.toLowerCase();
  const kind: NormalizedImportRow['kind'] | null = lowered.startsWith('kauf')
    ? 'buy'
    : lowered.startsWith('verkauf')
      ? 'sell'
      : null;
  if (!kind) return fail(`Unsupported booking "${info || '(empty)'}".`);

  const executedAt = parseDay(cell(record, 'date'));
  if (!executedAt) return fail(`Unparseable date "${cell(record, 'date')}".`);

  const currency = (cell(record, 'currency') || 'EUR').toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) {
    return fail(`Unrecognized currency "${cell(record, 'currency')}".`);
  }
  const isinRaw = cell(record, 'isin').toUpperCase();
  const isin = ISIN_PATTERN.test(isinRaw) ? isinRaw : null;
  const name = cell(record, 'name') || null;
  if (!isin && !name) return fail('Trade row without an ISIN or security name.');

  const nominale = parseDecimal(cell(record, 'quantity'));
  const price = parseDecimal(cell(record, 'price'));
  // Signed magnitudes: sells print a negative Nominale, some exports print
  // Provision signed — the side always comes from the booking text.
  const quantity = nominale === null ? null : Math.abs(nominale);
  const fee = Math.abs(parseDecimal(cell(record, 'fee')) ?? 0);
  if (quantity === null || quantity === 0) {
    return fail(`Invalid quantity "${cell(record, 'quantity')}".`);
  }
  if (price === null || price < 0) return fail(`Invalid price "${cell(record, 'price')}".`);

  return {
    line: record.line,
    raw: record.raw,
    ok: true,
    row: {
      kind,
      executedAt,
      isin,
      symbol: null,
      name,
      quantity,
      price,
      fee,
      amountEur: null,
      currency,
      note: null,
    },
  };
}

function mapCashRecord(
  record: CsvRecord,
  cell: (record: CsvRecord, key: CashKey) => string,
): MappedLine {
  const fail = (error: string): MappedLine => ({
    line: record.line,
    raw: record.raw,
    ok: false,
    error,
  });

  const executedAt = parseDay(cell(record, 'date'));
  if (!executedAt) return fail(`Unparseable date "${cell(record, 'date')}".`);

  const amount = parseDecimal(cell(record, 'amount'));
  if (amount === null || amount === 0) {
    return fail(`Invalid amount "${cell(record, 'amount')}".`);
  }

  const info = cell(record, 'info');
  const lowered = info.toLowerCase();

  const base = {
    executedAt,
    symbol: null,
    quantity: null,
    price: null,
    fee: null,
    amountEur: Math.abs(amount),
    currency: 'EUR', // the Flatex Konto is EUR-denominated (no currency column)
  };

  // Dividend booking: "Ertragsgutschrift <ISIN> <security name>". A reversal
  // ("Storno Ertragsgutschrift …") keeps the text but flips the sign — booking
  // its magnitude would double-count the income (and, under the AT tax mode,
  // withhold KESt on it), so a negative amount fails its row.
  if (/(ertragsgutschrift|dividende)/.test(lowered)) {
    if (amount < 0) {
      return fail(
        `Negative dividend amount "${cell(record, 'amount')}" — likely a reversal (Storno); adjust the original transaction manually.`,
      );
    }
    const isin = ISIN_IN_TEXT.exec(info)?.[1] ?? null;
    const name =
      info
        .replace(/^\s*(ertragsgutschrift|dividende)\s*/i, '')
        .replace(isin ?? '', '')
        .trim() || null;
    if (!isin && !name) return fail('Dividend booking without an instrument.');
    return {
      line: record.line,
      raw: record.raw,
      ok: true,
      row: { ...base, kind: 'dividend', isin, name, note: null },
    };
  }

  let kind: NormalizedImportRow['kind'] | null = null;
  let note: string | null = info || null;
  if (lowered.includes('einzahlung')) kind = 'deposit';
  else if (lowered.includes('auszahlung')) kind = 'withdrawal';
  else if (/(überweisung|ueberweisung)/.test(lowered)) {
    kind = amount > 0 ? 'deposit' : 'withdrawal';
  } else if (lowered.includes('zinsen')) {
    kind = amount > 0 ? 'deposit' : 'withdrawal';
    note = 'Interest (Flatex)';
  }
  if (!kind) return fail(`Unsupported booking "${info || '(empty)'}".`);
  // The text names a direction; an amount whose sign contradicts it (a Storno
  // reversal, or an export variant this mapper doesn't know) must not book as
  // the text's direction with the sign discarded.
  if ((kind === 'deposit' && amount < 0) || (kind === 'withdrawal' && amount > 0)) {
    return fail(
      `Amount "${cell(record, 'amount')}" contradicts the booking text "${info}" — likely a reversal (Storno); adjust the original transaction manually.`,
    );
  }

  return {
    line: record.line,
    raw: record.raw,
    ok: true,
    row: { ...base, kind, isin: null, name: null, note },
  };
}

export const flatexMapper: BrokerMapper = {
  id: 'flatex',
  label: 'Flatex',

  // Two header fingerprints, one per export kind — detect() takes the better
  // one. A genuine export scores 1 on its own kind; the cash columns shared by
  // the securities header (Buchtag/Valuta/Buchungsinformationen) never beat it.
  detect(csv: ParsedCsv): number {
    return Math.max(
      fingerprint(csv.header, SECURITIES_HEADER),
      fingerprint(csv.header, CASH_HEADER),
    );
  },

  map(csv: ParsedCsv): MappedLine[] {
    const securitiesIdx = columnIndexes(csv.header, SECURITIES_HEADER);
    const cashIdx = columnIndexes(csv.header, CASH_HEADER);

    // Dispatch on the columns only one kind has: Nominale+ISIN → securities,
    // Betrag+Buchungsinformationen → cash. Neither → not a Flatex export; a
    // manual mis-pick costs its rows, never the batch.
    if (securitiesIdx.quantity >= 0 && securitiesIdx.isin >= 0) {
      const cell = (record: CsvRecord, key: SecuritiesKey): string =>
        securitiesIdx[key] >= 0 ? (record.cells[securitiesIdx[key]] ?? '') : '';
      return csv.records.map((record) => mapSecuritiesRecord(record, cell));
    }
    if (cashIdx.amount >= 0 && cashIdx.info >= 0) {
      const cell = (record: CsvRecord, key: CashKey): string =>
        cashIdx[key] >= 0 ? (record.cells[cashIdx[key]] ?? '') : '';
      return csv.records.map((record) => mapCashRecord(record, cell));
    }
    return csv.records.map((record) => ({
      line: record.line,
      raw: record.raw,
      ok: false,
      error: 'Not a recognized Flatex export — expected a Wertpapierumsätze or Kontoumsätze CSV.',
    }));
  },
};
