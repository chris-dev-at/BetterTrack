import type { AlertKind, AlertStatus } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { AlertRepository } from '../../data/repositories/alertRepository';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { NotificationCenter } from '../notifications/notificationCenter';

/**
 * The price-alert evaluator (PROJECTPLAN.md §14, V3-P10 arc b). A BullMQ
 * repeatable job runs {@link runAlertsEvaluation} every minute: it loads every
 * active alert, reads each referenced asset's quote **once** through the cached
 * §5.3 market-data core (never a per-alert upstream fan-out), tests the rule,
 * and fires the ones that met their condition.
 *
 * Firing is guarded twice so concurrent or restarted evaluator runs cannot
 * double-fire (§14 "idempotency key per (alert, trigger window)"):
 *  - a per-(alert, minute-window) Redis `SET NX` lock, and
 *  - the alert's own persisted state (`status`/`last_triggered_at`): one-shot
 *    alerts flip to `triggered` and drop out of the active set; repeat alerts
 *    stay active but honour a 24 h cooldown.
 *
 * A fire only emits `alert.triggered` through the notification center, which
 * enqueues it on the DURABLE `notifications.dispatch` queue (#368/#367: the
 * old pub/sub hand-off was at-most-once — a fire published while the
 * dispatcher was down/redeploying was silently lost although the alert was
 * already on cooldown; the queue survives restarts and retries). The emit
 * happens BEFORE the alert's own state flips, so a crash between the two can
 * only ever re-fire (deduped downstream), never lose the notification. This
 * module never touches the notification tables directly.
 */

/** Repeat-alert cooldown between fires (§14: 24 h). */
export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The trigger-window granularity — the evaluator runs once a minute (§14). */
export const ALERT_FIRE_WINDOW_MS = 60_000;

/** TTL of the per-(alert, window) idempotency lock. Outlives one evaluation minute. */
export const ALERT_FIRE_LOCK_TTL_SECONDS = 120;

/** The minute-window bucket a timestamp falls in — the "trigger window" of §14. */
export function alertFireWindowStart(ts: number): number {
  return Math.floor(ts / ALERT_FIRE_WINDOW_MS) * ALERT_FIRE_WINDOW_MS;
}

/** Redis idempotency key for one (alert, trigger window). */
export function alertFireLockKey(alertId: string, windowStart: number): string {
  return `alerts:fired:${alertId}:${windowStart}`;
}

/** Inputs to the pure trigger predicate. */
export interface AlertConditionInput {
  kind: AlertKind;
  threshold: number;
  /** Reference price captured at creation (the `*_from_ref` kinds); else null. */
  refPrice: number | null;
  /** Current quote price in the asset's native currency. */
  price: number;
  /** Percent change on the day, or null when the provider did not report one. */
  dayChangePct: number | null;
}

/**
 * Whether an alert's rule is met by the current quote — the pure §14 predicate,
 * with no I/O. `threshold` is a price for the `price_*` kinds and a **positive
 * percent magnitude** for the `pct_*` kinds. The `*_from_ref` kinds compare the
 * live price to the reference captured at creation; the `pct_day_*` kinds use
 * the provider's day-change percent and no-op when it is unavailable.
 */
export function alertConditionMet(input: AlertConditionInput): boolean {
  const { kind, threshold, refPrice, price, dayChangePct } = input;
  switch (kind) {
    case 'price_above':
      return price >= threshold;
    case 'price_below':
      return price <= threshold;
    case 'pct_up_from_ref':
      if (refPrice === null || refPrice <= 0) return false;
      return ((price - refPrice) / refPrice) * 100 >= threshold;
    case 'pct_down_from_ref':
      if (refPrice === null || refPrice <= 0) return false;
      return ((refPrice - price) / refPrice) * 100 >= threshold;
    case 'pct_day_up':
      return dayChangePct !== null && dayChangePct >= threshold;
    case 'pct_day_down':
      return dayChangePct !== null && dayChangePct <= -threshold;
  }
}

export interface AlertsEvaluatorDeps {
  alertRepo: AlertRepository;
  marketData: Pick<MarketDataService, 'getQuote'>;
  redis: Redis;
  /** The central notification pipeline (#368) — fires enter the durable queue here. */
  notify: NotificationCenter;
  logger: Logger;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface AlertsEvaluationResult {
  /** Active alerts considered this run. */
  evaluated: number;
  /** Alerts that fired this run (unique quote calls = distinct assets). */
  fired: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Evaluate every active alert once and fire those whose condition is met. One
 * cached quote is fetched per distinct asset regardless of how many alerts
 * reference it, so the evaluator never fans out per-alert to the provider.
 */
export async function runAlertsEvaluation(
  deps: AlertsEvaluatorDeps,
): Promise<AlertsEvaluationResult> {
  const { alertRepo, marketData, redis, notify, logger } = deps;
  const now = deps.now ? deps.now() : Date.now();

  const active = await alertRepo.listActiveWithAsset();
  if (active.length === 0) return { evaluated: 0, fired: 0 };

  // Group by asset so each asset's quote is read exactly once from the cache.
  const byAsset = new Map<string, typeof active>();
  for (const alert of active) {
    const group = byAsset.get(alert.assetId);
    if (group) group.push(alert);
    else byAsset.set(alert.assetId, [alert]);
  }

  const windowStart = alertFireWindowStart(now);
  const occurredAt = new Date(now).toISOString();
  let fired = 0;

  for (const group of byAsset.values()) {
    const first = group[0]!;
    let price: number;
    let dayChangePct: number | null;
    try {
      const quote = (
        await marketData.getQuote({ providerId: first.providerId, providerRef: first.providerRef })
      ).value;
      price = quote.price;
      dayChangePct = quote.dayChangePct ?? null;
    } catch (err) {
      logger.warn(
        { assetId: first.assetId, providerRef: first.providerRef, err: errorMessage(err) },
        'alerts.evaluate: quote fetch failed, skipping asset',
      );
      continue;
    }

    for (const alert of group) {
      if (
        !alertConditionMet({
          kind: alert.kind,
          threshold: alert.threshold,
          refPrice: alert.refPrice,
          price,
          dayChangePct,
        })
      ) {
        continue;
      }

      // Repeat cooldown: a still-active repeat alert only re-fires after 24 h.
      if (
        alert.repeat &&
        alert.lastTriggeredAt &&
        now - alert.lastTriggeredAt.getTime() < ALERT_COOLDOWN_MS
      ) {
        continue;
      }

      // Idempotency: only the first evaluator run to claim this (alert, window)
      // lock may fire it. A concurrent/repeated run in the same minute loses the
      // race and no-ops — no double publish, no double notification (§14).
      const acquired = await redis.set(
        alertFireLockKey(alert.id, windowStart),
        '1',
        'EX',
        ALERT_FIRE_LOCK_TTL_SECONDS,
        'NX',
      );
      if (acquired !== 'OK') continue;

      // Emit FIRST, then flip the alert's state: if the process dies between
      // the two, the worst case is a re-fire next window (deduped by the
      // dispatcher's eventKey), never a triggered-but-never-delivered alert —
      // the exact #367 failure this ordering kills.
      await notify.emit({
        type: 'alert.triggered',
        userId: alert.userId,
        alertId: alert.id,
        assetId: alert.assetId,
        occurredAt,
      });
      const status: AlertStatus = alert.repeat ? 'active' : 'triggered';
      await alertRepo.recordTriggered(alert.id, status, new Date(now));
      fired += 1;
    }
  }

  return { evaluated: active.length, fired };
}
