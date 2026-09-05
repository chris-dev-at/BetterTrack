import type { AlertKind, AlertStatus } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { ActiveAlert, AlertRepository } from '../../data/repositories/alertRepository';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import { ParanoidModeError, type ParanoidModeGuard } from '../account/paranoidEnforcement';
import type { NotificationCenter } from '../notifications/notificationCenter';
import {
  createAlertFollowRecipientCache,
  type AlertFollowerFanoutDeps,
} from './alertFollowerFanout';

/**
 * The price-alert evaluator (PROJECTPLAN.md §14, V3-P10 arc b). A BullMQ
 * repeatable job runs {@link runAlertsEvaluation} every minute: it loads every
 * active alert, reads each referenced asset's quote **once** through the cached
 * §5.3 market-data core (never a per-alert upstream fan-out), tests the rule,
 * and fires the ones that met their condition.
 *
 * Firing is guarded so overlapping, re-delivered or replicated evaluator runs
 * cannot double-fire (§14 "idempotency key per (alert, trigger window)"):
 *  - a per-(alert, minute-window) Redis `SET NX` lock sheds the same-minute
 *    stampede before it reaches the database, and
 *  - the fire itself is an ATOMIC conditional transition on the alert row
 *    ({@link AlertRepository.claimTrigger}): it lands only while the row still
 *    carries the exact (`active`, `last_triggered_at`) snapshot the run read.
 *
 * The claim is what makes the guarantee hold ACROSS minutes, which the Redis
 * key alone cannot: a run that stalls past its BullMQ lock is re-delivered in a
 * later minute and still sees the pre-fire snapshot, so it takes a different
 * Redis key — and then loses the claim. The dispatcher's own dedupe cannot
 * catch that case either, because its event key folds in the fire's minute.
 *
 * A fire only emits `alert.triggered` through the notification center, which
 * enqueues it on the DURABLE `notifications.dispatch` queue (#368/#367: the
 * old pub/sub hand-off was at-most-once — a fire published while the
 * dispatcher was down/redeploying was silently lost although the alert was
 * already on cooldown; the queue survives restarts and retries). This module
 * never touches the notification tables directly.
 *
 * The honest ordering, and what it costs: the claim is taken BEFORE the emit,
 * because a claim is what makes one run's emit exclusive. A failed enqueue is
 * still fully recovered — the claim is RELEASED and the row restored to its
 * pre-fire snapshot, so the next run retries it, exactly the #367 rule for a
 * Redis hiccup. What is NOT covered is the process dying in the one-enqueue-wide
 * window between claim and emit: that fire is lost (a one-shot ends `triggered`
 * undelivered, a repeat waits out its cooldown) rather than duplicated. That is
 * the deliberate trade for killing the double fire that every overlapping run
 * produced.
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
  /**
   * Registry-bound transition guard for the evaluator's account-owned rail
   * (`alerts.evaluate` is classified `internallyFiltered`). The global-asset
   * rail needs no guard; an alert on the owner's OWN custom asset is killed
   * content, so it is only loaded, quoted, emitted and flipped inside that
   * account's transition lock.
   */
  paranoid: Pick<ParanoidModeGuard, 'runAllowed'>;
  /** The central notification pipeline (#368) — fires enter the durable queue here. */
  notify: NotificationCenter;
  /**
   * Alert-follow fire fan-out (#455): resolves the followers to notify with
   * `follow.alert.fired` when one of `ownerId`'s alerts fires — opted-in
   * followers of an owner whose `alertsVisibleToFollowers` opt-in is on (the
   * query joins the flag per fire, so unsharing stops delivery immediately).
   * Optional: absent = no follower fan-out (the owner's own delivery is
   * untouched either way).
   */
  followFanout?: AlertFollowerFanoutDeps;
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
 *
 * The run has two rails. Alerts on GLOBAL market assets carry no account
 * provenance and are evaluated directly. Alerts on an account's OWN custom
 * asset are killed content in paranoid mode: their owners are discovered from
 * identity-only metadata, and each owner's alerts are loaded, quoted, emitted
 * and flipped inside that account's transition lock — so an enable that wins
 * the race means the custom-asset query never runs and no side effect lands.
 *
 * An alert on a custom asset owned by a THIRD account fits neither rail: the
 * global rail excludes owned assets, and locking the alert's owner would not
 * lock the account whose content the asset actually is. Such a row is dropped
 * fail-closed — but it is counted and logged rather than vanishing silently
 * between the two `where` clauses.
 */
export async function runAlertsEvaluation(
  deps: AlertsEvaluatorDeps,
): Promise<AlertsEvaluationResult> {
  const { alertRepo, marketData, redis, notify, logger } = deps;
  const now = deps.now ? deps.now() : Date.now();

  // Alert-follow fan-out (#455): one audience resolution per owner per RUN,
  // spanning both rails. The resolution depends only on (owner, 'fire') but
  // costs two privacy-lock transactions, so resolving it per fired alert made a
  // market-wide event cost 2N lock round-trips before any notification work.
  const followAudience = deps.followFanout
    ? createAlertFollowRecipientCache(deps.followFanout, 'fire')
    : null;

  const globalActive = await alertRepo.listActiveWithAsset({ includeCustomAssets: false });
  let evaluated = globalActive.length;
  let fired = await evaluateBatch(globalActive);

  for (const ownerId of await alertRepo.listActiveCustomAssetOwnerIds()) {
    try {
      await deps.paranoid.runAllowed(ownerId, 'portfolioServer', async () => {
        const owned = await alertRepo.listActiveCustomAssetsForUser(ownerId);
        evaluated += owned.length;
        fired += await evaluateBatch(owned);
      });
    } catch (err) {
      // The account went paranoid: its custom-asset alerts are simply not
      // evaluated this run. Global alerts (already handled above) are untouched.
      if (err instanceof ParanoidModeError) continue;
      throw err;
    }
  }

  const unreachable = await alertRepo.countActiveForeignCustomAssetAlerts();
  if (unreachable > 0) {
    logger.warn(
      { unreachable },
      'alerts.evaluate: active alerts on a foreign account-owned asset are served by neither rail and were not evaluated',
    );
  }

  return { evaluated, fired };

  /** Evaluate one provenance-homogeneous batch; returns the number of fires. */
  async function evaluateBatch(active: readonly ActiveAlert[]): Promise<number> {
    if (active.length === 0) return 0;

    // Group by asset so each asset's quote is read exactly once from the cache.
    const byAsset = new Map<string, ActiveAlert[]>();
    for (const alert of active) {
      const group = byAsset.get(alert.assetId);
      if (group) group.push(alert);
      else byAsset.set(alert.assetId, [alert]);
    }

    const windowStart = alertFireWindowStart(now);
    const occurredAt = new Date(now).toISOString();
    let batchFired = 0;

    for (const group of byAsset.values()) {
      const first = group[0]!;
      let price: number;
      let dayChangePct: number | null;
      try {
        const quote = (
          await marketData.getQuote({
            providerId: first.providerId,
            providerRef: first.providerRef,
          })
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

        // Idempotency, first line: the per-(alert, window) Redis lock sheds a
        // same-minute stampede (a second replica, a raised concurrency) before
        // it reaches the database. It cannot span minutes, so it is a damper,
        // not the guarantee.
        const acquired = await redis.set(
          alertFireLockKey(alert.id, windowStart),
          '1',
          'EX',
          ALERT_FIRE_LOCK_TTL_SECONDS,
          'NX',
        );
        if (acquired !== 'OK') continue;

        // Idempotency, the guarantee: an atomic conditional transition off the
        // exact snapshot this run read. A run re-delivered in a LATER minute
        // still holds the pre-fire snapshot and takes a different Redis key —
        // and loses here, so it never emits.
        const status: AlertStatus = alert.repeat ? 'active' : 'triggered';
        const triggeredAt = new Date(now);
        const claimed = await alertRepo.claimTrigger({
          id: alert.id,
          expectedLastTriggeredAt: alert.lastTriggeredAt,
          status,
          triggeredAt,
        });
        if (!claimed) continue;

        const emitted = await notify.emit({
          type: 'alert.triggered',
          userId: alert.userId,
          alertId: alert.id,
          assetId: alert.assetId,
          occurredAt,
        });
        if (!emitted) {
          // Enqueue failed (the center logged it): release the claim so the row
          // is exactly where it was and the next window retries it — the #367
          // rule for a Redis hiccup, unchanged by the claim-first ordering: a
          // fire may be delayed and re-attempted, never dropped after the state
          // already flipped.
          await alertRepo.releaseTriggerClaim({
            id: alert.id,
            claimedStatus: status,
            claimedAt: triggeredAt,
            lastTriggeredAt: alert.lastTriggeredAt,
          });
          continue;
        }

        // Alert-follow fan-out (#455): IN ADDITION TO the owner's delivery above,
        // notify followers who opted into fired-alert news — the audience is the
        // one resolved for this owner this run (visibility is still decided by
        // the recipient query, never here). Recipients are disjoint from the
        // owner (self-follows are impossible), so the owner is never doubled.
        // Best-effort like the channel fan-outs: a failed follower emit logs
        // (the center already did) and never blocks the owner's fire.
        if (followAudience) {
          try {
            await followAudience.withRecipients(alert.userId, async (recipients) => {
              for (const recipient of recipients) {
                await notify.emit({
                  type: 'follow.alert.fired',
                  userId: recipient.followerId,
                  actorId: alert.userId,
                  actorUsername: recipient.ownerUsername,
                  alertId: alert.id,
                  assetId: alert.assetId,
                  occurredAt,
                });
              }
            });
          } catch (err) {
            logger.warn(
              { alertId: alert.id, err: errorMessage(err) },
              'alerts.evaluate: follower fan-out failed',
            );
          }
        }

        batchFired += 1;
      }
    }

    return batchFired;
  }
}
