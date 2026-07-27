import { webcrypto } from 'node:crypto';

import {
  cashBalancesBySource,
  externalCashFlowsForTwr,
  netWorthSeries,
  type SourcedCashMovement,
} from '@bettertrack/domain/cashLedger';
import {
  costBasisOverTime,
  deriveHoldings,
  netFlowsOverTime,
  timeWeightedReturn,
  valueOverTime,
  type Transaction,
} from '@bettertrack/domain/holdings';
import { computeSeriesStats } from '@bettertrack/domain/seriesStats';
import {
  initialCustomCarry,
  settleAtYear,
  settleCustomYear,
  settleDeYear,
} from '@bettertrack/domain/tax';
import { beforeEach, describe, expect, it } from 'vitest';

import { createVaultMoneyEngine } from './index';
import {
  CLIENT_MONEY_IDS,
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
  withTaxSettings,
} from './clientMoney.testSupport';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('paranoid client money engine', () => {
  it('decrypts the fixed multi-currency fixture and matches shared-domain money math exactly', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header, fixture.envelope);
    const market = createClientMoneyMarket();
    const engine = createVaultMoneyEngine(sync, market.market, { now: () => NOW });

    const outcome = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const expected = await expectedFixtureDerivation();
    expect(outcome.value.vaultVersion).toBe(11);
    expect(outcome.value.holdings).toEqual(expected.holdings);
    expect(outcome.value.cashSources).toEqual([
      { sourceId: CLIENT_MONEY_IDS.cashSource, name: 'Main', balanceEur: 1020 },
    ]);
    expect(outcome.value.cashBalanceEur).toBe(1020);
    expect(outcome.value.holdingsValueEur).toBe(1265);
    expect(outcome.value.totalValueEur).toBe(2285);
    expect(outcome.value.allocation).toEqual([
      {
        assetId: CLIENT_MONEY_IDS.eurAsset,
        valueEur: 1040,
        pct: (1040 / 1265) * 100,
      },
      {
        assetId: CLIENT_MONEY_IDS.usdAsset,
        valueEur: 225,
        pct: (225 / 1265) * 100,
      },
    ]);
    expect(
      outcome.value.series.map(({ date, valueEur, costBasisEur, pnlEur, twrPct }) => ({
        date,
        valueEur,
        costBasisEur,
        pnlEur,
        twrPct,
      })),
    ).toEqual(expected.series);
    expect(outcome.value.series.at(-1)).toMatchObject({
      date: '2026-07-27',
      valueEur: 2285,
      costBasisEur: 984.9,
      pnlEur: 280.1,
      isLiveToday: true,
      missingAssetIds: [],
    });
    expect(outcome.value.freshness).toBe('fresh');
    expect(outcome.value.missingAssetIds).toEqual([]);
    expect(outcome.value.stats).toEqual(expected.stats);
  });

  it('replays same-instant transactions in stable entity-id order', async () => {
    const fixture = await decryptClientMoneyFixture();
    const withTie = withAdditionalTransaction(
      withAdditionalTransaction(fixture.document, '018f0000-0000-7000-8000-000000000108', {
        side: 'buy',
        quantity: '1',
        price: '50',
        fee: '0',
        executedAt: '2026-07-20T10:00:00.000Z',
      }),
      '018f0000-0000-7000-8000-000000000109',
      {
        side: 'sell',
        quantity: '1',
        price: '60',
        fee: '0',
        executedAt: '2026-07-20T10:00:00.000Z',
      },
    );
    const result = await createVaultMoneyEngine(
      createMutableTestSync(withTie, fixture.header),
      createClientMoneyMarket().market,
      { now: () => NOW },
    ).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.holdings.find((holding) => holding.assetId === CLIENT_MONEY_IDS.eurAsset),
    ).toMatchObject({
      quantity: 8,
      avgCost: 100.5,
      realizedPnl: 47,
    });
  });

  it('matches AT, DE, and custom settlements and rejects unsupported tax modes', async () => {
    const fixture = await decryptClientMoneyFixture();
    const market = createClientMoneyMarket();

    const deDocument = withAdditionalTransaction(
      fixture.document,
      '018f0000-0000-7000-8000-000000000118',
      {
        side: 'sell',
        quantity: '2',
        price: '80',
        fee: '2',
        executedAt: '2026-07-26T15:00:00.000Z',
      },
    );
    const deSync = createMutableTestSync(deDocument, fixture.header);
    const deEngine = createVaultMoneyEngine(deSync, market.market, { now: () => NOW });
    const de = await deEngine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(de.ok).toBe(true);
    if (!de.ok) return;
    const expectedDe = settleDeYear({
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      existingEvents: [
        { kind: 'sell_gain', category: 'aktien', amountEur: 37 },
        { kind: 'sell_gain', category: 'aktien', amountEur: -43 },
        { kind: 'dividend', amountEur: 30 },
      ],
      heldEur: 0,
      newEvents: [],
    });
    expect(de.value.computedTaxTargetEur).toBe(expectedDe.heldAfterEur);
    expect(de.value.report.summary).toMatchObject({
      realizedPnlEur: -6,
      dividendsGrossEur: 30,
      taxWithheldEur: 10,
      taxRefundedEur: 0,
      taxNetEur: expectedDe.heldAfterEur,
      de: {
        allowanceUsedEur: expectedDe.yearEnd.allowanceUsedEur,
        allowanceRemainingEur: expectedDe.yearEnd.allowanceRemainingEur,
        aktienPotOutEur: expectedDe.yearEnd.aktienPotOutEur,
        sonstigePotOutEur: expectedDe.yearEnd.sonstigePotOutEur,
        kapestEur: expectedDe.yearEnd.kapestEur,
        soliEur: expectedDe.yearEnd.soliEur,
      },
    });

    const atDocument = withTaxSettings(fixture.document, 'country_specific', 'AT', null);
    const at = await createVaultMoneyEngine(
      createMutableTestSync(atDocument, fixture.header),
      market.market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    const expectedAt = settleAtYear({
      existingGainsEur: [37],
      existingDividendsEur: [30],
      heldEur: 0,
      newEvents: [],
    });
    expect(at).toMatchObject({
      ok: true,
      value: {
        computedTaxTargetEur: expectedAt.heldAfterEur,
        report: { summary: { taxNetEur: expectedAt.heldAfterEur } },
      },
    });
    const legacyAt = await createVaultMoneyEngine(
      createMutableTestSync(
        withTaxSettings(fixture.document, 'country_specific', null, null),
        fixture.header,
      ),
      market.market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(legacyAt).toMatchObject({
      ok: true,
      value: {
        computedTaxTargetEur: expectedAt.heldAfterEur,
        report: { summary: { taxNetEur: expectedAt.heldAfterEur } },
      },
    });

    const scopedMarket = createClientMoneyMarket();
    const scopedFx = scopedMarket.market.fx;
    scopedMarket.market.fx = async (...args) => {
      if (args[0] === 'USD') throw new Error('buy-only USD FX is unavailable');
      return scopedFx(...args);
    };
    const scoped = await createVaultMoneyEngine(
      createMutableTestSync(atDocument, fixture.header),
      scopedMarket.market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(scoped.ok).toBe(true);
    expect(scopedMarket.calls.fx.some((call) => call.startsWith('USD:'))).toBe(false);

    const customParams = {
      ratePct: 20,
      lossOffset: true,
      refund: true,
      yearReset: true,
      carryForward: false,
      costBasis: 'fifo' as const,
    };
    const customDocument = withAdditionalTransaction(
      withTaxSettings(fixture.document, 'custom', null, customParams),
      '018f0000-0000-7000-8000-000000000119',
      {
        side: 'buy',
        quantity: '2',
        price: '200',
        fee: '0',
        executedAt: '2026-07-22T15:00:00.000Z',
      },
    );
    const custom = await createVaultMoneyEngine(
      createMutableTestSync(customDocument, fixture.header),
      market.market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    const expectedCustom = settleCustomYear({
      params: customParams,
      carry: initialCustomCarry(),
      existingEvents: [
        { kind: 'sell_gain', amountEur: 37 },
        { kind: 'dividend', amountEur: 30 },
      ],
      heldEur: 0,
      newEvents: [],
    });
    expect(custom).toMatchObject({
      ok: true,
      value: {
        computedTaxTargetEur: expectedCustom.heldAfterEur,
        report: { summary: { taxNetEur: expectedCustom.heldAfterEur } },
      },
    });
    const frozenDeDocument = structuredClone(customDocument);
    const frozenSell = frozenDeDocument.entities.transaction?.find(
      (entity) => entity.id === '018f0000-0000-7000-8000-000000000112',
    );
    if (frozenSell === undefined) throw new Error('Fixture sell is missing.');
    frozenSell.data.taxMode = 'country_specific';
    frozenSell.data.taxCountry = 'DE';
    frozenSell.data.taxParams = null;
    const untaxed = await createVaultMoneyEngine(
      createMutableTestSync(withTaxSettings(frozenDeDocument, 'none', null, null), fixture.header),
      market.market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(untaxed).toMatchObject({
      ok: true,
      value: {
        computedTaxTargetEur: 0,
        report: {
          summary: { taxNetEur: 0 },
          positions: [{ realizedPnlEur: 37 }],
        },
      },
    });

    const ratchetParams = {
      ratePct: 20,
      lossOffset: true,
      refund: false,
      yearReset: true,
      carryForward: false,
      costBasis: 'moving-average' as const,
    };
    const ratchet = await createVaultMoneyEngine(
      createMutableTestSync(
        withTaxSettings(deDocument, 'custom', null, ratchetParams),
        fixture.header,
      ),
      market.market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    const expectedRatchet = settleCustomYear({
      params: ratchetParams,
      carry: initialCustomCarry(),
      existingEvents: [
        { kind: 'sell_gain', amountEur: 37 },
        { kind: 'dividend', amountEur: 30 },
        { kind: 'sell_gain', amountEur: -43 },
      ],
      heldEur: 0,
      newEvents: [],
    });
    expect(ratchet).toMatchObject({
      ok: true,
      value: {
        computedTaxTargetEur: expectedRatchet.heldAfterEur,
        report: { summary: { taxNetEur: expectedRatchet.heldAfterEur } },
      },
    });

    const unsupported = withTaxSettings(fixture.document, 'country_specific', 'FI', null);
    const rejected = await createVaultMoneyEngine(
      createMutableTestSync(unsupported, fixture.header),
      market.market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'TAX_MODE_UNSUPPORTED' },
    });
  });

  it('preserves frozen FIFO realizations after switching the current year to manual mode', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withAdditionalTransaction(
      fixture.document,
      '018f0000-0000-7000-8000-000000000122',
      {
        side: 'buy',
        quantity: '2',
        price: '200',
        fee: '0',
        executedAt: '2026-07-22T15:00:00.000Z',
      },
    );
    const frozenSell = document.entities.transaction?.find(
      (entity) => entity.id === '018f0000-0000-7000-8000-000000000112',
    );
    if (frozenSell === undefined) throw new Error('Fixture sell is missing.');
    frozenSell.data.taxMode = 'country_specific';
    frozenSell.data.taxCountry = 'DE';
    frozenSell.data.taxParams = null;
    const manual = withTaxSettings(document, 'manual_per_trade', null, null);

    const result = await createVaultMoneyEngine(
      createMutableTestSync(manual, fixture.header),
      createClientMoneyMarket().market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Audited server vector: the frozen DE row consumes the first 2 units from
    // the 10 @ 100 lot plus its proportional fee, not the later 2 @ 200 lot.
    expect(result.value.report.summary.realizedPnlEur).toBe(37);
    expect(result.value.report.positions[0]?.sells[0]).toMatchObject({
      transactionId: frozenSell.id,
      proceedsEur: 238,
      costBasisEur: 201,
      realizedPnlEur: 37,
      taxMode: 'country_specific',
    });
  });

  it('marks missing and stale market inputs explicitly instead of using a silent fallback', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header);
    const market = createClientMoneyMarket();
    market.setMissingQuote(CLIENT_MONEY_IDS.usdAsset, true);
    const engine = createVaultMoneyEngine(sync, market.market, { now: () => NOW });

    const missing = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(missing).toMatchObject({
      ok: true,
      value: {
        holdingsValueEur: null,
        totalValueEur: null,
        allocation: null,
        missingAssetIds: [CLIENT_MONEY_IDS.usdAsset],
      },
    });
    if (missing.ok) {
      expect(missing.value.series.at(-1)).toMatchObject({
        valueEur: null,
        costBasisEur: null,
        pnlEur: null,
        twrPct: null,
        missingAssetIds: [CLIENT_MONEY_IDS.usdAsset],
      });
    }

    market.setMissingQuote(CLIENT_MONEY_IDS.usdAsset, false);
    market.setStale(true);
    engine.clearCache();
    const stale = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(stale).toMatchObject({
      ok: true,
      value: { freshness: 'stale' },
    });
    if (stale.ok) {
      expect(stale.value.series.every((point) => point.freshness === 'stale')).toBe(true);
    }
    await expect(engine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026)).resolves.toMatchObject({
      ok: true,
      value: { freshness: 'stale' },
    });
  });

  it('caches derived work by vault version, market watermark, and range in memory only', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header);
    const market = createClientMoneyMarket();
    const engine = createVaultMoneyEngine(sync, market.market, { now: () => NOW });

    const first = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    const second = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toBe(first.value);

    market.setQuoteWatermark('quotes-v2');
    const repriced = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(repriced.ok).toBe(true);
    if (!repriced.ok) return;
    expect(repriced.value).not.toBe(first.value);

    market.setFxWatermark('fx-v2');
    const reFx = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(reFx.ok).toBe(true);
    if (!reFx.ok) return;
    expect(reFx.value).not.toBe(repriced.value);

    sync.setDocument(structuredClone(fixture.document));
    const mutated = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(mutated.ok).toBe(true);
    if (!mutated.ok) return;
    expect(mutated.value).not.toBe(reFx.value);
  });

  it('keeps the audited since-inception TWR vector for MAX and rebases only bounded ranges', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    document.entities.transaction = [document.entities.transaction![0]!];
    document.entities.cashMovement = [];
    document.entities.dividend = [];
    const engine = createVaultMoneyEngine(
      createMutableTestSync(document, fixture.header),
      createClientMoneyMarket().market,
      { now: () => NOW },
    );

    const maximum = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    const bounded = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, '1M');
    expect(maximum.ok).toBe(true);
    expect(bounded.ok).toBe(true);
    if (!maximum.ok || !bounded.ok) return;

    const auditedServerVector = [
      -0.497512437810943, 4.47761194029852, 9.452736318407972, 14.427860696517424,
      19.402985074626876, 24.37810945273633, 27.36318407960201, 29.35323383084578,
    ];
    expect(maximum.value.series).toHaveLength(auditedServerVector.length);
    maximum.value.series.forEach((point, index) => {
      expect(point.twrPct).toBeCloseTo(auditedServerVector[index]!, 12);
    });
    expect(bounded.value.series[0]?.twrPct).toBe(0);
    expect(maximum.value.series[0]?.twrPct).toBeCloseTo(auditedServerVector[0]!, 12);
  });

  it('matches the audited split-date cash-buy compensators', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    const transaction = document.entities.transaction![0]!;
    document.entities.transaction = [transaction];
    document.entities.dividend = [];
    const deposit = structuredClone(document.entities.cashMovement![0]!);
    deposit.data.amountEur = '2000';
    const settlement = structuredClone(deposit);
    settlement.id = '018f0000-0000-7000-8000-000000000119';
    settlement.data.kind = 'buy';
    settlement.data.amountEur = '-1005';
    settlement.data.transactionId = transaction.id;
    settlement.data.executedAt = '2026-07-22T09:00:00.000Z';
    settlement.data.createdAt = '2026-07-22T09:00:00.000Z';
    settlement.editedAt = '2026-07-22T09:00:00.000Z';
    document.entities.cashMovement = [deposit, settlement];

    const result = await createVaultMoneyEngine(
      createMutableTestSync(document, fixture.header),
      createClientMoneyMarket().market,
      { now: () => NOW },
    ).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const auditedServerVector = [
      0, -0.16638935108153063, 1.4975041597337757, 3.161397670549082, 5.623483533808016,
      8.08556939706695, 10.547655260325882, 12.024906778281231, 13.009741123584796,
    ];
    expect(result.value.series.map((point) => point.date)).toEqual([
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
      '2026-07-26',
      '2026-07-27',
    ]);
    result.value.series.forEach((point, index) => {
      expect(point.twrPct).toBeCloseTo(auditedServerVector[index]!, 12);
    });
  });

  it('matches audited manual smoothing and never fabricates a custom-asset day change', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    document.entities.transaction = [document.entities.transaction![0]!];
    const asset = document.entities.customAsset!.find(
      (entity) => entity.id === CLIENT_MONEY_IDS.eurAsset,
    )!;
    asset.data.providerId = 'manual';
    asset.data.providerRef = asset.id;
    asset.data.ownerId = CLIENT_MONEY_IDS.user;
    asset.data.type = 'custom';
    asset.data.meta = { smoothing: true };
    document.entities.customAssetValue = [
      manualValue('018f0000-0000-7000-8000-000000000120', asset.id, '2026-07-20', '100'),
      manualValue('018f0000-0000-7000-8000-000000000121', asset.id, '2026-07-22', '200'),
    ];
    const market = createClientMoneyMarket();

    const result = await createVaultMoneyEngine(
      createMutableTestSync(document, fixture.header),
      market.market,
      { now: () => NOW },
    ).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    expect(result.value.series.find((point) => point.date === '2026-07-21')).toMatchObject({
      valueEur: 2500,
    });
    expect(result.value.holdings[0]).toMatchObject({
      price: 200,
      dayChangeEur: null,
      dayChangePct: null,
    });
    expect(market.calls.quote).not.toContain(CLIENT_MONEY_IDS.eurAsset);
    expect(market.calls.history).not.toContain(CLIENT_MONEY_IDS.eurAsset);
  });

  it('loads FX only from the day each staggered foreign holding can contribute', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    const usdTransaction = document.entities.transaction!.find(
      (entity) => entity.data.assetId === CLIENT_MONEY_IDS.usdAsset,
    )!;
    usdTransaction.data.executedAt = '2026-07-26T10:00:00.000Z';
    usdTransaction.editedAt = '2026-07-26T10:00:00.000Z';
    const market = createClientMoneyMarket();
    const fx = market.market.fx;
    market.market.fx = async (from, to, date, signal) => {
      if (from === 'USD' && date !== undefined && date < '2026-07-26') {
        throw new Error(`irrelevant USD history requested for ${date}`);
      }
      return fx(from, to, date, signal);
    };

    const result = await createVaultMoneyEngine(
      createMutableTestSync(document, fixture.header),
      market.market,
      { now: () => NOW },
    ).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');

    expect(result.ok).toBe(true);
    expect(
      market.calls.fx.filter((call) => call.startsWith('USD:EUR:') && !call.endsWith(':spot')),
    ).toEqual(['USD:EUR:2026-07-26', 'USD:EUR:2026-07-27']);
  });

  it('does not reuse a cash-only live point across a UTC day rollover', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    document.entities.transaction = [];
    let now = NOW;
    const engine = createVaultMoneyEngine(
      createMutableTestSync(document, fixture.header),
      createClientMoneyMarket().market,
      { now: () => now },
    );

    const first = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    now = Date.parse('2026-07-28T00:01:00.000Z');
    const nextDay = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');

    expect(first.ok, first.ok ? undefined : JSON.stringify(first.error)).toBe(true);
    expect(nextDay.ok, nextDay.ok ? undefined : JSON.stringify(nextDay.error)).toBe(true);
    if (!first.ok || !nextDay.ok) return;
    expect(nextDay.value).not.toBe(first.value);
    expect(first.value.series.at(-1)).toMatchObject({ date: '2026-07-27', isLiveToday: true });
    expect(nextDay.value.series.at(-1)).toMatchObject({ date: '2026-07-28', isLiveToday: true });
    expect(nextDay.value.series.find((point) => point.date === '2026-07-27')).toMatchObject({
      isLiveToday: false,
    });
  });

  it('fails closed for lock/version races, malformed entities, and unsupported documents', async () => {
    const fixture = await decryptClientMoneyFixture();
    const lockedSync = createMutableTestSync(fixture.document, fixture.header);
    lockedSync.setLocked();
    const lockedMarket = createClientMoneyMarket();
    const locked = await createVaultMoneyEngine(lockedSync, lockedMarket.market, {
      now: () => NOW,
    }).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(locked).toMatchObject({ ok: false, error: { code: 'VAULT_LOCKED' } });
    expect(lockedMarket.calls.quote).toEqual([]);

    const corruptDocument = structuredClone(fixture.document);
    corruptDocument.entities.transaction![0]!.data.unexpected = 'must fail';
    const corruptMarket = createClientMoneyMarket();
    const corrupt = await createVaultMoneyEngine(
      createMutableTestSync(corruptDocument, fixture.header),
      corruptMarket.market,
      { now: () => NOW },
    ).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(corrupt).toMatchObject({ ok: false, error: { code: 'VAULT_CORRUPT' } });
    expect(corruptMarket.calls.quote).toEqual([]);

    const invalidRelation = structuredClone(fixture.document);
    invalidRelation.entities.cashMovement![0]!.data.transactionId =
      '018f0000-0000-7000-8000-000000000199';
    const invalidOwnership = await createVaultMoneyEngine(
      createMutableTestSync(invalidRelation, fixture.header),
      createClientMoneyMarket().market,
      { now: () => NOW },
    ).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(invalidOwnership).toMatchObject({
      ok: false,
      error: { code: 'VAULT_INVALID_OWNERSHIP' },
    });

    const invalidMarket = createClientMoneyMarket();
    invalidMarket.market.quote = async (assetId) => ({
      value: {
        price: 0,
        currency: assetId === CLIENT_MONEY_IDS.usdAsset ? 'USD' : 'EUR',
        asOf: '2026-07-27T12:00:00.000Z',
      },
      stale: false,
      asOf: '2026-07-27T12:00:00.000Z',
      watermark: `invalid:${assetId}`,
    });
    const unchangedSync = createMutableTestSync(fixture.document, fixture.header);
    const invalidPrice = await createVaultMoneyEngine(unchangedSync, invalidMarket.market, {
      now: () => NOW,
    }).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(invalidPrice).toMatchObject({
      ok: false,
      error: { code: 'MARKET_DATA_INVALID' },
    });
    expect(unchangedSync.state.active?.document).toBe(fixture.document);

    const raceSync = createMutableTestSync(fixture.document, fixture.header);
    const raceMarket = createClientMoneyMarket();
    const history = raceMarket.market.history;
    raceMarket.market.history = async (...args) => {
      const value = await history(...args);
      raceSync.setDocument(structuredClone(fixture.document));
      return value;
    };
    const raced = await createVaultMoneyEngine(raceSync, raceMarket.market, {
      now: () => NOW,
    }).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(raced).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED', retryable: true },
    });

    const futureDocument = {
      ...structuredClone(fixture.document),
      schemaVersion: 2,
    } as unknown as typeof fixture.document;
    const unsupported = await createVaultMoneyEngine(
      createMutableTestSync(futureDocument, fixture.header),
      createClientMoneyMarket().market,
      { now: () => NOW },
    ).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'VAULT_UNSUPPORTED_VERSION' },
    });
  });

  it('returns truthful empty derivations from a valid empty portfolio', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    document.entities.transaction = [];
    document.entities.dividend = [];
    document.entities.cashMovement = [];
    const sync = createMutableTestSync(document, fixture.header);
    const engine = createVaultMoneyEngine(sync, createClientMoneyMarket().market, {
      now: () => NOW,
    });

    await expect(engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX')).resolves.toMatchObject({
      ok: true,
      value: {
        holdings: [],
        holdingsValueEur: 0,
        cashBalanceEur: 0,
        totalValueEur: 0,
        allocation: [],
        series: [],
        stats: null,
      },
    });
    await expect(engine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026)).resolves.toMatchObject({
      ok: true,
      value: {
        computedTaxTargetEur: 0,
        report: {
          summary: {
            realizedPnlEur: 0,
            dividendsGrossEur: 0,
            taxNetEur: 0,
          },
          positions: [],
        },
      },
    });
  });
});

async function expectedFixtureDerivation() {
  const transactions: Array<Transaction & { id: string }> = [
    {
      id: '018f0000-0000-7000-8000-000000000110',
      assetId: CLIENT_MONEY_IDS.eurAsset,
      side: 'buy',
      quantity: 10,
      price: 100,
      fee: 5,
      executedAt: '2026-07-20T10:00:00.000Z',
    },
    {
      id: '018f0000-0000-7000-8000-000000000111',
      assetId: CLIENT_MONEY_IDS.usdAsset,
      side: 'buy',
      quantity: 5,
      price: 40,
      fee: 1,
      executedAt: '2026-07-20T10:00:00.000Z',
    },
    {
      id: '018f0000-0000-7000-8000-000000000112',
      assetId: CLIENT_MONEY_IDS.eurAsset,
      side: 'sell',
      quantity: 2,
      price: 120,
      fee: 2,
      executedAt: '2026-07-24T15:00:00.000Z',
    },
  ];
  const prices = [
    {
      assetId: CLIENT_MONEY_IDS.eurAsset,
      currency: 'EUR',
      prices: [100, 105, 110, 115, 120, 125, 128, 130].map((close, index) => ({
        date: `2026-07-${String(index + 20).padStart(2, '0')}`,
        close,
      })),
    },
    {
      assetId: CLIENT_MONEY_IDS.usdAsset,
      currency: 'USD',
      prices: [40, 41, 42, 43, 44, 45, 46, 50].map((close, index) => ({
        date: `2026-07-${String(index + 20).padStart(2, '0')}`,
        close,
      })),
    },
  ];
  const converter = {
    async toBase(amount: number, currency: string) {
      return amount * (currency === 'USD' ? 0.9 : 1);
    },
  };
  const holdings = await deriveHoldings(
    transactions,
    [
      {
        assetId: CLIENT_MONEY_IDS.eurAsset,
        currency: 'EUR',
        quote: { price: 130, prevClose: 128 },
      },
      {
        assetId: CLIENT_MONEY_IDS.usdAsset,
        currency: 'USD',
        quote: { price: 50, prevClose: 46 },
      },
    ],
    converter,
  );
  const movements: SourcedCashMovement[] = [
    {
      sourceId: CLIENT_MONEY_IDS.cashSource,
      kind: 'deposit',
      amountEur: 1000,
      occurredAt: '2026-07-19T08:00:00.000Z',
    },
    {
      sourceId: CLIENT_MONEY_IDS.cashSource,
      kind: 'dividend',
      amountEur: 30,
      occurredAt: '2026-07-25T12:00:00.000Z',
    },
    {
      sourceId: CLIENT_MONEY_IDS.cashSource,
      kind: 'tax_withholding',
      amountEur: -10,
      occurredAt: '2026-07-26T12:00:00.000Z',
    },
  ];
  const values = await valueOverTime({
    transactions,
    assets: prices,
    today: '2026-07-27',
    converter,
  });
  const costs = await costBasisOverTime({
    transactions,
    assets: prices,
    today: '2026-07-27',
    converter,
  });
  const worth = netWorthSeries({ holdingsValues: values, movements, today: '2026-07-27' });
  const flows = [
    ...(await netFlowsOverTime({
      transactions,
      currencyByAsset: new Map([
        [CLIENT_MONEY_IDS.eurAsset, 'EUR'],
        [CLIENT_MONEY_IDS.usdAsset, 'USD'],
      ]),
      converter,
    })),
    ...externalCashFlowsForTwr(movements),
  ];
  const twr = new Map(timeWeightedReturn(worth, flows).map((point) => [point.date, point.pct]));
  const holdingValues = new Map(values.map((point) => [point.date, point.valueEur]));
  const costValues = new Map(costs.map((point) => [point.date, point.costBasisEur]));
  expect([...cashBalancesBySource(movements).values()]).toEqual([1020]);
  return {
    holdings,
    stats: computeSeriesStats(worth.map((point) => ({ date: point.date, value: point.valueEur }))),
    series: worth.map((point) => {
      const costBasisEur = costValues.get(point.date) ?? 0;
      return {
        date: point.date,
        valueEur: point.valueEur,
        costBasisEur,
        pnlEur: (holdingValues.get(point.date) ?? 0) - costBasisEur,
        twrPct: twr.get(point.date) ?? 0,
      };
    }),
  };
}

function withAdditionalTransaction(
  document: Awaited<ReturnType<typeof decryptClientMoneyFixture>>['document'],
  id: string,
  patch: {
    side: 'buy' | 'sell';
    quantity: string;
    price: string;
    fee: string;
    executedAt: string;
  },
) {
  const next = structuredClone(document);
  next.entities.transaction = [
    ...(next.entities.transaction ?? []),
    {
      id,
      rev: 0,
      editedAt: patch.executedAt,
      editedBy: CLIENT_MONEY_IDS.device,
      deletedAt: null,
      data: {
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        assetId: CLIENT_MONEY_IDS.eurAsset,
        ...patch,
        note: null,
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        allowUncovered: false,
        uncoveredEntryPrice: null,
        source: 'manual',
      },
    },
  ];
  return next;
}

function manualValue(id: string, assetId: string, date: string, close: string) {
  return {
    id,
    rev: 0,
    editedAt: `${date}T12:00:00.000Z`,
    editedBy: CLIENT_MONEY_IDS.device,
    deletedAt: null,
    data: { assetId, date, close },
  };
}
