import { describe, expect, it } from 'vitest';

import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

import {
  moveInPreconditions,
  moveOutUnlocked,
  resolvePortfolioVaultMoveCapture,
} from './portfolioVaultMove';

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
