import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PortfolioStore } from '../../lib/portfolioStore';
import {
  PortfolioStoreResolutionError,
  type PortfolioStoreResolution,
} from './portfolioStoreResolver';
import { resolveVaultedPortfolioStores } from './vaultedPortfolioStores';

/**
 * The production owner of the E6 resolution (#1416): which portfolios end up
 * with a client store, and what a lock does to the ones that already have one.
 */

const VAULT_ID = '018f0000-0000-7000-8000-000000000501';
const ACCOUNT_ID = '018f0000-0000-7000-8000-000000000502';

describe('resolving the vaulted portfolios of one roster', () => {
  it('does no work at all — and loads no vault graph state — for an all-plain roster', async () => {
    const resolve = vi.fn();
    const subscribeToSessionEnd = vi.fn(() => () => {});

    const batch = await resolveVaultedPortfolioStores(
      { accountId: ACCOUNT_ID, portfolios: [plain('p-1'), plain('p-2')], vaults: [] },
      { resolve, subscribeToSessionEnd },
    );

    expect(batch.unlocked.size).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(subscribeToSessionEnd).not.toHaveBeenCalled();
  });

  it('keeps a locked vault out of the map, exactly as before the wiring', async () => {
    const { batch } = await resolveWith([
      { kind: 'plain', portfolio: plain('p-1'), store: {} as PortfolioStore },
      {
        kind: 'vaulted-locked',
        portfolio: vaulted('p-2'),
        vault: vaultConfig(),
        requiredAction: { kind: 'unlock', credential: 'device-password' },
      },
    ]);

    expect(batch.unlocked.size).toBe(0);
  });

  it('exposes exactly the unlocked members, keyed by portfolio id', async () => {
    const { batch } = await resolveWith([
      { kind: 'plain', portfolio: plain('p-1'), store: {} as PortfolioStore },
      unlockedResolution('p-2'),
    ]);

    expect([...batch.unlocked.keys()]).toEqual(['p-2']);
    expect(batch.unlocked.get('p-2')!.vaultId).toBe(VAULT_ID);
    expect(batch.unlocked.get('p-2')!.isCurrent()).toBe(true);
  });

  it('revokes every resolved member the moment the endpoint key session ends', async () => {
    const { batch, endSession, disposed } = await resolveWith([unlockedResolution('p-2')]);
    expect(batch.unlocked.get('p-2')!.isCurrent()).toBe(true);

    endSession();

    // Synchronously false — a surface re-rendered by the same signal shows the
    // stub on its very next paint, with no stale decrypted figure in between.
    expect(batch.unlocked.get('p-2')!.isCurrent()).toBe(false);
    expect(disposed).toEqual([]);
  });

  it('drops its decrypted references and its listener when the batch is disposed', async () => {
    const resolved = await resolveWith([unlockedResolution('p-2')]);

    resolved.batch.dispose();
    resolved.batch.dispose();

    expect(resolved.disposed).toEqual(['p-2']);
    // Once, not twice: a second dispose must not unsubscribe a listener that
    // a LATER batch may already own.
    expect(resolved.released).toBe(1);
    expect(resolved.batch.unlocked.get('p-2')!.isCurrent()).toBe(false);
  });

  it('releases the session listener when the resolution itself fails', async () => {
    let released = 0;
    await expect(
      resolveVaultedPortfolioStores(
        { accountId: ACCOUNT_ID, portfolios: [vaulted('p-2')], vaults: [vaultConfig()] },
        {
          subscribeToSessionEnd: () => () => {
            released += 1;
          },
          resolve: async () => {
            throw new Error('vault unreachable');
          },
        },
      ),
    ).rejects.toThrow('vault unreachable');

    expect(released).toBe(1);
  });

  it('pins each vault to the exact document set it authenticated', async () => {
    const seen: Array<(set: { vaultId: string }) => boolean> = [];
    await resolveVaultedPortfolioStores(
      { accountId: ACCOUNT_ID, portfolios: [vaulted('p-2')], vaults: [vaultConfig()] },
      {
        subscribeToSessionEnd: () => () => {},
        resolve: async (_portfolios, _vaults, dependencies) => {
          seen.push(dependencies.isDocumentSetCurrent as never);
          const resolution = unlockedResolution('p-2');
          return [{ status: 'resolved', portfolio: resolution.portfolio, resolution }];
        },
      },
    );

    const isCurrent = seen[0]!;
    const first = { vaultId: VAULT_ID };
    const second = { vaultId: VAULT_ID };
    expect(isCurrent(first)).toBe(true);
    expect(isCurrent(first)).toBe(true);
    // A different object for the same vault is a RELOAD, not the set this
    // batch's engine derives from.
    expect(isCurrent(second)).toBe(false);
  });

  it('names a portfolio whose open failed instead of dropping it into the locked stub', async () => {
    const failing = vaulted('p-3');
    const opened = unlockedResolution('p-2');
    const batch = await resolveVaultedPortfolioStores(
      { accountId: ACCOUNT_ID, portfolios: [opened.portfolio, failing], vaults: [vaultConfig()] },
      {
        subscribeToSessionEnd: () => () => {},
        resolve: async () => [
          { status: 'resolved', portfolio: opened.portfolio, resolution: opened },
          {
            status: 'failed',
            portfolio: failing,
            cause: new PortfolioStoreResolutionError(
              'VAULT_DOCUMENT_INVALID',
              'The vault header roster disagrees with the server membership.',
            ),
          },
        ],
      },
    );

    // One vault's failure never hides the other's success…
    expect([...batch.unlocked.keys()]).toEqual(['p-2']);
    // …and never hides itself: the surface gets the typed code and the sentence.
    expect(batch.failures.get('p-3')).toEqual({
      vaultId: VAULT_ID,
      code: 'VAULT_DOCUMENT_INVALID',
      message: 'The vault header roster disagrees with the server membership.',
    });
    batch.dispose();
  });
});

async function resolveWith(resolutions: PortfolioStoreResolution[]) {
  const disposed: string[] = [];
  let released = 0;
  let endSession = () => {};
  const batch = await resolveVaultedPortfolioStores(
    {
      accountId: ACCOUNT_ID,
      portfolios: resolutions.map(({ portfolio }) => portfolio),
      vaults: [vaultConfig()],
    },
    {
      subscribeToSessionEnd: (listener) => {
        endSession = listener;
        return () => {
          released += 1;
        };
      },
      // The dependencies the owner built are threaded back into the fake
      // resolutions, so `documentSnapshot()` answers the way the real resolver
      // answers it — through `isDocumentSetCurrent`. Without that the batch's
      // revocation would be asserted against a stub that cannot observe it.
      resolve: async (_portfolios, _vaults, dependencies) =>
        resolutions.map((resolution) => ({
          status: 'resolved' as const,
          portfolio: resolution.portfolio,
          resolution:
            resolution.kind === 'vaulted-unlocked'
              ? bindResolution(resolution, dependencies, () =>
                  disposed.push(resolution.portfolio.id),
                )
              : resolution,
        })),
    },
  );
  return {
    batch,
    disposed,
    endSession,
    get released() {
      return released;
    },
  };
}

/**
 * Give a fake unlocked resolution the same liveness wiring the real one has:
 * one authenticated set object, checked through the owner's own currency
 * predicate, dropped on dispose.
 */
function bindResolution(
  resolution: PortfolioStoreResolution & { kind: 'vaulted-unlocked' },
  dependencies: { isDocumentSetCurrent(set: { vaultId: string }): boolean },
  onDispose: () => void,
): PortfolioStoreResolution {
  const authenticatedSet = { vaultId: VAULT_ID };
  let live = true;
  return {
    ...resolution,
    documentSnapshot: () =>
      live && dependencies.isDocumentSetCurrent(authenticatedSet)
        ? ({ schemaVersion: 1 } as never)
        : null,
    dispose: () => {
      live = false;
      onDispose();
    },
  };
}

function unlockedResolution(id: string): PortfolioStoreResolution {
  return {
    kind: 'vaulted-unlocked',
    portfolio: vaulted(id),
    vault: vaultConfig(),
    engine: {
      derivePortfolio: async () => ({ ok: false, error: unusedFailure() }),
      deriveTaxReport: async () => ({ ok: false, error: unusedFailure() }),
      clearCache: () => {},
      clearTaxCache: () => {},
      revoke: () => {},
    },
    snapshotId: 'vault-document-set-v1:test',
    documentSnapshot: () => ({ schemaVersion: 1 }) as never,
    exportCleartext: async () => ({ ok: false, error: unusedFailure() }),
    dispose: () => {},
  };
}

function unusedFailure() {
  return { code: 'VAULT_LOCKED' as const, message: 'unused in this suite', retryable: true };
}

function plain(id: string): PortfolioSummary {
  return {
    id,
    name: `Portfolio ${id}`,
    visibility: 'private',
    sortOrder: 0,
    isDefault: false,
    defaultPayFromCash: false,
    archivedAt: null,
  };
}

function vaulted(id: string): PortfolioSummary {
  return { ...plain(id), vaultId: VAULT_ID, vaultAlias: 'TEST VECTOR vault' };
}

function vaultConfig(): VaultConfig {
  return {
    id: VAULT_ID,
    name: 'TEST VECTOR vault',
    headerDocId: '018f0000-0000-7000-8000-000000000503',
    commonDocId: '018f0000-0000-7000-8000-000000000504',
    media: ['server'],
    driveConnectionId: null,
    keyFingerprint: 'TESTVECTOR000000',
    retirementProofPublicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    retirementGeneration: 0,
    mediaAttestedAt: null,
    mediaAttestedDriveConnectionId: null,
    createdAt: '2026-08-21T08:00:00.000Z',
    updatedAt: '2026-08-21T08:00:00.000Z',
  };
}
