import { createHash } from 'node:crypto';

import type { ExpenseDirection } from '@bettertrack/contracts';

/** Cent-canonical decimal so `5`, `5.0` and `5.00` hash identically. */
function canonicalAmount(value: number): string {
  const fixed = value.toFixed(2);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}

/** Trim + collapse whitespace + lowercase so trivial memo reformatting still dedupes. */
function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The idempotency key for one imported bank row: `date+direction+amount+currency+
 * description`, sha-256 hex. Deterministic from the file, so a re-import produces
 * the same hash and the UNIQUE(user, dedup_hash) key skips it.
 */
export function expenseDedupHash(row: {
  bookedOn: string;
  direction: ExpenseDirection;
  amount: number;
  currency: string;
  description: string;
}): string {
  const key = [
    row.bookedOn,
    row.direction,
    canonicalAmount(row.amount),
    row.currency.toUpperCase(),
    normalizeDescription(row.description),
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}
