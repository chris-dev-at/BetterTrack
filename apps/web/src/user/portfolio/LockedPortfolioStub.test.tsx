import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

const VAULT_ID = '018f0000-0000-7000-8000-000000000002';

const mocks = vi.hoisted(() => ({
  listVaults: vi.fn(),
  movePortfolioOutOfVault: vi.fn(),
  requestPortfolioMoveOutChallenge: vi.fn(),
}));

vi.mock('../../lib/vaultApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vaultApi')>()),
  VAULTS_QUERY_KEY: ['vaults', 'configs'],
  listVaults: mocks.listVaults,
  getPortfolioVaultRevision: vi.fn(),
  getPortfolioVaultLifecycle: vi.fn(),
  getVaultMediaState: vi.fn(),
  transitionVaultMedia: vi.fn(),
  writeVaultDocument: vi.fn(),
  movePortfolioIntoVault: vi.fn(),
  movePortfolioOutOfVault: mocks.movePortfolioOutOfVault,
  requestPortfolioMoveOutChallenge: mocks.requestPortfolioMoveOutChallenge,
}));

import { LockedPortfolioStub } from './LockedPortfolioStub';

const portfolio = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Never reveal this name',
  vaultAlias: 'Vault portfolio 2',
  vaultId: VAULT_ID,
} as PortfolioSummary & { vaultId: string };

const VAULT: VaultConfig = {
  id: VAULT_ID,
  name: 'Long-term vault',
  headerDocId: '018f0000-0000-7000-8000-000000000003',
  commonDocId: '018f0000-0000-7000-8000-000000000004',
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

function renderStub(props: Partial<Parameters<typeof LockedPortfolioStub>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LockedPortfolioStub
          portfolio={portfolio}
          state={{
            status: 'stored+wrapped',
            session: 'locked',
            requiredAction: { kind: 'unlock', credential: 'device-password' },
          }}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listVaults.mockResolvedValue([VAULT]);
});

describe('LockedPortfolioStub', () => {
  it('renders only the server alias and the action implied by E3 state', async () => {
    const user = userEvent.setup();
    renderStub();

    expect(screen.getByRole('heading', { name: 'Vault portfolio 2' })).toBeInTheDocument();
    expect(screen.queryByText('Never reveal this name')).not.toBeInTheDocument();
    // #4, the owner's oracle: open the portfolio, get prompted, unlock. The
    // stub prompts in place instead of linking into the Control Center.
    expect(screen.queryByRole('link', { name: 'Unlock' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByLabelText('Device password')).toBeInTheDocument();
  });

  it('offers the §10 move-out wizard and states the server-readable price', async () => {
    const user = userEvent.setup();
    renderStub();

    await user.click(screen.getByRole('button', { name: 'Restore as a normal portfolio' }));
    expect(
      await screen.findByRole('heading', { name: 'Move portfolio out of the vault' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/server-readable again/i)).not.toHaveLength(0);
  });

  it('fires no move-out request while the step-up credential is missing', async () => {
    const user = userEvent.setup();
    renderStub({
      capture: { captureMoveIn: vi.fn(), captureMoveOut: vi.fn() },
      state: { status: 'stored+plain', requiredAction: { kind: 'open-silently' } },
    });

    await user.click(screen.getByRole('button', { name: 'Restore as a normal portfolio' }));
    await screen.findByRole('heading', { name: 'Move portfolio out of the vault' });
    await user.click(
      screen.getByRole('checkbox', { name: /portfolio becomes server-readable again/i }),
    );

    const commit = screen.getAllByRole('button', { name: 'Restore as a normal portfolio' }).at(-1)!;
    expect(commit).toBeDisabled();
    await user.click(commit);
    expect(mocks.requestPortfolioMoveOutChallenge).not.toHaveBeenCalled();
    expect(mocks.movePortfolioOutOfVault).not.toHaveBeenCalled();
  });

  it('runs the challenge round trip and sends the step-up in the commit body', async () => {
    const user = userEvent.setup();
    const restoreDocument = { schemaVersion: 1 } as never;
    mocks.requestPortfolioMoveOutChallenge.mockResolvedValue({
      portfolioId: portfolio.id,
      vaultId: VAULT_ID,
      lifecycleGeneration: 2,
      documentDigest: 'd'.repeat(43),
      documentSetHash: 'h'.repeat(43),
      challenge: 'c'.repeat(48),
      expiresAt: '2026-08-21T10:05:00.000Z',
    });
    mocks.movePortfolioOutOfVault.mockResolvedValue({
      portfolioId: portfolio.id,
      vaultId: VAULT_ID,
      moveOutId: '018f0000-0000-7000-8000-0000000000ff',
      lifecycleGeneration: 2,
      idempotent: false,
    });
    renderStub({
      capture: {
        captureMoveIn: vi.fn(),
        captureMoveOut: vi.fn(async () => ({
          lifecycleGeneration: 2,
          documentDigest: 'd'.repeat(43),
          documentSetHash: 'h'.repeat(43),
          document: restoreDocument,
          sign: async () => 's'.repeat(86),
        })),
      },
      state: { status: 'stored+plain', requiredAction: { kind: 'open-silently' } },
    });

    await user.click(screen.getByRole('button', { name: 'Restore as a normal portfolio' }));
    await screen.findByRole('heading', { name: 'Move portfolio out of the vault' });
    await user.click(
      screen.getByRole('checkbox', { name: /portfolio becomes server-readable again/i }),
    );
    await user.type(screen.getByLabelText('Account confirmation'), 'account-secret');
    await user.click(
      screen.getAllByRole('button', { name: 'Restore as a normal portfolio' }).at(-1)!,
    );

    await waitFor(() => expect(mocks.movePortfolioOutOfVault).toHaveBeenCalledOnce());
    expect(mocks.requestPortfolioMoveOutChallenge).toHaveBeenCalledWith(portfolio.id, {
      vaultId: VAULT_ID,
      lifecycleGeneration: 2,
      documentDigest: 'd'.repeat(43),
      documentSetHash: 'h'.repeat(43),
    });
    expect(mocks.movePortfolioOutOfVault.mock.calls[0]?.[1]).toMatchObject({
      vaultId: VAULT_ID,
      lifecycleGeneration: 2,
      vaultProof: { challenge: 'c'.repeat(48), signature: 's'.repeat(86) },
      stepUp: { password: 'account-secret' },
    });
  });
});
