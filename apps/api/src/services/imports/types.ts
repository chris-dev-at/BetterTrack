import type { ImportRowKind } from '@bettertrack/contracts';

import type { ParsedCsv } from './csv';

/**
 * The broker-mapper contract (PROJECTPLAN.md §13.4 V4-P8). Adding a broker is
 * exactly one mapper module (+ one anonymized fixture) registered in
 * `mappers/index.ts` — the framework (parsing, staging, resolution, dedupe,
 * preview, apply) never changes per broker. Mappers are pure: text in,
 * normalized rows out, no I/O — so every quirk is directly unit-testable.
 */

/**
 * One CSV row normalized to BetterTrack's staging shape. Trades carry
 * `quantity`/`price`/`fee` in the file's stated `currency`; `dividend` /
 * `deposit` / `withdrawal` rows carry the positive EUR magnitude in `amountEur`
 * (the cash ledger is EUR-only, §14). Instrument identity is whatever the file
 * provides — `isin`, `symbol`, `name`, each null when absent; the FRAMEWORK
 * resolves them against the local catalog (never the mapper).
 */
export interface NormalizedImportRow {
  kind: ImportRowKind;
  executedAt: Date;
  isin: string | null;
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  price: number | null;
  fee: number | null;
  amountEur: number | null;
  currency: string;
  note: string | null;
}

/**
 * Everything one row PARSED, with the kind left open (#964, §16 2026-08-29).
 *
 * This is {@link NormalizedImportRow} minus the one thing the classifier
 * refused to name, and it is deliberately kind-AGNOSTIC: `amount` is signed as
 * the file stated it, quantities keep whatever sign they had, and the identity
 * columns are still filled in even though a cash kind will discard them. The
 * kind-specific shaping — magnitudes, which columns survive, which are required
 * — happens exactly once, in `kindDerivation.deriveRowForKind`, whether the
 * classifier settled the kind or a person did later.
 *
 * It exists so a needs-review row can be CONFIRMED without re-uploading: the
 * file itself is never retained, so if staging did not keep these values there
 * would be nothing left to derive a booking from.
 */
export interface PendingKindFields {
  executedAt: Date;
  isin: string | null;
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  price: number | null;
  fee: number | null;
  /** SIGNED as the file wrote it — direction evidence, not a magnitude. */
  amount: number | null;
  currency: string;
  note: string | null;
}

/**
 * One mapped CSV line: either a normalized row or a per-line error (reported in
 * the preview while the rest of the file still lands — never all-or-nothing).
 *
 * The error variant carries an optional `pending` payload, which is the
 * INTERNAL distinction between the two very different reasons a line is not
 * bookable:
 *
 *  - ABSENT — the line could not be READ (an unreadable date, a number the
 *    staging columns refuse, an ambiguous date order). Nothing a person asserts
 *    can repair it here; it is reported with its reason and that is the end of
 *    it. Every broker mapper produces only this variant.
 *  - PRESENT — the line read perfectly and the classifier declined to name its
 *    KIND. The parsed fields ride along so a person can confirm one.
 *
 * On the wire BOTH are `flag: 'error'` — that vocabulary is frozen (shipped
 * mobile parses it) and both are equally "this import will not book it". The
 * client tells them apart by `confirmableKinds`, which only the second kind of
 * row can have.
 */
export type MappedLine =
  | { line: number; raw: string; ok: true; row: NormalizedImportRow }
  | { line: number; raw: string; ok: false; error: string; pending?: PendingKindFields };

export interface BrokerMapper {
  /** Stable mapper id (`trade_republic`) — stored on batches, shown by the picker. */
  id: string;
  /** Human label ("Trade Republic"). */
  label: string;
  /**
   * Confidence [0..1] that this parsed CSV is this broker's export — usually a
   * header-column fingerprint. Autodetect picks the highest score above the
   * registry threshold; ties go to registration order.
   */
  detect(csv: ParsedCsv): number;
  /** Map every data record to a normalized row or a per-line error. */
  map(csv: ParsedCsv): MappedLine[];
}
