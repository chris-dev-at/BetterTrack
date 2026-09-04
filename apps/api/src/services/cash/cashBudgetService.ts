import {
  CASH_TREND_MONTHS_MAX,
  type CashBudget,
  type CashBudgetListResponse,
  type CashBudgetProgress,
  type CashBudgetRawListResponse,
  type CashBudgetResponse,
  type CashMonthlySummaryResponse,
  type CashTagSummary,
  type CashTrendResponse,
  type CreateCashBudgetRequest,
  type UpdateCashBudgetRequest,
} from '@bettertrack/contracts';

import type {
  CashBudgetRecord,
  CashBudgetRepository,
  CashBudgetWithTag,
} from '../../data/repositories/cashBudgetRepository';
import type { CashSummaryRepository } from '../../data/repositories/cashSummaryRepository';
import type { CashTagRepository } from '../../data/repositories/cashTagRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import { isDriverErrorCode } from '../../data/driverError';
import { badRequest, conflict, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { NotificationCenter } from '../notifications/notificationCenter';

/**
 * Cash budgets: the per-(portfolio, tag, month) spend target, its evaluation, and
 * the monthly summary / trend reads the Cash flow surface draws (V5 cash fusion).
 *
 * This is the old `expense_budgets` evaluation ported onto tags and scoped to a
 * portfolio. What was carried over verbatim, because changing any of it would
 * change who gets alerted and how often:
 *
 *  - **Strictly over.** `spent > amount` at CENT precision, so hitting the target
 *    exactly is not exceeding it.
 *  - **Only the current month is evaluated.** A budget is a live guard rail; a
 *    closed month cannot be acted on and re-alerting it would be noise.
 *  - **Claim before emitting.** `cash_budget_fires` UNIQUE(budget, period) is the
 *    IDEMPOTENCY KEY: the claim lands first, so a blown budget alerts exactly once
 *    per month however many times the evaluator runs.
 *  - **Release on a non-durable emit.** A `false` from the notification centre
 *    means no durable transport accepted the event, so the claim is given back
 *    and the next run may try again — otherwise an outage would silently consume
 *    the month's single alert. A THROW out of `emit` is the same thing (#1754):
 *    nothing was delivered, so the claim is given back before the error is
 *    logged or re-raised, rather than being consumed by a transport fault.
 *  - **Never throws.** Evaluation runs off the back of a money write; a failure
 *    here must not fail the write that triggered it.
 *
 * What is NEW, because the fused model allows it: a month-specific budget row
 * overrides the recurring one for that month, and a movement's OUTFLOW is what
 * counts (an inflow carrying `Food` is a refund and must not create headroom).
 *
 * ── THE WRITE-PATH SEAM (#1754) ──
 *
 * {@link CashBudgetService.onCashWrite} is the ONE named hook every money write
 * that can move a budget's spend calls: `deposit` / `withdraw` / `fee`,
 * `transfer`, `PATCH` and `DELETE` of a movement, `set-balance` (all wired into
 * `portfolioService` as `onCashWrite`), and `PUT /cash/movements/:id/tags`
 * (wired into `cashTagService`, because retagging changes what a movement counts
 * against). It is `evaluate`, so it is the non-throwing form: the user came to
 * move money, and a budget alert must never cost them the write.
 *
 * ── THE RE-ARM RULE: RE-ARM ON FALLING UNDER (#1754) ──
 *
 * The claim marks a period as ALERTED, not as SPENT. So an evaluation that finds
 * a budget no longer exceeded RELEASES that period's claim, and the next
 * overrun in the same month alerts again. Both ways back under the line re-arm,
 * because both are the same question ("is it over right now?"): the spend
 * dropping (a mis-tagged row untagged, a movement deleted or corrected) and the
 * target rising (`PATCH` to a bigger amount). Without it, one stale overrun
 * consumed the month: untagging a €150 row and then genuinely spending €600
 * emitted nothing.
 *
 * It stays EXACTLY ONCE while the condition holds — the release only ever fires
 * for a budget that is currently under its target, so repeated writes over an
 * already-alerted budget still emit one notification for the month.
 */

const BUDGET_NOT_FOUND = () => notFound('Budget not found.', 'CASH_BUDGET_NOT_FOUND');
const PORTFOLIO_NOT_FOUND = () => notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
const TAG_REF_INVALID = () => badRequest('That tag does not exist.', 'CASH_TAG_REF_NOT_FOUND');
const BUDGET_EXISTS = () =>
  conflict('That tag already has a budget for this period.', 'CASH_BUDGET_EXISTS');

function isUniqueViolation(err: unknown): boolean {
  return isDriverErrorCode(err, '23505');
}

/** `YYYY-MM` of an instant, in UTC — the bucket every cash surface uses. */
export function periodKeyFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** The `count` months ending at `endPeriod`, oldest first. */
export function periodsEndingAt(endPeriod: string, count: number): string[] {
  const [year, month] = endPeriod.split('-').map(Number) as [number, number];
  // Absolute month index, so the arithmetic never has to think about year edges.
  const endIndex = year * 12 + (month - 1);
  const periods: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const index = endIndex - offset;
    periods.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return periods;
}

/** Micros → EUR, at cent precision — every figure this service reports. */
function toEur(micros: number): number {
  return Math.round(micros / 10_000) / 100;
}

/**
 * Strictly over, compared in CENTS. Both sides are rounded to cents first so a
 * stored `199.999999` cannot read as over a `200.00` target through float drift.
 */
export function isOverBudget(spentEur: number, amountEur: number): boolean {
  return Math.round(spentEur * 100) > Math.round(amountEur * 100);
}

/**
 * THE CASH-WRITE SEAM (#1754). One named hook, taken by every service that
 * moves money or changes what a movement is labelled as, so a new cash write
 * cannot silently skip budget evaluation.
 */
export type CashWriteHook = (userId: string, portfolioId: string) => Promise<void>;

function toBudgetDto(record: CashBudgetRecord): CashBudget {
  return {
    id: record.id,
    portfolioId: record.portfolioId,
    tagId: record.tagId,
    period: record.periodKey,
    amount: Number(record.amount),
    currency: record.currency,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export interface CashBudgetServiceDeps {
  budgets: CashBudgetRepository;
  summaries: CashSummaryRepository;
  tags: Pick<CashTagRepository, 'findByIdForOwner'>;
  portfolios: Pick<PortfolioRepository, 'findByIdForUser'>;
  notify: NotificationCenter;
  now?: () => Date;
  logger?: Logger;
}

export interface CashBudgetService {
  listBudgets(userId: string, portfolioId: string, month?: string): Promise<CashBudgetListResponse>;
  /**
   * Every raw budget row this owner holds, across all portfolios and periods —
   * the faithful capture the paranoid enable migration needs (the per-month
   * progress list cannot enumerate other months' month-specific budgets).
   */
  listAllBudgets(userId: string): Promise<CashBudgetRawListResponse>;
  createBudget(userId: string, input: CreateCashBudgetRequest): Promise<CashBudgetResponse>;
  updateBudget(
    userId: string,
    budgetId: string,
    patch: UpdateCashBudgetRequest,
  ): Promise<CashBudgetResponse>;
  deleteBudget(userId: string, budgetId: string): Promise<void>;
  summary(userId: string, portfolioId: string, month?: string): Promise<CashMonthlySummaryResponse>;
  trends(userId: string, portfolioId: string, months?: number): Promise<CashTrendResponse>;
  /** Evaluate one portfolio's budgets for the current month and alert once each. */
  evaluate(userId: string, portfolioId: string): Promise<void>;
  /**
   * THE WRITE-PATH SEAM (#1754) — what every cash write calls, named for what it
   * hangs off rather than for what it does. Same non-throwing evaluation as
   * {@link CashBudgetService.evaluate}; see the module header for the full list
   * of write paths wired to it.
   */
  onCashWrite: CashWriteHook;
  /** Transition finalizers need a failure to remain durable instead of being logged and swallowed. */
  evaluateRequired(userId: string, portfolioId: string): Promise<void>;
}

export function createCashBudgetService(deps: CashBudgetServiceDeps): CashBudgetService {
  const { budgets, summaries, tags, portfolios, notify } = deps;
  const now = deps.now ?? (() => new Date());

  /** Ownership check, in the service, before any portfolio-scoped repository call. */
  async function requireOwnedPortfolio(userId: string, portfolioId: string): Promise<void> {
    const portfolio = await portfolios.findByIdForUser(userId, portfolioId);
    if (!portfolio) throw PORTFOLIO_NOT_FOUND();
  }

  /** Progress for one portfolio-month: the effective target per tag vs. its outflow. */
  async function progressFor(portfolioId: string, period: string): Promise<CashBudgetProgress[]> {
    const [targets, outflow] = await Promise.all([
      budgets.effectiveTargets(portfolioId, period),
      budgets.outflowByTag(portfolioId, period),
    ]);
    return targets
      .map((target) => progressRow(target, outflow.get(target.tagId) ?? 0, period))
      .sort((left, right) => left.tagName.localeCompare(right.tagName));
  }

  function progressRow(
    target: CashBudgetWithTag,
    spentRaw: number,
    period: string,
  ): CashBudgetProgress {
    const amount = Number(target.amount);
    // `outflowByTag` sums numeric(20,6); round to cents once, here, so `spent`,
    // `remaining` and `exceeded` are all decided by the same figure.
    const spent = Math.round(spentRaw * 100) / 100;
    return {
      id: target.id,
      portfolioId: target.portfolioId,
      tagId: target.tagId,
      tagName: target.tagName,
      tagColor: target.tagColor,
      amount,
      currency: target.currency,
      period,
      recurring: target.periodKey === null,
      spent,
      remaining: Math.round((amount - spent) * 100) / 100,
      exceeded: isOverBudget(spent, amount),
    };
  }

  /**
   * Give a period's claim back, reporting rather than raising: it is called from
   * paths that must not fail (a money write, and the error branch of an emit
   * that already failed). The caller decides what a `false` means — under
   * `required` it becomes the failure a transition finalizer needs.
   */
  async function releaseClaim(budgetId: string, period: string): Promise<boolean> {
    try {
      await budgets.releaseFire(budgetId, period);
      return true;
    } catch (err) {
      deps.logger?.warn({ err, budgetId }, 'cash budget fire-release failed');
      return false;
    }
  }

  async function evaluateBudgets(
    userId: string,
    portfolioId: string,
    required: boolean,
  ): Promise<void> {
    const period = periodKeyFor(now());
    const [targets, outflow, claimedPeriods] = await Promise.all([
      budgets.effectiveTargets(portfolioId, period),
      budgets.outflowByTag(portfolioId, period),
      // The claims this portfolio already holds for the month — the re-arm rule
      // needs to know which of them no longer describe an overrun.
      budgets.firedPeriods(portfolioId, period),
    ]);
    // Which budgets are over RIGHT NOW. Everything else that holds a claim for
    // the month gets it back once the loop is done (the re-arm rule).
    const exceeded = new Set<string>();
    for (const target of targets) {
      const row = progressRow(target, outflow.get(target.tagId) ?? 0, period);
      if (!row.exceeded) continue;
      exceeded.add(target.id);

      // IDEMPOTENCY KEY: (budget_id, period_key). The claim lands BEFORE the
      // emit, so a concurrent evaluator loses the race and emits nothing.
      let fireId: string | null = null;
      try {
        fireId = await budgets.claimFire(target.id, period);
      } catch (err) {
        deps.logger?.warn({ err, budgetId: target.id }, 'cash budget fire-claim failed');
        if (required) throw err;
        continue;
      }
      if (fireId === null) continue;

      let durable: boolean;
      try {
        durable = await notify.emit({
          type: 'budget.exceeded',
          userId,
          budgetId: target.id,
          // The fused model's tag stands where the category did — the user-facing
          // question ("a budget was blown") is unchanged, so the notification
          // type is too. `portfolioId` is new: budgets are per portfolio now, so
          // a deep link needs to know which ledger.
          categoryId: target.tagId,
          categoryName: target.tagName,
          portfolioId,
          period,
          // The claim's identity is the alert's identity: the dispatcher dedupes
          // on it, so a period re-armed after falling back under its target can
          // alert again on the next genuine overrun (#1754).
          fireId,
          // One currency by contract (`cashBudgetCurrencySchema` admits EUR
          // only): `spent` comes off `amount_eur`, so the two figures this
          // alert prints beside each other are the same denomination.
          amount: row.amount,
          spent: row.spent,
          currency: target.currency,
          occurredAt: now().toISOString(),
        });
      } catch (err) {
        // A THROW delivered nothing, exactly like a `false` — give the claim
        // back so the month is not consumed by a transport fault, then let the
        // original error decide the outcome.
        deps.logger?.warn({ err, budgetId: target.id }, 'cash budget notification threw');
        await releaseClaim(target.id, period);
        if (required) throw err;
        continue;
      }
      if (durable) continue;

      // Nothing accepted it, so the month has not really been alerted.
      const released = await releaseClaim(target.id, period);
      if (!released && required) {
        throw new Error('cash budget fire-release failed');
      }
      if (required) throw new Error('cash budget notification was not durably accepted');
    }

    // RE-ARM ON FALLING UNDER (see the module header). A claim says the period
    // was ALERTED; these ones no longer describe anything, so the next genuine
    // overrun in the same month may alert again. Driven off the claims actually
    // held, so the common path — nothing claimed — issues no write at all, and
    // a claim whose budget stopped being the month's effective target (a
    // one-month override took over) is re-armed too rather than being stranded.
    for (const budgetId of claimedPeriods) {
      if (exceeded.has(budgetId)) continue;
      const released = await releaseClaim(budgetId, period);
      if (!released && required) {
        throw new Error('cash budget fire-claim could not be re-armed');
      }
    }
  }

  /** {@link CashBudgetService.evaluate} — the non-throwing form. */
  const evaluateSafely: CashWriteHook = async (userId, portfolioId) => {
    try {
      await evaluateBudgets(userId, portfolioId, false);
    } catch (err) {
      // Evaluation hangs off a money write; it must never fail that write.
      deps.logger?.warn({ err, userId, portfolioId }, 'cash budget evaluation failed');
    }
  };

  return {
    async listBudgets(userId, portfolioId, month): Promise<CashBudgetListResponse> {
      await requireOwnedPortfolio(userId, portfolioId);
      const period = month ?? periodKeyFor(now());
      return { period, budgets: await progressFor(portfolioId, period) };
    },

    async listAllBudgets(userId): Promise<CashBudgetRawListResponse> {
      // `listForOwner` is joined through `portfolios.user_id`, so it can never
      // pick up a foreign ledger. `toBudgetDto` drops the joined tag columns.
      const records = await budgets.listForOwner(userId);
      return { budgets: records.map(toBudgetDto) };
    },

    async createBudget(userId, input): Promise<CashBudgetResponse> {
      // BOTH sides scoped to the caller before anything is written: the portfolio
      // (money) and the tag (label) must each belong to this account.
      await requireOwnedPortfolio(userId, input.portfolioId);
      const tag = await tags.findByIdForOwner(userId, input.tagId);
      if (tag === null) throw TAG_REF_INVALID();

      try {
        const created = await budgets.create({
          portfolioId: input.portfolioId,
          tagId: input.tagId,
          periodKey: input.period ?? null,
          amount: input.amount.toFixed(2),
          currency: input.currency,
        });
        // A new target can already be blown, so evaluate immediately rather than
        // waiting for the next money write.
        await evaluateSafely(userId, input.portfolioId);
        return { budget: toBudgetDto(created) };
      } catch (err) {
        if (isUniqueViolation(err)) throw BUDGET_EXISTS();
        throw err;
      }
    },

    async updateBudget(userId, budgetId, patch): Promise<CashBudgetResponse> {
      const updated = await budgets.update(userId, budgetId, {
        ...(patch.amount !== undefined ? { amount: patch.amount.toFixed(2) } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      });
      if (updated === null) throw BUDGET_NOT_FOUND();
      await evaluateSafely(userId, updated.portfolioId);
      return { budget: toBudgetDto(updated) };
    },

    async deleteBudget(userId, budgetId): Promise<void> {
      const deleted = await budgets.delete(userId, budgetId);
      if (!deleted) throw BUDGET_NOT_FOUND();
    },

    async summary(userId, portfolioId, month): Promise<CashMonthlySummaryResponse> {
      await requireOwnedPortfolio(userId, portfolioId);
      const period = month ?? periodKeyFor(now());
      const [totals, tagRows, untagged] = await Promise.all([
        summaries.monthTotals(portfolioId, period),
        summaries.tagTotals(portfolioId, period),
        summaries.untaggedTotals(portfolioId, period),
      ]);

      const rows: CashTagSummary[] = tagRows
        .map((row) => ({
          tagId: row.tagId,
          name: row.name,
          color: row.color,
          system: row.system,
          outflow: toEur(row.outflowMicros),
          inflow: toEur(row.inflowMicros),
          movements: row.movements,
        }))
        // Outflow-heaviest first: the question the surface answers is "where did
        // the money go", so the biggest spend leads.
        .sort((left, right) => right.outflow - left.outflow || left.name.localeCompare(right.name));

      // The untagged bucket goes last — it is a residual, not a category.
      if (untagged.movements > 0) {
        rows.push({
          tagId: null,
          name: null,
          color: null,
          system: false,
          outflow: toEur(untagged.outflowMicros),
          inflow: toEur(untagged.inflowMicros),
          movements: untagged.movements,
        });
      }

      const totalInflow = toEur(totals.inflowMicros);
      const totalOutflow = toEur(totals.outflowMicros);
      return {
        portfolioId,
        month: period,
        totalInflow,
        totalOutflow,
        // Reconciles to the ledger because it comes off the movements, not off
        // the tag rows (which double-count a multi-tagged movement by design).
        net: Math.round((totalInflow - totalOutflow) * 100) / 100,
        tags: rows,
      };
    },

    async trends(userId, portfolioId, months): Promise<CashTrendResponse> {
      await requireOwnedPortfolio(userId, portfolioId);
      const window = Math.min(months ?? 6, CASH_TREND_MONTHS_MAX);
      const periods = periodsEndingAt(periodKeyFor(now()), window);
      const first = periods[0]!;
      const [firstYear, firstMonth] = first.split('-').map(Number) as [number, number];
      const from = new Date(Date.UTC(firstYear, firstMonth - 1, 1));
      const [lastYear, lastMonth] = periods[periods.length - 1]!.split('-').map(Number) as [
        number,
        number,
      ];
      const toExclusive = new Date(
        Date.UTC(lastMonth === 12 ? lastYear + 1 : lastYear, lastMonth === 12 ? 0 : lastMonth, 1),
      );

      const rows = await summaries.trendRows(portfolioId, from, toExclusive);
      const byMonth = new Map(rows.map((row) => [row.month, row]));
      // Every month in the window gets a point, so a gap draws as a measured zero
      // rather than as a slope between the months either side of it.
      return {
        portfolioId,
        points: periods.map((month) => {
          const row = byMonth.get(month);
          return {
            month,
            inflow: toEur(row?.inflowMicros ?? 0),
            outflow: toEur(row?.outflowMicros ?? 0),
          };
        }),
      };
    },

    evaluate: evaluateSafely,

    // The seam is `evaluate` under the name of the thing it hangs off, and is
    // deliberately the SAME function object rather than a `this`-bound method:
    // it is handed to other services as a bare reference.
    onCashWrite: evaluateSafely,

    evaluateRequired(userId, portfolioId) {
      return evaluateBudgets(userId, portfolioId, true);
    },
  };
}
