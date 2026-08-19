#!/usr/bin/env node
/**
 * Vault v2 quarantine export — the EXTERNAL backup half of the 2026-08-19 owner
 * ruling (PROJECTPLAN §16; "one paranoid implementation").
 *
 * Migration `0089_vault_v2_quarantine.sql` renames the three per-portfolio
 * vault-v2 tables to `zz_vault_v2_backup_*` and parks the two portfolio columns
 * and the legacy migration state in two further `zz_` tables. Nothing in the
 * application references them any more, so the rename is a quarantine, not a
 * deletion: merge-deploy is safe and the rows survive until an operator runs
 * THIS script.
 *
 * What it does
 *   1. Connects with `DATABASE_URL`.
 *   2. Dumps every row of every `zz_vault_v2_backup_*` table into ONE timestamped
 *      JSON file under `BT_VAULT_V2_BACKUP_DIR` (default `$HOME/bettertrack-backups`).
 *   3. Re-reads the written file, parses it, and compares the per-table row
 *      counts against what the database reported.
 *   4. Only with `--drop`, and only after that verification passed, drops the
 *      quarantined tables (and the two v2 enums) inside one transaction.
 *
 * Refusals (all fail closed, before a single byte is written):
 *   - an output directory inside a git working tree — this data must never be
 *     one `git add` away from a public repository;
 *   - a missing `DATABASE_URL`;
 *   - `--drop` when any expected quarantine table is absent (a half-applied
 *     migration must not be "completed" by dropping the rest).
 *
 * `bytea` columns are emitted as `{ "$bytea": "<base64>" }` so the ciphertext
 * round-trips exactly; `Date` becomes an ISO string. The dump is the ONLY copy
 * once `--drop` runs — the ruling is explicit that there is no port path back
 * into the v1 paranoid implementation.
 *
 * Usage:
 *   node scripts/ops/export-vault-v2-backup.mjs            # dump + verify only
 *   node scripts/ops/export-vault-v2-backup.mjs --drop     # dump + verify + destroy
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * `postgres` is a dependency of `apps/api`, not of the repo root, and this
 * script deliberately lives outside any workspace package so an operator can
 * run it from a checkout without installing the API's toolchain. Resolve it
 * from the API package and say so plainly when it is missing.
 */
function loadPostgres() {
  try {
    return require(require.resolve('postgres', { paths: [path.join(REPO_ROOT, 'apps', 'api')] }));
  } catch {
    console.error(
      'Could not resolve the `postgres` driver.\n' +
        'Run `pnpm install` in the repository first (it is a dependency of apps/api).',
    );
    process.exit(1);
  }
}

/** Every table the quarantine migration parks, in dump order. */
export const QUARANTINE_TABLES = [
  'zz_vault_v2_backup_vaults',
  'zz_vault_v2_backup_vault_docs',
  'zz_vault_v2_backup_vault_leave_receipts',
  'zz_vault_v2_backup_portfolio_links',
  'zz_vault_v2_backup_legacy_migration',
];

/**
 * Drop order is the reverse of creation: `vault_docs` references `vaults`, so
 * children first. The two enums go last — `vault_docs.doc_kind` still uses one.
 */
const DROP_ORDER = [
  'zz_vault_v2_backup_legacy_migration',
  'zz_vault_v2_backup_portfolio_links',
  'zz_vault_v2_backup_vault_leave_receipts',
  'zz_vault_v2_backup_vault_docs',
  'zz_vault_v2_backup_vaults',
];

const DROP_ENUMS = ['vault_doc_kind', 'vault_backends'];

/**
 * A directory is refused when it, or any ancestor, contains `.git`. The backup
 * holds every byte of ciphertext plus the account ids that own it; a repo-local
 * path is one `git add -A` away from publication.
 */
export function findGitRoot(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** JSON-safe encoding that keeps `bytea` byte-exact. */
export function encodeValue(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return { $bytea: value.toString('base64') };
  if (value instanceof Uint8Array) return { $bytea: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)]));
  }
  return value;
}

function timestampSlug(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

async function tableExists(sql, name) {
  const rows = await sql`
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = ${name}
  `;
  return rows.length > 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const drop = argv.includes('--drop');
  const unknown = argv.filter((a) => a !== '--drop');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(', ')}`);
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const outDir = path.resolve(
    process.env.BT_VAULT_V2_BACKUP_DIR ?? path.join(homedir(), 'bettertrack-backups'),
  );

  // Fail closed BEFORE connecting: never open a session we are going to abandon.
  const gitRoot = findGitRoot(outDir);
  if (gitRoot) {
    console.error(
      `Refusing to write the vault-v2 backup inside a git working tree.\n` +
        `  requested : ${outDir}\n` +
        `  git root  : ${gitRoot}\n` +
        `Set BT_VAULT_V2_BACKUP_DIR to a path outside every repository.`,
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const postgres = loadPostgres();
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  try {
    const present = [];
    const missing = [];
    for (const table of QUARANTINE_TABLES) {
      if (await tableExists(sql, table)) present.push(table);
      else missing.push(table);
    }

    if (present.length === 0) {
      console.error(
        'No `zz_vault_v2_backup_*` tables found. Either the quarantine migration ' +
          'has not been applied to this database, or the backup already ran with --drop.',
      );
      process.exit(1);
    }

    if (drop && missing.length > 0) {
      console.error(
        `Refusing --drop: the quarantine is incomplete. Missing: ${missing.join(', ')}.\n` +
          'Apply the migration fully, or re-run without --drop to dump what exists.',
      );
      process.exit(1);
    }

    const tables = {};
    const counts = {};
    for (const table of present) {
      // Identifiers come from the constant list above, never from input.
      const rows = await sql`select * from ${sql(table)}`;
      tables[table] = rows.map((row) => encodeValue({ ...row }));
      counts[table] = rows.length;
    }

    const payload = {
      kind: 'bettertrack.vault-v2-quarantine-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      note:
        'Per-portfolio vault v2 surface, removed by the 2026-08-19 owner ruling ' +
        '(PROJECTPLAN §16). Ciphertext is client-encrypted and NOT readable ' +
        'without the owning user’s vault passphrase. There is no port path into ' +
        'the v1 paranoid implementation.',
      counts,
      missingTables: missing,
      tables,
    };

    const file = path.join(outDir, `vault-v2-quarantine-${timestampSlug()}.json`);
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });

    // Verification: the file on disk must parse back to the same row counts.
    // Reading our own in-memory object proves nothing about what was written.
    const reread = JSON.parse(readFileSync(file, 'utf8'));
    const mismatches = present.filter(
      (table) => (reread.tables?.[table]?.length ?? -1) !== counts[table],
    );
    if (mismatches.length > 0) {
      console.error(
        `Backup verification FAILED for: ${mismatches.join(', ')}. Nothing was dropped.`,
      );
      process.exit(1);
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`Wrote ${file} (${statSync(file).size} bytes)`);
    for (const table of present) console.log(`  ${table}: ${counts[table]} row(s)`);
    if (missing.length > 0) console.log(`  (absent: ${missing.join(', ')})`);
    console.log(`Verified ${total} row(s) round-trip from the written file.`);

    if (!drop) {
      console.log('\nDry run — nothing dropped. Re-run with --drop to destroy the quarantine.');
      return;
    }

    await sql.begin(async (tx) => {
      for (const table of DROP_ORDER) {
        if (!present.includes(table)) continue;
        await tx`drop table if exists ${tx(table)} cascade`;
      }
      for (const enumName of DROP_ENUMS) {
        await tx.unsafe(`drop type if exists "public"."${enumName}"`);
      }
    });
    console.log(
      '\nDropped the quarantined vault-v2 tables and enums. The JSON file is now the only copy.',
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (exitCode !== 0) process.exit(exitCode);
}

// Importable for tests; only the direct invocation runs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
