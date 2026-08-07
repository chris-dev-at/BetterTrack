import type { VaultHeaderDoc, VaultSummary } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import {
  lockedPortfolioIndex,
  lockedPortfolioRows,
  resolveVaultSectionState,
  type VaultKnowledge,
} from './sectionState';
import { FIXTURE_PORTFOLIO_A, FIXTURE_PORTFOLIO_B, FIXTURE_VAULT_ID } from './testSupport';

const OTHER_VAULT_ID = '7f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a07';

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

function header(portfolios: { portfolioId: string; alias: string }[]): VaultHeaderDoc {
  return {
    formatVersion: 2,
    vaultId: FIXTURE_VAULT_ID,
    name: 'Drive vault',
    kdfSalt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    keySlots: [
      {
        slotId: '8f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a08',
        kind: 'passphrase',
        wrappedKey: 'AAAA',
      },
    ],
    portfolios,
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
    header: null,
    unlocked: false,
    rememberedOnDevice: false,
    ...overrides,
  };
}

describe('portfolio settings vault section state', () => {
  const base = { portfolioId: FIXTURE_PORTFOLIO_A, legacyParanoid: false } as const;

  it('is loading before the vault list resolves', () => {
    expect(resolveVaultSectionState({ ...base, status: 'loading', vaults: [] })).toEqual({
      kind: 'loading',
    });
  });

  it('is an error state rather than a silently empty section', () => {
    expect(resolveVaultSectionState({ ...base, status: 'error', vaults: [] })).toEqual({
      kind: 'error',
    });
  });

  it('points a legacy account-level paranoid account at the migration first', () => {
    expect(
      resolveVaultSectionState({ ...base, status: 'ready', vaults: [], legacyParanoid: true }),
    ).toEqual({ kind: 'legacy' });
  });

  it('offers the create-a-vault teaser when no vault exists', () => {
    expect(resolveVaultSectionState({ ...base, status: 'ready', vaults: [] })).toEqual({
      kind: 'no-vaults',
    });
  });

  it('offers every vault as a join target for a normal portfolio', () => {
    const state = resolveVaultSectionState({
      ...base,
      status: 'ready',
      vaults: [
        knowledge({ unlocked: true }),
        knowledge({
          summary: summary({ id: OTHER_VAULT_ID, name: 'Server vault', backends: ['server'] }),
        }),
      ],
    });
    expect(state).toEqual({
      kind: 'joinable',
      choices: [
        { vaultId: FIXTURE_VAULT_ID, name: 'Drive vault', backends: ['drive'], unlocked: true },
        { vaultId: OTHER_VAULT_ID, name: 'Server vault', backends: ['server'], unlocked: false },
      ],
    });
  });

  it('shows the locked state when the owning vault has no key in this browser', () => {
    const state = resolveVaultSectionState({
      ...base,
      status: 'ready',
      vaults: [
        knowledge({
          summary: summary({ portfolioIds: [FIXTURE_PORTFOLIO_A] }),
          header: header([{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' }]),
          rememberedOnDevice: true,
        }),
      ],
    });
    expect(state).toEqual({
      kind: 'vaulted-locked',
      vaultId: FIXTURE_VAULT_ID,
      vaultName: 'Drive vault',
      alias: 'Tech',
      backends: ['drive'],
      rememberedOnDevice: true,
    });
  });

  it('shows the unlocked state with move-out and QR affordances', () => {
    const state = resolveVaultSectionState({
      ...base,
      status: 'ready',
      vaults: [
        knowledge({
          summary: summary({ portfolioIds: [FIXTURE_PORTFOLIO_A] }),
          header: header([{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' }]),
          unlocked: true,
        }),
      ],
    });
    expect(state).toMatchObject({ kind: 'vaulted-unlocked', alias: 'Tech' });
  });

  it('treats a portfolio the header knows but the server has not listed as vaulted', () => {
    const state = resolveVaultSectionState({
      ...base,
      status: 'ready',
      vaults: [
        knowledge({ header: header([{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' }]) }),
      ],
    });
    expect(state.kind).toBe('vaulted-locked');
  });

  it('treats a portfolio the server lists but the header has not indexed as vaulted', () => {
    const state = resolveVaultSectionState({
      ...base,
      status: 'ready',
      vaults: [knowledge({ summary: summary({ portfolioIds: [FIXTURE_PORTFOLIO_A] }) })],
    });
    expect(state).toMatchObject({ kind: 'vaulted-locked', alias: null });
  });

  it('leaves an unrelated portfolio joinable', () => {
    const state = resolveVaultSectionState({
      portfolioId: FIXTURE_PORTFOLIO_B,
      legacyParanoid: false,
      status: 'ready',
      vaults: [
        knowledge({
          summary: summary({ portfolioIds: [FIXTURE_PORTFOLIO_A] }),
          header: header([{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' }]),
        }),
      ],
    });
    expect(state.kind).toBe('joinable');
  });
});

describe('locked rows on money surfaces', () => {
  it('renders one row per indexed portfolio with its alias and lock state', () => {
    const rows = lockedPortfolioRows([
      knowledge({
        summary: summary({ portfolioIds: [FIXTURE_PORTFOLIO_A] }),
        header: header([
          { portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' },
          { portfolioId: FIXTURE_PORTFOLIO_B, alias: 'Pension' },
        ]),
      }),
    ]);
    expect(rows).toEqual([
      {
        portfolioId: FIXTURE_PORTFOLIO_A,
        vaultId: FIXTURE_VAULT_ID,
        vaultName: 'Drive vault',
        alias: 'Tech',
        locked: true,
        unavailable: false,
      },
      {
        portfolioId: FIXTURE_PORTFOLIO_B,
        vaultId: FIXTURE_VAULT_ID,
        vaultName: 'Drive vault',
        alias: 'Pension',
        locked: true,
        unavailable: false,
      },
    ]);
  });

  it('marks rows unlocked once the browser holds the key', () => {
    const rows = lockedPortfolioRows([
      knowledge({
        unlocked: true,
        header: header([{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' }]),
      }),
    ]);
    expect(rows[0]!.locked).toBe(false);
  });

  it('never lets a vaulted portfolio vanish when the header has not loaded', () => {
    const rows = lockedPortfolioRows([
      knowledge({ summary: summary({ portfolioIds: [FIXTURE_PORTFOLIO_A] }) }),
    ]);
    expect(rows).toEqual([
      {
        portfolioId: FIXTURE_PORTFOLIO_A,
        vaultId: FIXTURE_VAULT_ID,
        vaultName: 'Drive vault',
        alias: 'Drive vault',
        locked: true,
        unavailable: false,
      },
    ]);
  });

  it('marks a portfolio whose blob could not be read as unavailable, not empty', () => {
    const rows = lockedPortfolioRows(
      [
        knowledge({
          unlocked: true,
          header: header([
            { portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' },
            { portfolioId: FIXTURE_PORTFOLIO_B, alias: 'Pension' },
          ]),
        }),
      ],
      [FIXTURE_PORTFOLIO_B],
    );
    expect(rows.find((row) => row.portfolioId === FIXTURE_PORTFOLIO_A)).toMatchObject({
      locked: false,
      unavailable: false,
    });
    expect(rows.find((row) => row.portfolioId === FIXTURE_PORTFOLIO_B)).toMatchObject({
      locked: false,
      unavailable: true,
    });
  });

  it('indexes rows across several vaults for O(1) row lookup', () => {
    const index = lockedPortfolioIndex([
      knowledge({ header: header([{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' }]) }),
      knowledge({
        summary: summary({ id: OTHER_VAULT_ID, name: 'Server vault', backends: ['server'] }),
        header: {
          ...header([{ portfolioId: FIXTURE_PORTFOLIO_B, alias: 'Pension' }]),
          vaultId: OTHER_VAULT_ID,
        },
        unlocked: true,
      }),
    ]);
    expect(index.get(FIXTURE_PORTFOLIO_A)).toMatchObject({ alias: 'Tech', locked: true });
    expect(index.get(FIXTURE_PORTFOLIO_B)).toMatchObject({
      alias: 'Pension',
      locked: false,
      vaultName: 'Server vault',
    });
    expect(index.size).toBe(2);
  });

  it('is empty when the account has no vaults', () => {
    expect(lockedPortfolioRows([])).toEqual([]);
  });
});
