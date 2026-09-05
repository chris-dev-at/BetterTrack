import type { AssetRef, DividendEvents } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { MarketIntelRepository } from '../../data/repositories/marketIntelRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { DividendEventNotice } from '../../events';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import { claimReminderMarker } from '../../services/marketIntel/reminderMarker';
import type { NotificationCenter } from '../../services/notifications/notificationCenter';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `marketIntel.dividendScan` — the daily scan behind the opt-in **dividend
 * event** notification (§13.5 V5-P5, arc a). It sweeps every held asset across
 * all users, fetches its dividend events through the cached provider keystone
 * once per asset, and emits a `dividend.event` for each holder whose upcoming
 * ex-date falls within {@link DIVIDEND_EVENT_HORIZON_DAYS}.
 *
 * Idempotency key: `(recipient_user_id, asset_id, ex_date)`. Three layers keep
 * it exactly once for that key:
 *  1. it only emits for a holder who actually **opted in** (the type is off by
 *     default; a holder with every channel off is skipped so no dedupe marker is
 *     written that would later mask an enable),
 *  2. the scan's OWN durable marker ({@link claimReminderMarker}) — a per-date
 *     `SET NX` claim plus a per-(holder, asset) anchor, both written before the
 *     emit. This is the guard that actually holds: the dispatcher's dedupe
 *     marker IS the inbox row, and a visible inbox row is hard-deletable by its
 *     owner, so a holder who read and cleared the notification used to be
 *     re-notified on EVERY remaining day of the horizon, on every channel, and
 *  3. the dispatcher's own `(recipient, event key)` dedupe behind it.
 *
 * Everything degrades gracefully but never silently: the gate off ⇒ nothing
 * runs; a provider error on one asset skips that holder and is re-attempted for
 * the next holder of the same asset (bounded by
 * {@link DIVIDEND_PROVIDER_ATTEMPTS_PER_ASSET}) rather than writing the asset off
 * for the whole run; a row or a user that throws is isolated; and every skip is
 * counted into `skipped`, so a partially-failed run cannot log as complete.
 */

export const DIVIDEND_SCAN_SCHEDULER_ID = 'marketIntel.dividendScan';
/** Daily, after the morning price refresh, in the deploy timezone. */
export const DIVIDEND_SCAN_CRON = '30 6 * * *';
export const DIVIDEND_SCAN_TZ = 'Europe/Vienna';
/** How far ahead an ex-date must be to fire the reminder. */
export const DIVIDEND_EVENT_HORIZON_DAYS = 7;

/**
 * TTL of both durable marker keys. Far beyond the horizon, so a daily re-scan
 * never re-fires inside it; the same (holder, asset, ex-date) tuple never
 * recurs, so a long TTL costs nothing.
 */
export const DIVIDEND_EVENT_MARKER_TTL_SECONDS = 45 * 24 * 60 * 60;

/**
 * How far an ex-date may move and still be the SAME payout. Sized between the
 * two things it must separate: a provider amending an announced ex-date moves it
 * by a day or two, while the tightest real payout cadence is a monthly
 * distributor at ~28 days. A week sits clear of both, so an amended date is
 * never a second notification and a genuine next payout is never swallowed.
 * (Matches the ruling #1758 made for earnings: exactly one notification per
 * event, with no "date changed" follow-up.)
 */
export const DIVIDEND_EVENT_MATCH_DAYS = 7;

/**
 * How many times one asset's dividend read may be attempted in a single run. A
 * provider failure is deliberately NOT cached as "skip this asset for the rest
 * of the run" — that let a rate-limit blip at the first holder silently cost
 * every later holder of the same asset their notice. The next holder re-attempts
 * instead; the cap keeps a genuine outage from turning into one call per holder.
 */
export const DIVIDEND_PROVIDER_ATTEMPTS_PER_ASSET = 3;

/** Redis key of the per-(holder, asset, ex-date) `SET NX` claim. */
export function dividendEventLockKey(userId: string, assetId: string, exDateKey: string): string {
  return `dividend:notified:${userId}:${assetId}:${exDateKey}`;
}

/**
 * Redis key of the per-(holder, asset) anchor: the ex-date this holder was last
 * notified about, so a date the provider merely amended is recognised as the
 * same payout. Distinct namespace from the per-date claim above.
 */
export function dividendEventAnchorKey(userId: string, assetId: string): string {
  return `dividend:event:${userId}:${assetId}`;
}

/** Whether the `dividend.event` type is enabled on ANY channel for a user. */
export type DividendNotifyGate = (userId: string) => Promise<boolean>;

export interface DividendEventsScanDeps {
  repo: Pick<MarketIntelRepository, 'listNormalUserIds' | 'listHeldAssetHoldersForUser'>;
  marketData: Pick<MarketDataService, 'intelCapabilities' | 'getDividendEvents'>;
  notify: NotificationCenter;
  /** The durable idempotency store behind the notify-once marker. */
  redis: Redis;
  /** Per-user opt-in gate (skip a holder who never enabled the type). */
  isEnabled: DividendNotifyGate;
  /** Lock before holding aggregation and hold through provider work + emit. */
  runIfAllowed: (userId: string, action: () => Promise<void>) => Promise<boolean>;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ the scan is a no-op. */
  enabled: boolean;
  horizonDays?: number;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
  logger?: Logger;
}

export interface DividendScanResult {
  /** Distinct assets whose events were fetched. */
  assetsScanned: number;
  /**
   * Due ex-dates considered for an opted-in holder. Decomposes EXACTLY:
   * `candidates === emitted + suppressed + failed + errored`.
   */
  candidates: number;
  /** `dividend.event` emits the durable transport accepted. */
  emitted: number;
  /** Candidates the durable marker says were already notified — a clean no-op. */
  suppressed: number;
  /** Candidates not notified: the enqueue was REFUSED (`emit` returned false), or
   *  the marker store was unreachable. Both retry on the next scan. */
  failed: number;
  /** Candidates abandoned by a throw — isolated, state unknown, no retry. */
  errored: number;
  /** Holder rows skipped because their asset's provider read failed this run. */
  holdersSkipped: number;
  /** Distinct assets still unresolved when the run ended. */
  assetsFailed: number;
  /** Users whose pass threw; the users after them still ran. */
  usersFailed: number;
  /** Users the paranoid transition guard deferred (`runIfAllowed` said no). */
  usersDeferred: number;
  /** Everything the run did NOT do: `holdersSkipped + failed + errored +
   *  usersFailed + usersDeferred`. Non-zero ⇒ the run is not complete. */
  skipped: number;
  /** `skipped > 0` — a run that must never be logged as clean. */
  degraded: boolean;
}

/** The all-zero result: the gated-off no-op, and the counter seed. */
function emptyResult(): DividendScanResult {
  return {
    assetsScanned: 0,
    candidates: 0,
    emitted: 0,
    suppressed: 0,
    failed: 0,
    errored: 0,
    holdersSkipped: 0,
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
 * Build a per-user opt-in gate from the notification repository: enabled iff the
 * `dividend.event` type routes to at least one channel.
 */
export function dividendNotifyGate(
  repo: Pick<NotificationRepository, 'routingFor'>,
): DividendNotifyGate {
  return async (userId: string) => {
    const routing = await repo.routingFor(userId, 'dividend.event');
    return (
      routing.inapp ||
      routing.email ||
      routing.push ||
      routing.webpush ||
      routing.telegram ||
      routing.discord
    );
  };
}

/**
 * The pure scan core (mirrors `runAlertsEvaluation`): testable in isolation with
 * a mocked clock, a stub provider and a recording notification center.
 */
export async function runDividendEventsScan(
  deps: DividendEventsScanDeps,
): Promise<DividendScanResult> {
  const { repo, marketData, notify, redis, isEnabled, enabled, logger } = deps;
  if (!enabled) return emptyResult();
  const now = deps.now ?? Date.now;
  const horizonDays = deps.horizonDays ?? DIVIDEND_EVENT_HORIZON_DAYS;

  const nowMs = now();
  const todayStart = new Date(nowMs).toISOString().slice(0, 10);
  const horizonEnd = new Date(nowMs + horizonDays * 86_400_000).toISOString().slice(0, 10);

  // Resolved dividend events per distinct asset; `null` = the provider cannot
  // serve dividends for it (a permanent, expected answer for this run — NOT a
  // failure, which is tracked separately so it can be re-attempted).
  const eventsByAsset = new Map<string, DividendEvents | null>();
  const attemptsByAsset = new Map<string, number>();
  const unresolvedAssets = new Set<string>();
  const scannedAssetIds = new Set<string>();
  let candidates = 0;
  let emitted = 0;
  let suppressed = 0;
  let failed = 0;
  let errored = 0;
  let holdersSkipped = 0;
  let usersFailed = 0;
  let usersDeferred = 0;
  const occurredAt = new Date(nowMs).toISOString();

  // Candidate discovery reads only account metadata. For each account, the
  // registry guard wins/loses against paranoid enable before ANY holding
  // aggregation, and stays held through provider fetches and notifications.
  for (const userId of await repo.listNormalUserIds()) {
    try {
      const allowed = await deps.runIfAllowed(userId, async () => {
        // Opt-in gate: skip a holder who never enabled the type — the marker and
        // the dispatcher's hidden dedupe row would otherwise mask a later enable.
        if (!(await isEnabled(userId))) return;
        const holdings = await repo.listHeldAssetHoldersForUser(userId);
        for (const row of holdings) {
          let events = eventsByAsset.get(row.assetId);
          if (events === undefined) {
            const ref: AssetRef = { providerId: row.providerId, providerRef: row.providerRef };
            if (!marketData.intelCapabilities(ref).dividends) {
              eventsByAsset.set(row.assetId, null);
              continue;
            }
            const attempts = attemptsByAsset.get(row.assetId) ?? 0;
            if (attempts >= DIVIDEND_PROVIDER_ATTEMPTS_PER_ASSET) {
              // The attempt budget for this asset is spent; every further holder
              // is a RECORDED skip, so the run reports degraded instead of
              // quietly under-counting.
              holdersSkipped += 1;
              continue;
            }
            try {
              events = (await marketData.getDividendEvents(ref)).value;
              eventsByAsset.set(row.assetId, events);
              scannedAssetIds.add(row.assetId);
              unresolvedAssets.delete(row.assetId);
            } catch (err) {
              // NOT cached as null: the next holder of this asset re-attempts
              // (up to the budget above), so one holder taking a rate-limit does
              // not cost every other holder their notice for the day.
              attemptsByAsset.set(row.assetId, attempts + 1);
              unresolvedAssets.add(row.assetId);
              holdersSkipped += 1;
              logger?.warn(
                { err: errorMessage(err), assetId: row.assetId, userId, attempt: attempts + 1 },
                'dividend scan: provider fetch failed; holder skipped, asset re-attempted for the next holder',
              );
              continue;
            }
          }
          if (!events) continue;

          // Upcoming events whose ex-date is inside the reminder horizon.
          const dueEvents = events.upcoming.filter((event) => {
            if (!event.exDate) return false;
            const day = event.exDate.slice(0, 10);
            return day >= todayStart && day <= horizonEnd;
          });
          for (const event of dueEvents) {
            candidates += 1;
            try {
              const exDateKey = event.exDate!.slice(0, 10);
              // The scan's own durable guard: independent of the deletable inbox
              // row, and claimed BEFORE the emit so a crash cannot re-arm it.
              const claim = await claimReminderMarker({
                redis,
                lockKey: dividendEventLockKey(userId, row.assetId, exDateKey),
                anchorKey: dividendEventAnchorKey(userId, row.assetId),
                dateKey: exDateKey,
                matchDays: DIVIDEND_EVENT_MATCH_DAYS,
                ttlSeconds: DIVIDEND_EVENT_MARKER_TTL_SECONDS,
              });
              if (claim.status === 'duplicate') {
                suppressed += 1;
                continue;
              }
              if (claim.status === 'unavailable') {
                failed += 1;
                logger?.warn(
                  {
                    err: errorMessage(claim.err),
                    userId,
                    assetId: row.assetId,
                    exDate: exDateKey,
                  },
                  'dividend scan: idempotency marker unavailable; retrying next scan',
                );
                continue;
              }

              const notice: DividendEventNotice = {
                type: 'dividend.event',
                userId,
                assetId: row.assetId,
                symbol: row.symbol,
                exDate: event.exDate!,
                payDate: event.payDate,
                amount: event.amount,
                currency: event.currency ?? events.currency,
                occurredAt,
              };
              if (await notify.emit(notice)) {
                emitted += 1;
                continue;
              }
              // Enqueue REFUSED (the center logged it, and never throws): roll
              // the claim back so the next scan retries, and never count it as
              // sent. A THROW is a different animal — the enqueue may have
              // acked, so the claim stands and the candidate is `errored`.
              await claim.release();
              failed += 1;
            } catch (err) {
              errored += 1;
              logger?.warn(
                { err: errorMessage(err), userId, assetId: row.assetId },
                'dividend scan: candidate failed, continuing the sweep',
              );
            }
          }
        }
      });
      // The transition guard won: this user's book was not read at all. A
      // legitimate outcome, but not "nothing to do" — count it so the run
      // reports degraded rather than complete.
      if (!allowed) usersDeferred += 1;
    } catch (err) {
      // Per-user isolation: a repository or Redis throw at user k must not
      // abandon users k+1…n (BullMQ's retry would restart the whole book).
      usersFailed += 1;
      logger?.warn(
        { err: errorMessage(err), userId },
        'dividend scan: user pass failed, continuing the sweep',
      );
    }
  }

  const skipped = holdersSkipped + failed + errored + usersFailed + usersDeferred;
  return {
    assetsScanned: scannedAssetIds.size,
    candidates,
    emitted,
    suppressed,
    failed,
    errored,
    holdersSkipped,
    assetsFailed: unresolvedAssets.size,
    usersFailed,
    usersDeferred,
    skipped,
    degraded: skipped > 0,
  };
}

/** The Redis idempotency store comes from the {@link JobContext}, as it does for
 *  the sibling earnings scan. */
export type DividendEventsJobDeps = Omit<DividendEventsScanDeps, 'now' | 'logger' | 'redis'>;

export function createDividendEventsScanJob(
  deps: DividendEventsJobDeps,
): JobDefinition<'marketIntel.dividendScan'> {
  return {
    name: QUEUE_NAMES.marketIntelDividendScan,
    schedule: {
      id: DIVIDEND_SCAN_SCHEDULER_ID,
      pattern: DIVIDEND_SCAN_CRON,
      tz: DIVIDEND_SCAN_TZ,
    },
    async handler(job, ctx) {
      // The REAL execution instant — see earningsReminderJob: the creation
      // `timestamp` is the previous iteration's pickup, so `todayStart` would
      // resolve to yesterday and the horizon end would fall a day short.
      const now = job.processedOn ?? Date.now();
      const result = await runDividendEventsScan({
        ...deps,
        redis: ctx.redis,
        now: () => now,
        logger: ctx.logger,
      });
      // A run that skipped anything is NOT complete: it logs as degraded, at
      // warn, naming the skipped total and its decomposition.
      const { degraded, ...counts } = result;
      if (degraded) {
        ctx.logger.warn(counts, 'marketIntel.dividendScan completed with skips');
      } else {
        ctx.logger.info(counts, 'marketIntel.dividendScan complete');
      }
    },
  };
}
