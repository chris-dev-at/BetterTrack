import {
  MAX_CASH_AMOUNT_EUR,
  MAX_TAX_REPORT_FIGURE_EUR,
  taxYearReportResponseSchema,
  type PortfolioAsset,
  type TaxCountry,
  type TaxYearPosition,
  type TaxYearReportResponse,
} from '@bettertrack/contracts';
import { deCarryPots, floorCents, settleAtYear, settleDeYear } from '@bettertrack/domain/tax';
import { describe, expect, it } from 'vitest';

import {
  LOCKED_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY,
  LOCKED_PORTFOLIOS_QUALIFIER_OTHER_MESSAGE_KEY,
  UNREADABLE_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY,
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
  subCentLoss: '018f0000-0000-7000-8000-000000000417',
  subCentDividend: '018f0000-0000-7000-8000-000000000418',
  poolA24: '018f0000-0000-7000-8000-000000000419',
  poolA25: '018f0000-0000-7000-8000-000000000420',
  poolA26: '018f0000-0000-7000-8000-000000000421',
  poolA26d: '018f0000-0000-7000-8000-000000000422',
  poolB24: '018f0000-0000-7000-8000-000000000423',
  poolB25: '018f0000-0000-7000-8000-000000000424',
  poolB26: '018f0000-0000-7000-8000-000000000425',
  allowanceA: '018f0000-0000-7000-8000-000000000426',
  allowanceB: '018f0000-0000-7000-8000-000000000427',
  offsetLoss: '018f0000-0000-7000-8000-000000000428',
  offsetGain: '018f0000-0000-7000-8000-000000000429',
  atGainA: '018f0000-0000-7000-8000-000000000430',
  atDividendA: '018f0000-0000-7000-8000-000000000431',
  atLossB: '018f0000-0000-7000-8000-000000000432',
  healthySell: '018f0000-0000-7000-8000-000000000433',
  corruptSell: '018f0000-0000-7000-8000-000000000434',
  infiniteSell: '018f0000-0000-7000-8000-000000000435',
  overflowA: '018f0000-0000-7000-8000-000000000436',
  overflowB: '018f0000-0000-7000-8000-000000000437',
  thirdPortfolio: '018f0000-0000-7000-8000-000000000438',
  vaultThree: '018f0000-0000-7000-8000-000000000439',
  staleActivitySell: '018f0000-0000-7000-8000-000000000440',
  futureSell: '018f0000-0000-7000-8000-000000000441',
  duplicateYearSell: '018f0000-0000-7000-8000-000000000442',
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
    const result = composedFigures(testCompositionInput(members));

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
    const result = composedFigures(testCompositionInput(members));

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

    const result = requireComposed(
      composePortfolioFigures(testCompositionInput(members), ['totalValueEur', 'cashEur']),
    );

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

    const result = composedFigures(testCompositionInput(members));

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
    const mixedResult = composedTaxYear('AT', 2026, testCompositionInput(mixed));
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
    const mixedResult = composedTaxYear('DE', 2026, testCompositionInput(mixed));
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

    const result = composedTaxYear('DE', 2026, testCompositionInput(members));

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

    const result = composedTaxYear('DE', 2026, testCompositionInput(members));

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

    const result = composedTaxYear('DE', 2026, testCompositionInput(members));
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

    expect(composedTaxYear('DE', 2026, testCompositionInput(members)).realizedPnlEur.valueEur).toBe(
      2000,
    );
    expect(composedTaxYear('AT', 2026, testCompositionInput(members)).realizedPnlEur.valueEur).toBe(
      0,
    );
  });

  it('qualifies AT tax totals as well as the DE detail branch', () => {
    const members: PortfolioTaxCompositionMember[] = [
      ...taxMembers('AT', [
        report('AT', stockAsset(), [{ kind: 'sell', id: IDS.plainSell, amount: 2000 }]),
      ]),
      { state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultTwo },
    ];

    const result = composedTaxYear('AT', 2026, testCompositionInput(members));
    expect(result.de).toBeNull();
    for (const figure of [result.taxTargetEur, result.realizedPnlEur, result.dividendsGrossEur]) {
      expect(figure.coverage).toMatchObject({
        kind: 'partial',
        lockedPortfolioCount: 1,
        qualifier: { kind: 'locked-portfolios', count: 1 },
      });
    }
  });

  it('floors the reported DE figures exactly like the authoritative report boundary', () => {
    // T1 REVIEW VECTOR: sub-cent residue in the year outcome. The server's
    // report (taxService.deSummaryForYear) floors allowanceUsed / remaining /
    // potIn / potOut at the presentation boundary; the composed DE block must
    // quantize the SAME figures identically, or the cross-portfolio panel
    // shows FP dust (0.005, 999.995) where the portfolio page shows clean
    // cents. Settlement inputs stay raw — only REPORTED figures are floored
    // (#370 money policy: floor toward zero, never round up).
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
            [
              { kind: 'sell', id: IDS.subCentLoss, amount: -0.005 },
              { kind: 'dividend', id: IDS.subCentDividend, amount: 0.005 },
            ],
            2026,
          ),
        ]),
      },
    ];

    const result = composedTaxYear('DE', 2026, testCompositionInput(members));

    // Engine outcome: aktienPotOut 0.005, allowanceUsed 0.005, remaining
    // 999.995 — all sub-cent. The authoritative report floors every one.
    expect(result.de?.aktienPotOutEur.valueEur).toBe(0);
    expect(result.de?.allowanceUsedEur.valueEur).toBe(0);
    expect(result.de?.allowanceRemainingEur.valueEur).toBe(999.99);
    expect(result.de?.sonstigePotOutEur.valueEur).toBe(0);

    // FINAL-REVIEW F2: in the vector above the sonstige remainder is POSITIVE,
    // so its pot-out is 0 on the engine's untouched initializer and the floor
    // is not exercised — the mutation sweep proved that assertion true with or
    // without it. This second scenario carries a genuine sub-cent SONSTIGE
    // loss (a crypto sell, no offsetting income), so the raw pot-out is 0.005
    // and only the presentation floor makes it 0.
    const sonstigeLoss = composedTaxYear(
      'DE',
      2026,
      testCompositionInput([
        {
          state: 'visible',
          portfolioId: IDS.plain,
          source: 'plain',
          vaultId: null,
          value: taxValue('DE', [
            report(
              'DE',
              otherAsset(),
              [{ kind: 'sell', id: IDS.subCentLoss, amount: -0.005 }],
              2026,
            ),
          ]),
        },
      ]),
    );
    expect(sonstigeLoss.de?.sonstigePotOutEur.valueEur).toBe(0);
    expect(sonstigeLoss.de?.aktienPotOutEur.valueEur).toBe(0);
  });

  it('matches the authoritative pooled DE settlement exactly on fractional multi-portfolio streams', () => {
    // T1 REVIEW VECTOR: composed target must equal the domain engine run over
    // the pooled event stream EXACTLY — same floats through the same
    // floorCents — on binary-hostile fractional amounts across two portfolios
    // and two carried years. Flooring anywhere on the settlement path breaks
    // this equality (the review's 0.01-vs-0.02 divergence class).
    const members: PortfolioTaxCompositionMember[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: taxValue('DE', [
          report('DE', stockAsset(), [{ kind: 'sell', id: IDS.poolA24, amount: -10.007 }], 2024),
          report('DE', otherAsset(), [{ kind: 'sell', id: IDS.poolA25, amount: -3.0004 }], 2025),
          report(
            'DE',
            stockAsset(),
            [
              { kind: 'sell', id: IDS.poolA26, amount: 5000.003 },
              { kind: 'dividend', id: IDS.poolA26d, amount: 12.0007 },
            ],
            2026,
          ),
        ]),
      },
      {
        state: 'visible',
        portfolioId: IDS.vaulted,
        source: 'vaulted',
        vaultId: IDS.vaultOne,
        value: taxValue('DE', [
          report('DE', stockAsset(), [{ kind: 'sell', id: IDS.poolB24, amount: 4.0009 }], 2024),
          report('DE', otherAsset(), [{ kind: 'sell', id: IDS.poolB25, amount: -7.13 }], 2025),
          report('DE', otherAsset(), [{ kind: 'sell', id: IDS.poolB26, amount: -0.017 }], 2026),
        ]),
      },
    ];
    // The pooled event streams in composition's own (year, at, id) order, so
    // float accumulation order matches bit for bit.
    const pots = deCarryPots([
      [
        { kind: 'sell_gain', category: 'aktien', amountEur: -10.007 },
        { kind: 'sell_gain', category: 'aktien', amountEur: 4.0009 },
      ],
      [
        { kind: 'sell_gain', category: 'sonstige', amountEur: -3.0004 },
        { kind: 'sell_gain', category: 'sonstige', amountEur: -7.13 },
      ],
    ]);
    const authoritative = settleDeYear({
      aktienPotInEur: pots.aktienEur,
      sonstigePotInEur: pots.sonstigeEur,
      existingEvents: [
        { kind: 'sell_gain', category: 'aktien', amountEur: 5000.003 },
        { kind: 'sell_gain', category: 'sonstige', amountEur: -0.017 },
        { kind: 'dividend', amountEur: 12.0007 },
      ],
      heldEur: 0,
      newEvents: [],
    });

    const result = composedTaxYear('DE', 2026, testCompositionInput(members));

    expect(authoritative.yearEnd.kapestEur).toBeGreaterThan(0);
    expect(result.taxTargetEur.valueEur).toBe(authoritative.heldAfterEur);
    expect(result.de?.kapestEur.valueEur).toBe(authoritative.yearEnd.kapestEur);
    expect(result.de?.soliEur.valueEur).toBe(authoritative.yearEnd.soliEur);
    expect(result.de?.aktienPotInEur.valueEur).toBe(floorCents(pots.aktienEur));
    expect(result.de?.sonstigePotInEur.valueEur).toBe(floorCents(pots.sonstigeEur));
  });

  it('applies the Sparer-Pauschbetrag once across pooled portfolios, never per portfolio', () => {
    // T1 SEMANTICS PIN: the composed DE view is ONE combined settlement — one
    // allowance for the person, cross-portfolio offsetting. It intentionally
    // does NOT equal the sum of separate per-portfolio settlements (each of
    // which would consume its own EUR 1000 here and both would owe nothing).
    const members: PortfolioTaxCompositionMember[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: taxValue('DE', [
          report('DE', stockAsset(), [{ kind: 'dividend', id: IDS.allowanceA, amount: 1000 }]),
        ]),
      },
      {
        state: 'visible',
        portfolioId: IDS.vaulted,
        source: 'vaulted',
        vaultId: IDS.vaultOne,
        value: taxValue('DE', [
          report('DE', stockAsset(), [{ kind: 'dividend', id: IDS.allowanceB, amount: 1000 }]),
        ]),
      },
    ];

    const result = composedTaxYear('DE', 2026, testCompositionInput(members));

    expect(result.de?.allowanceUsedEur.valueEur).toBe(1000);
    expect(result.de?.allowanceRemainingEur.valueEur).toBe(0);
    // 2000 pooled − 1000 allowance → 25 % KapESt on 1000.
    expect(result.de?.kapestEur.valueEur).toBe(250);
  });

  it("offsets one portfolio's loss against another portfolio's gain in the composed view", () => {
    // T1 SEMANTICS PIN: cross-portfolio loss offsetting is the point of the
    // combined view — a loss sealed in portfolio A neutralizes a gain in B.
    const members: PortfolioTaxCompositionMember[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: taxValue('DE', [
          report('DE', stockAsset(), [{ kind: 'sell', id: IDS.offsetLoss, amount: -300 }]),
        ]),
      },
      {
        state: 'visible',
        portfolioId: IDS.vaulted,
        source: 'vaulted',
        vaultId: IDS.vaultOne,
        value: taxValue('DE', [
          report('DE', stockAsset(), [{ kind: 'sell', id: IDS.offsetGain, amount: 300 }]),
        ]),
      },
    ];

    const result = composedTaxYear('DE', 2026, testCompositionInput(members));

    expect(result.taxTargetEur.valueEur).toBe(0);
    expect(result.de?.kapestEur.valueEur).toBe(0);
    expect(result.de?.allowanceUsedEur.valueEur).toBe(0);
    expect(result.realizedPnlEur.valueEur).toBe(0);
  });

  it('matches the authoritative AT pool settlement exactly on fractional streams', () => {
    // T1 REVIEW VECTOR: the AT side of the same exactness guarantee — pooled
    // fractional gains, a loss from another portfolio, and a dividend must
    // reproduce settleAtYear bit for bit.
    const members: PortfolioTaxCompositionMember[] = [
      {
        state: 'visible',
        portfolioId: IDS.plain,
        source: 'plain',
        vaultId: null,
        value: taxValue('AT', [
          report(
            'AT',
            stockAsset(),
            [
              { kind: 'sell', id: IDS.atGainA, amount: 100.007 },
              { kind: 'dividend', id: IDS.atDividendA, amount: 3.0001 },
            ],
            2026,
          ),
        ]),
      },
      {
        state: 'visible',
        portfolioId: IDS.vaulted,
        source: 'vaulted',
        vaultId: IDS.vaultOne,
        value: taxValue('AT', [
          report('AT', stockAsset(), [{ kind: 'sell', id: IDS.atLossB, amount: -50.0004 }], 2026),
        ]),
      },
    ];
    const authoritative = settleAtYear({
      // Composition's (year, at, id) order: both sells at 03-01, A's id sorts
      // before B's, the dividend at 06-01 last.
      existingGainsEur: [100.007, -50.0004],
      existingDividendsEur: [3.0001],
      heldEur: 0,
      newEvents: [],
    });

    const result = composedTaxYear('AT', 2026, testCompositionInput(members));

    expect(authoritative.heldAfterEur).toBeGreaterThan(0);
    expect(result.taxTargetEur.valueEur).toBe(authoritative.heldAfterEur);
    expect(result.realizedPnlEur.valueEur).toBe(floorCents(100.007 + -50.0004));
    expect(result.dividendsGrossEur.valueEur).toBe(floorCents(3.0001));
  });
});

describe('all-locked scopes at the composition seam (#1514 part 1)', () => {
  it('refuses to publish a bare zero wearing a locked qualifier', () => {
    // The module doc promises "a partial value cannot exist without its
    // rendering instruction". Before #1514 a DIRECT call skipped past
    // composeHomeRollup's guard and produced exactly the forbidden artifact:
    // valueEur 0 with "+ 2 locked portfolios". The seam itself must refuse.
    const members: PortfolioCompositionMember<AdditivePortfolioFigures>[] = [
      { state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultOne },
      { state: 'locked', portfolioId: IDS.lockedTwo, vaultId: IDS.vaultTwo },
    ];

    const result = composePortfolioFigures(testCompositionInput(members));

    expect(result).toEqual({
      kind: 'unavailable',
      coverage: {
        kind: 'unavailable',
        visiblePortfolioCount: 0,
        lockedPortfolioCount: 2,
        unavailablePortfolioCount: 0,
      },
      memberFailures: [],
    });
    // No number of any kind escapes an all-locked scope.
    expect(JSON.stringify(result)).not.toContain('Eur');
  });

  it('keeps an all-locked projection unavailable for an explicit figure subset too', () => {
    const members: PortfolioCompositionMember<
      Pick<AdditivePortfolioFigures, 'totalValueEur' | 'cashEur'>
    >[] = [{ state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultOne }];

    const result = composePortfolioFigures(testCompositionInput(members), [
      'totalValueEur',
      'cashEur',
    ]);

    expect(result.kind).toBe('unavailable');
  });

  it('keeps an empty scope an honest complete zero', () => {
    // Nothing is hidden here: a scope with no portfolios really is worth zero,
    // so suppressing the figure would be its own kind of dishonesty.
    const result = requireComposed(
      composePortfolioFigures(
        testCompositionInput([] as PortfolioCompositionMember<AdditivePortfolioFigures>[]),
      ),
    );

    expect(result.totalValueEur.valueEur).toBe(0);
    expectComplete(result.totalValueEur, 0);
  });

  it('reports an all-locked tax scope as unavailable rather than a zero settlement', () => {
    const members: PortfolioTaxCompositionMember[] = [
      { state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultOne },
    ];

    const result = composeCountryTaxYear('DE', 2026, testCompositionInput(members));

    expect(result).toEqual({
      kind: 'unavailable',
      coverage: {
        kind: 'unavailable',
        visiblePortfolioCount: 0,
        lockedPortfolioCount: 1,
        unavailablePortfolioCount: 0,
      },
      memberFailures: [],
    });
  });

  it('keeps an empty tax scope an honest complete zero', () => {
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([] as PortfolioTaxCompositionMember[]),
      ),
    );

    expect(result.taxTargetEur.valueEur).toBe(0);
    expectComplete(result.taxTargetEur, 0);
  });
});

describe('per-member typed tax failures (#1514 part 2)', () => {
  it('degrades one corrupt member and still composes the healthy portfolios', () => {
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          {
            state: 'visible',
            portfolioId: IDS.vaulted,
            source: 'vaulted',
            vaultId: IDS.vaultOne,
            value: taxValue('DE', [corruptedReport()]),
          },
        ]),
      ),
    );

    expect(result.memberFailures).toEqual([
      {
        portfolioId: IDS.vaulted,
        error: {
          code: 'TAX_DATA_INVALID',
          message: expect.stringContaining(IDS.vaulted),
          retryable: false,
          details: { portfolioId: IDS.vaulted },
        },
      },
    ]);
    // The healthy portfolio's own figures survive intact...
    expect(result.realizedPnlEur.valueEur).toBe(2000);
    // ...and the unreadable member is carried as unavailable, never as a zero
    // contribution that would silently dilute the composed view.
    for (const figure of [
      result.taxTargetEur,
      result.realizedPnlEur,
      result.dividendsGrossEur,
      ...Object.values(result.de ?? {}),
    ]) {
      expect(figure.coverage).toEqual({
        kind: 'partial',
        visiblePortfolioCount: 1,
        lockedPortfolioCount: 0,
        unavailablePortfolioCount: 1,
        qualifier: {
          kind: 'unreadable-portfolios',
          count: 1,
          messageKey: UNREADABLE_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY,
        },
      });
    }
  });

  it('counts locked and unreadable members together in the qualifier', () => {
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          {
            state: 'visible',
            portfolioId: IDS.vaulted,
            source: 'vaulted',
            vaultId: IDS.vaultOne,
            value: taxValue('DE', [corruptedReport()]),
          },
          { state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultTwo },
        ]),
      ),
    );

    expect(result.taxTargetEur.coverage).toEqual({
      kind: 'partial',
      visiblePortfolioCount: 1,
      lockedPortfolioCount: 1,
      unavailablePortfolioCount: 1,
      qualifier: {
        kind: 'unreadable-portfolios',
        count: 2,
        messageKey: 'vaultComposition.unreadablePortfoliosQualifierOther',
      },
    });
  });

  it('keeps the finite backstop between a schema-valid Infinity and settlement', () => {
    // #1514 ACCEPTANCE CRITERION: zod's z.number() ACCEPTS Infinity, so schema
    // validation alone cannot keep a non-finite report figure out of the
    // domain settlement. The requireFinite layer is load-bearing; this test
    // fails the moment a refactor drops it and lets Infinity through.
    const poisoned = report('DE', stockAsset(), [
      { kind: 'sell', id: IDS.infiniteSell, amount: Number.POSITIVE_INFINITY },
    ]);
    expect(taxYearReportResponseSchema.safeParse(poisoned).success).toBe(true);

    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          {
            state: 'visible',
            portfolioId: IDS.vaulted,
            source: 'vaulted',
            vaultId: IDS.vaultOne,
            value: taxValue('DE', [poisoned]),
          },
        ]),
      ),
    );

    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.vaulted, error: { code: 'TAX_DATA_INVALID' } },
    ]);
    for (const figure of [
      result.taxTargetEur,
      result.realizedPnlEur,
      result.dividendsGrossEur,
      ...Object.values(result.de ?? {}),
    ]) {
      expect(Number.isFinite(figure.valueEur)).toBe(true);
      expect(figure.coverage.kind).toBe('partial');
    }
    // The healthy member settles exactly as if the poisoned one never existed.
    const healthyOnly = requireComposed(
      composeCountryTaxYear('DE', 2026, testCompositionInput([healthyTaxMember(2000)])),
    );
    expect(result.taxTargetEur.valueEur).toBe(healthyOnly.taxTargetEur.valueEur);
    expect(result.de?.kapestEur.valueEur).toBe(healthyOnly.de?.kapestEur.valueEur);
  });

  it('reports a wholly unreadable scope as unavailable, never as a zero tax target', () => {
    const result = composeCountryTaxYear(
      'DE',
      2026,
      testCompositionInput([
        {
          state: 'visible',
          portfolioId: IDS.vaulted,
          source: 'vaulted',
          vaultId: IDS.vaultOne,
          value: taxValue('DE', [corruptedReport()]),
        },
        { state: 'locked', portfolioId: IDS.lockedOne, vaultId: IDS.vaultTwo },
      ]),
    );

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') throw new Error('Expected an unavailable composition.');
    expect(result.coverage).toEqual({
      kind: 'unavailable',
      visiblePortfolioCount: 0,
      lockedPortfolioCount: 1,
      unavailablePortfolioCount: 1,
    });
    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.vaulted, error: { code: 'TAX_DATA_INVALID' } },
    ]);
  });

  it('still throws for caller bugs instead of degrading them to member failures', () => {
    // Corrupt vault DATA degrades one member. A CALLER bug is not data: it can
    // only be fixed by changing the call site, so it must stay loud.
    //
    // REVIEW F3: what belongs on THIS side of the line is exactly the set the
    // caller computes for itself — the requested year ARGUMENT, the roster it
    // fetched, and the member shape it assembled. The report/activity year
    // INDEX left this list, because for a vaulted portfolio it is built by
    // scanning the decrypted document (`taxEngine.clientTaxYears`) and is
    // therefore attacker-influenced content, not a call-site fact.
    const healthy = [healthyTaxMember(2000)];

    expect(() => composeCountryTaxYear('DE', 2026.5, testCompositionInput(healthy))).toThrow(
      RangeError,
    );
    expect(() =>
      composeCountryTaxYear('DE', 2026, {
        authoritativeRoster: [{ portfolioId: IDS.plain, source: 'plain', vaultId: null }],
        members: [...healthy, ...healthy],
      }),
    ).toThrow(`Portfolio ${IDS.plain} occurs more than once in composition.`);
    expect(() =>
      composeCountryTaxYear('DE', 2026, {
        authoritativeRoster: [
          { portfolioId: IDS.plain, source: 'plain', vaultId: null },
          { portfolioId: IDS.lockedOne, source: 'vaulted', vaultId: IDS.vaultOne },
        ],
        members: healthy,
      }),
    ).toThrow(`Portfolio ${IDS.lockedOne} is missing from the authoritative composition roster`);
  });
});

describe('malformed member containers degrade, never escape (#1514 review F1)', () => {
  // Every case below is a whole-VIEW escape at review head: the container is
  // dereferenced before any per-element guard runs, so the throw leaves
  // composeCountryTaxYear entirely and takes the healthy portfolios' figures
  // with it. The member value is vault-derived, so the honest answer is a typed
  // per-member degradation.
  it.each([
    {
      shape: 'a null reports container',
      value: { ...taxValue('DE', []), reports: null },
    },
    {
      shape: 'a reports container that is not an array',
      value: { ...taxValue('DE', []), reports: 'not-an-array' },
    },
    {
      shape: 'a non-iterable activity-year index',
      value: { ...taxValue('DE', []), authoritativeActivityYears: 42 },
    },
    {
      shape: 'null effective settings',
      value: { ...taxValue('DE', []), effectiveSettings: null },
    },
  ])('degrades the member behind $shape', ({ value }) => {
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([healthyTaxMember(2000), malformedMember(value)]),
      ),
    );

    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.vaulted, error: { code: 'TAX_DATA_INVALID' } },
    ]);
    // The healthy portfolio is untouched by its neighbour's malformed shape.
    expect(result.realizedPnlEur.valueEur).toBe(2000);
    expect(result.taxTargetEur.coverage).toMatchObject({
      kind: 'partial',
      visiblePortfolioCount: 1,
      unavailablePortfolioCount: 1,
    });
  });

  it.each([
    { shape: 'an unknown tax mode', settings: { mode: 'freeform', country: null, custom: null } },
    {
      shape: 'a country the engine does not ship',
      settings: { mode: 'country_specific', country: 'ZZ', custom: null },
    },
    {
      shape: 'a country_specific mode with no country',
      settings: { mode: 'country_specific', country: null, custom: null },
    },
  ])('degrades a member whose settings carry $shape (#1514 review F6)', ({ settings }) => {
    // `effectiveSettings` is read out of the decrypted document like everything
    // else on the member, so nonsense in it degrades that member — the same
    // rule as the report rows, applied to the settings that classify them.
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          malformedMember({ ...taxValue('DE', []), effectiveSettings: settings }),
        ]),
      ),
    );

    expect(result.memberFailures).toMatchObject([{ portfolioId: IDS.vaulted }]);
    expect(result.memberFailures[0]?.error.code).toMatch(/^TAX_/);
    expect(result.realizedPnlEur.valueEur).toBe(2000);
  });

  it('degrades a member whose report explodes while it is being read', () => {
    // zod v3 `safeParse` catches ZodError and NOTHING else, so a throwing
    // accessor on the member value walks straight out of schema validation.
    // Unreachable from JSON today, but the member boundary must hold for any
    // throw, not only for the ones we predicted.
    const healthy = report('DE', stockAsset(), [
      { kind: 'sell', id: IDS.healthySell, amount: 500 },
    ]);
    const booby = {
      year: healthy.year,
      summary: healthy.summary,
      get positions(): never {
        throw new Error('decrypted document read exploded');
      },
    } as unknown as TaxYearReportResponse;

    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          malformedMember({ ...taxValue('DE', []), reports: [booby] }),
        ]),
      ),
    );

    expect(result.memberFailures).toMatchObject([{ portfolioId: IDS.vaulted }]);
    expect(result.realizedPnlEur.valueEur).toBe(2000);
  });
});

describe('report-year anomalies are member data, not caller bugs (#1514 review F3)', () => {
  // PREMISE CORRECTION: for a vaulted portfolio the activity-year index is
  // built by `taxEngine.clientTaxYears`, which scans the DECRYPTED DOCUMENT's
  // transactions/dividends/cashMovements — and the server activity-year routes
  // are killed by paranoidEnforcement. So both the report years and the
  // activity years are content, and an anomaly in them degrades one member.
  it('degrades a member that stamps a report with a year past the composed one', () => {
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          malformedMember(
            taxValue('DE', [
              report('DE', stockAsset(), [{ kind: 'sell', id: IDS.futureSell, amount: 999 }], 2027),
            ]),
          ),
        ]),
      ),
    );

    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.vaulted, error: { code: 'TAX_DATA_INVALID' } },
    ]);
    expect(result.memberFailures[0]?.error.message).toContain('2027');
    // Critically: the future-stamped row never reaches the pooled stream.
    expect(result.realizedPnlEur.valueEur).toBe(2000);
  });

  it('degrades a member that supplies the same report year twice', () => {
    const duplicated = taxValue('DE', [
      report('DE', stockAsset(), [{ kind: 'sell', id: IDS.duplicateYearSell, amount: 100 }], 2026),
      report('DE', stockAsset(), [{ kind: 'sell', id: IDS.corruptSell, amount: 100 }], 2026),
    ]);

    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([healthyTaxMember(2000), malformedMember(duplicated)]),
      ),
    );

    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.vaulted, error: { code: 'TAX_DATA_INVALID' } },
    ]);
    // Neither copy of the duplicated year was counted, once or twice.
    expect(result.realizedPnlEur.valueEur).toBe(2000);
  });

  it('degrades a member missing an authoritative prior activity year', () => {
    // Previously a whole-view RangeError. The index says the document holds
    // 2025 activity while no 2025 report came with it: the document and its
    // derived reports disagree, which is corruption of ONE member's data.
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          malformedMember({
            ...taxValue('DE', [report('DE', stockAsset(), [], 2026)]),
            authoritativeActivityYears: [2025, 2026],
          }),
        ]),
      ),
    );

    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.vaulted, error: { code: 'TAX_DATA_INVALID' } },
    ]);
    expect(result.memberFailures[0]?.error.message).toContain('2025');
    expect(result.realizedPnlEur.valueEur).toBe(2000);
  });

  it.each([
    { shape: 'an out-of-range activity year', years: [1899, 2026] },
    { shape: 'a fractional activity year', years: [2025.5, 2026] },
    { shape: 'a repeated activity year', years: [2026, 2026] },
  ])('degrades a member carrying $shape', ({ years }) => {
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          malformedMember({
            ...taxValue('DE', [report('DE', stockAsset(), [], 2026)]),
            authoritativeActivityYears: years,
          }),
        ]),
      ),
    );

    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.vaulted, error: { code: 'TAX_DATA_INVALID' } },
    ]);
    expect(result.realizedPnlEur.valueEur).toBe(2000);
  });
});

describe('ordinary portfolios that used to crash the composed view (#1514 review F3)', () => {
  it('composes an untaxed portfolio as a zero-event member, not a failure', () => {
    // USER STORY: I keep one portfolio on tax mode "none". It has sells, so its
    // activity-year index is not empty, but nothing derives tax reports for it.
    // My combined tax panel must still show my OTHER portfolio's numbers — this
    // portfolio simply is not taxed, and it is certainly not corrupt.
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          malformedMember({
            reports: [],
            authoritativeActivityYears: [2025, 2026],
            effectiveSettings: { mode: 'none', country: null, custom: null },
          }),
        ]),
      ),
    );

    expect(result.memberFailures).toEqual([]);
    expect(result.realizedPnlEur.valueEur).toBe(2000);
    // Two members contributed; the untaxed one contributed nothing but is not
    // withheld, so the figure is COMPLETE and wears no qualifier at all.
    expectComplete(result.taxTargetEur, 2);
  });

  it('composes a portfolio whose last activity predates the requested year', () => {
    // USER STORY: I stopped trading in this portfolio in 2024. Opening the 2026
    // combined view must not fail — the portfolio contributes no 2026 events,
    // and its carried 2024 loss must still reach the pooled loss pot.
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          malformedMember(
            taxValue('DE', [
              report(
                'DE',
                stockAsset(),
                [{ kind: 'sell', id: IDS.staleActivitySell, amount: -500 }],
                2024,
              ),
            ]),
          ),
        ]),
      ),
    );

    expect(result.memberFailures).toEqual([]);
    expectComplete(result.taxTargetEur, 2);
    // The dormant portfolio still carries its 2024 Aktien loss into 2026.
    expect(result.de?.aktienPotInEur.valueEur).toBe(500);
    // 2000 current gain − 500 carried loss − 1000 allowance = 500 taxed.
    expect(result.de?.kapestEur.valueEur).toBe(125);
    expect(result.realizedPnlEur.valueEur).toBe(2000);
  });
});

describe('pooled overflow cannot escape the seam (#1514 review F4)', () => {
  it('degrades every member whose row magnitude exceeds the report bound', () => {
    // Two schema-valid finite 1.7e308 rows sum to Infinity, and `floorCents`
    // then threw a CashLedgerError out of the whole composition — a crash that
    // could not even be attributed to one member. Bounding the row magnitude at
    // the schema turns it into two ordinary per-member degradations.
    const result = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          healthyTaxMember(2000),
          malformedMember(taxValue('DE', [overflowReport(IDS.overflowA)])),
          {
            state: 'visible',
            portfolioId: IDS.thirdPortfolio,
            source: 'vaulted',
            vaultId: IDS.vaultThree,
            value: taxValue('DE', [overflowReport(IDS.overflowB)]),
          },
        ]),
      ),
    );

    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.vaulted, error: { code: 'TAX_DATA_INVALID' } },
      { portfolioId: IDS.thirdPortfolio, error: { code: 'TAX_DATA_INVALID' } },
    ]);
    // The healthy member settles exactly as if the overflowing ones never came.
    const healthyOnly = requireComposed(
      composeCountryTaxYear('DE', 2026, testCompositionInput([healthyTaxMember(2000)])),
    );
    expect(result.taxTargetEur.valueEur).toBe(healthyOnly.taxTargetEur.valueEur);
    expect(result.realizedPnlEur.valueEur).toBe(2000);
    for (const figure of [
      result.taxTargetEur,
      result.realizedPnlEur,
      result.dividendsGrossEur,
      ...Object.values(result.de ?? {}),
    ]) {
      expect(Number.isFinite(figure.valueEur)).toBe(true);
      expect(figure.coverage).toMatchObject({
        kind: 'partial',
        visiblePortfolioCount: 1,
        unavailablePortfolioCount: 2,
      });
    }
  });

  it('keeps the magnitude bound a decade clear of every persisted EUR column', () => {
    // The bound must reject nothing a server can produce. `numeric(20,6)` — the
    // widest EUR column behind a tax report — tops out just under 1e14, and the
    // product's own user-entry cap (MAX_CASH_AMOUNT_EUR) at 1e12 is lower
    // still. The bound also stays under Number.MAX_SAFE_INTEGER, so nothing it
    // admits has already lost its euro part to float64.
    expect(MAX_TAX_REPORT_FIGURE_EUR).toBeGreaterThan(1e14);
    expect(MAX_TAX_REPORT_FIGURE_EUR).toBeGreaterThan(MAX_CASH_AMOUNT_EUR);
    expect(MAX_TAX_REPORT_FIGURE_EUR).toBeLessThan(Number.MAX_SAFE_INTEGER);

    // A figure at the DB ceiling composes; one past the bound degrades.
    const atCeiling = requireComposed(
      composeCountryTaxYear(
        'DE',
        2026,
        testCompositionInput([
          malformedMember(
            taxValue('DE', [
              report('DE', stockAsset(), [{ kind: 'sell', id: IDS.overflowA, amount: 1e14 }]),
            ]),
          ),
        ]),
      ),
    );
    // It composes rather than degrading — which is the whole claim. The value
    // is asserted loosely on purpose: `floorCents` multiplies by 100 before
    // flooring, so at the DB ceiling the intermediate passes 2^53 and lands a
    // fraction of a cent off. That is pre-existing ledger behaviour at an
    // absurd magnitude, untouched here, and it is orthogonal to the bound.
    expect(atCeiling.memberFailures).toEqual([]);
    expect(Number.isFinite(atCeiling.realizedPnlEur.valueEur)).toBe(true);
    expect(atCeiling.realizedPnlEur.valueEur).toBeGreaterThan(9.9e13);
  });
});

describe('additive figure members degrade at their own boundary (#1514 review F5)', () => {
  it('degrades a member carrying a non-finite figure and keeps the healthy total', () => {
    // The wiring epic feeds composePortfolioFigures vault-derived totals, so a
    // non-finite one is content, not a call-site bug: it must cost that one
    // member, not every figure on the page.
    const result = requireComposed(
      composePortfolioFigures(
        testCompositionInput([
          visible(IDS.plain, 'plain', null, { ...ZERO_FIGURES, totalValueEur: 100 }),
          visible(IDS.vaulted, 'vaulted', IDS.vaultOne, {
            ...ZERO_FIGURES,
            totalValueEur: Number.POSITIVE_INFINITY,
          }),
        ]),
      ),
    );

    expect(result.totalValueEur.valueEur).toBe(100);
    expect(result.totalValueEur.coverage).toEqual({
      kind: 'partial',
      visiblePortfolioCount: 1,
      lockedPortfolioCount: 0,
      unavailablePortfolioCount: 1,
      qualifier: {
        kind: 'unreadable-portfolios',
        count: 1,
        messageKey: UNREADABLE_PORTFOLIOS_QUALIFIER_ONE_MESSAGE_KEY,
      },
    });
    // The degradation is not confined to the figure that was broken: every
    // composed figure now rests on one portfolio, so every one wears the
    // qualifier. The healthy member's own values are still exact.
    expect(result.marketValueEur.coverage).toEqual(result.totalValueEur.coverage);
    expect(result.cashEur.coverage).toEqual(result.totalValueEur.coverage);
  });

  it('reports a wholly unreadable figure scope as unavailable, never as a zero', () => {
    const result = composePortfolioFigures(
      testCompositionInput([
        visible(IDS.plain, 'plain', null, {
          ...ZERO_FIGURES,
          totalValueEur: Number.NaN,
        }),
      ]),
    );

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') throw new Error('Expected an unavailable composition.');
    expect(result.coverage).toEqual({
      kind: 'unavailable',
      visiblePortfolioCount: 0,
      lockedPortfolioCount: 0,
      unavailablePortfolioCount: 1,
    });
    // VAULT_CORRUPT, not TAX_DATA_INVALID: these are net-worth figures, and the
    // code picks the copy the reader is shown.
    expect(result.memberFailures).toMatchObject([
      { portfolioId: IDS.plain, error: { code: 'VAULT_CORRUPT', retryable: false } },
    ]);
  });

  it('still throws when the CALLER hands it a broken roster', () => {
    // The member boundary must not swallow call-site bugs on this seam either.
    expect(() =>
      composePortfolioFigures({
        authoritativeRoster: [{ portfolioId: IDS.plain, source: 'plain', vaultId: null }],
        members: [
          visible(IDS.plain, 'plain', null, ZERO_FIGURES),
          visible(IDS.plain, 'plain', null, ZERO_FIGURES),
        ],
      }),
    ).toThrow(`Portfolio ${IDS.plain} occurs more than once in composition.`);
  });
});

/**
 * Narrows the seam's typed result to its composed arm and drops the
 * discriminant again, so every pre-existing exactness/pooling assertion below
 * keeps its expected values AND its shape: the seam now returns a
 * discriminated union (#1514), but none of the money assertions moved.
 */
function requireComposed<T extends { kind: 'composed' } | { kind: 'unavailable' }>(
  result: T,
): Omit<Extract<T, { kind: 'composed' }>, 'kind'> {
  if (result.kind !== 'composed') {
    throw new Error(`Expected a composed result, received "${String(result.kind)}".`);
  }
  const { kind: _discriminant, ...composed } = result as Extract<T, { kind: 'composed' }>;
  return composed;
}

/** The composed arm of {@link composePortfolioFigures}, or a failed assertion. */
function composedFigures(input: PortfolioCompositionInput<AdditivePortfolioFigures>) {
  return requireComposed(composePortfolioFigures(input));
}

/** The composed arm of {@link composeCountryTaxYear}, or a failed assertion. */
function composedTaxYear(...args: Parameters<typeof composeCountryTaxYear>) {
  return requireComposed(composeCountryTaxYear(...args));
}

/** A schema-valid DE member with one taxable gain, used as the healthy control. */
function healthyTaxMember(amount: number): PortfolioTaxCompositionMember {
  return {
    state: 'visible',
    portfolioId: IDS.plain,
    source: 'plain',
    vaultId: null,
    value: taxValue('DE', [
      report('DE', stockAsset(), [{ kind: 'sell', id: IDS.healthySell, amount }]),
    ]),
  };
}

/**
 * The vaulted member as the wiring epic will really hand it over: whatever the
 * decrypted document produced, INCLUDING shapes the compile-time type forbids.
 * The cast is the point — every probe below asks what happens when the runtime
 * value and the declared type disagree, which is exactly the attacker's move.
 */
function malformedMember(value: unknown): PortfolioTaxCompositionMember {
  return {
    state: 'visible',
    portfolioId: IDS.vaulted,
    source: 'vaulted',
    vaultId: IDS.vaultOne,
    value: value as Extract<PortfolioTaxCompositionMember, { state: 'visible' }>['value'],
  };
}

/** A schema-valid, finite report row whose magnitude alone overflows a pooled sum. */
function overflowReport(sellId: string): TaxYearReportResponse {
  const overflowing = report('DE', stockAsset(), [{ kind: 'sell', id: sellId, amount: 1.7e308 }]);
  // Finite, and accepted by the shared response contract as it stands today.
  expect(Number.isFinite(overflowing.positions[0]!.sells[0]!.realizedPnlEur)).toBe(true);
  expect(taxYearReportResponseSchema.safeParse(overflowing).success).toBe(true);
  return overflowing;
}

/** A zod-rejected report row: the money figure arrives as a string. */
function corruptedReport(): TaxYearReportResponse {
  const base = report('DE', stockAsset(), [{ kind: 'sell', id: IDS.corruptSell, amount: 500 }]);
  const position = base.positions[0]!;
  return {
    ...base,
    positions: [
      {
        ...position,
        sells: [{ ...position.sells[0]!, realizedPnlEur: '500' as unknown as number }],
      },
    ],
  };
}

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
