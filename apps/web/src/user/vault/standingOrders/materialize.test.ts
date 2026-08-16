import { webcrypto } from 'node:crypto';

import {
  decodeVaultEnvelope,
  vaultEnvelopeHeaderSchema,
  type VaultDocument,
  type VaultEntity,
} from '@bettertrack/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { MarketDataSourceError, type MarketDataSource } from '../../../lib/marketDataSource';
import {
  CLIENT_MONEY_IDS,
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
} from '../engine/clientMoney.testSupport';
import { createVaultMoneyEngine } from '../engine';
import { encryptVaultDocument } from '../crypto';
import type { DataHome, DataHomeWriteOptions, DataHomeWriteResult } from '../dataHome';
import {
  createLocalDataHome,
  type LocalDataHomeStorage,
  type LocalVaultRecord,
} from '../localDataHome';
import { createMemoryVaultQuarantineStore } from '../quarantine';
import { createVaultSyncEngine, type VaultSyncEngine } from '../sync';
import {
  createVaultPortfolioStore,
  reconcilePortfolioDocument,
  type VaultPortfolioStore,
} from '../vaultPortfolioStore';
import { createStandingOrderMaterializationLifecycle } from './lifecycle';
import { materializeDueStandingOrders, STANDING_ORDER_MAX_QUOTE_AGE_MS } from './materialize';
import { standingOrderOccurrenceId } from './occurrenceId';
import { calendarDayInTimezone, dueStandingOrderOccurrence } from './schedule';

const DAILY_ADD_ID = '018f0000-0000-7000-8000-000000000201';
const MONTHLY_BUY_ID = '018f0000-0000-7000-8000-000000000202';
const PAUSED_ID = '018f0000-0000-7000-8000-000000000203';
const NOT_DUE_ID = '018f0000-0000-7000-8000-000000000204';
const DEDUCT_ID = '018f0000-0000-7000-8000-000000000205';
const DEVICE_ID = CLIENT_MONEY_IDS.device;
const SECOND_DEVICE_ID = '018f0000-0000-7000-8000-000000000206';
const LEGACY_RUN_ID = '018f0000-0000-7000-8000-0000000002a1';
const LEGACY_LEDGER_ID = '018f0000-0000-7000-8000-0000000002a2';
const REPLACEMENT_WRITE_ID = '018f0000-0000-7000-8000-0000000002a3';
const MISSING_ASSET_ID = '018f0000-0000-7000-8000-0000000002a4';
const BOOKED_AT = '2026-07-26T22:30:00.000Z';
const PRIOR_BOOKED_AT = '2026-07-26T05:00:00.000Z';
const PRIOR_BUY_EXECUTED_AT = '2026-07-20T06:00:00.000Z';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('paranoid standing-order materialization', () => {
  it('books daily and newest-only monthly occurrences atomically after unlock', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        label: 'Salary',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        label: 'Monthly ETF',
        cadence: 'monthly',
        anchorDay: 31,
        startDate: '2026-05-01',
      }),
      standingOrder(PAUSED_ID, {
        kind: 'cash-deduct',
        amount: '5',
        label: 'Paused',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
        status: 'paused',
      }),
      standingOrder(NOT_DUE_ID, {
        kind: 'cash-add',
        amount: '5',
        label: 'Tomorrow',
        cadence: 'monthly',
        anchorDay: 28,
        startDate: '2026-07-01',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync);
    const market = createClientMoneyMarket();

    const outcome = await materializeDueStandingOrders(sync, store, market.market, {
      now: () => new Date(BOOKED_AT),
      timezone: 'Europe/Vienna',
    });

    expect(outcome.ok, outcome.ok ? undefined : JSON.stringify(outcome.error)).toBe(true);
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        today: '2026-07-27',
        booked: [
          {
            orderId: DAILY_ADD_ID,
            dueDate: '2026-07-27',
            kind: 'cash-add',
            status: 'created',
          },
          {
            orderId: MONTHLY_BUY_ID,
            dueDate: '2026-06-30',
            kind: 'buy-asset',
            status: 'created',
          },
        ],
        deferred: [],
      },
    });
    const active = sync.state.active!.document;
    const dailyOccurrence = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
    expect(dailyOccurrence).toBe('3a739294-e8b8-5811-9c83-9e4ee7c8b2b6');
    const monthlyOccurrence = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-06-30');
    expect(live(active, 'cashMovement', dailyOccurrence)?.data).toMatchObject({
      kind: 'deposit',
      amountEur: '25',
      source: 'standing-order',
      executedAt: BOOKED_AT,
    });
    expect(live(active, 'transaction', monthlyOccurrence)?.data).toMatchObject({
      assetId: CLIENT_MONEY_IDS.eurAsset,
      side: 'buy',
      quantity: '1',
      price: '130',
      fee: '0',
      source: 'standing-order',
      executedAt: BOOKED_AT,
    });
    expect(active.entities.standingOrderRun).toHaveLength(2);
    expect(active.entities.standingOrderRun?.map((entity) => entity.data.periodKey).sort()).toEqual(
      ['2026-06-30', '2026-07-27'],
    );
    expect(
      active.entities.standingOrderRun?.some((run) => run.data.periodKey === '2026-05-31'),
    ).toBe(false);
    expect(order(active, DAILY_ADD_ID).data).toMatchObject({
      lastRunAt: BOOKED_AT,
      lastPeriodKey: '2026-07-27',
    });
    // The fixture's provider clock is ahead of this scan, so the record-only
    // market stamp is clamped without changing the transaction's execution time.
    expect(order(active, MONTHLY_BUY_ID).data).toMatchObject({
      lastRunAt: BOOKED_AT,
      lastPeriodKey: '2026-06-30',
    });
    expect(order(active, PAUSED_ID).data.lastPeriodKey).toBeNull();
    expect(order(active, NOT_DUE_ID).data.lastPeriodKey).toBeNull();
    expect(sync.mutationCount).toBe(2);

    const retry = await materializeDueStandingOrders(sync, store, market.market, {
      now: () => new Date(BOOKED_AT),
      timezone: 'Europe/Vienna',
    });
    expect(retry).toMatchObject({ ok: true, value: { booked: [], deferred: [] } });
    expect(sync.mutationCount).toBe(2);
    expect(sync.state.active!.document.entities.cashMovement).toHaveLength(4);
    expect(sync.state.active!.document.entities.transaction).toHaveLength(4);

    const resumed = structuredClone(sync.state.active!.document);
    const resumedOrder = order(resumed, PAUSED_ID);
    resumedOrder.rev += 1;
    resumedOrder.data.status = 'active';
    sync.setDocument(resumed);
    const afterResume = await materializeDueStandingOrders(sync, store, market.market, {
      now: () => new Date(BOOKED_AT),
      timezone: 'Europe/Vienna',
    });
    expect(afterResume).toMatchObject({
      ok: true,
      value: {
        booked: [{ orderId: PAUSED_ID, dueDate: '2026-07-27', kind: 'cash-deduct' }],
        deferred: [],
      },
    });
    expect(order(sync.state.active!.document, PAUSED_ID).data.lastPeriodKey).toBe('2026-07-27');
  });

  it.each(['watermark without rows', 'run without ledger'] as const)(
    'fails closed on an interrupted occurrence with a %s',
    async (partialState) => {
      const fixture = await decryptClientMoneyFixture();
      const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
      const document = withOrders(fixture.document, [
        standingOrder(DAILY_ADD_ID, {
          kind: 'cash-add',
          amount: '25',
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-07-20',
          ...(partialState === 'watermark without rows'
            ? { lastRunAt: BOOKED_AT, lastPeriodKey: '2026-07-27' }
            : {}),
        }),
      ]);
      if (partialState === 'run without ledger') {
        document.entities.standingOrderRun = [
          {
            id: occurrenceId,
            rev: 0,
            editedAt: BOOKED_AT,
            editedBy: DEVICE_ID,
            deletedAt: null,
            data: {
              standingOrderId: DAILY_ADD_ID,
              periodKey: '2026-07-27',
              bookedAt: BOOKED_AT,
            },
          },
        ];
      }
      const sync = createMutableTestSync(document, fixture.header);
      const market = createClientMoneyMarket();
      const engine = createVaultMoneyEngine(sync, market.market, {
        now: () => new Date(BOOKED_AT).getTime(),
      });

      const catchUp = await engine.onAppOpen();
      const portfolio = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
      const tax = await engine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);

      if (partialState === 'watermark without rows') {
        expect(catchUp).toMatchObject({
          ok: true,
          value: {
            booked: [],
            deferred: [],
            failed: [{ orderId: DAILY_ADD_ID, errorCode: 'VAULT_CORRUPT' }],
            skipped: [],
          },
        });
      }
      for (const outcome of [
        ...(partialState === 'watermark without rows' ? [] : [catchUp]),
        portfolio,
        tax,
      ]) {
        expect(outcome).toMatchObject({
          ok: false,
          error: { code: 'VAULT_CORRUPT', retryable: false },
        });
        expect(outcome).not.toHaveProperty('value');
      }
      expect(sync.mutationCount).toBe(0);
      expect(market.calls.quote).toEqual([]);
      if (partialState === 'run without ledger') expect(market.calls.history).toEqual([]);
      expect(market.calls.fx).toEqual([]);
    },
  );

  it.each(['booked with random ledger id', 'claim-only tombstone'] as const)(
    'preserves a legacy server occurrence that is %s',
    async (legacyState) => {
      const fixture = await decryptClientMoneyFixture();
      const booked = legacyState === 'booked with random ledger id';
      const document = withOrders(fixture.document, [
        standingOrder(DAILY_ADD_ID, {
          kind: 'cash-add',
          amount: '25',
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-07-20',
          ...(booked ? { lastRunAt: BOOKED_AT, lastPeriodKey: '2026-07-27' } : {}),
        }),
      ]);
      document.entities.standingOrderRun = [
        {
          id: LEGACY_RUN_ID,
          rev: 0,
          editedAt: BOOKED_AT,
          editedBy: DEVICE_ID,
          deletedAt: null,
          data: {
            standingOrderId: DAILY_ADD_ID,
            periodKey: '2026-07-27',
            bookedAt: BOOKED_AT,
          },
        },
      ];
      if (booked) {
        document.entities.cashMovement = [
          ...(document.entities.cashMovement ?? []),
          {
            id: LEGACY_LEDGER_ID,
            rev: 0,
            editedAt: BOOKED_AT,
            editedBy: DEVICE_ID,
            deletedAt: null,
            data: {
              portfolioId: CLIENT_MONEY_IDS.portfolio,
              sourceId: CLIENT_MONEY_IDS.cashSource,
              kind: 'deposit',
              amountEur: '25',
              transactionId: null,
              transferId: null,
              counterpartSourceId: null,
              dividendId: null,
              taxYear: null,
              executedAt: BOOKED_AT,
              note: null,
              source: 'standing-order',
              dedupHash: null,
              originalCurrency: null,
              createdAt: BOOKED_AT,
            },
          },
        ];
      }
      const sync = createMutableTestSync(document, fixture.header);
      const market = createClientMoneyMarket();

      const outcome = await materializeDueStandingOrders(
        sync,
        createVaultPortfolioStore(sync),
        market.market,
        {
          now: () => new Date(BOOKED_AT),
          timezone: 'Europe/Vienna',
        },
      );

      expect(outcome).toMatchObject({ ok: true, value: { booked: [], deferred: [] } });
      const deterministicId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
      expect(live(sync.state.active!.document, 'standingOrderRun', LEGACY_RUN_ID)).toBeDefined();
      expect(
        live(sync.state.active!.document, 'standingOrderRun', deterministicId),
      ).toBeUndefined();
      expect(live(sync.state.active!.document, 'cashMovement', deterministicId)).toBeUndefined();
      if (booked) {
        expect(live(sync.state.active!.document, 'cashMovement', LEGACY_LEDGER_ID)).toBeDefined();
      } else {
        expect(live(sync.state.active!.document, 'cashMovement', LEGACY_LEDGER_ID)).toBeUndefined();
      }
      expect(sync.mutationCount).toBe(0);
      expect(market.calls.quote).toEqual([]);
    },
  );

  it('converges two devices after their deterministic occurrences contend on the shared primary', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const encrypted = await encryptVaultDocument({
      document,
      vaultKey: fixture.vaultKey,
      header: {
        keyId: fixture.header.keyId,
        wrappedKeys: fixture.header.wrappedKeys,
        vaultVersion: fixture.header.vaultVersion,
        deviceId: fixture.header.deviceId,
        writeId: fixture.header.writeId,
        writtenAt: fixture.header.writtenAt,
      },
    });
    const firstLocal = createLocalDataHome({
      scope: 'standing-order-concurrent-first',
      storage: createMemoryLocalStorage(),
    });
    const secondLocal = createLocalDataHome({
      scope: 'standing-order-concurrent-second',
      storage: createMemoryLocalStorage(),
    });
    await Promise.all([
      firstLocal.write(encrypted.envelope, { ifVersion: null }),
      secondLocal.write(encrypted.envelope, { ifVersion: null }),
    ]);
    const primary = createContendedMemoryPrimary(encrypted.envelope);
    const firstSync = createVaultSyncEngine({
      local: firstLocal,
      primary: primary.home,
      vaultKey: fixture.vaultKey,
      deviceId: DEVICE_ID,
      writeId: writeIdSequence(0x100),
      now: () => BOOKED_AT,
      quarantine: createMemoryVaultQuarantineStore(() => BOOKED_AT),
      documentReconciler: reconcilePortfolioDocument,
      requiresCompleteMutationProvenance: true,
    });
    const secondSync = createVaultSyncEngine({
      local: secondLocal,
      primary: primary.home,
      vaultKey: fixture.vaultKey,
      deviceId: SECOND_DEVICE_ID,
      writeId: writeIdSequence(0x200),
      now: () => BOOKED_AT,
      quarantine: createMemoryVaultQuarantineStore(() => BOOKED_AT),
      documentReconciler: reconcilePortfolioDocument,
      requiresCompleteMutationProvenance: true,
    });
    await expect(Promise.all([firstSync.start(), secondSync.start()])).resolves.toEqual([
      expect.objectContaining({ status: 'synced' }),
      expect.objectContaining({ status: 'synced' }),
    ]);

    const market = createClientMoneyMarket();
    const options = {
      now: () => new Date(BOOKED_AT),
      timezone: 'Europe/Vienna',
    };

    const [first, second] = await Promise.all([
      materializeDueStandingOrders(
        firstSync,
        createVaultPortfolioStore(firstSync),
        market.market,
        options,
      ),
      materializeDueStandingOrders(
        secondSync,
        createVaultPortfolioStore(secondSync),
        market.market,
        options,
      ),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(primary.conflictCount).toBe(1);
    expect(primary.initialCandidateDeviceIds.sort()).toEqual([DEVICE_ID, SECOND_DEVICE_ID].sort());

    await firstSync.reconnect();
    await secondSync.reconnect();
    await firstSync.reconnect();
    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
    for (const sync of [firstSync, secondSync]) {
      const active = sync.state.active!.document;
      expect(
        active.entities.cashMovement?.filter(
          (entity) => entity.id === occurrenceId && entity.deletedAt === null,
        ),
      ).toHaveLength(1);
      expect(live(active, 'cashMovement', occurrenceId)?.data.source).toBe('standing-order');
      expect(
        active.entities.standingOrderRun?.filter(
          (entity) => entity.id === occurrenceId && entity.deletedAt === null,
        ),
      ).toHaveLength(1);
      expect(live(active, 'standingOrderRun', occurrenceId)?.data).toMatchObject({
        standingOrderId: DAILY_ADD_ID,
        periodKey: '2026-07-27',
      });
      expect(order(active, DAILY_ADD_ID).data.lastPeriodKey).toBe('2026-07-27');
    }
    expect(firstSync.state.active?.document).toEqual(secondSync.state.active?.document);
  });

  it('does not duplicate a durable occurrence when its first response is lost', async () => {
    const fixture = await decryptClientMoneyFixture();
    const market = createClientMoneyMarket();
    const options = {
      now: () => new Date(BOOKED_AT),
      timezone: 'Europe/Vienna',
    };
    const retryDocument = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const retrySync = createMutableTestSync(retryDocument, fixture.header);
    const durableStore = createVaultPortfolioStore(retrySync);
    let loseFirstResponse = true;
    const unreliableStore: VaultPortfolioStore = {
      ...durableStore,
      async materializeStandingOrderOccurrence(input, signal) {
        const committed = await durableStore.materializeStandingOrderOccurrence(input, signal);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error('response lost after durable commit');
        }
        return committed;
      },
    };
    const interrupted = await materializeDueStandingOrders(
      retrySync,
      unreliableStore,
      market.market,
      options,
    );
    expect(interrupted.ok).toBe(false);
    const afterRestart = await materializeDueStandingOrders(
      retrySync,
      durableStore,
      market.market,
      options,
    );
    expect(afterRestart).toMatchObject({
      ok: true,
      value: { booked: [], deferred: [] },
    });
    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
    expect(
      retrySync.state.active!.document.entities.cashMovement?.filter(
        (entity) => entity.id === occurrenceId,
      ),
    ).toHaveLength(1);
  });

  it('keeps quote and insufficient-cash deferrals distinguishable', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
      standingOrder(DEDUCT_ID, {
        kind: 'cash-deduct',
        amount: '5000',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const market = createClientMoneyMarket();
    market.setMissingQuote(CLIENT_MONEY_IDS.eurAsset, true);

    const outcome = await materializeDueStandingOrders(
      sync,
      createVaultPortfolioStore(sync),
      market.market,
      {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      },
    );

    expect(outcome).toMatchObject({
      ok: true,
      value: {
        booked: [],
        deferred: [
          { orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason: 'quote-unavailable' },
          { orderId: DEDUCT_ID, dueDate: '2026-07-27', reason: 'insufficient-cash' },
        ],
        failed: [],
        skipped: [],
      },
    });
    expect(sync.state.active!.document.entities.standingOrderRun).toBeUndefined();
    expect(order(sync.state.active!.document, MONTHLY_BUY_ID).data.lastPeriodKey).toBeNull();
    expect(order(sync.state.active!.document, DEDUCT_ID).data.lastPeriodKey).toBeNull();
    expect(sync.mutationCount).toBe(0);

    const insufficientDocument = withOrders(fixture.document, [
      standingOrder(DEDUCT_ID, {
        kind: 'cash-deduct',
        amount: '5000',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const insufficientSync = createMutableTestSync(insufficientDocument, fixture.header);
    await expect(
      materializeDueStandingOrders(
        insufficientSync,
        createVaultPortfolioStore(insufficientSync),
        createClientMoneyMarket().market,
        {
          now: () => new Date(BOOKED_AT),
          timezone: 'Europe/Vienna',
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [],
        deferred: [{ orderId: DEDUCT_ID, dueDate: '2026-07-27', reason: 'insufficient-cash' }],
      },
    });
    expect(order(insufficientSync.state.active!.document, DEDUCT_ID).data.lastPeriodKey).toBeNull();

    const invalidSync = createMutableTestSync(document, fixture.header);
    const invalidMarket = createClientMoneyMarket();
    invalidMarket.market.quote = async () => ({
      value: {
        price: 0,
        currency: 'EUR',
        asOf: BOOKED_AT,
      },
      stale: false,
      asOf: BOOKED_AT,
      watermark: 'invalid',
    });
    await expect(
      materializeDueStandingOrders(
        invalidSync,
        createVaultPortfolioStore(invalidSync),
        invalidMarket.market,
        {
          now: () => new Date(BOOKED_AT),
          timezone: 'Europe/Vienna',
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        deferred: [
          { orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason: 'quote-unavailable' },
          { orderId: DEDUCT_ID, dueDate: '2026-07-27', reason: 'insufficient-cash' },
        ],
      },
    });
    expect(invalidSync.mutationCount).toBe(0);

    const wrongCurrencyDocument = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        currency: 'USD',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const wrongCurrencySync = createMutableTestSync(wrongCurrencyDocument, fixture.header);
    await expect(
      materializeDueStandingOrders(
        wrongCurrencySync,
        createVaultPortfolioStore(wrongCurrencySync),
        market.market,
        {
          now: () => new Date(BOOKED_AT),
          timezone: 'Europe/Vienna',
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        failed: [{ orderId: DAILY_ADD_ID, dueDate: '2026-07-27', errorCode: 'VAULT_CORRUPT' }],
      },
    });
    expect(wrongCurrencySync.mutationCount).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(
      materializeDueStandingOrders(sync, createVaultPortfolioStore(sync), market.market, {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });
  });

  it.each(['over-age', 'stale', 'provider-unavailable'] as const)(
    'isolates a %s quote failure between two bookable orders',
    async (failureKind) => {
      const fixture = await decryptClientMoneyFixture();
      const document = withOrders(fixture.document, [
        standingOrder(DAILY_ADD_ID, {
          kind: 'cash-add',
          amount: '25',
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-07-20',
        }),
        standingOrder(MONTHLY_BUY_ID, {
          kind: 'buy-asset',
          assetId: CLIENT_MONEY_IDS.eurAsset,
          amount: '1',
          currency: 'EUR',
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-07-20',
        }),
        standingOrder(PAUSED_ID, {
          kind: 'cash-add',
          amount: '10',
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-07-20',
        }),
      ]);
      const sync = createMutableTestSync(document, fixture.header);
      const base = createClientMoneyMarket();
      const market: MarketDataSource = {
        ...base.market,
        async quote(assetId, signal) {
          if (failureKind === 'provider-unavailable') {
            throw new MarketDataSourceError('MARKET_DATA_UNAVAILABLE', 'Injected provider outage.');
          }
          const result = await base.market.quote(assetId, signal);
          if (failureKind === 'stale') return { ...result, stale: true };
          const asOf = new Date(
            Date.parse(BOOKED_AT) - STANDING_ORDER_MAX_QUOTE_AGE_MS - 1,
          ).toISOString();
          return { ...result, asOf, value: { ...result.value, asOf } };
        },
      };

      const outcome = await materializeDueStandingOrders(
        sync,
        createVaultPortfolioStore(sync),
        market,
        {
          now: () => new Date(BOOKED_AT),
          timezone: 'Europe/Vienna',
        },
      );

      expect(outcome).toMatchObject({
        ok: true,
        value: {
          booked: [{ orderId: DAILY_ADD_ID }, { orderId: PAUSED_ID }],
          deferred: [
            { orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason: 'quote-unavailable' },
          ],
          failed: [],
          skipped: [],
        },
      });
      expect(sync.mutationCount).toBe(2);
    },
  );

  it.each(['missing', 'stale'] as const)(
    'defers a %s quote and books exactly once at the next unlock boundary',
    async (failureKind) => {
      const fixture = await decryptClientMoneyFixture();
      const document = withOrders(fixture.document, [
        standingOrder(MONTHLY_BUY_ID, {
          kind: 'buy-asset',
          assetId: CLIENT_MONEY_IDS.eurAsset,
          amount: '1',
          currency: 'EUR',
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-07-20',
        }),
      ]);
      const sync = createMutableTestSync(document, fixture.header);
      const market = createClientMoneyMarket();
      if (failureKind === 'missing') {
        market.setMissingQuote(CLIENT_MONEY_IDS.eurAsset, true);
      } else {
        market.setStale(true);
      }
      const lifecycle = createStandingOrderMaterializationLifecycle(sync, market.market, {
        retryCount: 0,
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      });
      const engine = createVaultMoneyEngine(sync, market.market, {
        now: () => new Date(BOOKED_AT).getTime(),
        standingOrders: lifecycle,
      });
      const occurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-27');

      await expect(engine.onAppOpen()).resolves.toMatchObject({
        ok: true,
        value: {
          deferred: [
            { orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason: 'quote-unavailable' },
          ],
          failed: [],
        },
      });
      expect(live(sync.state.active!.document, 'transaction', occurrenceId)).toBeUndefined();
      expect(live(sync.state.active!.document, 'standingOrderRun', occurrenceId)).toBeUndefined();
      expect(sync.mutationCount).toBe(0);
      await expect(
        engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX'),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'MARKET_DATA_UNAVAILABLE', retryable: true },
      });

      if (failureKind === 'missing') {
        market.setMissingQuote(CLIENT_MONEY_IDS.eurAsset, false);
      } else {
        market.setStale(false);
      }
      await expect(
        engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX'),
      ).resolves.toMatchObject({
        ok: true,
      });
      await expect(engine.afterUnlock()).resolves.toMatchObject({
        ok: true,
        value: {
          booked: [
            {
              occurrenceId,
              orderId: MONTHLY_BUY_ID,
              dueDate: '2026-07-27',
              status: 'created',
            },
          ],
        },
      });
      await expect(
        engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX'),
      ).resolves.toMatchObject({
        ok: true,
      });

      expect(
        sync.state.active?.document.entities.transaction?.filter(
          (entity) => entity.id === occurrenceId && entity.deletedAt === null,
        ),
      ).toHaveLength(1);
      expect(
        sync.state.active?.document.entities.standingOrderRun?.filter(
          (entity) => entity.id === occurrenceId && entity.deletedAt === null,
        ),
      ).toHaveLength(1);
      expect(sync.mutationCount).toBe(1);
    },
  );

  it('defers an over-age provider quote and records a fresh market stamp without redating the buy', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const base = createClientMoneyMarket();
    let providerAsOf = '2026-07-21T22:30:00.000Z';
    const market: MarketDataSource = {
      ...base.market,
      async quote(assetId, signal) {
        const result = await base.market.quote(assetId, signal);
        return {
          ...result,
          asOf: providerAsOf,
          value: { ...result.value, asOf: providerAsOf },
        };
      },
    };
    const store = createVaultPortfolioStore(sync);
    const occurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-27');

    await expect(
      materializeDueStandingOrders(sync, store, market, {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [],
        deferred: [{ orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason: 'quote-unavailable' }],
        failed: [],
        skipped: [],
      },
    });
    expect(live(sync.state.active!.document, 'transaction', occurrenceId)).toBeUndefined();
    expect(live(sync.state.active!.document, 'standingOrderRun', occurrenceId)).toBeUndefined();
    expect(order(sync.state.active!.document, MONTHLY_BUY_ID).data).toMatchObject({
      lastRunAt: null,
      lastPeriodKey: null,
    });
    expect(sync.mutationCount).toBe(0);

    providerAsOf = '2026-07-26T20:00:00.000Z';
    await expect(
      materializeDueStandingOrders(sync, store, market, {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [{ orderId: MONTHLY_BUY_ID, occurrenceId, status: 'created' }],
        deferred: [],
      },
    });
    expect(live(sync.state.active!.document, 'transaction', occurrenceId)?.data).toMatchObject({
      executedAt: BOOKED_AT,
      source: 'standing-order',
    });
    expect(live(sync.state.active!.document, 'standingOrderRun', occurrenceId)?.data).toMatchObject(
      {
        bookedAt: BOOKED_AT,
      },
    );
    expect(order(sync.state.active!.document, MONTHLY_BUY_ID).data).toMatchObject({
      lastRunAt: providerAsOf,
      lastPeriodKey: '2026-07-27',
    });
    expect(sync.mutationCount).toBe(1);
  });

  it('books a provider quote exactly at the automatic-buy age ceiling', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const base = createClientMoneyMarket();
    const providerAsOf = new Date(
      Date.parse(BOOKED_AT) - STANDING_ORDER_MAX_QUOTE_AGE_MS,
    ).toISOString();
    const market: MarketDataSource = {
      ...base.market,
      async quote(assetId, signal) {
        const result = await base.market.quote(assetId, signal);
        return {
          ...result,
          asOf: providerAsOf,
          value: { ...result.value, asOf: providerAsOf },
        };
      },
    };
    const occurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-27');

    await expect(
      materializeDueStandingOrders(sync, createVaultPortfolioStore(sync), market, {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [{ orderId: MONTHLY_BUY_ID, occurrenceId, status: 'created' }],
        deferred: [],
      },
    });
    expect(order(sync.state.active!.document, MONTHLY_BUY_ID).data).toMatchObject({
      lastRunAt: providerAsOf,
      lastPeriodKey: '2026-07-27',
    });
    expect(sync.mutationCount).toBe(1);
  });

  it('skips an order paused in the freshest local document before commit', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync, { now: () => BOOKED_AT });
    const base = createClientMoneyMarket();
    let pausedOrder: VaultEntity | null = null;
    const market: MarketDataSource = {
      ...base.market,
      async quote(assetId, signal) {
        const result = await base.market.quote(assetId, signal);
        await store.pauseStandingOrder(MONTHLY_BUY_ID);
        pausedOrder = structuredClone(order(sync.state.active!.document, MONTHLY_BUY_ID));
        return result;
      },
    };
    const occurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-27');

    await expect(
      materializeDueStandingOrders(sync, store, market, {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [],
        deferred: [],
        failed: [],
        skipped: [{ orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason: 'status-changed' }],
      },
    });
    expect(live(sync.state.active!.document, 'transaction', occurrenceId)).toBeUndefined();
    expect(live(sync.state.active!.document, 'cashMovement', occurrenceId)).toBeUndefined();
    expect(live(sync.state.active!.document, 'standingOrderRun', occurrenceId)).toBeUndefined();
    expect(order(sync.state.active!.document, MONTHLY_BUY_ID)).toEqual(pausedOrder);
    expect(order(sync.state.active!.document, MONTHLY_BUY_ID).data).toMatchObject({
      status: 'paused',
      lastRunAt: null,
      lastPeriodKey: null,
    });
    expect(sync.mutationCount).toBe(1);
  });

  it.each(['malformed-row', 'missing-asset'] as const)(
    'isolates %s corruption and books a later order',
    async (failureKind) => {
      const fixture = await decryptClientMoneyFixture();
      const badOrder = standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: failureKind === 'missing-asset' ? MISSING_ASSET_ID : CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      });
      if (failureKind === 'malformed-row') badOrder.data.amount = 1;
      const document = withOrders(fixture.document, [
        badOrder,
        standingOrder(DAILY_ADD_ID, {
          kind: 'cash-add',
          amount: '25',
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-07-20',
        }),
      ]);
      const sync = createMutableTestSync(document, fixture.header);

      const outcome = await materializeDueStandingOrders(
        sync,
        createVaultPortfolioStore(sync),
        createClientMoneyMarket().market,
        {
          now: () => new Date(BOOKED_AT),
          timezone: 'Europe/Vienna',
        },
      );

      expect(outcome).toMatchObject({
        ok: true,
        value: {
          booked: [{ orderId: DAILY_ADD_ID, dueDate: '2026-07-27', status: 'created' }],
          deferred: [],
          failed: [
            {
              orderId: MONTHLY_BUY_ID,
              dueDate: failureKind === 'malformed-row' ? null : '2026-07-27',
              errorCode: 'VAULT_CORRUPT',
            },
          ],
          skipped: [],
        },
      });
      expect(sync.mutationCount).toBe(1);
    },
  );

  it('keeps document validation and locked-vault failures at run scope', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    document.entities.portfolio![0]!.data.name = 42;
    const corruptSync = createMutableTestSync(document, fixture.header);
    await expect(
      materializeDueStandingOrders(
        corruptSync,
        createVaultPortfolioStore(corruptSync),
        createClientMoneyMarket().market,
        { now: () => new Date(BOOKED_AT), timezone: 'Europe/Vienna' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'VAULT_CORRUPT', retryable: false },
    });

    const lockedSync = createMutableTestSync(fixture.document, fixture.header);
    lockedSync.setLocked();
    await expect(
      materializeDueStandingOrders(
        lockedSync,
        createVaultPortfolioStore(lockedSync),
        createClientMoneyMarket().market,
        { now: () => new Date(BOOKED_AT), timezone: 'Europe/Vienna' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'VAULT_LOCKED', retryable: true },
    });
  });

  it.each([
    ['deleted', 'deleted'],
    ['rescheduled', 'no-longer-due'],
  ] as const)('records a commit-time %s skip', async (change, reason) => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync, { now: () => BOOKED_AT });
    const base = createClientMoneyMarket();
    const market: MarketDataSource = {
      ...base.market,
      async quote(assetId, signal) {
        const result = await base.market.quote(assetId, signal);
        if (change === 'deleted') {
          await store.deleteStandingOrder(MONTHLY_BUY_ID);
        } else {
          await store.updateStandingOrder(MONTHLY_BUY_ID, { endDate: '2026-07-26' });
        }
        return result;
      },
    };

    await expect(
      materializeDueStandingOrders(sync, store, market, {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [],
        deferred: [],
        failed: [],
        skipped: [{ orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason }],
      },
    });
    expect(sync.mutationCount).toBe(1);
  });

  it('commits against a fresh candidate after an unrelated local write during quote acquisition', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync, { now: () => BOOKED_AT });
    const base = createClientMoneyMarket();
    const market: MarketDataSource = {
      ...base.market,
      async quote(assetId, signal) {
        const result = await base.market.quote(assetId, signal);
        await store.depositCash(CLIENT_MONEY_IDS.portfolio, {
          amountEur: 1,
          sourceId: CLIENT_MONEY_IDS.cashSource,
        });
        return result;
      },
    };
    const occurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-27');

    await expect(
      materializeDueStandingOrders(sync, store, market, {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [{ orderId: MONTHLY_BUY_ID, occurrenceId, status: 'created' }],
        deferred: [],
        failed: [],
        skipped: [],
      },
    });
    expect(sync.mutationCount).toBe(2);
    expect(live(sync.state.active!.document, 'transaction', occurrenceId)).toBeDefined();
  });

  it.each([
    [
      'active buy without an asset',
      {
        kind: 'buy-asset',
        assetId: null,
        status: 'active',
      },
    ],
    [
      'paused buy without an asset',
      {
        kind: 'buy-asset',
        assetId: null,
        status: 'paused',
      },
    ],
    [
      'cash order carrying an asset',
      {
        kind: 'cash-add',
        assetId: CLIENT_MONEY_IDS.eurAsset,
      },
    ],
    [
      'daily cadence carrying an anchor',
      {
        cadence: 'daily',
        anchorDay: 1,
      },
    ],
    [
      'monthly cadence without an anchor',
      {
        cadence: 'monthly',
        anchorDay: null,
      },
    ],
    [
      'non-positive amount',
      {
        amount: '0',
      },
    ],
    [
      'cash order using a non-EUR currency',
      {
        currency: 'USD',
      },
    ],
    [
      'buy order whose currency differs from its asset',
      {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        currency: 'USD',
      },
    ],
    [
      'impossible calendar start date',
      {
        startDate: '2026-02-30',
      },
    ],
    [
      'end date before its start date',
      {
        startDate: '2026-07-20',
        endDate: '2026-07-19',
      },
    ],
    [
      'incomplete run watermark',
      {
        lastRunAt: BOOKED_AT,
        lastPeriodKey: null,
      },
    ],
  ] as const)(
    'isolates an invalid %s definition during catch-up while strict derivations stay closed',
    async (label, overrides) => {
      const fixture = await decryptClientMoneyFixture();
      const document = withOrders(fixture.document, [standingOrder(DAILY_ADD_ID, overrides)]);
      const sync = createMutableTestSync(document, fixture.header);
      const market = createClientMoneyMarket();
      const engine = createVaultMoneyEngine(sync, market.market, {
        now: () => new Date(BOOKED_AT).getTime(),
      });

      const catchUp = await engine.onAppOpen();
      const portfolio = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
      const tax = await engine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);

      expect(catchUp).toMatchObject({
        ok: true,
        value: {
          booked: [],
          deferred: [],
          failed:
            label === 'paused buy without an asset'
              ? []
              : [{ orderId: DAILY_ADD_ID, errorCode: 'VAULT_CORRUPT' }],
          skipped: [],
        },
      });
      for (const outcome of [portfolio, tax]) {
        expect(outcome).toMatchObject({
          ok: false,
          error: { code: 'VAULT_CORRUPT', retryable: false },
        });
        expect(outcome).not.toHaveProperty('value');
      }
      expect(sync.mutationCount).toBe(0);
      expect(market.calls.quote).toEqual([]);
      expect(market.calls.history).toEqual([]);
      expect(market.calls.fx).toEqual([]);
    },
  );

  it('fails a due manual buy when no local valuation exists', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const asset = document.entities.customAsset!.find(
      (entity) => entity.id === CLIENT_MONEY_IDS.eurAsset,
    )!;
    asset.data.providerId = 'manual';
    asset.data.providerRef = asset.id;
    asset.data.ownerId = CLIENT_MONEY_IDS.user;
    asset.data.type = 'custom';
    document.entities.customAssetValue = [];
    const sync = createMutableTestSync(document, fixture.header);
    const market = createClientMoneyMarket();

    await expect(
      materializeDueStandingOrders(sync, createVaultPortfolioStore(sync), market.market, {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [],
        deferred: [{ orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason: 'quote-unavailable' }],
        failed: [],
        skipped: [],
      },
    });
    expect(sync.mutationCount).toBe(0);
    expect(market.calls.quote).toEqual([]);
  });

  it('prices a vault-only manual asset locally instead of deferring to the server', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const asset = document.entities.customAsset!.find(
      (entity) => entity.id === CLIENT_MONEY_IDS.eurAsset,
    )!;
    asset.data.providerId = 'manual';
    asset.data.providerRef = asset.id;
    asset.data.ownerId = CLIENT_MONEY_IDS.user;
    asset.data.type = 'custom';
    asset.data.meta = { smoothing: true };
    document.entities.customAssetValue = [
      manualValue('018f0000-0000-7000-8000-000000000206', asset.id, '2026-07-20', '100'),
      manualValue('018f0000-0000-7000-8000-000000000207', asset.id, '2026-07-26', '175'),
    ];
    const sync = createMutableTestSync(document, fixture.header);
    const market = createClientMoneyMarket();

    const outcome = await materializeDueStandingOrders(
      sync,
      createVaultPortfolioStore(sync),
      market.market,
      {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      },
    );

    expect(outcome).toMatchObject({
      ok: true,
      value: {
        booked: [{ orderId: MONTHLY_BUY_ID, kind: 'buy-asset' }],
        deferred: [],
      },
    });
    const occurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-27');
    expect(live(sync.state.active!.document, 'transaction', occurrenceId)?.data).toMatchObject({
      assetId: CLIENT_MONEY_IDS.eurAsset,
      price: '175',
      source: 'standing-order',
      executedAt: BOOKED_AT,
    });
    expect(order(sync.state.active!.document, MONTHLY_BUY_ID).data).toMatchObject({
      lastRunAt: BOOKED_AT,
      lastPeriodKey: '2026-07-27',
    });
    expect(market.calls.quote).not.toContain(CLIENT_MONEY_IDS.eurAsset);
  });

  it('runs catch-up at the public money-engine app-open boundary', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const engine = createVaultMoneyEngine(sync, createClientMoneyMarket().market, {
      now: () => new Date(BOOKED_AT).getTime(),
    });

    await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');

    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
    expect(live(sync.state.active!.document, 'cashMovement', occurrenceId)?.data).toMatchObject({
      kind: 'deposit',
      amountEur: '25',
      source: 'standing-order',
    });
  });

  it('coalesces lifecycle work, retries transient failures, and waits for unlock after a lock', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header);
    const market = createClientMoneyMarket();
    const success = {
      ok: true as const,
      value: { today: '2026-07-27', booked: [], deferred: [], failed: [], skipped: [] },
    };
    let retryCalls = 0;
    const retrying = createStandingOrderMaterializationLifecycle(sync, market.market, {
      retryCount: 1,
      async materialize() {
        retryCalls += 1;
        return retryCalls === 1
          ? {
              ok: false as const,
              error: {
                code: 'OPERATION_ABORTED' as const,
                message: 'retry',
                retryable: true,
              },
            }
          : success;
      },
    });

    const [opened, unlocked] = await Promise.all([retrying.onAppOpen(), retrying.afterUnlock()]);
    expect(opened).toEqual(success);
    expect(unlocked).toEqual(success);
    expect(retryCalls).toBe(2);

    let isolatedCalls = 0;
    const isolated = createStandingOrderMaterializationLifecycle(sync, market.market, {
      retryCount: 3,
      async materialize() {
        isolatedCalls += 1;
        return {
          ok: true as const,
          value: {
            today: '2026-07-27',
            booked: [],
            deferred: [
              {
                orderId: MONTHLY_BUY_ID,
                dueDate: '2026-07-27',
                reason: 'quote-unavailable' as const,
              },
            ],
            failed: [
              {
                orderId: DAILY_ADD_ID,
                dueDate: null,
                errorCode: 'VAULT_CORRUPT' as const,
              },
            ],
            skipped: [],
          },
        };
      },
    });
    await expect(isolated.onAppOpen()).resolves.toMatchObject({ ok: true });
    expect(isolatedCalls).toBe(1);

    let lockCalls = 0;
    const locked = createStandingOrderMaterializationLifecycle(sync, market.market, {
      retryCount: 3,
      async materialize() {
        lockCalls += 1;
        return lockCalls === 1
          ? {
              ok: false as const,
              error: {
                code: 'VAULT_LOCKED' as const,
                message: 'locked',
                retryable: true,
              },
            }
          : success;
      },
    });
    await expect(locked.onAppOpen()).resolves.toMatchObject({
      ok: false,
      error: { code: 'VAULT_LOCKED' },
    });
    expect(lockCalls).toBe(1);
    await expect(locked.afterUnlock()).resolves.toEqual(success);
    expect(lockCalls).toBe(2);
  });

  it('keeps a public locked catch-up dormant until the explicit unlock boundary', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header);
    const market = createClientMoneyMarket();
    const locked = {
      ok: false as const,
      error: {
        code: 'VAULT_LOCKED' as const,
        message: 'locked',
        retryable: true,
      },
    };
    const success = {
      ok: true as const,
      value: { today: '2026-07-27', booked: [], deferred: [], failed: [], skipped: [] },
    };
    let appOpenCalls = 0;
    let unlockCalls = 0;
    const engine = createVaultMoneyEngine(sync, market.market, {
      now: () => new Date(BOOKED_AT).getTime(),
      standingOrders: {
        async onAppOpen() {
          appOpenCalls += 1;
          return appOpenCalls === 1 ? locked : success;
        },
        async afterUnlock() {
          unlockCalls += 1;
          return success;
        },
      },
    });

    await expect(engine.onAppOpen()).resolves.toEqual(locked);
    await expect(engine.onAppOpen()).resolves.toEqual(locked);
    await expect(engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX')).resolves.toEqual({
      ok: false,
      error: locked.error,
    });
    expect(appOpenCalls).toBe(1);
    expect(unlockCalls).toBe(0);
    expect(market.calls.quote).toEqual([]);
    expect(market.calls.history).toEqual([]);

    await expect(engine.afterUnlock()).resolves.toEqual(success);
    await expect(engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX')).resolves.toMatchObject({
      ok: true,
    });
    expect(appOpenCalls).toBe(1);
    expect(unlockCalls).toBe(1);
  });

  it('re-arms a failed public catch-up and recovers exactly once without another unlock', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const encrypted = await encryptVaultDocument({
      document,
      vaultKey: fixture.vaultKey,
      header: {
        keyId: fixture.header.keyId,
        wrappedKeys: fixture.header.wrappedKeys,
        vaultVersion: fixture.header.vaultVersion,
        deviceId: fixture.header.deviceId,
        writeId: fixture.header.writeId,
        writtenAt: fixture.header.writtenAt,
      },
    });
    const failingLocal = createFailingCommitStorage();
    const local = createLocalDataHome({
      scope: 'standing-order-first-commit-failure',
      storage: failingLocal.storage,
    });
    await expect(local.write(encrypted.envelope, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
    });
    const primary = createMemoryPrimary(encrypted.envelope);
    let writeSequence = 0x300;
    const sync = createVaultSyncEngine({
      local,
      primary: primary.home,
      vaultKey: fixture.vaultKey,
      deviceId: DEVICE_ID,
      writeId: () => `018f0000-0000-7000-8000-${(writeSequence++).toString(16).padStart(12, '0')}`,
      now: () => BOOKED_AT,
      quarantine: createMemoryVaultQuarantineStore(() => BOOKED_AT),
      documentReconciler: reconcilePortfolioDocument,
      requiresCompleteMutationProvenance: true,
    });
    await expect(sync.start()).resolves.toMatchObject({ status: 'synced' });
    failingLocal.failNextCommit();

    const market = createClientMoneyMarket();
    const lifecycle = createStandingOrderMaterializationLifecycle(sync, market.market, {
      retryCount: 0,
      now: () => new Date(BOOKED_AT),
      timezone: 'Europe/Vienna',
    });
    const engine = createVaultMoneyEngine(sync, market.market, {
      now: () => new Date(BOOKED_AT).getTime(),
      standingOrders: lifecycle,
    });

    await expect(engine.onAppOpen()).resolves.toMatchObject({
      ok: false,
      error: { code: 'VAULT_DATA_UNAVAILABLE', retryable: true },
    });
    expect(failingLocal.failureCount).toBe(1);
    expect(failingLocal.currentVersion).toBe(fixture.header.vaultVersion);
    expect(primary.writeCount).toBe(0);
    expect(market.calls.quote).toEqual([]);
    expect(market.calls.history).toEqual([]);

    await expect(engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX')).resolves.toMatchObject({
      ok: true,
    });
    await expect(engine.onAppOpen()).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [
          {
            orderId: DAILY_ADD_ID,
            dueDate: '2026-07-27',
            kind: 'cash-add',
            status: 'created',
          },
        ],
      },
    });
    await expect(engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX')).resolves.toMatchObject({
      ok: true,
    });

    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
    expect(
      sync.state.active?.document.entities.cashMovement?.filter(
        (entity) => entity.id === occurrenceId && entity.deletedAt === null,
      ),
    ).toHaveLength(1);
    expect(
      sync.state.active?.document.entities.standingOrderRun?.filter(
        (entity) => entity.id === occurrenceId && entity.deletedAt === null,
      ),
    ).toHaveLength(1);
    expect(failingLocal.failureCount).toBe(1);
    expect(failingLocal.currentVersion).toBe(fixture.header.vaultVersion + 1);
    expect(primary.version).toBe(fixture.header.vaultVersion + 1);
    expect(primary.writeCount).toBe(1);
  });

  it.each(['conflict', 'unresolved'] as const)(
    'performs no standing-order write while sync is %s',
    async (status) => {
      const fixture = await decryptClientMoneyFixture();
      const document = withOrders(fixture.document, [
        standingOrder(DAILY_ADD_ID, {
          kind: 'cash-add',
          amount: '25',
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-07-20',
        }),
      ]);
      const sync = createMutableTestSync(document, fixture.header);
      sync.setStatus(status);

      await expect(
        materializeDueStandingOrders(
          sync,
          createVaultPortfolioStore(sync),
          createClientMoneyMarket().market,
          {
            now: () => new Date(BOOKED_AT),
            timezone: 'Europe/Vienna',
          },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'VAULT_DATA_UNAVAILABLE', retryable: true },
      });
      expect(sync.mutationCount).toBe(0);
    },
  );

  it('rejects a standing-order mutation queued behind reconnect-to-conflict', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const encrypted = await encryptVaultDocument({
      document,
      vaultKey: fixture.vaultKey,
      header: {
        keyId: fixture.header.keyId,
        wrappedKeys: fixture.header.wrappedKeys,
        vaultVersion: fixture.header.vaultVersion,
        deviceId: fixture.header.deviceId,
        writeId: fixture.header.writeId,
        writtenAt: fixture.header.writtenAt,
      },
    });
    const racingLocal = createReconnectConflictStorage();
    const local = createLocalDataHome({
      scope: 'standing-order-reconnect-conflict',
      storage: racingLocal.storage,
    });
    await expect(local.write(encrypted.envelope, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
    });
    const primary = createMemoryPrimary(encrypted.envelope);
    let writeSequence = 0x400;
    const sync = createVaultSyncEngine({
      local,
      primary: primary.home,
      vaultKey: fixture.vaultKey,
      deviceId: DEVICE_ID,
      writeId: () => `018f0000-0000-7000-8000-${(writeSequence++).toString(16).padStart(12, '0')}`,
      now: () => BOOKED_AT,
      quarantine: createMemoryVaultQuarantineStore(() => BOOKED_AT),
      documentReconciler: reconcilePortfolioDocument,
      requiresCompleteMutationProvenance: true,
    });
    await expect(sync.start()).resolves.toMatchObject({ status: 'synced' });

    const mutationQueued = deferred<void>();
    let mutationCallbackCalls = 0;
    const observedSync: VaultSyncEngine = {
      get deviceId() {
        return sync.deviceId;
      },
      get state() {
        return sync.state;
      },
      start: () => sync.start(),
      reconnect: () => sync.reconnect(),
      mutate(mutator) {
        mutationQueued.resolve();
        return sync.mutate((context) => {
          mutationCallbackCalls += 1;
          return mutator(context);
        });
      },
    };
    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');

    racingLocal.armReconnectConflict();
    const reconnecting = sync.reconnect();
    await racingLocal.readStarted;
    const materializing = createVaultPortfolioStore(
      observedSync,
    ).materializeStandingOrderOccurrence({
      occurrenceId,
      orderId: DAILY_ADD_ID,
      dueDate: '2026-07-27',
      calendarDay: '2026-07-27',
      timezone: 'Europe/Vienna',
      executedAt: BOOKED_AT,
      recordedAt: BOOKED_AT,
      expectedCandidate: candidateIdentity(fixture.header),
    });
    const materialized = materializing.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await mutationQueued.promise;
    expect(sync.state.status).toBe('synced');

    racingLocal.releaseRead();
    await expect(reconnecting).resolves.toMatchObject({ status: 'conflict' });
    const outcome = await materialized;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({
      name: 'VaultCryptoError',
      code: 'storage-failed',
    });
    expect(mutationCallbackCalls).toBe(0);
    expect(racingLocal.currentVersion).toBe(fixture.header.vaultVersion);
    expect(primary.version).toBe(fixture.header.vaultVersion);
    expect(primary.writeCount).toBe(0);
    expect(live(sync.state.active!.document, 'cashMovement', occurrenceId)).toBeUndefined();
    expect(live(sync.state.active!.document, 'standingOrderRun', occurrenceId)).toBeUndefined();
  });

  it('aborts when the candidate write id changes inside the serialized write boundary', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const mutable = createMutableTestSync(document, fixture.header);
    const racingSync: VaultSyncEngine = {
      get deviceId() {
        return mutable.deviceId;
      },
      get state() {
        return mutable.state;
      },
      start: () => mutable.start(),
      reconnect: () => mutable.reconnect(),
      mutate(mutator) {
        const active = mutable.state.active;
        if (active === null) throw new Error('Expected an active test candidate.');
        mutable.setDocument(structuredClone(active.document), false, REPLACEMENT_WRITE_ID);
        return mutable.mutate(mutator);
      },
    };
    const market = createClientMoneyMarket();
    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');

    const outcome = await materializeDueStandingOrders(
      racingSync,
      createVaultPortfolioStore(racingSync),
      market.market,
      {
        now: () => new Date(BOOKED_AT),
        timezone: 'Europe/Vienna',
      },
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED', retryable: true },
    });
    expect(mutable.state.active?.header.vaultVersion).toBe(fixture.header.vaultVersion);
    expect(mutable.state.active?.header.writeId).toBe(REPLACEMENT_WRITE_ID);
    expect(mutable.mutationCount).toBe(0);
    expect(live(mutable.state.active!.document, 'cashMovement', occurrenceId)).toBeUndefined();
    expect(live(mutable.state.active!.document, 'standingOrderRun', occurrenceId)).toBeUndefined();
  });

  it('keeps calendar math deterministic across month ends and timezone boundaries', () => {
    expect(
      dueStandingOrderOccurrence(
        {
          cadence: 'monthly',
          anchorDay: 31,
          startDate: '2024-01-01',
          endDate: null,
        },
        '2024-03-01',
      ),
    ).toBe('2024-02-29');
    expect(
      dueStandingOrderOccurrence(
        {
          cadence: 'daily',
          anchorDay: null,
          startDate: '2026-01-01',
          endDate: null,
        },
        '2026-07-27',
      ),
    ).toBe('2026-07-27');
    expect(
      dueStandingOrderOccurrence(
        {
          cadence: 'monthly',
          anchorDay: 31,
          startDate: '2026-01-01',
          endDate: '2026-01-31',
        },
        '2026-07-27',
      ),
    ).toBe('2026-01-31');
    expect(calendarDayInTimezone(new Date(BOOKED_AT), 'Europe/Vienna')).toBe('2026-07-27');
    expect(calendarDayInTimezone(new Date(BOOKED_AT), 'America/New_York')).toBe('2026-07-26');
  });

  it('refuses invalid scan stamps at the direct standing-order store boundary', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const localAsset = document.entities.customAsset!.find(
      (entity) => entity.id === CLIENT_MONEY_IDS.eurAsset,
    )!;
    localAsset.data.providerId = 'manual';
    localAsset.data.providerRef = localAsset.id;
    localAsset.data.ownerId = CLIENT_MONEY_IDS.user;
    localAsset.data.type = 'custom';
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync);
    const expectedCandidate = candidateIdentity(fixture.header);
    const cashOccurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
    const buyOccurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-27');

    await expect(
      store.materializeStandingOrderOccurrence({
        occurrenceId: cashOccurrenceId,
        orderId: DAILY_ADD_ID,
        dueDate: '2026-07-27',
        calendarDay: '2026-07-27',
        timezone: 'Europe/Vienna',
        executedAt: BOOKED_AT,
        recordedAt: '2026-07-26T22:30:00.001Z',
        expectedCandidate,
      }),
    ).rejects.toMatchObject({
      code: 'VAULT_DATA_INVALID',
      message: 'The standing-order occurrence identity is invalid.',
    });
    await expect(
      store.materializeStandingOrderOccurrence({
        occurrenceId: cashOccurrenceId,
        orderId: DAILY_ADD_ID,
        dueDate: '2026-07-27',
        calendarDay: '2026-07-27',
        timezone: 'Europe/Vienna',
        executedAt: BOOKED_AT,
        recordedAt: PRIOR_BOOKED_AT,
        expectedCandidate,
      }),
    ).rejects.toMatchObject({
      code: 'VAULT_DATA_INVALID',
      message: 'Cash standing orders must use EUR, the scan timestamp, and no quote data.',
    });
    await expect(
      store.materializeStandingOrderOccurrence({
        occurrenceId: buyOccurrenceId,
        orderId: MONTHLY_BUY_ID,
        dueDate: '2026-07-27',
        calendarDay: '2026-07-27',
        timezone: 'Europe/Vienna',
        executedAt: BOOKED_AT,
        recordedAt: PRIOR_BOOKED_AT,
        expectedCandidate,
        price: 175,
        quoteCurrency: 'EUR',
      }),
    ).rejects.toMatchObject({
      code: 'VAULT_DATA_INVALID',
      message: 'A local-asset standing order must record the scan timestamp.',
    });
    expect(sync.mutationCount).toBe(0);
  });

  it('returns an existing buy replay after its local asset snapshot is gone', async () => {
    const fixture = await decryptClientMoneyFixture();
    const dueDate = '2026-07-27';
    const occurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, dueDate);
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
        lastRunAt: BOOKED_AT,
        lastPeriodKey: dueDate,
      }),
    ]);
    document.entities.standingOrderRun = [
      bookedRun(occurrenceId, MONTHLY_BUY_ID, dueDate, BOOKED_AT),
    ];
    document.entities.transaction = [
      ...(document.entities.transaction ?? []),
      bookedBuy(occurrenceId, CLIENT_MONEY_IDS.eurAsset, '1', '175', BOOKED_AT),
    ];
    document.entities.customAsset = document.entities.customAsset?.filter(
      (entity) => entity.id !== CLIENT_MONEY_IDS.eurAsset,
    );
    const sync = createMutableTestSync(document, fixture.header);

    await expect(
      createVaultPortfolioStore(sync).materializeStandingOrderOccurrence({
        occurrenceId,
        orderId: MONTHLY_BUY_ID,
        dueDate,
        calendarDay: dueDate,
        timezone: 'Europe/Vienna',
        executedAt: BOOKED_AT,
        recordedAt: BOOKED_AT,
        expectedCandidate: candidateIdentity(fixture.header),
        price: 175,
        quoteCurrency: 'EUR',
      }),
    ).resolves.toEqual({
      occurrenceId,
      orderId: MONTHLY_BUY_ID,
      dueDate,
      rowKind: 'transaction',
      status: 'existing',
    });
    expect(sync.mutationCount).toBe(0);
  });

  it('refuses a non-derived occurrence id and a date before the schedule is due', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-28',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync);
    await expect(
      store.materializeStandingOrderOccurrence({
        occurrenceId: '018f0000-0000-5000-8000-000000000299',
        orderId: DAILY_ADD_ID,
        dueDate: '2026-07-28',
        calendarDay: '2026-07-27',
        timezone: 'Europe/Vienna',
        executedAt: BOOKED_AT,
        recordedAt: BOOKED_AT,
        expectedCandidate: candidateIdentity(fixture.header),
      }),
    ).rejects.toMatchObject({ code: 'VAULT_DATA_INVALID' });
    const derivedId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-28');
    await expect(
      store.materializeStandingOrderOccurrence({
        occurrenceId: derivedId,
        orderId: DAILY_ADD_ID,
        dueDate: '2026-07-28',
        calendarDay: '2026-07-27',
        timezone: 'Europe/Vienna',
        executedAt: BOOKED_AT,
        recordedAt: BOOKED_AT,
        expectedCandidate: candidateIdentity(fixture.header),
      }),
    ).rejects.toMatchObject({ code: 'VAULT_DATA_INVALID' });
    expect(sync.mutationCount).toBe(0);
  });

  it('skips catch-up and keeps derivations when endDate shrank below booked periods', async () => {
    const fixture = await decryptClientMoneyFixture();
    const dailyOccurrence = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-26');
    const monthlyOccurrence = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-15');
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-01',
        endDate: '2026-07-20',
        lastRunAt: PRIOR_BOOKED_AT,
        lastPeriodKey: '2026-07-26',
      }),
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '1',
        currency: 'EUR',
        cadence: 'monthly',
        anchorDay: 15,
        startDate: '2026-05-01',
        endDate: '2026-07-01',
        lastRunAt: PRIOR_BOOKED_AT,
        lastPeriodKey: '2026-07-15',
      }),
    ]);
    document.entities.standingOrderRun = [
      bookedRun(dailyOccurrence, DAILY_ADD_ID, '2026-07-26', PRIOR_BOOKED_AT),
      bookedRun(monthlyOccurrence, MONTHLY_BUY_ID, '2026-07-15', PRIOR_BOOKED_AT),
    ];
    document.entities.cashMovement = [
      ...(document.entities.cashMovement ?? []),
      bookedDeposit(dailyOccurrence, '25', PRIOR_BOOKED_AT),
    ];
    document.entities.transaction = [
      ...(document.entities.transaction ?? []),
      bookedBuy(monthlyOccurrence, CLIENT_MONEY_IDS.eurAsset, '1', '120', PRIOR_BUY_EXECUTED_AT),
    ];
    const sync = createMutableTestSync(document, fixture.header);
    const market = createClientMoneyMarket();

    const outcome = await materializeDueStandingOrders(
      sync,
      createVaultPortfolioStore(sync),
      market.market,
      { now: () => new Date(BOOKED_AT), timezone: 'Europe/Vienna' },
    );

    expect(outcome, outcome.ok ? undefined : JSON.stringify(outcome.error)).toMatchObject({
      ok: true,
      value: { booked: [], deferred: [] },
    });
    expect(sync.mutationCount).toBe(0);
    expect(market.calls.quote).toEqual([]);
    expect(market.calls.history).toEqual([]);
    expect(market.calls.fx).toEqual([]);

    const engine = createVaultMoneyEngine(sync, market.market, {
      now: () => new Date(BOOKED_AT).getTime(),
    });
    await expect(engine.onAppOpen()).resolves.toMatchObject({ ok: true });
    await expect(engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX')).resolves.toMatchObject({
      ok: true,
    });
    await expect(engine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026)).resolves.toMatchObject({
      ok: true,
    });
    expect(sync.mutationCount).toBe(0);
  });

  it('keeps live runs of a tombstoned standing order valid and derivable', async () => {
    const fixture = await decryptClientMoneyFixture();
    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-26');
    const tombstoned = standingOrder(DAILY_ADD_ID, {
      kind: 'cash-add',
      amount: '25',
      cadence: 'daily',
      anchorDay: null,
      startDate: '2026-07-01',
      lastRunAt: PRIOR_BOOKED_AT,
      lastPeriodKey: '2026-07-26',
    });
    tombstoned.rev = 1;
    tombstoned.deletedAt = BOOKED_AT;
    const document = withOrders(fixture.document, [tombstoned]);
    document.entities.standingOrderRun = [
      bookedRun(occurrenceId, DAILY_ADD_ID, '2026-07-26', PRIOR_BOOKED_AT),
    ];
    document.entities.cashMovement = [
      ...(document.entities.cashMovement ?? []),
      bookedDeposit(occurrenceId, '25', PRIOR_BOOKED_AT),
    ];
    const sync = createMutableTestSync(document, fixture.header);
    const market = createClientMoneyMarket();
    const engine = createVaultMoneyEngine(sync, market.market, {
      now: () => new Date(BOOKED_AT).getTime(),
    });

    await expect(engine.onAppOpen()).resolves.toMatchObject({ ok: true });
    await expect(engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX')).resolves.toMatchObject({
      ok: true,
    });
    await expect(engine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026)).resolves.toMatchObject({
      ok: true,
    });
    expect(sync.mutationCount).toBe(0);
  });

  it('still fails closed when a run watermark is off its cadence lattice', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'monthly',
        anchorDay: 15,
        startDate: '2026-05-01',
        lastRunAt: PRIOR_BOOKED_AT,
        lastPeriodKey: '2026-07-14',
      }),
    ]);
    document.entities.standingOrderRun = [
      bookedRun(LEGACY_RUN_ID, MONTHLY_BUY_ID, '2026-07-14', PRIOR_BOOKED_AT),
    ];
    const sync = createMutableTestSync(document, fixture.header);
    const market = createClientMoneyMarket();
    const engine = createVaultMoneyEngine(sync, market.market, {
      now: () => new Date(BOOKED_AT).getTime(),
    });

    const catchUp = await engine.onAppOpen();
    const portfolio = await engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    const tax = await engine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);

    expect(catchUp).toMatchObject({
      ok: true,
      value: {
        booked: [],
        deferred: [],
        failed: [{ orderId: MONTHLY_BUY_ID, errorCode: 'VAULT_CORRUPT' }],
        skipped: [],
      },
    });
    for (const outcome of [portfolio, tax]) {
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'VAULT_CORRUPT', retryable: false },
      });
    }
    expect(sync.mutationCount).toBe(0);
    expect(market.calls.quote).toEqual([]);
    expect(market.calls.history).toEqual([]);
    expect(market.calls.fx).toEqual([]);
  });

  it('fails closed in the store when a past-due watermark has no durable claim', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-01',
        endDate: '2026-07-20',
        lastRunAt: PRIOR_BOOKED_AT,
        lastPeriodKey: '2026-07-26',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync);
    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-20');

    await expect(
      store.materializeStandingOrderOccurrence({
        occurrenceId,
        orderId: DAILY_ADD_ID,
        dueDate: '2026-07-20',
        calendarDay: '2026-07-27',
        timezone: 'Europe/Vienna',
        executedAt: BOOKED_AT,
        recordedAt: BOOKED_AT,
        expectedCandidate: candidateIdentity(fixture.header),
      }),
    ).rejects.toMatchObject({ code: 'VAULT_DATA_INVALID' });
    expect(sync.mutationCount).toBe(0);

    // With the later period's durable claim present the same call is the
    // server's "already satisfied" skip, never a write.
    const claimed = structuredClone(document);
    claimed.entities.standingOrderRun = [
      bookedRun(
        await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-26'),
        DAILY_ADD_ID,
        '2026-07-26',
        PRIOR_BOOKED_AT,
      ),
    ];
    claimed.entities.cashMovement = [
      ...(claimed.entities.cashMovement ?? []),
      bookedDeposit(
        await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-26'),
        '25',
        PRIOR_BOOKED_AT,
      ),
    ];
    const claimedSync = createMutableTestSync(claimed, fixture.header);
    await expect(
      createVaultPortfolioStore(claimedSync).materializeStandingOrderOccurrence({
        occurrenceId,
        orderId: DAILY_ADD_ID,
        dueDate: '2026-07-20',
        calendarDay: '2026-07-27',
        timezone: 'Europe/Vienna',
        executedAt: BOOKED_AT,
        recordedAt: BOOKED_AT,
        expectedCandidate: candidateIdentity(fixture.header),
      }),
    ).resolves.toMatchObject({ status: 'existing', dueDate: '2026-07-20' });
    expect(claimedSync.mutationCount).toBe(0);
  });

  it('quantizes standing-order buy prices to the server numeric(20,6) scale', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(MONTHLY_BUY_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        amount: '2',
        currency: 'EUR',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    const sync = createMutableTestSync(document, fixture.header);
    const base = createClientMoneyMarket();
    // A float32 quote artifact the server's numeric(20,6) can never store.
    const rawQuotePrice = Number('175.33999633789062');
    const market: MarketDataSource = {
      ...base.market,
      async quote(assetId, signal) {
        const result = await base.market.quote(assetId, signal);
        return { ...result, value: { ...result.value, price: rawQuotePrice } };
      },
    };

    const outcome = await materializeDueStandingOrders(
      sync,
      createVaultPortfolioStore(sync),
      market,
      { now: () => new Date(BOOKED_AT), timezone: 'Europe/Vienna' },
    );

    expect(outcome, outcome.ok ? undefined : JSON.stringify(outcome.error)).toMatchObject({
      ok: true,
      value: { booked: [{ orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27' }], deferred: [] },
    });
    const occurrenceId = await standingOrderOccurrenceId(MONTHLY_BUY_ID, '2026-07-27');
    expect(live(sync.state.active!.document, 'transaction', occurrenceId)?.data).toMatchObject({
      quantity: '2',
      price: '175.339996',
    });
  });

  it('provisions the Main cash source on first cash touch like the server', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withOrders(fixture.document, [
      standingOrder(DAILY_ADD_ID, {
        kind: 'cash-add',
        amount: '25',
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
      }),
    ]);
    document.entities.cashSource = [];
    document.entities.cashMovement = [];
    document.entities.dividend = [];
    const sync = createMutableTestSync(document, fixture.header);
    const market = createClientMoneyMarket();

    const outcome = await materializeDueStandingOrders(
      sync,
      createVaultPortfolioStore(sync),
      market.market,
      { now: () => new Date(BOOKED_AT), timezone: 'Europe/Vienna' },
    );

    expect(outcome, outcome.ok ? undefined : JSON.stringify(outcome.error)).toMatchObject({
      ok: true,
      value: {
        booked: [{ orderId: DAILY_ADD_ID, dueDate: '2026-07-27', status: 'created' }],
        deferred: [],
      },
    });
    const active = sync.state.active!.document;
    const sources = (active.entities.cashSource ?? []).filter(
      (entity) => entity.deletedAt === null,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]?.data).toMatchObject({
      portfolioId: CLIENT_MONEY_IDS.portfolio,
      name: 'Main',
      type: 'cash',
      isMain: true,
      archivedAt: null,
    });
    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
    expect(live(active, 'cashMovement', occurrenceId)?.data).toMatchObject({
      kind: 'deposit',
      amountEur: '25',
      sourceId: sources[0]!.id,
    });
    await expect(
      createVaultMoneyEngine(sync, market.market, {
        now: () => new Date(BOOKED_AT).getTime(),
      }).derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX'),
    ).resolves.toMatchObject({ ok: true });
  });
});

function withOrders(document: VaultDocument, orders: VaultEntity[]): VaultDocument {
  const next = structuredClone(document);
  next.entities.standingOrder = orders;
  return next;
}

function standingOrder(id: string, overrides: Partial<Record<string, unknown>>): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: '2026-05-01T08:00:00.000Z',
    editedBy: DEVICE_ID,
    deletedAt: null,
    data: {
      userId: CLIENT_MONEY_IDS.user,
      portfolioId: CLIENT_MONEY_IDS.portfolio,
      kind: 'cash-add',
      assetId: null,
      amount: '1',
      currency: 'EUR',
      label: null,
      cadence: 'daily',
      anchorDay: null,
      startDate: '2026-05-01',
      endDate: null,
      status: 'active',
      lastRunAt: null,
      lastPeriodKey: null,
      createdAt: '2026-05-01T08:00:00.000Z',
      updatedAt: '2026-05-01T08:00:00.000Z',
      ...overrides,
    },
  };
}

function bookedRun(
  id: string,
  standingOrderId: string,
  periodKey: string,
  bookedAt: string,
): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: bookedAt,
    editedBy: DEVICE_ID,
    deletedAt: null,
    data: { standingOrderId, periodKey, bookedAt },
  };
}

function bookedDeposit(id: string, amountEur: string, executedAt: string): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: executedAt,
    editedBy: DEVICE_ID,
    deletedAt: null,
    data: {
      portfolioId: CLIENT_MONEY_IDS.portfolio,
      sourceId: CLIENT_MONEY_IDS.cashSource,
      kind: 'deposit',
      amountEur,
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      executedAt,
      note: null,
      source: 'standing-order',
      dedupHash: null,
      originalCurrency: null,
      createdAt: executedAt,
    },
  };
}

function bookedBuy(
  id: string,
  assetId: string,
  quantity: string,
  price: string,
  executedAt: string,
): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: executedAt,
    editedBy: DEVICE_ID,
    deletedAt: null,
    data: {
      portfolioId: CLIENT_MONEY_IDS.portfolio,
      assetId,
      side: 'buy',
      quantity,
      price,
      fee: '0',
      executedAt,
      note: null,
      taxMode: null,
      taxCountry: null,
      taxAmountEur: null,
      taxParams: null,
      allowUncovered: false,
      uncoveredEntryPrice: null,
      source: 'standing-order',
    },
  };
}

function candidateIdentity(header: { vaultVersion: number; keyId: string; writeId: string }): {
  vaultVersion: number;
  vaultKeyId: string;
  writeId: string;
} {
  return {
    vaultVersion: header.vaultVersion,
    vaultKeyId: header.keyId,
    writeId: header.writeId,
  };
}

function live(
  document: VaultDocument,
  kind: keyof VaultDocument['entities'],
  id: string,
): VaultEntity | undefined {
  return document.entities[kind]?.find((entity) => entity.id === id && entity.deletedAt === null);
}

function order(document: VaultDocument, id: string): VaultEntity {
  const entity = live(document, 'standingOrder', id);
  if (entity === undefined) throw new Error(`Missing standing order ${id}`);
  return entity;
}

function manualValue(id: string, assetId: string, date: string, close: string): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: `${date}T12:00:00.000Z`,
    editedBy: DEVICE_ID,
    deletedAt: null,
    data: { assetId, date, close },
  };
}

function createMemoryLocalStorage(): LocalDataHomeStorage {
  let record: LocalVaultRecord | null = null;
  return {
    async read() {
      return cloneLocalRecord(record);
    },
    async compareAndSwap(_scope, ifVersion, build) {
      const currentVersion = record?.version ?? null;
      if (currentVersion !== ifVersion) {
        return { status: 'conflict', currentVersion };
      }
      record = cloneLocalRecord(build(cloneLocalRecord(record)));
      return { status: 'ok' };
    },
  };
}

function writeIdSequence(seed: number): () => string {
  let sequence = seed;
  return () => `018f0000-0000-7000-8000-${(sequence++).toString(16).padStart(12, '0')}`;
}

function createFailingCommitStorage(): {
  storage: LocalDataHomeStorage;
  failNextCommit(): void;
  readonly failureCount: number;
  readonly currentVersion: number | null;
} {
  let record: LocalVaultRecord | null = null;
  let failNext = false;
  let failures = 0;
  const storage: LocalDataHomeStorage = {
    async read() {
      return cloneLocalRecord(record);
    },
    async compareAndSwap(_scope, ifVersion, build) {
      if (failNext) {
        failNext = false;
        failures += 1;
        throw new Error('Injected local encrypted commit failure.');
      }
      const currentVersion = record?.version ?? null;
      if (currentVersion !== ifVersion) {
        return { status: 'conflict', currentVersion };
      }
      record = cloneLocalRecord(build(cloneLocalRecord(record)));
      return { status: 'ok' };
    },
  };
  return {
    storage,
    failNextCommit() {
      failNext = true;
    },
    get failureCount() {
      return failures;
    },
    get currentVersion() {
      return record?.version ?? null;
    },
  };
}

function createReconnectConflictStorage(): {
  storage: LocalDataHomeStorage;
  armReconnectConflict(): void;
  readonly readStarted: Promise<void>;
  releaseRead(): void;
  readonly currentVersion: number | null;
} {
  const readStarted = deferred<void>();
  const releaseRead = deferred<void>();
  let record: LocalVaultRecord | null = null;
  let blockNextRead = false;
  let conflictsRemaining = 0;
  const storage: LocalDataHomeStorage = {
    async read() {
      if (blockNextRead) {
        blockNextRead = false;
        readStarted.resolve();
        await releaseRead.promise;
      }
      return cloneLocalRecord(record);
    },
    async compareAndSwap(_scope, ifVersion, build) {
      const currentVersion = record?.version ?? null;
      if (conflictsRemaining > 0) {
        conflictsRemaining -= 1;
        return { status: 'conflict', currentVersion };
      }
      if (currentVersion !== ifVersion) {
        return { status: 'conflict', currentVersion };
      }
      record = cloneLocalRecord(build(cloneLocalRecord(record)));
      return { status: 'ok' };
    },
  };
  return {
    storage,
    armReconnectConflict() {
      blockNextRead = true;
      // Exhaust the sync engine's bounded reconcile retry loop, then allow the
      // queued mutation's storage path to proceed if its status gate is wrong.
      conflictsRemaining = 16;
    },
    get readStarted() {
      return readStarted.promise;
    },
    releaseRead() {
      releaseRead.resolve();
    },
    get currentVersion() {
      return record?.version ?? null;
    },
  };
}

function cloneLocalRecord(record: LocalVaultRecord | null): LocalVaultRecord | null {
  return record === null ? null : structuredClone(record);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createMemoryPrimary(initialEnvelope: Uint8Array): {
  home: DataHome;
  readonly writeCount: number;
  readonly version: number;
} {
  let envelope = initialEnvelope.slice();
  let header = decodeTestEnvelopeHeader(envelope);
  let writes = 0;
  const home: DataHome = {
    medium: 'server',
    async read() {
      return {
        status: 'ok',
        medium: 'server',
        envelope: envelope.slice(),
        info: {
          medium: 'server',
          version: header.vaultVersion,
          sizeBytes: envelope.byteLength,
          updatedAt: header.writtenAt,
        },
      };
    },
    async write(next, options) {
      writes += 1;
      if (options.ifVersion !== header.vaultVersion) {
        return {
          status: 'conflict',
          medium: 'server',
          currentVersion: header.vaultVersion,
        };
      }
      envelope = next.slice();
      header = decodeTestEnvelopeHeader(envelope);
      return {
        status: 'ok',
        medium: 'server',
        info: {
          medium: 'server',
          version: header.vaultVersion,
          sizeBytes: envelope.byteLength,
          updatedAt: header.writtenAt,
        },
      };
    },
    async info() {
      return {
        status: 'ok',
        medium: 'server',
        info: {
          medium: 'server',
          version: header.vaultVersion,
          sizeBytes: envelope.byteLength,
          updatedAt: header.writtenAt,
        },
      };
    },
  };
  return {
    home,
    get writeCount() {
      return writes;
    },
    get version() {
      return header.vaultVersion;
    },
  };
}

function createContendedMemoryPrimary(initialEnvelope: Uint8Array): {
  home: DataHome;
  readonly conflictCount: number;
  readonly initialCandidateDeviceIds: string[];
} {
  interface Contender {
    next: Uint8Array;
    resolve: (result: DataHomeWriteResult) => void;
  }

  let envelope = initialEnvelope.slice();
  let header = decodeTestEnvelopeHeader(envelope);
  const initialVersion = header.vaultVersion;
  const contenders: Contender[] = [];
  const initialCandidateDeviceIds: string[] = [];
  let contentionOpen = true;
  let conflicts = 0;

  function successfulWrite(): DataHomeWriteResult {
    return {
      status: 'ok',
      medium: 'server',
      info: {
        medium: 'server',
        version: header.vaultVersion,
        sizeBytes: envelope.byteLength,
        updatedAt: header.writtenAt,
      },
    };
  }

  const home: DataHome = {
    medium: 'server',
    async read() {
      return {
        status: 'ok',
        medium: 'server',
        envelope: envelope.slice(),
        info: {
          medium: 'server',
          version: header.vaultVersion,
          sizeBytes: envelope.byteLength,
          updatedAt: header.writtenAt,
        },
      };
    },
    async write(next: Uint8Array, options: DataHomeWriteOptions): Promise<DataHomeWriteResult> {
      if (contentionOpen && options.ifVersion === initialVersion) {
        initialCandidateDeviceIds.push(decodeTestEnvelopeHeader(next).deviceId);
        return new Promise<DataHomeWriteResult>((resolve) => {
          contenders.push({ next: next.slice(), resolve });
          if (contenders.length !== 2) return;

          contentionOpen = false;
          const winner = contenders[0]!;
          const loser = contenders[1]!;
          envelope = winner.next;
          header = decodeTestEnvelopeHeader(envelope);
          winner.resolve(successfulWrite());
          conflicts += 1;
          loser.resolve({
            status: 'conflict',
            medium: 'server',
            currentVersion: header.vaultVersion,
          });
        });
      }
      if (options.ifVersion !== header.vaultVersion) {
        conflicts += 1;
        return {
          status: 'conflict',
          medium: 'server',
          currentVersion: header.vaultVersion,
        };
      }
      envelope = next.slice();
      header = decodeTestEnvelopeHeader(envelope);
      return successfulWrite();
    },
    async info() {
      return {
        status: 'ok',
        medium: 'server',
        info: {
          medium: 'server',
          version: header.vaultVersion,
          sizeBytes: envelope.byteLength,
          updatedAt: header.writtenAt,
        },
      };
    },
  };

  return {
    home,
    get conflictCount() {
      return conflicts;
    },
    get initialCandidateDeviceIds() {
      return [...initialCandidateDeviceIds];
    },
  };
}

function decodeTestEnvelopeHeader(envelope: Uint8Array) {
  return vaultEnvelopeHeaderSchema.parse(decodeVaultEnvelope(envelope).header);
}
