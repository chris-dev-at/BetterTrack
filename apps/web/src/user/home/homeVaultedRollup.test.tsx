import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary, PortfolioTotals } from '@bettertrack/contracts';

const mocks = vi.hoisted(() => ({ useVaultedPortfolioStores: vi.fn() }));
vi.mock('../vault/useVaultedPortfolioStores', () => ({
  useVaultedPortfolioStores: mocks.useVaultedPortfolioStores,
}));

import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import { PortfolioStoreProvider } from '../portfolio/PortfolioStoreProvider';
import { useRollup } from './homeData';

/**
 * The Home half of the E6 store-resolver wiring (#1416), end to end through the
 * hook seam: an unlocked vaulted portfolio contributes its REAL figures to the
 * roll-up, and the instant its session stops being current it goes back to
 * being a locked member of a qualified subtotal — never a wrong total, and
 * never a silent zero.
 */

const VAULT_ID = '018f0000-0000-7000-8000-000000000601';

const PLAIN: PortfolioSummary = {
  id: 'p-plain',
  name: 'Plain',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};
const VAULTED: PortfolioSummary = {
  ...PLAIN,
  id: 'p-vaulted',
  name: 'Vault alias',
  isDefault: false,
  vaultId: VAULT_ID,
  vaultAlias: 'Vault alias',
};

const TOTALS: PortfolioTotals = {
  marketValueEur: 900,
  investedEur: 800,
  unrealizedPnlEur: 100,
  unrealizedPnlPct: 12.5,
  dayChangeEur: 10,
  dayChangePct: 1.1,
  cashEur: 100,
  totalValueEur: 1000,
};

function Probe({ portfolios }: { portfolios: PortfolioSummary[] }) {
  const rollup = useRollup(portfolios);
  return (
    <div>
      <span data-testid="status">{rollup.status}</span>
      <span data-testid="total">
        {rollup.status === 'ready' ? rollup.totalValue.valueEur : 'unavailable'}
      </span>
      <span data-testid="coverage">
        {rollup.status === 'ready' ? rollup.totalValue.coverage.kind : 'unavailable'}
      </span>
      <span data-testid="locked">
        {rollup.status === 'ready' ? (rollup.totalValue.coverage.lockedPortfolioCount ?? 0) : -1}
      </span>
    </div>
  );
}

function renderRollup(portfolios: PortfolioSummary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store: PortfolioStore = {
    ...apiPortfolioStore,
    // Only PLAIN members may ever reach this: `usePortfolioSummaries` keeps a
    // vaulted stub's query disabled, wired or not.
    getPortfolio: async (portfolioId) => {
      if (portfolioId !== PLAIN.id) throw new Error(`unexpected server read for ${portfolioId}`);
      return { baseCurrency: 'EUR', holdings: [], totals: TOTALS };
    },
  };
  return render(
    <QueryClientProvider client={client}>
      <PortfolioStoreProvider store={store}>
        <Probe portfolios={portfolios} />
      </PortfolioStoreProvider>
    </QueryClientProvider>,
  );
}

/**
 * `accessId` is the ONLY thing that distinguishes two accesses over the same
 * vault and the same documents — `vaultId` and `snapshotId` are deliberately
 * held constant here, because that is the shape the roll-up's cache key has to
 * survive (see `useUnlockedVaultReads`).
 */
function access(
  isCurrent: () => boolean,
  options: { accessId?: string; readTotals?: () => Promise<never> } = {},
) {
  return {
    accessId: options.accessId ?? 'vault-access-1',
    portfolioId: VAULTED.id,
    vaultId: VAULT_ID,
    portfolio: VAULTED,
    store: apiPortfolioStore,
    isCurrent,
    readTotals:
      options.readTotals ??
      (async () => ({ totals: TOTALS, snapshotId: 'vault-document-set-v1:test' })),
    dispose: () => {},
  };
}

/**
 * What a DISPOSED access does: `readTotals` derives, then re-checks currency
 * and refuses rather than reporting a figure branded with a snapshot that is no
 * longer live (`resolvedPortfolioStore.readTotals`).
 */
function disposedAccess(accessId: string) {
  return access(() => true, {
    accessId,
    readTotals: async () => {
      throw new Error('The vault locked while its portfolio totals were read.');
    },
  });
}

beforeEach(() => {
  mocks.useVaultedPortfolioStores.mockReturnValue({ unlocked: new Map(), failures: new Map() });
});

describe('Home roll-up over an unlocked vault', () => {
  it('still qualifies the subtotal while the vault is locked', async () => {
    renderRollup([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('total')).toHaveTextContent(String(TOTALS.totalValueEur));
    expect(screen.getByTestId('coverage')).toHaveTextContent('partial');
    expect(screen.getByTestId('locked')).toHaveTextContent('1');
  });

  it('reports unavailable — not "locked" — when an unlocked vault’s portfolio failed to open', async () => {
    // The settled resolver hands back a failure for a member whose vault IS
    // open on this device. Calling it "locked" would disguise a failure as the
    // user's choice, and composing around it would print a number the client
    // has no basis for — so the roll-up exposes none.
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map(),
      failures: new Map([
        [
          VAULTED.id,
          {
            vaultId: VAULT_ID,
            code: 'VAULT_DOCUMENT_INVALID',
            message: 'The vault header roster disagrees with the server membership.',
          },
        ],
      ]),
    });

    renderRollup([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unavailable'));
    expect(screen.getByTestId('coverage')).toHaveTextContent('unavailable');
  });

  it('adds the client-served vaulted figures once the resolver opens it', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[VAULTED.id, access(() => true)]]),
      failures: new Map(),
    });

    renderRollup([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('coverage')).toHaveTextContent('complete'));
    expect(screen.getByTestId('total')).toHaveTextContent(String(TOTALS.totalValueEur * 2));
    expect(screen.getByTestId('locked')).toHaveTextContent('0');
  });

  it('falls back to the locked qualifier when the session stops being current', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[VAULTED.id, access(() => false)]]),
      failures: new Map(),
    });

    renderRollup([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // The composition boundary refuses the value rather than trusting the map.
    expect(screen.getByTestId('coverage')).toHaveTextContent('partial');
    expect(screen.getByTestId('total')).toHaveTextContent(String(TOTALS.totalValueEur));
  });

  it('does not serve a disposed access’s rejection to the one that replaced it', async () => {
    // The roll-up's copy of paranoid-UX failure map #1. Unlocking a second
    // vault disposes the whole batch and re-resolves; the disposed access's
    // in-flight `readTotals` then refuses. Keyed by `vaultId` (or by
    // `snapshotId` — both survive a re-resolve over unchanged documents) that
    // refusal lands under the key the LIVE access reads, and Home reports an
    // error for a portfolio it can read perfectly well.
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[VAULTED.id, disposedAccess('vault-access-dead')]]),
      failures: new Map(),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (portfolios: PortfolioSummary[]) => (
      <QueryClientProvider client={client}>
        <PortfolioStoreProvider
          store={{
            ...apiPortfolioStore,
            getPortfolio: async () => ({
              baseCurrency: 'EUR' as const,
              holdings: [],
              totals: TOTALS,
            }),
          }}
        >
          <Probe portfolios={portfolios} />
        </PortfolioStoreProvider>
      </QueryClientProvider>
    );
    const view = render(tree([PLAIN, VAULTED]));

    // The dead access's refusal is stated, because for THAT access it is true.
    await waitFor(() => expect(screen.getByTestId('coverage')).toHaveTextContent('partial'));

    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[VAULTED.id, access(() => true, { accessId: 'vault-access-live' })]]),
      failures: new Map(),
    });
    view.rerender(tree([PLAIN, VAULTED]));

    await waitFor(() => expect(screen.getByTestId('coverage')).toHaveTextContent('complete'));
    expect(screen.getByTestId('total')).toHaveTextContent(String(TOTALS.totalValueEur * 2));
  });

  it('reports unknown rather than a lone client total when the plain member fails', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[VAULTED.id, access(() => true)]]),
      failures: new Map(),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PortfolioStoreProvider
          store={{
            ...apiPortfolioStore,
            getPortfolio: async () => {
              throw new Error('503');
            },
          }}
        >
          <Probe portfolios={[PLAIN, VAULTED]} />
        </PortfolioStoreProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unavailable'));
    expect(screen.getByTestId('total')).toHaveTextContent('unavailable');
  });
});
