import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

/**
 * #2000 — end to end through the REAL api client: a wrong §15 step-up credential
 * must surface inside the dialog that asked for it and must never reach the
 * app-wide auth policy, which is the thing that signs the user out and bounces
 * them to `/login`.
 *
 * Everything below the surface is real here on purpose: the dialog, the flow
 * module, the api wrapper and `apiRequest`'s response policy. A test that mocked
 * `vaultApi` (as `VaultManager.test.tsx` does, for its own reasons) would keep
 * passing with the suppression removed, because the wire is exactly where the
 * bug lived. Only the keystore, auth and portfolio-roster seams are stubbed —
 * none of them decide auth policy.
 */
const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000000a1';
const VAULT_ID = '018f0000-0000-7000-8000-0000000000a2';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-0000000000a3';

const mocks = vi.hoisted(() => ({
  listPortfolios: vi.fn(),
  useVaultedPortfolioStores: vi.fn(),
  stateFor: vi.fn(),
  getTwoFactorStatus: vi.fn(),
  logout: vi.fn(),
  prepareDriveStorage: vi.fn(),
  unlockFromDevice: vi.fn(),
}));

// Partial: only the roster read is stubbed. The rest of the module is pulled in
// by the E6 capture engine and must stay real.
vi.mock('../../../lib/portfolioApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/portfolioApi')>()),
  listPortfolios: mocks.listPortfolios,
}));
vi.mock('../useVaultedPortfolioStores', () => ({
  useVaultedPortfolioStores: mocks.useVaultedPortfolioStores,
}));
vi.mock('../../AuthContext', () => ({
  useAuth: () => ({ user: { id: ACCOUNT_ID, username: 'ada' }, logout: mocks.logout }),
  useOptionalAuth: () => ({ status: 'authenticated', user: { id: ACCOUNT_ID } }),
}));
vi.mock('../keystore/runtime', () => ({
  endpointVaultKeystore: { stateFor: mocks.stateFor },
  resumeEndpointSessionOnce: async () => ({ unlockedVaultIds: [] }),
  bindEndpointKeystoreAccount: () => undefined,
}));
vi.mock('../../../lib/twoFactorApi', () => ({ getTwoFactorStatus: mocks.getTwoFactorStatus }));
vi.mock('../VaultRuntimeProvider', () => ({
  useVaultRuntime: () => ({
    phase: 'locked',
    unlockFromDevice: mocks.unlockFromDevice,
    unlockWithPassphrase: vi.fn(),
    unlockWithRecoveryKit: vi.fn(),
    prepareDriveStorage: mocks.prepareDriveStorage,
  }),
}));

import { setAuthResponsePolicy } from '../../../lib/apiClient';
import { submitPortfolioMoveIn, submitPortfolioMoveOut } from '../portfolioVaultMove';
import type { PortfolioVaultMoveCapture } from '../portfolioVaultMove';
import { discardLockedVault } from './disable';
import { PortfolioVaultMoveWizard } from './PortfolioVaultMoveWizard';
import { VaultManager } from './VaultManager';
import { VaultUnlockGate } from './VaultUnlockGate';

const VAULT: VaultConfig = {
  id: VAULT_ID,
  name: 'Long-term vault',
  headerDocId: '018f0000-0000-7000-8000-0000000000b1',
  commonDocId: '018f0000-0000-7000-8000-0000000000b2',
  media: ['server'],
  driveConnectionId: null,
  keyFingerprint: 'abcdefghijklmnop',
  retirementProofPublicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  retirementGeneration: 0,
  mediaAttestedAt: '2026-08-20T10:00:00.000Z',
  mediaAttestedDriveConnectionId: null,
  createdAt: '2026-08-20T09:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

const PORTFOLIO = {
  id: PORTFOLIO_ID,
  name: 'Retirement',
  vaultAlias: null,
  vaultId: null,
  isDefault: true,
  sortOrder: 0,
  visibility: 'private',
  defaultPayFromCash: false,
  archivedAt: null,
  createdAt: '2026-08-20T09:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
} as PortfolioSummary;

/** The §15 refusal, verbatim: a generic 401 that never names the wrong factor. */
function refusedCredential(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'INVALID_CREDENTIALS', message: 'Re-authentication failed.' },
    }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * One routing stub, so each case declares only the refusal it is about and the
 * reads that have to succeed for the ceremony to reach it.
 */
function stubApi(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const key = `${init.method ?? 'GET'} ${url.split('?')[0]}`;
    const route = routes[key];
    if (!route) return Promise.reject(new Error(`unrouted request: ${key}`));
    return Promise.resolve(route());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Every hook the app-wide policy owns; a gated refusal may fire NONE of them. */
function installAuthPolicy() {
  const policy = {
    onUnauthorized: vi.fn(),
    onPasswordChangeRequired: vi.fn(),
    onRateLimited: vi.fn(),
  };
  const dispose = setAuthResponsePolicy(policy);
  return { policy, dispose };
}

function expectSessionIntact(policy: ReturnType<typeof installAuthPolicy>['policy']) {
  expect(policy.onUnauthorized).not.toHaveBeenCalled();
  expect(policy.onPasswordChangeRequired).not.toHaveBeenCalled();
  expect(policy.onRateLimited).not.toHaveBeenCalled();
  expect(mocks.logout).not.toHaveBeenCalled();
}

let seenPath = '';

function LocationProbe() {
  seenPath = useLocation().pathname;
  return null;
}

function renderIn(node: React.ReactNode, initialPath = '/control/privacy') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationProbe />
        {node}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The E6 engine seam: this test is about the refusal, not about ciphertext. */
const CAPTURE: PortfolioVaultMoveCapture = {
  captureMoveIn: vi.fn(async () => ({ docVersion: 4 })),
  captureMoveOut: vi.fn(async () => ({
    lifecycleGeneration: 1,
    documentDigest: 'D'.repeat(43),
    documentSetHash: 'E'.repeat(43),
    document: { schemaVersion: 1 as const, entities: [], mergeLog: [], mirrorProvenance: [] },
    sign: async () => 'S'.repeat(86),
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  seenPath = '';
  mocks.listPortfolios.mockResolvedValue({ portfolios: [], defaultPortfolioId: null });
  mocks.useVaultedPortfolioStores.mockReturnValue({ unlocked: new Map() });
  mocks.stateFor.mockResolvedValue({
    status: 'stored+wrapped',
    session: 'unlocked',
    requiredAction: null,
  });
  mocks.getTwoFactorStatus.mockResolvedValue({
    totpEnabled: false,
    totpPending: false,
    emailEnabled: false,
    recoveryCodesRemaining: 0,
  });
  mocks.unlockFromDevice.mockResolvedValue(false);
  mocks.prepareDriveStorage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a wrong §15 step-up credential never logs the user out', () => {
  it('delete vault: the refusal stays in the dialog, the session and the route are untouched', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      const fetchMock = stubApi({
        'GET /api/v1/vaults': () => json({ vaults: [VAULT] }),
        [`DELETE /api/v1/vaults/${VAULT_ID}`]: refusedCredential,
      });
      const user = userEvent.setup();
      renderIn(<VaultManager operations={{ provision: vi.fn(), fetchHeader: vi.fn() }} />);

      await user.click(await screen.findByRole('button', { name: 'Delete' }));
      await user.type(screen.getByLabelText('Account confirmation'), 'mistyped-password');
      await user.click(screen.getByRole('button', { name: 'Delete empty vault' }));

      expect(
        await screen.findByText('The vault could not be deleted. Nothing changed.'),
      ).toBeInTheDocument();
      // The dialog is still standing, with the credential field the owner can
      // correct — not a login screen.
      expect(screen.getByLabelText('Account confirmation')).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'DELETE'),
      ).toHaveLength(1);
      expect(seenPath).toBe('/control/privacy');
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('move-in: an authenticator code the commit refuses is a wizard error, not a logout', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({
        [`GET /api/v1/portfolios/${PORTFOLIO_ID}/vault/revision`]: () =>
          json({ portfolioDataRevision: 'rev-1', importBatchCount: 0 }),
        [`POST /api/v1/portfolios/${PORTFOLIO_ID}/vault/move-in`]: refusedCredential,
      });
      const user = userEvent.setup();
      renderIn(
        <PortfolioVaultMoveWizard
          mode="in"
          onCancel={vi.fn()}
          onSubmit={({ vaultId, stepUp }) =>
            submitPortfolioMoveIn({
              portfolio: PORTFOLIO,
              vault: { ...VAULT, id: vaultId },
              stepUp,
              capture: CAPTURE,
            }).then(() => undefined)
          }
          portfolioName="Retirement"
          vaults={[{ id: VAULT_ID, name: VAULT.name }]}
        />,
      );

      await user.selectOptions(screen.getByLabelText('Target vault'), VAULT_ID);
      // A TOTP code is never pre-verified — it is a one-shot consumable that has
      // to reach the commit's same-lock verifier unspent — so this is the path
      // that used to hit the unsuppressed move-in call directly.
      await user.selectOptions(screen.getByLabelText('Confirmation method'), 'code');
      await user.type(screen.getByLabelText('Account confirmation'), '000000');
      await user.click(screen.getByRole('button', { name: 'Move into vault' }));

      expect(
        await screen.findByText('The portfolio was not moved. Its server data is unchanged.'),
      ).toBeInTheDocument();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('move-in: the pre-verified password path (#1528 F1) stays in-form too', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({ 'POST /api/v1/auth/reauth': refusedCredential });
      const user = userEvent.setup();
      renderIn(
        <PortfolioVaultMoveWizard
          mode="in"
          onCancel={vi.fn()}
          onSubmit={({ vaultId, stepUp }) =>
            submitPortfolioMoveIn({
              portfolio: PORTFOLIO,
              vault: { ...VAULT, id: vaultId },
              stepUp,
              capture: CAPTURE,
            }).then(() => undefined)
          }
          portfolioName="Retirement"
          vaults={[{ id: VAULT_ID, name: VAULT.name }]}
        />,
      );

      await user.selectOptions(screen.getByLabelText('Target vault'), VAULT_ID);
      await user.type(screen.getByLabelText('Account confirmation'), 'mistyped-password');
      await user.click(screen.getByRole('button', { name: 'Move into vault' }));

      expect(
        await screen.findByText('The portfolio was not moved. Its server data is unchanged.'),
      ).toBeInTheDocument();
      // Nothing was captured and nothing was committed: the pre-verify is the
      // whole point of #1528 F1.
      expect(CAPTURE.captureMoveIn).not.toHaveBeenCalled();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('move-out: the commit is the ONLY credential check, and its refusal is in-form', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({
        [`POST /api/v1/portfolios/${PORTFOLIO_ID}/vault/move-out/challenge`]: () =>
          json({
            portfolioId: PORTFOLIO_ID,
            vaultId: VAULT_ID,
            lifecycleGeneration: 1,
            documentDigest: 'D'.repeat(43),
            documentSetHash: 'E'.repeat(43),
            challenge: 'C'.repeat(64),
            expiresAt: '2026-09-16T12:00:00.000Z',
          }),
        [`POST /api/v1/portfolios/${PORTFOLIO_ID}/vault/move-out`]: refusedCredential,
      });
      const user = userEvent.setup();
      renderIn(
        <PortfolioVaultMoveWizard
          mode="out"
          onCancel={vi.fn()}
          onSubmit={({ stepUp }) =>
            submitPortfolioMoveOut({
              portfolio: PORTFOLIO,
              vault: VAULT,
              stepUp,
              capture: CAPTURE,
            }).then(() => undefined)
          }
          portfolioName="Retirement"
          unlocked
          vaultName={VAULT.name}
        />,
      );

      await user.click(screen.getByRole('checkbox', { name: /becomes server-readable again/i }));
      await user.type(screen.getByLabelText('Account confirmation'), 'mistyped-password');
      await user.click(screen.getByRole('button', { name: 'Restore as a normal portfolio' }));

      expect(await screen.findByText(/It remains locked in the vault/i)).toBeInTheDocument();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('start fresh: the locked-vault discard refuses in the stuck fold, not at the login screen', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({ 'POST /api/v1/account/paranoid/disable': refusedCredential });
      const user = userEvent.setup();
      renderIn(
        <VaultUnlockGate
          mediaSet={['server']}
          onStartFresh={(credential) =>
            discardLockedVault(ACCOUNT_ID, credential).then(() => undefined)
          }
        />,
      );

      await user.type(await screen.findByLabelText('Type your username (ada) to confirm'), 'ada');
      await user.type(screen.getByLabelText('Current account password'), 'mistyped-password');
      await user.click(screen.getByRole('button', { name: 'Discard the vault and start fresh' }));

      expect(await screen.findByText(/The vault could not be discarded/i)).toBeInTheDocument();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });
});
