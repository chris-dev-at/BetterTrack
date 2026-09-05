import type { ImportRowKind, ImportUnderstanding } from '@bettertrack/contracts';

import {
  extractRowFields,
  understandTableWithAi,
  type ColumnMapResult,
  type HeaderMappingAiContext,
} from './columnMapping';
import { stripDecimalDecoration } from './csv';
import { deriveRowForKind } from './kindDerivation';
import { classifyRows, type ClassifiableRow, type ClassifyContext } from './rowClassifier';
import {
  defaultCurrencyForTable,
  parseLocalizedDay,
  parseLocalizedDecimal,
  sniffFlagsByRow,
  type SniffedTable,
} from './table';
import type { MappedLine, PendingKindFields } from './types';

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
 * ── REPORTED IS NOT ALWAYS FINAL (§16 2026-08-29 gap (b)) ─────────────────────
 *
 * The first two of those are a MISSING DECISION; the rest are a missing or
 * unusable VALUE. They read identically in the preview and they used to be
 * identical in staging too — every `!ok` line was persisted with all columns
 * null, so a Raiffeisen ELBA statement (no booking-type column: every row a
 * memo plus a signed amount) previewed perfectly and could never be imported.
 *
 * So a row held back only by the kind question now keeps its parsed fields
 * ({@link PendingKindFields}) and can be finished by a person through
 * `PATCH /imports/:batchId/rows/:rowId`, which re-runs `deriveRowForKind`
 * against exactly those fields. The machine still refuses to guess — that is
 * unchanged and is the whole reason the question reaches a human at all.
 *
 * The kind-independent gates therefore run FIRST below: a row whose date cannot
 * be read has nothing to confirm, and offering the question would be a lie.
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
 * readable one, else the file's default. Anything that is not a three-letter ISO
 * code is discarded rather than passed on — staging's `char(3)` column would
 * reject it and take the whole insert with it.
 *
 * The default comes from {@link defaultCurrencyForTable} rather than the sniff's
 * own mapping-blind `defaultCurrency`: it is the majority over the columns this
 * module actually reads, so an informational FX column the mapper has already
 * decided to `ignore` cannot restate the whole file's currency.
 */
function rowCurrency(raw: string | null, fileCurrency: string): string {
  const stated = raw?.toUpperCase() ?? null;
  if (stated !== null && CURRENCY_PATTERN.test(stated)) return stated;
  const fallback = fileCurrency.toUpperCase();
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
function toUnderstanding(
  table: SniffedTable,
  mapping: ColumnMapResult,
  amountsSigned: boolean,
): ImportUnderstanding {
  return {
    amountsSigned,
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

  // The columns the mapper decided carry no value for us. Both the sniff's
  // per-row doubt and the file's default currency are scoped to what is left:
  // an `ignore`-mapped column may not force a row to manual review, and may not
  // restate the file's currency, because nothing below ever reads it.
  const ignoredColumns = new Set(mapping.ignoredColumns);
  const flagsByRow = sniffFlagsByRow(table, { ignoredColumns });
  const fileCurrency = defaultCurrencyForTable(table, { ignoredColumns });

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

  /**
   * Does this file's amount column carry SIGNS? One explicitly signed cell
   * anywhere settles it — a column that marks direction marks it throughout, so
   * its unmarked positives are inflows rather than unsigned magnitudes.
   *
   * A property of the FILE, decided once over every row, because a single row
   * cannot tell you: `2100.00` is exactly as consistent with "money in" as with
   * "the amount, direction stated elsewhere". It travels on the understanding
   * and is what lets a later confirmation refuse the wrong direction.
   *
   * IT READS THE RAW CELL, NOT THE PARSED NUMBER, and that is the whole point:
   * `parseDecimal` strips a leading `+` on its way to the value (correctly —
   * `+2.100,00` IS 2100), so asking the parsed number "are you negative?" reads
   * a statement of nothing but explicit `+` credits as UNSIGNED. Every row of
   * such a file was then confirmable as a withdrawal, and the wizard's bulk bar
   * offered "confirm these as withdrawals" over unmistakable inflows. The sign
   * survives only here, before the parse, so it is captured here.
   */
  const statesSign = (raw: string | null): boolean => {
    if (raw === null) return false;
    // The SAME decoration stripper the parsers use, so `+1.000,00 EUR` and a
    // bare `+5` answer alike and a future decoration rule cannot make the two
    // disagree.
    const bare = stripDecimalDecoration(raw);
    return bare !== null && (bare.startsWith('+') || bare.startsWith('-'));
  };
  const amountsSigned = projected.some(
    (row) => row.amountNum !== null && (row.amountNum < 0 || statesSign(row.amount)),
  );
  const derivation = { amountsSigned };

  const lines: MappedLine[] = projected.map((row) => {
    const raw = rawLine(row.cells, table.delimiter);
    const verdict = verdicts[row.index];
    const fail = (error: string): MappedLine => ({ line: row.line, raw, ok: false, error });

    if (!verdict) return fail('This row could not be classified.');

    // ── The kind-INDEPENDENT gates run first ─────────────────────────────────
    // They used to run after the classifier's verdict, which was harmless while
    // every unbookable row was equally final. It is not harmless now: a row
    // reported as "needs a human decision" while its real blocker is an
    // unreadable date would offer a confirmation that could never derive
    // anything. Whatever is missing here is missing for EVERY kind, so it is
    // the honest reason to show, and such a row is not confirmable.
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

    // Everything the row parsed, kind still open. This is what a later
    // confirmation derives from — the upload itself is never retained.
    const fields: PendingKindFields = {
      executedAt,
      isin: row.isin,
      symbol: row.symbol,
      name: row.description,
      quantity: row.quantityNum,
      price: row.priceNum,
      fee: row.fee === null ? null : parseLocalizedDecimal(row.fee, table.numberLocale),
      amount: row.amountNum,
      currency: rowCurrency(row.currency, fileCurrency),
      note: row.description,
    };

    // ── The kind question ────────────────────────────────────────────────────
    // A row the classifier will not settle is REPORTED exactly as before — and
    // now carries its parsed fields, so the wizard can offer "this row is a …"
    // and the server can derive the booking from what it read rather than from
    // anything the client sends (§16 2026-08-29 gap (b)).
    const undecided = (error: string): MappedLine => ({
      line: row.line,
      raw,
      ok: false,
      error,
      pending: fields,
    });

    if (!isBookable(verdict.kind)) {
      return undecided(
        verdict.kind === 'unknown'
          ? `This row could not be identified as a trade, dividend or cash movement (${verdict.evidence}).`
          : `This row looks like a ${verdict.kind} entry, which is not imported on its own — ` +
              'it belongs to the transaction it was charged on.',
      );
    }
    if (verdict.needsReview) {
      return undecided(
        `This row needs a human decision before it can be imported — read as ` +
          `"${verdict.kind}" with low confidence (${verdict.evidence}).`,
      );
    }

    const kind: ImportRowKind = verdict.kind;
    const derived = deriveRowForKind(kind, fields, derivation);
    // A kind the classifier was SURE of that the derivation cannot build is a
    // plain error, not a question: the machine's reading and the row's content
    // disagree, and asking a person to re-assert the same kind would not change
    // what the row is missing.
    //
    // A CURRENCY refusal is the exception, and it is why `deriveRowForKind`
    // names its refusals. It says nothing about the kind — the row's units are
    // simply not ones the EUR-only cash ledger holds (§14) — and the same row
    // may still be derivable as a trade, which keeps its native currency. Ending
    // it here made the refusal unrecoverable: the row was persisted with every
    // column null, so nothing the wizard offered could reach it, and a person
    // whose file merely carried an odd currency column had no move but to
    // re-export. It stays refused, and now it stays confirmable.
    if (!derived.ok) {
      return derived.refusal === 'currency' ? undecided(derived.error) : fail(derived.error);
    }
    return { line: row.line, raw, ok: true, row: derived.row };
  });

  return { understanding: toUnderstanding(table, mapping, amountsSigned), lines };
}
