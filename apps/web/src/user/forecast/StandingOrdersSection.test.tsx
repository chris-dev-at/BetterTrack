import { webcrypto } from 'node:crypto';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { PortfolioSummary, StandingOrder, VaultEntity } from '@bettertrack/contracts';

vi.mock('../../lib/standingOrdersApi', () => ({
  STANDING_ORDERS_QUERY_KEY: ['standingOrders'],
  listStandingOrders: vi.fn(),
  createStandingOrder: vi.fn(),
  updateStandingOrder: vi.fn(),
  pauseStandingOrder: vi.fn(),
  resumeStandingOrder: vi.fn(),
  deleteStandingOrder: vi.fn(),
}));

import * as standingOrdersApi from '../../lib/standingOrdersApi';
import { MarketDataSourceError, type MarketDataSource } from '../../lib/marketDataSource';

import { StandingOrdersSection } from './StandingOrdersSection';
import { PortfolioStoreProvider } from '../portfolio/PortfolioStoreProvider';
import {
  CLIENT_MONEY_IDS,
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
} from '../vault/engine/clientMoney.testSupport';
import { createVaultMoneyEngine } from '../vault/engine';
import { createParanoidAppPortfolioStore } from '../vault/engine/paranoidPortfolioStore';
import {
  VaultMoneyEngineContext,
  type VaultMoneySession,
} from '../vault/engine/VaultMoneyEngineContext';
import { createStandingOrderMaterializationLifecycle } from '../vault/standingOrders/lifecycle';
import type { StandingOrderMaterializationResult } from '../vault/standingOrders/materialize';
import { standingOrderOccurrenceId } from '../vault/standingOrders/occurrenceId';
import { createVaultPortfolioStore } from '../vault/vaultPortfolioStore';

const PORTFOLIOS: PortfolioSummary[] = [
  {
    id: 'p1',
    name: 'Main',
    visibility: 'private',
    sortOrder: 0,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
  },
];

const VAULT_QUOTE_DEFERRED_ID = '018f0000-0000-7000-8000-000000000301';
const VAULT_FAILED_ID = '018f0000-0000-7000-8000-000000000302';
const VAULT_BOOKED_ID = '018f0000-0000-7000-8000-000000000303';
const VAULT_PAUSED_ID = '018f0000-0000-7000-8000-000000000304';
const VAULT_FUTURE_ID = '018f0000-0000-7000-8000-000000000305';
const VAULT_INSUFFICIENT_ID = '018f0000-0000-7000-8000-000000000306';
const VAULT_OVERSOLD_TRANSACTION_ID = '018f0000-0000-7000-8000-000000000307';
const VAULT_SCAN_AT = '2026-07-26T22:30:00.000Z';

function makeOrder(over: Partial<StandingOrder> = {}): StandingOrder {
  return {
    id: 'so1',
    portfolioId: 'p1',
    kind: 'buy-asset',
    assetId: 'a1',
    assetSymbol: 'VWCE.DE',
    assetName: 'Vanguard FTSE All-World',
    amount: 5,
    currency: 'EUR',
    label: null,
    cadence: 'monthly',
    anchorDay: 1,
    startDate: '2026-07-01',
    endDate: null,
    status: 'active',
    lastRunAt: null,
    lastPeriodKey: null,
    nextRunDate: '2026-08-01',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function renderSection(initialEntry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <StandingOrdersSection portfolios={PORTFOLIOS} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderVaultSection(session: VaultMoneySession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const portfolios = [{ ...PORTFOLIOS[0]!, id: CLIENT_MONEY_IDS.portfolio }];
  render(
    <QueryClientProvider client={client}>
      <VaultMoneyEngineContext.Provider value={session}>
        <PortfolioStoreProvider store={createParanoidAppPortfolioStore(session)}>
          <MemoryRouter>
            <StandingOrdersSection portfolios={portfolios} />
          </MemoryRouter>
        </PortfolioStoreProvider>
      </VaultMoneyEngineContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  vi.clearAllMocks();
  vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({ orders: [] });
});

describe('StandingOrdersSection', () => {
  test('shows the designed empty state and a New-order CTA', async () => {
    renderSection();
    expect(await screen.findByText('No standing orders yet')).toBeInTheDocument();
    // The header still has the visible primary CTA.
    expect(screen.getByRole('button', { name: 'New standing order' })).toBeInTheDocument();
  });

  test('lists each order with its next run', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [
        makeOrder({ id: 'so-buy', assetSymbol: 'VWCE.DE', amount: 3, nextRunDate: '2026-08-01' }),
        makeOrder({
          id: 'so-cash',
          kind: 'cash-add',
          assetId: null,
          assetSymbol: null,
          assetName: null,
          amount: 2500,
          label: 'salary',
          nextRunDate: '2026-08-05',
          cadence: 'monthly',
          anchorDay: 5,
        }),
      ],
    });
    renderSection();

    expect(await screen.findByText('VWCE.DE')).toBeInTheDocument();
    expect(screen.getByText('VWCE.DE').closest('li')).toHaveAttribute(
      'id',
      'standing-order-so-buy',
    );
    // The row's compact description bundles amount + cadence in one line;
    // match on a substring so the ` · ` separator between them is ignored.
    expect(screen.getByText(/Buy 3 × VWCE\.DE/)).toBeInTheDocument();
    // Localized date + label the row exposes.
    expect(screen.getByText(/Next run: 01\.08\.2026/)).toBeInTheDocument();

    expect(screen.getByText('salary')).toBeInTheDocument();
    expect(screen.getByText(/Add 2\.500,00 €/)).toBeInTheDocument();
  });

  test('keeps server-mode rows free of vault materialization notices', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [makeOrder()],
    });
    renderSection();

    const row = (await screen.findByText('VWCE.DE')).closest('li')!;
    expect(within(row).queryByText(/^Not booked/)).not.toBeInTheDocument();
  });

  test('logs a throwing materialization subscriber without failing its scan', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header);
    const market = createClientMoneyMarket().market;
    const lifecycle = createStandingOrderMaterializationLifecycle(sync, market, {
      retryCount: 0,
      materialize: async () => ({
        ok: true,
        value: {
          today: '2026-07-27',
          booked: [],
          deferred: [],
          failed: [],
          skipped: [],
          dropped: [],
        },
      }),
    });
    const observerError = new Error('observer failed');
    const healthyObserver = vi.fn();
    lifecycle.subscribeStandingOrderMaterialization(() => {
      throw observerError;
    });
    lifecycle.subscribeStandingOrderMaterialization(healthyObserver);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(lifecycle.onAppOpen()).resolves.toMatchObject({ ok: true });
      expect(healthyObserver).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledWith(
        'Failed to notify standing-order materialization observer.',
        observerError,
      );
    } finally {
      logError.mockRestore();
    }
  });

  test('shows only affected vault rows after a scan and clears a quote notice after recovery', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    const priorRunId = await standingOrderOccurrenceId(VAULT_INSUFFICIENT_ID, '2026-07-22');
    document.entities.standingOrder = [
      vaultStandingOrder(VAULT_QUOTE_DEFERRED_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        label: 'Deferred quote',
      }),
      vaultStandingOrder(VAULT_FAILED_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.usdAsset,
        currency: 'USD',
        label: 'Commit failure',
      }),
      vaultStandingOrder(VAULT_BOOKED_ID, { label: 'Salary' }),
      vaultStandingOrder(VAULT_PAUSED_ID, { label: 'Paused', status: 'paused' }),
      vaultStandingOrder(VAULT_FUTURE_ID, {
        label: 'Tomorrow',
        startDate: '2026-07-28',
      }),
      vaultStandingOrder(VAULT_INSUFFICIENT_ID, {
        kind: 'cash-deduct',
        amount: '5000',
        label: 'Rent',
        lastRunAt: '2026-07-22T08:00:00.000Z',
        lastPeriodKey: '2026-07-22',
        updatedAt: '2026-07-23T08:00:00.000Z',
      }),
    ];
    document.entities.standingOrderRun = [
      ...(document.entities.standingOrderRun ?? []),
      vaultStandingOrderRun(
        priorRunId,
        VAULT_INSUFFICIENT_ID,
        '2026-07-22',
        '2026-07-22T08:00:00.000Z',
      ),
    ];
    document.entities.cashMovement = [
      ...(document.entities.cashMovement ?? []),
      vaultStandingOrderWithdrawal(priorRunId, '-1', '2026-07-22T08:00:00.000Z'),
    ];
    // Reconciliation skips this unchanged invalid baseline; the standing-order
    // buy mutates its USD timeline so prospective validation rejects the real
    // store commit instead of a test double manufacturing a failure.
    document.entities.transaction = [
      ...(document.entities.transaction ?? []),
      vaultOversoldTransaction(VAULT_OVERSOLD_TRANSACTION_ID),
    ];
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync, { now: () => VAULT_SCAN_AT });
    const failedOccurrenceId = await standingOrderOccurrenceId(VAULT_FAILED_ID, '2026-07-27');
    await expect(
      store.materializeStandingOrderOccurrence({
        occurrenceId: failedOccurrenceId,
        orderId: VAULT_FAILED_ID,
        dueDate: '2026-07-27',
        calendarDay: '2026-07-27',
        timezone: 'Europe/Vienna',
        executedAt: VAULT_SCAN_AT,
        recordedAt: VAULT_SCAN_AT,
        expectedCandidate: {
          vaultVersion: fixture.header.vaultVersion,
          vaultKeyId: fixture.header.keyId,
          writeId: fixture.header.writeId,
        },
        price: 50,
        quoteCurrency: 'USD',
      }),
    ).rejects.toMatchObject({
      code: 'VAULT_DATA_INVALID',
      message: 'The transaction mutation would oversell the available holding.',
    });
    const baseMarket = createClientMoneyMarket();
    let quoteRecovered = false;
    const market: MarketDataSource = {
      ...baseMarket.market,
      async quote(assetId, signal) {
        if (assetId === CLIENT_MONEY_IDS.eurAsset && !quoteRecovered) {
          throw new MarketDataSourceError(
            'MARKET_DATA_UNSUPPORTED',
            'The test quote is deliberately unsupported.',
          );
        }
        return baseMarket.market.quote(assetId, signal);
      },
    };
    const lifecycle = createStandingOrderMaterializationLifecycle(sync, market, {
      store,
      now: () => new Date(VAULT_SCAN_AT),
      timezone: 'Europe/Vienna',
      retryCount: 0,
    });
    const engine = createVaultMoneyEngine(sync, market, {
      now: () => Date.parse(VAULT_SCAN_AT),
      standingOrders: lifecycle,
    });

    await expect(engine.afterUnlock()).resolves.toMatchObject({
      ok: true,
      value: {
        booked: [{ orderId: VAULT_BOOKED_ID, dueDate: '2026-07-27' }],
        deferred: [
          {
            orderId: VAULT_QUOTE_DEFERRED_ID,
            dueDate: '2026-07-27',
            reason: 'quote-unavailable',
          },
          {
            orderId: VAULT_INSUFFICIENT_ID,
            dueDate: '2026-07-27',
            reason: 'insufficient-cash',
          },
        ],
        failed: [{ orderId: VAULT_FAILED_ID, dueDate: '2026-07-27', errorCode: 'VAULT_CORRUPT' }],
      },
    });
    renderVaultSection({ engine, sync, store });

    await waitFor(() =>
      expect(documentElementById(`standing-order-${VAULT_QUOTE_DEFERRED_ID}`)).toBeInTheDocument(),
    );
    const deferredRow = documentElementById(`standing-order-${VAULT_QUOTE_DEFERRED_ID}`);
    const failedRow = documentElementById(`standing-order-${VAULT_FAILED_ID}`);
    const insufficientRow = documentElementById(`standing-order-${VAULT_INSUFFICIENT_ID}`);
    expect(
      within(deferredRow).getByText(
        'Not booked — quote unavailable — oldest missed booking due since 01.07.2026',
      ),
    ).toBeInTheDocument();
    const failedNotice = within(failedRow).getByText(
      'Not booked — booking error — oldest missed booking due since 01.07.2026',
    );
    expect(failedNotice).toHaveClass('bt-neg');
    expect(failedNotice).not.toHaveClass('bt-gold-note');
    expect(
      within(insufficientRow).getByText(
        'Not booked — insufficient cash — oldest missed booking due since 23.07.2026',
      ),
    ).toBeInTheDocument();

    for (const orderId of [VAULT_BOOKED_ID, VAULT_PAUSED_ID, VAULT_FUTURE_ID]) {
      expect(
        within(documentElementById(`standing-order-${orderId}`)).queryByText(/^Not booked/),
      ).not.toBeInTheDocument();
    }

    quoteRecovered = true;
    await act(async () => {
      await expect(engine.afterUnlock()).resolves.toMatchObject({
        ok: true,
        value: {
          booked: [{ orderId: VAULT_QUOTE_DEFERRED_ID, dueDate: '2026-07-27' }],
        },
      });
    });

    await waitFor(() =>
      expect(within(deferredRow).queryByText(/^Not booked/)).not.toBeInTheDocument(),
    );
    expect(
      within(failedRow).getByText(/^Not booked — booking error — oldest missed booking due since/),
    ).toBeInTheDocument();
    expect(
      within(insufficientRow).getByText(
        'Not booked — insufficient cash — oldest missed booking due since 23.07.2026',
      ),
    ).toBeInTheDocument();
  });

  // One case per axis on which a retained scan outcome can go stale. The row's
  // notice is derived from the document alone, so each of these must suppress it
  // even though the lifecycle still holds — and republishes — the old outcome.

  test('suppresses a retained deferral once the vault watermark covers its due date', async () => {
    const row = await renderRetainedScan({
      booked: { day: '2026-07-22', at: '2026-07-22T08:00:00.000Z' },
      scan: {
        today: '2026-07-22',
        deferred: [
          { orderId: VAULT_INSUFFICIENT_ID, dueDate: '2026-07-22', reason: 'insufficient-cash' },
        ],
        failed: [],
      },
    });

    expect(within(row).queryByText(/^Not booked/)).not.toBeInTheDocument();
  });

  test('suppresses a retained deferral once the end date leaves no outstanding occurrence', async () => {
    const row = await renderRetainedScan({
      // The user pulled `endDate` back behind the deferred day after the scan.
      order: { endDate: '2026-07-22' },
      booked: { day: '2026-07-22', at: '2026-07-22T08:00:00.000Z' },
      scan: {
        today: '2026-07-27',
        deferred: [
          { orderId: VAULT_INSUFFICIENT_ID, dueDate: '2026-07-27', reason: 'quote-unavailable' },
        ],
        failed: [],
      },
    });

    expect(within(row).queryByText(/^Not booked/)).not.toBeInTheDocument();
  });

  test('never dates a notice in the future when the watermark already covers today', async () => {
    const row = await renderRetainedScan({
      booked: { day: '2026-07-27', at: VAULT_SCAN_AT },
      scan: {
        today: '2026-07-27',
        deferred: [
          { orderId: VAULT_INSUFFICIENT_ID, dueDate: '2026-07-27', reason: 'insufficient-cash' },
        ],
        failed: [],
      },
    });

    expect(within(row).queryByText(/^Not booked/)).not.toBeInTheDocument();
    // Tomorrow is the only still-unbooked occurrence, and an outage cannot have
    // started in the future — the row may schedule it, never date a notice to it.
    expect(within(row).queryByText(/since 28\.07\.2026/)).not.toBeInTheDocument();
    expect(within(row).getByText('Next run: 28.07.2026')).toBeInTheDocument();
  });

  test('suppresses an undated failure when the order owes no occurrence', async () => {
    const row = await renderRetainedScan({
      order: { endDate: '2026-07-22' },
      booked: { day: '2026-07-22', at: '2026-07-22T08:00:00.000Z' },
      scan: {
        today: '2026-07-27',
        deferred: [],
        failed: [{ orderId: VAULT_INSUFFICIENT_ID, dueDate: null, errorCode: 'VAULT_CORRUPT' }],
      },
    });

    expect(within(row).queryByText(/^Not booked/)).not.toBeInTheDocument();
  });

  test('dates an undated failure from the document when an occurrence is outstanding', async () => {
    const row = await renderRetainedScan({
      scan: {
        today: '2026-07-27',
        deferred: [],
        failed: [{ orderId: VAULT_INSUFFICIENT_ID, dueDate: null, errorCode: 'VAULT_CORRUPT' }],
      },
    });

    expect(
      within(row).getByText(
        'Not booked — booking error — oldest missed booking due since 01.07.2026',
      ),
    ).toBeInTheDocument();
  });

  // The other side of the same coin: a dropped period and a stale-priced
  // booking are facts about what the scan DID, so they are stated even when the
  // order booked — the suppression that hid them is what #1793 is about.

  test('names the catch-up periods the vault scan dropped, though the newest booked', async () => {
    const row = await renderRetainedScan({
      booked: { day: '2026-07-27', at: VAULT_SCAN_AT },
      scan: {
        today: '2026-07-27',
        deferred: [],
        failed: [],
        booked: [
          {
            orderId: VAULT_INSUFFICIENT_ID,
            occurrenceId: '018f0000-0000-7000-8000-0000000003a1',
            dueDate: '2026-07-27',
            kind: 'cash-deduct',
            status: 'created',
          },
        ],
        dropped: [
          {
            orderId: VAULT_INSUFFICIENT_ID,
            periods: ['2026-07-25', '2026-07-26'],
            newestPeriod: '2026-07-26',
            droppedCount: 2,
          },
        ],
      },
    });

    expect(
      within(row).getByText(
        '2 missed period(s) skipped, up to 26.07.2026 — only the newest one is caught up, the rest are not booked',
      ),
    ).toBeInTheDocument();
  });

  test('names the valuation day a local-asset booking was priced from', async () => {
    const row = await renderRetainedScan({
      booked: { day: '2026-07-27', at: VAULT_SCAN_AT },
      scan: {
        today: '2026-07-27',
        deferred: [],
        failed: [],
        booked: [
          {
            orderId: VAULT_INSUFFICIENT_ID,
            occurrenceId: '018f0000-0000-7000-8000-0000000003a2',
            dueDate: '2026-07-27',
            kind: 'buy-asset',
            status: 'created',
            stalePriceAsOf: '2025-01-15',
          },
        ],
      },
    });

    expect(
      within(row).getByText(
        'Booked at your own valuation from 15.01.2025 — no newer value point exists',
      ),
    ).toBeInTheDocument();
  });

  test('scrolls to a notification-linked row after the async list loads', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [makeOrder()],
    });

    renderSection('/workbench/forecasts#standing-order-so1');

    expect(await screen.findByText('VWCE.DE')).toBeInTheDocument();
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'center',
      }),
    );
  });

  test('pauses an active order and reflects the resume affordance after refetch', async () => {
    const active = makeOrder({ status: 'active' });
    const paused = makeOrder({ status: 'paused', nextRunDate: null });
    vi.mocked(standingOrdersApi.listStandingOrders)
      .mockResolvedValueOnce({ orders: [active] })
      .mockResolvedValue({ orders: [paused] });
    vi.mocked(standingOrdersApi.pauseStandingOrder).mockResolvedValue(paused);

    const user = userEvent.setup();
    renderSection();

    await screen.findByText('VWCE.DE');
    await user.click(screen.getByRole('button', { name: 'VWCE.DE Pause' }));

    await waitFor(() => expect(standingOrdersApi.pauseStandingOrder).toHaveBeenCalledWith('so1'));
    // After the mutation success the shared query key refetches and the row now
    // exposes Resume + a Paused badge.
    expect(await screen.findByRole('button', { name: 'VWCE.DE Resume' })).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  test('resumes a paused order and swaps back to Pause', async () => {
    const paused = makeOrder({ status: 'paused', nextRunDate: null });
    const active = makeOrder({ status: 'active', nextRunDate: '2026-08-01' });
    vi.mocked(standingOrdersApi.listStandingOrders)
      .mockResolvedValueOnce({ orders: [paused] })
      .mockResolvedValue({ orders: [active] });
    vi.mocked(standingOrdersApi.resumeStandingOrder).mockResolvedValue(active);

    const user = userEvent.setup();
    renderSection();

    await screen.findByRole('button', { name: 'VWCE.DE Resume' });
    await user.click(screen.getByRole('button', { name: 'VWCE.DE Resume' }));

    await waitFor(() => expect(standingOrdersApi.resumeStandingOrder).toHaveBeenCalledWith('so1'));
    expect(await screen.findByRole('button', { name: 'VWCE.DE Pause' })).toBeInTheDocument();
  });

  test('confirms before deleting and then round-trips', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders)
      .mockResolvedValueOnce({ orders: [makeOrder()] })
      .mockResolvedValue({ orders: [] });
    vi.mocked(standingOrdersApi.deleteStandingOrder).mockResolvedValue();

    const user = userEvent.setup();
    renderSection();

    await screen.findByText('VWCE.DE');
    await user.click(screen.getByRole('button', { name: 'VWCE.DE Delete' }));

    // A confirm prompt appears before any API call is made.
    expect(standingOrdersApi.deleteStandingOrder).not.toHaveBeenCalled();
    expect(
      screen.getByText('Delete this standing order? It stops creating future entries.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'VWCE.DE Yes' }));

    await waitFor(() => expect(standingOrdersApi.deleteStandingOrder).toHaveBeenCalledWith('so1'));
    // After refetch the list is empty again.
    expect(await screen.findByText('No standing orders yet')).toBeInTheDocument();
  });

  test('surfaces the load-error banner when the fetch fails', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ orders: [] });
    const user = userEvent.setup();
    renderSection();

    expect(
      await screen.findByText('Could not load your standing orders. Please try again.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No standing orders yet')).toBeInTheDocument();
    expect(standingOrdersApi.listStandingOrders).toHaveBeenCalledTimes(2);
  });

  test('paused orders show "No next run scheduled" instead of a date', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [makeOrder({ status: 'paused', nextRunDate: null })],
    });
    renderSection();

    await screen.findByText('VWCE.DE');
    expect(screen.getByText('No next run scheduled.')).toBeInTheDocument();
  });

  test.each([
    ['active live', false, 'active', 'Active', 'Pause'],
    ['paused live', false, 'paused', 'Paused', 'Resume'],
    ['active archive-suspended', true, 'active', 'Suspended — portfolio archived', null],
    ['paused archive-suspended', true, 'paused', 'Suspended — portfolio archived', null],
  ] as const)(
    '%s rows show the intended badge and pause/resume affordance',
    async (_state, suspendedByArchive, status, badge, pauseResumeAction) => {
      vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
        orders: [makeOrder({ suspendedByArchive, status, nextRunDate: null })],
      });
      renderSection();

      await screen.findByText('VWCE.DE');
      expect(screen.getByText(badge)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'VWCE.DE Edit' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'VWCE.DE Delete' })).toBeInTheDocument();

      if (pauseResumeAction) {
        expect(
          screen.getByRole('button', { name: `VWCE.DE ${pauseResumeAction}` }),
        ).toBeInTheDocument();
      } else {
        expect(screen.queryByRole('button', { name: 'VWCE.DE Pause' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'VWCE.DE Resume' })).not.toBeInTheDocument();
      }
    },
  );

  test('opens the edit dialog for a row', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [makeOrder()],
    });
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('VWCE.DE');
    await user.click(screen.getByRole('button', { name: 'VWCE.DE Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit standing order' });
    // Kind is locked in edit mode — every non-current tab is disabled.
    expect(within(dialog).getByRole('button', { name: 'Add cash' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Buy asset' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('gives each row distinct primary and delete-confirmation action names', async () => {
    vi.mocked(standingOrdersApi.listStandingOrders).mockResolvedValue({
      orders: [
        makeOrder({ id: 'so-buy', assetSymbol: 'VWCE.DE' }),
        makeOrder({
          id: 'so-cash',
          kind: 'cash-add',
          assetId: null,
          assetSymbol: null,
          assetName: null,
          label: 'salary',
          status: 'paused',
          nextRunDate: null,
        }),
      ],
    });
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('VWCE.DE');
    expect(screen.getByRole('button', { name: 'VWCE.DE Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'salary Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'VWCE.DE Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'salary Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'VWCE.DE Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'salary Delete' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'VWCE.DE Delete' }));
    expect(screen.getByRole('button', { name: 'VWCE.DE Yes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'VWCE.DE No' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'VWCE.DE No' }));

    await user.click(screen.getByRole('button', { name: 'salary Delete' }));
    expect(screen.getByRole('button', { name: 'salary Yes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'salary No' })).toBeInTheDocument();
  });
});

/**
 * Render one vault-backed `cash-deduct` row against a lifecycle that keeps
 * republishing a fixed scan outcome, so a test can move the *document* (booking
 * watermark, end date) underneath a retained deferral or failure and assert what
 * the row derives. `booked` adds the matching run + withdrawal aggregate so the
 * watermark it sets is a real prior booking rather than a dangling stamp.
 */
async function renderRetainedScan(options: {
  order?: Partial<Record<string, unknown>>;
  booked?: { day: string; at: string };
  scan: Pick<StandingOrderMaterializationResult, 'today' | 'deferred' | 'failed'> &
    Partial<Pick<StandingOrderMaterializationResult, 'booked' | 'dropped'>>;
}): Promise<HTMLElement> {
  const fixture = await decryptClientMoneyFixture();
  const document = structuredClone(fixture.document);
  const booked = options.booked;
  document.entities.standingOrder = [
    vaultStandingOrder(VAULT_INSUFFICIENT_ID, {
      kind: 'cash-deduct',
      label: 'Rent',
      ...(booked === undefined
        ? {}
        : { lastRunAt: booked.at, lastPeriodKey: booked.day, updatedAt: booked.at }),
      ...options.order,
    }),
  ];
  if (booked !== undefined) {
    const runId = await standingOrderOccurrenceId(VAULT_INSUFFICIENT_ID, booked.day);
    document.entities.standingOrderRun = [
      ...(document.entities.standingOrderRun ?? []),
      vaultStandingOrderRun(runId, VAULT_INSUFFICIENT_ID, booked.day, booked.at),
    ];
    document.entities.cashMovement = [
      ...(document.entities.cashMovement ?? []),
      vaultStandingOrderWithdrawal(runId, '-1', booked.at),
    ];
  }

  const sync = createMutableTestSync(document, fixture.header);
  const store = createVaultPortfolioStore(sync, { now: () => VAULT_SCAN_AT });
  const market = createClientMoneyMarket().market;
  const lifecycle = createStandingOrderMaterializationLifecycle(sync, market, {
    store,
    retryCount: 0,
    materialize: async () => ({
      ok: true,
      value: { booked: [], skipped: [], dropped: [], ...options.scan },
    }),
  });
  const engine = createVaultMoneyEngine(sync, market, {
    now: () => Date.parse(VAULT_SCAN_AT),
    standingOrders: lifecycle,
  });

  // Proves the outcome really is published — otherwise a suppression assertion
  // below would pass for the trivial reason that no scan result exists at all.
  await expect(engine.afterUnlock()).resolves.toMatchObject({ ok: true, value: options.scan });
  renderVaultSection({ engine, sync, store });

  return waitFor(() => documentElementById(`standing-order-${VAULT_INSUFFICIENT_ID}`));
}

function vaultStandingOrder(id: string, overrides: Partial<Record<string, unknown>>): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: '2026-07-01T08:00:00.000Z',
    editedBy: CLIENT_MONEY_IDS.device,
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
      startDate: '2026-07-01',
      endDate: null,
      status: 'active',
      lastRunAt: null,
      lastPeriodKey: null,
      createdAt: '2026-07-01T08:00:00.000Z',
      updatedAt: '2026-07-01T08:00:00.000Z',
      ...overrides,
    },
  };
}

function vaultStandingOrderRun(
  id: string,
  standingOrderId: string,
  periodKey: string,
  bookedAt: string,
): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: bookedAt,
    editedBy: CLIENT_MONEY_IDS.device,
    deletedAt: null,
    data: { standingOrderId, periodKey, bookedAt },
  };
}

function vaultStandingOrderWithdrawal(
  id: string,
  amountEur: string,
  executedAt: string,
): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: executedAt,
    editedBy: CLIENT_MONEY_IDS.device,
    deletedAt: null,
    data: {
      portfolioId: CLIENT_MONEY_IDS.portfolio,
      sourceId: CLIENT_MONEY_IDS.cashSource,
      kind: 'withdrawal',
      amountEur,
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      executedAt,
      note: 'Rent',
      source: 'standing-order',
      dedupHash: null,
      originalCurrency: null,
      createdAt: executedAt,
    },
  };
}

function vaultOversoldTransaction(id: string): VaultEntity {
  return {
    id,
    rev: 0,
    editedAt: '2026-07-27T00:00:00.000Z',
    editedBy: CLIENT_MONEY_IDS.device,
    deletedAt: null,
    data: {
      portfolioId: CLIENT_MONEY_IDS.portfolio,
      assetId: CLIENT_MONEY_IDS.usdAsset,
      side: 'sell',
      quantity: '1000',
      price: '50',
      fee: '0',
      executedAt: '2026-07-27T00:00:00.000Z',
      note: null,
      taxMode: null,
      taxCountry: null,
      taxAmountEur: null,
      taxParams: null,
      allowUncovered: false,
      uncoveredEntryPrice: null,
      source: 'manual',
    },
  };
}

function documentElementById(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Expected an element with id ${id}.`);
  return element;
}
