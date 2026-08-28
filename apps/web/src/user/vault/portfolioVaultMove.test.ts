import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { verifySessionPassword } from '../../lib/userApi';
import { getPortfolioVaultRevision, movePortfolioIntoVault } from '../../lib/vaultApi';
import {
  moveInPreconditions,
  moveOutUnlocked,
  resolvePortfolioVaultMoveCapture,
  submitPortfolioMoveIn,
  type PortfolioVaultMoveCapture,
} from './portfolioVaultMove';

vi.mock('../../lib/userApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/userApi')>()),
  verifySessionPassword: vi.fn(),
}));

vi.mock('../../lib/vaultApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vaultApi')>()),
  getPortfolioVaultRevision: vi.fn(),
  movePortfolioIntoVault: vi.fn(),
}));

const VAULT: VaultConfig = {
  id: '018f0000-0000-7000-8000-000000000001',
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
  id: '018f0000-0000-7000-8000-000000000004',
  name: 'Trading',
  isDefault: false,
  sortOrder: 1,
  visibility: 'private',
  defaultPayFromCash: false,
  archivedAt: null,
} as PortfolioSummary;

describe('submitPortfolioMoveIn (#1528 F1 half 1)', () => {
  const calls: string[] = [];

  function fakeCapture(): PortfolioVaultMoveCapture {
    return {
      captureMoveIn: vi.fn(async () => {
        calls.push('capture');
        return { docVersion: 1, portfolioDataRevision: 'accepted_by_the_capture' };
      }),
      captureMoveOut: vi.fn(async () => {
        throw new Error('TEST VECTOR: captureMoveOut must not be called');
      }),
    };
  }

  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    vi.mocked(verifySessionPassword).mockImplementation(async () => {
      calls.push('verify');
    });
    vi.mocked(getPortfolioVaultRevision).mockImplementation(async () => {
      calls.push('revision');
      return { portfolioDataRevision: 'opening_token', importBatchCount: 0 };
    });
    vi.mocked(movePortfolioIntoVault).mockImplementation(async () => {
      calls.push('commit');
      return {
        portfolioId: PORTFOLIO.id,
        vaultId: VAULT.id,
        docVersion: 1,
        lifecycleGeneration: 1,
        idempotent: false,
      };
    });
  });

  it('proves a password step-up BEFORE any capture work, then binds revision → capture → commit', async () => {
    const capture = fakeCapture();
    await submitPortfolioMoveIn({
      portfolio: PORTFOLIO,
      vault: VAULT,
      stepUp: { password: 'correct horse' },
      capture,
    });
    // The order is the fix: a mistyped password must be discovered while the
    // vault is still untouched, not after the roster ran ahead of membership.
    expect(calls).toEqual(['verify', 'revision', 'capture', 'commit']);
    expect(verifySessionPassword).toHaveBeenCalledWith('correct horse', 'portfolio-vault-move-in');
    // The commit binds to the token the capture ACCEPTED, with the credential.
    expect(movePortfolioIntoVault).toHaveBeenCalledWith(PORTFOLIO.id, {
      vaultId: VAULT.id,
      docVersion: 1,
      portfolioDataRevision: 'accepted_by_the_capture',
      stepUp: { password: 'correct horse' },
    });
  });

  it('a refused pre-verify stops the flow before a single capture write', async () => {
    // Mutation guard: removing the pre-verify makes the capture run (and write
    // ciphertext + the roster entry) before the wrong password is discovered.
    vi.mocked(verifySessionPassword).mockRejectedValue(
      new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.'),
    );
    const capture = fakeCapture();
    await expect(
      submitPortfolioMoveIn({
        portfolio: PORTFOLIO,
        vault: VAULT,
        stepUp: { password: 'mistyped' },
        capture,
      }),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'INVALID_CREDENTIALS' });
    expect(capture.captureMoveIn).not.toHaveBeenCalled();
    expect(getPortfolioVaultRevision).not.toHaveBeenCalled();
    expect(movePortfolioIntoVault).not.toHaveBeenCalled();
  });

  it('never spends one-shot factors on the pre-verify: TOTP and recovery codes go straight to the commit', async () => {
    for (const stepUp of [{ code: '123456' }, { recoveryCode: 'AAAA-BBBB' }]) {
      calls.length = 0;
      await submitPortfolioMoveIn({
        portfolio: PORTFOLIO,
        vault: VAULT,
        stepUp,
        capture: fakeCapture(),
      });
      expect(verifySessionPassword).not.toHaveBeenCalled();
      expect(calls).toEqual(['revision', 'capture', 'commit']);
      expect(movePortfolioIntoVault).toHaveBeenCalledWith(
        PORTFOLIO.id,
        expect.objectContaining({ stepUp }),
      );
    }
  });
});

describe('resolvePortfolioVaultMoveCapture', () => {
  // The E6 residual this change exists for (#1525): the seam must return the
  // engine so both wizards light up unchanged. Before this change it was
  // literally `return null` and every move refused at the capture step.
  it('returns the production capture engine', () => {
    expect(resolvePortfolioVaultMoveCapture()).not.toBeNull();
  });

  it('returns one engine identity so every surface answers the same question the same way', () => {
    expect(resolvePortfolioVaultMoveCapture()).toBe(resolvePortfolioVaultMoveCapture());
  });

  it('drops the capture-unavailable precondition once the engine resolves', () => {
    const capture = resolvePortfolioVaultMoveCapture();
    const preconditions = moveInPreconditions({
      portfolio: PORTFOLIO,
      vault: VAULT,
      vaultState: { status: 'stored+plain', requiredAction: { kind: 'open-silently' } },
      capture,
    });
    expect(preconditions.map(({ id }) => id)).not.toContain('capture-unavailable');
    expect(preconditions).toEqual([]);
  });

  it('still refuses for genuinely-unready states: a locked vault stays a blocking step', () => {
    const capture = resolvePortfolioVaultMoveCapture();
    const preconditions = moveInPreconditions({
      portfolio: PORTFOLIO,
      vault: VAULT,
      vaultState: {
        status: 'stored+wrapped',
        session: 'locked',
        requiredAction: { kind: 'unlock', credential: 'device-password' },
      },
      capture,
    });
    expect(preconditions.map(({ id }) => id)).toContain('vault-locked');
  });

  it('unlocks move-out only for an openable endpoint state', () => {
    const capture = resolvePortfolioVaultMoveCapture();
    expect(
      moveOutUnlocked(
        { status: 'stored+plain', requiredAction: { kind: 'open-silently' } },
        capture,
      ),
    ).toBe(true);
    expect(
      moveOutUnlocked(
        {
          status: 'stored+wrapped',
          session: 'locked',
          requiredAction: { kind: 'unlock', credential: 'device-password' },
        },
        capture,
      ),
    ).toBe(false);
    expect(
      moveOutUnlocked({ status: 'stored+plain', requiredAction: { kind: 'open-silently' } }, null),
    ).toBe(false);
  });
});
