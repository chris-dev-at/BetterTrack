import {
  VAULT_ENTITY_ROW_SCHEMAS,
  type StandingOrderKind,
  type VaultEntity,
} from '@bettertrack/contracts';
import { InsufficientCashError } from '@bettertrack/domain/cashLedger';

import { MarketDataSourceError, type MarketDataSource } from '../../../lib/marketDataSource';
import { type VaultPortfolioStore, VaultPortfolioStoreError } from '../vaultPortfolioStore';
import {
  asMoneyFailure,
  moneyFailure,
  VaultMoneyEngineError,
  type VaultMoneyOutcome,
} from '../engine/errors';
import { liveEntities, validatedVaultSnapshot } from '../engine/session';
import type { VaultSyncEngine } from '../sync';
import { standingOrderOccurrenceId } from './occurrenceId';
import { calendarDayInTimezone, dueStandingOrderOccurrence } from './schedule';

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
}

export interface DeferredStandingOrder {
  orderId: string;
  dueDate: string;
  reason: 'market-data' | 'insufficient-cash' | 'invalid-order';
}

export interface StandingOrderMaterializationResult {
  today: string;
  booked: MaterializedStandingOrder[];
  deferred: DeferredStandingOrder[];
}

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
    const timezone = options.timezone ?? 'Europe/Vienna';
    const today = calendarDayInTimezone(now, timezone);
    const snapshot = validatedVaultSnapshot(sync);
    const orders = liveEntities(snapshot.document, 'standingOrder').map(parseOrder);
    const existingRuns = new Set(
      liveEntities(snapshot.document, 'standingOrderRun').map((entity) => {
        const row = VAULT_ENTITY_ROW_SCHEMAS.standingOrderRun.parse(entity.data);
        return `${row.standingOrderId}\u0000${row.periodKey}`;
      }),
    );
    const result: StandingOrderMaterializationResult = {
      today,
      booked: [],
      deferred: [],
    };

    for (const order of orders) {
      signal?.throwIfAborted();
      if (order.row.status !== 'active') continue;
      const dueDate = dueStandingOrderOccurrence(order.row, today);
      if (
        dueDate === null ||
        (order.row.lastPeriodKey !== null && order.row.lastPeriodKey >= dueDate) ||
        existingRuns.has(`${order.entity.id}\u0000${dueDate}`)
      ) {
        continue;
      }

      let quote: { price: number; currency: string } | null = null;
      if (order.row.kind === 'buy-asset') {
        if (order.row.assetId === null) {
          result.deferred.push({ orderId: order.entity.id, dueDate, reason: 'invalid-order' });
          continue;
        }
        try {
          const marketQuote = await market.quote(order.row.assetId, signal);
          if (
            !Number.isFinite(marketQuote.value.price) ||
            marketQuote.value.price <= 0 ||
            marketQuote.value.currency !== order.row.currency
          ) {
            throw moneyFailure('MARKET_DATA_INVALID', 'Standing-order quote is invalid.');
          }
          quote = {
            price: marketQuote.value.price,
            currency: marketQuote.value.currency,
          };
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
          if (cause instanceof VaultMoneyEngineError) throw cause;
          if (cause instanceof MarketDataSourceError) {
            if (cause.code === 'MARKET_DATA_INVALID') {
              throw moneyFailure('MARKET_DATA_INVALID', cause.message, { cause });
            }
            if (cause.code === 'MARKET_DATA_UNSUPPORTED') {
              throw moneyFailure('MARKET_DATA_UNSUPPORTED', cause.message, { cause });
            }
          }
          result.deferred.push({ orderId: order.entity.id, dueDate, reason: 'market-data' });
          continue;
        }
      }

      const occurrenceId = await standingOrderOccurrenceId(order.entity.id, dueDate);
      try {
        const committed = await store.materializeStandingOrderOccurrence(
          {
            occurrenceId,
            orderId: order.entity.id,
            dueDate,
            calendarDay: today,
            timezone,
            executedAt: now.toISOString(),
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
        });
      } catch (cause) {
        if (
          cause instanceof InsufficientCashError ||
          (cause instanceof VaultPortfolioStoreError &&
            cause.message.toLowerCase().includes('insufficient'))
        ) {
          result.deferred.push({ orderId: order.entity.id, dueDate, reason: 'insufficient-cash' });
          continue;
        }
        throw cause;
      }
    }
    return { ok: true, value: result };
  } catch (cause) {
    return { ok: false, error: asMoneyFailure(cause) };
  }
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
