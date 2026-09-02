import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { PortfolioSummary } from '@bettertrack/contracts';

const mocks = vi.hoisted(() => ({
  getPortfolio: vi.fn(),
  getPortfolioHistory: vi.fn(),
  stateFor: vi.fn(),
}));

vi.mock('../../../lib/portfolioApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/portfolioApi')>()),
  getPortfolio: mocks.getPortfolio,
  getPortfolioHistory: mocks.getPortfolioHistory,
}));
vi.mock('../../vault/keystore/runtime', () => ({
  endpointVaultKeystore: { stateFor: mocks.stateFor },
  // The endpoint keystore now resumes device custody before any state read.
  resumeEndpointSessionOnce: async () => ({ unlockedVaultIds: [] }),
  bindEndpointKeystoreAccount: () => undefined,
}));

import { PortfolioCardsWidget } from './PortfolioCardsWidget';

function locked(index: number): PortfolioSummary {
  return {
    id: `018f0000-0000-7000-8000-00000000000${index}`,
    name: `Secret name ${index}`,
    vaultId: `018f0000-0000-7000-8000-00000000001${index}`,
    vaultAlias: `Vault portfolio ${index}`,
    sortOrder: index,
    visibility: 'private',
    isDefault: index === 1,
    defaultPayFromCash: false,
    archivedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stateFor.mockResolvedValue({
    status: 'not-on-this-endpoint',
    requiredAction: { kind: 'provide-phrase', methods: ['enter-words', 'scan-qr'] },
  });
});

test('renders aggregate locked stubs without reading money data or exposing true names', async () => {
  const portfolios = [locked(1), locked(2)];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PortfolioCardsWidget
          onSettingsChange={() => {}}
          portfolios={portfolios}
          portfoliosLoading={false}
          scopedPortfolio={null}
          scopedPortfolios={portfolios}
          settings={{}}
          size="m"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(screen.getByText('2 locked portfolios')).toBeInTheDocument();
  expect(screen.getByText('Vault portfolio 1')).toBeInTheDocument();
  expect(screen.getByText('Vault portfolio 2')).toBeInTheDocument();
  expect(screen.queryByText('Secret name 1')).not.toBeInTheDocument();
  expect(screen.queryByText('Secret name 2')).not.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getAllByRole('link', { name: 'Enter words' })).toHaveLength(2);
  });
  expect(mocks.getPortfolio).not.toHaveBeenCalled();
  expect(mocks.getPortfolioHistory).not.toHaveBeenCalled();
});

function plain(index: number): PortfolioSummary {
  return {
    id: `018f0000-0000-7000-8000-0000000000a${index}`,
    name: `Plain ${index}`,
    sortOrder: index,
    visibility: 'private',
    isDefault: index === 1,
    defaultPayFromCash: false,
    archivedAt: null,
  };
}

function totals(totalValueEur: number) {
  return {
    totals: {
      totalValueEur,
      marketValueEur: totalValueEur,
      investedEur: totalValueEur,
      unrealizedPnlEur: 0,
      dayChangeEur: 0,
      cashEur: 0,
      realizedPnlEur: 0,
      dividendsGrossEur: 0,
    },
  };
}

test('a locked member leaves the share column unknown instead of inflating it to 100%', async () => {
  // The visible portfolio is the ONLY one the server can price, so a share
  // computed against it alone would read 100% — a confident number that is
  // wrong precisely because a vault is sealed. Unknown must stay unknown.
  const portfolios = [plain(1), locked(2)];
  mocks.getPortfolio.mockResolvedValue(totals(4_000));
  mocks.getPortfolioHistory.mockResolvedValue({ points: [], baseCurrency: 'EUR' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PortfolioCardsWidget
          onSettingsChange={() => {}}
          portfolios={portfolios}
          portfoliosLoading={false}
          scopedPortfolio={null}
          scopedPortfolios={portfolios}
          settings={{ variant: 'table' }}
          size="m"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  // The locked member is still itemised and counted out loud — it is not hidden,
  // it is declared.
  expect(await screen.findByText('1 locked portfolio')).toBeInTheDocument();
  expect(screen.getByText('Vault portfolio 2')).toBeInTheDocument();
  // Its own money never reaches the server.
  expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
  // And no row claims a share, because the denominator is unknowable.
  expect(screen.queryByText('100.00%')).not.toBeInTheDocument();
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
});
