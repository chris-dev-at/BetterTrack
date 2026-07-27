import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { PortfolioStore } from '../../lib/portfolioStore';
import type { VaultSyncEngine } from './sync';

const fixtures = vi.hoisted(() => ({
  store: {} as PortfolioStore,
}));

vi.mock('../UserApp', () => ({
  UserApp: ({ portfolioStore }: { portfolioStore?: PortfolioStore }) => (
    <output data-testid="selected-store">
      {portfolioStore === fixtures.store ? 'vault' : 'unexpected'}
    </output>
  ),
}));

vi.mock('./vaultPortfolioStore', () => ({
  createVaultPortfolioStore: vi.fn(),
}));

import { createVaultPortfolioStore } from './vaultPortfolioStore';
import { VaultUserApp } from './VaultUserApp';

describe('VaultUserApp', () => {
  test('constructs the vault-backed portfolio store and injects it into the user app', () => {
    const engine = {} as VaultSyncEngine;
    vi.mocked(createVaultPortfolioStore).mockReturnValue(fixtures.store);

    render(<VaultUserApp engine={engine} />);

    expect(createVaultPortfolioStore).toHaveBeenCalledWith(engine);
    expect(screen.getByTestId('selected-store')).toHaveTextContent('vault');
  });
});
