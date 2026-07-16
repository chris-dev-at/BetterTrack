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
 * One mapped CSV line: either a normalized row or a per-line error (reported in
 * the preview while the rest of the file still lands — never all-or-nothing).
 */
export type MappedLine =
  | { line: number; raw: string; ok: true; row: NormalizedImportRow }
  | { line: number; raw: string; ok: false; error: string };

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
