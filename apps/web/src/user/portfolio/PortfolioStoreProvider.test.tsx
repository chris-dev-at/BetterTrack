import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
}));
vi.mock('../../lib/standingOrdersApi', () => ({}));

import type { VaultDocument, VaultEntity } from '@bettertrack/contracts';
import type { Holding } from '@bettertrack/domain/holdings';

import * as portfolioApi from '../../lib/portfolioApi';
import { apiPortfolioStore } from '../../lib/portfolioStore';
import type { ClientPortfolioDerivation } from '../vault/engine/types';
import type { VaultMoneySession } from '../vault/engine/VaultMoneyEngineContext';
import { createParanoidAppPortfolioStore } from '../vault/engine/paranoidPortfolioStore';
import { PortfolioStoreProvider, usePortfolioStore } from './PortfolioStoreProvider';

function Probe() {
  const store = usePortfolioStore();
  return (
    <button
      type="button"
      onClick={() => {
        void store.listPortfolios().then((result) => {
          document.body.dataset.portfolioSource = result.portfolios[0]?.name ?? 'empty';
        });
      }}
    >
      Read portfolios
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  delete document.body.dataset.portfolioSource;
});

test('normal mode preserves endpoint behavior through apiPortfolioStore', async () => {
  vi.mocked(portfolioApi.listPortfolios).mockResolvedValue({
    portfolios: [summary('Normal API')],
  });
  const user = userEvent.setup();
  render(
    <PortfolioStoreProvider>
      <Probe />
    </PortfolioStoreProvider>,
  );

  await user.click(screen.getByRole('button', { name: 'Read portfolios' }));

  await vi.waitFor(() => expect(document.body.dataset.portfolioSource).toBe('Normal API'));
  expect(portfolioApi.listPortfolios).toHaveBeenCalledOnce();
});

test('the account-mode provider selects the unlocked vault adapter without mounting an API read', async () => {
  const vaultList = vi.fn(async () => ({ portfolios: [summary('Encrypted vault')] }));
  const user = userEvent.setup();
  render(
    <PortfolioStoreProvider store={{ ...apiPortfolioStore, listPortfolios: vaultList }}>
      <Probe />
    </PortfolioStoreProvider>,
  );

  await user.click(screen.getByRole('button', { name: 'Read portfolios' }));

  await vi.waitFor(() => expect(document.body.dataset.portfolioSource).toBe('Encrypted vault'));
  expect(vaultList).toHaveBeenCalledOnce();
  expect(portfolioApi.listPortfolios).not.toHaveBeenCalled();
});

test('the day-change percent counts only holdings that actually have a day move', async () => {
  // A €100,000 house (custom asset, no previous close) beside €10,000 of stock
  // that gained €100 today. The header must read +1,01 % (100 / 9,900), exactly
  // like the server's computeTotals — not 100 / 110,000.
  const store = createParanoidAppPortfolioStore(
    session([
      holding(STOCK_ID, { marketValueEur: 10_000, costBasisEur: 8_000, dayChangeEur: 100 }),
      holding(HOUSE_ID, { marketValueEur: 100_000, costBasisEur: 100_000, dayChangeEur: null }),
    ]),
  );

  const response = await store.getPortfolio(PORTFOLIO_ID);

  expect(response.totals.dayChangeEur).toBe(100);
  expect(response.totals.dayChangePct).toBeCloseTo((100 / 9_900) * 100, 10);
  expect(response.totals.marketValueEur).toBe(110_000);
});

test('the day-change percent is null when no holding has a previous close', async () => {
  const store = createParanoidAppPortfolioStore(
    session([
      holding(HOUSE_ID, { marketValueEur: 100_000, costBasisEur: 100_000, dayChangeEur: null }),
    ]),
  );

  const response = await store.getPortfolio(PORTFOLIO_ID);

  expect(response.totals.dayChangeEur).toBe(0);
  expect(response.totals.dayChangePct).toBeNull();
  expect(response.totals.unrealizedPnlPct).toBe(0);
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = '018f0000-0000-7000-8000-000000000001';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000010';
const STOCK_ID = '018f0000-0000-7000-8000-000000000020';
const HOUSE_ID = '018f0000-0000-7000-8000-000000000021';

function summary(name: string) {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    name,
    visibility: 'private' as const,
    sortOrder: 0,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
  };
}

function holding(assetId: string, values: Partial<Holding>): Holding {
  return {
    assetId,
    currency: 'EUR',
    quantity: 1,
    avgCost: 0,
    realizedPnl: 0,
    price: 1,
    marketValueEur: 0,
    costBasisEur: 0,
    unrealizedPnlEur:
      (values.marketValueEur ?? 0) - (values.costBasisEur ?? 0) || (values.unrealizedPnlEur ?? 0),
    unrealizedPnlPct: null,
    dayChangeEur: null,
    dayChangePct: null,
    ...values,
  };
}

function entity(id: string, data: Record<string, unknown>): VaultEntity {
  return {
    id,
    rev: 1,
    editedAt: '2026-07-30T10:00:00.000Z',
    editedBy: '018f0000-0000-7000-8000-0000000000ff',
    deletedAt: null,
    data,
  };
}

function vaultDocument(): VaultDocument {
  return {
    schemaVersion: 1,
    entities: {
      portfolio: [
        entity(PORTFOLIO_ID, {
          userId: USER_ID,
          name: 'Main',
          visibility: 'private',
          sortOrder: 0,
          defaultPayFromCash: false,
          archivedAt: null,
        }),
      ],
      customAsset: [
        entity(STOCK_ID, {
          providerId: 'yahoo',
          providerRef: 'ACME',
          ownerId: null,
          type: 'stock',
          symbol: 'ACME',
          name: 'Acme',
          exchange: 'XETRA',
          currency: 'EUR',
          meta: null,
          searchText: 'ACME Acme',
        }),
        entity(HOUSE_ID, {
          providerId: 'manual',
          providerRef: 'HOUSE',
          ownerId: USER_ID,
          type: 'custom',
          symbol: 'HOUSE',
          name: 'House',
          exchange: null,
          currency: 'EUR',
          meta: { category: 'real_estate', smoothing: false },
          searchText: 'HOUSE House',
        }),
      ],
    },
    mergeLog: [],
  };
}

/** The narrow slice of the money session `portfolioResponse` actually reads. */
function session(holdings: Holding[]): VaultMoneySession {
  const derivation: ClientPortfolioDerivation = {
    ownerUserId: USER_ID,
    vaultKeyId: '018f0000-0000-7000-8000-0000000000aa',
    portfolioId: PORTFOLIO_ID,
    vaultVersion: 1,
    writeId: '018f0000-0000-7000-8000-0000000000ab',
    assetPriceWatermark: '2026-07-30T10:00:00.000Z',
    range: '1D',
    baseCurrency: 'EUR',
    holdings,
    holdingsValueEur: holdings.reduce((sum, row) => sum + (row.marketValueEur ?? 0), 0),
    cashBalanceEur: 0,
    totalValueEur: holdings.reduce((sum, row) => sum + (row.marketValueEur ?? 0), 0),
    allocation: [],
    cashSources: [],
    series: [],
    stats: null,
    freshness: 'fresh',
    missingAssetIds: [],
  };
  return {
    engine: {
      onAppOpen: vi.fn(),
      afterUnlock: vi.fn(),
      derivePortfolio: vi.fn(async () => ({ ok: true as const, value: derivation })),
      deriveTaxReport: vi.fn(),
      clearCache: vi.fn(),
    },
    sync: { state: { status: 'synced', active: { document: vaultDocument() }, pending: null } },
    store: {},
  } as unknown as VaultMoneySession;
}
