import type { AssetRef, DividendEvents } from '@bettertrack/contracts';

import type { MarketIntelRepository } from '../../data/repositories/marketIntelRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { DividendEventNotice } from '../../events';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { NotificationCenter } from '../../services/notifications/notificationCenter';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `marketIntel.dividendScan` — the daily scan behind the opt-in **dividend
 * event** notification (§13.5 V5-P5, arc a). It sweeps every held asset across
 * all users, fetches its dividend events through the cached provider keystone
 * once per asset, and emits a `dividend.event` for each holder whose upcoming
 * ex-date falls within {@link DIVIDEND_EVENT_HORIZON_DAYS}.
 *
 * Idempotency key: `(recipient_user_id, asset_id, ex_date)`. Two layers keep it
 * exactly once for that key:
 *  1. it only emits for a holder who actually **opted in** (the type is off by
 *     default; a holder with every channel off is skipped so no dedupe marker is
 *     written that would later mask an enable), and
 *  2. the dispatcher dedupes on the `(recipient, asset, ex-date)` event key, so
 *     re-seeing the same upcoming event on the next day's run no-ops.
 *
 * Everything degrades gracefully: the gate off ⇒ nothing runs; a provider error
 * for one asset is skipped, never aborting the sweep.
 */

export const DIVIDEND_SCAN_SCHEDULER_ID = 'marketIntel.dividendScan';
/** Daily, after the morning price refresh, in the deploy timezone. */
export const DIVIDEND_SCAN_CRON = '30 6 * * *';
export const DIVIDEND_SCAN_TZ = 'Europe/Vienna';
/** How far ahead an ex-date must be to fire the reminder. */
export const DIVIDEND_EVENT_HORIZON_DAYS = 7;

/** Whether the `dividend.event` type is enabled on ANY channel for a user. */
export type DividendNotifyGate = (userId: string) => Promise<boolean>;

export interface DividendEventsScanDeps {
  repo: Pick<MarketIntelRepository, 'listNormalUserIds' | 'listHeldAssetHoldersForUser'>;
  marketData: Pick<MarketDataService, 'intelCapabilities' | 'getDividendEvents'>;
  notify: NotificationCenter;
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
  /** `dividend.event` emits enqueued (before the dispatcher's own dedupe). */
  emitted: number;
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
  const { repo, marketData, notify, isEnabled, enabled, logger } = deps;
  if (!enabled) return { assetsScanned: 0, emitted: 0 };
  const now = deps.now ?? Date.now;
  const horizonDays = deps.horizonDays ?? DIVIDEND_EVENT_HORIZON_DAYS;

  const nowMs = now();
  const todayStart = new Date(nowMs).toISOString().slice(0, 10);
  const horizonEnd = new Date(nowMs + horizonDays * 86_400_000).toISOString().slice(0, 10);

  const eventsByAsset = new Map<string, DividendEvents | null>();
  const scannedAssetIds = new Set<string>();
  let emitted = 0;
  const occurredAt = new Date(nowMs).toISOString();

  // Candidate discovery reads only account metadata. For each account, the
  // registry guard wins/loses against paranoid enable before ANY holding
  // aggregation, and stays held through provider fetches and notifications.
  for (const userId of await repo.listNormalUserIds()) {
    await deps.runIfAllowed(userId, async () => {
      // Opt-in gate: skip a holder who never enabled the type — the dispatcher
      // would otherwise write a hidden dedupe marker that later masks an enable.
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
          try {
            events = (await marketData.getDividendEvents(ref)).value;
            eventsByAsset.set(row.assetId, events);
            scannedAssetIds.add(row.assetId);
          } catch (err) {
            logger?.warn(
              { err, assetId: row.assetId },
              'dividend scan: provider fetch failed; skipping asset',
            );
            eventsByAsset.set(row.assetId, null);
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
          await notify.emit(notice);
          emitted += 1;
        }
      }
    });
  }

  return { assetsScanned: scannedAssetIds.size, emitted };
}

export type DividendEventsJobDeps = Omit<DividendEventsScanDeps, 'now' | 'logger'>;

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
      const result = await runDividendEventsScan({ ...deps, now: () => now, logger: ctx.logger });
      ctx.logger.info(
        { assetsScanned: result.assetsScanned, emitted: result.emitted },
        'marketIntel.dividendScan complete',
      );
    },
  };
}
