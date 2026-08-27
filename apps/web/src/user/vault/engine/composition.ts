import {
  taxYearReportResponseSchema,
  type PortfolioAsset,
  type TaxCountry,
  type TaxSettingsResponse,
  type TaxYearReportResponse,
} from '@bettertrack/contracts';
import { floorCents } from '@bettertrack/domain/cashLedger';
import {
  deCarryPots,
  dePotCategoryForAssetType,
  settleAtYear,
  settleDeYear,
  type DeTaxableEvent,
} from '@bettertrack/domain/tax';

import { VaultMoneyEngineError, moneyFailure, type VaultMoneyFailure } from './errors';
import { activeTaxRegime, taxRegimeForRow, type TaxRegime } from './taxEngine';

export const LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY =
  'vaultComposition.lockedPortfoliosQualifierOne' as const;
export const LOCKED_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY =
  'vaultComposition.lockedPortfoliosQualifierOther' as const;
export const UNREADABLE_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY =
  'vaultComposition.unreadablePortfoliosQualifierOne' as const;
export const UNREADABLE_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY =
  'vaultComposition.unreadablePortfoliosQualifierOther' as const;

export interface LockedPortfoliosQualifier {
  kind: 'locked-portfolios';
  count: number;
  messageKey:
    | typeof LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY
    | typeof LOCKED_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY;
}

/**
 * Locked AND corrupt members in one honest count: every portfolio of the scope
 * whose figures are missing from the number this qualifier hangs on. The exact
 * split stays available on the coverage itself.
 */
export interface UnreadablePortfoliosQualifier {
  kind: 'unreadable-portfolios';
  count: number;
  messageKey:
    | typeof UNREADABLE_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY
    | typeof UNREADABLE_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY;
}

/**
 * How much of the scope a figure actually covers.
 *
 * The degraded arm deliberately keeps `kind: 'partial'` rather than inventing a
 * third discriminant: every renderer already treats `partial` as "must print
 * the qualifier", and a new kind would have slipped past those checks as an
 * unqualified bare number — the failure mode this type exists to prevent.
 */
export type PortfolioFigureCoverage =
  | {
      kind: 'complete';
      visiblePortfolioCount: number;
      lockedPortfolioCount: 0;
      qualifier: null;
    }
  | {
      kind: 'partial';
      visiblePortfolioCount: number;
      lockedPortfolioCount: number;
      qualifier: LockedPortfoliosQualifier;
    }
  | {
      kind: 'partial';
      visiblePortfolioCount: number;
      lockedPortfolioCount: number;
      /** Members whose own data could not be read; never counted as zero. */
      unavailablePortfolioCount: number;
      qualifier: UnreadablePortfoliosQualifier;
    };

/** Coverage of a scope that produced no figure at all. */
export interface UnavailablePortfolioCoverage {
  kind: 'unavailable';
  visiblePortfolioCount: 0;
  lockedPortfolioCount: number;
  unavailablePortfolioCount: number;
}

/** One member that degraded out of the composition, named and typed. */
export interface CompositionMemberFailure {
  portfolioId: string;
  error: VaultMoneyFailure;
}

/**
 * The typed "no basis for any number" result. Returned instead of a zero when
 * no member of a non-empty scope could contribute — the seam's own answer to
 * the all-locked question, so no consumer has to remember to ask it first.
 */
export interface UnavailableComposition {
  kind: 'unavailable';
  coverage: UnavailablePortfolioCoverage;
  memberFailures: readonly CompositionMemberFailure[];
}

/**
 * The only public aggregate-figure shape. A partial value cannot exist without
 * its "+ N locked portfolios" rendering instruction, so aggregate consumers
 * never receive a silently incomplete bare number (paranoid design §14). A
 * figure of this type therefore always rests on at least one readable member:
 * a scope with none yields {@link UnavailableComposition} instead (#1514).
 */
export interface QualifiedPortfolioFigure {
  valueEur: number;
  coverage: PortfolioFigureCoverage;
}

export type PortfolioCompositionMember<T> =
  | {
      state: 'visible';
      portfolioId: string;
      source: 'plain' | 'vaulted';
      vaultId: string | null;
      value: T;
    }
  | {
      state: 'locked';
      portfolioId: string;
      vaultId: string;
    };

/**
 * The complete portfolio catalog for the aggregate's scope. This must come
 * from the authoritative portfolio/vault listing, independently of whichever
 * portfolios currently have values available to compose.
 */
export type AuthoritativePortfolioRosterEntry =
  | {
      portfolioId: string;
      source: 'plain';
      vaultId: null;
    }
  | {
      portfolioId: string;
      source: 'vaulted';
      vaultId: string;
    };

export interface PortfolioCompositionInput<T> {
  /** Complete authoritative roster for this aggregate, never derived from `members`. */
  authoritativeRoster: readonly AuthoritativePortfolioRosterEntry[];
  /** One visible value or locked stub for every authoritative roster entry. */
  members: readonly PortfolioCompositionMember<T>[];
}

export interface AdditivePortfolioFigures {
  totalValueEur: number;
  marketValueEur: number;
  investedEur: number;
  unrealizedPnlEur: number;
  dayChangeEur: number;
  cashEur: number;
  realizedPnlEur: number;
  dividendsGrossEur: number;
}

export type ComposedPortfolioFigures = {
  [K in keyof AdditivePortfolioFigures]: QualifiedPortfolioFigure;
};

export type SelectedComposedPortfolioFigures<K extends keyof AdditivePortfolioFigures> = {
  [P in K]: QualifiedPortfolioFigure;
};

export type ComposedPortfolioFiguresResult =
  | ({ kind: 'composed' } & ComposedPortfolioFigures)
  | UnavailableComposition;

export type SelectedComposedPortfolioFiguresResult<K extends keyof AdditivePortfolioFigures> =
  | ({ kind: 'composed' } & SelectedComposedPortfolioFigures<K>)
  | UnavailableComposition;

const ADDITIVE_FIGURE_KEYS = [
  'totalValueEur',
  'marketValueEur',
  'investedEur',
  'unrealizedPnlEur',
  'dayChangeEur',
  'cashEur',
  'realizedPnlEur',
  'dividendsGrossEur',
] as const satisfies readonly (keyof AdditivePortfolioFigures)[];

/** Merge already-derived, additive portfolio figures at their domain boundary. */
export function composePortfolioFigures(
  input: PortfolioCompositionInput<AdditivePortfolioFigures>,
): ComposedPortfolioFiguresResult;
/** Merge an explicit projection when a consumer has only that audited figure subset. */
export function composePortfolioFigures<const K extends keyof AdditivePortfolioFigures>(
  input: PortfolioCompositionInput<Pick<AdditivePortfolioFigures, K>>,
  keys: readonly K[],
): SelectedComposedPortfolioFiguresResult<K>;
export function composePortfolioFigures(
  input: PortfolioCompositionInput<Partial<AdditivePortfolioFigures>>,
  keys: readonly (keyof AdditivePortfolioFigures)[] = ADDITIVE_FIGURE_KEYS,
): ({ kind: 'composed' } & Partial<ComposedPortfolioFigures>) | UnavailableComposition {
  const { authoritativeRoster, members } = input;
  assertCompleteAuthoritativeRoster(authoritativeRoster, members);
  const visible = members.filter(
    (member): member is Extract<(typeof members)[number], { state: 'visible' }> =>
      member.state === 'visible',
  );
  const counts: MemberCoverageCounts = {
    visible: visible.length,
    locked: members.filter((member) => member.state === 'locked').length,
    unreadable: 0,
  };
  if (unavailableScope(members, counts)) return unavailableComposition(counts, []);
  const coverage = coverageFor(counts);
  const figures = Object.fromEntries(
    keys.map((key) => [
      key,
      qualifyMoney(
        visible.reduce((total, member) => {
          const value = member.value[key];
          requireFinite(value, `${member.portfolioId}.${key}`);
          return total + value;
        }, 0),
        coverage,
      ),
    ]),
  ) as Partial<ComposedPortfolioFigures>;
  return { kind: 'composed', ...figures };
}

export interface VisiblePortfolioTax {
  /** One report for every authoritative activity year through the requested year. */
  reports: readonly TaxYearReportResponse[];
  /** Exact year index returned by the portfolio's tax engine/server endpoint. */
  authoritativeActivityYears: readonly number[];
  /** Living settings used by the same row-regime classifier as the client engine. */
  effectiveSettings: Pick<TaxSettingsResponse, 'mode' | 'country' | 'custom'>;
}

export type PortfolioTaxCompositionMember = PortfolioCompositionMember<VisiblePortfolioTax>;

export interface DeTaxCompositionFigures {
  allowanceUsedEur: QualifiedPortfolioFigure;
  allowanceRemainingEur: QualifiedPortfolioFigure;
  aktienPotInEur: QualifiedPortfolioFigure;
  aktienPotOutEur: QualifiedPortfolioFigure;
  sonstigePotInEur: QualifiedPortfolioFigure;
  sonstigePotOutEur: QualifiedPortfolioFigure;
  kapestEur: QualifiedPortfolioFigure;
  soliEur: QualifiedPortfolioFigure;
}

export interface ComposedCountryTaxYear {
  year: number;
  country: Extract<TaxCountry, 'AT' | 'DE'>;
  taxTargetEur: QualifiedPortfolioFigure;
  realizedPnlEur: QualifiedPortfolioFigure;
  dividendsGrossEur: QualifiedPortfolioFigure;
  de: DeTaxCompositionFigures | null;
  /**
   * Exactly the portfolios this composition dropped because their own data
   * could not be read — never the locked ones, which the coverage counts
   * separately. Empty on a clean compose; otherwise it names every degraded
   * portfolio and matches the coverage's `unavailablePortfolioCount`.
   */
  memberFailures: readonly CompositionMemberFailure[];
}

export type ComposedCountryTaxYearResult =
  | ({ kind: 'composed' } & ComposedCountryTaxYear)
  | UnavailableComposition;

interface TaxEvent {
  year: number;
  at: string;
  id: string;
  kind: 'sell_gain' | 'dividend';
  amountEur: number;
  asset: PortfolioAsset;
}

/**
 * Compose AT/DE loss-offset tax across plain server reports and client reports.
 * Event extraction is plumbing; all tax targets, loss pots and allowances are
 * computed by the same `@bettertrack/domain/tax` functions as the server.
 *
 * SEMANTICS (T1 ruling, pinned by tests): this is ONE pooled settlement over
 * the union of every visible portfolio's events — one Sparer-Pauschbetrag for
 * the person, loss pots chained over the pooled prior-year stream, losses in
 * one portfolio offsetting gains in another. It answers "what would this look
 * like as a single combined depot" and therefore intentionally does NOT equal
 * the sum of the per-portfolio settlements (separate paying agents each apply
 * their own allowance and never see each other's losses). Precision contract:
 * settlement consumes the reports' full-precision per-row figures raw; cent
 * flooring happens only at this module's reported presentation boundary,
 * mirroring the server report's own quantization.
 *
 * FAILURE CHANNELS (#1514): one corrupt member must not take the healthy
 * portfolios' figures with it, and a corrupt member must never be read as a
 * zero contribution either. Two disjoint channels enforce that. Member DATA —
 * report row shapes and their money figures, all derived from a decrypted
 * vault document and therefore attacker-influenced — degrades that member to a
 * typed {@link CompositionMemberFailure} counted as unavailable coverage.
 * CALLER CONTRACT breaches — a non-integer year, a roster mismatch, a
 * duplicated portfolio, an incomplete report index — still throw, because only
 * a code change at the call site can fix them and swallowing them would hide a
 * wiring bug behind a plausible-looking number.
 */
export function composeCountryTaxYear(
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  year: number,
  input: PortfolioCompositionInput<VisiblePortfolioTax>,
): ComposedCountryTaxYearResult {
  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new RangeError(`Unsupported tax composition year ${year}.`);
  }
  const { authoritativeRoster, members } = input;
  assertCompleteAuthoritativeRoster(authoritativeRoster, members);

  const visibleMembers: ReadTaxMember[] = [];
  const memberFailures: CompositionMemberFailure[] = [];
  for (const member of members) {
    if (member.state !== 'visible') continue;
    try {
      visibleMembers.push(readMemberReports(member, country, year));
    } catch (cause) {
      // The ONLY channel that degrades: a typed vault-data failure. A
      // TypeError/RangeError from the contract assertions above is a caller
      // bug and keeps propagating, so the two can never be confused.
      if (!(cause instanceof VaultMoneyEngineError)) throw cause;
      memberFailures.push({ portfolioId: member.portfolioId, error: cause.failure });
    }
  }

  const counts: MemberCoverageCounts = {
    visible: visibleMembers.length,
    locked: members.filter((member) => member.state === 'locked').length,
    unreadable: memberFailures.length,
  };
  if (unavailableScope(members, counts)) return unavailableComposition(counts, memberFailures);
  const coverage = coverageFor(counts);

  const events = visibleMembers
    .flatMap((member) => member.events)
    .sort(
      (left, right) =>
        left.year - right.year ||
        (left.at < right.at ? -1 : left.at > right.at ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  const currentEvents = events.filter((event) => event.year === year);
  const realizedPnlEur = floorCents(
    currentEvents
      .filter((event) => event.kind === 'sell_gain')
      .reduce((total, event) => total + event.amountEur, 0),
  );
  const dividendsGrossEur = floorCents(
    currentEvents
      .filter((event) => event.kind === 'dividend')
      .reduce((total, event) => total + event.amountEur, 0),
  );

  if (country === 'AT') {
    const settlement = settleAtYear({
      existingGainsEur: currentEvents
        .filter((event) => event.kind === 'sell_gain')
        .map((event) => event.amountEur),
      existingDividendsEur: currentEvents
        .filter((event) => event.kind === 'dividend')
        .map((event) => event.amountEur),
      heldEur: 0,
      newEvents: [],
    });
    return {
      kind: 'composed',
      year,
      country,
      taxTargetEur: qualifyMoney(settlement.heldAfterEur, coverage),
      realizedPnlEur: qualifyMoney(realizedPnlEur, coverage),
      dividendsGrossEur: qualifyMoney(dividendsGrossEur, coverage),
      de: null,
      memberFailures,
    };
  }

  const priorYears = [...new Set(events.map((event) => event.year))]
    .filter((eventYear) => eventYear < year)
    .sort((left, right) => left - right);
  const pots = deCarryPots(
    priorYears.map((priorYear) =>
      events.filter((event) => event.year === priorYear).map(toDeTaxableEvent),
    ),
  );
  const aktienPotInEur = floorCents(pots.aktienEur);
  const sonstigePotInEur = floorCents(pots.sonstigeEur);
  const settlement = settleDeYear({
    aktienPotInEur: pots.aktienEur,
    sonstigePotInEur: pots.sonstigeEur,
    existingEvents: currentEvents.map(toDeTaxableEvent),
    heldEur: 0,
    newEvents: [],
  });
  return {
    kind: 'composed',
    year,
    country,
    taxTargetEur: qualifyMoney(settlement.heldAfterEur, coverage),
    realizedPnlEur: qualifyMoney(realizedPnlEur, coverage),
    dividendsGrossEur: qualifyMoney(dividendsGrossEur, coverage),
    memberFailures,
    // The reported DE block mirrors the server report's presentation boundary
    // (taxService.deSummaryForYear): allowance and pot figures floor to cents
    // HERE — after settlement ran on the raw values — so the composed panel
    // and the portfolio page quantize identically. kapest/soli arrive already
    // cent-exact from the engine and pass through.
    de: {
      allowanceUsedEur: qualifyMoney(floorCents(settlement.yearEnd.allowanceUsedEur), coverage),
      allowanceRemainingEur: qualifyMoney(
        floorCents(settlement.yearEnd.allowanceRemainingEur),
        coverage,
      ),
      aktienPotInEur: qualifyMoney(aktienPotInEur, coverage),
      aktienPotOutEur: qualifyMoney(floorCents(settlement.yearEnd.aktienPotOutEur), coverage),
      sonstigePotInEur: qualifyMoney(sonstigePotInEur, coverage),
      sonstigePotOutEur: qualifyMoney(floorCents(settlement.yearEnd.sonstigePotOutEur), coverage),
      kapestEur: qualifyMoney(settlement.yearEnd.kapestEur, coverage),
      soliEur: qualifyMoney(settlement.yearEnd.soliEur, coverage),
    },
  };
}

function toDeTaxableEvent(event: TaxEvent): DeTaxableEvent {
  return event.kind === 'dividend'
    ? { kind: 'dividend', amountEur: event.amountEur }
    : {
        kind: 'sell_gain',
        category: dePotCategoryForAssetType(event.asset.type),
        amountEur: event.amountEur,
      };
}

/** One visible member reduced to the events it contributes to the pooled stream. */
interface ReadTaxMember {
  portfolioId: string;
  events: readonly TaxEvent[];
}

/**
 * Validate one member's own reports and extract its events.
 *
 * Throws a typed {@link VaultMoneyEngineError} for vault-data problems (the
 * caller degrades that member) and a plain RangeError/TypeError for caller
 * contract breaches (the caller lets them out). Nothing here is caught locally,
 * so the two channels stay visibly separate.
 */
function readMemberReports(
  member: Extract<PortfolioTaxCompositionMember, { state: 'visible' }>,
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  year: number,
): ReadTaxMember {
  const reports = parseMemberReports(member);
  assertMemberYearIndex(member, reports, year);
  const activeRegime = activeTaxRegime(member.value.effectiveSettings);
  return {
    portfolioId: member.portfolioId,
    events: reports.flatMap((report) =>
      taxEvents(report, country, activeRegime, member.portfolioId),
    ),
  };
}

/** DATA boundary: a report that fails its contract schema degrades its member. */
function parseMemberReports(
  member: Extract<PortfolioTaxCompositionMember, { state: 'visible' }>,
): TaxYearReportResponse[] {
  return member.value.reports.map((report) => {
    const parsed = taxYearReportResponseSchema.safeParse(report);
    if (parsed.success) return parsed.data;
    throw moneyFailure(
      'TAX_DATA_INVALID',
      `Portfolio ${member.portfolioId} supplied a tax report that failed schema validation.`,
      { details: { portfolioId: member.portfolioId } },
    );
  });
}

/**
 * CALLER boundary: the report index this member was assembled with. The years
 * come from the caller's own tax-engine query, not from vault content, so an
 * inconsistent index is a wiring bug and stays loud rather than degrading a
 * portfolio the user can actually read.
 */
function assertMemberYearIndex(
  member: Extract<PortfolioTaxCompositionMember, { state: 'visible' }>,
  reports: readonly TaxYearReportResponse[],
  year: number,
): void {
  const reportYears = new Set<number>();
  for (const report of reports) {
    if (report.year > year) {
      throw new RangeError(
        `Portfolio ${member.portfolioId} supplied future tax year ${report.year}.`,
      );
    }
    if (reportYears.has(report.year)) {
      throw new TypeError(
        `Portfolio ${member.portfolioId} supplied tax year ${report.year} more than once.`,
      );
    }
    reportYears.add(report.year);
  }
  const activityYears = new Set<number>();
  for (const activityYear of member.value.authoritativeActivityYears) {
    if (!Number.isInteger(activityYear) || activityYear < 1900 || activityYear > 3000) {
      throw new RangeError(
        `Portfolio ${member.portfolioId} supplied invalid activity year ${activityYear}.`,
      );
    }
    if (activityYears.has(activityYear)) {
      throw new TypeError(
        `Portfolio ${member.portfolioId} supplied activity year ${activityYear} more than once.`,
      );
    }
    activityYears.add(activityYear);
  }
  const requiredYears = new Set([
    year,
    ...[...activityYears].filter((activityYear) => activityYear <= year),
  ]);
  const missingYears = [...requiredYears]
    .filter((requiredYear) => !reportYears.has(requiredYear))
    .sort((left, right) => left - right);
  if (missingYears.length > 0) {
    throw new RangeError(
      `Portfolio ${member.portfolioId} did not supply required tax year(s) ${missingYears.join(', ')}.`,
    );
  }
}

function taxEvents(
  report: TaxYearReportResponse,
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  activeRegime: TaxRegime,
  portfolioId: string,
): TaxEvent[] {
  const events: TaxEvent[] = [];
  for (const position of report.positions) {
    for (const sell of position.sells) {
      if (countryForRegime(taxRegimeForRow(sell, activeRegime)) !== country) continue;
      requireFiniteReportFigure(
        sell.realizedPnlEur,
        `${sell.transactionId}.realizedPnlEur`,
        portfolioId,
      );
      events.push({
        year: report.year,
        at: sell.executedAt,
        id: sell.transactionId,
        kind: 'sell_gain',
        amountEur: sell.realizedPnlEur,
        asset: position.asset,
      });
    }
    for (const dividend of position.dividends) {
      if (countryForRegime(taxRegimeForRow(dividend, activeRegime)) !== country) {
        continue;
      }
      requireFiniteReportFigure(
        dividend.grossAmountEur,
        `${dividend.dividendId}.grossAmountEur`,
        portfolioId,
      );
      events.push({
        year: report.year,
        at: dividend.executedAt,
        id: dividend.dividendId,
        kind: 'dividend',
        amountEur: dividend.grossAmountEur,
        asset: position.asset,
      });
    }
  }
  return events;
}

function countryForRegime(regime: TaxRegime): TaxCountry | null {
  if (regime.kind === 'at') return 'AT';
  if (regime.kind === 'de') return 'DE';
  return null;
}

/** How the scope's members resolved: contributing, sealed, or unreadable. */
interface MemberCoverageCounts {
  visible: number;
  locked: number;
  unreadable: number;
}

/**
 * The invariant this whole module exists for, evaluated once at the seam.
 *
 * A qualifier needs something to qualify. With no contributing member the
 * figures would come back as 0 — not because the money is zero but because
 * none of it could be read — and "0,00 € + 1 locked portfolio" states a
 * balance nobody has a basis for. An EMPTY scope is the honest exception: zero
 * portfolios really are worth zero, and there is nothing being withheld.
 */
function unavailableScope<T>(
  members: readonly PortfolioCompositionMember<T>[],
  counts: MemberCoverageCounts,
): boolean {
  return members.length > 0 && counts.visible === 0;
}

function unavailableComposition(
  counts: MemberCoverageCounts,
  memberFailures: readonly CompositionMemberFailure[],
): UnavailableComposition {
  return {
    kind: 'unavailable',
    coverage: {
      kind: 'unavailable',
      visiblePortfolioCount: 0,
      lockedPortfolioCount: counts.locked,
      unavailablePortfolioCount: counts.unreadable,
    },
    memberFailures,
  };
}

function coverageFor(counts: MemberCoverageCounts): PortfolioFigureCoverage {
  const visiblePortfolioCount = counts.visible;
  const lockedPortfolioCount = counts.locked;
  if (lockedPortfolioCount === 0 && counts.unreadable === 0) {
    return {
      kind: 'complete',
      visiblePortfolioCount,
      lockedPortfolioCount: 0,
      qualifier: null,
    };
  }
  if (counts.unreadable === 0) {
    return {
      kind: 'partial',
      visiblePortfolioCount,
      lockedPortfolioCount,
      qualifier: {
        kind: 'locked-portfolios',
        count: lockedPortfolioCount,
        messageKey:
          lockedPortfolioCount === 1
            ? LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY
            : LOCKED_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY,
      },
    };
  }
  const missing = lockedPortfolioCount + counts.unreadable;
  return {
    kind: 'partial',
    visiblePortfolioCount,
    lockedPortfolioCount,
    unavailablePortfolioCount: counts.unreadable,
    qualifier: {
      kind: 'unreadable-portfolios',
      count: missing,
      messageKey:
        missing === 1
          ? UNREADABLE_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY
          : UNREADABLE_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY,
    },
  };
}

function qualifyMoney(
  valueEur: number,
  coverage: PortfolioFigureCoverage,
): QualifiedPortfolioFigure {
  requireFinite(valueEur, 'composed figure');
  return { valueEur, coverage };
}

function assertCompleteAuthoritativeRoster<T>(
  authoritativeRoster: readonly AuthoritativePortfolioRosterEntry[],
  members: readonly PortfolioCompositionMember<T>[],
): void {
  const rosterByPortfolioId = new Map<string, AuthoritativePortfolioRosterEntry>();
  for (const rosterEntry of authoritativeRoster) {
    if (rosterByPortfolioId.has(rosterEntry.portfolioId)) {
      throw new TypeError(
        `Portfolio ${rosterEntry.portfolioId} occurs more than once in the authoritative roster.`,
      );
    }
    rosterByPortfolioId.set(rosterEntry.portfolioId, rosterEntry);
  }

  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.portfolioId)) {
      throw new TypeError(`Portfolio ${member.portfolioId} occurs more than once in composition.`);
    }
    seen.add(member.portfolioId);
    const rosterEntry = rosterByPortfolioId.get(member.portfolioId);
    if (!rosterEntry) {
      throw new TypeError(
        `Portfolio ${member.portfolioId} is not present in the authoritative roster.`,
      );
    }
    if (member.state === 'visible') {
      if (member.source === 'plain' && member.vaultId !== null) {
        throw new TypeError(`Plain portfolio ${member.portfolioId} cannot name a vault.`);
      }
      if (member.source === 'vaulted' && member.vaultId === null) {
        throw new TypeError(`Vaulted portfolio ${member.portfolioId} must name its vault.`);
      }
      if (member.source !== rosterEntry.source || member.vaultId !== rosterEntry.vaultId) {
        throw new TypeError(
          `Portfolio ${member.portfolioId} does not match its authoritative storage location.`,
        );
      }
    } else if (rosterEntry.source !== 'vaulted' || member.vaultId !== rosterEntry.vaultId) {
      throw new TypeError(
        `Locked portfolio ${member.portfolioId} does not match its authoritative vault.`,
      );
    }
  }

  for (const rosterEntry of authoritativeRoster) {
    if (!seen.has(rosterEntry.portfolioId)) {
      throw new TypeError(
        `Portfolio ${rosterEntry.portfolioId} is missing from the authoritative composition roster resolution.`,
      );
    }
  }
}

/**
 * The finite backstop for figures the CALLER derived and handed over. Their
 * provenance is our own engine, so a non-finite one is a programmer error.
 */
function requireFinite(value: unknown, label: string): asserts value is number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite money figure.`);
}

/**
 * The same backstop one layer out, at the vault-DATA boundary — and it is
 * load-bearing, not belt-and-braces: zod's `z.number()` ACCEPTS Infinity, so a
 * schema-valid report can still carry a non-finite figure straight into a
 * domain settlement. Here the figure came from a decrypted document, so the
 * honest answer is to degrade that one portfolio rather than to crash the
 * composed view of every other portfolio (#1514).
 */
function requireFiniteReportFigure(
  value: unknown,
  label: string,
  portfolioId: string,
): asserts value is number {
  if (!Number.isFinite(value)) {
    throw moneyFailure(
      'TAX_DATA_INVALID',
      `Portfolio ${portfolioId} supplied a non-finite ${label}.`,
      { details: { portfolioId } },
    );
  }
}
