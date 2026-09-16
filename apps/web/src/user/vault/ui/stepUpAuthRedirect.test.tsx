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

import de from '../../../i18n/messages/de.json';
import en from '../../../i18n/messages/en.json';
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

/**
 * #2028 — the OTHER §15 answer these dialogs can get: the 429 emitted by the
 * per-account progressive step-up throttle AND by the module's route limiter,
 * indistinguishably. `Retry-After` is present because the server sends it; no
 * surface is allowed to render it (see the §15 gate at the bottom of this file).
 */
function throttled(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }),
    {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    },
  );
}

/**
 * The two answers, verbatim from the EN catalog, per dialog. Pinned as literals
 * rather than read through `t()` so that a catalog edit which collapses the two
 * back into one string fails here instead of passing a test that compares a
 * value to itself.
 */
const REFUSAL_COPY = {
  delete: 'The vault could not be deleted. Nothing changed.',
  moveIn: 'The portfolio was not moved. Its server data is unchanged.',
  moveOut:
    'The portfolio could not be restored completely. It remains locked in the vault; retry resumes the same move.',
  discard:
    'The vault could not be discarded. Nothing changed — try again when the connection is available.',
} as const;

const THROTTLE_COPY = {
  delete: 'Too many attempts. Wait a moment, then try the deletion again. Nothing changed.',
  moveIn:
    'Too many attempts. Wait a moment, then try again. The portfolio was not moved and its server data is unchanged.',
  moveOut:
    'Too many attempts. Wait a moment, then try again. The portfolio stays locked in the vault until it succeeds.',
  discard: 'Too many attempts. Wait a moment, then try the discard again. Nothing changed.',
} as const;

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

      expect(await screen.findByText(REFUSAL_COPY.delete)).toBeInTheDocument();
      expect(screen.queryByText(THROTTLE_COPY.delete)).not.toBeInTheDocument();
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

      expect(await screen.findByText(REFUSAL_COPY.moveIn)).toBeInTheDocument();
      expect(screen.queryByText(THROTTLE_COPY.moveIn)).not.toBeInTheDocument();
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

      expect(await screen.findByText(REFUSAL_COPY.moveIn)).toBeInTheDocument();
      expect(screen.queryByText(THROTTLE_COPY.moveIn)).not.toBeInTheDocument();
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

      expect(await screen.findByText(REFUSAL_COPY.moveOut)).toBeInTheDocument();
      expect(screen.queryByText(THROTTLE_COPY.moveOut)).not.toBeInTheDocument();
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

      expect(await screen.findByText(REFUSAL_COPY.discard)).toBeInTheDocument();
      expect(screen.queryByText(THROTTLE_COPY.discard)).not.toBeInTheDocument();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });
});

/**
 * #2028 — the SAME four dialogs, answering the other §15 refusal. Before this
 * change every one of them rendered its credential-refusal line for a 429, so
 * an owner holding a CORRECT password was told it was wrong and re-entered it,
 * driving the per-account progressive throttle deeper on every attempt.
 *
 * Each case asserts both halves: the throttle line is shown AND the refusal
 * line is not. Asserting only the first would pass on a dialog that stacked the
 * new copy on top of the old, which is the failure mode that matters here — the
 * owner must not be told "wrong credential" at all.
 *
 * `expectSessionIntact` carries the rest of the acceptance for free: it is the
 * app-wide policy's own `onRateLimited` (the toast #2025 stopped firing on gated
 * calls), `onUnauthorized` and the logout seam.
 */
describe('a throttled §15 step-up says "wait", never "wrong credential"', () => {
  it('delete vault: the 429 is a wait, and the dialog stays open on the entry', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({
        'GET /api/v1/vaults': () => json({ vaults: [VAULT] }),
        [`DELETE /api/v1/vaults/${VAULT_ID}`]: throttled,
      });
      const user = userEvent.setup();
      renderIn(<VaultManager operations={{ provision: vi.fn(), fetchHeader: vi.fn() }} />);

      await user.click(await screen.findByRole('button', { name: 'Delete' }));
      await user.type(screen.getByLabelText('Account confirmation'), 'the-correct-password');
      await user.click(screen.getByRole('button', { name: 'Delete empty vault' }));

      expect(await screen.findByText(THROTTLE_COPY.delete)).toBeInTheDocument();
      expect(screen.queryByText(REFUSAL_COPY.delete)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Account confirmation')).toBeInTheDocument();
      expect(seenPath).toBe('/control/privacy');
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('move-in: a 429 from the COMMIT is a wait, not a refused authenticator code', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({
        [`GET /api/v1/portfolios/${PORTFOLIO_ID}/vault/revision`]: () =>
          json({ portfolioDataRevision: 'rev-1', importBatchCount: 0 }),
        [`POST /api/v1/portfolios/${PORTFOLIO_ID}/vault/move-in`]: throttled,
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
      await user.selectOptions(screen.getByLabelText('Confirmation method'), 'code');
      await user.type(screen.getByLabelText('Account confirmation'), '000000');
      await user.click(screen.getByRole('button', { name: 'Move into vault' }));

      expect(await screen.findByText(THROTTLE_COPY.moveIn)).toBeInTheDocument();
      expect(screen.queryByText(REFUSAL_COPY.moveIn)).not.toBeInTheDocument();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('move-in: a 429 from the PRE-VERIFY (#1528 F1) reads the same, and captures nothing', async () => {
    // `/auth/reauth` throttles on its own namespace, so this 429 and the commit's
    // are two different limiters reaching one surface. §15 requires them to be
    // indistinguishable there, which is exactly what asserting the same string
    // in both cases pins.
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({ 'POST /api/v1/auth/reauth': throttled });
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
      await user.type(screen.getByLabelText('Account confirmation'), 'the-correct-password');
      await user.click(screen.getByRole('button', { name: 'Move into vault' }));

      expect(await screen.findByText(THROTTLE_COPY.moveIn)).toBeInTheDocument();
      expect(screen.queryByText(REFUSAL_COPY.moveIn)).not.toBeInTheDocument();
      expect(CAPTURE.captureMoveIn).not.toHaveBeenCalled();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it("move-out: the commit's 429 is a wait, and the portfolio is still in the vault", async () => {
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
        [`POST /api/v1/portfolios/${PORTFOLIO_ID}/vault/move-out`]: throttled,
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
      await user.type(screen.getByLabelText('Account confirmation'), 'the-correct-password');
      await user.click(screen.getByRole('button', { name: 'Restore as a normal portfolio' }));

      expect(await screen.findByText(THROTTLE_COPY.moveOut)).toBeInTheDocument();
      expect(screen.queryByText(REFUSAL_COPY.moveOut)).not.toBeInTheDocument();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('start fresh: the stuck fold asks for a wait rather than a re-typed password', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({ 'POST /api/v1/account/paranoid/disable': throttled });
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
      await user.type(screen.getByLabelText('Current account password'), 'the-correct-password');
      await user.click(screen.getByRole('button', { name: 'Discard the vault and start fresh' }));

      expect(await screen.findByText(THROTTLE_COPY.discard)).toBeInTheDocument();
      expect(screen.queryByText(REFUSAL_COPY.discard)).not.toBeInTheDocument();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });
});

/**
 * §15's actual requirement, stated over the catalogs rather than over one
 * render: the per-account progressive throttle and the route limiter must be
 * INDISTINGUISHABLE in copy, because naming which one fired discloses whether
 * the credential path was reached at all.
 *
 * So no throttle string may name a limiter, a window, a countdown or the factor
 * that was being checked — and all five say the same thing, in the same words,
 * for whichever limiter fired.
 */
describe('the §15 throttle copy discloses nothing about which limiter fired', () => {
  const THROTTLE_KEYS = [
    ['vault', 'manager', 'deleteThrottled'],
    ['vault', 'portfolioMove', 'moveIn', 'throttled'],
    ['vault', 'portfolioMove', 'moveOut', 'throttled'],
    ['vault', 'unlock', 'stuck', 'throttled'],
    ['settings', 'connections', 'driveAccounts', 'acknowledgeThrottled'],
  ] as const;

  /**
   * Terms that would betray the limiter (which one, how long, how many left) or
   * the factor being verified. `attempt`/`Versuch` is deliberately absent: the
   * copy has to say what happened, and "too many attempts" is true of both
   * limiters.
   */
  const DISCLOSING = [
    /\bpassword\b/i,
    /\bpasswort\b/i,
    /\bcode\b/i,
    /\bcredential/i,
    /\brate.?limit/i,
    /\bthrottl/i,
    /\bdrossel/i,
    /\broute\b/i,
    /\bendpoint\b/i,
    /\baccount\b/i,
    /\bkonto\b/i,
    /\b\d+\s*(?:s|sec|second|seconds|min|minute|minutes|Sekunde|Sekunden|Minute|Minuten)\b/i,
  ];

  function read(catalog: unknown, path: readonly string[]): string {
    let node: unknown = catalog;
    for (const segment of path) {
      expect(node, `missing before ${segment} in ${path.join('.')}`).toBeTypeOf('object');
      node = (node as Record<string, unknown>)[segment];
    }
    expect(node, `${path.join('.')} is not a string`).toBeTypeOf('string');
    return node as string;
  }

  it('the disclosure probe is not vacuous', () => {
    const bad = 'Account rate limit reached — wrong password, retry in 30 seconds.';
    expect(DISCLOSING.filter((pattern) => pattern.test(bad))).toHaveLength(4);
    // …and it does not fire on the copy's own vocabulary.
    expect(DISCLOSING.some((pattern) => pattern.test('Too many attempts. Wait a moment.'))).toBe(
      false,
    );
  });

  for (const [code, catalog] of [
    ['en', en],
    ['de', de],
  ] as const) {
    it(`${code}: every §15 throttle line names no limiter, factor or countdown`, () => {
      for (const path of THROTTLE_KEYS) {
        const value = read(catalog, path);
        const leaked = DISCLOSING.filter((pattern) => pattern.test(value)).map(String);
        expect(leaked, `${code}.${path.join('.')} leaks: ${value}`).toEqual([]);
      }
    });

    it(`${code}: all five open with the same sentence, whichever limiter fired`, () => {
      // Only the opening is shared. What follows says which ceremony did not
      // happen — dialog identity, which the owner already knows and which
      // discloses nothing about the limiter.
      const openings = THROTTLE_KEYS.map((path) => read(catalog, path).split('.')[0]);
      expect(new Set(openings).size, `openings drifted: ${openings.join(' | ')}`).toBe(1);
      expect(openings[0]).toBe(code === 'en' ? 'Too many attempts' : 'Zu viele Versuche');
    });
  }
});
