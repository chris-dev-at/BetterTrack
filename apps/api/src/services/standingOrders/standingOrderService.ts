import {
  SOURCE_TAG_STANDING_ORDER,
  type CreateStandingOrderRequest,
  type StandingOrder,
  type StandingOrderListResponse,
  type StandingOrderRunListResponse,
  type UpdateStandingOrderRequest,
} from '@bettertrack/contracts';

import { floorCents } from '../../domain/cashLedger';
import type { Database } from '../../data/db';
import type { AssetRepository } from '../../data/repositories/assetRepository';
import type {
  CashMovementRecord,
  CashMovementRepository,
} from '../../data/repositories/cashMovementRepository';
import type { CashSourceRepository } from '../../data/repositories/cashSourceRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type {
  StandingOrderRepository,
  StandingOrderWithAsset,
} from '../../data/repositories/standingOrderRepository';
import type { TransactionRepository } from '../../data/repositories/transactionRepository';
import { badRequest, notFound } from '../../errors';
import type { Logger } from '../../logger';
import { ParanoidModeError, type ParanoidModeGuard } from '../account/paranoidEnforcement';
import type { MarketDataService } from '../../providers';
import type { StandingOrderSkipOutcome } from '../../events';
import type { NotificationCenter } from '../notifications/notificationCenter';
import type { PortfolioSnapshotService } from '../portfolio/portfolioSnapshots';
import {
  calendarDayInTimezone,
  dueOccurrence,
  nextRunDate,
  prevDay,
  skippedPeriods,
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
  /** Standard durable notification entry point for deferred/dropped periods. */
  notify: NotificationCenter;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
  /** Timezone for calendar-day resolution; defaults to {@link STANDING_ORDERS_SCAN_TZ}. */
  timezone?: string;
  logger?: Logger;
  paranoid?: Pick<ParanoidModeGuard, 'assertAllowed' | 'isParanoid' | 'runAllowed'>;
  /** Registry-branded worker filter for the `standingOrders.process` scan. */
  isParanoidForProcessing?: (userId: string) => Promise<boolean>;
  /** Registry-bound transition lock held across one order's complete booking path. */
  runIfAllowedForProcessing?: (userId: string, action: () => Promise<void>) => Promise<boolean>;
}

/** Outcome tallies for one scan, surfaced to the job log. */
export interface ProcessDueResult {
  scanned: number;
  booked: number;
  /** Periods already claimed by an earlier/concurrent run (the double-run guard). */
  skippedDuplicate: number;
  /** Periods left unbooked by a pre-check (provider failure / insufficient cash). */
  deferred: number;
  /**
   * Orders whose final in-lock recheck aborted the write: the portfolio was
   * archived — or the order paused, removed, or its watermark advanced past the
   * candidate period — between the scan's optimistic `listActive` read and the
   * locked claim.
   */
  skippedArchived: number;
}

/** A newly-created archive/restore tombstone, retained only for compensation. */
export interface StandingOrderRestoreSkip {
  orderId: string;
  periodKey: string;
  previousLastPeriodKey: string | null;
  previousLastRunAt: Date | null;
}

export interface StandingOrderService {
  list(userId: string, opts?: { portfolioId?: string }): Promise<StandingOrderListResponse>;
  /**
   * The caller's raw run ledger. Exposed because the order DTO's
   * `lastPeriodKey`/`lastRunAt` watermark cannot express a claimed-but-unbooked
   * period, and a consumer that has to reproduce this account's exactly-once
   * state (the paranoid-mode capture) would otherwise re-book a period that was
   * deliberately tombstoned.
   */
  listRuns(userId: string): Promise<StandingOrderRunListResponse>;
  get(userId: string, id: string): Promise<StandingOrder>;
  create(userId: string, input: CreateStandingOrderRequest): Promise<StandingOrder>;
  update(userId: string, id: string, patch: UpdateStandingOrderRequest): Promise<StandingOrder>;
  pause(userId: string, id: string): Promise<StandingOrder>;
  resume(userId: string, id: string): Promise<StandingOrder>;
  remove(userId: string, id: string): Promise<void>;
  /**
   * Claim the active orders' elapsed period while their portfolio is still
   * archived, so restoring it resumes only at a later scheduled anchor.
   */
  skipDuePeriodsForPortfolioRestore(
    userId: string,
    portfolioId: string,
    opts?: { now?: number },
  ): Promise<StandingOrderRestoreSkip[]>;
  /** Remove newly-created restore tombstones when the portfolio never reopens. */
  rollbackSkippedPeriodsForPortfolioRestore(
    userId: string,
    claims: readonly StandingOrderRestoreSkip[],
  ): Promise<void>;
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
    notify,
    logger,
  } = deps;
  const now = deps.now ?? Date.now;
  const timezone = deps.timezone ?? STANDING_ORDERS_SCAN_TZ;
  const isParanoidForProcessing =
    deps.isParanoidForProcessing ??
    (deps.paranoid ? (userId: string) => deps.paranoid!.isParanoid(userId) : undefined);
  const runIfAllowedForProcessing =
    deps.runIfAllowedForProcessing ??
    (deps.paranoid
      ? async (userId: string, action: () => Promise<void>) => {
          try {
            await deps.paranoid!.runAllowed(userId, 'standingOrderExecution', action);
            return true;
          } catch (error) {
            if (error instanceof ParanoidModeError) return false;
            throw error;
          }
        }
      : undefined);

  function toDto(record: StandingOrderWithAsset, today: string): StandingOrder {
    const suspendedByArchive = record.portfolioArchivedAt !== null;
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
      suspendedByArchive,
      lastRunAt: record.lastRunAt ? record.lastRunAt.toISOString() : null,
      lastPeriodKey: record.lastPeriodKey,
      nextRunDate: nextRunDate(
        specOf(record),
        today,
        record.lastPeriodKey,
        record.status === 'active' && !suspendedByArchive,
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
      await deps.paranoid?.assertAllowed(userId, 'standingOrderExecution');
      const today = calendarDayInTimezone(now(), timezone);
      const records = await repo.listForUser(userId, { portfolioId: opts?.portfolioId });
      return { orders: records.map((r) => toDto(r, today)) };
    },

    async listRuns(userId) {
      await deps.paranoid?.assertAllowed(userId, 'standingOrderExecution');
      const records = await repo.listRunsForUser(userId);
      return {
        runs: records.map((run) => ({
          id: run.id,
          standingOrderId: run.standingOrderId,
          periodKey: run.periodKey,
          bookedAt: run.bookedAt.toISOString(),
        })),
      };
    },

    async get(userId, id) {
      await deps.paranoid?.assertAllowed(userId, 'standingOrderExecution');
      const record = await requireOwnedOrder(userId, id);
      return toDto(record, calendarDayInTimezone(now(), timezone));
    },

    async create(userId, input) {
      await deps.paranoid?.assertAllowed(userId, 'standingOrderExecution');
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
      await deps.paranoid?.assertAllowed(userId, 'standingOrderExecution');
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
      await deps.paranoid?.assertAllowed(userId, 'standingOrderExecution');
      await requireOwnedOrder(userId, id);
      const record = await repo.setStatus(userId, id, 'paused');
      if (!record) throw ORDER_NOT_FOUND();
      return toDto(record, calendarDayInTimezone(now(), timezone));
    },

    async resume(userId, id) {
      await deps.paranoid?.assertAllowed(userId, 'standingOrderExecution');
      await requireOwnedOrder(userId, id);
      const record = await repo.setStatus(userId, id, 'active');
      if (!record) throw ORDER_NOT_FOUND();
      return toDto(record, calendarDayInTimezone(now(), timezone));
    },

    async remove(userId, id) {
      await deps.paranoid?.assertAllowed(userId, 'standingOrderExecution');
      const removed = await repo.remove(userId, id);
      if (!removed) throw ORDER_NOT_FOUND();
    },

    async skipDuePeriodsForPortfolioRestore(userId, portfolioId, opts) {
      const restoreNow = opts?.now ?? now();
      const today = calendarDayInTimezone(restoreNow, timezone);
      const skippedAt = new Date(restoreNow);
      const orders = await repo.listActiveForPortfolio(userId, portfolioId);
      const claims: StandingOrderRestoreSkip[] = [];

      for (const order of orders) {
        const due = dueOccurrence(specOf(order), today);
        if (due === null) continue;
        // Only STRICTLY-PAST periods are tombstoned: a period due on the
        // restore day itself books normally once the portfolio is scannable
        // again (the anchor-day ruling — restoring a monthly on its anchor must
        // not silently burn that month). Tombstoning the newest elapsed
        // occurrence still closes the archive window: the advanced watermark
        // keeps a stale pre-archive worker from back-filling anything older.
        const skipThrough = due < today ? due : dueOccurrence(specOf(order), prevDay(today));
        if (
          skipThrough === null ||
          (order.lastPeriodKey !== null && order.lastPeriodKey >= skipThrough)
        ) {
          continue;
        }
        if (await repo.claimSkippedPeriod(order.id, skipThrough, skippedAt)) {
          claims.push({
            orderId: order.id,
            periodKey: skipThrough,
            previousLastPeriodKey: order.lastPeriodKey,
            previousLastRunAt: order.lastRunAt,
          });
        }
      }

      if (claims.length > 0) {
        logger?.info(
          { portfolioId, userId, through: today, claimed: claims.length },
          'standing orders: claimed elapsed periods before archived portfolio restore',
        );
      }
      return claims;
    },

    async rollbackSkippedPeriodsForPortfolioRestore(userId, claims) {
      await Promise.all(
        claims.map((claim) =>
          repo.rollbackSkippedPeriod(userId, claim.orderId, claim.periodKey, {
            lastPeriodKey: claim.previousLastPeriodKey,
            lastRunAt: claim.previousLastRunAt,
          }),
        ),
      );
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
        skippedArchived: 0,
      };

      for (const order of orders) {
        // Definitions are vault-owned in paranoid mode. A row seen by a stale
        // worker around the enable transaction is skipped before quote, claim,
        // ledger write, or snapshot invalidation.
        if (await isParanoidForProcessing?.(order.userId)) continue;
        const processOrder = async () => {
          const due = dueOccurrence(specOf(order), today);
          if (due === null) return;
          // Fast path: this exact period (or a later one) is already booked. The
          // claim below is the authoritative guard; this just avoids a needless
          // quote fetch on the common already-booked case.
          if (order.lastPeriodKey !== null && order.lastPeriodKey >= due) return;

          const candidateDroppedPeriods = skippedPeriods(specOf(order), order.lastPeriodKey, due);
          // `lastPeriodKey` is only a display watermark. A post-claim booking
          // failure deliberately leaves it stale, and markBooked can fail after
          // the money row committed. The run ledger is the authoritative claim
          // state, so neither case may be reported later as an unrecorded drop.
          const claimedPeriodKeys = new Set(
            await repo.listClaimedPeriodKeys(order.id, [...candidateDroppedPeriods, due]),
          );
          const droppedPeriods = candidateDroppedPeriods.filter(
            (periodKey) => !claimedPeriodKeys.has(periodKey),
          );
          if (droppedPeriods.length > 0) {
            logger?.info(
              {
                orderId: order.id,
                from: order.lastPeriodKey,
                due,
                skipped: droppedPeriods.length,
              },
              'standing order: catching up — booking newest period only, skipping older',
            );
            const newestDroppedPeriod = droppedPeriods.at(-1)!;
            await notifyFailure(order, newestDroppedPeriod, 'dropped', droppedPeriods.length);
          }

          // A stale watermark can also expose the currently due period after a
          // claim. Skip it before any retriable pre-check can falsely call that
          // already-final occurrence deferred; claimPeriod remains the atomic
          // concurrency guard for a genuinely unclaimed due period.
          if (claimedPeriodKeys.has(due)) {
            result.skippedDuplicate += 1;
            return;
          }

          // Retriable pre-checks BEFORE claiming, so a failure never claims the
          // period and it retries cleanly next run (no double-book risk).
          let bookPrice: number | null = null;
          let cashSourceId: string | null = null;
          try {
            if (order.kind === 'buy-asset') {
              bookPrice = await resolveQuotePrice(order);
            } else {
              cashSourceId = (await cashSourceRepo.getOrCreateMain(order.portfolioId)).id;
            }
          } catch (err) {
            result.deferred += 1;
            logger?.warn(
              { orderId: order.id, kind: order.kind, due, err },
              'standing order: period deferred (provider failure / insufficient cash), will retry',
            );
            // A same-day transient is not yet "deferred past its anchor". If it
            // remains unbooked, a later scan emits one stable notice for this
            // period; daily schedules instead surface the old period as dropped
            // when tomorrow's occurrence becomes due.
            if (due < today) await notifyFailure(order, due, 'deferred');
            return;
          }

          // The scan's `listActive` result is intentionally only an optimistic
          // candidate list. Archive can commit while a quote is in flight, so
          // the final active check, claim and money write share one portfolio
          // mutation lock. An archive that wins that lock makes this a no-op;
          // an execution that wins finishes while the portfolio is still active.
          const outcome = await repo.withActivePortfolioLock(
            order.portfolioId,
            order.id,
            due,
            async (tx) => {
              if (order.kind === 'cash-deduct') {
                const movements = await cashMovementRepo.listForPortfolio(order.portfolioId, tx);
                if (!cashCovers(order, cashSourceId!, movements)) return 'deferred' as const;
              }

              const claimed = await repo.claimPeriod(order.id, due, tx);
              if (!claimed) return 'duplicate' as const;

              try {
                // A failed money write must leave its run claim as the existing
                // no-retry tombstone. A nested transaction is a savepoint, so the
                // failed write rolls back without releasing the outer portfolio
                // lock or rolling back the durable claim.
                await tx.transaction(async (savepoint) => {
                  await bookRow(
                    order,
                    bookPrice,
                    executedAt,
                    cashSourceId,
                    savepoint as unknown as Database,
                  );
                });
              } catch (err) {
                logger?.error(
                  { orderId: order.id, kind: order.kind, due, err },
                  'standing order: booking failed AFTER claim; period will not retry',
                );
                return 'booking-failed' as const;
              }
              return 'booked' as const;
            },
          );

          if (outcome === null) {
            result.skippedArchived += 1;
            logger?.info(
              { orderId: order.id, portfolioId: order.portfolioId, due },
              'standing order: skipped — portfolio archived or order superseded during execution',
            );
            return;
          }
          if (outcome === 'deferred') {
            result.deferred += 1;
            logger?.warn(
              { orderId: order.id, kind: order.kind, due },
              'standing order: period deferred (insufficient cash), will retry',
            );
            // Same rule as the pre-check deferral above: a same-day transient
            // is not yet "deferred past its anchor".
            if (due < today) await notifyFailure(order, due, 'deferred');
            return;
          }
          if (outcome === 'duplicate') {
            result.skippedDuplicate += 1;
            return;
          }
          if (outcome === 'booking-failed') {
            await notifyFailure(order, due, 'booking_failed');
            return;
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
        };
        if (runIfAllowedForProcessing) {
          await runIfAllowedForProcessing(order.userId, processOrder);
        } else {
          await processOrder();
        }
      }

      logger?.info(result, 'standing orders: scan complete');
      return result;
    },
  };

  /** Emit one idempotent, matrix-routed notice without affecting booking semantics. */
  async function notifyFailure(
    order: StandingOrderWithAsset,
    periodKey: string,
    outcome: StandingOrderSkipOutcome,
    droppedCount?: number,
  ): Promise<void> {
    await notify.emit({
      type: 'standing_order.skipped',
      userId: order.userId,
      standingOrderId: order.id,
      periodKey,
      outcome,
      ...(droppedCount === undefined ? {} : { droppedCount }),
      orderLabel: order.label?.trim() || order.assetSymbol,
      // This is the scheduled occurrence identity, not the scan time. The
      // webhook bridge keys retries by order + period + outcome, independent of
      // mutable display copy such as `orderLabel`.
      occurredAt: `${periodKey}T00:00:00.000Z`,
    });
  }

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

  /** Whether the portfolio's Main cash can cover a deduction (no negatives). */
  function cashCovers(
    order: StandingOrderWithAsset,
    cashSourceId: string,
    movements: readonly CashMovementRecord[],
  ): boolean {
    const balance = floorCents(
      movements
        .filter((movement) => movement.sourceId === cashSourceId)
        .reduce((sum, movement) => sum + movement.amountEur, 0),
    );
    return floorCents(order.amount) <= balance;
  }

  /** Book the ledger row for one due period, tagged `standing-order`, in `tx`. */
  async function bookRow(
    order: StandingOrderWithAsset,
    bookPrice: number | null,
    executedAt: Date,
    cashSourceId: string | null,
    tx: Database,
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
        tx,
      );
      return;
    }
    if (cashSourceId === null) {
      throw new Error(`standing order ${order.id}: cash order has no Main source`);
    }
    const magnitude = floorCents(order.amount);
    await cashMovementRepo.insert(
      order.portfolioId,
      {
        sourceId: cashSourceId,
        kind: order.kind === 'cash-add' ? 'deposit' : 'withdrawal',
        amountEur: order.kind === 'cash-add' ? magnitude : -magnitude,
        executedAt,
        note: order.label,
        source: SOURCE_TAG_STANDING_ORDER,
      },
      tx,
    );
  }
}
