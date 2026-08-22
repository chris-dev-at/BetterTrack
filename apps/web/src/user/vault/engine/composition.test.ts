import type {
  PortfolioAsset,
  TaxCountry,
  TaxYearPosition,
  TaxYearReportResponse,
} from '@bettertrack/contracts';
import { settleAtYear, settleDeYear } from '@bettertrack/domain/tax';
import { describe, expect, it } from 'vitest';

import {
  LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY,
  LOCKED_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY,
  composeCountryTaxYear,
  composePortfolioFigures,
  type AdditivePortfolioFigures,
  type AuthoritativePortfolioRosterEntry,
  type PortfolioCompositionInput,
  type PortfolioCompositionMember,
  type PortfolioTaxCompositionMember,
  type QualifiedPortfolioFigure,
} from './composition';

const IDS = {
  plain: '018f0000-0000-7000-8000-000000000401',
  vaulted: '018f0000-0000-7000-8000-000000000402',
  lockedOne: '018f0000-0000-7000-8000-000000000403',
  lockedTwo: '018f0000-0000-7000-8000-000000000404',
  vaultOne: '018f0000-0000-7000-8000-000000000405',
  vaultTwo: '018f0000-0000-7000-8000-000000000406',
  stock: '018f0000-0000-7000-8000-000000000407',
  other: '018f0000-0000-7000-8000-000000000408',
  plainSell: '018f0000-0000-7000-8000-000000000409',
  vaultSell: '018f0000-0000-7000-8000-000000000410',
  dividend: '018f0000-0000-7000-8000-000000000411',
  priorLoss: '018f0000-0000-7000-8000-000000000412',
  priorGain: '018f0000-0000-7000-8000-000000000413',
  currentSell: '018f0000-0000-7000-8000-000000000414',
  fractionalLoss: '018f0000-0000-7000-8000-000000000415',
  fractionalGain: '018f0000-0000-7000-8000-000000000416',
} as const;

const ZERO_FIGURES: AdditivePortfolioFigures = {
  totalValueEur: 0,
  marketValueEur: 0,
  investedEur: 0,
  unrealizedPnlEur: 0,
  dayChangeEur: 0,
  cashEur: 0,
  realizedPnlEur: 0,
  dividendsGrossEur: 0,
};

describe('cross-portfolio composition', () => {
  it('merges mixed plain and unlocked-vault figures to exact decimal cents', () => {
    // TEST VECTOR: deliberately uses binary-hostile decimal cents and verifies
    // the composed values at the UI's exact-decimal-string boundary.
    const members: PortfolioCompositionMember<AdditivePortfolioFigures>[] = [
      visible(IDS.plain, 'plain', null, {
        ...ZERO_FIGURES,
        totalValueEur: 10.1,
        marketValueEur: 8.05,
        cashEur: 2.05,
        realizedPnlEur: -1.01,
      }),
      visible(IDS.vaulted, 'vaulted', IDS.vaultOne, {
        ...ZERO_FIGURES,
        totalValueEur: 20.2,
        marketValueEur: 17.15,
        cashEur: 3.05,
        realizedPnlEur: 4.04,
      }),
    ];
    const result = composePortfolioFigures(testCompositionInput(members));

    expect(result.totalValueEur.valueEur.toFixed(2)).toBe('30.30');
    expect(result.marketValueEur.valueEur.toFixed(2)).toBe('25.20');
    expect(result.cashEur.valueEur.toFixed(2)).toBe('5.10');
    expect(result.realizedPnlEur.valueEur.toFixed(2)).toBe('3.03');
    for (const figure of Object.values(result)) expectComplete(figure, 2);
  });

  it('matches the unquantized server-shaped additive total for plain portfolios', () => {
    // TEST VECTOR: the server's portfolioService.computeTotals and homeData
    // rollup add already-derived figures without introducing another cent
    // floor. The third decimal proves composition preserves that boundary.
    const plainFigures: AdditivePortfolioFigures[] = [
      {
        ...ZERO_FIGURES,
        totalValueEur: 10.109,
        marketValueEur: 8.055,
        investedEur: 7.125,
        cashEur: 2.054,
      },
      {
        ...ZERO_FIGURES,
        totalValueEur: 20.109,
        marketValueEur: 17.155,
        investedEur: 16.125,
        cashEur: 3.054,
      },
    ];
    const members = plainFigures.map((value, index) =>
      visible(index === 0 ? IDS.plain : IDS.vaulted, 'plain', null, value),
    );
    const result = composePortfolioFigures(testCompositionInput(members));

    expect(result.totalValueEur.valueEur.toFixed(3)).toBe('30.218');
    expect(result.marketValueEur.valueEur.toFixed(3)).toBe('25.210');
    expect(result.investedEur.valueEur.toFixed(3)).toBe('23.250');
    expect(result.cashEur.valueEur.toFixed(3)).toBe('5.108');
    expect(result.totalValueEur.valueEur).not.toBe(30.21);
    for (const figure of Object.values(result)) expectComplete(figure, 2);
  });

  it('composes only an explicitly selected typed figure projection', () => {
    const members: PortfolioCompositionMember<
      Pick<AdditivePortfolioFigures, 'totalValueEur' | 'cashEur'>
    >[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: { totalValueEur: 100.109, cashEur: 10.055 },
      },
      { state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultOne },
    ];

    const result = composePortfolioFigures(testCompositionInput(members), [
      'totalValueEur',
      'cashEur',
    ]);

    expect(Object.keys(result)).toEqual(['totalValueEur', 'cashEur']);
    expect(result.totalValueEur.valueEur).toBe(100.109);
    expect(result.cashEur.valueEur).toBe(10.055);
    expect(result.totalValueEur.coverage).toMatchObject({
      kind: 'partial',
      lockedPortfolioCount: 1,
      qualifier: {
        count: 1,
        messageKey: LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY,
      },
    });
  });

  it.each([
    { locked: [] as string[], expected: 0 },
    { locked: [IDS.lockedOne], expected: 1 },
    { locked: [IDS.lockedOne, IDS.lockedTwo], expected: 2 },
  ])('makes the locked qualifier non-bypassable for $expected locked portfolios', (testCase) => {
    const members: PortfolioCompositionMember<AdditivePortfolioFigures>[] = [
      visible(IDS.plain, 'plain', null, { ...ZERO_FIGURES, totalValueEur: 100 }),
      ...testCase.locked.map((portfolioId, index) => ({
        state: 'locked' as const,
        portfolioId,
        vaultId: index === 0 ? IDS.vaultOne : IDS.vaultTwo,
      })),
    ];

    const result = composePortfolioFigures(testCompositionInput(members));

    for (const figure of Object.values(result)) {
      if (testCase.expected === 0) {
        expectComplete(figure, 1);
      } else {
        expect(figure.coverage).toEqual({
          kind: 'partial',
          visiblePortfolioCount: 1,
          lockedPortfolioCount: testCase.expected,
          qualifier: {
            kind: 'locked-portfolios',
            count: testCase.expected,
            messageKey:
              testCase.expected === 1
                ? LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY
                : LOCKED_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY,
          },
        });
      }
    }
  });

  it('rejects an omitted locked member instead of reporting complete coverage', () => {
    const members = [visible(IDS.plain, 'plain', null, { ...ZERO_FIGURES, totalValueEur: 100 })];
    const authoritativeRoster: AuthoritativePortfolioRosterEntry[] = [
      { portfolioId: IDS.plain, source: 'plain', vaultId: null },
      { portfolioId: IDS.lockedOne, source: 'vaulted', vaultId: IDS.vaultOne },
    ];

    expect(() => composePortfolioFigures({ authoritativeRoster, members })).toThrow(
      `Portfolio ${IDS.lockedOne} is missing from the authoritative composition roster resolution.`,
    );
  });

  it('composes AT loss offset through the authoritative domain settlement', () => {
    // TEST VECTOR: +€1,500 sell, −€500 sell and €100 dividend share one AT
    // pool. 27.5% × €1,100 = €302.50, computed only by packages/domain.
    const mixed = taxMembers('AT', [
      report('AT', stockAsset(), [{ kind: 'sell', id: IDS.plainSell, amount: 1500 }]),
      report('AT', otherAsset(), [
        { kind: 'sell', id: IDS.vaultSell, amount: -500 },
        { kind: 'dividend', id: IDS.dividend, amount: 100 },
      ]),
    ]);
    const mixedResult = composeCountryTaxYear('AT', 2026, testCompositionInput(mixed));
    const expected = settleAtYear({
      existingGainsEur: [1500, -500],
      existingDividendsEur: [100],
      heldEur: 0,
      newEvents: [],
    });

    expect(mixedResult.taxTargetEur.valueEur.toFixed(2)).toBe(expected.heldAfterEur.toFixed(2));
    expect(mixedResult.taxTargetEur.valueEur.toFixed(2)).toBe('302.50');
    expectComplete(mixedResult.taxTargetEur, 2);
  });

  it('composes DE loss pots and allowance through the authoritative domain settlement', () => {
    // TEST VECTOR: €2,000 Aktien gain, €500 Sonstige loss and €100 dividend.
    // Domain applies DE pot/cross-offset and the statutory allowance/tax split.
    const mixed = taxMembers('DE', [
      report('DE', stockAsset(), [{ kind: 'sell', id: IDS.plainSell, amount: 2000 }]),
      report('DE', otherAsset(), [
        { kind: 'sell', id: IDS.vaultSell, amount: -500 },
        { kind: 'dividend', id: IDS.dividend, amount: 100 },
      ]),
    ]);
    const mixedResult = composeCountryTaxYear('DE', 2026, testCompositionInput(mixed));
    const expected = settleDeYear({
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      existingEvents: [
        { kind: 'sell_gain', category: 'aktien', amountEur: 2000 },
        { kind: 'sell_gain', category: 'sonstige', amountEur: -500 },
        { kind: 'dividend', amountEur: 100 },
      ],
      heldEur: 0,
      newEvents: [],
    });

    expect(mixedResult.taxTargetEur.valueEur.toFixed(2)).toBe(expected.heldAfterEur.toFixed(2));
    expect(mixedResult.de?.kapestEur.valueEur.toFixed(2)).toBe(
      expected.yearEnd.kapestEur.toFixed(2),
    );
    for (const figure of Object.values(mixedResult.de ?? {})) expectComplete(figure, 2);
  });

  it('replays prior DE years across portfolios before settling the requested year', () => {
    // TEST VECTOR: the 2025 cross-portfolio Aktien pool is -1000 + 600 = -400.
    // Per-portfolio pot summaries cannot be added safely; composition must feed
    // the combined prior-year event stream through domain deCarryPots.
    const members: PortfolioTaxCompositionMember[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: taxValue('DE', [
          report('DE', stockAsset(), [{ kind: 'sell', id: IDS.priorLoss, amount: -1000 }], 2025),
          report('DE', stockAsset(), [], 2026),
        ]),
      },
      {
        state: 'visible',
        portfolioId: IDS.vaulted,
        source: 'vaulted',
        vaultId: IDS.vaultOne,
        value: taxValue('DE', [
          report('DE', stockAsset(), [{ kind: 'sell', id: IDS.priorGain, amount: 600 }], 2025),
          report('DE', stockAsset(), [{ kind: 'sell', id: IDS.currentSell, amount: 500 }], 2026),
        ]),
      },
    ];

    const result = composeCountryTaxYear('DE', 2026, testCompositionInput(members));

    expect(result.de?.aktienPotInEur.valueEur.toFixed(2)).toBe('400.00');
    expect(result.de?.aktienPotOutEur.valueEur.toFixed(2)).toBe('0.00');
    expect(result.realizedPnlEur.valueEur.toFixed(2)).toBe('500.00');
  });

  it('passes a fractional carried DE Aktien loss raw into settlement', () => {
    // REVIEW ROUND 1 TEST VECTOR: a 2025 Aktien loss of EUR 0.001 carried into
    // a 2026 Aktien gain of EUR 1000.08. The loss-pot input must remain raw for
    // domain settlement; only the reported pot-in figure is floored. Premature
    // flooring over-taxes this vector by one cent (EUR 0.02 instead of 0.01).
    const members: PortfolioTaxCompositionMember[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: taxValue('DE', [
          report(
            'DE',
            stockAsset(),
            [{ kind: 'sell', id: IDS.fractionalLoss, amount: -0.001 }],
            2025,
          ),
          report(
            'DE',
            stockAsset(),
            [{ kind: 'sell', id: IDS.fractionalGain, amount: 1000.08 }],
            2026,
          ),
        ]),
      },
    ];
    const authoritative = settleDeYear({
      aktienPotInEur: 0.001,
      sonstigePotInEur: 0,
      existingEvents: [{ kind: 'sell_gain', category: 'aktien', amountEur: 1000.08 }],
      heldEur: 0,
      newEvents: [],
    });

    const result = composeCountryTaxYear('DE', 2026, testCompositionInput(members));

    expect(authoritative.yearEnd.kapestEur.toFixed(2)).toBe('0.01');
    expect(result.de?.kapestEur.valueEur.toFixed(2)).toBe(
      authoritative.yearEnd.kapestEur.toFixed(2),
    );
    expect(result.de?.aktienPotInEur.valueEur.toFixed(2)).toBe('0.00');
  });

  it('qualifies every AT/DE tax figure when any relevant portfolio is locked', () => {
    const members: PortfolioTaxCompositionMember[] = [
      ...taxMembers('DE', [
        report('DE', stockAsset(), [{ kind: 'sell', id: IDS.plainSell, amount: 2000 }]),
      ]),
      { state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultTwo },
    ];

    const result = composeCountryTaxYear('DE', 2026, testCompositionInput(members));
    const everyFigure = [
      result.taxTargetEur,
      result.realizedPnlEur,
      result.dividendsGrossEur,
      ...Object.values(result.de ?? {}),
    ];

    for (const figure of everyFigure) {
      expect(figure.coverage.kind).toBe('partial');
      expect(figure.coverage.lockedPortfolioCount).toBe(1);
      expect(figure.coverage.qualifier).toMatchObject({
        kind: 'locked-portfolios',
        count: 1,
      });
    }
  });

  it('rejects tax composition when the authoritative roster has an omitted locked member', () => {
    const members = taxMembers('AT', [report('AT', stockAsset(), [], 2026)]);
    const authoritativeRoster: AuthoritativePortfolioRosterEntry[] = [
      { portfolioId: IDS.plain, source: 'plain', vaultId: null },
      { portfolioId: IDS.lockedOne, source: 'vaulted', vaultId: IDS.vaultOne },
    ];

    expect(() => composeCountryTaxYear('AT', 2026, { authoritativeRoster, members })).toThrow(
      `Portfolio ${IDS.lockedOne} is missing from the authoritative composition roster resolution.`,
    );
  });

  it('applies the client engine living regime when frozen rows name an older country', () => {
    // TEST VECTOR: a row frozen under AT is classified as DE when DE is the
    // current non-manual regime, exactly like taxEngine.regimeForRow.
    const frozenAt = report('AT', stockAsset(), [
      { kind: 'sell', id: IDS.plainSell, amount: 2000 },
    ]);
    const members: PortfolioTaxCompositionMember[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: taxValue('DE', [frozenAt]),
      },
    ];

    expect(
      composeCountryTaxYear('DE', 2026, testCompositionInput(members)).realizedPnlEur.valueEur,
    ).toBe(2000);
    expect(
      composeCountryTaxYear('AT', 2026, testCompositionInput(members)).realizedPnlEur.valueEur,
    ).toBe(0);
  });

  it('fails closed when an authoritative prior activity year is missing', () => {
    const current = report('DE', stockAsset(), [], 2026);
    const members: PortfolioTaxCompositionMember[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: {
          ...taxValue('DE', [current]),
          authoritativeActivityYears: [2025, 2026],
        },
      },
    ];

    expect(() => composeCountryTaxYear('DE', 2026, testCompositionInput(members))).toThrow(
      'did not supply required tax year(s) 2025',
    );
  });

  it('qualifies AT tax totals as well as the DE detail branch', () => {
    const members: PortfolioTaxCompositionMember[] = [
      ...taxMembers('AT', [
        report('AT', stockAsset(), [{ kind: 'sell', id: IDS.plainSell, amount: 2000 }]),
      ]),
      { state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultTwo },
    ];

    const result = composeCountryTaxYear('AT', 2026, testCompositionInput(members));
    expect(result.de).toBeNull();
    for (const figure of [result.taxTargetEur, result.realizedPnlEur, result.dividendsGrossEur]) {
      expect(figure.coverage).toMatchObject({
        kind: 'partial',
        lockedPortfolioCount: 1,
        qualifier: { kind: 'locked-portfolios', count: 1 },
      });
    }
  });
});

function visible(
  portfolioId: string,
  source: 'plain' | 'vaulted',
  vaultId: string | null,
  value: AdditivePortfolioFigures,
): PortfolioCompositionMember<AdditivePortfolioFigures> {
  return { state: 'visible', portfolioId, source, vaultId, value };
}

/** Fixture convenience only; production callers must use an independently fetched roster. */
function testCompositionInput<T>(
  members: readonly PortfolioCompositionMember<T>[],
): PortfolioCompositionInput<T> {
  return {
    authoritativeRoster: members.map((member): AuthoritativePortfolioRosterEntry => {
      if (member.state === 'locked' || member.source === 'vaulted') {
        if (member.vaultId === null) throw new TypeError('Vaulted test fixture requires a vault.');
        return { portfolioId: member.portfolioId, source: 'vaulted', vaultId: member.vaultId };
      }
      return { portfolioId: member.portfolioId, source: 'plain', vaultId: null };
    }),
    members,
  };
}

function taxMembers(
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  reports: TaxYearReportResponse[],
): PortfolioTaxCompositionMember[] {
  return reports.map((value, index) => ({
    state: 'visible',
    portfolioId: index === 0 ? IDS.plain : IDS.vaulted,
    source: index === 0 ? 'plain' : 'vaulted',
    vaultId: index === 0 ? null : IDS.vaultOne,
    value: taxValue(country, [value]),
  }));
}

function taxValue(
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  reports: TaxYearReportResponse[],
): Extract<PortfolioTaxCompositionMember, { state: 'visible' }>['value'] {
  return {
    reports,
    authoritativeActivityYears: [...new Set(reports.map(({ year }) => year))],
    effectiveSettings: { mode: 'country_specific', country },
  };
}

function report(
  country: Extract<TaxCountry, 'AT' | 'DE'>,
  asset: PortfolioAsset,
  rows: Array<{ kind: 'sell' | 'dividend'; id: string; amount: number }>,
  year = 2026,
): TaxYearReportResponse {
  const sells = rows
    .filter((row) => row.kind === 'sell')
    .map((row) => ({
      transactionId: row.id,
      executedAt: `${year}-03-01T10:00:00.000Z`,
      quantity: 1,
      proceedsEur: Math.max(0, row.amount),
      costBasisEur: Math.max(0, -row.amount),
      realizedPnlEur: row.amount,
      taxMode: 'country_specific' as const,
      taxAmountEur: null,
      taxCountry: country,
      taxParams: null,
    }));
  const dividends = rows
    .filter((row) => row.kind === 'dividend')
    .map((row) => ({
      dividendId: row.id,
      executedAt: `${year}-06-01T10:00:00.000Z`,
      grossAmountEur: row.amount,
      taxMode: 'country_specific' as const,
      taxAmountEur: null,
      taxCountry: country,
      taxParams: null,
    }));
  const position: TaxYearPosition = {
    asset,
    realizedPnlEur: sells.reduce((sum, row) => sum + row.realizedPnlEur, 0),
    dividendsGrossEur: dividends.reduce((sum, row) => sum + row.grossAmountEur, 0),
    taxEur: 0,
    sells,
    dividends,
  };
  return {
    year,
    summary: {
      year,
      lastChangedAt: `${year}-06-01T10:00:00.000Z`,
      realizedPnlEur: position.realizedPnlEur,
      dividendsGrossEur: position.dividendsGrossEur,
      taxWithheldEur: 0,
      taxRefundedEur: 0,
      taxNetEur: 0,
      ...(country === 'DE'
        ? {
            de: {
              allowanceUsedEur: 0,
              allowanceRemainingEur: 1000,
              aktienPotInEur: 0,
              aktienPotOutEur: 0,
              sonstigePotInEur: 0,
              sonstigePotOutEur: 0,
              kapestEur: 0,
              soliEur: 0,
            },
          }
        : {}),
    },
    positions: [position],
  };
}

function stockAsset(): PortfolioAsset {
  return {
    id: IDS.stock,
    symbol: 'TEST-STOCK',
    name: 'TEST VECTOR stock',
    exchange: 'XETRA',
    currency: 'EUR',
    type: 'stock',
    isCustom: false,
    category: null,
    smoothing: false,
  };
}

function otherAsset(): PortfolioAsset {
  return {
    ...stockAsset(),
    id: IDS.other,
    symbol: 'TEST-OTHER',
    name: 'TEST VECTOR other asset',
    type: 'crypto',
  };
}

function expectComplete(figure: QualifiedPortfolioFigure, visiblePortfolioCount: number): void {
  expect(figure.coverage).toEqual({
    kind: 'complete',
    visiblePortfolioCount,
    lockedPortfolioCount: 0,
    qualifier: null,
  });
}
