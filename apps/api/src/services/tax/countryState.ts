import type { CashMovementRecord } from '../../data/repositories/cashMovementRepository';
import type { DividendRecord } from '../../data/repositories/taxRepository';
import type { TransactionRecord } from '../../data/repositories/transactionRepository';
import {
  deCarryPots,
  settleDeYear,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  type DePotCategory,
  type DePots,
  type DeTaxableEvent,
  type DeYearOutcome,
  type SellRealizationEur,
} from '../../domain/tax';

/**
 * Per-country tax state helpers (V5-P4, issue #580): the pure bookkeeping the
 * tax service needs once `country_specific` rows can be frozen under EITHER
 * country (§16 cutover — a mid-year AT→DE switch leaves both regimes'
 * settlements coexisting in one Vienna year).
 *
 * The load-bearing frame: a year's total held tax (`heldForYear`, country-
 * agnostic) must always equal the **sum of both countries' independent
 * targets** — the AT pool target over AT-frozen rows plus the DE year target
 * over DE-frozen rows (with its pot chain from prior years). Each engine only
 * ever steers its own component, so the service hands `settleAtYear` /
 * `settleDeYear` the year's held MINUS the other country's target. Everything
 * here derives append-only from rows + recomputed realizations; nothing is
 * stored.
 */

/**
 * The engine country a frozen `country_specific` row belongs to. Legacy rows
 * (V3-P4) always carry `AT`; anything that is not `DE` settles as AT so an
 * unexpected value can never silently drop a row from both pools.
 */
export function rowEngineCountry(
  taxCountry: string | null,
): typeof TAX_COUNTRY_AT | typeof TAX_COUNTRY_DE {
  return taxCountry === TAX_COUNTRY_DE ? TAX_COUNTRY_DE : TAX_COUNTRY_AT;
}

/** A sell taxed under `country_specific` mode (either country). */
export const isCountrySpecificSell = (t: TransactionRecord): boolean =>
  t.side === 'sell' && t.taxMode === 'country_specific';

/** A sell frozen under the DE engine. */
export const isDeSell = (t: TransactionRecord): boolean =>
  isCountrySpecificSell(t) && rowEngineCountry(t.taxCountry) === TAX_COUNTRY_DE;

/** A dividend frozen under the DE engine. */
export const isDeDividend = (d: DividendRecord): boolean =>
  d.taxMode === 'country_specific' && rowEngineCountry(d.taxCountry) === TAX_COUNTRY_DE;

/** Whether any row of the portfolio is frozen under DE (drives the DE machinery). */
export function portfolioHasDeRows(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
): boolean {
  return transactions.some(isDeSell) || dividendRows.some(isDeDividend);
}

/** The row data + recomputed views the DE derivations run over. */
export interface DeRowView {
  transactions: readonly TransactionRecord[];
  dividendRows: readonly DividendRecord[];
  /**
   * FIFO EUR realizations by transaction id, recomputed over the *current*
   * log (pending batch inputs included on write paths) — the DE analog of the
   * AT pool's recomputed moving-average gains.
   */
  deRealizations: ReadonlyMap<string, SellRealizationEur>;
  /** DE loss-pot category of an asset (`stock` → aktien, else sonstige). */
  categoryOf: (assetId: string) => DePotCategory;
  /** Vienna tax year of a row timestamp (shared with the service). */
  yearOf: (at: Date) => number;
}

/** Extra (pending, not-yet-inserted) DE events keyed by their Vienna year. */
export type DeEventsByYear = ReadonlyMap<number, readonly DeTaxableEvent[]>;

/**
 * Bucket the DE-frozen rows into per-year taxable events — sells with their
 * recomputed FIFO gains, dividends with their gross — optionally merged with
 * pending events that are about to be inserted. Order within a year is
 * irrelevant (the year target is a function of the aggregates).
 */
export function deEventsByYear(
  view: DeRowView,
  extra?: DeEventsByYear,
): Map<number, DeTaxableEvent[]> {
  const byYear = new Map<number, DeTaxableEvent[]>();
  const push = (year: number, event: DeTaxableEvent): void => {
    const events = byYear.get(year);
    if (events) events.push(event);
    else byYear.set(year, [event]);
  };
  for (const t of view.transactions) {
    if (!isDeSell(t)) continue;
    const realization = view.deRealizations.get(t.id);
    if (!realization) {
      throw new Error(`Tax engine: no FIFO realization for DE sell ${t.id}`);
    }
    push(view.yearOf(t.executedAt), {
      kind: 'sell_gain',
      category: view.categoryOf(t.assetId),
      amountEur: realization.realizedPnlEur,
    });
  }
  for (const d of view.dividendRows) {
    if (!isDeDividend(d)) continue;
    push(view.yearOf(d.executedAt), { kind: 'dividend', amountEur: d.grossAmountEur });
  }
  if (extra) {
    for (const [year, events] of extra) {
      for (const event of events) push(year, event);
    }
  }
  return byYear;
}

/**
 * The DE loss pots entering `year`: the domain pot chain folded over every
 * earlier year that has events (gap years pass pots through unchanged, §20
 * Abs. 6 Sätze 2–3).
 */
export function dePotsInForYear(
  eventsByYear: ReadonlyMap<number, readonly DeTaxableEvent[]>,
  year: number,
): DePots {
  const priorYears = [...eventsByYear.keys()].filter((y) => y < year).sort((a, b) => a - b);
  return deCarryPots(priorYears.map((y) => eventsByYear.get(y)!));
}

/** One year's DE state: the pots entering it and its derived year-end outcome. */
export interface DeYearState {
  potIns: DePots;
  outcome: DeYearOutcome;
}

/** Derive one year's DE state (pot chain + year-end function) from the events. */
export function deYearStateForYear(
  eventsByYear: ReadonlyMap<number, readonly DeTaxableEvent[]>,
  year: number,
): DeYearState {
  const potIns = dePotsInForYear(eventsByYear, year);
  const outcome = settleDeYear({
    aktienPotInEur: potIns.aktienEur,
    sonstigePotInEur: potIns.sonstigeEur,
    existingEvents: eventsByYear.get(year) ?? [],
    heldEur: 0,
    newEvents: [],
  }).yearEnd;
  return { potIns, outcome };
}

/** The DE component of a year's held-tax target (0 for a year with no DE events). */
export function deTargetForYear(
  eventsByYear: ReadonlyMap<number, readonly DeTaxableEvent[]>,
  year: number,
): number {
  return deYearStateForYear(eventsByYear, year).outcome.totalTaxEur;
}

/**
 * Every Vienna year carrying country-specific state: years of CS sells and
 * dividends plus years with unattached tax movements (a correction can leave a
 * year behind after its rows are gone). Ascending. This is the candidate set
 * for the DE downstream ripple — a changed year changes its pot-outs, which
 * can shift every later year's target.
 */
export function countrySpecificYears(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
  movements: readonly CashMovementRecord[],
  yearOf: (at: Date) => number,
): number[] {
  const years = new Set<number>();
  for (const t of transactions) {
    if (isCountrySpecificSell(t)) years.add(yearOf(t.executedAt));
  }
  for (const d of dividendRows) {
    if (d.taxMode === 'country_specific') years.add(yearOf(d.executedAt));
  }
  for (const m of movements) {
    if (m.kind !== 'tax_withholding' && m.kind !== 'tax_refund') continue;
    if (m.transactionId !== null || m.dividendId !== null) continue;
    if (m.taxYear !== null) years.add(m.taxYear);
  }
  return [...years].sort((a, b) => a - b);
}
