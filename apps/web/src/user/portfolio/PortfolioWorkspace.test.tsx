import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary } from '@bettertrack/contracts';

const mocks = vi.hoisted(() => ({ stateFor: vi.fn() }));
vi.mock('../vault/keystore/runtime', () => ({
  endpointVaultKeystore: { stateFor: mocks.stateFor },
}));

import { apiPortfolioStore } from '../../lib/portfolioStore';
import { PortfolioStoreProvider } from './PortfolioStoreProvider';
import { PortfolioWorkspace } from './PortfolioWorkspace';

const PLAIN = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Plain portfolio',
  isDefault: true,
} as PortfolioSummary;
const LOCKED = {
  id: '018f0000-0000-7000-8000-000000000002',
  name: 'Private real name',
  vaultAlias: 'Vault portfolio 1',
  vaultId: '018f0000-0000-7000-8000-000000000003',
  isDefault: false,
} as PortfolioSummary;

function renderWorkspace(portfolios: PortfolioSummary[], active: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/portfolio?portfolio=${active}`]}>
        <PortfolioStoreProvider
          store={{
            ...apiPortfolioStore,
            listPortfolios: async () => ({ portfolios }),
          }}
        >
          <Routes>
            <Route element={<PortfolioWorkspace />}>
              <Route path="/portfolio" element={<div>portfolio contents</div>} />
            </Route>
          </Routes>
        </PortfolioStoreProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.stateFor.mockResolvedValue({
    status: 'not-on-this-endpoint',
    requiredAction: { kind: 'provide-phrase', methods: ['enter-words', 'scan-qr'] },
  });
});

describe('PortfolioWorkspace vault boundary', () => {
  it('replaces a vaulted portfolio with its alias/action and removes killed affordances', async () => {
    renderWorkspace([PLAIN, LOCKED], LOCKED.id);

    expect(await screen.findByRole('heading', { name: 'Vault portfolio 1' })).toBeInTheDocument();
    expect(screen.queryByText('Private real name')).not.toBeInTheDocument();
    expect(screen.queryByText('portfolio contents')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Enter words' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Scan QR' })).toBeInTheDocument();
  });

  it('keeps the same affordances present for a normal sibling', async () => {
    renderWorkspace([PLAIN, LOCKED], PLAIN.id);

    expect(await screen.findByText('portfolio contents')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });
});
