import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';

import { assetIdentities } from '../../../data/schema';
import {
  PARANOID_PROBE_HANDLER_NAMES,
  PARANOID_PURGE_HANDLER_NAMES,
} from '../../../data/repositories/paranoidTransitionRepository';
import { VAULT_TABLE_ENTITY_KINDS } from '@bettertrack/contracts';

import {
  EXPORT_TABLE_CLASSIFICATION,
  PARANOID_PURGED_TABLE_NAMES,
  PARANOID_PURGE_ONLY_TABLE_NAMES,
  PARANOID_PURGE_REASONS,
  PARANOID_REHYDRATION_POLICY,
  PARANOID_TABLE_CLASSIFICATION,
  PARANOID_VAULT_DOC_BUCKETS,
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

  it('only uses the three allowed axis values', () => {
    for (const [table, c] of Object.entries(PARANOID_TABLE_CLASSIFICATION)) {
      expect(['vault', 'server', 'purge'], `${table} has an invalid classification`).toContain(c);
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

  /**
   * The per-portfolio vault surface itself (E0 #1410): config rows, opaque
   * ciphertext and the token-free Drive registry are `server` for exactly the
   * reason the v1 `paranoid_*` rows are — account config + ciphertext, never
   * portfolio content. Pinned so a re-classification is a deliberate review.
   */
  it('keeps the per-portfolio vault surface server-side (E0 #1410)', () => {
    for (const table of [
      'vaults',
      'vault_blobs',
      'vault_blob_history',
      'vault_server_candidates',
      'vault_retirements',
      'vault_retired',
      'drive_connections',
    ]) {
      expect(PARANOID_TABLE_CLASSIFICATION[table], `${table} should be server`).toBe('server');
      expect(EXPORT_TABLE_CLASSIFICATION[table], `${table} needs an export skip`).toMatchObject({
        kind: 'skip',
      });
    }
  });

  /**
   * THE DOC-BUCKET AXIS (docs/paranoid-design.md §5, E0 #1410): every
   * `vault`-classified table names the encrypted doc that carries it —
   * `portfolio` (the member portfolio's own doc) or `common` (the vault-wide
   * account-scoped doc) — with the same "equally exhaustive, CI fails on a
   * gap" contract as the axis it extends.
   */
  describe('the doc-bucket axis (per-portfolio vaults, E0 #1410)', () => {
    it('assigns exactly one bucket to every vault-classified table and to nothing else', () => {
      expect(Object.keys(PARANOID_VAULT_DOC_BUCKETS).sort()).toEqual([
        ...PARANOID_VAULT_TABLE_NAMES,
      ]);
    });

    it('only uses the two bucket values', () => {
      for (const [table, bucket] of Object.entries(PARANOID_VAULT_DOC_BUCKETS)) {
        expect(['portfolio', 'common'], `${table} has an invalid doc bucket`).toContain(bucket);
      }
    });

    it('pins the mechanical scoping rule on the telling cases', () => {
      // portfolio-scoped rows ride the member portfolio's own doc...
      expect(PARANOID_VAULT_DOC_BUCKETS['transactions']).toBe('portfolio');
      expect(PARANOID_VAULT_DOC_BUCKETS['standing_order_runs']).toBe('portfolio');
      expect(PARANOID_VAULT_DOC_BUCKETS['import_batches']).toBe('portfolio');
      expect(PARANOID_VAULT_DOC_BUCKETS['cash_budgets']).toBe('portfolio');
      // ...account-scoped, vault-referenced rows ride the common doc. The
      // V5-P9 expense tables land here DELIBERATELY: the design note's §5
      // wording assumed portfolio-scoped expense rows, but the live schema
      // keys them by user_id only, and the axis follows the actual scoping
      // column (recorded in the contracts' VAULT_ENTITY_DOC_BUCKETS note).
      expect(PARANOID_VAULT_DOC_BUCKETS['user_tax_settings']).toBe('common');
      expect(PARANOID_VAULT_DOC_BUCKETS['assets']).toBe('common');
      expect(PARANOID_VAULT_DOC_BUCKETS['price_history']).toBe('common');
      expect(PARANOID_VAULT_DOC_BUCKETS['expense_transactions']).toBe('common');
      expect(PARANOID_VAULT_DOC_BUCKETS['cash_tags']).toBe('common');
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

  it('drives both destructive handlers and zero-cleartext probes from the full purged set', () => {
    expect(PARANOID_PURGE_HANDLER_NAMES).toEqual([...PARANOID_PURGED_TABLE_NAMES]);
    expect(PARANOID_PROBE_HANDLER_NAMES).toEqual([...PARANOID_PURGED_TABLE_NAMES]);
  });

  /**
   * The `purge` axis value (added for operational identifier telemetry) destroys + zero-probes a
   * table WITHOUT enrolling it in the encrypted document. These three guards are
   * what stop it from becoming a quiet backdoor into that document — or, worse, a
   * way to mark a table destroyed while the client still believes it holds it.
   */
  describe('the purge axis', () => {
    it('purges and probes every purge-classified table, exactly like a vault table', () => {
      for (const table of PARANOID_PURGE_ONLY_TABLE_NAMES) {
        expect(PARANOID_PURGE_HANDLER_NAMES, `${table} needs a purge handler`).toContain(table);
        expect(PARANOID_PROBE_HANDLER_NAMES, `${table} needs a zero-probe`).toContain(table);
      }
    });

    it('never carries a purge-classified table into the encrypted document', () => {
      for (const table of PARANOID_PURGE_ONLY_TABLE_NAMES) {
        expect(
          Object.keys(VAULT_TABLE_ENTITY_KINDS),
          `${table} is purge-classified and must NOT enter the strict v1 document`,
        ).not.toContain(table);
        expect(
          PARANOID_REHYDRATION_POLICY[table],
          `${table} is purge-classified: it is never restored, so it takes no rehydration policy`,
        ).toBeUndefined();
        expect(PARANOID_VAULT_TABLE_NAMES, `${table} is not vault content`).not.toContain(table);
      }
    });

    /**
     * The leak this axis exists for: a paranoid client prices every holding
     * itself, so `usage_events` recorded the account's holdings roster daily.
     */
    it('purges usage_events and keeps the non-identifying rollup server-side', () => {
      expect(PARANOID_TABLE_CLASSIFICATION['usage_events']).toBe('purge');
      // `usage_daily` is keyed (day, feature) across ALL accounts — no user id,
      // no asset id — so it identifies nobody and is deliberately NOT purged.
      expect(PARANOID_TABLE_CLASSIFICATION['usage_daily']).toBe('server');
    });

    /**
     * `purge` made "destroyed but never captured" a CI-green state for the first
     * time — which also makes flipping an existing `vault` table here a green way
     * to stop capturing it. The export axis answers the same hazard by demanding
     * a non-empty reason for every `skip`; this demands one for every `purge`.
     */
    it('states a non-empty reason for every purge-classified table', () => {
      expect(Object.keys(PARANOID_PURGE_REASONS).sort()).toEqual([
        ...PARANOID_PURGE_ONLY_TABLE_NAMES,
      ]);
      for (const [table, reason] of Object.entries(PARANOID_PURGE_REASONS)) {
        expect(reason.trim().length, `${table} needs a stated reason`).toBeGreaterThan(0);
      }
    });

    /**
     * The membership roster is PINNED, not merely derived. Adding a second table
     * to this axis is a deliberate act that has to edit this list — so a future
     * change cannot quietly move a captured table into "destroyed, never
     * captured" and stay green.
     */
    it('pins every member so adding another is a deliberate review', () => {
      expect([...PARANOID_PURGE_ONLY_TABLE_NAMES]).toEqual(['api_key_request_log', 'usage_events']);
    });
  });
});
