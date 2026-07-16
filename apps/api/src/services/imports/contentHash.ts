import { createHash } from 'node:crypto';

import type { ImportRowKind } from '@bettertrack/contracts';

/**
 * Content-hash dedupe for broker imports (PROJECTPLAN.md §13.4 V4-P8): the spec
 * key is `date + instrument + qty + price`. The same function covers all row
 * kinds so a re-import of the SAME file is a no-op end-to-end:
 *
 * - trades hash `day|instrument|quantity|price`;
 * - dividends have no qty/price — the EUR gross takes the price slot;
 * - cash rows have no instrument — the kind takes the instrument slot and the
 *   EUR magnitude the price slot (`deposit` vs `withdrawal` must not collide).
 *
 * `instrument` is the resolved catalog asset id when resolution succeeded (so
 * hashes are comparable with already-recorded transactions/dividends), else the
 * file's raw identity (ISIN/symbol/name) — those hashes only ever dedupe
 * *within* a file, since an unresolved row can never have landed before.
 */

/** ISO calendar day of a timestamp — the `date` part of the dedupe key. */
export function hashDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Canonical decimal rendering so `5`, `5.0` and a DB `numeric` `"5.00000000"`
 * (already parsed to `number` by the repositories) hash identically.
 */
export function canonicalAmount(value: number | null): string {
  return value === null ? '' : String(value);
}

export interface ContentHashInput {
  kind: ImportRowKind;
  executedAt: Date;
  /** Resolved asset id, or the file's raw instrument identity; null for cash rows. */
  instrument: string | null;
  quantity: number | null;
  price: number | null;
  /** EUR magnitude for dividend/cash rows (takes the price slot). */
  amountEur: number | null;
}

/** The §13.4 content hash (`date+instrument+qty+price`), sha-256 hex. */
export function contentHash(input: ContentHashInput): string {
  const isTrade = input.kind === 'buy' || input.kind === 'sell';
  const instrument = isTrade || input.kind === 'dividend' ? input.instrument : `cash:${input.kind}`;
  const priceSlot = isTrade ? input.price : input.amountEur;
  const key = [
    hashDay(input.executedAt),
    instrument ?? '',
    canonicalAmount(input.quantity),
    canonicalAmount(priceSlot),
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}
