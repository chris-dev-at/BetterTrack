import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { PortfolioResponse, PortfolioSummary } from '@bettertrack/contracts';

/**
 * THE FENCE FOR ONE BUG CLASS (#1981, §6.16).
 *
 * `createVaultedPortfolioRouteGuard` refuses any request whose path, query or
 * body carries a vaulted portfolio's id — 403 VAULTED_PORTFOLIO, doubled by
 * `apiRetryPolicy`, swallowed by whatever asked. So a surface rendered inside
 * an unlocked vault portfolio that talks to the server ABOUT that portfolio is
 * never a working surface; it is the "call it and catch the refusal" pattern
 * `PortfolioStoreProvider` exists to replace (#1416, paranoid-UX failure map
 * #7). #1898 shipped exactly one of these (the dividend roll-ups, scoped to the
 * portfolio and therefore doomed on a vaulted one) and #1976 gated it; this
 * file is the regression fence for the whole class rather than for that block.
 */

// ─── The seam under test ──────────────────────────────────────────────────────

/**
 * `apiRequest` is the single fetch chokepoint of the web app
 * (`lib/apiClient.ts`), so every `lib/*Api` module — and therefore every
 * `useQuery`/`useMutation` that reaches the server — passes through this one
 * spy. NOTHING below stubs an api module: a stubbed module never reaches the
 * chokepoint, and a fence that mocks away the thing it is fencing proves
 * nothing. (That is also why this lives beside `UnlockedVaultPortfolioPage.test.tsx`
 * instead of inside it — that file stubs `portfolioApi` and `marketIntelApi` to
 * keep its rendering assertions inert, which is the opposite of what is needed
 * here.)
 */
const apiMocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('../../lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/apiClient')>()),
  apiRequest: apiMocks.apiRequest,
}));

/**
 * Deploy capabilities fail CLOSED until the `/feature-flags` bootstrap answers
 * (`NO_CAPABILITIES`), and this harness never resolves it — so every
 * capability-gated block would stay silent for a reason that has nothing to do
 * with the vault, and "no request was made" would be vacuously true (the #1976
 * reviewer's finding). Force the whole map ON: the only thing that may keep a
 * block quiet here is the portfolio-store capability under test.
 */
vi.mock('../../lib/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/featureFlags')>();
  const everyCapability = Object.fromEntries(
    Object.keys(actual.NO_CAPABILITIES).map((key) => [key, true]),
  ) as typeof actual.NO_CAPABILITIES;
  return {
    ...actual,
    useDeployCapabilities: () => everyCapability,
    useDeployCapability: () => true,
  };
});

// The identity seam (`useUnlockedPortfolioNames`) resolves through the
// keystore and the resolver; substituting it keeps this file about requests.
const storeMocks = vi.hoisted(() => ({ useVaultedPortfolioStores: vi.fn() }));
vi.mock('../vault/useVaultedPortfolioStores', () => ({
  useVaultedPortfolioStores: storeMocks.useVaultedPortfolioStores,
}));

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

import { ApiError } from '../../lib/apiClient';
import { getPortfolioDividendCalendarFor } from '../../lib/marketIntelApi';
import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import { SECTION_NAV } from '../components/sectionNav';
import { waitForColdStart } from '../../test/waitForColdStart';
import type { UnlockedVaultPortfolioAccess } from '../vault/resolvedPortfolioStore';
import { PortfolioPage } from './PortfolioPage';
import { PortfolioStoreProvider } from './PortfolioStoreProvider';
import { PortfolioWorkspace } from './PortfolioWorkspace';
import {
  RESOLVED_VAULT_STORE_CAPABILITIES,
  UnlockedVaultPortfolio,
} from './UnlockedVaultPortfolio';
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

const PORTFOLIO: PortfolioResponse = {
  baseCurrency: 'EUR',
  holdings: [
    {
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
    },
  ],
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

/** The refusal every row operation of a resolver-backed store answers with. */
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

// ─── Reading the chokepoint ───────────────────────────────────────────────────

interface RecordedRequest {
  path: string;
  method: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

const recorded: RecordedRequest[] = [];

/**
 * Whether a recorded request hands the server this portfolio's id — the exact
 * question `vaultedPortfolioTargetForRequest` asks on the way in
 * (`apps/api/src/services/account/vaultedPortfolioEnforcement.ts`). It reads the
 * path, the query AND the body, so this reads all three rather than the URL
 * alone: a `POST` whose body carries `{ portfolioId }` 403s exactly like a
 * `GET /portfolios/:id`.
 */
function carriesPortfolioId(request: RecordedRequest): boolean {
  return [request.path, JSON.stringify(request.query ?? null), JSON.stringify(request.body ?? null)]
    .join(' ')
    .includes(PORTFOLIO_ID);
}

/**
 * The server's own exit door. `VAULTED_PORTFOLIO_TRANSITION_CARVEOUT_REGISTRY`
 * exempts these five operations beneath `/portfolios/:id/vault` and nothing
 * else, because the move-in/move-out transition HAS to name the portfolio it is
 * moving. Mirroring the carve-out keeps this fence from one day failing on the
 * one request that legitimately leaves the vault.
 */
const TRANSITION_CARVEOUT = new RegExp(
  `^/portfolios/${PORTFOLIO_ID}/vault/(revision|lifecycle|move-in|move-out|move-out/challenge)$`,
);

function isTransitionCarveout(request: RecordedRequest): boolean {
  return TRANSITION_CARVEOUT.test(request.path.split('?')[0]!);
}

function violations(): RecordedRequest[] {
  return recorded.filter(
    (request) => carriesPortfolioId(request) && !isTransitionCarveout(request),
  );
}

// ─── Harnesses ────────────────────────────────────────────────────────────────

/**
 * The composition `PortfolioWorkspace` mounts for an unlocked vaulted portfolio.
 *
 * `capabilityOverride` re-declares the store binding INSIDE the wrapper, with
 * the wrapper's own store and cache scope, so a case can move one capability
 * and leave the rest of the real composition alone.
 */
function renderUnlocked(
  access: UnlockedVaultPortfolioAccess,
  capabilityOverride?: Partial<typeof RESOLVED_VAULT_STORE_CAPABILITIES>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page =
    capabilityOverride === undefined ? (
      <PortfolioPage />
    ) : (
      <PortfolioStoreProvider
        capabilities={{ ...RESOLVED_VAULT_STORE_CAPABILITIES, ...capabilityOverride }}
        scope={[{ vaultAccess: access.accessId }]}
        store={access.store}
      >
        <PortfolioPage />
      </PortfolioStoreProvider>
    );
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/portfolio?portfolio=${PORTFOLIO_ID}`]}>
        <UnlockedVaultPortfolio access={access} portfolio={STUB}>
          {page}
        </UnlockedVaultPortfolio>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The workspace itself, with a sentinel standing in for every routed page, so
 * "which pages mount inside the vault subtree" is a rendered fact rather than a
 * claim.
 */
function renderWorkspaceAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`${path}?portfolio=${PORTFOLIO_ID}`]}>
        <PortfolioStoreProvider
          store={{ ...apiPortfolioStore, listPortfolios: async () => ({ portfolios: [STUB] }) }}
        >
          <Routes>
            <Route element={<PortfolioWorkspace />}>
              <Route element={<div data-testid="routed-page" />} path="/portfolio" />
              <Route element={<div data-testid="routed-page" />} path="/portfolio/*" />
            </Route>
          </Routes>
        </PortfolioStoreProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  recorded.length = 0;
  storeMocks.useVaultedPortfolioStores.mockReturnValue({
    unlocked: new Map([[PORTFOLIO_ID, liveAccess('vault-access-workspace')]]),
    failures: new Map(),
  });
  apiMocks.apiRequest.mockImplementation(
    async (
      path: string,
      options?: { method?: string; query?: Record<string, unknown>; body?: unknown },
    ) => {
      recorded.push({
        path,
        method: options?.method ?? 'GET',
        query: options?.query,
        body: options?.body,
      });
      // Answer the way the guard answers a vaulted id, and the way an
      // unreachable server answers everything else — so a surface that DOES ask
      // travels its real failure path instead of a fabricated success.
      throw path.includes(PORTFOLIO_ID)
        ? new ApiError(403, 'VAULTED_PORTFOLIO', 'This portfolio is sealed in a vault.')
        : new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server.');
    },
  );
});

// ─── The fence ────────────────────────────────────────────────────────────────

describe('what an unlocked vault portfolio may send to the server (§6.16, #1981)', () => {
  test('mounts the whole overview without handing the server its portfolio id', async () => {
    renderUnlocked(liveAccess('vault-access-fence'));

    // Settle the page's own cascade first, so "nothing asked" is a settled fact
    // and not a race against a query that has yet to start.
    expect(await waitForColdStart(() => screen.getAllByText(NET_WORTH))).not.toHaveLength(0);

    expect(violations()).toEqual([]);
  });

  /**
   * ANTI-VACUITY. A "no call was made" assertion passes just as well against a
   * dead spy, a renamed chokepoint or a page that never mounted, so the
   * detector is made to fire here on a request the page is forbidden to make —
   * the very pair #1898 introduced and #1976 gated. Proven the other way round
   * too: with `serverReadable` in `DividendIntelSection` forced back to `true`
   * at the parent commit, the case above fails with both roll-ups listed.
   */
  test('and the fence really can see such a request when one is made', async () => {
    renderUnlocked(liveAccess('vault-access-control'));
    expect(await waitForColdStart(() => screen.getAllByText(NET_WORTH))).not.toHaveLength(0);
    expect(violations()).toEqual([]);

    await expect(getPortfolioDividendCalendarFor(PORTFOLIO_ID)).rejects.toMatchObject({
      code: 'VAULTED_PORTFOLIO',
    });

    expect(violations().map((request) => request.path)).toEqual([
      `/assets/portfolio/dividend-calendar?portfolioId=${PORTFOLIO_ID}`,
    ]);
  });

  /**
   * The gate this fence protects must not hang off `rowReads`. That flag is
   * about what the CLIENT store can project out of its authenticated document,
   * and since #1532 the resolver-backed store serves the whole row set — so the
   * day `RESOLVED_VAULT_STORE_CAPABILITIES` is corrected to say so, a gate
   * written on `rowReads` would put the doomed roll-ups straight back on the
   * wire. This case moves exactly that flag and nothing else.
   *
   * RED at the parent commit, where `DividendIntelSection` read `rowReads`.
   */
  test('stays silent even when the store declares its client row reads readable', async () => {
    renderUnlocked(liveAccess('vault-access-rowreads'), { rowReads: true });

    expect(await waitForColdStart(() => screen.getAllByText(NET_WORTH))).not.toHaveLength(0);

    expect(violations()).toEqual([]);
  });
});

// ─── What the fence above covers ──────────────────────────────────────────────

/**
 * The fence mounts ONE page, and that is only enough because the workspace
 * mounts only that one: for a vaulted portfolio `PortfolioWorkspace` collapses
 * the tab strip to Overview and renders no `Outlet` anywhere else, so the
 * overview IS the vault subtree today.
 *
 * These cases hold that claim to the rendered tree. When §6.16 routing lands a
 * tab back — `CashMovementsPage` first (#2006, whose ledger read still goes
 * straight to `portfolioApi`) — the matching case here fails, and that failure
 * is the instruction: the page that starts mounting has to be added to the
 * fence above at the same time, not after the next 403 is noticed in a log.
 */
describe('the surface the fence covers is the whole vault subtree', () => {
  test('the overview does mount inside the unlocked vault wrapper', async () => {
    renderWorkspaceAt('/portfolio');

    expect(
      await waitForColdStart(() => screen.getByTestId('unlocked-vault-portfolio')),
    ).toBeTruthy();
    expect(screen.getByTestId('routed-page')).toBeInTheDocument();
  });

  const otherTabs = SECTION_NAV.portfolio.children
    .map((child) => child.to)
    .filter((to) => to !== '/portfolio');

  test.each(otherTabs)('%s mounts no page for a vaulted portfolio', async (path) => {
    renderWorkspaceAt(path);

    expect(
      await waitForColdStart(() => screen.getByTestId('unlocked-vault-portfolio')),
    ).toBeTruthy();
    expect(screen.queryByTestId('routed-page')).not.toBeInTheDocument();
    expect(violations()).toEqual([]);
  });
});
