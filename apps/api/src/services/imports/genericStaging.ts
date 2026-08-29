import type { ImportRowKind, ImportUnderstanding } from '@bettertrack/contracts';

import {
  extractRowFields,
  understandTableWithAi,
  type ColumnMapResult,
  type HeaderMappingAiContext,
} from './columnMapping';
import { classifyRows, type ClassifiableRow, type ClassifyContext } from './rowClassifier';
import {
  parseLocalizedDay,
  parseLocalizedDecimal,
  sniffFlagsByRow,
  type SniffedTable,
} from './table';
import type { MappedLine, NormalizedImportRow } from './types';

/**
 * The GENERIC staging path (#964, §16 2026-07-31: "IMPORT IS A WIZARD THAT
 * UNDERSTANDS A WHOLE FILE, not a CSV parser for one shape").
 *
 * The four broker mappers stay exactly as they are and keep first claim on a
 * file — they are hand-verified fast paths for the exports we know. This module
 * is what happens to everything else: instead of the old
 * `IMPORT_BROKER_UNRECOGNIZED` dead end, the file is sniffed, its columns are
 * labelled, and its rows are classified individually, so the owner's stated
 * failure mode — "OH I ONLY UNDERSTAND CASH TRANSACTIONS IN THIS FORMAT AND IF
 * THERE IS 1 STOCK TRANSACTION I EITHER BREAK OR ADD IT TO JUST A CASH
 * WITHDRAW" — cannot happen: kind is decided per ROW, so one file may hold 20
 * cash movements and 30 trades (directive point 2).
 *
 * It emits the SAME {@link MappedLine} shape a broker mapper emits, which is
 * the whole integration: instrument resolution, candidate capture, dedupe,
 * cash-rule pre-tagging, staging and apply downstream are byte-for-byte the
 * code that already runs, and none of them learns that a second front end
 * exists.
 *
 * ── WHAT THIS MODULE REFUSES TO DO ────────────────────────────────────────────
 *
 * Every uncertainty becomes a REPORTED row, never a booked guess (directive
 * point 3: report what was understood, ask about what was not). A row is turned
 * into a per-line error — surfaced in the preview, excluded from apply, and the
 * rest of the file still lands — when:
 *
 *  - the classifier could not name its kind, or named one that is not bookable
 *    (`fee` / `tax` / `unknown`);
 *  - the classifier wants a human to look (`needsReview`), including every case
 *    where the sniffer's own doubt about that physical line was handed across;
 *  - the file's date order is a GUESS (`dateLocaleAmbiguous`) — `01/02/2024` is
 *    either 1 February or 2 January, and `table.ts` states that a reader must
 *    force review rather than book unattended. It is the whole file's rows
 *    rather than a few, which is correct and loud: the wizard shows the reason
 *    once and the user fixes the export, instead of a year of holdings landing
 *    off by months;
 *  - a cash or dividend amount is not in EUR. The cash ledger is EUR-only
 *    (§14), this path has no broker-specific knowledge of how a file states its
 *    conversion, and silently treating 500 USD as 500 EUR is a money defect. A
 *    trade keeps its native currency, exactly as the broker mappers do.
 *
 * ── WHERE THE MODEL IS, AND IS NOT ────────────────────────────────────────────
 *
 * The optional heavy-tier header fallback is threaded through to
 * {@link understandTableWithAi} and nothing else. Its output is a PROPOSAL that
 * never enters `fieldWinners`, and {@link extractRowFields} — the single
 * function that decides which column a VALUE is read from — reads only
 * `fieldWinners`. So a model cannot influence one number this module extracts,
 * whatever it proposes; the proposals travel to the client as suggestions to be
 * confirmed by a person. With no seam configured this is the deterministic
 * pipeline exactly, which is also what a refused or failing seam degrades to.
 */

/** A bookable wire kind — the classifier's `fee`/`tax`/`unknown` are not. */
const BOOKABLE_KINDS = new Set<string>(['buy', 'sell', 'dividend', 'deposit', 'withdrawal']);

function isBookable(kind: string): kind is ImportRowKind {
  return BOOKABLE_KINDS.has(kind);
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** A mapped cell, trimmed, with the empty string normalized to null. */
function cell(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The file's stated currency for a row: its own currency column when it has a
 * readable one, else the majority currency the sniff found. Anything that is
 * not a three-letter ISO code is discarded rather than passed on — staging's
 * `char(3)` column would reject it and take the whole insert with it.
 */
function rowCurrency(raw: string | null, table: SniffedTable): string {
  const stated = raw?.toUpperCase() ?? null;
  if (stated !== null && CURRENCY_PATTERN.test(stated)) return stated;
  const fallback = table.defaultCurrency.toUpperCase();
  return CURRENCY_PATTERN.test(fallback) ? fallback : 'EUR';
}

/**
 * Reconstruct a display line for the preview's expandable detail. The sniffer
 * hands over parsed cells rather than the original text, so this re-joins them
 * with the file's own delimiter — faithful to the content, not necessarily to
 * the byte-exact original (quoting is not re-applied). `rowIndex` still points
 * at the real physical line, which is what an auditor follows.
 */
function rawLine(cells: readonly string[], delimiter: string): string {
  return cells.join(delimiter);
}

export interface GenericStagingResult {
  understanding: ImportUnderstanding;
  lines: MappedLine[];
}

export interface GenericStagingContext {
  /** Heavy-tier header fallback. Omitted ⇒ deterministic mapping only. */
  header?: HeaderMappingAiContext;
  /** Cheap-tier row classification. Omitted ⇒ stages 1–2 plus review. */
  rows?: ClassifyContext;
}

/** Project the wire view of what the pipeline understood about the file. */
function toUnderstanding(table: SniffedTable, mapping: ColumnMapResult): ImportUnderstanding {
  return {
    mappings: mapping.mappings.map((m) => ({
      header: m.header,
      field: m.field,
      confidence: m.confidence,
      reason: m.reason,
      needsReview: m.needsReview,
      ...(m.alternative ? { alternative: m.alternative } : {}),
      ...(m.alternativeOf ? { alternativeOf: m.alternativeOf } : {}),
      ...(m.source ? { source: m.source } : {}),
    })),
    unmappedHeaders: [...mapping.unmapped],
    delimiter: table.delimiter,
    encoding: table.encoding,
    dateLocale: table.dateLocale,
    numberLocale: table.numberLocale,
    dateLocaleAmbiguous: table.dateLocaleAmbiguous,
  };
}

/**
 * Understand a file and normalize its rows. Returns null when the buffer holds
 * no tabular content at all; propagates `UnsupportedFileFormatError` and
 * `UnmappableTableError` from {@link understandTableWithAi} for the caller to
 * turn into the right 400.
 */
export async function stageGenericFile(
  buffer: Uint8Array,
  filename: string,
  ctx: GenericStagingContext = {},
): Promise<GenericStagingResult | null> {
  const understood = await understandTableWithAi(buffer, filename, ctx.header ?? {});
  if (!understood) return null;
  const { table, mapping } = understood;

  const flagsByRow = sniffFlagsByRow(table);

  // One projection per data row, in file order. Values stay RAW out of
  // `extractRowFields` by contract, so every parse below goes through the
  // table's own locale-aware helpers rather than `Number()`/`Date.parse`.
  const projected = table.rows.map((cells, index) => {
    const fields = extractRowFields(mapping, cells);
    const quantity = cell(fields.quantity);
    const price = cell(fields.price);
    const amount = cell(fields.amount);
    return {
      index,
      cells,
      line: table.lineNumbers[index] ?? index + 1,
      date: cell(fields.date),
      symbol: cell(fields.symbol),
      isin: cell(fields.isin),
      description: cell(fields.description),
      kindHint: cell(fields.kindHint),
      currency: cell(fields.currency),
      fee: cell(fields.fee),
      quantity,
      price,
      amount,
      quantityNum: quantity === null ? null : parseLocalizedDecimal(quantity, table.numberLocale),
      priceNum: price === null ? null : parseLocalizedDecimal(price, table.numberLocale),
      amountNum: amount === null ? null : parseLocalizedDecimal(amount, table.numberLocale),
    };
  });

  const classifiable: ClassifiableRow[] = projected.map((row) => ({
    // The classifier reads free text for its keyword stage; the description
    // column is where a statement's memo lives.
    text: row.description,
    kindHint: row.kindHint,
    quantity: row.quantityNum,
    price: row.priceNum,
    amount: row.amountNum,
    symbol: row.symbol,
    isin: row.isin,
    // Hand the sniffer's per-line doubt across the module boundary: a totals
    // line is invisible to a classifier reading only content, and booking a
    // file's own subtotal as an extra deposit is exactly the defect this
    // parameter exists to stop.
    ...(flagsByRow.get(row.index)?.length ? { sniffFlags: [...flagsByRow.get(row.index)!] } : {}),
  }));

  const verdicts = await classifyRows(classifiable, ctx.rows ?? {});

  const lines: MappedLine[] = projected.map((row) => {
    const raw = rawLine(row.cells, table.delimiter);
    const verdict = verdicts[row.index];
    const fail = (error: string): MappedLine => ({ line: row.line, raw, ok: false, error });

    if (!verdict) return fail('This row could not be classified.');
    if (!isBookable(verdict.kind)) {
      return fail(
        verdict.kind === 'unknown'
          ? `This row could not be identified as a trade, dividend or cash movement (${verdict.evidence}).`
          : `This row looks like a ${verdict.kind} entry, which is not imported on its own — ` +
              'it belongs to the transaction it was charged on.',
      );
    }
    if (verdict.needsReview) {
      return fail(
        `This row needs a human decision before it can be imported — read as ` +
          `"${verdict.kind}" with low confidence (${verdict.evidence}).`,
      );
    }

    if (row.date === null) return fail('This row has no readable date.');
    if (table.dateLocaleAmbiguous) {
      return fail(
        `The file's date order is ambiguous — "${row.date}" could be day/month or ` +
          'month/day. Re-export with ISO dates (YYYY-MM-DD), or import this file per broker.',
      );
    }
    const executedAt = parseLocalizedDay(row.date, table.dateLocale);
    if (executedAt === null)
      return fail(`"${row.date}" is not a date this file's format explains.`);

    const kind: ImportRowKind = verdict.kind;
    const currency = rowCurrency(row.currency, table);
    const feeNum = row.fee === null ? null : parseLocalizedDecimal(row.fee, table.numberLocale);

    if (kind === 'buy' || kind === 'sell') {
      if (row.quantityNum === null || row.priceNum === null) {
        return fail('This row reads as a trade but has no readable quantity and price.');
      }
      if (row.symbol === null && row.isin === null && row.description === null) {
        return fail('This row reads as a trade but names no instrument.');
      }
      const normalized: NormalizedImportRow = {
        kind,
        executedAt,
        isin: row.isin,
        symbol: row.symbol,
        name: row.description,
        // Side is carried by `kind`, so magnitude is what the columns mean —
        // a file writing a sale as a negative quantity states the same trade.
        quantity: Math.abs(row.quantityNum),
        price: Math.abs(row.priceNum),
        fee: feeNum === null ? null : Math.abs(feeNum),
        amountEur: null,
        currency,
        note: row.description,
      };
      return { line: row.line, raw, ok: true, row: normalized };
    }

    // dividend / deposit / withdrawal — the EUR-only side of the ledger (§14).
    if (row.amountNum === null) {
      return fail(`This row reads as a ${kind} but has no readable amount.`);
    }
    if (currency !== 'EUR') {
      return fail(
        `This row is stated in ${currency}, and cash and dividends are recorded in EUR — ` +
          'convert the export, or import this file through its broker mapper.',
      );
    }
    if (
      kind === 'dividend' &&
      row.symbol === null &&
      row.isin === null &&
      row.description === null
    ) {
      return fail('This row reads as a dividend but names no instrument.');
    }
    const normalized: NormalizedImportRow = {
      kind,
      executedAt,
      isin: kind === 'dividend' ? row.isin : null,
      symbol: kind === 'dividend' ? row.symbol : null,
      name: kind === 'dividend' ? row.description : null,
      quantity: null,
      price: null,
      fee: null,
      // Direction is carried by `kind`; staging stores the positive magnitude.
      amountEur: Math.abs(row.amountNum),
      currency,
      note: row.description,
    };
    return { line: row.line, raw, ok: true, row: normalized };
  });

  return { understanding: toUnderstanding(table, mapping), lines };
}
