import { uuidv7 } from 'uuidv7';

/**
 * Durable idempotency keys for `DELETE /portfolios/{id}/vault` (leave).
 *
 * The server records each `restoreId` in `vault_leave_receipts` and replays the
 * original receipt instead of re-inserting rows. That only helps if the CLIENT
 * keeps the same id across a retry — including a retry that happens after a
 * crash, a reload, or a browser restart. A `useState` id would be regenerated
 * by exactly the failures the receipt exists to survive, so the id is persisted
 * before the request goes out and cleared only once the server acknowledges it.
 *
 * `localStorage` rather than IndexedDB on purpose: this is a non-secret uuid
 * that must be readable synchronously during a render, and losing it is a
 * correctness bug rather than a privacy one.
 */

const STORAGE_KEY = 'bettertrack.vault2.restoreIds';

type RestoreIdMap = Record<string, string>;

function read(): RestoreIdMap {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const map: RestoreIdMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') map[key] = value;
    }
    return map;
  } catch {
    // A corrupt or unavailable store must not block a move-out; the worst case
    // is a fresh id, which is exactly where we would have been anyway.
    return {};
  }
}

function write(map: RestoreIdMap): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Private-mode quota failures are survivable: the leave still works, it
    // just is not replay-safe across a reload.
  }
}

/**
 * The restore id for this portfolio's in-flight leave, minted on first use and
 * stable across retries until {@link clearRestoreId}.
 */
export function restoreIdFor(portfolioId: string, mint: () => string = uuidv7): string {
  const map = read();
  const existing = map[portfolioId];
  if (existing != null) return existing;
  const minted = mint();
  write({ ...map, [portfolioId]: minted });
  return minted;
}

/** Drop the id once the server has acknowledged the leave. */
export function clearRestoreId(portfolioId: string): void {
  const map = read();
  if (!(portfolioId in map)) return;
  const { [portfolioId]: _removed, ...rest } = map;
  write(rest);
}

/** Every portfolio with an unacknowledged leave; used to surface a retry. */
export function pendingRestoreIds(): RestoreIdMap {
  return read();
}
