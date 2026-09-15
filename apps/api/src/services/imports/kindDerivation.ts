import type { ImportRowKind } from '@bettertrack/contracts';
import { IMPORT_ROW_KINDS } from '@bettertrack/contracts';

import type { NormalizedImportRow, PendingKindFields } from './types';

/**
 * THE ONE PLACE A KIND BECOMES A BOOKING (#964; §16 2026-08-29 gap (b)).
 *
 * Given a kind and the fields a row parsed, this decides whether that kind is
 * derivable at all and, if it is, what the staged row looks like: which columns
 * survive, which are required, and which magnitudes are taken.
 *
 * It has exactly TWO callers, and that is the whole point of extracting it:
 *
 *  1. `genericStaging`, when the CLASSIFIER named the kind;
 *  2. `importService.resolveRow`, when a PERSON named it afterwards through
 *     `PATCH /imports/:batchId/rows/:rowId`.
 *
 * The second caller is why the derivation may not live inline in staging any
 * more. The upload is never retained, so confirming a kind cannot mean
 * re-reading the file — it means re-running THIS function against the fields
 * already persisted. If the two paths each had their own copy, a person's
 * confirmation could book something staging would have refused, which is the
 * exact drift the subsystem's no-guess promise is made of.
 *
 * ── WHAT A CLIENT CAN AND CANNOT MOVE ────────────────────────────────────────
 *
 * A confirmation carries one enum member. Every number it books comes from
 * {@link PendingKindFields}, which the server parsed from the file; the caller
 * chooses WHICH derivation runs, never what it reads. So the worst a hostile or
 * mistaken client can do is assert a kind the row does not support — and that
 * is refused below, with the reason.
 */

/**
 * The cash direction each kind implies. Mirrors `rowClassifier`'s
 * KEYWORD_EXPECTED_SIGN, and for the same reason: a purchase pays money out, a
 * sale takes money in, and cash kinds say so in their name.
 */
const EXPECTED_DIRECTION: Record<ImportRowKind, 1 | -1> = {
  buy: -1,
  sell: 1,
  deposit: 1,
  dividend: 1,
  withdrawal: -1,
};

/**
 * WHY a kind could not be derived — the difference between "this row is not
 * that" and "this row's units are not ones the cash ledger holds".
 *
 * `currency` is separated because it is not a statement about the KIND at all:
 * the same row may still be derivable as a trade, which keeps its native
 * currency exactly as the broker mappers do. Staging therefore keeps such a row
 * confirmable instead of ending it, so a person can still say what it is —
 * see `genericStaging`.
 */
export type KindDerivationRefusal = 'currency' | 'fields';

export type KindDerivation =
  | { ok: true; row: NormalizedImportRow }
  | { ok: false; error: string; refusal: KindDerivationRefusal };

/**
 * What the FILE the row came from is known to do, as opposed to what the row
 * itself says. Exactly one thing so far, and it is the difference between a
 * number and a direction.
 */
export interface DerivationContext {
  /**
   * The file's amount column carries signs — at least one row of it is
   * negative (`ImportUnderstanding.amountsSigned`).
   *
   * Required rather than defaulted: getting it wrong in either direction is a
   * money question, so every caller states what it knows instead of inheriting
   * an assumption.
   */
  amountsSigned: boolean;
}

const fail = (error: string, refusal: KindDerivationRefusal = 'fields'): KindDerivation => ({
  ok: false,
  error,
  refusal,
});

/** Any evidence of WHICH instrument a row is about. */
function namesInstrument(fields: PendingKindFields): boolean {
  return fields.isin !== null || fields.symbol !== null || fields.name !== null;
}

/**
 * Derive the staged row for one asserted kind, or say why it cannot be one.
 *
 * ── THE ONE RULE THAT IS NOT IN STAGING'S OLD SHAPE ───────────────────────────
 *
 * An amount whose SIGN contradicts the kind's direction is refused.
 *
 * A MINUS SIGN is unambiguous on its own: nothing writes money coming in as a
 * negative, so a negative amount is never a `deposit` or a `dividend`,
 * whatever else the file does. A PLUS is not the mirror image — a great many
 * statements write unsigned magnitudes and carry the direction in a column this
 * path has none of — so a positive amount only refuses an outflow when the file
 * is KNOWN to sign its amounts ({@link DerivationContext.amountsSigned}, true
 * when any row of that upload is negative). On an unsigned file both directions
 * stay open and the person decides, which is the whole point.
 *
 * It is inert on the classifier's own path: every reading whose kind
 * contradicts the row's amount sign is already forced to `needsReview` by
 * `rowClassifier` (`contradictsAmountSign`, and stage 1's sign rules), so no
 * row that reaches this function with a classifier-named kind can trip it. It
 * only ever constrains a HUMAN confirmation — and there it is load-bearing,
 * because the wizard's bulk affordance applies one kind to many rows at once.
 * On a signed statement that is what keeps "confirm the rest as withdrawals"
 * from turning the salary line into money leaving: the salary row is simply not
 * eligible for that sweep, and stays there to be decided on its own.
 */
export function deriveRowForKind(
  kind: ImportRowKind,
  fields: PendingKindFields,
  context: DerivationContext,
): KindDerivation {
  const { amount } = fields;
  const sign = amount === null || amount === 0 ? null : amount > 0 ? 1 : -1;
  // A positive amount is evidence only where the column distinguishes; a
  // negative one always is.
  const signSpeaks = sign === -1 || (sign === 1 && context.amountsSigned);
  if (sign !== null && signSpeaks && EXPECTED_DIRECTION[kind] !== sign) {
    return fail(
      sign === -1
        ? `This row's amount is negative, which is money out — it cannot be recorded as a ` +
            `${kind}. Pick the movement that takes money out, or correct the export.`
        : `This row's amount is positive and this file writes money out as a negative, so ` +
            `the row is money in — it cannot be recorded as a ${kind}.`,
    );
  }

  if (kind === 'buy' || kind === 'sell') {
    if (fields.quantity === null || fields.price === null) {
      return fail('This row reads as a trade but has no readable quantity and price.');
    }
    if (!namesInstrument(fields)) {
      return fail('This row reads as a trade but names no instrument.');
    }
    return {
      ok: true,
      row: {
        kind,
        executedAt: fields.executedAt,
        isin: fields.isin,
        symbol: fields.symbol,
        name: fields.name,
        // Side is carried by `kind`, so magnitude is what the columns mean —
        // a file writing a sale as a negative quantity states the same trade.
        quantity: Math.abs(fields.quantity),
        price: Math.abs(fields.price),
        fee: fields.fee === null ? null : Math.abs(fields.fee),
        amountEur: null,
        currency: fields.currency,
        note: fields.note,
      },
    };
  }

  // dividend / deposit / withdrawal — the EUR-only side of the ledger (§14).
  if (amount === null) {
    return fail(`This row reads as a ${kind} but has no readable amount.`);
  }
  // ZERO IS NOT A DIRECTION, and the ledger says so in its own schema:
  // `portfolio_cash_movements_sign` demands `amount_eur > 0` for money in and
  // `< 0` for money out — "never zero (the ledger never guesses)".
  //
  // Refused HERE, in the derivation, rather than left to the database. A CHECK
  // violation surfaces as a raw driver error at APPLY, long after the batch has
  // been claimed, and a `0,00` line (a netted reversal, a notice line — banks
  // emit them) would otherwise be offered all three cash kinds and confirmed
  // 200. `derivableKinds` therefore offers nothing for such a row and it stays
  // what it was: a reported line nobody can book, which is the truth.
  if (amount === 0) {
    return fail(
      `This row's amount is zero, which is neither money in nor money out — ` +
        'there is no cash movement to record. It stays reported, not imported.',
    );
  }
  if (fields.currency !== 'EUR') {
    return fail(
      `This row is stated in ${fields.currency}, and cash and dividends are recorded in EUR — ` +
        'convert the export, or import this file through its broker mapper.',
      'currency',
    );
  }
  if (kind === 'dividend' && !namesInstrument(fields)) {
    return fail('This row reads as a dividend but names no instrument.');
  }
  return {
    ok: true,
    row: {
      kind,
      // A cash movement is not about an instrument: `contentHash` keys cash on
      // a null instrument, so a memo parked in `name` would hash differently
      // from the same movement recorded by hand and defeat the duplicate check.
      //
      // The memo is not discarded, though — it stays in `note` below, which is
      // the field the booking carries into the ledger and therefore the only
      // one both sides of a dedupe can read. `contentHash` takes it from there
      // as the cash key's discriminator, which is what keeps two same-day
      // €500 deposits with different memos two movements rather than one.
      isin: kind === 'dividend' ? fields.isin : null,
      symbol: kind === 'dividend' ? fields.symbol : null,
      name: kind === 'dividend' ? fields.name : null,
      executedAt: fields.executedAt,
      quantity: null,
      price: null,
      fee: null,
      // Direction is carried by `kind`; staging stores the positive magnitude.
      amountEur: Math.abs(amount),
      currency: fields.currency,
      note: fields.note,
    },
  };
}

/**
 * The kinds {@link deriveRowForKind} will accept for these fields, in the
 * contract's own order.
 *
 * Computed by dry-running the derivation rather than by re-stating its rules,
 * so the list a client is offered and the list the server honours cannot drift.
 * Empty means the row carries nothing bookable — a person asserting a kind
 * would only be told no, so no affordance is offered at all.
 */
export function derivableKinds(
  fields: PendingKindFields,
  context: DerivationContext,
): ImportRowKind[] {
  return IMPORT_ROW_KINDS.filter((kind) => deriveRowForKind(kind, fields, context).ok);
}
