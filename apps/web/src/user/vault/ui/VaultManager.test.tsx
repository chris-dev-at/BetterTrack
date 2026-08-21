import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

const VAULT_ID = '018f0000-0000-7000-8000-000000000001';
const mocks = vi.hoisted(() => ({
  listVaults: vi.fn(),
  listConnections: vi.fn(),
  listPortfolios: vi.fn(),
  renameVault: vi.fn(),
  deleteVault: vi.fn(),
  stateFor: vi.fn(),
}));

vi.mock('../../../lib/vaultApi', () => ({
  VAULTS_QUERY_KEY: ['vaults', 'configs'],
  DRIVE_CONNECTIONS_QUERY_KEY: ['vaults', 'drive-connections'],
  listVaults: mocks.listVaults,
  listVaultDriveConnections: mocks.listConnections,
  renameVault: mocks.renameVault,
  deleteVault: mocks.deleteVault,
  readVaultHeaderDocument: vi.fn(),
}));
vi.mock('../../../lib/portfolioApi', () => ({ listPortfolios: mocks.listPortfolios }));
vi.mock('../../AuthContext', () => ({
  useAuth: () => ({ user: { id: '018f0000-0000-7000-8000-000000000099' } }),
}));
vi.mock('../keystore/runtime', () => ({
  endpointVaultKeystore: { stateFor: mocks.stateFor },
}));

import { ApiError } from '../../../lib/apiClient';
import { VaultManager, type VaultManagerOperations } from './VaultManager';

const VAULT: VaultConfig = {
  id: VAULT_ID,
  name: 'Long-term vault',
  headerDocId: '018f0000-0000-7000-8000-000000000002',
  commonDocId: '018f0000-0000-7000-8000-000000000003',
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

const LOCKED_PORTFOLIO = {
  id: '018f0000-0000-7000-8000-000000000004',
  name: 'Secret real portfolio name',
  vaultAlias: 'Vault portfolio 1',
  vaultId: VAULT_ID,
  isDefault: true,
  sortOrder: 0,
  visibility: 'private',
  defaultPayFromCash: false,
  archivedAt: null,
  createdAt: '2026-08-20T09:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
} as PortfolioSummary;

const operations: VaultManagerOperations = {
  provision: vi.fn(),
  fetchHeader: vi.fn(),
};

function renderManager(
  initialPath = '/control/privacy',
  managerOperations: VaultManagerOperations = operations,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <VaultManager operations={managerOperations} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listVaults.mockResolvedValue([VAULT]);
  mocks.listConnections.mockResolvedValue([]);
  mocks.listPortfolios.mockResolvedValue({
    portfolios: [LOCKED_PORTFOLIO],
    defaultPortfolioId: LOCKED_PORTFOLIO.id,
  });
  mocks.stateFor.mockResolvedValue({
    status: 'not-on-this-endpoint',
    requiredAction: { kind: 'provide-phrase', methods: ['enter-words', 'scan-qr'] },
  });
  mocks.renameVault.mockResolvedValue({ ...VAULT, name: 'Renamed' });
  mocks.deleteVault.mockResolvedValue(undefined);
});

describe('VaultManager', () => {
  it('shows calm cleartext boundaries, aliases, storage and a state action per vault', async () => {
    renderManager();

    expect(await screen.findByText('Long-term vault')).toBeInTheDocument();
    expect(screen.getByText('Vault portfolio 1')).toBeInTheDocument();
    expect(screen.queryByText('Secret real portfolio name')).not.toBeInTheDocument();
    expect(screen.getByText(/Encrypted on BetterTrack/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Enter words' })).toHaveAttribute(
      'href',
      `/control/privacy?vault=${VAULT_ID}&action=provide-phrase`,
    );
    const explainer = screen.getByText(/Vault names and storage settings stay readable/i);
    expect(explainer.closest('[role="alert"]')).toBeNull();
  });

  it('names the Drive connection bound to a vault', async () => {
    const connectionId = '018f0000-0000-7000-8000-000000000008';
    mocks.listVaults.mockResolvedValue([
      {
        ...VAULT,
        media: ['drive'],
        driveConnectionId: connectionId,
        mediaAttestedDriveConnectionId: connectionId,
      },
    ]);
    mocks.listConnections.mockResolvedValue([
      {
        id: connectionId,
        googleSub: '123456789',
        email: 'owner@example.com',
        displayName: 'Personal',
        createdAt: '2026-08-20T09:00:00.000Z',
        lastVerifiedAt: '2026-08-20T10:00:00.000Z',
      },
    ]);

    renderManager();

    expect(await screen.findByText('Drive: Personal · owner@example.com')).toBeInTheDocument();
  });

  it('opens the bounded restore picker and keeps corrupt history visible but inert', async () => {
    const restoreCandidate = vi.fn(async () => undefined);
    const managerOperations: VaultManagerOperations = {
      ...operations,
      listRestoreCandidates: vi.fn(async () => [
        {
          id: 'server-history-2',
          source: 'server-history',
          medium: 'server' as const,
          envelope: new Uint8Array([1]),
          version: 2,
          updatedAt: '2026-08-20T10:00:00.000Z',
          status: 'available' as const,
        },
        {
          id: 'server-history-1',
          source: 'server-history',
          medium: 'server' as const,
          envelope: new Uint8Array([2]),
          version: 1,
          updatedAt: '2026-08-19T10:00:00.000Z',
          status: 'corrupt' as const,
        },
      ]),
      restoreCandidate,
    };
    const user = userEvent.setup();
    renderManager(`/control/privacy?vault=${VAULT_ID}&action=restore`, managerOperations);

    expect(await screen.findByText('Corrupt — cannot restore')).toBeInTheDocument();
    const choices = screen.getAllByRole('radio');
    expect(choices[1]).toBeDisabled();
    await user.click(choices[0]!);
    await user.click(screen.getByRole('button', { name: 'Restore selected copy' }));
    await waitFor(() => expect(restoreCandidate).toHaveBeenCalledOnce());
  });

  it('presents start fresh as step-up-gated destruction', async () => {
    const startFresh = vi.fn(async () => undefined);
    const user = userEvent.setup();
    renderManager(`/control/privacy?vault=${VAULT_ID}&action=start-fresh`, {
      ...operations,
      startFresh,
    });

    expect(await screen.findByText(/permanently discards this vault/i)).toBeInTheDocument();
    const action = screen.getByRole('button', { name: 'Continue' });
    expect(action).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /destruction, not recovery/i }));
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');
    await user.click(action);

    await waitFor(() =>
      expect(startFresh).toHaveBeenCalledWith(VAULT, { password: 'account-secret' }),
    );
  });

  it('renames and reports the exact referenced-vault delete refusal', async () => {
    const user = userEvent.setup();
    mocks.deleteVault.mockRejectedValue(
      new ApiError(409, 'VAULT_REFERENCED_BY_PORTFOLIO', 'still referenced'),
    );
    renderManager();
    await screen.findByText('Long-term vault');

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText('Vault name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.renameVault).toHaveBeenCalledWith(VAULT_ID, { name: 'Renamed' }),
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.type(screen.getByLabelText('Account confirmation'), 'account-password');
    await user.click(screen.getByRole('button', { name: 'Delete empty vault' }));
    expect(await screen.findByText(/still contains a portfolio/i)).toBeInTheDocument();
  });
});
