import {
  SOURCE_TAG_STANDING_ORDER,
  type CreateStandingOrderRequest,
  type StandingOrder,
  type StandingOrderListResponse,
  type UpdateStandingOrderRequest,
} from '@bettertrack/contracts';

import { floorCents } from '../../domain/cashLedger';
import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { CashMovementRepository } from '../../data/repositories/cashMovementRepository';
import type { CashSourceRepository } from '../../data/repositories/cashSourceRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type {
  StandingOrderRepository,
  StandingOrderWithAsset,
} from '../../data/repositories/standingOrderRepository';
import type { TransactionRepository } from '../../data/repositories/transactionRepository';
import { badRequest, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { PortfolioSnapshotService } from '../portfolio/portfolioSnapshots';
import {
  calendarDayInTimezone,
  dueOccurrence,
  nextRunDate,
  skippedPeriodCount,
  type ScheduleSpec,
} from './schedule';

/**
 * Standing orders — the auto-recording engine (PROJECTPLAN.md §13.5 V5-P6b arc
 * (a), issue #593). Owner-scoped CRUD + pause/resume over the definitions, plus
 * {@link StandingOrderService.processDueOrders} — the daily job body that books
 * each order's single most-recent due occurrence exactly once.
 *
 * **Exactly-once, without double-booking (the paramount rule).** For each due
 * order+period the engine (1) runs its retriable pre-checks — fetch the quote
 * for a buy, verify cash for a deduct — BEFORE claiming, so a provider failure
 * or insufficient cash simply leaves the period unbooked to retry next run;
 * (2) claims the period atomically via the UNIQUE(order, period) index
 * ({@link StandingOrderRepository.claimPeriod}), so a double-run of the job or a
 * concurrent worker claims at most once; (3) books the ledger row through the
 * repositories, tagged {@link SOURCE_TAG_STANDING_ORDER}. A booking error AFTER
 * the claim leaves the claim as a tombstone (never retried) rather than risking
 * a double-book — the safe direction for money.
 *
 * **Catch-up.** {@link dueOccurrence} returns only the newest occurrence ≤ today
 * (§16 planner note), so after downtime only that one books; the skipped periods
 * are logged, never booked.
 *
 * **No negative balances.** A `cash-deduct` that would overdraw is deferred (and
 * retried) rather than forced negative — the app's cash invariant holds. Buys
 * never touch cash (they book only the BUY transaction at the current quote).
 * Rows are dated at the execution instant; the scheduled period identity lives
 * in the run's `period_key`.
 */

/** Timezone the daily scan reads "today" in — the deploy tz, matching the crons. */
export const STANDING_ORDERS_SCAN_TZ = 'Europe/Vienna';

export interface StandingOrderServiceDeps {
  repo: StandingOrderRepository;
  portfolioRepo: Pick<PortfolioRepository, 'findByIdForUser'>;
  assetRepo: Pick<AssetRepository, 'findByIdForUser'>;
  transactionRepo: Pick<TransactionRepository, 'insertMany'>;
  cashMovementRepo: Pick<CashMovementRepository, 'insert' | 'listForPortfolio'>;
  cashSourceRepo: Pick<CashSourceRepository, 'getOrCreateMain'>;
  marketData: Pick<MarketDataService, 'getQuote'>;
  snapshots: Pick<PortfolioSnapshotService, 'invalidate'>;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
  /** Timezone for calendar-day resolution; defaults to {@link STANDING_ORDERS_SCAN_TZ}. */
  timezone?: string;
  logger?: Logger;
}

/** Outcome tallies for one scan, surfaced to the job log. */
export interface ProcessDueResult {
  scanned: number;
  booked: number;
  /** Periods already claimed by an earlier/concurrent run (the double-run guard). */
  skippedDuplicate: number;
  /** Periods left unbooked by a pre-check (provider failure / insufficient cash). */
  deferred: number;
}

export interface StandingOrderService {
  list(userId: string, opts?: { portfolioId?: string }): Promise<StandingOrderListResponse>;
  get(userId: string, id: string): Promise<StandingOrder>;
  create(userId: string, input: CreateStandingOrderRequest): Promise<StandingOrder>;
  update(userId: string, id: string, patch: UpdateStandingOrderRequest): Promise<StandingOrder>;
  pause(userId: string, id: string): Promise<StandingOrder>;
  resume(userId: string, id: string): Promise<StandingOrder>;
  remove(userId: string, id: string): Promise<void>;
  /** The daily job body: book every active order's newest due occurrence once. */
  processDueOrders(opts?: { now?: number }): Promise<ProcessDueResult>;
}

const ORDER_NOT_FOUND = () => notFound('Standing order not found.');

function specOf(record: StandingOrderWithAsset): ScheduleSpec {
  return {
    cadence: record.cadence,
    anchorDay: record.anchorDay,
    startDate: record.startDate,
    endDate: record.endDate,
  };
}

/** The UTC calendar day of a timestamp — the snapshot invalidation anchor. */
function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function createStandingOrderService(deps: StandingOrderServiceDeps): StandingOrderService {
  const {
    repo,
    portfolioRepo,
    assetRepo,
    transactionRepo,
    cashMovementRepo,
    cashSourceRepo,
    marketData,
    snapshots,
    logger,
  } = deps;
  const now = deps.now ?? Date.now;
  const timezone = deps.timezone ?? STANDING_ORDERS_SCAN_TZ;

  function toDto(record: StandingOrderWithAsset, today: string): StandingOrder {
    return {
      id: record.id,
      portfolioId: record.portfolioId,
      kind: record.kind,
      assetId: record.assetId,
      assetSymbol: record.assetSymbol,
      assetName: record.assetName,
      amount: record.amount,
      currency: record.currency,
      label: record.label,
      cadence: record.cadence,
      anchorDay: record.anchorDay,
      startDate: record.startDate,
      endDate: record.endDate,
      status: record.status,
      lastRunAt: record.lastRunAt ? record.lastRunAt.toISOString() : null,
      lastPeriodKey: record.lastPeriodKey,
      nextRunDate: nextRunDate(
        specOf(record),
        today,
        record.lastPeriodKey,
        record.status === 'active',
      ),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async function requireOwnedOrder(userId: string, id: string): Promise<StandingOrderWithAsset> {
    const record = await repo.findByIdForUser(userId, id);
    if (!record) throw ORDER_NOT_FOUND();
    return record;
  }

  return {
    async list(userId, opts) {
      const today = calendarDayInTimezone(now(), timezone);
      const records = await repo.listForUser(userId, { portfolioId: opts?.portfolioId });
      return { orders: records.map((r) => toDto(r, today)) };
    },

    async get(userId, id) {
      const record = await requireOwnedOrder(userId, id);
      return toDto(record, calendarDayInTimezone(now(), timezone));
    },

    async create(userId, input) {
      // Ownership: the target portfolio must be the caller's own (§8/§10).
      const portfolio = await portfolioRepo.findByIdForUser(userId, input.portfolioId);
      if (!portfolio) throw notFound('Portfolio not found.');

      let currency = 'EUR';
      let assetId: string | null = null;
      if (input.kind === 'buy-asset') {
        // The asset must be visible to the caller; its native currency is stored
        // for display (the buy executes at the quote's currency).
        const asset = await assetRepo.findByIdForUser(input.assetId!, userId);
        if (!asset) throw badRequest('Asset not found.', 'STANDING_ORDER_ASSET_NOT_FOUND');
        assetId = asset.id;
        currency = asset.currency;
      }

      const startDate = input.startDate ?? calendarDayInTimezone(now(), timezone);
      const endDate = input.endDate ?? null;
      if (endDate !== null && endDate < startDate) {
        throw badRequest(
          'endDate must be on or after startDate.',
          'STANDING_ORDER_END_BEFORE_START',
        );
      }

      const record = await repo.create({
        userId,
        portfolioId: input.portfolioId,
        kind: input.kind,
        assetId,
        amount: input.amount,
        currency,
        label: input.label ?? null,
        cadence: input.cadence,
        anchorDay: input.anchorDay ?? null,
        startDate,
        endDate,
      });
      return toDto(record, calendarDayInTimezone(now(), timezone));
    },

    async update(userId, id, patch) {
      const existing = await requireOwnedOrder(userId, id);
      const endDate = patch.endDate === undefined ? existing.endDate : patch.endDate;
      if (endDate !== null && endDate < existing.startDate) {
        throw badRequest(
          'endDate must be on or after startDate.',
          'STANDING_ORDER_END_BEFORE_START',
        );
      }
      const record = await repo.update(userId, id, {
        ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
      });
      if (!record) throw ORDER_NOT_FOUND();
      return toDto(record, calendarDayInTimezone(now(), timezone));
    },

    async pause(userId, id) {
      await requireOwnedOrder(userId, id);
      const record = await repo.setStatus(userId, id, 'paused');
      if (!record) throw ORDER_NOT_FOUND();
      return toDto(record, calendarDayInTimezone(now(), timezone));
    },

    async resume(userId, id) {
      await requireOwnedOrder(userId, id);
      const record = await repo.setStatus(userId, id, 'active');
      if (!record) throw ORDER_NOT_FOUND();
      return toDto(record, calendarDayInTimezone(now(), timezone));
    },

    async remove(userId, id) {
      const removed = await repo.remove(userId, id);
      if (!removed) throw ORDER_NOT_FOUND();
    },

    async processDueOrders(opts) {
      const nowMs = opts?.now ?? now();
      const today = calendarDayInTimezone(nowMs, timezone);
      const executedAt = new Date(nowMs);
      const orders = await repo.listActive();
      const result: ProcessDueResult = {
        scanned: orders.length,
        booked: 0,
        skippedDuplicate: 0,
        deferred: 0,
      };

      for (const order of orders) {
        const due = dueOccurrence(specOf(order), today);
        if (due === null) continue;
        // Fast path: this exact period (or a later one) is already booked. The
        // claim below is the authoritative guard; this just avoids a needless
        // quote fetch on the common already-booked case.
        if (order.lastPeriodKey !== null && order.lastPeriodKey >= due) continue;

        const skipped = skippedPeriodCount(specOf(order), order.lastPeriodKey, due);
        if (skipped > 0) {
          logger?.info(
            { orderId: order.id, from: order.lastPeriodKey, due, skipped },
            'standing order: catching up — booking newest period only, skipping older',
          );
        }

        // Retriable pre-checks BEFORE claiming, so a failure never claims the
        // period and it retries cleanly next run (no double-book risk).
        let bookPrice: number | null = null;
        try {
          if (order.kind === 'buy-asset') {
            bookPrice = await resolveQuotePrice(order);
          } else if (order.kind === 'cash-deduct') {
            await assertCashCovers(order);
          }
        } catch (err) {
          result.deferred += 1;
          logger?.warn(
            { orderId: order.id, kind: order.kind, due, err },
            'standing order: period deferred (provider failure / insufficient cash), will retry',
          );
          continue;
        }

        const claimed = await repo.claimPeriod(order.id, due);
        if (!claimed) {
          result.skippedDuplicate += 1;
          continue;
        }

        try {
          await bookRow(order, bookPrice, executedAt);
        } catch (err) {
          // The claim stays as a tombstone (not retried) — booking at-most-once
          // is safer for money than risking a double-book on retry.
          logger?.error(
            { orderId: order.id, kind: order.kind, due, err },
            'standing order: booking failed AFTER claim; period will not retry',
          );
          continue;
        }

        // Bookkeeping + snapshot invalidation are best-effort — the ledger row is
        // already durable; a hiccup here self-heals (next run / nightly reroll).
        try {
          await repo.markBooked(order.id, due, executedAt);
        } catch (err) {
          logger?.warn({ orderId: order.id, due, err }, 'standing order: markBooked failed');
        }
        try {
          await snapshots.invalidate(order.portfolioId, dayOf(executedAt));
        } catch (err) {
          logger?.warn(
            { orderId: order.id, due, err },
            'standing order: snapshot invalidation failed',
          );
        }
        result.booked += 1;
      }

      logger?.info(result, 'standing orders: scan complete');
      return result;
    },
  };

  /** Fetch the current native-currency quote price for a buy (throws on failure). */
  async function resolveQuotePrice(order: StandingOrderWithAsset): Promise<number> {
    if (!order.assetProviderId || !order.assetProviderRef) {
      throw new Error(`standing order ${order.id}: buy has no asset ref`);
    }
    const quote = await marketData.getQuote({
      providerId: order.assetProviderId,
      providerRef: order.assetProviderRef,
    });
    return quote.value.price;
  }

  /** Reject when the portfolio's Main cash can't cover a deduction (no negatives). */
  async function assertCashCovers(order: StandingOrderWithAsset): Promise<void> {
    const main = await cashSourceRepo.getOrCreateMain(order.portfolioId);
    const movements = await cashMovementRepo.listForPortfolio(order.portfolioId);
    const balance = floorCents(
      movements.filter((m) => m.sourceId === main.id).reduce((sum, m) => sum + m.amountEur, 0),
    );
    if (floorCents(order.amount) > balance) {
      throw badRequest(
        'Insufficient cash to cover the standing order.',
        'STANDING_ORDER_INSUFFICIENT_CASH',
      );
    }
  }

  /** Book the ledger row for one due period, tagged `standing-order`. */
  async function bookRow(
    order: StandingOrderWithAsset,
    bookPrice: number | null,
    executedAt: Date,
  ): Promise<void> {
    if (order.kind === 'buy-asset') {
      await transactionRepo.insertMany(
        order.portfolioId,
        [
          {
            assetId: order.assetId!,
            side: 'buy',
            quantity: order.amount,
            price: bookPrice!,
            fee: 0,
            executedAt,
            note: order.label,
            source: SOURCE_TAG_STANDING_ORDER,
            cashMovements: [],
          },
        ],
        [],
      );
      return;
    }
    const main = await cashSourceRepo.getOrCreateMain(order.portfolioId);
    const magnitude = floorCents(order.amount);
    await cashMovementRepo.insert(order.portfolioId, {
      sourceId: main.id,
      kind: order.kind === 'cash-add' ? 'deposit' : 'withdrawal',
      amountEur: order.kind === 'cash-add' ? magnitude : -magnitude,
      executedAt,
      note: order.label,
      source: SOURCE_TAG_STANDING_ORDER,
    });
  }
}
