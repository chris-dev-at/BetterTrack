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
