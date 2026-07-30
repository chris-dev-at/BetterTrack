import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';

import { assetIdentities } from '../../../data/schema';
import {
  EXPORT_TABLE_CLASSIFICATION,
  PARANOID_REHYDRATION_POLICY,
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
      'asset_identities',
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

  it('keeps the opaque identity anchor and account claim server-side and content-free', () => {
    expect(PARANOID_TABLE_CLASSIFICATION.asset_identities).toBe('server');
    expect(EXPORT_TABLE_CLASSIFICATION.asset_identities).toMatchObject({ kind: 'skip' });
    expect(Object.keys(getTableColumns(assetIdentities))).toEqual(['id', 'ownerId']);
  });

  /**
   * V5 cash fusion: the cash-flow tables are vault-classified from birth, but
   * their rehydration policy is `purge-only` only for as long as NOTHING writes
   * them (phase 1 ships the schema + backfill; the client vault emits none of
   * these entity kinds yet). The moment a repository exists, purge-only means a
   * paranoid disable silently drops the user's tags, budgets and rules — so this
   * test flips to demanding `restore` as soon as the first writer appears, and
   * the phase that adds it cannot ship without noticing.
   */
  describe('cash-flow tables (V5 cash fusion)', () => {
    const apiSrc = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const CASH_TABLES = {
      cash_tags: 'cashTag',
      cash_movement_tags: 'cashMovementTag',
      cash_budgets: 'cashBudget',
      cash_rules: 'cashRule',
      cash_rule_tags: 'cashRuleTag',
    } as const;
    /** Any of these existing means a service can now write the cash-flow tables. */
    const WRITERS = [
      'data/repositories/cashTagRepository.ts',
      'data/repositories/cashFlowRepository.ts',
      'services/cash/cashTagService.ts',
    ];
    const hasWriter = WRITERS.some((rel) => existsSync(join(apiSrc, rel)));

    it('are all vault-classified', () => {
      for (const table of [...Object.keys(CASH_TABLES), 'cash_budget_fires']) {
        expect(PARANOID_TABLE_CLASSIFICATION[table], `${table} should be vault`).toBe('vault');
      }
    });

    it('restore what a writer can create; the per-period fired marker stays derived', () => {
      for (const [table, entity] of Object.entries(CASH_TABLES)) {
        expect(
          PARANOID_REHYDRATION_POLICY[table],
          hasWriter
            ? `${table} now has a writer — its rehydration policy MUST be restore('${entity}'), ` +
                'or disabling paranoid mode silently drops it'
            : `${table} has no writer yet — purge-only is the accurate policy`,
        ).toEqual(hasWriter ? { kind: 'restore', entity } : { kind: 'purge-only' });
      }
      // The fired marker is exactly-once alert bookkeeping: rebuilt, never trusted.
      expect(PARANOID_REHYDRATION_POLICY['cash_budget_fires']).toEqual({ kind: 'purge-only' });
    });
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
