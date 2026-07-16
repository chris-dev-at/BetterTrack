import { createHash } from 'node:crypto';

import type { ImportRowKind } from '@bettertrack/contracts';

import { floorCents } from '../../domain/cashLedger';

/**
 * Content-hash dedupe for broker imports (PROJECTPLAN.md §13.4 V4-P8): the spec
 * key is `date + instrument + qty + price` — it names the dedupe *intent*, and
 * the instrument slot disambiguates wherever distinct rows would otherwise
 * collide. The same function covers all row kinds so a re-import of the SAME
 * file is a no-op end-to-end:
 *
 * - trades hash `day|side:instrument|quantity|price` — a buy and a sell of the
 *   same instrument on the same day at equal quantity and price (a flat
 *   round-trip exit) are two real rows, so the side must not collide, exactly
 *   like `deposit` vs `withdrawal` below;
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

/** Persisted column scales (schema): `numeric(20,8)` quantities, `numeric(20,6)` prices/EUR. */
export const QUANTITY_HASH_SCALE = 8;
export const AMOUNT_HASH_SCALE = 6;

/**
 * Canonical decimal rendering so `5`, `5.0` and a DB `numeric` `"5.00000000"`
 * (already parsed to `number` by the repositories) hash identically. Rounds to
 * the persisted column scale first — a file value with MORE decimals than the
 * column keeps would otherwise hash differently on re-import than the stored
 * entity it created, quietly defeating dedupe.
 */
export function canonicalAmount(value: number | null, scale: number): string {
  if (value === null) return '';
  const fixed = value.toFixed(scale);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
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

/**
 * Dividend/cash EUR amounts persist cent-FLOORED (`taxService.recordDividend`
 * and `depositCash`/`withdrawCash` all quantize through {@link floorCents}), so
 * the hash must key on the exact value the persisted entity will carry —
 * otherwise a >2-decimal file amount (e.g. `3.755`) hashes differently on
 * re-import than the `3.75` entity it created and the row double-books.
 * Trade quantity/price slots keep the full column scales (8/6 dp) — those
 * columns really store `numeric(20,8)`/`numeric(20,6)`.
 */
function centFloored(amountEur: number | null): number | null {
  return amountEur === null ? null : floorCents(amountEur);
}

/** The §13.4 content hash (`date+instrument+qty+price`), sha-256 hex. */
export function contentHash(input: ContentHashInput): string {
  const isTrade = input.kind === 'buy' || input.kind === 'sell';
  const instrument = isTrade
    ? `${input.kind}:${input.instrument ?? ''}`
    : input.kind === 'dividend'
      ? input.instrument
      : `cash:${input.kind}`;
  const priceSlot = isTrade ? input.price : centFloored(input.amountEur);
  const key = [
    hashDay(input.executedAt),
    instrument ?? '',
    canonicalAmount(input.quantity, QUANTITY_HASH_SCALE),
    canonicalAmount(priceSlot, AMOUNT_HASH_SCALE),
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}
