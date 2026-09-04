import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MIRROR_ROW_KINDS,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_SCHEMAS,
  VAULT_ENTITY_ROW_SCHEMAS,
  VAULT_MIRROR_PROVENANCE_DROPPED_COLUMNS,
  VAULT_MIRROR_PROVENANCE_ENTITY_KINDS,
  VAULT_MIRROR_PROVENANCE_PROOF_FIELDS,
  VAULT_TABLE_ENTITY_KINDS,
  vaultMirrorProvenanceSchema,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../../../data/schema';
import { assertCollectorCoverage } from '../collector';
import {
  EXPORT_DEFERRAL_MARKER,
  EXPORT_DEFERRED_TABLE_NAMES,
  EXPORT_TABLE_CLASSIFICATION,
  EXPORT_VAULT_AXIS_DIVERGENCES,
  EXPORTED_ENTITY_NAMES,
  PARANOID_REHYDRATION_HANDLERS,
  PARANOID_REHYDRATION_POLICY,
  PARANOID_TABLE_CLASSIFICATION,
  schemaTableNames,
} from '../manifest';

/**
 * Completeness sweep vs the Drizzle schema (§13.4 V4-P6a "done-when", #494). The
 * classification map MUST cover every schema table exactly once — so a future
 * user-owned table breaks this test until it is exported or explicitly
 * allow-listed with a reason. Also pins the two tables the acceptance criteria
 * call out by name (cash-source movements + tax rows).
 */
describe('account-export completeness', () => {
  const tables = schemaTableNames();

  it('classifies every schema table (no gaps)', () => {
    const missing = tables.filter((t) => !(t in EXPORT_TABLE_CLASSIFICATION));
    expect(missing, `unclassified tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale classification entries', () => {
    const known = new Set(tables);
    const stale = Object.keys(EXPORT_TABLE_CLASSIFICATION).filter((t) => !known.has(t));
    expect(stale, `classification names a non-existent table: ${stale.join(', ')}`).toEqual([]);
  });

  it('every skipped table states a non-empty reason', () => {
    for (const [table, c] of Object.entries(EXPORT_TABLE_CLASSIFICATION)) {
      if (c.kind === 'skip') {
        expect(c.reason.trim().length, `${table} skipped with an empty reason`).toBeGreaterThan(0);
      }
    }
  });

  it('exports cash-source movements and tax rows (named in the acceptance criteria)', () => {
    expect(EXPORT_TABLE_CLASSIFICATION['portfolio_cash_movements']).toEqual({
      kind: 'export',
      entity: 'cashMovements',
    });
    expect(EXPORT_TABLE_CLASSIFICATION['user_tax_settings']).toEqual({
      kind: 'export',
      entity: 'taxSettings',
    });
  });

  it('exports every portfolio-owned ledger table + custom assets', () => {
    for (const table of [
      'portfolios',
      'transactions',
      'portfolio_cash_sources',
      'dividends',
      'assets',
      'price_history',
    ]) {
      expect(EXPORT_TABLE_CLASSIFICATION[table]?.kind, `${table} should be exported`).toBe(
        'export',
      );
    }
  });

  /**
   * NOTE ON WHAT THIS DOES *NOT* PROVE: `EXPORTED_ENTITY_NAMES` is derived from
   * `EXPORT_TABLE_CLASSIFICATION`, so this assertion is a tautology on purpose —
   * it pins the derivation, nothing more. That the collector actually BUILDS
   * each named entity is proved by `assertCollectorCoverage` (below, and on
   * every real export run) and by the DB-backed `exportFlow.test.ts`.
   */
  it('the exported-entity name list is derived from the classification', () => {
    const fromMap = new Set(
      Object.values(EXPORT_TABLE_CLASSIFICATION)
        .filter((c) => c.kind === 'export')
        .map((c) => (c as { entity: string }).entity),
    );
    expect(new Set(EXPORTED_ENTITY_NAMES)).toEqual(fromMap);
  });

  it('exports the V5-P9 expense area and the cash-fusion tag/budget/rule layer', () => {
    expect(
      Object.fromEntries(
        [
          'expense_categories',
          'expense_transactions',
          'expense_rules',
          'expense_budgets',
          'cash_tags',
          'cash_movement_tags',
          'cash_budgets',
          'cash_rules',
          'cash_rule_tags',
        ].map((table) => [table, EXPORT_TABLE_CLASSIFICATION[table]]),
      ),
    ).toEqual({
      expense_categories: { kind: 'export', entity: 'expenseCategories' },
      expense_transactions: { kind: 'export', entity: 'expenseTransactions' },
      expense_rules: { kind: 'export', entity: 'expenseRules' },
      expense_budgets: { kind: 'export', entity: 'expenseBudgets' },
      cash_tags: { kind: 'export', entity: 'cashTags' },
      cash_movement_tags: { kind: 'export', entity: 'cashMovementTags' },
      cash_budgets: { kind: 'export', entity: 'cashBudgets' },
      cash_rules: { kind: 'export', entity: 'cashRules' },
      cash_rule_tags: { kind: 'export', entity: 'cashRuleTags' },
    });
    // The two per-period fired markers are exactly-once alert bookkeeping, and
    // stay a plain skip — not a deferral, because they are not user content.
    for (const table of ['expense_budget_fires', 'cash_budget_fires']) {
      const classification = EXPORT_TABLE_CLASSIFICATION[table];
      expect(classification?.kind, `${table} should stay skipped`).toBe('skip');
      expect((classification as { reason: string }).reason).not.toContain(EXPORT_DEFERRAL_MARKER);
    }
  });
});

/**
 * "This is the user's data and we have not built it yet" used to be a permanently
 * CI-green state: `skipped(reason)` accepted any prose, and nine V5-P9 tables sat
 * behind the phrase "export coverage lands with a later export sweep" while the
 * encrypted vault already restored them as user content (#1711). These guards make
 * that state visible and bounded instead of silent.
 */
describe('account-export deferrals', () => {
  /**
   * PINNED ROSTER — edit deliberately. Every entry is user-owned data the export
   * does not carry yet; adding a tenth is a decision a reviewer makes here, not a
   * side effect of a sentence in `manifest.ts`.
   */
  const EXPECTED_DEFERRALS = [
    'drive_connections',
    'friend_group_members',
    'friend_groups',
    'item_comments',
    'item_reactions',
    'mirror_chain_members',
    'notification_cadences',
    'standing_order_runs',
    'standing_orders',
    'webhook_subscriptions',
    'widget_layouts',
  ];

  it('enumerates every deferral, and nothing else', () => {
    expect([...EXPORT_DEFERRED_TABLE_NAMES]).toEqual(EXPECTED_DEFERRALS);
  });

  it('states a reason beyond the marker for each deferral', () => {
    for (const table of EXPORT_DEFERRED_TABLE_NAMES) {
      const classification = EXPORT_TABLE_CLASSIFICATION[table];
      expect(classification?.kind).toBe('skip');
      const reason = (classification as { reason: string }).reason;
      expect(
        reason.slice(EXPORT_DEFERRAL_MARKER.length).trim().length,
        `${table} is deferred without saying why`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * The retired phrase. It read as bookkeeping while it was in fact the whole
   * disclosure that a user's expenses were missing from their own archive, so it
   * is now mechanically extinct: a deferral declares itself with
   * {@link EXPORT_DEFERRAL_MARKER} and joins the pinned roster above.
   */
  it('no classification defers behind the retired "later export sweep" prose', () => {
    const offenders = Object.entries(EXPORT_TABLE_CLASSIFICATION)
      .filter(([, c]) => c.kind === 'skip' && /later export sweep/i.test(c.reason))
      .map(([table]) => table);
    expect(offenders, `retired deferral phrase still used by: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * The reason strings above are only half the disclosure — the block comments
   * over each classification are what the next reader hits first, so the phrase
   * has to be extinct in the file, not merely unused by the runtime values.
   */
  it('the retired phrase survives nowhere in manifest.ts, comments included', () => {
    const manifestSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../manifest.ts'),
      'utf8',
    );
    const offendingLines = manifestSource
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /later export sweep/i.test(line));
    expect(
      offendingLines,
      `retired deferral phrase still in manifest.ts prose: ${offendingLines
        .map(({ number }) => `line ${number}`)
        .join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * THE EXPORT↔VAULT AXIS GUARD — the export-side mirror of the cash-fusion guard
 * in `paranoidClassification.test.ts` ("the moment a repository exists,
 * purge-only means a paranoid disable silently drops the user's tags"). Both
 * axes answer one question — is this the user's own data? — so a table the vault
 * restores but the export skips is one axis contradicting the other.
 */
describe('export ↔ vault axis agreement', () => {
  /**
   * PINNED — the only tables allowed to disagree today. #1711 carried the V5-P9
   * expense/cash half and scoped the standing-order definitions out; a third
   * table joining this list must be a deliberate edit here, with the same
   * question answered: why does the vault call these rows the user's while the
   * export does not hand them back?
   */
  const EXPECTED_DIVERGENCES = ['standing_order_runs', 'standing_orders'];

  it('lets no table the vault restores be silently skipped by the export', () => {
    expect(
      [...EXPORT_VAULT_AXIS_DIVERGENCES],
      'a vault-restorable table is skipped by the export — carry it, or pin it here on purpose',
    ).toEqual(EXPECTED_DIVERGENCES);
  });

  it('requires every divergence to be a declared deferral, never a plain skip', () => {
    for (const table of EXPORT_VAULT_AXIS_DIVERGENCES) {
      expect(PARANOID_REHYDRATION_POLICY[table]?.kind).toBe('restore');
      const classification = EXPORT_TABLE_CLASSIFICATION[table];
      expect(
        (classification as { reason: string }).reason.startsWith(EXPORT_DEFERRAL_MARKER),
        `${table} is vault-restorable user data; its export skip must declare itself a deferral`,
      ).toBe(true);
    }
  });

  it('holds for the nine tables this guard was written for', () => {
    for (const table of [
      'expense_categories',
      'expense_transactions',
      'expense_rules',
      'expense_budgets',
      'cash_tags',
      'cash_movement_tags',
      'cash_budgets',
      'cash_rules',
      'cash_rule_tags',
    ]) {
      expect(PARANOID_REHYDRATION_POLICY[table]?.kind, `${table} vault policy`).toBe('restore');
      expect(EXPORT_VAULT_AXIS_DIVERGENCES).not.toContain(table);
    }
  });
});

/**
 * The collector↔manifest drift guard. Until #1711 it filtered the built set
 * through the allowed set BEFORE comparing, so only the missing direction could
 * ever fail: an entity the collector assembled whose table was still skipped was
 * dropped silently, while `manifest.json` told the reader that data was absent.
 */
describe('collector coverage guard', () => {
  it('accepts exactly the declared entity set', () => {
    expect(() => assertCollectorCoverage([...EXPORTED_ENTITY_NAMES])).not.toThrow();
  });

  it('throws on a stray extra entity whose table is not classified as exported', () => {
    expect(() =>
      assertCollectorCoverage([...EXPORTED_ENTITY_NAMES, 'expenseBudgetFires']),
    ).toThrowError(/stray \[expenseBudgetFires\]/);
  });

  it('throws on a declared entity the collector never builds', () => {
    const [first, ...rest] = EXPORTED_ENTITY_NAMES;
    expect(() => assertCollectorCoverage(rest)).toThrowError(new RegExp(`missing \\[${first}\\]`));
  });
});

describe('strict vault-payload completeness', () => {
  const vaultTables = Object.entries(PARANOID_TABLE_CLASSIFICATION)
    .filter(([, classification]) => classification === 'vault')
    .map(([table]) => table)
    .sort();
  const tablesByName = new Map(
    Object.values(schema as unknown as Record<string, unknown>)
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => [getTableName(table), table]),
  );

  it('enrolls every vault-classified table in the strict v1 entity map', () => {
    const enrolled = Object.keys(VAULT_TABLE_ENTITY_KINDS).sort();
    expect(enrolled, `strict v1 table enrollment: ${enrolled.join(', ')}`).toEqual(vaultTables);
  });

  it('makes every vault table explicitly restorable or purge-only', () => {
    expect(Object.keys(PARANOID_REHYDRATION_POLICY).sort()).toEqual(vaultTables);
  });

  it('requires every restorable table to name a strict payload schema and restore handler', () => {
    const handlers = new Set<string>(PARANOID_REHYDRATION_HANDLERS);
    for (const [table, policy] of Object.entries(PARANOID_REHYDRATION_POLICY)) {
      if (policy.kind !== 'restore') continue;
      expect(
        VAULT_ENTITY_SCHEMAS[policy.entity],
        `${table} restores ${policy.entity} without a strict vault payload schema`,
      ).toBeDefined();
      expect(
        handlers.has(policy.entity),
        `${table} restores ${policy.entity} without a rehydration insertion branch`,
      ).toBe(true);
    }
  });

  it('restores the authoritative standing-order exactly-once ledger', () => {
    expect(PARANOID_REHYDRATION_POLICY['standing_order_runs']).toEqual({
      kind: 'restore',
      entity: 'standingOrderRun',
    });
  });

  it('has one restore policy for each handler', () => {
    const entities = Object.values(PARANOID_REHYDRATION_POLICY)
      .filter(
        (policy): policy is Extract<typeof policy, { kind: 'restore' }> =>
          policy.kind === 'restore',
      )
      .map((policy) => policy.entity)
      .sort();
    expect([...PARANOID_REHYDRATION_HANDLERS].sort()).toEqual(entities);
  });

  /**
   * Fields the strict vault payload carries WITHOUT a backing Drizzle column.
   *
   * There is exactly one legitimate reason for an entry here: the column was
   * dropped, but the field cannot be removed from the `.strict()` client
   * document because documents already written in the field's lifetime carry the
   * key and would fail validation without it. `portfolios.vault_id` / `.alias`
   * were dropped with the per-portfolio vault v2 surface (owner ruling
   * 2026-08-19, PROJECTPLAN §16); a paranoid account's vault written while v2
   * existed still has both keys, and that vault is the ONLY copy of its data.
   *
   * This is a frozen ledger, not a general exemption: adding an entry means
   * proving the same "already-written documents would break" argument. Removing
   * one requires a document migration in `migrateVaultDocument`, never a
   * schema-only edit.
   *
   * `vaultId` left this list with the E0 per-portfolio vaults keystone (#1410):
   * `portfolios.vault_id` is a real column again (a FRESH one — see the schema
   * comment), so the field is now column-backed rather than vestigial. `alias`
   * stays: its E0 successor column is deliberately named `vault_alias`, so the
   * retired `alias` name remains payload-only.
   */
  const VESTIGIAL_PAYLOAD_FIELDS: Readonly<Record<string, readonly string[]>> = {
    portfolios: ['alias'],
  };

  it('carries every persisted Drizzle column and names any omission', () => {
    for (const tableName of vaultTables) {
      const table = tablesByName.get(tableName);
      expect(table, `${tableName}: Drizzle table not found`).toBeDefined();
      if (table == null) continue;

      const kind = VAULT_TABLE_ENTITY_KINDS[
        tableName as keyof typeof VAULT_TABLE_ENTITY_KINDS
      ] as VaultEntityKind;
      const rowSchema = VAULT_ENTITY_ROW_SCHEMAS[kind] as {
        shape: Record<string, unknown>;
      };
      const persisted = Object.keys(getTableColumns(table));
      // Database `id` is carried by the common strict entity metadata. Every
      // other column remains same-named in `data`, with no restore derivation.
      const expectedDataFields = persisted.filter((column) => column !== 'id').sort();
      const carriedDataFields = Object.keys(rowSchema.shape).sort();
      const missing = expectedDataFields.filter((column) => !carriedDataFields.includes(column));
      const stale = carriedDataFields
        .filter((column) => !expectedDataFields.includes(column))
        .filter((column) => !(VESTIGIAL_PAYLOAD_FIELDS[tableName] ?? []).includes(column));

      expect(
        missing,
        `${tableName}.${missing.join(`, ${tableName}.`)} missing from strict ${kind} payload`,
      ).toEqual([]);
      expect(
        stale,
        `${kind} carries non-column fields for ${tableName}: ${stale.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('does not classify rehydration metadata as vault content', () => {
    expect(PARANOID_TABLE_CLASSIFICATION['paranoid_rehydration_receipts']).toBe('server');
  });
});

/**
 * Severed-fork MIRRORCHAIN provenance (`docs/paranoid-design.md` §7.1) is
 * enrolled in the same mechanical style as the strict document: every
 * `mirror_rows` column is either carried by the encrypted record or explicitly
 * named as dropped with a reason, so a future column can neither slip into the
 * vault nor silently escape restore-time validation.
 */
describe('severed-fork provenance enrollment', () => {
  const proof = Object.keys(VAULT_MIRROR_PROVENANCE_PROOF_FIELDS).sort();
  const carried = Object.keys(vaultMirrorProvenanceSchema.shape)
    .filter((field) => !proof.includes(field))
    .sort();
  const dropped = Object.keys(VAULT_MIRROR_PROVENANCE_DROPPED_COLUMNS).sort();
  const columns = Object.keys(getTableColumns(schema.mirrorRows)).sort();

  it('carries or explicitly drops every mirror_rows column', () => {
    expect([...carried, ...dropped].sort()).toEqual(columns);
    expect(carried.filter((field) => dropped.includes(field))).toEqual([]);
  });

  /**
   * A proof field is carried on purpose and is NOT a `mirror_rows` column, so it
   * must be declared as one — otherwise the column gate above would either fail
   * or, worse, be relaxed into accepting an undeclared extra field.
   */
  it('declares every carried field that is not a mirror_rows column', () => {
    expect(proof.filter((field) => columns.includes(field))).toEqual([]);
    expect(
      Object.keys(vaultMirrorProvenanceSchema.shape)
        .filter((field) => !columns.includes(field))
        .sort(),
    ).toEqual(proof);
    expect(proof).toContain('membershipId');
  });

  it('states a non-empty reason for every dropped column and proof field', () => {
    for (const [column, reason] of Object.entries({
      ...VAULT_MIRROR_PROVENANCE_DROPPED_COLUMNS,
      ...VAULT_MIRROR_PROVENANCE_PROOF_FIELDS,
    })) {
      expect(reason.trim().length, `${column} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('resolves every mirror row kind to an enrolled vault entity kind', () => {
    expect(Object.keys(VAULT_MIRROR_PROVENANCE_ENTITY_KINDS).sort()).toEqual(
      [...MIRROR_ROW_KINDS].sort(),
    );
    for (const kind of Object.values(VAULT_MIRROR_PROVENANCE_ENTITY_KINDS)) {
      expect(VAULT_ENTITY_KINDS).toContain(kind);
    }
  });

  /**
   * `mirror_rows` itself stays server-classified and is NEVER restored: its
   * `created_by`/`created_by_username` columns are a co-member's identity, which
   * the encrypted document must not carry, so a `vault` classification could only
   * be honoured by leaking exactly that. The logical half rides `mirrorProvenance`
   * instead, and the fork stays un-synced after disable.
   */
  it('keeps the identity map itself server-classified and out of the entity map', () => {
    expect(PARANOID_TABLE_CLASSIFICATION['mirror_rows']).toBe('server');
    expect(Object.keys(VAULT_TABLE_ENTITY_KINDS)).not.toContain('mirror_rows');
    expect(PARANOID_REHYDRATION_POLICY['mirror_rows']).toBeUndefined();
  });
});
