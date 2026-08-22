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

import { activeTaxRegime, taxRegimeForRow, type TaxRegime } from './taxEngine';

export const LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY =
  'vaultComposition.lockedPortfoliosQualifierOne' as const;
export const LOCKED_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY =
  'vaultComposition.lockedPortfoliosQualifierOther' as const;

export interface LockedPortfoliosQualifier {
  kind: 'locked-portfolios';
  count: number;
  messageKey:
    | typeof LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY
    | typeof LOCKED_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY;
}

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
    };

/**
 * The only public aggregate-figure shape. A partial value cannot exist without
 * its "+ N locked portfolios" rendering instruction, so aggregate consumers
 * never receive a silently incomplete bare number (paranoid design §14).
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
): ComposedPortfolioFigures;
/** Merge an explicit projection when a consumer has only that audited figure subset. */
export function composePortfolioFigures<const K extends keyof AdditivePortfolioFigures>(
  input: PortfolioCompositionInput<Pick<AdditivePortfolioFigures, K>>,
  keys: readonly K[],
): SelectedComposedPortfolioFigures<K>;
export function composePortfolioFigures(
  input: PortfolioCompositionInput<Partial<AdditivePortfolioFigures>>,
  keys: readonly (keyof AdditivePortfolioFigures)[] = ADDITIVE_FIGURE_KEYS,
): Partial<ComposedPortfolioFigures> {
  const { authoritativeRoster, members } = input;
  assertCompleteAuthoritativeRoster(authoritativeRoster, members);
  const coverage = coverageFor(members);
  const visible = members.filter(
    (member): member is Extract<(typeof members)[number], { state: 'visible' }> =>
      member.state === 'visible',
  );
  return Object.fromEntries(
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
}

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
 */
export function composeCountryTaxYear(
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  year: number,
  input: PortfolioCompositionInput<VisiblePortfolioTax>,
): ComposedCountryTaxYear {
  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new RangeError(`Unsupported tax composition year ${year}.`);
  }
  const { authoritativeRoster, members } = input;
  assertCompleteAuthoritativeRoster(authoritativeRoster, members);
  const coverage = coverageFor(members);
  const visibleMembers = members
    .filter(
      (member): member is Extract<(typeof members)[number], { state: 'visible' }> =>
        member.state === 'visible',
    )
    .map((member) => {
      const activeRegime = activeTaxRegime(member.value.effectiveSettings);
      const reports = member.value.reports.map((report) =>
        taxYearReportResponseSchema.parse(report),
      );
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
      return { ...member, activeRegime, reports };
    });

  const events = visibleMembers
    .flatMap((member) =>
      member.reports.flatMap((report) => taxEvents(report, country, member.activeRegime)),
    )
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
      year,
      country,
      taxTargetEur: qualifyMoney(settlement.heldAfterEur, coverage),
      realizedPnlEur: qualifyMoney(realizedPnlEur, coverage),
      dividendsGrossEur: qualifyMoney(dividendsGrossEur, coverage),
      de: null,
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
    year,
    country,
    taxTargetEur: qualifyMoney(settlement.heldAfterEur, coverage),
    realizedPnlEur: qualifyMoney(realizedPnlEur, coverage),
    dividendsGrossEur: qualifyMoney(dividendsGrossEur, coverage),
    de: {
      allowanceUsedEur: qualifyMoney(settlement.yearEnd.allowanceUsedEur, coverage),
      allowanceRemainingEur: qualifyMoney(settlement.yearEnd.allowanceRemainingEur, coverage),
      aktienPotInEur: qualifyMoney(aktienPotInEur, coverage),
      aktienPotOutEur: qualifyMoney(settlement.yearEnd.aktienPotOutEur, coverage),
      sonstigePotInEur: qualifyMoney(sonstigePotInEur, coverage),
      sonstigePotOutEur: qualifyMoney(settlement.yearEnd.sonstigePotOutEur, coverage),
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

function taxEvents(
  report: TaxYearReportResponse,
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  activeRegime: TaxRegime,
): TaxEvent[] {
  const events: TaxEvent[] = [];
  for (const position of report.positions) {
    for (const sell of position.sells) {
      if (countryForRegime(taxRegimeForRow(sell, activeRegime)) !== country) continue;
      requireFinite(sell.realizedPnlEur, `${sell.transactionId}.realizedPnlEur`);
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
      requireFinite(dividend.grossAmountEur, `${dividend.dividendId}.grossAmountEur`);
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

function coverageFor<T>(
  members: readonly PortfolioCompositionMember<T>[],
): PortfolioFigureCoverage {
  const visiblePortfolioCount = members.filter((member) => member.state === 'visible').length;
  const lockedPortfolioCount = members.length - visiblePortfolioCount;
  if (lockedPortfolioCount === 0) {
    return {
      kind: 'complete',
      visiblePortfolioCount,
      lockedPortfolioCount: 0,
      qualifier: null,
    };
  }
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

function requireFinite(value: unknown, label: string): asserts value is number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite money figure.`);
}
