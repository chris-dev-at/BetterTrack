import { customTaxParamsSchema } from '@bettertrack/contracts';

import type { DividendRecord } from '../../data/repositories/taxRepository';
import type { TransactionRecord } from '../../data/repositories/transactionRepository';
import {
  customCarryForYears,
  customYearOutcome,
  floorCents,
  type CostBasisStrategy,
  type CustomTaxableEvent,
  type CustomTaxParams,
  type SellRealizationEur,
} from '../../domain/tax';

/**
 * Custom-mode tax state helpers (V5-P4c, issue #584): the bookkeeping the tax
 * service needs once rows can be frozen under user-parameterized rule sets.
 *
 * The frame generalizes the AT/DE coexistence design (countryState.ts): every
 * DISTINCT parameter set a row was frozen under is its own settlement regime.
 * A year's total held tax must always equal the **sum of every regime's
 * independent target** — the AT pool target, the DE year target, and one
 * custom target per parameter group (each with its own carry chain over prior
 * years). Each engine only ever steers its own component; the service hands
 * `settleCustomYear` the year's held MINUS all other regimes' targets.
 * Everything derives append-only from rows + recomputed realizations.
 */

/**
 * Narrow a stored parameter snapshot (jsonb) into {@link CustomTaxParams}.
 * Row snapshots are written exclusively by this service, so an unparseable
 * one means corrupted state — fail loud rather than silently re-grouping a
 * row (which would mis-tax every settlement that follows).
 */
export function parseFrozenCustomParams(raw: unknown, rowId: string): CustomTaxParams {
  const parsed = customTaxParamsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Tax engine: row ${rowId} carries an unreadable custom-tax snapshot`);
  }
  return parsed.data;
}

/**
 * The stable grouping key of a parameter set — two rows settle in the same
 * regime exactly when every parameter matches.
 */
export function customParamsKey(p: CustomTaxParams): string {
  return [
    p.ratePct,
    p.lossOffset ? 1 : 0,
    p.refund ? 1 : 0,
    p.yearReset ? 1 : 0,
    p.carryForward ? 1 : 0,
    p.costBasis,
  ].join('|');
}

/**
 * Whether a parameter set carries state across year boundaries — a changed
 * year then changes what enters every later year (the DE-pot-style ripple).
 */
export const customParamsRipple = (p: CustomTaxParams): boolean => !p.yearReset || p.carryForward;

/** A sell frozen under the custom engine. */
export const isCustomSell = (t: TransactionRecord): boolean =>
  t.side === 'sell' && t.taxMode === 'custom';

/**
 * A sell frozen under a FIFO-based custom parameter set — like a DE sell, ANY
 * trade of its asset can shift its lot consumption (sells consume lots too,
 * unlike the moving average).
 */
export const isCustomFifoSell = (t: TransactionRecord): boolean =>
  isCustomSell(t) && parseFrozenCustomParams(t.taxParams, t.id).costBasis === 'fifo';

/**
 * Whether the custom machinery is chain-sensitive here: any frozen custom
 * row's parameter set — or the ACTIVE set, when given — carries state across
 * year boundaries ({@link customParamsRipple}) or consumes FIFO lots. Gates
 * the widened affected-year/asset sets on write and delete paths (a year
 * whose combined target did not move settles to a zero correction).
 */
export function customChainSensitive(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
  activeParams?: CustomTaxParams | null,
): boolean {
  const sensitive = (p: CustomTaxParams): boolean =>
    customParamsRipple(p) || p.costBasis === 'fifo';
  if (activeParams && sensitive(activeParams)) return true;
  return (
    transactions.some(
      (t) => isCustomSell(t) && sensitive(parseFrozenCustomParams(t.taxParams, t.id)),
    ) ||
    dividendRows.some(
      (d) => isCustomDividend(d) && sensitive(parseFrozenCustomParams(d.taxParams, d.id)),
    )
  );
}

/** A dividend frozen under the custom engine. */
export const isCustomDividend = (d: DividendRecord): boolean => d.taxMode === 'custom';

/** Whether any row of the portfolio is frozen under custom (drives the machinery). */
export function portfolioHasCustomRows(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
): boolean {
  return transactions.some(isCustomSell) || dividendRows.some(isCustomDividend);
}

/** The row data + recomputed views the custom derivations run over. */
export interface CustomRowView {
  transactions: readonly TransactionRecord[];
  dividendRows: readonly DividendRecord[];
  /**
   * EUR realizations by transaction id per cost-basis strategy, recomputed
   * over the *current* log (pending batch inputs included on write paths) —
   * each group realizes its sells under its own frozen `costBasis`.
   */
  realizationsFor: (strategy: CostBasisStrategy) => ReadonlyMap<string, SellRealizationEur>;
  /** Vienna tax year of a row timestamp (shared with the service). */
  yearOf: (at: Date) => number;
}

/** One frozen parameter group: its params + per-year chronological events. */
export interface CustomGroup {
  key: string;
  params: CustomTaxParams;
  /** Events per Vienna year, chronological (order matters when `refund` is off). */
  eventsByYear: Map<number, CustomTaxableEvent[]>;
}

/**
 * Bucket the custom-frozen rows into parameter groups with per-year taxable
 * events — sells with their recomputed gains under the group's cost basis,
 * dividends with their gross — each year's events in chronological order.
 */
export function customGroups(view: CustomRowView): Map<string, CustomGroup> {
  interface Dated {
    at: number;
    event: CustomTaxableEvent;
  }
  const byGroup = new Map<string, { params: CustomTaxParams; byYear: Map<number, Dated[]> }>();
  const push = (params: CustomTaxParams, at: Date, event: CustomTaxableEvent): void => {
    const key = customParamsKey(params);
    let group = byGroup.get(key);
    if (!group) {
      group = { params, byYear: new Map() };
      byGroup.set(key, group);
    }
    const year = view.yearOf(at);
    const events = group.byYear.get(year);
    if (events) events.push({ at: at.getTime(), event });
    else group.byYear.set(year, [{ at: at.getTime(), event }]);
  };
  for (const t of view.transactions) {
    if (!isCustomSell(t)) continue;
    const params = parseFrozenCustomParams(t.taxParams, t.id);
    const realization = view.realizationsFor(params.costBasis).get(t.id);
    if (!realization) {
      throw new Error(`Tax engine: no ${params.costBasis} realization for custom sell ${t.id}`);
    }
    push(params, t.executedAt, { kind: 'sell_gain', amountEur: realization.realizedPnlEur });
  }
  for (const d of view.dividendRows) {
    if (!isCustomDividend(d)) continue;
    const params = parseFrozenCustomParams(d.taxParams, d.id);
    push(params, d.executedAt, { kind: 'dividend', amountEur: d.grossAmountEur });
  }
  const groups = new Map<string, CustomGroup>();
  for (const [key, { params, byYear }] of byGroup) {
    const eventsByYear = new Map<number, CustomTaxableEvent[]>();
    for (const [year, dated] of byYear) {
      eventsByYear.set(
        year,
        dated.sort((a, b) => a.at - b.at).map((d) => d.event),
      );
    }
    groups.set(key, { key, params, eventsByYear });
  }
  return groups;
}

/**
 * Merge extra (pending, not-yet-inserted) events into a group's per-year map —
 * pending events append after the frozen ones (they are being recorded now).
 */
export function mergeCustomEvents(
  base: ReadonlyMap<number, readonly CustomTaxableEvent[]> | undefined,
  extra: ReadonlyMap<number, readonly CustomTaxableEvent[]>,
): Map<number, CustomTaxableEvent[]> {
  const merged = new Map<number, CustomTaxableEvent[]>();
  if (base) {
    for (const [year, events] of base) merged.set(year, [...events]);
  }
  for (const [year, events] of extra) {
    const existing = merged.get(year);
    if (existing) existing.push(...events);
    else merged.set(year, [...events]);
  }
  return merged;
}

/** The carry state entering `year` for one group's per-year events. */
export function customCarryIntoYear(
  params: CustomTaxParams,
  eventsByYear: ReadonlyMap<number, readonly CustomTaxableEvent[]>,
  year: number,
) {
  const priorYears = [...eventsByYear.keys()].filter((y) => y < year).sort((a, b) => a - b);
  return customCarryForYears(
    params,
    priorYears.map((y) => eventsByYear.get(y)!),
  );
}

/** One group's component of a year's held-tax target (0 for an event-less year of a reset group). */
export function customGroupTargetForYear(group: CustomGroup, year: number): number {
  const carry = customCarryIntoYear(group.params, group.eventsByYear, year);
  return customYearOutcome(group.params, carry, group.eventsByYear.get(year) ?? []).targetEur;
}

/** The custom component of a year's held-tax target: the sum over all groups. */
export function customTargetForYear(groups: Iterable<CustomGroup>, year: number): number {
  let total = 0;
  for (const group of groups) total += customGroupTargetForYear(group, year);
  return floorCents(total);
}
