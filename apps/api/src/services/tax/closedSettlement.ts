import type { CashMovementRecord } from '../../data/repositories/cashMovementRepository';
import type { DividendRecord } from '../../data/repositories/taxRepository';
import type { TransactionRecord } from '../../data/repositories/transactionRepository';
import {
  atYearTargetEur,
  floorCents,
  viennaYearOf,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  type DePotCategory,
  type DeTaxableEvent,
  type SellRealizationEur,
} from '../../domain/tax';
import {
  countrySpecificYears,
  deEventsByYear,
  deTargetForYear,
  fiTargetForYear,
  isDeDividend,
  isDeSell,
  isFiDividend,
  isFiSell,
  portfolioHasDeRows,
} from './countryState';
import {
  customChainSensitive,
  customGroups,
  customGroupTargetForYear,
  isCustomDividend,
  isCustomFifoSell,
  isCustomSell,
  type CustomGroup,
} from './customState';
import type { OpenRegime } from './openYear';

/**
 * Closed-year settlement choke point (issue #669, hardening #635/#656).
 *
 * PR #656 needed four review rounds because the closed-year ΔF self-adjustment
 * was enforced per-regime-per-branch inside the tax service's mutation paths:
 * each round found another mode/regime branch that silently skipped it, and a
 * skipped settlement is PERMANENT — the year's next touch reads the drift
 * `held − Σ standalone frozen targets` as legitimate locked open-era residue
 * ({@link lockedResidueForYear}) and preserves it forever.
 *
 * This module makes the invariant structural instead of per-branch:
 *
 *  - {@link frozenTargetForYear} is THE standalone frozen decomposition ΣF —
 *    one AT pool + one DE year + one FI pool + one component per frozen custom
 *    parameter group. Every path (and the matrix test) reads it from here.
 *  - {@link scopeClosedMutation} computes the affected closed years for ANY
 *    mutation from mode-independent facts only — which years the mutation
 *    writes rows into, which assets' trade history it changes (realizations
 *    are per-asset), and whether chain-sensitive frozen state exists (DE pots
 *    / carry-forward custom groups ripple into every later engine year). No
 *    caller-side regime/mode gate can narrow the set (#656 round 3's class).
 *  - {@link closedReshapeCorrections} settles every affected year by exactly
 *    `ΔF + (held_before − held_after)` — algebraically identical to targeting
 *    `Σ F_after + residue`, so the year's locked open-era state survives by
 *    construction and pure-reshape paths (non-engine writes, deletes, ripple
 *    years) need no bespoke settlement code at all (#656 rounds 2/4's class).
 *
 * New engine EVENTS (batch sells / a dividend entering the year it is recorded
 * into) still steer through the regime settle functions — the marginal tax
 * frozen onto a row is inherently regime logic — but their callers derive the
 * year set and all components from here, and the closed-year ΔF matrix test
 * (`closedYearDeltaMatrix.test.ts`) pins that every {regime} × {mutation path}
 * cell shifts held by exactly the change in this module's decomposition.
 *
 * Everything here is pure (rows in, numbers out): no I/O, no clock.
 */

/** Vienna tax year of a row timestamp (the service-wide bucketing rule). */
export const viennaYearOfDate = (at: Date): number => viennaYearOf(at.toISOString());

/** A row settled by an engine (country-specific or custom) — never manual. */
export const isEngineTaxed = (taxMode: TransactionRecord['taxMode']): boolean =>
  taxMode === 'country_specific' || taxMode === 'custom';

/**
 * A sell frozen under a FIFO-realizing regime — DE, FI, or a FIFO custom
 * parameter set. Unlike the moving average (which only buys re-shape, because
 * a sell never moves another row's average), FIFO replays EVERY trade of the
 * asset chronologically, so mutating ANY trade — a sell's quantity or date
 * too — can shift these rows' lot consumption (#656 round 3; #669/#675: the
 * same class through the edit door). The mutation guards and the ΔF matrix
 * test share this classifier so they can never disagree about what counts as
 * a reshape threat.
 */
export const isFifoRealizedSell = (t: TransactionRecord): boolean =>
  isDeSell(t) || isFiSell(t) || isCustomFifoSell(t);

const isTaxMovementKind = (kind: CashMovementRecord['kind']): boolean =>
  kind === 'tax_withholding' || kind === 'tax_refund';

/**
 * The tax currently **held** for one Vienna year of one portfolio: the sum
 * of the frozen tax on the year's engine-taxed rows (their attached
 * settlement movements mirror those 1:1 — created atomically, immutable,
 * cascading together) plus the unattached year corrections among the
 * movements. Manual-mode rows are excluded: engine pools contain only rows
 * taxed by an engine (§16), and manual withholdings are never refunded.
 */
export function heldForYear(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
  movements: readonly CashMovementRecord[],
  year: number,
): number {
  let held = 0;
  for (const t of transactions) {
    if (t.side !== 'sell' || !isEngineTaxed(t.taxMode)) continue;
    if (viennaYearOfDate(t.executedAt) !== year) continue;
    held += t.taxAmountEur ?? 0;
  }
  for (const d of dividendRows) {
    if (!isEngineTaxed(d.taxMode)) continue;
    if (viennaYearOfDate(d.executedAt) !== year) continue;
    held += d.taxAmountEur ?? 0;
  }
  for (const m of movements) {
    if (!isTaxMovementKind(m.kind) || m.taxYear !== year) continue;
    if (m.transactionId !== null || m.dividendId !== null) continue;
    held += -m.amountEur;
  }
  return floorCents(held);
}

/**
 * Every Vienna year carrying ANY engine-settled state (AT/DE/FI/custom rows
 * or unattached corrections), ascending — the candidate set for the
 * downstream ripple when a chained regime's earlier year changes.
 */
export function engineTaxedYears(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
  movements: readonly CashMovementRecord[],
): number[] {
  const years = new Set(
    countrySpecificYears(transactions, dividendRows, movements, viennaYearOfDate),
  );
  for (const t of transactions) {
    if (isCustomSell(t)) years.add(viennaYearOfDate(t.executedAt));
  }
  for (const d of dividendRows) {
    if (isCustomDividend(d)) years.add(viennaYearOfDate(d.executedAt));
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * The year's already-persisted AT pool inputs, gains recomputed. DE- and
 * FI-frozen rows are NOT part of the AT pool (V5-P4, #635): they enter the
 * year through their own country's target instead, so the countries'
 * settlements coexist in one (closed) year.
 */
export function existingAtPool(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
  realizations: ReadonlyMap<string, SellRealizationEur>,
  year: number,
): { existingGainsEur: number[]; existingDividendsEur: number[] } {
  const existingGainsEur: number[] = [];
  for (const t of transactions) {
    if (t.side !== 'sell' || t.taxMode !== 'country_specific' || isDeSell(t) || isFiSell(t)) {
      continue;
    }
    if (viennaYearOfDate(t.executedAt) !== year) continue;
    const realization = realizations.get(t.id);
    if (!realization) {
      throw new Error(`Tax engine: no realization for AT sell ${t.id} (year ${year})`);
    }
    existingGainsEur.push(realization.realizedPnlEur);
  }
  const existingDividendsEur = dividendRows
    .filter(
      (d) =>
        d.taxMode === 'country_specific' &&
        !isDeDividend(d) &&
        !isFiDividend(d) &&
        viennaYearOfDate(d.executedAt) === year,
    )
    .map((d) => d.grossAmountEur);
  return { existingGainsEur, existingDividendsEur };
}

/** The AT component of a year's held-tax target (0 without AT rows). */
export function atTargetForYear(
  transactions: readonly TransactionRecord[],
  dividendRows: readonly DividendRecord[],
  realizations: ReadonlyMap<string, SellRealizationEur>,
  year: number,
): number {
  const pool = existingAtPool(transactions, dividendRows, realizations, year);
  let poolEur = 0;
  for (const gain of pool.existingGainsEur) poolEur += gain;
  for (const dividend of pool.existingDividendsEur) poolEur += dividend;
  return atYearTargetEur(poolEur);
}

/**
 * The custom component of a year's held-tax target: the sum of every frozen
 * parameter group's independent target, optionally excluding the ACTIVE
 * group (whose component `settleCustomYear` steers itself on write paths).
 */
export function customTargetForYear(
  groups: ReadonlyMap<string, CustomGroup>,
  year: number,
  excludeKey?: string,
): number {
  let total = 0;
  for (const group of groups.values()) {
    if (group.key === excludeKey) continue;
    total += customGroupTargetForYear(group, year);
  }
  return floorCents(total);
}

/**
 * One side (pre- or post-mutation) of a closed year's standalone frozen
 * decomposition: the rows plus realization maps and per-regime frozen state
 * consistent with them. The `involve*` gates MUST be identical on both sides
 * of a delta so both omit the same components (use one
 * {@link involvedRegimes} result for both).
 */
export interface FrozenComponentState {
  transactions: readonly TransactionRecord[];
  dividendRows: readonly DividendRecord[];
  realizations: ReadonlyMap<string, SellRealizationEur>;
  fifoRealizations: ReadonlyMap<string, SellRealizationEur>;
  deEvents: ReadonlyMap<number, readonly DeTaxableEvent[]>;
  customGroups: ReadonlyMap<string, CustomGroup>;
  involveDe: boolean;
  involveFi: boolean;
  involveCustom: boolean;
}

/** The inputs {@link buildFrozenComponentState} assembles a state from. */
export interface FrozenComponentInputs {
  transactions: readonly TransactionRecord[];
  dividendRows: readonly DividendRecord[];
  realizations: ReadonlyMap<string, SellRealizationEur>;
  fifoRealizations: ReadonlyMap<string, SellRealizationEur>;
  /** DE loss-pot category of an asset (only consulted when `involveDe`). */
  categoryOf: (assetId: string) => DePotCategory;
  involveDe: boolean;
  involveFi: boolean;
  involveCustom: boolean;
}

/**
 * Assemble a {@link FrozenComponentState}: derive the frozen DE events and
 * custom parameter groups from the rows + realizations exactly once, the same
 * way on every path (the shared construction the per-path copies used to
 * hand-roll).
 */
export function buildFrozenComponentState(input: FrozenComponentInputs): FrozenComponentState {
  return {
    transactions: input.transactions,
    dividendRows: input.dividendRows,
    realizations: input.realizations,
    fifoRealizations: input.fifoRealizations,
    deEvents: input.involveDe
      ? deEventsByYear({
          transactions: input.transactions,
          dividendRows: input.dividendRows,
          deRealizations: input.fifoRealizations,
          categoryOf: input.categoryOf,
          yearOf: viennaYearOfDate,
        })
      : new Map<number, DeTaxableEvent[]>(),
    customGroups: input.involveCustom
      ? customGroups({
          transactions: input.transactions,
          dividendRows: input.dividendRows,
          realizationsFor: (strategy) =>
            strategy === 'fifo' ? input.fifoRealizations : input.realizations,
          yearOf: viennaYearOfDate,
        })
      : new Map<string, CustomGroup>(),
    involveDe: input.involveDe,
    involveFi: input.involveFi,
    involveCustom: input.involveCustom,
  };
}

/** Σ standalone frozen-component targets of one year (AT + DE + FI + custom groups). */
export function frozenTargetForYear(state: FrozenComponentState, year: number): number {
  return floorCents(
    atTargetForYear(state.transactions, state.dividendRows, state.realizations, year) +
      (state.involveDe ? deTargetForYear(state.deEvents, year) : 0) +
      (state.involveFi
        ? fiTargetForYear(
            state.transactions,
            state.dividendRows,
            state.fifoRealizations,
            year,
            viennaYearOfDate,
          )
        : 0) +
      (state.involveCustom ? customTargetForYear(state.customGroups, year) : 0),
  );
}

/**
 * A closed year's locked residue (#635): the gap between the tax actually
 * HELD and the standalone frozen decomposition, both evaluated on the
 * PRE-mutation state. While the year was open, the live derivation held
 * joint-pool amounts — attached marginals AND unattached corrections — that
 * need not decompose into the per-regime standalone targets (DE allowance
 * sharing, the FI threshold, chained custom carry). Whatever that gap is
 * when a mutation touches the closed year, the machinery preserves it:
 * every settlement targets `Σ standalone frozen targets (post-mutation) +
 * residue`, so held shifts by exactly the CHANGE in the frozen
 * decomposition and the state the year locked in — healed, deliberately
 * refunded, or solvency-deferred — survives by construction. On data whose
 * held already equals the decomposition (all pre-#635 history) the residue
 * is 0 and behavior is byte-identical to the recording-time machinery.
 *
 * The same mechanism deliberately preserves pre-#635 LEGACY drift (closed
 * years whose held never settled because a historical `none`/`manual`-era
 * backdated write skipped settlement): post hoc it is indistinguishable from
 * legitimate open-era state, so a "repair" would wholesale re-tax the year
 * onto the standalone decomposition — exactly what Option A forbids (§16
 * 2026-07-22: a year locks in whatever settled state it reached). The #669
 * owner-logged decision is to PRESERVE it as residue; the matrix test pins
 * that every mutation path conserves it while still settling its own ΔF.
 */
export function lockedResidueForYear(
  baseline: FrozenComponentState,
  movements: readonly CashMovementRecord[],
  year: number,
): number {
  return floorCents(
    heldForYear(baseline.transactions, baseline.dividendRows, movements, year) -
      frozenTargetForYear(baseline, year),
  );
}

/** The rows of one side (pre- or post-mutation) of a mutation. */
export interface ClosedMutationRows {
  transactions: readonly TransactionRecord[];
  dividendRows: readonly DividendRecord[];
}

/** The mode-independent facts {@link scopeClosedMutation} scopes a mutation from. */
export interface ClosedMutationScopeInput {
  /** Pre-mutation rows (a delete's removed row still present). */
  before: ClosedMutationRows;
  /** Post-mutation rows (a delete's removed row gone; pending batch rows are NOT rows yet). */
  after: ClosedMutationRows;
  /** Tax movements (pre-mutation superset) — corrections can carry years whose rows are gone. */
  movements: readonly CashMovementRecord[];
  /**
   * Years the mutation writes rows into or removes rows from directly:
   * pending batch sell years, the recorded/deleted dividend's year, the
   * deleted transaction's year. Open years are filtered out here.
   */
  mutationYears: readonly number[];
  /**
   * Assets whose trade history the mutation changes (every batch input's
   * asset / the deleted transaction's asset). Realizations are per-asset —
   * moving averages and FIFO lots — so only these assets' engine-frozen
   * sells can be reshaped. Empty for dividend mutations.
   */
  mutatedAssetIds: ReadonlySet<string>;
  /**
   * The regime steering NEW engine events, when the path records any — it
   * can introduce chain-sensitive events (a pending DE sell into a closed
   * year changes that year's pot-outs) before any frozen row of that regime
   * exists. Omit on paths that add no engine events (non-engine writes,
   * deletes).
   */
  recordingRegime?: OpenRegime;
  /** First open Vienna year (∞ under the manual regime: every year is closed-machinery). */
  openFrom: number;
}

/** What {@link scopeClosedMutation} derives — shared by every mutation path. */
export interface ClosedMutationScope {
  /** Frozen DE rows exist on either side (or the recording regime is DE). */
  involveDe: boolean;
  /** Frozen FI rows exist on either side (or the recording regime is FI). */
  involveFi: boolean;
  /** Frozen custom rows exist on either side (or the recording regime is custom). */
  involveCustom: boolean;
  /**
   * Chain-sensitive state is present: DE pots or a carry/FIFO custom group
   * (frozen on either side, or introduced by the recording regime). A changed
   * year then changes what enters every later engine year.
   */
  chainSensitive: boolean;
  /**
   * THE affected closed years, ascending: every closed year the mutation can
   * reshape. A year whose decomposition did not move settles to a zero
   * correction and posts nothing — over-inclusion is safe by construction,
   * under-inclusion is the #656 bug class this module exists to kill.
   */
  years: number[];
}

/**
 * Derive which regimes a mutation involves — ONE derivation for both sides
 * of every delta, so the frozen decompositions can never omit different
 * components on the two sides.
 */
function involvedRegimes(
  input: Pick<ClosedMutationScopeInput, 'before' | 'after' | 'recordingRegime'>,
): Pick<ClosedMutationScope, 'involveDe' | 'involveFi' | 'involveCustom' | 'chainSensitive'> {
  const { before, after, recordingRegime } = input;
  const involveDe =
    (recordingRegime?.kind === 'country' && recordingRegime.country === TAX_COUNTRY_DE) ||
    portfolioHasDeRows(before.transactions, before.dividendRows) ||
    portfolioHasDeRows(after.transactions, after.dividendRows);
  const involveFi =
    (recordingRegime?.kind === 'country' && recordingRegime.country === TAX_COUNTRY_FI) ||
    before.transactions.some(isFiSell) ||
    after.transactions.some(isFiSell) ||
    before.dividendRows.some(isFiDividend) ||
    after.dividendRows.some(isFiDividend);
  const activeParams = recordingRegime?.kind === 'custom' ? recordingRegime.params : null;
  const involveCustom =
    activeParams !== null ||
    before.transactions.some(isCustomSell) ||
    after.transactions.some(isCustomSell) ||
    before.dividendRows.some(isCustomDividend) ||
    after.dividendRows.some(isCustomDividend);
  const chainSensitive =
    involveDe ||
    (involveCustom &&
      (customChainSensitive(before.transactions, before.dividendRows, activeParams) ||
        customChainSensitive(after.transactions, after.dividendRows, null)));
  return { involveDe, involveFi, involveCustom, chainSensitive };
}

/**
 * THE closed-year scoping choke point (#669): the affected closed years of
 * ANY mutation, computed from mode-independent facts. Sources:
 *
 *  1. The years the mutation directly writes into / removes from
 *     (`mutationYears`).
 *  2. Every year (either side) holding an engine-frozen sell of a mutated
 *     asset — a (back)dated trade reshapes its asset's moving average under
 *     later AT sells and its FIFO lot consumption under DE/FI/custom-FIFO
 *     sells, in any year (#656 round 3: no per-regime gate may narrow this).
 *  3. With chain-sensitive state involved, every engine-settled year after
 *     the earliest candidate — a changed year changes its carry-outs, which
 *     ripple into every later engine year.
 */
export function scopeClosedMutation(input: ClosedMutationScopeInput): ClosedMutationScope {
  const regimes = involvedRegimes(input);
  const years = new Set<number>();
  for (const year of input.mutationYears) {
    if (year < input.openFrom) years.add(year);
  }
  const addMutatedAssetSells = (transactions: readonly TransactionRecord[]): void => {
    for (const t of transactions) {
      if (t.side !== 'sell' || !isEngineTaxed(t.taxMode)) continue;
      if (!input.mutatedAssetIds.has(t.assetId)) continue;
      const year = viennaYearOfDate(t.executedAt);
      if (year < input.openFrom) years.add(year);
    }
  };
  addMutatedAssetSells(input.before.transactions);
  addMutatedAssetSells(input.after.transactions);
  if (regimes.chainSensitive && years.size > 0) {
    const minYear = Math.min(...years);
    const rippleFrom = (rows: ClosedMutationRows): void => {
      for (const year of engineTaxedYears(rows.transactions, rows.dividendRows, input.movements)) {
        if (year > minYear && year < input.openFrom) years.add(year);
      }
    };
    rippleFrom(input.before);
    rippleFrom(input.after);
  }
  return { ...regimes, years: [...years].sort((a, b) => a - b) };
}

/** One closed year's centralized reshape settlement. */
export interface ClosedYearCorrection {
  year: number;
  /** Signed settlement delta: positive = withhold, negative = refund. */
  deltaEur: number;
}

/** Input of {@link closedReshapeCorrections}: both sides of the mutation. */
export interface ClosedReshapeInput {
  /** The affected closed years ({@link scopeClosedMutation}), any order. */
  years: readonly number[];
  /** Pre-mutation decomposition + the movements its held/residue read from. */
  before: FrozenComponentState;
  movementsBefore: readonly CashMovementRecord[];
  /** Post-mutation decomposition + the movements the post-mutation held reads from. */
  after: FrozenComponentState;
  movementsAfter: readonly CashMovementRecord[];
}

/**
 * THE closed-year reshape settlement (#669): for every affected year, the
 * correction that keeps held tracking the frozen decomposition by exactly its
 * change,
 *
 *     Δ = (ΣF_after − ΣF_before) + (held_before − held_after)
 *
 * — algebraically identical to targeting `ΣF_after + residue` against the
 * post-mutation held (the held terms cancel against the residue), so the
 * year's locked open-era state survives by construction. The held shift is
 * non-zero only when the mutation itself removed attached engine tax (a
 * deleted engine-taxed row and its cascaded movements). Zero-delta years post
 * nothing. Signed on purpose: a reshape is a data correction, exempt from any
 * regime's no-refund ratchet (§16).
 */
export function closedReshapeCorrections(input: ClosedReshapeInput): ClosedYearCorrection[] {
  const corrections: ClosedYearCorrection[] = [];
  for (const year of [...input.years].sort((a, b) => a - b)) {
    const deltaEur = floorCents(
      frozenTargetForYear(input.after, year) -
        frozenTargetForYear(input.before, year) +
        heldForYear(
          input.before.transactions,
          input.before.dividendRows,
          input.movementsBefore,
          year,
        ) -
        heldForYear(input.after.transactions, input.after.dividendRows, input.movementsAfter, year),
    );
    if (deltaEur !== 0) corrections.push({ year, deltaEur });
  }
  return corrections;
}
