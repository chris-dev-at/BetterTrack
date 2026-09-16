import { webcrypto } from 'node:crypto';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  CashMovementsResponse,
  PortfolioListResponse,
  VaultDocument,
  VaultEntity,
} from '@bettertrack/contracts';

/**
 * WHICH STORE SERVES THE PRIMARY LEDGER (#2006, §6.16).
 *
 * `CashMovementsPage` read `getCashMovements` straight off `portfolioApi` while
 * `useActivePortfolio` next to it already resolved the roster through
 * `usePortfolioStore()`. For a VAULTED portfolio that split is fatal, not
 * cosmetic: the server holds no rows for it, and
 * `createVaultedPortfolioRouteGuard` reads the portfolio id off the path and
 * answers 403 VAULTED_PORTFOLIO — so the ledger came back empty, the source
 * facet #1658 added never arrived, and the page fired a doomed request per
 * mount. This file pins the read to the store seam from both sides: the vault
 * twin answers a vaulted portfolio locally and sends the server nothing about
 * it, and the account-level store still puts the byte-identical request on the
 * wire.
 */

// ─── The chokepoint ───────────────────────────────────────────────────────────

/**
 * `apiRequest` is the single fetch chokepoint of the web app
 * (`lib/apiClient.ts`), so every `lib/*Api` module — and therefore every
 * `useQuery` that reaches the server — passes through this one spy. Nothing
 * here stubs `portfolioApi`: a stubbed module never reaches the chokepoint, and
 * a fence that mocks away the thing it is fencing proves nothing (the technique
 * is #2031's `UnlockedVaultPortfolioRequests.test.tsx`; the sibling
 * `CashMovementsPage.test.tsx` deliberately does the opposite, stubbing the api
 * module to keep its rendering assertions inert).
 */
const apiMocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('../../../lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/apiClient')>()),
  apiRequest: apiMocks.apiRequest,
}));

import { ApiError } from '../../../lib/apiClient';
import * as portfolioApi from '../../../lib/portfolioApi';
import {
  CLIENT_MONEY_IDS,
  createMutableTestSync,
  decryptClientMoneyFixture,
} from '../../vault/engine/clientMoney.testSupport';
import { createVaultPortfolioStore } from '../../vault/vaultPortfolioStore';
import type { PortfolioStore } from '../../../lib/portfolioStore';
import { PortfolioStoreProvider } from '../PortfolioStoreProvider';
import { waitForColdStart } from '../../../test/waitForColdStart';
import { CashMovementsPage } from './CashMovementsPage';

const VAULT_PORTFOLIO_ID = CLIENT_MONEY_IDS.portfolio;
const ACCOUNT_PORTFOLIO_ID = '018f0000-0000-7000-8000-0000000009a1';

interface RecordedRequest {
  path: string;
  method: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

const recorded: RecordedRequest[] = [];

/**
 * Whether a recorded request hands the server the VAULTED portfolio's id — the
 * exact question `vaultedPortfolioTargetForRequest` asks on the way in
 * (`apps/api/src/services/account/vaultedPortfolioEnforcement.ts`). It reads the
 * path, the query AND the body, so this reads all three: a `POST` whose body
 * carries `{ portfolioId }` 403s exactly like a `GET /portfolios/:id/cash`.
 */
function carriesVaultedId(request: RecordedRequest): boolean {
  return [request.path, JSON.stringify(request.query ?? null), JSON.stringify(request.body ?? null)]
    .join(' ')
    .includes(VAULT_PORTFOLIO_ID);
}

function violations(): RecordedRequest[] {
  return recorded.filter(carriesVaultedId);
}

/** Paths this test seeds an answer for; everything else travels its failure path. */
const answers = new Map<string, unknown>();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const IMPORTED_MOVEMENT_ID = '018f0000-0000-7000-8000-0000000009b1';

/**
 * One imported row on top of the fixture's hand-entered ledger, so the
 * portfolio-wide facet the twin computes has two entries and the page is
 * obliged to grow the picker (`showSourceFilter` needs more than one).
 */
function withImportedMovement(document: VaultDocument): VaultDocument {
  const next = structuredClone(document);
  const entity: VaultEntity = {
    id: IMPORTED_MOVEMENT_ID,
    rev: 0,
    editedAt: '2026-07-27T09:00:00.000Z',
    editedBy: CLIENT_MONEY_IDS.device,
    deletedAt: null,
    data: {
      portfolioId: VAULT_PORTFOLIO_ID,
      sourceId: CLIENT_MONEY_IDS.cashSource,
      kind: 'deposit',
      amountEur: '300',
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      executedAt: '2026-07-27T09:00:00.000Z',
      note: 'Flatex deposit',
      source: 'import:flatex',
      createdAt: '2026-07-27T09:00:00.000Z',
      dedupHash: null,
      originalCurrency: null,
    },
  };
  next.entities.cashMovement = [...(next.entities.cashMovement ?? []), entity];
  return next;
}

/** The refusal a store operation this page must never reach for answers with. */
function refuse(operation: string): never {
  throw new Error(`"${operation}" is not the ledger page's to call from a vault portfolio.`);
}

/**
 * The real vault twin, over the real encrypted fixture — not a hand-rolled
 * double, so the facet and the paging under test are the twin's own code.
 *
 * `VaultPortfolioStore` is a `PortfolioStore` minus the two DERIVED reads:
 * inside the real subtree `createParanoidAppPortfolioStore` answers
 * `getPortfolio`/`getPortfolioHistory` out of the client money engine, which
 * this file has no business standing up. They refuse loudly rather than
 * resolving to a stub, so a future edit that makes the ledger page reach for a
 * derivation says so in the failure instead of quietly passing over a fake.
 */
async function vaultTwinStore(): Promise<PortfolioStore> {
  const fixture = await decryptClientMoneyFixture();
  const sync = createMutableTestSync(withImportedMovement(fixture.document), fixture.header);
  return {
    ...createVaultPortfolioStore(sync),
    getPortfolio: () => refuse('getPortfolio'),
    getPortfolioHistory: () => refuse('getPortfolioHistory'),
  };
}

const ACCOUNT_ROSTER: PortfolioListResponse = {
  portfolios: [
    {
      id: ACCOUNT_PORTFOLIO_ID,
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const ACCOUNT_LEDGER: CashMovementsResponse = {
  balanceEur: 1_000,
  movements: [
    {
      id: '018f0000-0000-7000-8000-0000000009c1',
      kind: 'withdrawal',
      amountEur: -50,
      sourceId: '018f0000-0000-7000-8000-0000000009c2',
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      executedAt: '2026-07-10T00:00:00.000Z',
      note: 'Landlord',
      source: 'manual',
      createdAt: '2026-07-10T00:00:00.000Z',
      tags: [],
    },
  ],
  sources: [],
  nextCursor: null,
};

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderPage(portfolioId: string, store?: PortfolioStore) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/portfolio/cash/movements?portfolio=${portfolioId}`]}>
        {/*
         * The binding `UnlockedVaultPortfolio` installs for a per-portfolio
         * vault access: the resolver-backed store, its own cache scope, and no
         * writes or server row reads. Omitting `store` leaves the provider's
         * account-level default (`apiPortfolioStore`), which is what every
         * non-vaulted portfolio gets.
         */}
        {store === undefined ? (
          <CashMovementsPage />
        ) : (
          <PortfolioStoreProvider
            capabilities={{ writes: false, rowReads: false, serverPortfolioReads: false }}
            scope={[{ vaultAccess: 'vault-access-2006' }]}
            store={store}
          >
            <CashMovementsPage />
          </PortfolioStoreProvider>
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  vi.clearAllMocks();
  recorded.length = 0;
  answers.clear();
  answers.set('/cash/tags', { tags: [] });
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
      // Answer the way the guard answers a vaulted id, the way the server
      // answers a seeded path, and the way an unreachable server answers the
      // rest — so a surface that DOES ask travels its real failure path instead
      // of a fabricated success.
      if (path.includes(VAULT_PORTFOLIO_ID)) {
        throw new ApiError(403, 'VAULTED_PORTFOLIO', 'This portfolio is sealed in a vault.');
      }
      if (answers.has(path)) return answers.get(path);
      throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server.');
    },
  );
});

// ─── A vaulted portfolio ──────────────────────────────────────────────────────

describe('the primary ledger inside a vault portfolio (#2006, §6.16)', () => {
  test('renders the twin’s movements and never names the portfolio to the server', async () => {
    renderPage(VAULT_PORTFOLIO_ID, await vaultTwinStore());

    // The rows are the fixture's own ledger plus the imported row, decrypted
    // out of the vault document — nothing the server could have supplied.
    expect(await waitForColdStart(() => screen.getByText('Flatex deposit'))).toBeInTheDocument();
    expect(screen.getByText('initial cash')).toBeInTheDocument();
    expect(screen.getByText('quarterly dividend')).toBeInTheDocument();

    expect(violations()).toEqual([]);
    // Not vacuous: the page DID reach the chokepoint, for the one read that is
    // user-wide rather than portfolio-scoped (`GET /cash/tags`, which the guard
    // has no id to refuse).
    expect(recorded.map((request) => request.path)).toEqual(['/cash/tags']);
  });

  test('offers the twin’s portfolio-wide source facet as the picker', async () => {
    renderPage(VAULT_PORTFOLIO_ID, await vaultTwinStore());
    await waitForColdStart(() => screen.getByText('Flatex deposit'));

    const picker = screen.getByLabelText('Source');
    expect(within(picker).getByRole('option', { name: 'Imported · Flatex' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Manual entry' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'All sources' })).toBeInTheDocument();
  });

  test('filters on the twin, still without a request about the portfolio', async () => {
    const user = userEvent.setup();
    renderPage(VAULT_PORTFOLIO_ID, await vaultTwinStore());
    await waitForColdStart(() => screen.getByText('Flatex deposit'));

    await user.selectOptions(screen.getByLabelText('Source'), 'import:flatex');

    await waitForColdStart(() =>
      expect(screen.queryByText('initial cash')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Flatex deposit')).toBeInTheDocument();
    // The selection survives its own refetch: the facet is portfolio-wide, so
    // `import:flatex` stays a listed option even though the filtered page holds
    // only imported rows.
    expect(screen.getByLabelText('Source')).toHaveValue('import:flatex');
    expect(violations()).toEqual([]);
  });

  /**
   * ANTI-VACUITY. "No such request was made" passes just as well against a dead
   * spy, a renamed chokepoint or a page that never mounted, so the detector is
   * made to fire on the exact request this page used to make — a direct
   * `portfolioApi.getCashMovements` with the vaulted id, which is what the file
   * looked like before #2006.
   */
  test('and the fence really can see the read this page used to make', async () => {
    renderPage(VAULT_PORTFOLIO_ID, await vaultTwinStore());
    await waitForColdStart(() => screen.getByText('Flatex deposit'));
    expect(violations()).toEqual([]);

    await expect(
      portfolioApi.getCashMovements(VAULT_PORTFOLIO_ID, { includeSourceTags: true }),
    ).rejects.toMatchObject({ code: 'VAULTED_PORTFOLIO' });

    expect(violations().map((request) => request.path)).toEqual([
      `/portfolios/${VAULT_PORTFOLIO_ID}/cash`,
    ]);
  });
});

// ─── An account portfolio ─────────────────────────────────────────────────────

describe('the same page over the account store is unchanged on the wire', () => {
  test('still issues the #1658 first-page request, byte for byte', async () => {
    answers.set('/portfolios', ACCOUNT_ROSTER);
    answers.set(`/portfolios/${ACCOUNT_PORTFOLIO_ID}/cash`, ACCOUNT_LEDGER);

    renderPage(ACCOUNT_PORTFOLIO_ID);

    expect(await waitForColdStart(() => screen.getByText('Landlord'))).toBeInTheDocument();
    const ledgerRequests = recorded.filter(
      (request) => request.path === `/portfolios/${ACCOUNT_PORTFOLIO_ID}/cash`,
    );
    expect(ledgerRequests).toHaveLength(1);
    expect(ledgerRequests[0]).toMatchObject({
      method: 'GET',
      query: {
        cursor: undefined,
        limit: 50,
        source: undefined,
        tag: undefined,
        // Page one, and only page one, opts into the portfolio-wide facet.
        includeSourceTags: 'true',
      },
    });
  });
});
