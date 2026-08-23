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
