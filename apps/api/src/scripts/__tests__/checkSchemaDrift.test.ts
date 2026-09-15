import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../data/schema';
import {
  collectDeclaredSchema,
  collectLiveSchema,
  compareSchema,
  formatReport,
  truncateIdentifier,
  type DeclaredSchema,
  type LiveIndex,
  type LiveSchema,
} from '../checkSchemaDrift';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle',
);

const index = (overrides: Partial<LiveIndex> & Pick<LiveIndex, 'table' | 'name'>): LiveIndex => ({
  columns: [],
  partial: false,
  constraintBacked: false,
  ...overrides,
});

const emptyLive = (): LiveSchema => ({ tables: [], constraints: [], indexes: [] });
const emptyDeclared = (): DeclaredSchema => ({ tables: [], constraints: [], indexes: [] });

describe('schema drift gate — a freshly migrated database', () => {
  let live: LiveSchema;

  beforeAll(async () => {
    const client = new PGlite({ extensions: { pg_trgm } });
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    live = await collectLiveSchema(
      async (query) => (await client.query(query)).rows as Record<string, unknown>[],
    );
  }, 120_000);

  it('declares every live CHECK, UNIQUE, FOREIGN KEY and index in schema.ts, and nothing extra', () => {
    const report = compareSchema(collectDeclaredSchema(), live);
    expect(formatReport(report)).toContain('Schema drift OK');
    expect(report.errors).toEqual([]);
  });

  it('indexes the referencing column of every foreign key, with an empty allowlist', () => {
    const report = compareSchema(collectDeclaredSchema(), live);
    expect(report.checkedForeignKeys).toBeGreaterThan(100);
    expect(report.allowlisted).toBe(0);
  });

  it('keeps the two CHECKs the enum-recreation migrations drop and re-add', () => {
    // #1619: 0019/0021/0077 drop `portfolio_cash_movements_sign` and 0061 drops
    // `user_tax_settings_country`, each re-adding it in the same transaction. A
    // reader grepping only for DROP would conclude they are gone; they are not.
    const names = live.constraints.map((entry) => `${entry.table}.${entry.name}`);
    expect(names).toContain('portfolio_cash_movements.portfolio_cash_movements_sign');
    expect(names).toContain('user_tax_settings.user_tax_settings_country');
  });
});

describe('schema drift comparison', () => {
  it('reports a CHECK that exists in the database but not in schema.ts', () => {
    const report = compareSchema(
      { ...emptyDeclared(), tables: ['widgets'] },
      {
        ...emptyLive(),
        tables: ['widgets'],
        constraints: [
          {
            table: 'widgets',
            name: 'widgets_positive',
            type: 'check',
            columns: ['size'],
            definition: 'CHECK ((size > 0))',
          },
        ],
      },
    );

    expect(report.errors).toEqual([
      'check "widgets_positive" on "widgets" exists in the database but is not declared in ' +
        'schema.ts — CHECK ((size > 0))',
    ]);
  });

  it('reports a constraint declared in schema.ts that the migration chain never creates', () => {
    const report = compareSchema(
      {
        ...emptyDeclared(),
        tables: ['widgets'],
        constraints: [{ table: 'widgets', name: 'widgets_positive', type: 'check' }],
      },
      { ...emptyLive(), tables: ['widgets'] },
    );

    expect(report.errors).toEqual([
      'check "widgets_positive" on "widgets" is declared in schema.ts but does not exist in the ' +
        'database — the migration chain is missing it',
    ]);
  });

  it('reports an index that only one side knows about', () => {
    const declaredOnly = compareSchema(
      {
        ...emptyDeclared(),
        tables: ['widgets'],
        indexes: [{ table: 'widgets', name: 'widgets_owner_idx' }],
      },
      { ...emptyLive(), tables: ['widgets'] },
    );
    expect(declaredOnly.errors).toHaveLength(1);
    expect(declaredOnly.errors[0]).toContain('the migration chain is missing it');

    const liveOnly = compareSchema(
      { ...emptyDeclared(), tables: ['widgets'] },
      {
        ...emptyLive(),
        tables: ['widgets'],
        indexes: [index({ table: 'widgets', name: 'widgets_owner_idx', columns: ['owner_id'] })],
      },
    );
    expect(liveOnly.errors).toHaveLength(1);
    expect(liveOnly.errors[0]).toContain('is not declared in schema.ts');
  });

  it('ignores the index Postgres builds to back a constraint', () => {
    const report = compareSchema(
      { ...emptyDeclared(), tables: ['widgets'] },
      {
        ...emptyLive(),
        tables: ['widgets'],
        indexes: [
          index({
            table: 'widgets',
            name: 'widgets_pkey',
            columns: ['id'],
            constraintBacked: true,
          }),
        ],
      },
    );

    expect(report.errors).toEqual([]);
  });

  it('ignores the zz_ quarantine mirrors a data migration owns', () => {
    const report = compareSchema(emptyDeclared(), {
      ...emptyLive(),
      tables: ['zz_vault_v2_backup_vaults'],
      constraints: [
        {
          table: 'zz_vault_v2_backup_vaults',
          name: 'zz_vault_v2_backup_vaults_pkey_shape',
          type: 'check',
          columns: ['id'],
          definition: 'CHECK (true)',
        },
      ],
    });

    expect(report.errors).toEqual([]);
  });

  it('matches a Drizzle-generated name against the truncation Postgres stores', () => {
    const generated = `widgets_owner_id_${'x'.repeat(60)}_fk`;
    expect(truncateIdentifier(generated)).toHaveLength(63);

    const report = compareSchema(
      {
        ...emptyDeclared(),
        tables: ['widgets'],
        constraints: [
          { table: 'widgets', name: truncateIdentifier(generated), type: 'foreign key' },
        ],
        indexes: [{ table: 'widgets', name: 'widgets_owner_idx' }],
      },
      {
        ...emptyLive(),
        tables: ['widgets'],
        constraints: [
          {
            table: 'widgets',
            name: truncateIdentifier(generated),
            type: 'foreign key',
            columns: ['owner_id'],
            definition: 'FOREIGN KEY (owner_id) REFERENCES users(id)',
          },
        ],
        indexes: [index({ table: 'widgets', name: 'widgets_owner_idx', columns: ['owner_id'] })],
      },
    );

    expect(report.errors).toEqual([]);
  });

  it('fails a foreign key whose referencing column has no index', () => {
    const live: LiveSchema = {
      ...emptyLive(),
      tables: ['widgets'],
      constraints: [
        {
          table: 'widgets',
          name: 'widgets_owner_id_users_id_fk',
          type: 'foreign key',
          columns: ['owner_id'],
          definition: 'FOREIGN KEY (owner_id) REFERENCES users(id)',
        },
      ],
    };
    const declared: DeclaredSchema = {
      ...emptyDeclared(),
      tables: ['widgets'],
      constraints: [
        { table: 'widgets', name: 'widgets_owner_id_users_id_fk', type: 'foreign key' },
      ],
    };

    const uncovered = compareSchema(declared, live, {});
    expect(uncovered.errors).toHaveLength(1);
    expect(uncovered.errors[0]).toContain('has no index on its referencing column(s)');

    const allowlisted = compareSchema(declared, live, { 'widgets(owner_id)': 'cold admin table' });
    expect(allowlisted.errors).toEqual([]);
    expect(allowlisted.allowlisted).toBe(1);
  });

  it('accepts a leading-column match and rejects a partial or trailing one', () => {
    const withIndex = (indexes: LiveIndex[]) =>
      compareSchema(
        {
          ...emptyDeclared(),
          tables: ['widgets'],
          constraints: [{ table: 'widgets', name: 'widgets_fk', type: 'foreign key' }],
          indexes: indexes.map((entry) => ({ table: entry.table, name: entry.name })),
        },
        {
          ...emptyLive(),
          tables: ['widgets'],
          constraints: [
            {
              table: 'widgets',
              name: 'widgets_fk',
              type: 'foreign key',
              columns: ['owner_id'],
              definition: 'FOREIGN KEY (owner_id) REFERENCES users(id)',
            },
          ],
          indexes,
        },
        {},
      ).errors;

    expect(
      withIndex([index({ table: 'widgets', name: 'a_idx', columns: ['owner_id', 'created_at'] })]),
    ).toEqual([]);
    expect(
      withIndex([index({ table: 'widgets', name: 'b_idx', columns: ['created_at', 'owner_id'] })]),
    ).toHaveLength(1);
    expect(
      withIndex([index({ table: 'widgets', name: 'c_idx', columns: ['owner_id'], partial: true })]),
    ).toHaveLength(1);
  });

  it('rejects an allowlist entry that no longer matches an unindexed foreign key', () => {
    const report = compareSchema(emptyDeclared(), emptyLive(), {
      'widgets(owner_id)': 'stale',
    });

    expect(report.errors).toEqual([
      'FK_INDEX_ALLOWLIST entry "widgets(owner_id)" matches no unindexed foreign key — remove the ' +
        'stale entry',
    ]);
  });
});
