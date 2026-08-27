import type { DividendRecord } from '../../data/repositories/taxRepository';
import type { TransactionRecord } from '../../data/repositories/transactionRepository';
import {
  deCarryPots,
  settleDeYear,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  type DePotCategory,
  type DePots,
  type DeTaxableEvent,
  type DeYearOutcome,
  type SellRealizationEur,
} from '../../domain/tax';

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
 */
export function rowEngineCountry(
  taxCountry: string | null,
): typeof TAX_COUNTRY_AT | typeof TAX_COUNTRY_DE | typeof TAX_COUNTRY_FI {
  if (taxCountry === null || taxCountry === TAX_COUNTRY_AT) return TAX_COUNTRY_AT;
  if (taxCountry === TAX_COUNTRY_DE || taxCountry === TAX_COUNTRY_FI) return taxCountry;
  throw new Error(
    `Tax engine: no settlement component for frozen tax country "${taxCountry}" — ` +
      'wire it into SUPPORTED_TAX_COUNTRIES and the living-year country modules',
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
