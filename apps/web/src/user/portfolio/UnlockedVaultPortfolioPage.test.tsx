import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { PortfolioResponse, PortfolioSummary } from '@bettertrack/contracts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Server probes the overview mounts for a NORMAL-mode account (a per-portfolio
// vault does not flip the account mode): kept inert so nothing here reaches the
// network and every assertion below is about the vault store alone.
vi.mock('../../lib/portfolioApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/portfolioApi')>()),
  getRecategorizationStatus: vi.fn(async () => ({ pending: 0 })),
  dismissRecategorization: vi.fn(async () => undefined),
}));
vi.mock('../../lib/marketIntelApi', () => ({
  PORTFOLIO_DIVIDEND_CALENDAR_QUERY_KEY: ['portfolio', 'dividend-calendar'],
  PORTFOLIO_DIVIDEND_PROJECTION_QUERY_KEY: ['portfolio', 'dividend-projection'],
  getPortfolioDividendCalendar: vi.fn(async () => ({ entries: [] })),
  getPortfolioDividendProjection: vi.fn(async () => ({ perPortfolio: [], totalEur: 0 })),
}));
vi.mock('../../lib/searchApi', () => ({ searchAssets: vi.fn() }));

const chartMocks = vi.hoisted(() => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
    applyOptions: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    subscribeCrosshairMove: vi.fn(),
    remove: vi.fn(),
  })),
}));
vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  AreaSeries: 'AreaSeries',
  BaselineSeries: 'BaselineSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            width: 200,
            height: 200,
          })
        : children,
  };
});

// The identity seam (`useUnlockedPortfolioNames`) resolves through this hook;
// substituting it keeps the keystore, the resolver and the account context out
// of a test about what the page renders.
const storeMocks = vi.hoisted(() => ({ useVaultedPortfolioStores: vi.fn() }));
vi.mock('../vault/useVaultedPortfolioStores', () => ({
  useVaultedPortfolioStores: storeMocks.useVaultedPortfolioStores,
}));

import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import { waitForColdStart } from '../../test/waitForColdStart';
import { createUnlockedVaultPortfolioAccess } from '../vault/resolvedPortfolioStore';
import type { UnlockedVaultPortfolioAccess } from '../vault/resolvedPortfolioStore';
import type { UnlockedVaultPortfolioStoreResolution } from '../vault/portfolioStoreResolver';
import { PortfolioPage } from './PortfolioPage';
import { UnlockedVaultPortfolio } from './UnlockedVaultPortfolio';
import type { PortfolioVaultStub } from './lockedPortfolio';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000101';
const VAULT_ID = '018f0000-0000-7000-8000-000000000201';

/** Exactly what the server serves for a vaulted row: an alias and a sentinel. */
const STUB = {
  id: PORTFOLIO_ID,
  name: `__vaulted_portfolio__:${PORTFOLIO_ID}`,
  visibility: 'private' as const,
  sortOrder: 0,
  isDefault: false,
  defaultPayFromCash: false,
  archivedAt: null,
  vaultId: VAULT_ID,
  vaultAlias: 'Private Holdings',
} as PortfolioVaultStub;

/** The decrypted row the resolution carries — the TRUE name. */
const DECRYPTED: PortfolioSummary = { ...STUB, name: 'Vault Test PF' };

const HOLDING = {
  asset: {
    id: '018f0000-0000-7000-8000-000000000301',
    symbol: 'MSFT',
    name: 'Microsoft Corporation',
    exchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock' as const,
    isCustom: false,
  },
  quantity: 5,
  avgCost: 320.2,
  realizedPnl: 0,
  price: 513.53,
  marketValueEur: 4147.19,
  costBasisEur: 2288.42,
  unrealizedPnlEur: 1858.77,
  unrealizedPnlPct: 81.23,
  dayChangeEur: 67.48,
  dayChangePct: 1.65,
};

const PORTFOLIO: PortfolioResponse = {
  baseCurrency: 'EUR',
  holdings: [HOLDING],
  totals: {
    marketValueEur: 4147.19,
    investedEur: 2288.42,
    unrealizedPnlEur: 1858.77,
    unrealizedPnlPct: 81.23,
    dayChangeEur: 67.48,
    dayChangePct: 1.65,
    cashEur: 0,
    totalValueEur: 4147.19,
  },
};

/** The rendered net worth, in the app's number format. */
const NET_WORTH = '4.147,19 €';

const HISTORY = {
  range: '1M' as const,
  interval: '1d' as const,
  baseCurrency: 'EUR' as const,
  points: [{ date: '2026-08-01', valueEur: 4000 }],
  performance: [{ date: '2026-08-01', pct: 0 }],
};

/**
 * The refusal every row operation of a resolver-backed store answers with
 * (`resolvedPortfolioStore.refusingRowStore`) — refused BY DESIGN, not failed.
 */
function refuse(operation: string): never {
  throw new Error(`"${operation}" is not available from a resolver-backed vault portfolio store.`);
}

/** A live per-portfolio access: derivations answer, every row operation refuses. */
function liveAccess(accessId: string): UnlockedVaultPortfolioAccess {
  const store: PortfolioStore = {
    ...apiPortfolioStore,
    listPortfolios: async () => ({ portfolios: [STUB] }),
    getPortfolio: async () => PORTFOLIO,
    getPortfolioHistory: async () => HISTORY,
    listTransactions: async () => refuse('listTransactions'),
    listCashSources: async () => refuse('listCashSources'),
  };
  return {
    accessId,
    portfolioId: PORTFOLIO_ID,
    vaultId: VAULT_ID,
    portfolio: DECRYPTED,
    store,
    isCurrent: () => true,
    readTotals: async () => ({ totals: PORTFOLIO.totals, snapshotId: 'snapshot-1' }),
    dispose: () => undefined,
  };
}

/**
 * A DISPOSED access, built through the real factory over a real resolution
 * whose document snapshot has gone — the exact shape the registry leaves behind
 * when the vault-opened edge fires: `entry.batch?.dispose()`, the in-flight
 * `getPortfolio` on the old access then finds `documentSnapshot() === null` and
 * the composition rejects with VAULT_DATA_UNAVAILABLE.
 *
 * Only `engine.derivePortfolio` and `documentSnapshot` sit on the path under
 * test, so the resolution is narrowed to those; the cast says so once here
 * instead of building a decrypted document set the rejection never reaches.
 */
function disposedAccess(): UnlockedVaultPortfolioAccess {
  const resolution = {
    kind: 'vaulted-unlocked',
    portfolio: DECRYPTED,
    vault: { id: VAULT_ID },
    // Content identity of the opened documents. Deliberately CONSTANT across
    // both accesses in the recovery test below: two resolutions of the same
    // unchanged documents really do produce the same `snapshotId`, which is why
    // the cache scope keys on the access instance instead.
    snapshotId: 'vault-document-set:constant',
    engine: {
      derivePortfolio: async () => ({
        ok: true,
        value: {
          portfolioId: PORTFOLIO_ID,
          range: '1D',
          baseCurrency: 'EUR',
          holdings: [],
          holdingsValueEur: 0,
          cashBalanceEur: 0,
          totalValueEur: 0,
          series: [],
        },
      }),
    },
    documentSnapshot: () => null,
    dispose: () => undefined,
  } as unknown as UnlockedVaultPortfolioStoreResolution;

  const access = createUnlockedVaultPortfolioAccess(resolution, {
    plainStore: { ...apiPortfolioStore, listPortfolios: async () => ({ portfolios: [STUB] }) },
  });
  return access;
}

// ─── Harness ──────────────────────────────────────────────────────────────────

/**
 * Every case here mounts the whole of `PortfolioPage` behind the vault wrapper,
 * so the first thing each one waits for is that page's initial query cascade
 * settling — overview, history and the market-intel reads — not an interaction.
 * That is what `waitForColdStart` is for (see `src/test/setup.ts`): on a loaded
 * CI runner the cascade crosses Testing Library's 1 s default and the page is
 * still painting skeletons when the wait expires. The waits that follow a
 * settled render — the negative ones, and anything after a swap has already
 * been observed — deliberately keep the short default so a real regression
 * still fails fast.
 */
function renderUnlocked(access: UnlockedVaultPortfolioAccess) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (current: UnlockedVaultPortfolioAccess) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/portfolio?portfolio=${PORTFOLIO_ID}`]}>
        <UnlockedVaultPortfolio access={current} portfolio={STUB}>
          <PortfolioPage />
        </UnlockedVaultPortfolio>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(access));
  return {
    ...view,
    client,
    swapAccess: (next: UnlockedVaultPortfolioAccess) => view.rerender(tree(next)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  storeMocks.useVaultedPortfolioStores.mockReturnValue({ unlocked: new Map() });
});

// ─── The disposed-access rejection (failure map #1) ───────────────────────────

describe('an unlocked vault portfolio whose access was swapped underneath it', () => {
  test('the disposed access really does reject its portfolio read', async () => {
    // RED-FIRST ANCHOR. Everything below depends on this rejection being the
    // real one rather than a hand-thrown error: it comes out of the shipped
    // composition (`createParanoidAppPortfolioStore` → `portfolioResponse`)
    // because the resolution's document is gone.
    await expect(disposedAccess().store.getPortfolio(PORTFOLIO_ID)).rejects.toMatchObject({
      failure: { code: 'VAULT_DATA_UNAVAILABLE' },
    });
  });

  test('two accesses over the SAME documents are still two distinct cache scopes', () => {
    // The trap the fix is built around: `snapshotId` is derived from the
    // document set, so a dispose-and-re-resolve over unchanged documents
    // produces the SAME snapshot id. Keying the cache on it would leave the
    // dead access's rejection sitting under the live access's key.
    const first = disposedAccess();
    const second = disposedAccess();
    expect(first.accessId).not.toBe(second.accessId);
  });

  test('the fresh access renders its figures instead of inheriting a dead one’s error', async () => {
    const { swapAccess } = renderUnlocked(disposedAccess());

    // The dead access states its failure, because for THAT access it is true.
    expect(await waitForColdStart(() => screen.getByRole('alert'))).toHaveTextContent(
      /could not be read from its vault/i,
    );

    // The registry re-resolved; the live store is mounted under the same
    // portfolio id, and the page must start clean rather than repaint the
    // rejection the disposed one cached.
    swapAccess(liveAccess('vault-access-live'));

    expect(await waitForColdStart(() => screen.getAllByText(NET_WORTH))).not.toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  test('never tells a vaulted portfolio to refresh the page', async () => {
    // A reload destroys the endpoint unlock session (it is memory-only), so the
    // generic copy's advice is the one action that makes this worse.
    renderUnlocked(disposedAccess());

    const alert = await waitForColdStart(() => screen.getByRole('alert'));
    expect(alert).not.toHaveTextContent(/refresh/i);
    expect(alert).toHaveTextContent(/the vault stays open on this device/i);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

// ─── Write affordances and refused-by-design reads (failure map #7) ───────────

describe('an unlocked vault portfolio the resolver-backed store cannot write', () => {
  test('offers no write it can only refuse, and announces no unavailability', async () => {
    renderUnlocked(liveAccess('vault-access-1'));

    expect(await waitForColdStart(() => screen.getAllByText(NET_WORTH))).not.toHaveLength(0);

    for (const name of ['+ Transaction', '+ Custom investment', '+ Deposit', '− Withdraw']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // The refused row reads are not an outage and not news: the permanent
    // "This information isn't available." above NET WORTH is gone.
    await waitFor(() =>
      expect(screen.queryByText("This information isn't available.")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('keeps the read half of the overview intact', async () => {
    renderUnlocked(liveAccess('vault-access-2'));

    // Hiding the writes must not cost the surface anything it can answer.
    expect(await waitForColdStart(() => screen.getAllByText(NET_WORTH))).not.toHaveLength(0);
    expect(screen.getByText('2.288,42 €')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Value over time' })).toBeInTheDocument();
  });
});

// ─── Identity (failure map #6) ────────────────────────────────────────────────

describe('the name an unlocked vault portfolio is given', () => {
  test('never prints the server sentinel, with or without the decrypted name', async () => {
    const access = liveAccess('vault-access-3');
    storeMocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[PORTFOLIO_ID, access]]),
    });
    const { container } = renderUnlocked(access);

    expect(await waitForColdStart(() => screen.getAllByText(NET_WORTH))).not.toHaveLength(0);
    expect(container.textContent).not.toContain('__vaulted_portfolio__');
  });
});
