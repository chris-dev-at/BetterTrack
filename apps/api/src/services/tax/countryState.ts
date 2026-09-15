import type { DividendRecord } from '../../data/repositories/taxRepository';
import type { TransactionRecord } from '../../data/repositories/transactionRepository';
import {
  costBasisStrategyForEngine,
  deCarryPots,
  frozenTaxCountryEngine,
  settleDeYear,
  taxEngineForRow,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  type CostBasisStrategy,
  type DePotCategory,
  type DePots,
  type DeTaxableEvent,
  type DeYearOutcome,
  type SellRealizationEur,
  type SupportedTaxCountry,
  type TaxRowEngine,
  type TaxRowEngineFacts,
} from '../../domain/tax';
import type { LiveRegime } from './livingYear';

/**
 * Country-specific row routing and DE event derivation for the living-year tax
 * engine. Everything derives append-only from rows and recomputed realizations;
 * nothing is stored here.
 */

/**
 * The engine country a frozen `country_specific` row belongs to. Legacy rows
 * (V3-P4) carry `null` and settle as AT. Any OTHER unrecognized value fails
 * LOUD (#669 hardening): a country recordable through the API but not wired
 * into the settlement modules must never fall through into the AT pool —
 * its frozen rows would silently decompose and settle at AT rates, and the
 * drift would read as legitimate locked residue forever.
 *
 * Delegates to the shared domain narrowing (#1512) so the paranoid client's
 * frozen-row branch and this one cannot drift: both are the same function.
 */
export function rowEngineCountry(taxCountry: string | null): SupportedTaxCountry {
  return frozenTaxCountryEngine(taxCountry);
}

/** The engine vocabulary of a living regime, for the shared row classifier. */
export function livingEngineOf(regime: LiveRegime): TaxRowEngine {
  if (regime.kind === 'country') return regime.country;
  return regime.kind;
}

/**
 * Which engine one persisted row settles under against the current living
 * regime — the server side of the #1512 single classifier. Nothing here is
 * server-specific: it is `taxEngineForRow` over the row's frozen facts, and
 * the client `taxRegimeForRow` is the same call. The committed
 * `@bettertrack/domain/taxVectors` table pins both.
 */
export function rowTaxEngine(row: TaxRowEngineFacts, regime: LiveRegime): TaxRowEngine {
  return taxEngineForRow(row, livingEngineOf(regime));
}

/**
 * The cost basis a row's realized P/L is REPORTED under: the living regime's
 * strategy for every derivable row, and the frozen engine's own basis under
 * the literal manual regime (DE/FI = FIFO, custom = its snapshot's basis,
 * AT/none = moving average). One call for both engines; before #1512 the
 * server's manual-mode branch listed DE and FIFO-custom by hand and rendered
 * a frozen FI sell at the moving average although FI freezes under FIFO.
 */
export function reportCostBasisStrategy(
  row: TaxRowEngineFacts,
  regime: LiveRegime,
  frozenCustomCostBasis: CostBasisStrategy | null,
): CostBasisStrategy {
  const engine = rowTaxEngine(row, regime);
  if (engine !== 'custom') return costBasisStrategyForEngine(engine, null);
  // A custom engine under a custom LIVING regime means the row is derivable
  // (a manual row would have classified as `manual`), so the living
  // parameters apply; otherwise the row is custom-FROZEN under the literal
  // manual regime and keeps the basis its own snapshot recorded.
  return costBasisStrategyForEngine(
    engine,
    regime.kind === 'custom'
      ? regime.params
      : frozenCustomCostBasis === null
        ? null
        : { costBasis: frozenCustomCostBasis },
  );
}

/** A sell frozen under the DE engine. */
export const isDeSell = (t: TransactionRecord): boolean =>
  t.side === 'sell' &&
  t.taxMode === 'country_specific' &&
  rowEngineCountry(t.taxCountry) === TAX_COUNTRY_DE;

/** A dividend frozen under the DE engine. */
export const isDeDividend = (d: DividendRecord): boolean =>
  d.taxMode === 'country_specific' && rowEngineCountry(d.taxCountry) === TAX_COUNTRY_DE;

/** Whether any row of the portfolio is frozen under FI (drives the FI machinery). */
export function portfolioHasFiRows(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
): boolean {
  return (
    transactions.some(
      (transaction) =>
        transaction.side === 'sell' &&
        transaction.taxMode === 'country_specific' &&
        rowEngineCountry(transaction.taxCountry) === TAX_COUNTRY_FI,
    ) ||
    dividendRows.some(
      (dividend) =>
        dividend.taxMode === 'country_specific' &&
        rowEngineCountry(dividend.taxCountry) === TAX_COUNTRY_FI,
    )
  );
}

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
function potsInForYear(
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
  const potIns = potsInForYear(eventsByYear, year);
  const outcome = settleDeYear({
    aktienPotInEur: potIns.aktienEur,
    sonstigePotInEur: potIns.sonstigeEur,
    existingEvents: eventsByYear.get(year) ?? [],
    heldEur: 0,
    newEvents: [],
  }).yearEnd;
  return { potIns, outcome };
}
