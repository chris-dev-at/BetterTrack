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
 * The type is opt-in (default OFF on every channel), and the opt-in is checked
 * HERE, before any side effect: gating only at the delivery matrix would still
 * let the dispatcher write its hidden dedupe marker (the inbox row doubles as
 * that marker) and let this scan take its 45-day lock, so a recipient who
 * enabled the type a day later would silently receive nothing for that report.
 * Same rule, same reason as the sibling dividend scan.
 *
 * Firing is idempotent per (user, asset, REPORT) — not per date. Yahoo's
 * `earningsDate` is an estimated window until the company confirms it, so the
 * date a scan sees can move by a day or two inside the lead window; keying only
 * on the date sent a second reminder for the same report when the estimate
 * firmed up (#1758). Two guards, in order:
 *
 *   1. a per-(user, asset) REPORT ANCHOR holding the date already reminded for.
 *      A candidate within {@link EARNINGS_REPORT_MATCH_DAYS} of the anchor is
 *      the same report under a corrected date, and stays SILENT — the DECISION
 *      is exactly one notification per report, with no "date changed" follow-up:
 *      the reminder is at most three days out, the correction it would announce
 *      is a day or two, and §6.10 contracts one notification per (user, event
 *      key). Genuine consecutive reports are ~90 days apart, far outside the
 *      match window, so a later report is always a fresh anchor.
 *   2. the per-(user, asset, date) `SET NX` lock that has always been here,
 *      which makes the same-date path atomic between concurrent scans and is
 *      backstopped durably by the dispatcher's eventKey (assetId + date).
 *
 * Both TTLs are far longer than the lead window. The lock is released — and the
 * anchor never written — when the enqueue itself fails, so a Redis/queue hiccup
 * can only re-attempt next scan, never strand a reminder.
 *
 * Gate-respecting: when `MARKET_INTEL_ENABLED` is off the scan is a no-op — no
 * reminders exist when the arc is unconfigured (invisible when unconfigured).
 */

/**
 * How far ahead of a report the reminder fires, in CALENDAR days. The window is
 * compared as day strings (like the dividend scan), not as elapsed milliseconds:
 * a fixed-hour daily cron measuring elapsed time gives an after-close reporter
 * (report stamped 20:00) an effective two-day lead, because at the 06:00 scan
 * three days earlier the delta is 3 d 14 h — just outside a 3 × 24 h window.
 */
export const EARNINGS_REMINDER_LEAD_DAYS = 3;
/** The lead window in milliseconds — the offset the horizon day is taken from. */
export const EARNINGS_REMINDER_LEAD_MS = EARNINGS_REMINDER_LEAD_DAYS * 86_400_000;

/**
 * TTL of the per-(user, asset, date) idempotency lock. Well beyond the lead
 * window so a daily re-scan never re-fires within it; the same (asset, date)
 * tuple never recurs (a later report has a different date → a fresh key), so a
 * long TTL costs nothing.
 */
export const EARNINGS_REMINDER_LOCK_TTL_SECONDS = 45 * 24 * 60 * 60;

/**
 * How far an upcoming earnings date may move and still be the SAME report.
 * Sized between the two things it must separate: an estimated date firming up
 * moves by days (Yahoo publishes a window of a few days), while an asset's next
 * report is a full quarter — ~90 days — after this one. Three weeks sits well
 * clear of both, so a corrected date is never a second reminder and a genuine
 * next report is never swallowed.
 */
export const EARNINGS_REPORT_MATCH_DAYS = 21;

/** Redis idempotency key for one (user, asset, report date). */
export function earningsReminderLockKey(userId: string, assetId: string, dateKey: string): string {
  return `earnings:reminded:${userId}:${assetId}:${dateKey}`;
}

/**
 * Redis key of the report ANCHOR for one (user, asset): the report date this
 * recipient was last reminded about, so a date that merely moved is recognised
 * as the same report. Distinct namespace from the per-date lock above.
 */
export function earningsReminderReportKey(userId: string, assetId: string): string {
  return `earnings:report:${userId}:${assetId}`;
}

/** Whole days between two `YYYY-MM-DD` day strings, sign-independent. */
function dayDistance(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00.000Z`);
  const right = Date.parse(`${b}T00:00:00.000Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86_400_000;
}

/** Whether the `earnings.reminder` type is enabled on ANY channel for a user. */
export type EarningsNotifyGate = (userId: string) => Promise<boolean>;

export interface EarningsReminderScanDeps {
  intelRepo: Pick<
    MarketIntelRepository,
    'listAllWatchAssets' | 'listNormalUserIds' | 'listUserWatchAndHoldAssets'
  >;
  marketData: Pick<MarketDataService, 'intelCapabilities' | 'getEarningsEvents'>;
  redis: Redis;
  /** The central notification pipeline (#368) — reminders enter the durable queue here. */
  notify: NotificationCenter;
  /** Per-user opt-in gate (skip a recipient who never enabled the type). */
  isEnabled: EarningsNotifyGate;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ the scan is a no-op. */
  enabled: boolean;
  /**
   * Registry-bound transition lock held before each user's holding aggregation,
   * provider work, and reminder side effects. Returns false when enable won.
   */
  runIfAllowed: (userId: string, action: () => Promise<void>) => Promise<boolean>;
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
  const { intelRepo, marketData, redis, notify, isEnabled, enabled, logger } = deps;
  const now = deps.now ? deps.now() : Date.now();

  if (!enabled) return { scanned: 0, reminded: 0 };

  // The next earnings report per distinct asset, fetched once and reused across
  // every user who holds/watches it. `undefined` = not yet resolved.
  const nextByAsset = new Map<string, EarningsEvent | null>();
  const occurredAt = new Date(now).toISOString();
  const processed = new Set<string>();
  let reminded = 0;

  // Calendar-day window: [today, today + LEAD_DAYS] as day strings. A report is
  // "3 days out" by the date on the calendar, never by 3 × 24 h of elapsed time
  // — see EARNINGS_REMINDER_LEAD_DAYS.
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const horizonKey = new Date(now + EARNINGS_REMINDER_LEAD_MS).toISOString().slice(0, 10);

  // One matrix read per user per run, shared by every row that user holds/watches.
  const gateByUser = new Map<string, Promise<boolean>>();
  const optedIn = (userId: string): Promise<boolean> => {
    let gate = gateByUser.get(userId);
    if (!gate) {
      gate = isEnabled(userId);
      gateByUser.set(userId, gate);
    }
    return gate;
  };

  const processAsset = async (
    a: Awaited<ReturnType<MarketIntelRepository['listAllWatchAssets']>>[number],
  ) => {
    const rowKey = `${a.userId}:${a.assetId}`;
    if (processed.has(rowKey)) return;
    processed.add(rowKey);

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

    if (!next || !next.date) return;
    if (Number.isNaN(Date.parse(next.date))) return;
    const dateKey = next.date.slice(0, 10);
    // Only reports on a day inside the lead window; a day already behind us is
    // never a reminder (the ahead-of-time fires landed on earlier scan days).
    if (dateKey < todayKey || dateKey > horizonKey) return;

    // Opt-in gate, BEFORE the lock and the emit: a recipient who never enabled
    // the type must leave no trace at all this run — neither the 45-day lock nor
    // the dispatcher's hidden dedupe row, both of which would mask a later
    // enable for this same (asset, report date).
    if (!(await optedIn(a.userId))) return;

    // Same report under a corrected date ⇒ already reminded, stay silent. Read
    // AFTER the opt-in gate for the same reason the lock is taken there: a
    // recipient who never enabled the type leaves no state behind at all.
    const reportKey = earningsReminderReportKey(a.userId, a.assetId);
    const anchor = await redis.get(reportKey);
    if (anchor !== null && dayDistance(anchor, dateKey) <= EARNINGS_REPORT_MATCH_DAYS) return;

    const lockKey = earningsReminderLockKey(a.userId, a.assetId, dateKey);
    const acquired = await redis.set(lockKey, '1', 'EX', EARNINGS_REMINDER_LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') return;

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
      return;
    }
    // Anchor this report only once it is genuinely on the queue, so a failed
    // enqueue leaves neither guard set and the next scan retries.
    await redis.set(reportKey, dateKey, 'EX', EARNINGS_REMINDER_LOCK_TTL_SECONDS);
    reminded += 1;
  };

  // GLOBAL watchlist provenance is kept in paranoid mode. This query never
  // joins portfolios/transactions and never selects an account-owned (custom)
  // asset row, so these rows and their provider work are safe without an
  // account-mode guard.
  for (const watched of await intelRepo.listAllWatchAssets()) {
    await processAsset(watched);
  }

  // Discover accounts from account metadata only. Every holding aggregation —
  // and every account-owned custom watchlist row, which the global pass above
  // deliberately skipped — then happens inside that user's transition lock, and
  // the lock stays held through provider work plus enqueue. If enable won, no
  // transaction or custom-asset query is issued for that account at all. The
  // `processed` set makes the global rows this returns a no-op second time.
  for (const userId of await intelRepo.listNormalUserIds()) {
    await deps.runIfAllowed(userId, async () => {
      for (const asset of await intelRepo.listUserWatchAndHoldAssets(userId)) {
        await processAsset({ ...asset, userId });
      }
    });
  }

  return { scanned: processed.size, reminded };
}
