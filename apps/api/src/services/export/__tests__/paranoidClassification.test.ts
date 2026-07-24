import { describe, expect, it } from 'vitest';

import {
  PARANOID_TABLE_CLASSIFICATION,
  PARANOID_VAULT_TABLE_NAMES,
  schemaTableNames,
} from '../manifest';

/**
 * Paranoid data-home completeness sweep vs the Drizzle schema (§13.5 V5-P13 arc
 * b, `docs/paranoid-design.md` §1). The parallel of the export completeness test:
 * every schema table MUST be classified exactly once as `vault` (client-only,
 * purged/probed/rehydrated) or `server` (kept) — so a future table breaks this
 * test until it is classified, and can never silently leak into the "zero
 * portfolio rows server-side" guarantee.
 */
describe('paranoid table classification completeness', () => {
  const tables = schemaTableNames();

  it('classifies every schema table (no gaps)', () => {
    const missing = tables.filter((t) => !(t in PARANOID_TABLE_CLASSIFICATION));
    expect(missing, `unclassified tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale classification entries', () => {
    const known = new Set(tables);
    const stale = Object.keys(PARANOID_TABLE_CLASSIFICATION).filter((t) => !known.has(t));
    expect(stale, `classification names a non-existent table: ${stale.join(', ')}`).toEqual([]);
  });

  it('only uses the two allowed axis values', () => {
    for (const [table, c] of Object.entries(PARANOID_TABLE_CLASSIFICATION)) {
      expect(['vault', 'server'], `${table} has an invalid classification`).toContain(c);
    }
  });

  it('classifies the portfolio ledger + custom assets as vault', () => {
    for (const table of [
      'portfolios',
      'transactions',
      'dividends',
      'portfolio_cash_sources',
      'portfolio_cash_movements',
      'user_tax_settings',
      'assets',
      'price_history',
      'standing_orders',
      'import_batches',
      'expense_transactions',
    ]) {
      expect(PARANOID_TABLE_CLASSIFICATION[table], `${table} should be vault`).toBe('vault');
    }
  });

  it('keeps identity/auth, friends+chat, alerts and the vault rows server-side', () => {
    for (const table of [
      'users',
      'passkeys',
      'two_factor_recovery_codes',
      'friendships',
      'chat_messages',
      'alerts',
      'watchlists',
      'conglomerates',
      // The ciphertext rows are ciphertext + version metadata only (§1).
      'paranoid_vaults',
      'paranoid_vault_history',
    ]) {
      expect(PARANOID_TABLE_CLASSIFICATION[table], `${table} should be server`).toBe('server');
    }
  });

  it('derives the vault table-name list from the classification', () => {
    const fromMap = Object.entries(PARANOID_TABLE_CLASSIFICATION)
      .filter(([, c]) => c === 'vault')
      .map(([t]) => t)
      .sort();
    expect([...PARANOID_VAULT_TABLE_NAMES]).toEqual(fromMap);
    // The vault set is a strict, non-empty subset (the server keeps identity etc).
    expect(PARANOID_VAULT_TABLE_NAMES.length).toBeGreaterThan(0);
    expect(PARANOID_VAULT_TABLE_NAMES.length).toBeLessThan(tables.length);
  });
});
