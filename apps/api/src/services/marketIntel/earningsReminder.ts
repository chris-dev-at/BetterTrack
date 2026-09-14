import type { AssetRef, EarningsEvent } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { MarketIntelRepository } from '../../data/repositories/marketIntelRepository';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { NotificationCenter } from '../notifications/notificationCenter';

import { claimReminderMarker } from './reminderMarker';

/**
 * The earnings-reminder scan (PROJECTPLAN.md §13.5 V5-P5 arc b). A scheduled
 * job runs {@link runEarningsReminderScan} daily: it sweeps every user's held +
 * watched assets, reads each distinct asset's next earnings date **once**
 * through the cached §5.3 provider keystone, and — for those whose report falls
 * inside the reminder lead window — emits `earnings.reminder` through the
 * notification center onto the DURABLE `notifications.dispatch` queue (#368).
 *
 * The type is opt-in (default OFF on every channel), and the opt-in is checked
 * HERE, before any side effect AND before any provider read: gating only at the
 * delivery matrix would still let the dispatcher write its hidden dedupe marker
 * (the inbox row doubles as that marker) and let this scan take its 45-day lock,
 * so a recipient who enabled the type a day later would silently receive nothing
 * for that report — and gating after the earnings fetch (the shape until #1827)
 * spent one upstream `quoteSummary` per distinct held/watched asset every day on
 * a deployment where nobody enabled the type at all. Same rule, same order, same
 * reason as the sibling dividend scan.
 *
 * Firing is idempotent per (user, asset, REPORT) — not per date. Yahoo's
 * `earningsDate` is an estimated window until the company confirms it, so the
 * date a scan sees can move by a day or two inside the lead window; keying only
 * on the date sent a second reminder for the same report when the estimate
 * firmed up (#1758). Both guards — the per-(user, asset) REPORT ANCHOR holding
 * the date already reminded for ({@link EARNINGS_REPORT_MATCH_DAYS} decides
 * "same report under a corrected date": SILENT, no "date changed" follow-up) and
 * the per-(user, asset, date) `SET NX` lock that makes the claim atomic between
 * concurrent scans — live in {@link claimReminderMarker}, which also fixes their
 * ORDER: both are written before the emit, so a crash between the enqueue ack
 * and the anchor write can no longer leave a lock without its anchor and let a
 * firmed-up date produce a second reminder. Only a REFUSED enqueue rolls the
 * claim back, so a queue hiccup re-attempts on the next scan.
 *
 * Nothing in the sweep is fatal to the sweep: a row that throws is isolated and
 * counted, a user whose pass throws does not abandon the users after them, and
 * the result carries a `skipped` total so a partially-failed run can never be
 * logged as complete.
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

/**
 * How many times one asset's earnings read may be attempted in a single run. A
 * provider failure is deliberately NOT cached as "skip this asset for the rest
 * of the run" — that let a rate-limit blip at the first holder silently cost
 * every later holder/watcher of the same asset their reminder. The next row
 * re-attempts instead; the cap keeps a genuine outage from turning into one call
 * per row. Mirrors `DIVIDEND_PROVIDER_ATTEMPTS_PER_ASSET` in the sibling scan.
 */
export const EARNINGS_PROVIDER_ATTEMPTS_PER_ASSET = 3;

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
  /** Reminders newly emitted this run (deduped by the durable marker). */
  reminded: number;
  /** Candidates the durable marker says were already reminded — a clean no-op. */
  suppressed: number;
  /** Candidates not reminded: the enqueue was refused, or the marker store was
   *  unreachable. Both retry on the next scan. */
  failed: number;
  /** Rows abandoned by a throw (repository, Redis, transport) — isolated. */
  errored: number;
  /** Rows skipped because their asset's provider read failed on this row (or its
   *  attempt budget was already spent). A later row re-attempts the asset. */
  rowsSkipped: number;
  /** Distinct assets still unresolved when the run ended. */
  assetsFailed: number;
  /** Users whose pass threw; the users after them still ran. */
  usersFailed: number;
  /** Users the paranoid transition guard deferred (`runIfAllowed` said no). */
  usersDeferred: number;
  /** Everything the run did NOT do: `rowsSkipped + failed + errored +
   *  usersFailed + usersDeferred`. Counted per ROW (not per unresolved asset,
   *  which `assetsFailed` reports separately) so a blip that a later row
   *  re-attempted successfully still shows up as the reminder it cost.
   *  Non-zero ⇒ the run is not complete. */
  skipped: number;
  /** `skipped > 0` — a run that must never be logged as clean. */
  degraded: boolean;
}

/** The all-zero result: the gated-off no-op, and the counter seed. */
function emptyResult(): EarningsReminderScanResult {
  return {
    scanned: 0,
    reminded: 0,
    suppressed: 0,
    failed: 0,
    errored: 0,
    rowsSkipped: 0,
    assetsFailed: 0,
    usersFailed: 0,
    usersDeferred: 0,
    skipped: 0,
    degraded: false,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sweep every user's held + watched assets and emit a reminder for each whose
 * next earnings report falls inside the lead window and has not already been
 * reminded (per-key lock). One earnings read per distinct asset, regardless of
 * how many users hold/watch it — and none at all for an asset whose every
 * holder/watcher is opted out. A read that FAILS is re-attempted by the next row
 * for that asset, up to {@link EARNINGS_PROVIDER_ATTEMPTS_PER_ASSET}.
 */
export async function runEarningsReminderScan(
  deps: EarningsReminderScanDeps,
): Promise<EarningsReminderScanResult> {
  const { intelRepo, marketData, redis, notify, isEnabled, enabled, logger } = deps;
  const now = deps.now ? deps.now() : Date.now();

  if (!enabled) return emptyResult();

  // The next earnings report per distinct asset, fetched once and reused across
  // every user who holds/watches it. `undefined` = not yet resolved.
  const nextByAsset = new Map<string, EarningsEvent | null>();
  /** Failed provider attempts per asset, bounded by the per-asset budget. */
  const attemptsByAsset = new Map<string, number>();
  const occurredAt = new Date(now).toISOString();
  const processed = new Set<string>();
  const unresolvedAssets = new Set<string>();
  let reminded = 0;
  let suppressed = 0;
  let failed = 0;
  let errored = 0;
  let rowsSkipped = 0;
  let usersFailed = 0;
  let usersDeferred = 0;

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

    // Opt-in gate FIRST — before the provider read, not after it. A recipient
    // who never enabled the type gets no reminder whatever the report says, so
    // reading the asset for them is a daily upstream call with nowhere to go
    // (the read is uncached at the daily cadence: EARNINGS_TTL_SECONDS is 6 h).
    // It is also the gate that must precede every side effect — see below.
    if (!(await optedIn(a.userId))) return;

    let next = nextByAsset.get(a.assetId);
    if (next === undefined) {
      const ref: AssetRef = { providerId: a.providerId, providerRef: a.providerRef };
      if (!marketData.intelCapabilities(ref).earnings) {
        // A permanent, expected answer for this run — not a failure.
        nextByAsset.set(a.assetId, null);
        return;
      }
      const attempts = attemptsByAsset.get(a.assetId) ?? 0;
      if (attempts >= EARNINGS_PROVIDER_ATTEMPTS_PER_ASSET) {
        // The attempt budget for this asset is spent; every further row is a
        // RECORDED skip, so the run reports degraded instead of under-counting.
        rowsSkipped += 1;
        return;
      }
      try {
        const { value } = await marketData.getEarningsEvents(ref);
        next = value.next ?? null;
        nextByAsset.set(a.assetId, next);
        unresolvedAssets.delete(a.assetId);
      } catch (err) {
        // NOT cached as null: the next row for this asset re-attempts (up to the
        // budget above), so one recipient taking a rate-limit does not cost
        // every other holder/watcher of it their reminder for the day.
        attemptsByAsset.set(a.assetId, attempts + 1);
        unresolvedAssets.add(a.assetId);
        rowsSkipped += 1;
        logger?.warn(
          {
            assetId: a.assetId,
            providerRef: a.providerRef,
            attempt: attempts + 1,
            err: errorMessage(err),
          },
          'earnings.remind: earnings fetch failed; row skipped, asset re-attempted for the next row',
        );
        return;
      }
    }

    if (!next || !next.date) return;
    if (Number.isNaN(Date.parse(next.date))) return;
    const dateKey = next.date.slice(0, 10);
    // Only reports on a day inside the lead window; a day already behind us is
    // never a reminder (the ahead-of-time fires landed on earlier scan days).
    if (dateKey < todayKey || dateKey > horizonKey) return;

    // Claim the report BEFORE emitting: same report under a corrected date ⇒
    // already reminded, stay silent; and no crash window can leave the per-date
    // lock without its anchor. Reached only past the opt-in gate at the top of
    // this row — a recipient who never enabled the type must leave no trace at
    // all this run: neither the 45-day lock nor the dispatcher's hidden dedupe
    // row, both of which would mask a later enable for this (asset, date).
    const claim = await claimReminderMarker({
      redis,
      lockKey: earningsReminderLockKey(a.userId, a.assetId, dateKey),
      anchorKey: earningsReminderReportKey(a.userId, a.assetId),
      dateKey,
      matchDays: EARNINGS_REPORT_MATCH_DAYS,
      ttlSeconds: EARNINGS_REMINDER_LOCK_TTL_SECONDS,
    });
    if (claim.status === 'duplicate') {
      suppressed += 1;
      return;
    }
    if (claim.status === 'unavailable') {
      failed += 1;
      logger?.warn(
        { userId: a.userId, assetId: a.assetId, dateKey, err: errorMessage(claim.err) },
        'earnings.remind: idempotency marker unavailable, skipping row',
      );
      return;
    }

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
      // Enqueue REFUSED (the center logged it, and never throws): roll the claim
      // back so the next scan retries — a hiccup delays, never drops (the #367
      // rule). A THROW here is a different animal: the enqueue may well have
      // acked, so the claim deliberately stands and the row is counted as
      // errored rather than re-armed.
      await claim.release();
      failed += 1;
      return;
    }
    reminded += 1;
  };

  /**
   * Per-ROW isolation. Only the provider call used to be guarded, so a Redis or
   * transport hiccup on row *k* abandoned rows *k+1…n* — and for a 3-day
   * sustained failure nothing recorded the gap. A row that throws is counted and
   * the sweep continues; its claim (if any) stands, so the residue is a skipped
   * reminder, never a duplicated one.
   */
  const processRow = async (row: Parameters<typeof processAsset>[0]) => {
    try {
      await processAsset(row);
    } catch (err) {
      errored += 1;
      logger?.warn(
        { userId: row.userId, assetId: row.assetId, err: errorMessage(err) },
        'earnings.remind: row failed, continuing the sweep',
      );
    }
  };

  // GLOBAL watchlist provenance is kept in paranoid mode. This query never
  // joins portfolios/transactions and never selects an account-owned (custom)
  // asset row, so these rows and their provider work are safe without an
  // account-mode guard.
  for (const watched of await intelRepo.listAllWatchAssets()) {
    await processRow(watched);
  }

  // Discover accounts from account metadata only. Every holding aggregation —
  // and every account-owned custom watchlist row, which the global pass above
  // deliberately skipped — then happens inside that user's transition lock, and
  // the lock stays held through provider work plus enqueue. If enable won, no
  // transaction or custom-asset query is issued for that account at all. The
  // `processed` set makes the global rows this returns a no-op second time.
  for (const userId of await intelRepo.listNormalUserIds()) {
    try {
      const allowed = await deps.runIfAllowed(userId, async () => {
        for (const asset of await intelRepo.listUserWatchAndHoldAssets(userId)) {
          await processRow({ ...asset, userId });
        }
      });
      // The transition guard won: this user's book was not read at all. That is
      // a legitimate outcome, but it is not "nothing to do" — count it, so the
      // run reports as degraded rather than complete.
      if (!allowed) usersDeferred += 1;
    } catch (err) {
      usersFailed += 1;
      logger?.warn(
        { userId, err: errorMessage(err) },
        'earnings.remind: user pass failed, continuing the sweep',
      );
    }
  }

  const skipped = rowsSkipped + failed + errored + usersFailed + usersDeferred;
  return {
    scanned: processed.size,
    reminded,
    suppressed,
    failed,
    errored,
    rowsSkipped,
    assetsFailed: unresolvedAssets.size,
    usersFailed,
    usersDeferred,
    skipped,
    degraded: skipped > 0,
  };
}
