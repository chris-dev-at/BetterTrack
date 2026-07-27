import { webcrypto } from 'node:crypto';

import type { VaultDocumentV1, VaultEntity } from '@bettertrack/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CLIENT_MONEY_IDS,
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
} from '../engine/clientMoney.testSupport';
import { createVaultMoneyEngine } from '../engine';
import { createVaultPortfolioStore, type VaultPortfolioStore } from '../vaultPortfolioStore';
import { createStandingOrderMaterializationLifecycle } from './lifecycle';
import { materializeDueStandingOrders } from './materialize';
import { standingOrderOccurrenceId } from './occurrenceId';
import { calendarDayInTimezone, dueStandingOrderOccurrence } from './schedule';

const DAILY_ADD_ID = '018f0000-0000-7000-8000-000000000201';
const MONTHLY_BUY_ID = '018f0000-0000-7000-8000-000000000202';
const PAUSED_ID = '018f0000-0000-7000-8000-000000000203';
const NOT_DUE_ID = '018f0000-0000-7000-8000-000000000204';
const DEDUCT_ID = '018f0000-0000-7000-8000-000000000205';
const DEVICE_ID = CLIENT_MONEY_IDS.device;
const BOOKED_AT = '2026-07-26T22:30:00.000Z';

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

  it('converges concurrent devices on one deterministic occurrence and retry after a lost response', async () => {
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
    const store = createVaultPortfolioStore(sync);
    const market = createClientMoneyMarket();
    const options = {
      now: () => new Date(BOOKED_AT),
      timezone: 'Europe/Vienna',
    };

    const [first, second] = await Promise.all([
      materializeDueStandingOrders(sync, store, market.market, options),
      materializeDueStandingOrders(sync, store, market.market, options),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const occurrenceId = await standingOrderOccurrenceId(DAILY_ADD_ID, '2026-07-27');
    expect(
      sync.state.active!.document.entities.cashMovement?.filter(
        (entity) => entity.id === occurrenceId,
      ),
    ).toHaveLength(1);
    expect(
      sync.state.active!.document.entities.standingOrderRun?.filter(
        (entity) => entity.id === occurrenceId,
      ),
    ).toHaveLength(1);

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
    expect(
      retrySync.state.active!.document.entities.cashMovement?.filter(
        (entity) => entity.id === occurrenceId,
      ),
    ).toHaveLength(1);
  });

  it('defers missing quotes and insufficient cash without claiming the period', async () => {
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
          { orderId: MONTHLY_BUY_ID, dueDate: '2026-07-27', reason: 'market-data' },
          { orderId: DEDUCT_ID, dueDate: '2026-07-27', reason: 'insufficient-cash' },
        ],
      },
    });
    expect(sync.state.active!.document.entities.standingOrderRun).toBeUndefined();
    expect(order(sync.state.active!.document, MONTHLY_BUY_ID).data.lastPeriodKey).toBeNull();
    expect(order(sync.state.active!.document, DEDUCT_ID).data.lastPeriodKey).toBeNull();

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
      ok: false,
      error: { code: 'MARKET_DATA_INVALID' },
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
      ok: false,
      error: { code: 'VAULT_CORRUPT' },
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
      value: { today: '2026-07-27', booked: [], deferred: [] },
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
      }),
    ).rejects.toMatchObject({ code: 'VAULT_DATA_INVALID' });
    expect(sync.mutationCount).toBe(0);
  });
});

function withOrders(document: VaultDocumentV1, orders: VaultEntity[]): VaultDocumentV1 {
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

function live(
  document: VaultDocumentV1,
  kind: keyof VaultDocumentV1['entities'],
  id: string,
): VaultEntity | undefined {
  return document.entities[kind]?.find((entity) => entity.id === id && entity.deletedAt === null);
}

function order(document: VaultDocumentV1, id: string): VaultEntity {
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
