import type { AssetRef, EarningsEvent } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { MarketIntelRepository } from '../../data/repositories/marketIntelRepository';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { NotificationCenter } from '../notifications/notificationCenter';

/**
 * The earnings-reminder scan (PROJECTPLAN.md §13.5 V5-P5 arc b). A scheduled
 * job runs {@link runEarningsReminderScan} daily: it sweeps every user's held +
 * watched assets, reads each distinct asset's next earnings date **once**
 * through the cached §5.3 provider keystone, and — for those whose report falls
 * inside the reminder lead window — emits `earnings.reminder` through the
 * notification center onto the DURABLE `notifications.dispatch` queue (#368).
 *
 * The type is opt-in (default OFF on every channel); a recipient who never
 * enabled it simply has the delivery gated at the matrix. Firing is idempotent
 * per (user, asset, report date): a per-key Redis `SET NX` lock (TTL far longer
 * than the lead window, and the same (asset, date) never recurs — the next
 * report is a different date) keeps a daily re-scan across the multi-day window
 * from re-emitting, and the dispatcher's eventKey folds the same tuple as a
 * durable backstop. The lock is released when the enqueue itself fails, so a
 * Redis/queue hiccup can only re-attempt next scan, never strand a reminder.
 *
 * Gate-respecting: when `MARKET_INTEL_ENABLED` is off the scan is a no-op — no
 * reminders exist when the arc is unconfigured (invisible when unconfigured).
 */

/** How far ahead of a report the reminder fires (days). */
export const EARNINGS_REMINDER_LEAD_DAYS = 3;
/** The lead window in milliseconds. */
export const EARNINGS_REMINDER_LEAD_MS = EARNINGS_REMINDER_LEAD_DAYS * 86_400_000;

/**
 * TTL of the per-(user, asset, date) idempotency lock. Well beyond the lead
 * window so a daily re-scan never re-fires within it; the same (asset, date)
 * tuple never recurs (a later report has a different date → a fresh key), so a
 * long TTL costs nothing.
 */
export const EARNINGS_REMINDER_LOCK_TTL_SECONDS = 45 * 24 * 60 * 60;

/** Redis idempotency key for one (user, asset, report date). */
export function earningsReminderLockKey(userId: string, assetId: string, dateKey: string): string {
  return `earnings:reminded:${userId}:${assetId}:${dateKey}`;
}

export interface EarningsReminderScanDeps {
  intelRepo: Pick<MarketIntelRepository, 'listAllWatchAndHoldAssets'>;
  marketData: Pick<MarketDataService, 'intelCapabilities' | 'getEarningsEvents'>;
  redis: Redis;
  /** The central notification pipeline (#368) — reminders enter the durable queue here. */
  notify: NotificationCenter;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ the scan is a no-op. */
  enabled: boolean;
  logger?: Logger;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface EarningsReminderScanResult {
  /** Held/watched asset rows considered this run. */
  scanned: number;
  /** Reminders newly emitted this run (deduped by the per-key lock). */
  reminded: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sweep every user's held + watched assets and emit a reminder for each whose
 * next earnings report falls inside the lead window and has not already been
 * reminded (per-key lock). One earnings read per distinct asset, regardless of
 * how many users hold/watch it.
 */
export async function runEarningsReminderScan(
  deps: EarningsReminderScanDeps,
): Promise<EarningsReminderScanResult> {
  const { intelRepo, marketData, redis, notify, enabled, logger } = deps;
  const now = deps.now ? deps.now() : Date.now();

  if (!enabled) return { scanned: 0, reminded: 0 };

  const inScope = await intelRepo.listAllWatchAndHoldAssets();
  if (inScope.length === 0) return { scanned: 0, reminded: 0 };

  // The next earnings report per distinct asset, fetched once and reused across
  // every user who holds/watches it. `undefined` = not yet resolved.
  const nextByAsset = new Map<string, EarningsEvent | null>();
  const occurredAt = new Date(now).toISOString();
  let reminded = 0;

  for (const a of inScope) {
    let next = nextByAsset.get(a.assetId);
    if (next === undefined) {
      next = null;
      const ref: AssetRef = { providerId: a.providerId, providerRef: a.providerRef };
      if (marketData.intelCapabilities(ref).earnings) {
        try {
          const { value } = await marketData.getEarningsEvents(ref);
          next = value.next ?? null;
        } catch (err) {
          logger?.warn(
            { assetId: a.assetId, providerRef: a.providerRef, err: errorMessage(err) },
            'earnings.remind: earnings fetch failed, skipping asset',
          );
          next = null;
        }
      }
      nextByAsset.set(a.assetId, next);
    }

    if (!next || !next.date) continue;
    const dueMs = Date.parse(next.date);
    if (Number.isNaN(dueMs)) continue;
    // Only upcoming reports within the lead window; a past date is never a
    // reminder (the ahead-of-time fires already landed on earlier scan days).
    if (dueMs < now || dueMs - now > EARNINGS_REMINDER_LEAD_MS) continue;

    const dateKey = next.date.slice(0, 10);
    const lockKey = earningsReminderLockKey(a.userId, a.assetId, dateKey);
    const acquired = await redis.set(lockKey, '1', 'EX', EARNINGS_REMINDER_LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') continue;

    const emitted = await notify.emit({
      type: 'earnings.reminder',
      userId: a.userId,
      assetId: a.assetId,
      symbol: a.symbol,
      name: a.name,
      earningsDate: next.date,
      estimated: next.estimated,
      occurredAt,
    });
    if (!emitted) {
      // Enqueue failed (the center logged it): release the lock so the next
      // scan retries — a hiccup delays, never drops (the #367 rule).
      await redis.del(lockKey);
      continue;
    }
    reminded += 1;
  }

  return { scanned: inScope.length, reminded };
}
