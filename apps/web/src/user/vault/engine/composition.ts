import {
  MAX_TAX_REPORT_FIGURE_EUR,
  vaultTaxYearReportResponseSchema,
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

import { asMoneyFailure, moneyFailure, type VaultMoneyFailure } from './errors';
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

  // The same member boundary as the tax seam (#1514 review F5). Home derives
  // these totals from decrypted vault documents, so a member that cannot be
  // read must cost that portfolio and nothing else — it is carried as
  // unavailable coverage, never as a zero that would silently dilute the sum.
  const readable: Record<string, number>[] = [];
  const memberFailures: CompositionMemberFailure[] = [];
  for (const member of members) {
    if (member.state !== 'visible') continue;
    try {
      readable.push(readMemberFigures(member, keys));
    } catch (cause) {
      memberFailures.push({ portfolioId: member.portfolioId, error: asMoneyFailure(cause) });
    }
  }

  const counts: MemberCoverageCounts = {
    visible: readable.length,
    locked: members.filter((member) => member.state === 'locked').length,
    unreadable: memberFailures.length,
  };
  if (unavailableScope(members, counts)) return unavailableComposition(counts, memberFailures);
  const coverage = coverageFor(counts);
  try {
    const figures = Object.fromEntries(
      keys.map((key) => [
        key,
        qualifyMoney(
          readable.reduce((total, value) => total + (value[key] ?? 0), 0),
          coverage,
        ),
      ]),
    ) as Partial<ComposedPortfolioFigures>;
    return { kind: 'composed', ...figures };
  } catch {
    // Unreachable while every member figure is bounded (see readMemberFigures);
    // the honest answer if a bound is ever bypassed is no figure at all.
    return pooledUnavailableComposition(counts, memberFailures);
  }
}

/**
 * One member's additive figures, checked before they join a sum.
 *
 * These are net-worth figures rather than tax data, so a bad one is reported as
 * VAULT_CORRUPT — the code the rest of the vault already uses for a decrypted
 * document that produced something unusable, and the one whose copy actually
 * describes what happened.
 *
 * The magnitude bound is the same one the tax reports carry: it is what makes
 * the pooled addition provably overflow-free, since no realistic total — the
 * widest EUR column behind one is `numeric(20,6)`, ceiling ~1e14 — comes
 * anywhere near it.
 */
function readMemberFigures(
  member: Extract<
    PortfolioCompositionMember<Partial<AdditivePortfolioFigures>>,
    { state: 'visible' }
  >,
  keys: readonly (keyof AdditivePortfolioFigures)[],
): Record<string, number> {
  const unusable = (detail: string): never => {
    throw moneyFailure('VAULT_CORRUPT', `Portfolio ${member.portfolioId} supplied ${detail}.`, {
      details: { portfolioId: member.portfolioId },
    });
  };
  const value: unknown = member.value;
  if (!isPlainRecord(value)) return unusable('a figure set that is not an object');
  const figures: Record<string, number> = {};
  for (const key of keys) {
    const figure = value[key];
    if (
      typeof figure !== 'number' ||
      !Number.isFinite(figure) ||
      Math.abs(figure) > MAX_TAX_REPORT_FIGURE_EUR
    ) {
      unusable(`an unusable ${key}`);
      continue;
    }
    figures[key] = figure;
  }
  return figures;
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
 * zero contribution either. Two disjoint channels enforce that, and the line
 * between them is PROVENANCE — who computed the fact, not how structural it
 * looks:
 *
 *  - Facts the CALLER computes for itself — the requested `year` ARGUMENT, the
 *    authoritative roster it fetched, the member records it assembled — still
 *    THROW. Only a code change at the call site can fix them, and swallowing
 *    one would hide a wiring bug behind a plausible-looking number.
 *  - Everything derived from a VAULT DOCUMENT degrades that one member to a
 *    typed {@link CompositionMemberFailure}, counted as unavailable coverage.
 *
 * That includes the member's report/activity YEAR INDEX, which an earlier
 * revision of this file wrongly filed under "caller contract". For a vaulted
 * portfolio the index is not a call-site fact at all: `taxEngine.clientTaxYears`
 * builds it by scanning the DECRYPTED DOCUMENT's transactions, dividends and
 * cash movements, and `paranoidEnforcement` kills the server's activity-year
 * routes — so for exactly the portfolios this seam exists to protect, the years
 * are attacker-influenced content. A future-stamped report, a duplicated year, a
 * year the index promises but no report carries, a nonsense `effectiveSettings.mode`
 * — all of it is document content, and all of it degrades ONE member.
 *
 * Because the shapes are attacker-influenced, member processing also assumes
 * NOTHING about the runtime shape of `member.value`: the container is validated
 * before it is walked, and any unexpected throw inside member scope degrades
 * that member rather than escaping (a throwing accessor walks straight out of
 * zod's `safeParse`, which catches ZodError and nothing else).
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
      // THE MEMBER BOUNDARY. Everything reachable from here reads a decrypted
      // document, so ANY throw — a typed vault failure, a TypeError off a shape
      // the compile-time type promised and the runtime value did not, a
      // throwing accessor that walked out of `safeParse` — costs exactly this
      // portfolio. The caller-computed checks all ran ABOVE this loop and are
      // still free to propagate, so the two channels cannot be confused.
      memberFailures.push({ portfolioId: member.portfolioId, error: asMoneyFailure(cause) });
    }
  }

  const counts: MemberCoverageCounts = {
    visible: visibleMembers.length,
    locked: members.filter((member) => member.state === 'locked').length,
    unreadable: memberFailures.length,
  };
  if (unavailableScope(members, counts)) return unavailableComposition(counts, memberFailures);
  const coverage = coverageFor(counts);

  try {
    return settleComposedTaxYear(country, year, visibleMembers, coverage, memberFailures);
  } catch {
    // BELT AND BRACES (#1514 review F4). Every figure in the pooled stream came
    // through `vaultTaxYearReportResponseSchema`, so each is finite and within
    // MAX_TAX_REPORT_FIGURE_EUR and the sums below cannot overflow — reaching
    // this arm means a bound was bypassed. A pooled failure cannot be blamed on
    // any single member, so the honest answer is the typed whole-composition
    // unavailable result, never a `CashLedgerError` thrown through the view.
    return pooledUnavailableComposition(counts, memberFailures);
  }
}

/** The pooled settlement itself, once every member has been read and counted. */
function settleComposedTaxYear(
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  year: number,
  visibleMembers: readonly ReadTaxMember[],
  coverage: PortfolioFigureCoverage,
  memberFailures: readonly CompositionMemberFailure[],
): { kind: 'composed' } & ComposedCountryTaxYear {
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
 * Validate one member's own vault-derived data and extract its events.
 *
 * Every throw from here is caught at the member boundary and degrades this one
 * portfolio, so the code below is free to fail on anything it does not like.
 * It runs shape-first: the container before its elements, the regime before
 * the reports, because each step is what makes the next one safe to walk.
 */
function readMemberReports(
  member: Extract<PortfolioTaxCompositionMember, { state: 'visible' }>,
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  year: number,
): ReadTaxMember {
  const value = memberTaxValue(member);
  const activeRegime = activeTaxRegime(value.effectiveSettings);
  if (activeRegime.kind === 'none') {
    // An UNTAXED portfolio contributes nothing and is not corrupt (#1514
    // review F3). Its row classifier answers `none` for every row it holds and
    // `manual` for the rest — neither names a country — so no report of it
    // could ever reach an AT/DE pool. The caller therefore derives no reports
    // for it at all, and demanding a report index from it used to fail the
    // whole composed view over a portfolio that is simply not taxed. It
    // composes as a zero-event member instead: counted as visible, withholding
    // nothing, so the figures it joins stay COMPLETE.
    return { portfolioId: member.portfolioId, events: [] };
  }
  const reports = parseMemberReports(member, value.reports);
  assertMemberYearIndex(member, value.authoritativeActivityYears, reports, year);
  return {
    portfolioId: member.portfolioId,
    events: reports.flatMap((report) =>
      taxEvents(report, country, activeRegime, member.portfolioId),
    ),
  };
}

/** The member value, as far as the declared type can still be trusted at runtime. */
interface MemberTaxValue {
  reports: readonly unknown[];
  authoritativeActivityYears: readonly unknown[];
  effectiveSettings: Pick<TaxSettingsResponse, 'mode' | 'country' | 'custom'>;
}

/**
 * CONTAINER boundary (#1514 review F1): the member value's own shape, checked
 * before anything walks it.
 *
 * The compile-time type says `reports` is an array; a decrypted document is
 * under no obligation to agree. Reaching `.map` on a `null` or a string, or
 * spreading a number as if it were a year index, throws a TypeError from
 * outside every per-element guard — which at review head escaped the whole
 * composition and took the healthy portfolios' figures with it. These four
 * lines are the difference between one degraded member and a blank view.
 */
function memberTaxValue(
  member: Extract<PortfolioTaxCompositionMember, { state: 'visible' }>,
): MemberTaxValue {
  const invalid = (detail: string): never => {
    throw moneyFailure('TAX_DATA_INVALID', `Portfolio ${member.portfolioId} supplied ${detail}.`, {
      details: { portfolioId: member.portfolioId },
    });
  };
  const value: unknown = member.value;
  if (!isPlainRecord(value)) return invalid('a tax member value that is not an object');
  if (!Array.isArray(value.reports)) return invalid('a report set that is not an array');
  if (!Array.isArray(value.authoritativeActivityYears)) {
    return invalid('an activity-year index that is not an array');
  }
  if (!isPlainRecord(value.effectiveSettings)) {
    return invalid('tax settings that are not an object');
  }
  return {
    reports: value.reports,
    authoritativeActivityYears: value.authoritativeActivityYears,
    // Its FIELDS stay untrusted: `activeTaxRegime` validates mode/country/custom
    // and raises a typed failure for nonsense, which degrades this member too.
    effectiveSettings: value.effectiveSettings as MemberTaxValue['effectiveSettings'],
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * DATA boundary: a report that fails its contract schema degrades its member.
 *
 * Validation runs against {@link vaultTaxYearReportResponseSchema} rather than
 * the plain server response contract: same shape, plus the per-row magnitude
 * bound that keeps two individually finite rows from summing to `Infinity`
 * inside the pooled settlement (#1514 review F4).
 */
function parseMemberReports(
  member: Extract<PortfolioTaxCompositionMember, { state: 'visible' }>,
  reports: readonly unknown[],
): TaxYearReportResponse[] {
  return reports.map((report) => {
    const parsed = vaultTaxYearReportResponseSchema.safeParse(report);
    if (parsed.success) return parsed.data;
    throw moneyFailure(
      'TAX_DATA_INVALID',
      `Portfolio ${member.portfolioId} supplied a tax report that failed schema validation.`,
      { details: { portfolioId: member.portfolioId } },
    );
  });
}

/**
 * DATA boundary: the member's report index against its own activity years.
 *
 * PROVENANCE (#1514 review F3, correcting this file's earlier claim): these
 * years are NOT the caller's own facts. For a vaulted portfolio the index comes
 * from `taxEngine.clientTaxYears`, which derives it by scanning the decrypted
 * document's transactions, dividends and cash movements, and the server's
 * activity-year routes are killed by `paranoidEnforcement` — so for exactly the
 * portfolios this seam protects, both the report years and the activity years
 * are document content an attacker can shape. Every anomaly here therefore
 * degrades ONE member rather than throwing the composed view away.
 */
function assertMemberYearIndex(
  member: Extract<PortfolioTaxCompositionMember, { state: 'visible' }>,
  authoritativeActivityYears: readonly unknown[],
  reports: readonly TaxYearReportResponse[],
  year: number,
): void {
  const invalid = (detail: string): never => {
    throw moneyFailure('TAX_DATA_INVALID', `Portfolio ${member.portfolioId} ${detail}.`, {
      details: { portfolioId: member.portfolioId },
    });
  };
  const reportYears = new Set<number>();
  for (const report of reports) {
    if (report.year > year) invalid(`supplied future tax year ${report.year}`);
    if (reportYears.has(report.year)) {
      invalid(`supplied tax year ${report.year} more than once`);
    }
    reportYears.add(report.year);
  }
  const activityYears = new Set<number>();
  for (const activityYear of authoritativeActivityYears) {
    if (
      typeof activityYear !== 'number' ||
      !Number.isInteger(activityYear) ||
      activityYear < 1900 ||
      activityYear > 3000
    ) {
      invalid(`supplied invalid activity year ${String(activityYear)}`);
      continue;
    }
    if (activityYears.has(activityYear)) {
      invalid(`supplied activity year ${activityYear} more than once`);
    }
    activityYears.add(activityYear);
  }
  // Only years the index CLAIMS activity in are required. The requested year
  // itself is not (#1514 review F3): a portfolio whose last trade was in 2024
  // contributes no 2026 events, which makes it dormant, not corrupt — and
  // demanding a 2026 report from it failed the whole view for an ordinary user.
  const missingYears = [...activityYears]
    .filter((activityYear) => activityYear <= year && !reportYears.has(activityYear))
    .sort((left, right) => left - right);
  if (missingYears.length > 0) {
    invalid(`did not supply required tax year(s) ${missingYears.join(', ')}`);
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

/**
 * The pooled-arithmetic backstop (#1514 review F4).
 *
 * A failure in the POOLED step cannot be attributed to any one member — the
 * whole point of this seam is that the members are settled together — so there
 * is no honest way to degrade a portfolio and publish the rest. Every non-locked
 * member is reported as unavailable instead: their figures really are missing
 * from a number that no longer exists. `memberFailures` still names only the
 * members that genuinely failed on their own data; the healthy ones are not
 * slandered with an invented failure.
 */
function pooledUnavailableComposition(
  counts: MemberCoverageCounts,
  memberFailures: readonly CompositionMemberFailure[],
): UnavailableComposition {
  return {
    kind: 'unavailable',
    coverage: {
      kind: 'unavailable',
      visiblePortfolioCount: 0,
      lockedPortfolioCount: counts.locked,
      unavailablePortfolioCount: counts.visible + counts.unreadable,
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
 * The finite backstop on a POOLED RESULT, after every member figure has already
 * been bounded on the way in. It should now be unreachable; the callers that
 * run it turn its throw into a typed unavailable composition rather than
 * letting it out, because a bad pooled result belongs to no single member.
 */
function requireFinite(value: unknown, label: string): asserts value is number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite money figure.`);
}

/**
 * The per-ROW finite backstop at the vault-DATA boundary.
 *
 * The shared `taxYearReportResponseSchema` accepts Infinity — zod's
 * `z.number()` admits it — which is why this layer was load-bearing on its own.
 * Reports now arrive through {@link vaultTaxYearReportResponseSchema}, which
 * rejects both non-finite and out-of-range figures, so this is the second lock
 * on the same door: it stays because it is the one that survives a refactor of
 * which schema the parse above happens to use.
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
