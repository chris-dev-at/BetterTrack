import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { LockedPortfolioStub } from './LockedPortfolioStub';

const portfolio = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Never reveal this name',
  vaultAlias: 'Vault portfolio 2',
  vaultId: '018f0000-0000-7000-8000-000000000002',
} as PortfolioSummary & { vaultId: string };

describe('LockedPortfolioStub', () => {
  it('renders only the server alias and the action implied by E3 state', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LockedPortfolioStub
            portfolio={portfolio}
            state={{
              status: 'stored+wrapped',
              session: 'locked',
              requiredAction: { kind: 'unlock', credential: 'device-password' },
            }}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Vault portfolio 2' })).toBeInTheDocument();
    expect(screen.queryByText('Never reveal this name')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unlock' })).toHaveAttribute(
      'href',
      '/control/privacy?vault=018f0000-0000-7000-8000-000000000002&action=unlock',
    );
  });
});
