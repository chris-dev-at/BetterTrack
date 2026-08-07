import type { VaultHeaderDoc, VaultSummary } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { foldVaultCoverage, qualifierFor } from './aggregates';
import type { VaultKnowledge } from './sectionState';
import { FIXTURE_PORTFOLIO_A, FIXTURE_PORTFOLIO_B, FIXTURE_VAULT_ID } from './testSupport';

const NORMAL_PORTFOLIO = '33333333-3333-4333-8333-333333333333';

function summary(overrides: Partial<VaultSummary> = {}): VaultSummary {
  return {
    id: FIXTURE_VAULT_ID,
    name: 'Drive vault',
    backends: ['drive'],
    createdAt: '2026-08-08T09:00:00.000Z',
    portfolioIds: [],
    ...overrides,
  };
}

function header(portfolioIds: string[]): VaultHeaderDoc {
  return {
    formatVersion: 2,
    vaultId: FIXTURE_VAULT_ID,
    name: 'Drive vault',
    kdfSalt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    keySlots: [
      { slotId: '8f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a08', kind: 'passphrase', wrappedKey: 'AAAA' },
    ],
    portfolios: portfolioIds.map((portfolioId, index) => ({
      portfolioId,
      alias: `Vault portfolio ${index + 1}`,
    })),
    backends: ['drive'],
    headerVersion: 1,
    deviceId: '2f2f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a02',
    writeId: '6f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a03',
    writtenAt: '2026-08-08T09:00:00.000Z',
    seal: null,
  };
}

function knowledge(overrides: Partial<VaultKnowledge> = {}): VaultKnowledge {
  return {
    summary: summary(),
    header: header([FIXTURE_PORTFOLIO_A, FIXTURE_PORTFOLIO_B]),
    unlocked: false,
    rememberedOnDevice: false,
    ...overrides,
  };
}

describe('aggregate coverage with locked vaults (r2 §12)', () => {
  it('is complete when nothing is locked', () => {
    const result = foldVaultCoverage({
      visible: [{ portfolioId: NORMAL_PORTFOLIO, value: 1000 }],
      vaults: [],
    });
    expect(result).toMatchObject({
      visibleTotal: 1000,
      lockedCount: 0,
      coverage: 'complete',
      requiresQualifier: false,
    });
    expect(qualifierFor(result)).toBeNull();
  });

  it('never renders a bare total while a vault is locked', () => {
    const result = foldVaultCoverage({
      visible: [{ portfolioId: NORMAL_PORTFOLIO, value: 1000 }],
      vaults: [knowledge()],
    });
    expect(result).toMatchObject({
      visibleTotal: 1000,
      lockedCount: 2,
      coverage: 'lockedExcluded',
      requiresQualifier: true,
    });
    expect(qualifierFor(result)).toEqual({
      key: 'vault.v2.aggregate.locked',
      vars: { count: 2 },
    });
  });

  it('stops counting a vault once it is unlocked and its rows are visible', () => {
    const result = foldVaultCoverage({
      visible: [
        { portfolioId: NORMAL_PORTFOLIO, value: 1000 },
        { portfolioId: FIXTURE_PORTFOLIO_A, value: 250 },
        { portfolioId: FIXTURE_PORTFOLIO_B, value: 750 },
      ],
      vaults: [knowledge({ unlocked: true })],
    });
    expect(result).toMatchObject({
      visibleTotal: 2000,
      lockedCount: 0,
      coverage: 'complete',
      requiresQualifier: false,
    });
  });

  it('lets a locked vault whose rows are already summed contribute nothing', () => {
    // Defensive: a caller that somehow summed a locked portfolio must not also
    // be told it was excluded.
    const result = foldVaultCoverage({
      visible: [{ portfolioId: FIXTURE_PORTFOLIO_A, value: 250 }],
      vaults: [knowledge({ header: header([FIXTURE_PORTFOLIO_A]) })],
    });
    expect(result.lockedCount).toBe(0);
    expect(result.coverage).toBe('complete');
  });

  it('names each locked vault for its lock chip', () => {
    const other = '7f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a07';
    const result = foldVaultCoverage({
      visible: [],
      vaults: [
        knowledge({ header: header([FIXTURE_PORTFOLIO_A]) }),
        knowledge({
          summary: summary({ id: other, name: 'Server vault', portfolioIds: [NORMAL_PORTFOLIO] }),
          header: null,
        }),
      ],
    });
    expect(result.lockedVaults).toEqual([
      { vaultId: FIXTURE_VAULT_ID, name: 'Drive vault', portfolioCount: 1 },
      { vaultId: other, name: 'Server vault', portfolioCount: 1 },
    ]);
    expect(result.lockedCount).toBe(2);
  });

  it('counts a server-listed member the header has not indexed yet', () => {
    const result = foldVaultCoverage({
      visible: [],
      vaults: [knowledge({ header: null, summary: summary({ portfolioIds: [NORMAL_PORTFOLIO] }) })],
    });
    expect(result.lockedCount).toBe(1);
  });

  it('reports an unreadable blob as unavailable, never as €0', () => {
    const result = foldVaultCoverage({
      visible: [{ portfolioId: NORMAL_PORTFOLIO, value: 1000 }],
      vaults: [knowledge({ unlocked: true })],
      unavailablePortfolioIds: [FIXTURE_PORTFOLIO_A],
    });
    expect(result).toMatchObject({
      coverage: 'unavailable',
      unavailableCount: 1,
      requiresQualifier: true,
    });
    expect(qualifierFor(result)).toEqual({
      key: 'vault.v2.aggregate.unavailable',
      vars: { count: 1 },
    });
  });

  it('combines a locked vault and an unreadable blob in one qualifier', () => {
    const result = foldVaultCoverage({
      visible: [],
      vaults: [knowledge({ header: header([FIXTURE_PORTFOLIO_A, FIXTURE_PORTFOLIO_B]) })],
      unavailablePortfolioIds: [FIXTURE_PORTFOLIO_B],
    });
    expect(result.lockedCount).toBe(1);
    expect(result.unavailableCount).toBe(1);
    expect(qualifierFor(result)).toEqual({
      key: 'vault.v2.aggregate.lockedAndUnavailable',
      vars: { locked: 1, unavailable: 1 },
    });
  });

  it('lets a locked vault outrank a merely partial price coverage', () => {
    const result = foldVaultCoverage({
      visible: [{ portfolioId: NORMAL_PORTFOLIO, value: 1000 }],
      vaults: [knowledge()],
      priceCoverage: 'partial',
    });
    expect(result.coverage).toBe('lockedExcluded');
  });

  it('keeps a partial price coverage when no vault is locked', () => {
    const result = foldVaultCoverage({
      visible: [{ portfolioId: NORMAL_PORTFOLIO, value: 1000 }],
      vaults: [knowledge({ unlocked: true })],
      priceCoverage: 'partial',
    });
    expect(result.coverage).toBe('partial');
  });
});
