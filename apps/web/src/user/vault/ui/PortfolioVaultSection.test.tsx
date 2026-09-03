import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

const VAULT_ID = '018f0000-0000-7000-8000-000000000001';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000004';

const mocks = vi.hoisted(() => ({
  listVaults: vi.fn(),
  getPortfolioVaultRevision: vi.fn(),
  movePortfolioIntoVault: vi.fn(),
  stateFor: vi.fn(),
  verifySessionPassword: vi.fn(),
}));

vi.mock('../../../lib/userApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/userApi')>()),
  verifySessionPassword: mocks.verifySessionPassword,
}));
vi.mock('../../../lib/vaultApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/vaultApi')>()),
  VAULTS_QUERY_KEY: ['vaults', 'configs'],
  listVaults: mocks.listVaults,
  getPortfolioVaultRevision: mocks.getPortfolioVaultRevision,
  getPortfolioVaultLifecycle: vi.fn(),
  getVaultMediaState: vi.fn(),
  transitionVaultMedia: vi.fn(),
  writeVaultDocument: vi.fn(),
  movePortfolioIntoVault: mocks.movePortfolioIntoVault,
  movePortfolioOutOfVault: vi.fn(),
  requestPortfolioMoveOutChallenge: vi.fn(),
}));
vi.mock('../keystore/runtime', () => ({
  endpointVaultKeystore: { stateFor: mocks.stateFor },
  // The endpoint keystore now resumes device custody before any state read.
  resumeEndpointSessionOnce: async () => ({ unlockedVaultIds: [] }),
  bindEndpointKeystoreAccount: () => undefined,
}));

import { PortfolioVaultSection } from './PortfolioVaultSection';

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

const PORTFOLIO = {
  id: PORTFOLIO_ID,
  name: 'Trading',
  isDefault: false,
  sortOrder: 1,
  visibility: 'private',
  defaultPayFromCash: false,
  archivedAt: null,
} as PortfolioSummary;

/** Reads back where the section left the user standing. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function renderSection(
  capture: Parameters<typeof PortfolioVaultSection>[0]['capture'] = null,
  onMoved: () => void = () => {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {/* The real entry point: the portfolio's own Settings tab. */}
      <MemoryRouter initialEntries={[`/portfolio/settings?portfolio=${PORTFOLIO_ID}`]}>
        <PortfolioVaultSection capture={capture} onMoved={onMoved} portfolio={PORTFOLIO} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listVaults.mockResolvedValue([VAULT]);
  mocks.stateFor.mockResolvedValue({
    status: 'stored+plain',
    requiredAction: { kind: 'open-silently' },
  });
  mocks.verifySessionPassword.mockResolvedValue(undefined);
  mocks.getPortfolioVaultRevision.mockResolvedValue({ portfolioDataRevision: 'rev-7' });
  mocks.movePortfolioIntoVault.mockResolvedValue({
    portfolioId: PORTFOLIO_ID,
    vaultId: VAULT_ID,
    docVersion: 4,
    lifecycleGeneration: 1,
    idempotent: false,
  });
});

describe('PortfolioVaultSection', () => {
  it('stays absent for an account that owns no vault', async () => {
    mocks.listVaults.mockResolvedValue([]);
    renderSection();

    await waitFor(() => expect(mocks.listVaults).toHaveBeenCalled());
    expect(screen.queryByText('Private vault')).not.toBeInTheDocument();
  });

  it('opens the move-in wizard with the irreversibility statement', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Move into vault' }));
    expect(
      screen.getByRole('heading', { name: 'Move portfolio into a vault' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Those shares are not restored/i)).toBeInTheDocument();
  });

  it('fails closed while this device cannot prepare the encrypted copy', async () => {
    const user = userEvent.setup();
    renderSection(null);

    await user.click(await screen.findByRole('button', { name: 'Move into vault' }));
    await user.selectOptions(screen.getByLabelText('Target vault'), VAULT_ID);
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');

    expect(screen.getByText(/can’t prepare the portfolio’s encrypted copy/i)).toBeInTheDocument();
    const commit = screen.getAllByRole('button', { name: 'Move into vault' }).at(-1)!;
    expect(commit).toBeDisabled();
    await user.click(commit);
    expect(mocks.movePortfolioIntoVault).not.toHaveBeenCalled();
  });

  it('sends the captured doc version, the bound revision and the step-up together', async () => {
    const user = userEvent.setup();
    const capture = {
      captureMoveIn: vi.fn(async () => ({ docVersion: 4 })),
      captureMoveOut: vi.fn(),
    };
    renderSection(capture);

    await user.click(await screen.findByRole('button', { name: 'Move into vault' }));
    await user.selectOptions(screen.getByLabelText('Target vault'), VAULT_ID);
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');
    await user.click(screen.getAllByRole('button', { name: 'Move into vault' }).at(-1)!);

    await waitFor(() =>
      expect(mocks.movePortfolioIntoVault).toHaveBeenCalledWith(PORTFOLIO_ID, {
        vaultId: VAULT_ID,
        docVersion: 4,
        portfolioDataRevision: 'rev-7',
        stepUp: { password: 'account-secret' },
      }),
    );
    // The revision is read BEFORE the capture, so E4's double-read CAS can
    // refuse a move whose rows changed underneath it.
    expect(mocks.getPortfolioVaultRevision).toHaveBeenCalledBefore(capture.captureMoveIn);
    // And the password is proven BEFORE the capture writes anything (#1528
    // F1): a mistyped credential refuses while the vault is still untouched.
    expect(mocks.verifySessionPassword).toHaveBeenCalledWith(
      'account-secret',
      'portfolio-vault-move-in',
    );
    expect(mocks.verifySessionPassword).toHaveBeenCalledBefore(capture.captureMoveIn);
  });

  it('leaves the settings page the move just retired, for the portfolio overview', async () => {
    // FAILURE MAP #5. A vaulted portfolio has no Settings route: the workspace
    // collapses its local nav to Overview and renders nothing for every other
    // tab. Succeeding here therefore emptied the very page the user was
    // standing on down to the "Unlocked" strip and the footer — the blank page
    // behind "I moved a portfolio into a vault and I couldn't load it anymore".
    const user = userEvent.setup();
    const onMoved = vi.fn();
    renderSection(
      { captureMoveIn: vi.fn(async () => ({ docVersion: 4 })), captureMoveOut: vi.fn() },
      onMoved,
    );

    await user.click(await screen.findByRole('button', { name: 'Move into vault' }));
    await user.selectOptions(screen.getByLabelText('Target vault'), VAULT_ID);
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');
    await user.click(screen.getAllByRole('button', { name: 'Move into vault' }).at(-1)!);

    await waitFor(() =>
      expect(screen.getByTestId('url')).toHaveTextContent(`/portfolio?portfolio=${PORTFOLIO_ID}`),
    );
    // The roster refresh still runs — the navigation is in addition to it, not
    // instead of it, or the switcher would keep showing the pre-move name.
    expect(onMoved).toHaveBeenCalledTimes(1);
  });

  it('does not navigate when the move itself refuses', async () => {
    mocks.movePortfolioIntoVault.mockRejectedValue(new Error('refused'));
    const user = userEvent.setup();
    renderSection({
      captureMoveIn: vi.fn(async () => ({ docVersion: 4 })),
      captureMoveOut: vi.fn(),
    });

    await user.click(await screen.findByRole('button', { name: 'Move into vault' }));
    await user.selectOptions(screen.getByLabelText('Target vault'), VAULT_ID);
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');
    await user.click(screen.getAllByRole('button', { name: 'Move into vault' }).at(-1)!);

    await waitFor(() => expect(mocks.movePortfolioIntoVault).toHaveBeenCalled());
    expect(screen.getByTestId('url')).toHaveTextContent(
      `/portfolio/settings?portfolio=${PORTFOLIO_ID}`,
    );
  });

  it('blocks the move while the target vault is locked on this device', async () => {
    mocks.stateFor.mockResolvedValue({
      status: 'stored+wrapped',
      session: 'locked',
      requiredAction: { kind: 'unlock', credential: 'device-password' },
    });
    const user = userEvent.setup();
    renderSection({ captureMoveIn: vi.fn(), captureMoveOut: vi.fn() });

    await user.click(await screen.findByRole('button', { name: 'Move into vault' }));
    await user.selectOptions(screen.getByLabelText('Target vault'), VAULT_ID);

    expect(await screen.findByText(/Open the target vault on this device/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unlock' })).toHaveAttribute(
      'href',
      `/control/privacy?vault=${VAULT_ID}&action=unlock`,
    );
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');
    expect(screen.getAllByRole('button', { name: 'Move into vault' }).at(-1)!).toBeDisabled();
    expect(mocks.movePortfolioIntoVault).not.toHaveBeenCalled();
  });
});
