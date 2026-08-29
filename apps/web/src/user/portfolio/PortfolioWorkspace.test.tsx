import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

const mocks = vi.hoisted(() => ({
  stateFor: vi.fn(),
  useVaultedPortfolioStores: vi.fn(),
  listVaults: vi.fn(),
}));
vi.mock('../vault/keystore/runtime', () => ({
  endpointVaultKeystore: { stateFor: mocks.stateFor },
}));
vi.mock('../../lib/vaultApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vaultApi')>()),
  listVaults: mocks.listVaults,
}));
vi.mock('../vault/useVaultedPortfolioStores', () => ({
  useVaultedPortfolioStores: mocks.useVaultedPortfolioStores,
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

/**
 * Typed on purpose: the move-out action reads `media` to decide the Drive-only
 * retention copy (#1491), and an `{ id, name }` stub let that read reach
 * `undefined` at runtime while still compiling. `VaultConfig` makes the next
 * field the wizard starts reading a type error here instead of a render crash.
 */
const VAULT: VaultConfig = {
  id: LOCKED.vaultId!,
  name: 'Vault portfolio 1',
  headerDocId: '018f0000-0000-7000-8000-000000000004',
  commonDocId: '018f0000-0000-7000-8000-000000000005',
  media: ['server'],
  driveConnectionId: null,
  keyFingerprint: 'abcdefghijklmnop',
  retirementProofPublicKey: 'cHVibGljLWtleQ',
  retirementGeneration: 0,
  mediaAttestedAt: '2026-08-20T10:00:00.000Z',
  mediaAttestedDriveConnectionId: null,
  createdAt: '2026-08-20T09:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

function renderWorkspace(portfolios: PortfolioSummary[], active: string, path = '/portfolio') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`${path}?portfolio=${active}`]}>
        <PortfolioStoreProvider
          store={{
            ...apiPortfolioStore,
            listPortfolios: async () => ({ portfolios }),
          }}
        >
          <Routes>
            <Route element={<PortfolioWorkspace />}>
              <Route path="/portfolio" element={<div>portfolio contents</div>} />
              <Route path="/portfolio/cash" element={<div>cash contents</div>} />
            </Route>
          </Routes>
        </PortfolioStoreProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The resolver-backed access object the workspace consults, reduced to what the
 * render fork actually reads. A real one carries the client store as well.
 */
function unlockedAccess(overrides: { isCurrent?: () => boolean } = {}) {
  return {
    portfolioId: LOCKED.id,
    vaultId: LOCKED.vaultId!,
    portfolio: { ...LOCKED, name: 'Private real name' },
    store: apiPortfolioStore,
    isCurrent: overrides.isCurrent ?? (() => true),
    readTotals: async () => {
      throw new Error('not used by the render fork');
    },
  };
}

beforeEach(() => {
  mocks.stateFor.mockResolvedValue({
    status: 'not-on-this-endpoint',
    requiredAction: { kind: 'provide-phrase', methods: ['enter-words', 'scan-qr'] },
  });
  mocks.useVaultedPortfolioStores.mockReturnValue({ unlocked: new Map() });
  mocks.listVaults.mockResolvedValue([VAULT]);
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

  /**
   * PARANOID-E6 residual (#1416). Membership alone stopped deciding the fork:
   * an UNLOCKED vault resolves to a client store, so the portfolio renders in
   * place from decrypted bytes instead of showing the stub forever.
   */
  it('renders the real portfolio in place once the resolver opens its vault', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[LOCKED.id, unlockedAccess()]]),
    });

    renderWorkspace([PLAIN, LOCKED], LOCKED.id);

    expect(await screen.findByText('portfolio contents')).toBeInTheDocument();
    expect(screen.queryByTestId('locked-portfolio-stub')).not.toBeInTheDocument();
  });

  it('falls straight back to the stub when the resolved session is no longer current', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[LOCKED.id, unlockedAccess({ isCurrent: () => false })]]),
    });

    renderWorkspace([PLAIN, LOCKED], LOCKED.id);

    expect(await screen.findByTestId('locked-portfolio-stub')).toBeInTheDocument();
    expect(screen.queryByText('portfolio contents')).not.toBeInTheDocument();
    // The real name never reaches the DOM on the way back to the stub.
    expect(screen.queryByText('Private real name')).not.toBeInTheDocument();
  });

  it('keeps a revoked session out even when its currency check throws', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([
        [
          LOCKED.id,
          unlockedAccess({
            isCurrent: () => {
              throw new Error('revoked');
            },
          }),
        ],
      ]),
    });

    renderWorkspace([PLAIN, LOCKED], LOCKED.id);

    expect(await screen.findByTestId('locked-portfolio-stub')).toBeInTheDocument();
    expect(screen.queryByText('portfolio contents')).not.toBeInTheDocument();
  });

  it('never opens a vaulted portfolio the resolver did not resolve', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([['some-other-portfolio', unlockedAccess()]]),
    });

    renderWorkspace([PLAIN, LOCKED], LOCKED.id);

    expect(await screen.findByTestId('locked-portfolio-stub')).toBeInTheDocument();
  });

  it('says it is looking into a vault and keeps leaving it reachable', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[LOCKED.id, unlockedAccess()]]),
    });

    renderWorkspace([PLAIN, LOCKED], LOCKED.id);

    // "Unlocked" and "never sealed" must not render identically.
    expect(await screen.findByText('Unlocked')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Restore as a normal portfolio' }),
    ).toBeInTheDocument();
  });

  it('keeps the tab strip collapsed for an unlocked vault, exactly as for a locked one', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[LOCKED.id, unlockedAccess()]]),
    });

    renderWorkspace([PLAIN, LOCKED], LOCKED.id);

    await screen.findByText('portfolio contents');
    // The client store answers the overview only; a tab that could report
    // nothing but unavailability is not offered at all.
    expect(screen.queryByRole('link', { name: 'Import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  /**
   * Caught by the E10-A10 arc first: the unlocked view offered "leave the
   * vault" but handed the wizard NO endpoint state, and `moveOutUnlocked`
   * reads a missing state as locked — so a demonstrably open vault was told to
   * unlock itself before moving out.
   */
  it('does not tell an already-open vault to unlock before it can be left', async () => {
    mocks.stateFor.mockResolvedValue({
      status: 'stored+wrapped',
      session: 'unlocked',
      requiredAction: { kind: 'open-silently' },
    });
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[LOCKED.id, unlockedAccess()]]),
    });

    renderWorkspace([PLAIN, LOCKED], LOCKED.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore as a normal portfolio' }));

    expect(
      await screen.findByRole('region', { name: 'Move portfolio out of the vault' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/Unlock this vault on this device/)).not.toBeInTheDocument(),
    );
  });

  it('lands a deep link to another tab on the strip, never on a page that can only refuse', async () => {
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([[LOCKED.id, unlockedAccess()]]),
    });

    renderWorkspace([PLAIN, LOCKED], LOCKED.id, '/portfolio/cash');

    expect(await screen.findByText('Unlocked')).toBeInTheDocument();
    expect(screen.queryByText('cash contents')).not.toBeInTheDocument();
  });
});
