import { describe, expect, test } from 'vitest';

import {
  vaultedPortfolioStubName,
  VAULTED_PORTFOLIO_STUB_NAME_PREFIX,
  type PortfolioSummary,
} from '@bettertrack/contracts';

import { isVaultedPortfolio, lockedPortfolioCount, portfolioDisplayName } from './lockedPortfolio';

const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000101';
const VAULT_ID = '018f0000-0000-7000-8000-000000000201';
const FALLBACK = 'Locked portfolio';

const PLAIN = {
  id: '018f0000-0000-7000-8000-000000000009',
  name: 'Main',
  visibility: 'private' as const,
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
} as PortfolioSummary;

/** Exactly what the server serves for a vaulted row (E4). */
const STUB = {
  ...PLAIN,
  id: PORTFOLIO_ID,
  isDefault: false,
  name: vaultedPortfolioStubName(PORTFOLIO_ID),
  vaultId: VAULT_ID,
  vaultAlias: 'Private Holdings',
} as PortfolioSummary;

describe('portfolioDisplayName', () => {
  test('names a plain portfolio by its own name', () => {
    expect(portfolioDisplayName(PLAIN, FALLBACK)).toBe('Main');
  });

  test('a locked vaulted row is named by its alias, never by its stored name', () => {
    expect(portfolioDisplayName(STUB, FALLBACK)).toBe('Private Holdings');
    expect(portfolioDisplayName({ ...STUB, vaultAlias: null }, FALLBACK)).toBe(FALLBACK);
    expect(portfolioDisplayName({ ...STUB, vaultAlias: '   ' }, FALLBACK)).toBe(FALLBACK);
  });

  test('the decrypted name wins once this device is holding the vault open', () => {
    // FAILURE MAP #6: the switcher, the stub title and the vault-manager chip
    // all showed the VAULT's name while the true one was already on screen in
    // the workspace — and two portfolios in one vault were indistinguishable.
    expect(portfolioDisplayName(STUB, FALLBACK, 'Vault Test PF')).toBe('Vault Test PF');
  });

  test('a blank or absent unlocked name falls back rather than rendering nothing', () => {
    expect(portfolioDisplayName(STUB, FALLBACK, '  ')).toBe('Private Holdings');
    expect(portfolioDisplayName(STUB, FALLBACK, null)).toBe('Private Holdings');
    expect(portfolioDisplayName(STUB, FALLBACK, undefined)).toBe('Private Holdings');
  });

  test('refuses the server sentinel even on a row that lost its vaultId', () => {
    // Belt and braces for the one thing that must never reach a screen. The
    // sentinel always ships with `vaultId` set today; the New-transaction
    // dialog still printed it, because it read `.name` directly instead of
    // coming through here.
    const sentinelOnly = { ...PLAIN, name: vaultedPortfolioStubName(PORTFOLIO_ID) };
    expect(portfolioDisplayName(sentinelOnly, FALLBACK)).toBe(FALLBACK);
    expect(portfolioDisplayName(sentinelOnly, FALLBACK)).not.toContain(
      VAULTED_PORTFOLIO_STUB_NAME_PREFIX,
    );
  });

  test('a name that merely mentions the prefix mid-string is a real name', () => {
    // Precision, not just recall: only the server's own prefix position counts.
    const named = { ...PLAIN, name: `My ${VAULTED_PORTFOLIO_STUB_NAME_PREFIX} notes` };
    expect(portfolioDisplayName(named, FALLBACK)).toBe(named.name);
  });
});

describe('vault membership helpers', () => {
  test('classifies rows by vaultId, not by name', () => {
    expect(isVaultedPortfolio(STUB)).toBe(true);
    expect(isVaultedPortfolio(PLAIN)).toBe(false);
    expect(isVaultedPortfolio({ ...STUB, vaultId: '' } as PortfolioSummary)).toBe(false);
    expect(isVaultedPortfolio(null)).toBe(false);
  });

  test('counts the locked rows in a roster', () => {
    expect(lockedPortfolioCount([PLAIN, STUB])).toBe(1);
    expect(lockedPortfolioCount([PLAIN])).toBe(0);
  });
});
