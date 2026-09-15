import {
  standingOrderQuoteRefusal,
  VAULT_ENTITY_ROW_SCHEMAS,
  type StandingOrderKind,
  type VaultEntity,
} from '@bettertrack/contracts';
import { InsufficientCashError } from '@bettertrack/domain/cashLedger';

import { MarketDataSourceError, type MarketDataSource } from '../../../lib/marketDataSource';
import {
  claimedStandingOrderPeriodKeys,
  existingStandingOrderOccurrence,
  isStandingOrderPortfolioArchived,
  VaultPortfolioStoreError,
  type VaultPortfolioStore,
} from '../vaultPortfolioStore';
import {
  asMoneyFailure,
  moneyFailure,
  VaultMoneyEngineError,
  type VaultMoneyErrorCode,
  type VaultMoneyOutcome,
} from '../engine/errors';
import { localManualAssetMarket } from '../engine/manualAsset';
import { readPortfolioModel } from '../engine/model';
import {
  assertVaultSnapshotCurrent,
  createStandingOrderScanValidator,
  liveEntities,
  refreshedStandingOrderSnapshot,
  validatedStandingOrderSnapshot,
} from '../engine/session';
import type { VaultSyncEngine } from '../sync';
import { standingOrderOccurrenceId } from './occurrenceId';
import {
  STANDING_ORDER_SCHEDULE_TZ,
  calendarDayInTimezone,
  dueStandingOrderOccurrence,
  skippedStandingOrderPeriods,
} from './schedule';

/**
 * Client mirror of the server's automatic-buy quote age ceiling in
 * `apps/api/src/services/standingOrders/standingOrderService.ts`.
 */
export const STANDING_ORDER_MAX_QUOTE_AGE_MS = 4 * 24 * 60 * 60 * 1000;

export interface StandingOrderMaterializerOptions {
  now?: () => Date;
  timezone?: string;
  signal?: AbortSignal;
}

export interface MaterializedStandingOrder {
  orderId: string;
  occurrenceId: string;
  dueDate: string;
  kind: StandingOrderKind;
  status: 'created' | 'existing';
  /**
   * The valuation day a local (custom) asset buy was priced from, present only
   * when it is older than {@link STANDING_ORDER_MAX_QUOTE_AGE_MS} — the ceiling
   * a market quote would have been deferred on. Local assets are exempt from
   * that ceiling (an owner's value point is not an outage) but not from saying
   * so, otherwise a months-old valuation books at a fresh-looking timestamp
   * with nothing to distinguish it (#1793).
   */
  stalePriceAsOf?: string;
}

/**
 * Periods the newest-only catch-up rule discarded for one order — the client
 * half of the server's `standing_order.skipped` / `dropped` notice. They are
 * never booked; they are reported so the vaulted user learns the same thing a
 * non-vaulted one is told (#1793).
 */
export interface DroppedStandingOrderPeriods {
  orderId: string;
  /** Oldest → newest, bounded by {@link DROPPED_PERIOD_REPORT_CAP}. */
  periods: string[];
  /** The newest discarded period — the server's `periodKey` on that notice. */
  newestPeriod: string;
  /** `periods.length`, mirroring the server's `droppedCount`. */
  droppedCount: number;
}

export interface DeferredStandingOrder {
  orderId: string;
  dueDate: string;
  reason: 'insufficient-cash' | 'quote-unavailable';
}

export interface FailedStandingOrder {
  orderId: string;
  dueDate: string | null;
  errorCode: VaultMoneyErrorCode;
}

export interface SkippedStandingOrder {
  orderId: string;
  dueDate: string;
  reason: 'deleted' | 'status-changed' | 'no-longer-due' | 'portfolio-archived';
}

export interface StandingOrderMaterializationResult {
  today: string;
  booked: MaterializedStandingOrder[];
  deferred: DeferredStandingOrder[];
  failed: FailedStandingOrder[];
  skipped: SkippedStandingOrder[];
  dropped: DroppedStandingOrderPeriods[];
}

/**
 * Upper bound on the discarded periods one order reports in a single scan,
 * matching the server's `skippedPeriods` cap. The count is of the bounded
 * window, so a decade-old daily order says "400 periods", never spins.
 */
export const DROPPED_PERIOD_REPORT_CAP = 400;

/**
 * Invoke after unlock and on each application start. It performs no server-side
 * portfolio mutation: each due occurrence is committed atomically through the
 * encrypted {@link VaultPortfolioStore}.
 */
export async function materializeDueStandingOrders(
  sync: VaultSyncEngine,
  store: VaultPortfolioStore,
  market: MarketDataSource,
  options: StandingOrderMaterializerOptions = {},
): Promise<VaultMoneyOutcome<StandingOrderMaterializationResult>> {
  try {
    const signal = options.signal;
    signal?.throwIfAborted();
    const now = (options.now ?? (() => new Date()))();
    const timezone = options.timezone ?? STANDING_ORDER_SCHEDULE_TZ;
    const today = calendarDayInTimezone(now, timezone);
    let snapshot = validatedStandingOrderSnapshot(sync);
    let validateOrderForScan = createStandingOrderScanValidator(snapshot.document);
    const adoptSnapshot = (next: typeof snapshot): void => {
      // The validator indexes this exact document, so its freshness is keyed on
      // document identity — not on the candidate triple, which cannot prove that
      // the rows behind it are the same object.
      const documentChanged = next.document !== snapshot.document;
      snapshot = next;
      if (documentChanged) {
        validateOrderForScan = createStandingOrderScanValidator(next.document);
      }
    };
    const refreshSnapshot = (): void => {
      adoptSnapshot(refreshedStandingOrderSnapshot(sync, snapshot));
    };
    const orderIds = liveEntities(snapshot.document, 'standingOrder').map((entity) => entity.id);
    const result: StandingOrderMaterializationResult = {
      today,
      booked: [],
      deferred: [],
      failed: [],
      skipped: [],
      dropped: [],
    };

    for (const orderId of orderIds) {
      signal?.throwIfAborted();
      const orderEntity = liveEntities(snapshot.document, 'standingOrder').find(
        (entity) => entity.id === orderId,
      );
      if (orderEntity === undefined) continue;
      let order: ReturnType<typeof parseOrder>;
      try {
        order = parseOrder(orderEntity);
      } catch (cause) {
        recordOrderFailure(result, orderId, null, cause);
        continue;
      }
      /*
       * Paused orders cannot book, so catch-up tolerates them silently — both
       * malformed business fields and an unreachable run row of their own, since
       * neither reaches a booking from here. Strict money derivations still
       * expose that corruption, which is where the user sees it.
       */
      if (order.row.status !== 'active') continue;
      /*
       * Archive is a suspension, not a pause: the server's scan excludes an
       * archived portfolio outright and its restore path deliberately
       * tombstones the elapsed period, so booking here would both move money
       * into a portfolio the user believes frozen and advance `lastPeriodKey`
       * past that no-back-fill rule (#1712). Silent, like a paused order —
       * nothing is owed while the suspension holds.
       */
      if (isStandingOrderPortfolioArchived(snapshot.document, order.row.portfolioId)) continue;
      let dueDate: string | null;
      try {
        dueDate = dueStandingOrderOccurrence(order.row, today);
      } catch (cause) {
        recordOrderFailure(result, orderId, null, cause);
        continue;
      }
      if (dueDate === null) continue;
      try {
        validateOrderForScan(order.entity);
      } catch (cause) {
        recordOrderFailure(result, orderId, dueDate, cause);
        continue;
      }

      /*
       * What the newest-only rule is about to discard, reported exactly where
       * the server reports it: before the already-booked exit, so a catch-up
       * that lands on an occurrence another device already booked still names
       * the periods nobody will ever book (#1793). The run ledger — not the
       * `lastPeriodKey` watermark, which a post-failure state can leave stale —
       * decides what was really claimed.
       */
      try {
        const claimed = claimedStandingOrderPeriodKeys(snapshot.document, order.entity.id);
        const droppedPeriods = skippedStandingOrderPeriods(
          order.row,
          order.row.lastPeriodKey,
          dueDate,
          DROPPED_PERIOD_REPORT_CAP,
        ).filter((periodKey) => !claimed.has(periodKey));
        if (droppedPeriods.length > 0) {
          result.dropped.push({
            orderId: order.entity.id,
            periods: droppedPeriods,
            newestPeriod: droppedPeriods.at(-1)!,
            droppedCount: droppedPeriods.length,
          });
        }
      } catch (cause) {
        recordOrderFailure(result, order.entity.id, dueDate, cause);
        continue;
      }

      const occurrenceId = await standingOrderOccurrenceId(order.entity.id, dueDate);
      let existing: ReturnType<typeof existingStandingOrderOccurrence>;
      try {
        existing = existingStandingOrderOccurrence(snapshot.document, {
          occurrenceId,
          orderId: order.entity.id,
          dueDate,
        });
      } catch (cause) {
        if (!isOrderScopedStoreFailure(cause)) throw cause;
        recordOrderFailure(result, order.entity.id, dueDate, cause);
        refreshSnapshot();
        continue;
      }
      if (existing !== null) {
        refreshSnapshot();
        continue;
      }

      let quote: {
        price: number;
        currency: string;
        recordedAt: string;
        stalePriceAsOf?: string;
      } | null = null;
      if (order.row.kind === 'buy-asset') {
        if (order.row.assetId === null) {
          recordOrderFailure(
            result,
            order.entity.id,
            dueDate,
            moneyFailure('VAULT_CORRUPT', `Buy standing order ${order.entity.id} has no asset.`),
          );
          continue;
        }
        try {
          const model = readPortfolioModel(snapshot.document, order.row.portfolioId);
          const asset = model.assets.get(order.row.assetId);
          if (asset === undefined) {
            throw moneyFailure(
              'VAULT_CORRUPT',
              `Buy standing order ${order.entity.id} references an unavailable asset.`,
            );
          }
          if (asset.dto.isCustom) {
            // Keep the pre-quote manual valuation for this booking. The fresh
            // commit snapshot rechecks asset identity/currency, while an edit to
            // the valuation itself intentionally takes effect on the next scan.
            const manual = localManualAssetMarket(snapshot.document, asset);
            if (manual.quote === null || manual.asOf === null) {
              throw moneyFailure(
                'MARKET_DATA_UNAVAILABLE',
                `A standing-order valuation is unavailable for manual asset ${order.row.assetId}.`,
                {
                  retryable: true,
                  details: { assetId: order.row.assetId },
                },
              );
            }
            /*
             * The owner's value-point day is this booking's market stamp, so it
             * is what `lastRunAt` records — the same rule the server engine now
             * applies (#1793). A local valuation is exempt from the quote-age
             * ceiling (it is not an outage), but a valuation older than that
             * ceiling is flagged on the booking instead of passing for fresh.
             */
            const valuationMs = Date.parse(`${manual.asOf}T00:00:00.000Z`);
            if (!Number.isFinite(valuationMs)) {
              throw moneyFailure(
                'MARKET_DATA_INVALID',
                `A standing-order valuation date is invalid for manual asset ${order.row.assetId}.`,
              );
            }
            const stale = now.getTime() - valuationMs > STANDING_ORDER_MAX_QUOTE_AGE_MS;
            quote = {
              price: manual.quote.price,
              currency: asset.currency,
              recordedAt: new Date(Math.min(valuationMs, now.getTime())).toISOString(),
              ...(stale ? { stalePriceAsOf: manual.asOf } : {}),
            };
          } else {
            const marketQuote = await market.quote(order.row.assetId, signal);
            if (marketQuote.stale) {
              throw moneyFailure(
                'MARKET_DATA_UNAVAILABLE',
                `Fresh standing-order quote is unavailable for asset ${order.row.assetId}.`,
                {
                  retryable: true,
                  details: {
                    assetId: order.row.assetId,
                    stale: true,
                    asOf: marketQuote.asOf,
                  },
                },
              );
            }
            if (typeof marketQuote.watermark !== 'string' || marketQuote.watermark.length === 0) {
              throw moneyFailure(
                'MARKET_DATA_INVALID',
                `Standing-order quote metadata is invalid for asset ${order.row.assetId}.`,
              );
            }
            const providerAsOfMs = Date.parse(marketQuote.value.asOf);
            if (!Number.isFinite(providerAsOfMs)) {
              throw moneyFailure(
                'MARKET_DATA_INVALID',
                `Standing-order quote timestamp is invalid for asset ${order.row.assetId}.`,
              );
            }
            if (now.getTime() - providerAsOfMs > STANDING_ORDER_MAX_QUOTE_AGE_MS) {
              throw moneyFailure(
                'MARKET_DATA_UNAVAILABLE',
                `Fresh standing-order quote is unavailable for asset ${order.row.assetId}.`,
                {
                  retryable: true,
                  details: {
                    assetId: order.row.assetId,
                    asOf: marketQuote.value.asOf,
                    maxQuoteAgeMs: STANDING_ORDER_MAX_QUOTE_AGE_MS,
                  },
                },
              );
            }
            quote = {
              price: marketQuote.value.price,
              currency: marketQuote.value.currency,
              recordedAt: new Date(Math.min(providerAsOfMs, now.getTime())).toISOString(),
            };
          }
          // The same rule the server engine applies before it claims a period
          // (#1712): quote, order and asset currency must agree, and the price
          // must be finite, positive and below the transaction ceiling.
          const refusal = standingOrderQuoteRefusal({
            price: quote.price,
            quoteCurrency: quote.currency,
            orderCurrency: order.row.currency,
            assetCurrency: asset.currency,
          });
          if (refusal !== null) {
            throw moneyFailure(
              'MARKET_DATA_INVALID',
              `Standing-order quote is invalid (${refusal}).`,
            );
          }
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
          if (cause instanceof VaultMoneyEngineError && !isMarketDataFailure(cause.failure.code)) {
            if (cause.failure.code === 'VAULT_CORRUPT') {
              recordOrderFailure(result, order.entity.id, dueDate, cause);
              refreshSnapshot();
              continue;
            }
            throw cause;
          }
          const quoteFailure = normalizeQuoteFailure(cause, order.row.assetId);
          if (!isMarketDataFailure(quoteFailure.failure.code)) throw quoteFailure;
          result.deferred.push({
            orderId: order.entity.id,
            dueDate,
            reason: 'quote-unavailable',
          });
          refreshSnapshot();
          continue;
        }
      }

      const commitSnapshot = validatedStandingOrderSnapshot(sync);
      const commitOrderEntity = liveEntities(commitSnapshot.document, 'standingOrder').find(
        (entity) => entity.id === order.entity.id,
      );
      if (commitOrderEntity === undefined) {
        result.skipped.push({ orderId: order.entity.id, dueDate, reason: 'deleted' });
        adoptSnapshot(commitSnapshot);
        continue;
      }
      let commitOrder: ReturnType<typeof parseOrder>;
      try {
        commitOrder = parseOrder(commitOrderEntity);
      } catch (cause) {
        recordOrderFailure(result, order.entity.id, dueDate, cause);
        adoptSnapshot(commitSnapshot);
        continue;
      }
      if (commitOrder.row.status !== 'active') {
        result.skipped.push({ orderId: order.entity.id, dueDate, reason: 'status-changed' });
        adoptSnapshot(commitSnapshot);
        continue;
      }
      if (isStandingOrderPortfolioArchived(commitSnapshot.document, commitOrder.row.portfolioId)) {
        // An archive that landed (from another device) while the quote was in
        // flight — the twin of the server's in-lock recheck.
        result.skipped.push({ orderId: order.entity.id, dueDate, reason: 'portfolio-archived' });
        adoptSnapshot(commitSnapshot);
        continue;
      }
      let commitDueDate: string | null;
      try {
        commitDueDate = dueStandingOrderOccurrence(commitOrder.row, today);
      } catch (cause) {
        recordOrderFailure(result, order.entity.id, dueDate, cause);
        adoptSnapshot(commitSnapshot);
        continue;
      }
      if (commitDueDate !== dueDate) {
        result.skipped.push({ orderId: order.entity.id, dueDate, reason: 'no-longer-due' });
        adoptSnapshot(commitSnapshot);
        continue;
      }

      try {
        const committed = await store.materializeStandingOrderOccurrence(
          {
            occurrenceId,
            orderId: order.entity.id,
            dueDate,
            calendarDay: today,
            timezone,
            executedAt: now.toISOString(),
            recordedAt: quote?.recordedAt ?? now.toISOString(),
            expectedCandidate: {
              vaultVersion: commitSnapshot.vaultVersion,
              vaultKeyId: commitSnapshot.vaultKeyId,
              writeId: commitSnapshot.writeId,
            },
            ...(quote === null ? {} : { price: quote.price, quoteCurrency: quote.currency }),
          },
          signal,
        );
        result.booked.push({
          orderId: order.entity.id,
          occurrenceId,
          dueDate,
          kind: order.row.kind,
          status: committed.status,
          ...(quote?.stalePriceAsOf === undefined ? {} : { stalePriceAsOf: quote.stalePriceAsOf }),
        });
        refreshSnapshot();
      } catch (cause) {
        if (isInsufficientCashFailure(cause)) {
          result.deferred.push({ orderId: order.entity.id, dueDate, reason: 'insufficient-cash' });
          refreshSnapshot();
          continue;
        }
        if (isOrderScopedStoreFailure(cause)) {
          recordOrderFailure(result, order.entity.id, dueDate, cause);
          refreshSnapshot();
          continue;
        }
        throw cause;
      }
    }
    assertVaultSnapshotCurrent(sync, snapshot);
    return { ok: true, value: result };
  } catch (cause) {
    return { ok: false, error: asMoneyFailure(cause) };
  }
}

function isMarketDataFailure(code: VaultMoneyErrorCode): boolean {
  return (
    code === 'MARKET_DATA_MISSING' ||
    code === 'MARKET_DATA_INVALID' ||
    code === 'MARKET_DATA_UNAVAILABLE' ||
    code === 'MARKET_DATA_UNSUPPORTED'
  );
}

function normalizeQuoteFailure(cause: unknown, assetId: string): VaultMoneyEngineError {
  if (cause instanceof VaultMoneyEngineError) return cause;
  if (cause instanceof MarketDataSourceError) {
    if (cause.code === 'MARKET_DATA_INVALID') {
      return moneyFailure('MARKET_DATA_INVALID', cause.message, { cause });
    }
    if (cause.code === 'MARKET_DATA_UNSUPPORTED') {
      return moneyFailure('MARKET_DATA_UNSUPPORTED', cause.message, { cause });
    }
    return moneyFailure('MARKET_DATA_UNAVAILABLE', cause.message, {
      retryable: true,
      details: { assetId },
      cause,
    });
  }
  return moneyFailure(
    'MARKET_DATA_UNAVAILABLE',
    `A standing-order quote is unavailable for asset ${assetId}.`,
    {
      retryable: true,
      details: { assetId },
      cause,
    },
  );
}

function recordOrderFailure(
  result: StandingOrderMaterializationResult,
  orderId: string,
  dueDate: string | null,
  cause: unknown,
): void {
  result.failed.push({ orderId, dueDate, errorCode: asMoneyFailure(cause).code });
}

function isOrderScopedStoreFailure(cause: unknown): boolean {
  return (
    cause instanceof VaultPortfolioStoreError &&
    (cause.code === 'VAULT_DATA_INVALID' || cause.code === 'VAULT_ENTITY_NOT_FOUND')
  );
}

/**
 * The business deferral is typed, never message-sniffed: the domain throws
 * InsufficientCashError directly, and a store wrapper keeps it on the `cause`
 * chain.
 */
function isInsufficientCashFailure(cause: unknown): boolean {
  for (let current: unknown = cause; current instanceof Error; current = current.cause) {
    if (current instanceof InsufficientCashError) return true;
  }
  return false;
}

function parseOrder(entity: VaultEntity): {
  entity: VaultEntity;
  row: ReturnType<(typeof VAULT_ENTITY_ROW_SCHEMAS)['standingOrder']['parse']>;
} {
  try {
    return {
      entity,
      row: VAULT_ENTITY_ROW_SCHEMAS.standingOrder.parse(entity.data),
    };
  } catch (cause) {
    throw moneyFailure('VAULT_CORRUPT', `Standing order ${entity.id} is malformed.`, { cause });
  }
}
