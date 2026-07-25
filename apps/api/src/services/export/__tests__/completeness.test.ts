import { describe, expect, it } from 'vitest';

import {
  VAULT_ENTITY_SCHEMAS,
  VAULT_ENTITY_ROW_SCHEMAS,
  VAULT_TABLE_ENTITY_KINDS,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../../../data/schema';
import {
  EXPORT_TABLE_CLASSIFICATION,
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

  it('the exported-entity name list is derived from the classification', () => {
    const fromMap = new Set(
      Object.values(EXPORT_TABLE_CLASSIFICATION)
        .filter((c) => c.kind === 'export')
        .map((c) => (c as { entity: string }).entity),
    );
    expect(new Set(EXPORTED_ENTITY_NAMES)).toEqual(fromMap);
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
    const handlers = new Set(PARANOID_REHYDRATION_HANDLERS);
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
      const stale = carriedDataFields.filter((column) => !expectedDataFields.includes(column));

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
