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
  useVaultedPortfolioStores: vi.fn(),
  renameVault: vi.fn(),
  deleteVault: vi.fn(),
  stateFor: vi.fn(),
  unlock: vi.fn(),
  openStoredVault: vi.fn(),
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
// Which of this account's vaulted portfolios are OPEN on this device. Nothing
// is open by default, so every other case here still sees the locked alias.
vi.mock('../useVaultedPortfolioStores', () => ({
  useVaultedPortfolioStores: mocks.useVaultedPortfolioStores,
}));
vi.mock('../../AuthContext', () => ({
  useAuth: () => ({ user: { id: '018f0000-0000-7000-8000-000000000099' } }),
  // Read by the resolution registry the membership chips consult; the registry
  // itself is stubbed above, so this only keeps the module surface complete.
  useOptionalAuth: () => ({
    status: 'authenticated',
    user: { id: '018f0000-0000-7000-8000-000000000099' },
  }),
}));
vi.mock('../keystore/runtime', () => ({
  endpointVaultKeystore: {
    stateFor: mocks.stateFor,
    unlock: mocks.unlock,
    openStoredVault: mocks.openStoredVault,
  },
  // The endpoint keystore now resumes device custody before any state read.
  resumeEndpointSessionOnce: async () => ({ unlockedVaultIds: [] }),
  bindEndpointKeystoreAccount: () => undefined,
}));

import { ApiError } from '../../../lib/apiClient';
import { EndpointKeystoreError } from '../keystore/errors';
import { VaultManager, type VaultManagerOperations } from './VaultManager';

/** The live state a deep link can outlive: five wrong passwords, wait or reset. */
function lockedOutState(retryAt: number) {
  return {
    status: 'stored+wrapped',
    session: 'locked',
    requiredAction: { kind: 'wait-or-reset', retryAt, alternative: 'reset-endpoint-keystore' },
  } as const;
}

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
  mocks.useVaultedPortfolioStores.mockReturnValue({ unlocked: new Map() });
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
  mocks.unlock.mockResolvedValue({ unlockedVaultIds: [VAULT_ID] });
  mocks.openStoredVault.mockResolvedValue(undefined);
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

  it('opens the creation ceremony without asking for the unmounted Drive-connection route', async () => {
    const user = userEvent.setup();
    // No `operations` override: exactly what PrivacyPanel ships, where Drive
    // provisioning is off. The E5 route does not exist yet, so a request here
    // could only 404 into a permanent error banner above step 1.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/control/privacy']}>
          <VaultManager />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText('Long-term vault');

    await user.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByLabelText('Vault name')).toBeInTheDocument();
    expect(mocks.listConnections).not.toHaveBeenCalled();
    expect(screen.queryByText('Drive connections could not be loaded')).not.toBeInTheDocument();
  });

  it('explains an unknown deep-linked action instead of rendering its raw key', async () => {
    renderManager(`/control/privacy?vault=${VAULT_ID}&action=whatever`);

    expect(
      await screen.findByText(/asks for a vault step that does not exist/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('vault.manager.access.whatever')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(await screen.findAllByRole('link', { name: 'Enter words' })).not.toHaveLength(0);
  });

  it('answers an unlock deep link on a locked-out vault with the wait-or-reset affordance', async () => {
    // The link is a request, not a state: it was minted before the fifth wrong
    // password and the row has since withdrawn "Unlock".
    mocks.stateFor.mockResolvedValue(lockedOutState(Date.now() + 300_000));

    renderManager(`/control/privacy?vault=${VAULT_ID}&action=unlock`);

    const notice = await screen.findByText(/too many wrong device passwords/i);
    // The retry instant, not a bare "temporarily locked".
    expect(notice.textContent ?? '').toMatch(/\d{1,2}:\d{2}/);
    expect(screen.queryByLabelText('Device password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    // The same next step the row offers, one click away.
    expect(screen.getAllByRole('link', { name: 'Reset this device' })).not.toHaveLength(0);
  });

  it('still renders a deep-linked action the live state does offer', async () => {
    renderManager(`/control/privacy?vault=${VAULT_ID}&action=provide-phrase`);

    expect(await screen.findByLabelText('12 recovery words')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByText(/too many wrong device passwords/i)).not.toBeInTheDocument();
  });

  it('names the lockout an unlock attempt trips instead of a generic refusal', async () => {
    const user = userEvent.setup();
    const retryAt = Date.now() + 30_000;
    mocks.stateFor.mockResolvedValue({
      status: 'stored+wrapped',
      session: 'locked',
      requiredAction: { kind: 'unlock', credential: 'device-password' },
    });
    mocks.unlock.mockRejectedValue(
      new EndpointKeystoreError(
        'locked-out',
        'Device-password verification is temporarily locked.',
        { failures: 5, retryAt },
      ),
    );
    renderManager(`/control/privacy?vault=${VAULT_ID}&action=unlock`);

    await user.type(await screen.findByLabelText('Device password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many wrong device passwords/i);
    expect(alert.textContent ?? '').toMatch(/\d{1,2}:\d{2}/);
    expect(
      screen.queryByText('That action could not be completed. The vault remains unchanged.'),
    ).not.toBeInTheDocument();
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

  it.each([
    ['rotate', /Rotating the recovery words isn’t available yet/i],
    ['start-fresh', /Starting fresh isn’t available yet/i],
    ['scan-qr', /Scanning a transfer QR isn’t available yet/i],
    ['restore', /Choosing an older encrypted copy isn’t available yet/i],
  ])(
    'explains %s in the shipped configuration instead of disabling it silently',
    async (action, reason) => {
      // No `operations` override: exactly what PrivacyPanel mounts.
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/control/privacy?vault=${VAULT_ID}&action=${action}`]}>
            <VaultManager />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(await screen.findAllByText(reason)).not.toHaveLength(0);
      // The action cannot run, so no Continue is offered at all — and the
      // vault's own live next step is still one click away.
      expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
      expect(await screen.findAllByRole('link', { name: 'Enter words' })).not.toHaveLength(0);
    },
  );

  it('keeps deferred row actions visible without linking into a dead end', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/control/privacy']}>
          <VaultManager />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Rotate recovery words')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Rotate recovery words' })).not.toBeInTheDocument();
    expect(screen.getByText('Start fresh')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Start fresh' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Rotating the recovery words isn’t available yet/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Starting fresh isn’t available yet/i)).toBeInTheDocument();

    // "Change storage" joins them (#1520). It used to link to
    // `/control/connections?vault=<id>`, a panel that never read the param and
    // carries no per-vault media control — a dead end by the same definition
    // the two rows above avoid.
    expect(screen.getByText('Change storage')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change storage' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Changing where a vault is stored isn’t available yet/i),
    ).toBeInTheDocument();
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

  it('refuses delete while a portfolio is inside before any request is sent', async () => {
    renderManager();

    expect(await screen.findByText('Vault portfolio 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByText(/still contains a portfolio/i)).toBeInTheDocument();
    expect(mocks.deleteVault).not.toHaveBeenCalled();
  });

  it('renames and reports the exact referenced-vault delete refusal', async () => {
    const user = userEvent.setup();
    // The membership list this device holds is empty — another device moved a
    // portfolio in — so the server refusal is the one that has to explain it.
    mocks.listPortfolios.mockResolvedValue({ portfolios: [], defaultPortfolioId: null });
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

  it('renders the row as a state badge, an action bar and ONE fold — not a link line', async () => {
    // The screenshot the owner reacted to: five underlined words in a row
    // (three of them `<span>`s only pretending to be links) followed by three
    // stacked "isn’t available yet" paragraphs above the fold.
    mocks.stateFor.mockResolvedValue({
      status: 'stored+wrapped',
      session: 'locked',
      requiredAction: { kind: 'unlock', credential: 'device-password' },
    });
    const { container } = renderManager();
    await screen.findByText('Long-term vault');

    // The live state is a badge beside the name, and its tone — not its copy —
    // is what separates "locked" from "locked out".
    const badge = await screen.findByText('Locked on this device');
    expect(badge).toHaveClass('bt-badge', 'bt-badge--gold');

    // One primary act; the maintenance actions are quiet buttons beside it.
    expect(screen.getByRole('link', { name: 'Unlock' })).toHaveClass('bt-btn--primary');
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveClass('bt-btn', 'bt-btn--quiet');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bt-btn--danger');

    // Deferred actions stay reachable and announced instead of vanishing from
    // the tab order (§12: never a SILENT disabled control), and each points at
    // the one fold that names what is missing.
    const rotate = screen.getByRole('button', { name: 'Rotate recovery words' });
    expect(rotate).toHaveAttribute('aria-disabled', 'true');
    const fold = container.querySelector('details.bt-disclosure');
    expect(fold).not.toBeNull();
    expect(rotate.getAttribute('aria-describedby')).toBe(fold?.parentElement?.id);

    // All three reasons live in that ONE fold now.
    expect(container.querySelectorAll('details.bt-disclosure')).toHaveLength(1);
    expect(screen.getByText('Why some actions aren’t available yet')).toBeInTheDocument();
    expect(fold?.textContent).toContain('Rotating the recovery words isn’t available yet');
    expect(fold?.textContent).toContain('Starting fresh isn’t available yet');
    expect(fold?.textContent).toContain('Changing where a vault is stored isn’t available yet');

    // And nothing on the row is a bare underlined affordance any more.
    expect(container.querySelector('.bt-link')).toBeNull();
  });

  it('points each live maintenance action at its OWN deep link', async () => {
    // Both rows are deferred in the shipped configuration, so the link branch
    // ships untested: swapping `action=rotate` for `action=start-fresh` passed
    // the whole suite. Supply the operations that make them live, then pin the
    // targets — one of these sends a user to a destructive flow.
    const managerOperations: VaultManagerOperations = {
      ...operations,
      rotate: vi.fn(async () => undefined),
      startFresh: vi.fn(async () => undefined),
    };
    renderManager('/control/privacy', managerOperations);
    await screen.findByText('Long-term vault');

    expect(screen.getByRole('link', { name: 'Rotate recovery words' })).toHaveAttribute(
      'href',
      `/control/privacy?vault=${VAULT_ID}&action=rotate`,
    );
    expect(screen.getByRole('link', { name: 'Start fresh' })).toHaveAttribute(
      'href',
      `/control/privacy?vault=${VAULT_ID}&action=start-fresh`,
    );
    // The fold stays — "Change storage" is deferred unconditionally in this
    // build — but it must no longer claim the two actions that just went live.
    const fold = screen.getByText('Why some actions aren’t available yet').closest('details');
    expect(fold?.textContent).toContain('Changing where a vault is stored isn’t available yet');
    expect(fold?.textContent).not.toContain('Rotating the recovery words');
    expect(fold?.textContent).not.toContain('Starting fresh isn’t available yet');
  });

  it('names an open portfolio in the membership chip instead of repeating the vault', async () => {
    // FAILURE MAP #6: the chip read "Private Holdings" under a vault called
    // "Private Holdings" — the vault named after itself. Locked stays alias.
    mocks.useVaultedPortfolioStores.mockReturnValue({
      unlocked: new Map([
        [
          LOCKED_PORTFOLIO.id,
          {
            portfolio: { ...LOCKED_PORTFOLIO, name: 'Secret real portfolio name' },
            isCurrent: () => true,
          },
        ],
      ]),
    });
    renderManager();

    expect(await screen.findByText('Secret real portfolio name')).toBeInTheDocument();
    expect(screen.queryByText('Vault portfolio 1')).not.toBeInTheDocument();
  });
});
