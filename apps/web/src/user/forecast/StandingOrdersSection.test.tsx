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
import { createVaultMoneyEngine, moneyFailure } from '../vault/engine';
import { createParanoidAppPortfolioStore } from '../vault/engine/paranoidPortfolioStore';
import {
  VaultMoneyEngineContext,
  type VaultMoneySession,
} from '../vault/engine/VaultMoneyEngineContext';
import { createStandingOrderMaterializationLifecycle } from '../vault/standingOrders/lifecycle';
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

  test('shows only affected vault rows after a scan and clears a quote notice after recovery', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    document.entities.standingOrder = [
      vaultStandingOrder(VAULT_QUOTE_DEFERRED_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.eurAsset,
        label: 'Deferred quote',
      }),
      vaultStandingOrder(VAULT_FAILED_ID, {
        kind: 'buy-asset',
        assetId: CLIENT_MONEY_IDS.usdAsset,
        label: 'Corrupt order',
      }),
      vaultStandingOrder(VAULT_BOOKED_ID, { label: 'Salary' }),
      vaultStandingOrder(VAULT_PAUSED_ID, { label: 'Paused', status: 'paused' }),
      vaultStandingOrder(VAULT_FUTURE_ID, {
        label: 'Tomorrow',
        startDate: '2026-07-28',
      }),
    ];
    const sync = createMutableTestSync(document, fixture.header);
    const store = createVaultPortfolioStore(sync, { now: () => VAULT_SCAN_AT });
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
        if (assetId === CLIENT_MONEY_IDS.usdAsset) {
          throw moneyFailure('VAULT_CORRUPT', 'The test order is deliberately corrupt.');
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
    expect(
      within(deferredRow).getByText('Not booked — quote unavailable since 27.07.2026'),
    ).toBeInTheDocument();
    expect(
      within(failedRow).getByText('Not booked — booking error since 27.07.2026'),
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
    expect(within(failedRow).getByText(/^Not booked — booking error/)).toBeInTheDocument();
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

function documentElementById(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Expected an element with id ${id}.`);
  return element;
}
