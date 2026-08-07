import type { VaultHeaderDoc, VaultSummary } from '@bettertrack/contracts';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { VaultKnowledge } from '../sectionState';

const vaultsContext = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('./VaultsProvider', () => ({ useVaults: () => vaultsContext.current }));

import { PortfolioVaultSection } from './PortfolioVaultSection';

const VAULT_ID = '4f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a01';
const PORTFOLIO_ID = '11111111-1111-4111-8111-111111111111';

function summary(overrides: Partial<VaultSummary> = {}): VaultSummary {
  return {
    id: VAULT_ID,
    name: 'Drive vault',
    backends: ['drive'],
    createdAt: '2026-08-08T09:00:00.000Z',
    portfolioIds: [],
    ...overrides,
  };
}

function header(): VaultHeaderDoc {
  return {
    formatVersion: 2,
    vaultId: VAULT_ID,
    name: 'Drive vault',
    kdfSalt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    keySlots: [
      { slotId: '8f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a08', kind: 'passphrase', wrappedKey: 'AAAA' },
    ],
    portfolios: [{ portfolioId: PORTFOLIO_ID, alias: 'Tech' }],
    backends: ['drive'],
    headerVersion: 1,
    deviceId: '2f2f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a02',
    writeId: '6f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a03',
    writtenAt: '2026-08-08T09:00:00.000Z',
    seal: null,
  };
}

function mount(
  context: {
    status?: 'loading' | 'ready' | 'error';
    vaults?: VaultKnowledge[];
  } = {},
  props: { legacyParanoid?: boolean } = {},
) {
  vaultsContext.current = {
    status: context.status ?? 'ready',
    vaults: context.vaults ?? [],
    keyring: { isUnlocked: () => false },
    passphraseStore: {},
    refresh: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <PortfolioVaultSection portfolioId={PORTFOLIO_ID} portfolioName="Tech" {...props} />
    </MemoryRouter>,
  );
}

describe('PortfolioVaultSection — the always-visible settings section', () => {
  it('renders on every portfolio, even with no vaults at all', () => {
    mount();
    expect(screen.getByRole('region', { name: 'Vault / Paranoid mode' })).toBeInTheDocument();
  });

  it('shows the explainer teaser and the create CTA when no vault exists', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Create a vault' })).toBeInTheDocument();
    expect(screen.getByText(/only key/iu)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How vaults work' })).toHaveAttribute(
      'href',
      '/vault/how-it-works',
    );
  });

  it('offers each vault as a move target for a normal portfolio', () => {
    mount({
      vaults: [
        { summary: summary(), header: null, unlocked: true, rememberedOnDevice: false },
        {
          summary: summary({
            id: '7f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a07',
            name: 'Server vault',
            backends: ['server'],
          }),
          header: null,
          unlocked: false,
          rememberedOnDevice: false,
        },
      ],
    });
    expect(screen.getByText('Drive vault')).toBeInTheDocument();
    expect(screen.getByText('Server vault')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Move into vault' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument();
  });

  it('shows the locked state with an unlock action for a vaulted portfolio', () => {
    mount({
      vaults: [
        {
          summary: summary({ portfolioIds: [PORTFOLIO_ID] }),
          header: header(),
          unlocked: false,
          rememberedOnDevice: false,
        },
      ],
    });
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    expect(screen.getByText('Shown as “Tech” while locked')).toBeInTheDocument();
    // No secret-bearing affordance while locked.
    expect(
      screen.queryByRole('button', { name: 'Share to another device' }),
    ).not.toBeInTheDocument();
  });

  it('shows the unlocked state with QR share and move-out', () => {
    mount({
      vaults: [
        {
          summary: summary({ portfolioIds: [PORTFOLIO_ID] }),
          header: header(),
          unlocked: true,
          rememberedOnDevice: true,
        },
      ],
    });
    expect(screen.getByText('Unlocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share to another device' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument();
  });

  it('names the backend so the user can see where the bytes live', () => {
    mount({
      vaults: [
        {
          summary: summary({ portfolioIds: [PORTFOLIO_ID], backends: ['server', 'drive'] }),
          header: header(),
          unlocked: true,
          rememberedOnDevice: false,
        },
      ],
    });
    expect(
      screen.getByText('Stored encrypted on BetterTrack and in your Google Drive'),
    ).toBeInTheDocument();
  });

  it('points a legacy account-wide account at the migration instead', () => {
    mount({}, { legacyParanoid: true });
    expect(screen.getByRole('link', { name: 'Open the migration' })).toHaveAttribute(
      'href',
      '/control/privacy',
    );
    expect(screen.queryByRole('button', { name: 'Create a vault' })).not.toBeInTheDocument();
  });

  it('surfaces a load failure instead of pretending there are no vaults', () => {
    mount({ status: 'error' });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load your vaults/iu);
    expect(screen.queryByRole('button', { name: 'Create a vault' })).not.toBeInTheDocument();
  });

  it('renders without a provider rather than throwing', () => {
    vaultsContext.current = null;
    render(
      <MemoryRouter>
        <PortfolioVaultSection portfolioId={PORTFOLIO_ID} portfolioName="Tech" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Create a vault' })).toBeInTheDocument();
  });
});
