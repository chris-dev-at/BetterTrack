import type { CashMovementRecord } from '../../data/repositories/cashMovementRepository';
import type { DividendRecord } from '../../data/repositories/taxRepository';
import type { UserTaxSettingsRecord } from '../../data/repositories/taxRepository';
import type { TransactionRecord } from '../../data/repositories/transactionRepository';
import {
  costBasisStrategyForCountry,
  customCarryForYears,
  deCarryPots,
  floorCents,
  settleAtYear,
  settleCustomYear,
  settleDeYear,
  settleFiYear,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  type CostBasisStrategy,
  type CustomTaxableEvent,
  type CustomTaxParams,
  type DePotCategory,
  type DePots,
  type DeTaxableEvent,
  type DeYearOutcome,
  type NewAtEvent,
  type SellRealizationEur,
  type SupportedTaxCountry,
} from '../../domain/tax';

/**
 * Open-year LIVE tax derivation (issue #635) — the rebuild of the frozen-at-
 * entry model. The §16 boundary:
 *
 *  - **Closed years** (Vienna years before the current one) keep their
 *    recording-time semantics: frozen modes coexist (countryState/customState),
 *    backdated mutations still settle into them append-only, and a settings
 *    switch never wholesale re-taxes them.
 *  - **Open years** (the current Vienna year and later) are re-derived in
 *    full under the portfolio's CURRENT effective settings, on every write
 *    path and on every report read — a continuously-derived withholding
 *    balance. Rows frozen under `none`/another regime re-tax; switching a
 *    mode heals the year (this is the 2026-€0 root-cause fix: sells recorded
 *    while the setting was `none` froze `taxMode='none'` and could never
 *    enter the AT pool, while their P/L still showed).
 *
 * Manual rows are the one carve-out: a `manual_per_trade` row's tax is a
 * user-stated fact — it never enters a derivation and its withholding is
 * never engine-refunded (the pre-existing doctrine, unchanged).
 *
 * Adding a country = a domain settle function + a branch in
 * {@link settleOpenYears} + the frozen-component analog in countryState.ts +
 * the contracts enum + picker/i18n entries.
 */

/** The regime the CURRENT settings put open years under. `manual` = no derivation. */
export type OpenRegime =
  | { kind: 'none' }
  | { kind: 'manual' }
  | { kind: 'country'; country: SupportedTaxCountry }
  | { kind: 'custom'; params: CustomTaxParams };

/** Narrow the stored country to a supported engine (legacy/unknown ⇒ AT). */
export function openCountryOf(country: string | null): SupportedTaxCountry {
  return country === TAX_COUNTRY_DE || country === TAX_COUNTRY_FI ? country : TAX_COUNTRY_AT;
}

/** The open-year regime of the resolved per-portfolio settings. */
export function openRegimeOf(
  settings: UserTaxSettingsRecord,
  parseParams: (settings: UserTaxSettingsRecord) => CustomTaxParams,
): OpenRegime {
  switch (settings.mode) {
    case 'none':
      return { kind: 'none' };
    case 'manual_per_trade':
      return { kind: 'manual' };
    case 'custom':
      return { kind: 'custom', params: parseParams(settings) };
    default:
      return { kind: 'country', country: openCountryOf(settings.country) };
  }
}

/** The cost-basis strategy the regime realizes open-year sells under (null = none). */
export function openRegimeStrategy(regime: OpenRegime): CostBasisStrategy | null {
  if (regime.kind === 'country') return costBasisStrategyForCountry(regime.country);
  if (regime.kind === 'custom') return regime.params.costBasis;
  return null;
}

/** A sell that participates in open-year derivation (everything but manual facts). */
export const isDerivableSell = (t: TransactionRecord): boolean =>
  t.side === 'sell' && t.taxMode !== 'manual_per_trade';

/** A dividend that participates in open-year derivation. */
export const isDerivableDividend = (d: DividendRecord): boolean => d.taxMode !== 'manual_per_trade';

/** The row data + recomputed views the open-year derivation runs over. */
export interface OpenYearRowView {
  transactions: readonly TransactionRecord[];
  dividendRows: readonly DividendRecord[];
  /**
   * EUR realizations by transaction id per cost-basis strategy, recomputed
   * over the *current* log (pending batch inputs included on write paths).
   */
  realizationsFor: (strategy: CostBasisStrategy) => ReadonlyMap<string, SellRealizationEur>;
  /** DE loss-pot category of an asset (`stock` → aktien, else sonstige). */
  categoryOf: (assetId: string) => DePotCategory;
  /** Vienna tax year of a row timestamp (shared with the service). */
  yearOf: (at: Date) => number;
}

/**
 * Every open Vienna year carrying ANY derivable state — a derivable sell or
 * dividend, or an unattached tax correction that must be steerable back to a
 * (possibly zero) target. Ascending.
 */
export function openDerivableYears(
  view: Pick<OpenYearRowView, 'transactions' | 'dividendRows' | 'yearOf'>,
  movements: readonly CashMovementRecord[],
  openFromYear: number,
): number[] {
  const years = new Set<number>();
  for (const t of view.transactions) {
    if (isDerivableSell(t)) {
      const year = view.yearOf(t.executedAt);
      if (year >= openFromYear) years.add(year);
    }
  }
  for (const d of view.dividendRows) {
    if (isDerivableDividend(d)) {
      const year = view.yearOf(d.executedAt);
      if (year >= openFromYear) years.add(year);
    }
  }
  for (const m of movements) {
    if (m.kind !== 'tax_withholding' && m.kind !== 'tax_refund') continue;
    if (m.transactionId !== null || m.dividendId !== null) continue;
    if (m.taxYear !== null && m.taxYear >= openFromYear) years.add(m.taxYear);
  }
  return [...years].sort((a, b) => a - b);
}

/** A new (not-yet-inserted) event entering an open year on a write path. */
export type NewOpenEvent =
  | { kind: 'sell_gain'; tempId: string; assetId: string }
  | { kind: 'dividend'; amountEur: number };

/** One dated derivable event of an existing row (amount resolved per regime). */
interface OpenEventSource {
  at: number;
  source:
    | { kind: 'sell_gain'; id: string; assetId: string }
    | { kind: 'dividend'; amountEur: number };
}

export interface SettleOpenYearsInput {
  /** The current regime — `manual` must be filtered by the caller (no derivation). */
  regime: Exclude<OpenRegime, { kind: 'manual' }>;
  view: OpenYearRowView;
  /** Open years to settle, any order (settled ascending, carry chained through). */
  years: readonly number[];
  /** The year's currently-held ENGINE tax (frozen row amounts + corrections). */
  heldOf: (year: number) => number;
  /**
   * Frozen DE events of CLOSED years (ascending fold seeds the pot chain into
   * the first open year). Only consulted when the regime is DE.
   */
  closedDeEvents?: ReadonlyMap<number, readonly DeTaxableEvent[]>;
  /**
   * Frozen custom events of CLOSED years for the ACTIVE parameter set only
   * (seeds the custom carry). Only consulted when the regime is custom.
   */
  closedCustomEvents?: ReadonlyMap<number, readonly CustomTaxableEvent[]>;
  /** Batch additions per open year (write paths), in recording order. */
  newEventsByYear?: ReadonlyMap<number, readonly NewOpenEvent[]>;
}

export interface OpenYearSettlement {
  year: number;
  /**
   * Delta (signed: positive = withhold, negative = refund) reconciling the
   * year's derived target with what is held, BEFORE new events — posts as an
   * unattached correction. This is the self-healing seam: a mode switch, a
   * re-shaped history or a legacy `none`-frozen row all surface here.
   */
  correctionDeltaEur: number;
  /** Marginal delta per new event of the year, in input order. */
  newEventDeltasEur: number[];
  /** The year's final engine target (held after all deltas). */
  targetAfterEur: number;
  /** Derived DE year state — present exactly when the regime is DE. */
  deState?: { potIns: DePots; outcome: DeYearOutcome };
}

/**
 * Settle every open year under the CURRENT regime: full re-derivation over
 * all derivable rows (chronological), carry chained from the closed years'
 * frozen state through earlier open years. Deterministic and shared by every
 * path — write, delete, dividend and report reconciliation all steer the same
 * target, so corrections can never oscillate between paths.
 */
export function settleOpenYears(input: SettleOpenYearsInput): OpenYearSettlement[] {
  const { regime, view } = input;
  const years = [...new Set(input.years)].sort((a, b) => a - b);
  if (years.length === 0) return [];

  const strategy = openRegimeStrategy(regime);
  const realizations = strategy ? view.realizationsFor(strategy) : null;
  const gainOf = (id: string): number => {
    const realization = realizations?.get(id);
    if (!realization) {
      throw new Error(`Tax engine: no ${strategy} realization for derivable sell ${id}`);
    }
    return realization.realizedPnlEur;
  };

  const eventsOfYear = (year: number): OpenEventSource[] => {
    const events: OpenEventSource[] = [];
    for (const t of view.transactions) {
      if (!isDerivableSell(t) || view.yearOf(t.executedAt) !== year) continue;
      events.push({
        at: t.executedAt.getTime(),
        source: { kind: 'sell_gain', id: t.id, assetId: t.assetId },
      });
    }
    for (const d of view.dividendRows) {
      if (!isDerivableDividend(d) || view.yearOf(d.executedAt) !== year) continue;
      events.push({
        at: d.executedAt.getTime(),
        source: { kind: 'dividend', amountEur: d.grossAmountEur },
      });
    }
    return events.sort((a, b) => a.at - b.at);
  };

  // Carry seeds from the closed years' frozen state (ascending fold).
  const ascendingClosed = <T>(byYear: ReadonlyMap<number, readonly T[]> | undefined): T[][] =>
    byYear
      ? [...byYear.keys()]
          .filter((y) => y < years[0]!)
          .sort((a, b) => a - b)
          .map((y) => [...byYear.get(y)!])
      : [];

  let dePots: DePots | null =
    regime.kind === 'country' && regime.country === TAX_COUNTRY_DE
      ? deCarryPots(ascendingClosed(input.closedDeEvents))
      : null;
  const customPriorYears: CustomTaxableEvent[][] =
    regime.kind === 'custom' ? ascendingClosed(input.closedCustomEvents) : [];

  const results: OpenYearSettlement[] = [];
  for (const year of years) {
    const existing = eventsOfYear(year);
    const news = input.newEventsByYear?.get(year) ?? [];
    const heldEur = input.heldOf(year);

    if (regime.kind === 'none') {
      // The engine has no claim on this year: target 0, everything held by
      // the engine refunds back out (manual withholdings are untouched — they
      // are not part of `heldOf`).
      results.push({
        year,
        correctionDeltaEur: floorCents(0 - heldEur),
        newEventDeltasEur: news.map(() => 0),
        targetAfterEur: 0,
      });
      continue;
    }

    if (regime.kind === 'country' && regime.country !== TAX_COUNTRY_DE) {
      const settle = regime.country === TAX_COUNTRY_FI ? settleFiYear : settleAtYear;
      const existingGainsEur: number[] = [];
      const existingDividendsEur: number[] = [];
      for (const e of existing) {
        if (e.source.kind === 'sell_gain') existingGainsEur.push(gainOf(e.source.id));
        else existingDividendsEur.push(e.source.amountEur);
      }
      const settlement = settle({
        existingGainsEur,
        existingDividendsEur,
        heldEur,
        newEvents: news.map(
          (n): NewAtEvent =>
            n.kind === 'sell_gain'
              ? { kind: 'sell_gain', amountEur: gainOf(n.tempId) }
              : { kind: 'dividend', amountEur: n.amountEur },
        ),
      });
      results.push({
        year,
        correctionDeltaEur: settlement.correctionDeltaEur,
        newEventDeltasEur: settlement.newEventDeltasEur,
        targetAfterEur: settlement.heldAfterEur,
      });
      continue;
    }

    if (regime.kind === 'country') {
      // DE: pots chain from the closed years' frozen events through every
      // earlier open year's derived events.
      const toDeEvent = (e: OpenEventSource): DeTaxableEvent =>
        e.source.kind === 'sell_gain'
          ? {
              kind: 'sell_gain',
              category: view.categoryOf(e.source.assetId),
              amountEur: gainOf(e.source.id),
            }
          : { kind: 'dividend', amountEur: e.source.amountEur };
      const potIns = dePots!;
      const settlement = settleDeYear({
        aktienPotInEur: potIns.aktienEur,
        sonstigePotInEur: potIns.sonstigeEur,
        existingEvents: existing.map(toDeEvent),
        heldEur,
        newEvents: news.map(
          (n): DeTaxableEvent =>
            n.kind === 'sell_gain'
              ? {
                  kind: 'sell_gain',
                  category: view.categoryOf(n.assetId),
                  amountEur: gainOf(n.tempId),
                }
              : { kind: 'dividend', amountEur: n.amountEur },
        ),
      });
      dePots = {
        aktienEur: settlement.yearEnd.aktienPotOutEur,
        sonstigeEur: settlement.yearEnd.sonstigePotOutEur,
      };
      results.push({
        year,
        correctionDeltaEur: settlement.correctionDeltaEur,
        newEventDeltasEur: settlement.newEventDeltasEur,
        targetAfterEur: settlement.heldAfterEur,
        deState: { potIns, outcome: settlement.yearEnd },
      });
      continue;
    }

    // Custom: the ACTIVE parameter set derives the whole year; carry chains
    // from the closed years' same-set frozen events through earlier open years.
    const toCustomEvent = (e: OpenEventSource): CustomTaxableEvent =>
      e.source.kind === 'sell_gain'
        ? { kind: 'sell_gain', amountEur: gainOf(e.source.id) }
        : { kind: 'dividend', amountEur: e.source.amountEur };
    const existingEvents = existing.map(toCustomEvent);
    const newEvents = news.map(
      (n): CustomTaxableEvent =>
        n.kind === 'sell_gain'
          ? { kind: 'sell_gain', amountEur: gainOf(n.tempId) }
          : { kind: 'dividend', amountEur: n.amountEur },
    );
    const settlement = settleCustomYear({
      params: regime.params,
      carry: customCarryForYears(regime.params, customPriorYears),
      existingEvents,
      heldEur,
      newEvents,
    });
    customPriorYears.push([...existingEvents, ...newEvents]);
    results.push({
      year,
      correctionDeltaEur: settlement.correctionDeltaEur,
      newEventDeltasEur: settlement.newEventDeltasEur,
      targetAfterEur: settlement.heldAfterEur,
    });
  }

  return results;
}

/** Restrict a per-year event map to CLOSED years (strictly before `openFromYear`). */
export function closedYearSlice<T>(
  byYear: ReadonlyMap<number, readonly T[]>,
  openFromYear: number,
): Map<number, readonly T[]> {
  const closed = new Map<number, readonly T[]>();
  for (const [year, events] of byYear) {
    if (year < openFromYear) closed.set(year, events);
  }
  return closed;
}
