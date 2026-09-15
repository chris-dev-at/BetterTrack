import { pathToFileURL } from 'node:url';

import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import postgres from 'postgres';

import * as schema from '../data/schema';

/**
 * CI guard (#1619): `apps/api/src/data/schema.ts` is the schema of record
 * (PROJECTPLAN §5.5), but roughly four fifths of the migration chain is
 * hand-written SQL. Nothing used to compare the two, so constraints could live
 * in production while `schema.ts` — the file a reader (or `drizzle-kit
 * generate`) treats as the truth — never mentioned them. On 2026-09-01 the
 * estate survey found 34 live CHECK constraints that `schema.ts` did not
 * declare.
 *
 * This introspects a freshly migrated database (`pg_constraint` / `pg_index`)
 * and compares it against the Drizzle table definitions:
 *
 *   a) every CHECK / UNIQUE / FOREIGN KEY and every index in the database is
 *      declared,
 *   b) every declared constraint and index exists in the database,
 *   c) every foreign key's referencing column(s) are covered by an index, or
 *      the FK is listed in {@link FK_INDEX_ALLOWLIST} with a reason (Postgres
 *      indexes the referenced side only; the referencing side is the one that
 *      gets scanned by cascading deletes and by the hot portfolio/user joins).
 *
 * Primary keys are not compared: Postgres always indexes them and Drizzle
 * always declares them, so there is nothing that can drift silently.
 *
 * Run it against the CI integration database after `db:migrate`:
 *   DATABASE_URL=postgres://... pnpm --filter @bettertrack/api check:schema-drift
 * The PGlite equivalent runs in `__tests__/checkSchemaDrift.test.ts`, so the
 * fast suite catches drift before CI does.
 */

export type ConstraintType = 'check' | 'unique' | 'foreign key';

export interface LiveConstraint {
  table: string;
  name: string;
  type: ConstraintType;
  /** Referencing columns, in constraint order. Empty for expression-only CHECKs. */
  columns: string[];
  definition: string;
}

export interface LiveIndex {
  table: string;
  name: string;
  /** Key columns in index order; expression keys appear as `(expr)`. */
  columns: string[];
  partial: boolean;
  /** True for the index Postgres creates to back a PRIMARY KEY / UNIQUE constraint. */
  constraintBacked: boolean;
}

export interface LiveSchema {
  tables: string[];
  constraints: LiveConstraint[];
  indexes: LiveIndex[];
}

export interface DeclaredConstraint {
  table: string;
  name: string;
  type: ConstraintType;
}

export interface DeclaredIndex {
  table: string;
  name: string;
}

export interface DeclaredSchema {
  tables: string[];
  constraints: DeclaredConstraint[];
  indexes: DeclaredIndex[];
}

/**
 * Foreign keys whose referencing column is deliberately left unindexed. Every
 * entry needs a reason: an unindexed FK column turns each parent delete into a
 * sequential scan of the child table, so "cold and tiny" is the only defensible
 * answer.
 */
export const FK_INDEX_ALLOWLIST: Record<string, string> = {};

/**
 * Table-name prefixes the database owns without `schema.ts` knowing about them.
 * Quarantine mirrors created by a data migration are deliberately invisible to
 * the app: 0089 (vault v2) and 0102 (paranoid v1) copy the legacy rows into
 * `zz_`-prefixed tables that no repository ever reads, and the §19 deletion
 * train drops them later in append-only migrations. Matching on the prefix (not
 * a name list) keeps the gate correct across both the creation and the drop.
 */
export const UNMANAGED_TABLE_PREFIXES: { prefix: string; reason: string }[] = [
  {
    prefix: 'zz_',
    reason: 'quarantine mirrors held for the §19 deletion train; no repository reads them',
  },
];

/**
 * Postgres truncates identifiers at NAMEDATALEN - 1 bytes. Drizzle composes
 * foreign-key names from table + column names without truncating, so a long
 * generated name in `schema.ts` is stored shortened and would otherwise read as
 * two different constraints.
 */
const PG_NAME_MAX_BYTES = 63;

export const truncateIdentifier = (name: string): string => {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.byteLength <= PG_NAME_MAX_BYTES) return name;
  // Cut on a character boundary: a multi-byte character split in half would
  // never match the server's own truncation.
  return new TextDecoder('utf8', { fatal: false })
    .decode(bytes.subarray(0, PG_NAME_MAX_BYTES))
    .replace(/�$/, '');
};

const isUnmanagedTable = (table: string): boolean =>
  UNMANAGED_TABLE_PREFIXES.some((entry) => table.startsWith(entry.prefix));

const allowlistKey = (table: string, columns: string[]): string => `${table}(${columns.join(',')})`;

// ---------------------------------------------------------------------------
// Database side
// ---------------------------------------------------------------------------

export const CONSTRAINTS_SQL = `
  SELECT t.relname AS table_name,
         c.conname AS name,
         CASE c.contype WHEN 'c' THEN 'check' WHEN 'u' THEN 'unique' ELSE 'foreign key' END AS type,
         COALESCE(
           (SELECT array_agg(a.attname ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum),
           ARRAY[]::name[]
         ) AS columns,
         pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND c.contype IN ('c', 'u', 'f')
   ORDER BY t.relname, c.conname
`;

export const INDEXES_SQL = `
  SELECT t.relname AS table_name,
         ic.relname AS name,
         COALESCE(
           (SELECT array_agg(COALESCE(a.attname, '(expr)') ORDER BY k.ord)
              FROM unnest(string_to_array(i.indkey::text, ' ')::int[]) WITH ORDINALITY AS k(attnum, ord)
              LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE k.ord <= i.indnkeyatts),
           ARRAY[]::text[]
         ) AS columns,
         i.indpred IS NOT NULL AS partial,
         EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) AS constraint_backed
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
   ORDER BY t.relname, ic.relname
`;

export const TABLES_SQL = `
  SELECT table_name
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_type = 'BASE TABLE'
     AND table_name <> '__drizzle_migrations'
   ORDER BY table_name
`;

/** Minimal executor so the CLI (postgres-js) and the test (PGlite) share one path. */
export type SqlExecutor = (query: string) => Promise<Record<string, unknown>[]>;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : [];

export async function collectLiveSchema(execute: SqlExecutor): Promise<LiveSchema> {
  const [tableRows, constraintRows, indexRows] = await Promise.all([
    execute(TABLES_SQL),
    execute(CONSTRAINTS_SQL),
    execute(INDEXES_SQL),
  ]);

  return {
    tables: tableRows.map((row) => String(row.table_name)),
    constraints: constraintRows.map((row) => ({
      table: String(row.table_name),
      name: String(row.name),
      type: String(row.type) as ConstraintType,
      columns: asStringArray(row.columns),
      definition: String(row.definition),
    })),
    indexes: indexRows.map((row) => ({
      table: String(row.table_name),
      name: String(row.name),
      columns: asStringArray(row.columns),
      partial: row.partial === true,
      constraintBacked: row.constraint_backed === true,
    })),
  };
}

// ---------------------------------------------------------------------------
// schema.ts side
// ---------------------------------------------------------------------------

export function collectDeclaredSchema(): DeclaredSchema {
  // The module also exports enums, types and helpers; `is` narrows at runtime,
  // but each table's literal generic makes the union too specific for a type
  // predicate, hence the cast to the erased `PgTable`.
  const tables = Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((value) => value as unknown as PgTable);
  const constraints: DeclaredConstraint[] = [];
  const indexes: DeclaredIndex[] = [];
  const names: string[] = [];

  for (const table of tables) {
    const config = getTableConfig(table);
    names.push(config.name);

    for (const check of config.checks) {
      constraints.push({ table: config.name, name: truncateIdentifier(check.name), type: 'check' });
    }
    for (const unique of config.uniqueConstraints) {
      constraints.push({
        table: config.name,
        name: truncateIdentifier(unique.name ?? ''),
        type: 'unique',
      });
    }
    // Column-level `.unique()` never reaches `uniqueConstraints`.
    for (const column of config.columns) {
      if (column.isUnique && column.uniqueName) {
        constraints.push({
          table: config.name,
          name: truncateIdentifier(column.uniqueName),
          type: 'unique',
        });
      }
    }
    for (const foreignKey of config.foreignKeys) {
      constraints.push({
        table: config.name,
        name: truncateIdentifier(foreignKey.getName()),
        type: 'foreign key',
      });
    }
    for (const index of config.indexes) {
      const name = index.config.name;
      if (name) indexes.push({ table: config.name, name: truncateIdentifier(name) });
    }
  }

  return { tables: names.sort(), constraints, indexes };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface DriftReport {
  errors: string[];
  checkedConstraints: number;
  checkedIndexes: number;
  checkedForeignKeys: number;
  allowlisted: number;
}

const constraintKey = (entry: { table: string; name: string }): string =>
  `${entry.table}.${entry.name}`;

/** An index covers an FK when its leading key columns are exactly the FK columns. */
function indexCovers(index: LiveIndex, columns: string[]): boolean {
  if (index.partial) return false;
  if (index.columns.length < columns.length) return false;
  const leading = index.columns.slice(0, columns.length);
  return [...leading].sort().join(',') === [...columns].sort().join(',');
}

export function compareSchema(
  declared: DeclaredSchema,
  live: LiveSchema,
  allowlist: Record<string, string> = FK_INDEX_ALLOWLIST,
): DriftReport {
  const errors: string[] = [];

  const declaredTables = new Set(declared.tables);
  const liveTables = new Set(live.tables.filter((table) => !isUnmanagedTable(table)));
  for (const table of live.tables) {
    if (isUnmanagedTable(table) || declaredTables.has(table)) continue;
    errors.push(`table "${table}" exists in the database but is not declared in schema.ts`);
  }
  for (const table of declared.tables) {
    if (!liveTables.has(table)) {
      errors.push(`table "${table}" is declared in schema.ts but does not exist in the database`);
    }
  }

  const declaredByKey = new Map(declared.constraints.map((entry) => [constraintKey(entry), entry]));
  const liveByKey = new Map(live.constraints.map((entry) => [constraintKey(entry), entry]));

  for (const entry of live.constraints) {
    // Constraints on a table schema.ts does not know about are already reported
    // once, as the missing table; do not repeat them per constraint.
    if (!declaredTables.has(entry.table)) continue;
    const match = declaredByKey.get(constraintKey(entry));
    if (!match) {
      errors.push(
        `${entry.type} "${entry.name}" on "${entry.table}" exists in the database but is not ` +
          `declared in schema.ts — ${entry.definition}`,
      );
      continue;
    }
    if (match.type !== entry.type) {
      errors.push(
        `"${entry.name}" on "${entry.table}" is a ${entry.type} in the database but declared as ` +
          `a ${match.type} in schema.ts`,
      );
    }
  }

  for (const entry of declared.constraints) {
    if (!liveTables.has(entry.table)) continue;
    if (!liveByKey.has(constraintKey(entry))) {
      errors.push(
        `${entry.type} "${entry.name}" on "${entry.table}" is declared in schema.ts but does not ` +
          `exist in the database — the migration chain is missing it`,
      );
    }
  }

  const indexesByTable = new Map<string, LiveIndex[]>();
  for (const index of live.indexes) {
    const bucket = indexesByTable.get(index.table);
    if (bucket) bucket.push(index);
    else indexesByTable.set(index.table, [index]);
  }

  // Standalone indexes only: the ones Postgres builds to back a PRIMARY KEY or
  // UNIQUE constraint are covered by the constraint comparison above, and
  // Drizzle never lists them as indexes.
  const standaloneIndexes = live.indexes.filter((index) => !index.constraintBacked);
  const declaredIndexNames = new Set(declared.indexes.map(constraintKey));
  const liveIndexNames = new Set(standaloneIndexes.map(constraintKey));

  for (const index of standaloneIndexes) {
    if (!liveTables.has(index.table)) continue;
    if (!declaredIndexNames.has(constraintKey(index))) {
      errors.push(
        `index "${index.name}" on "${index.table}" (${index.columns.join(', ')}) exists in the ` +
          `database but is not declared in schema.ts`,
      );
    }
  }
  for (const index of declared.indexes) {
    if (!liveTables.has(index.table)) continue;
    if (!liveIndexNames.has(constraintKey(index))) {
      errors.push(
        `index "${index.name}" on "${index.table}" is declared in schema.ts but does not exist in ` +
          `the database — the migration chain is missing it`,
      );
    }
  }

  const foreignKeys = live.constraints.filter((entry) => entry.type === 'foreign key');
  let allowlisted = 0;
  const usedAllowlistKeys = new Set<string>();

  for (const foreignKey of foreignKeys) {
    const key = allowlistKey(foreignKey.table, foreignKey.columns);
    const covered = (indexesByTable.get(foreignKey.table) ?? []).some((index) =>
      indexCovers(index, foreignKey.columns),
    );
    if (covered) {
      if (allowlist[key] !== undefined) usedAllowlistKeys.add(key);
      continue;
    }
    if (allowlist[key] !== undefined) {
      allowlisted += 1;
      usedAllowlistKeys.add(key);
      continue;
    }
    errors.push(
      `foreign key "${foreignKey.name}" on ${key} has no index on its referencing column(s) — ` +
        `add one in schema.ts (and a migration), or add "${key}" to FK_INDEX_ALLOWLIST with a reason`,
    );
  }

  for (const key of Object.keys(allowlist)) {
    if (!usedAllowlistKeys.has(key)) {
      errors.push(
        `FK_INDEX_ALLOWLIST entry "${key}" matches no unindexed foreign key — remove the stale entry`,
      );
    }
  }

  return {
    errors,
    checkedConstraints: live.constraints.length,
    checkedIndexes: standaloneIndexes.length,
    checkedForeignKeys: foreignKeys.length,
    allowlisted,
  };
}

export function formatReport(report: DriftReport): string {
  if (report.errors.length > 0) {
    return (
      'Schema drift check FAILED:\n\n' +
      report.errors.map((error) => `  x ${error}`).join('\n') +
      '\n\nschema.ts is the schema of record (PROJECTPLAN §5.5): every constraint the migration\n' +
      'chain creates must be declared there with the same name, and every declaration must exist\n' +
      'in the database.\n'
    );
  }
  return (
    `Schema drift OK — ${report.checkedConstraints} CHECK/UNIQUE/FOREIGN KEY constraints and ` +
    `${report.checkedIndexes} indexes match schema.ts; ${report.checkedForeignKeys} foreign keys ` +
    `indexed (${report.allowlisted} allowlisted).\n`
  );
}

export async function runSchemaDriftCheck(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required — run this against a freshly migrated database');
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
    const live = await collectLiveSchema(
      (query) => client.unsafe(query) as unknown as Promise<Record<string, unknown>[]>,
    );
    const report = compareSchema(collectDeclaredSchema(), live);
    if (report.errors.length > 0) {
      process.stderr.write(formatReport(report));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(formatReport(report));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSchemaDriftCheck();
}
