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

function access(isCurrent: () => boolean) {
  return {
    portfolioId: VAULTED.id,
    vaultId: VAULT_ID,
    portfolio: VAULTED,
    store: apiPortfolioStore,
    isCurrent,
    readTotals: async () => ({ totals: TOTALS, snapshotId: 'vault-document-set-v1:test' }),
    dispose: () => {},
  };
}

beforeEach(() => {
  mocks.useVaultedPortfolioStores.mockReturnValue({ unlocked: new Map() });
});

describe('Home roll-up over an unlocked vault', () => {
  it('still qualifies the subtotal while the vault is locked', async () => {
    renderRollup([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('total')).toHaveTextContent(String(TOTALS.totalValueEur));
    expect(screen.getByTestId('coverage')).toHaveTextContent('partial');
    expect(screen.getByTestId('locked')).toHaveTextContent('1');
  });

  it('adds the client-served vaulted figures once the resolver opens it', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[VAULTED.id, access(() => true)]]),
    });

    renderRollup([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('coverage')).toHaveTextContent('complete'));
    expect(screen.getByTestId('total')).toHaveTextContent(String(TOTALS.totalValueEur * 2));
    expect(screen.getByTestId('locked')).toHaveTextContent('0');
  });

  it('falls back to the locked qualifier when the session stops being current', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[VAULTED.id, access(() => false)]]),
    });

    renderRollup([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // The composition boundary refuses the value rather than trusting the map.
    expect(screen.getByTestId('coverage')).toHaveTextContent('partial');
    expect(screen.getByTestId('total')).toHaveTextContent(String(TOTALS.totalValueEur));
  });

  it('reports unknown rather than a lone client total when the plain member fails', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[VAULTED.id, access(() => true)]]),
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
