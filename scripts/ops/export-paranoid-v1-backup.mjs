#!/usr/bin/env node
/**
 * PARANOID E9 — §17 step 1: the owner-run VERIFIED ciphertext backup.
 *
 * `docs/paranoid-design.md` §17, ruled (C) "backup + wipe" on 2026-08-20 (§21 Q3):
 *
 *   "External ciphertext backup first — the PR #1392 ops pattern
 *    (`scripts/ops/export-vault-v2-backup.mjs` is the verified-dump precedent):
 *    dump every `paranoid_vaults` account blob + bounded history to a verified
 *    archive on the prod host, offsite copy confirmed, THEN any destructive
 *    step. The owner runs/authorizes the backup, exactly as with the v2
 *    teardown."
 *
 * This script is that step, and it is the ONLY thing in the codebase that can
 * open the gate on the wipe. It writes no destructive statement itself.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * On a verified dump it inserts one `paranoid_v1_backup_attestations` row: the
 * archive path, the archive's SHA-256, the per-table row counts, and a per-account
 * digest of the legacy rows as they stood at dump time.
 * `paranoidV1WipeService` refuses to touch an account that is not covered by such
 * a row, and refuses again if the account's digest has moved since. That is a
 * fact the server established for itself — never a client claim — which is what
 * PROJECTPLAN §16's 2026-07-28 ruling requires of anything that destroys.
 *
 * The attestation is NOT enough on its own. §17 says "offsite copy confirmed,
 * THEN any destructive step", so the wipe additionally requires
 * `offsite_confirmed_at`, which only `--confirm-offsite` sets, and only when the
 * digest of the copy that left the host matches the archive byte for byte.
 *
 * ── Verification is real ────────────────────────────────────────────────────
 * `writeFileSync` returning proves nothing. After writing, the archive is read
 * back FROM DISK, parsed, and matched on both the per-table row counts and a
 * SHA-256 digest of its canonical content. A short write, a full disk or a
 * mangled encoder fails here, loudly, and nothing is attested.
 *
 * ── Refusals, all fail-closed and all before any write ──────────────────────
 *   - an output directory inside a git working tree (this archive is every byte
 *     of account ciphertext plus the ids that own it — never one `git add` away
 *     from a public repository);
 *   - a missing `DATABASE_URL`;
 *   - `--confirm-offsite` for an archive with no attestation, or with a digest
 *     that does not match.
 *
 * `bytea` is emitted as `{ "$bytea": "<base64>" }` so ciphertext round-trips
 * byte-exact; `Date` becomes an ISO string. The ciphertext is client-encrypted:
 * this script cannot read it, and neither can the server (§16 — lost phrase =
 * lost vault; there is no escrow and no port path).
 *
 * Usage:
 *   node scripts/ops/export-paranoid-v1-backup.mjs
 *       # dump + verify + attest
 *   sha256sum <archive-on-the-offsite-target>
 *   node scripts/ops/export-paranoid-v1-backup.mjs --confirm-offsite <sha256> --archive <path>
 *       # record that the offsite copy is real; opens the gate on the wipe
 */

import { createRequire } from 'node:module';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * The seven v1 tables §19 lists under "Dies at the end of §17", in dump order.
 * Mirrors `PARANOID_V1_LEGACY_TABLES` in
 * `apps/api/src/services/account/paranoidV1TransitionSql.ts`.
 */
export const LEGACY_TABLES = [
  'paranoid_vaults',
  'paranoid_vault_history',
  'paranoid_enable_transitions',
  'paranoid_vault_server_candidates',
  'paranoid_vault_retirements',
  'paranoid_vault_retired',
  'paranoid_rehydration_receipts',
];

/**
 * The per-account digest statement. This is a VERBATIM copy of
 * `PARANOID_V1_ACCOUNT_DIGEST_SQL` in
 * `apps/api/src/services/account/paranoidV1TransitionSql.ts`, which carries the
 * full rationale. The copy exists because this script deliberately runs outside
 * the API's toolchain (an operator can run it from a plain checkout); the two
 * strings are pinned to each other, byte for byte, by
 * `apps/api/src/__tests__/exportParanoidV1Backup.test.ts`. If you edit one, edit
 * both — the wipe's staleness check is meaningless if they drift.
 */
export const PARANOID_V1_ACCOUNT_DIGEST_SQL = `
WITH target AS (SELECT $1::uuid AS uid),
parts AS (
  SELECT 'users_paranoid'::text AS tbl,
         (u."privacy_mode"::text
          || '|' || coalesce(array_to_string(u."paranoid_media_set", ','), '')
          || '|' || coalesce(u."paranoid_drive_attested_version"::text, '')) AS repr
    FROM "users" u WHERE u."id" = (SELECT uid FROM target)
  UNION ALL
  SELECT 'paranoid_vaults'::text, t::text FROM "paranoid_vaults" t
   WHERE t."user_id" = (SELECT uid FROM target)
  UNION ALL
  SELECT 'paranoid_vault_history'::text, t::text FROM "paranoid_vault_history" t
   WHERE t."user_id" = (SELECT uid FROM target)
  UNION ALL
  SELECT 'paranoid_enable_transitions'::text, t::text FROM "paranoid_enable_transitions" t
   WHERE t."user_id" = (SELECT uid FROM target)
  UNION ALL
  SELECT 'paranoid_vault_server_candidates'::text, t::text FROM "paranoid_vault_server_candidates" t
   WHERE t."user_id" = (SELECT uid FROM target)
  UNION ALL
  SELECT 'paranoid_vault_retirements'::text, t::text FROM "paranoid_vault_retirements" t
   WHERE t."user_id" = (SELECT uid FROM target)
  UNION ALL
  SELECT 'paranoid_vault_retired'::text, t::text FROM "paranoid_vault_retired" t
   WHERE t."user_id" = (SELECT uid FROM target)
  UNION ALL
  SELECT 'paranoid_rehydration_receipts'::text, t::text FROM "paranoid_rehydration_receipts" t
   WHERE t."user_id" = (SELECT uid FROM target)
)
SELECT encode(
  sha256(convert_to(coalesce(string_agg(tbl || ':' || repr, E'\\n' ORDER BY tbl, repr), ''), 'UTF8')),
  'hex'
) AS digest
FROM parts
`.trim();

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

/**
 * A directory is refused when it, or any ancestor, contains `.git`. Same rule as
 * the v2 precedent, same reason: the archive holds user ciphertext and the
 * account ids that own it.
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

/** The digest the archive is verified against: SHA-256 over the serialised tables. */
export function contentDigest(tables) {
  return createHash('sha256').update(JSON.stringify(tables)).digest('hex');
}

function timestampSlug(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Re-read the archive FROM DISK and prove it says what we meant to write.
 *
 * Both halves matter. The row counts catch a truncated or partially serialised
 * dump; the content digest catches anything that changed a value without changing
 * a count. Callers treat `ok: false` as fatal — no attestation, so no wipe.
 */
export function verifyArchive({ file, expectedCounts, expectedContentSha256 }) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `archive is not readable JSON: ${String(error)}` };
  }
  const tables = parsed?.tables;
  if (!tables || typeof tables !== 'object') {
    return { ok: false, reason: 'archive has no `tables` object' };
  }
  for (const [table, expected] of Object.entries(expectedCounts)) {
    const actual = Array.isArray(tables[table]) ? tables[table].length : -1;
    if (actual !== expected) {
      return {
        ok: false,
        reason: `${table}: archive holds ${actual} row(s), expected ${expected}`,
      };
    }
  }
  const actualDigest = contentDigest(tables);
  if (actualDigest !== expectedContentSha256) {
    return { ok: false, reason: 'archive content digest does not match what was written' };
  }
  return { ok: true, archiveSha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

/** Constant-time hex compare — the operator-supplied offsite digest is untrusted input. */
function digestsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Dump → verify → attest. `port` is the database seam so the suite can drive
 * every branch hermetically; `main()` supplies the real `postgres`-backed one.
 */
export async function runExport({ port, outDir, createdBy, now = new Date() }) {
  const gitRoot = findGitRoot(outDir);
  if (gitRoot) {
    throw new Error(
      `Refusing to write the paranoid-v1 backup inside a git working tree.\n` +
        `  requested : ${outDir}\n  git root  : ${gitRoot}`,
    );
  }
  mkdirSync(outDir, { recursive: true });

  const tables = {};
  const counts = {};
  for (const table of LEGACY_TABLES) {
    const rows = await port.readTable(table);
    tables[table] = rows.map((row) => encodeValue({ ...row }));
    counts[table] = rows.length;
  }

  // Per-account digests, computed by Postgres via the statement the wipe shares.
  const userIds = await port.listUserIds();
  const userDigests = {};
  for (const userId of userIds) {
    userDigests[userId] = await port.accountDigest(userId);
  }

  const payload = {
    kind: 'bettertrack.paranoid-v1-transition-backup',
    version: 1,
    exportedAt: now.toISOString(),
    note:
      'Account-level (v1) paranoid vault data, retired by docs/paranoid-design.md ' +
      '§17 as ruled (C) on 2026-08-20. Ciphertext is client-encrypted and NOT ' +
      'readable without the account’s legacy passphrase, which dies with the wipe ' +
      '(§17 step 2). There is no port path into the per-portfolio vault model.',
    counts,
    userDigests,
    tables,
  };

  const file = path.join(outDir, `paranoid-v1-transition-${timestampSlug(now)}.json`);
  const expectedContentSha256 = contentDigest(tables);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });

  const verdict = verifyArchive({ file, expectedCounts: counts, expectedContentSha256 });
  if (!verdict.ok) {
    throw new Error(`Backup verification FAILED: ${verdict.reason}. Nothing was attested.`);
  }

  await port.insertAttestation({
    id: randomUUID(),
    archiveFile: file,
    archiveSha256: verdict.archiveSha256,
    rowCounts: counts,
    userDigests,
    createdBy,
    offsiteConfirmedAt: null,
    offsiteConfirmedSha256: null,
  });

  return { file, archiveSha256: verdict.archiveSha256, counts, userDigests };
}

/**
 * §17's "offsite copy confirmed", recorded as a checked fact. The operator
 * digests the copy that actually left the host; only a constant-time match against
 * the archive's own digest sets `offsite_confirmed_at`, and only that column lets
 * `paranoidV1WipeService` proceed.
 */
export async function confirmOffsite({ port, archiveFile, offsiteSha256 }) {
  const attestation = await port.attestationByArchiveFile(archiveFile);
  if (!attestation) {
    throw new Error(
      `No attestation for ${archiveFile}. Run the export first; an unverified ` +
        'archive can never authorise a wipe.',
    );
  }
  if (!digestsEqual(attestation.archiveSha256, offsiteSha256)) {
    throw new Error(
      'The offsite digest does not match the archive on this host. Nothing was ' +
        'confirmed and the wipe stays locked.',
    );
  }
  await port.markOffsiteConfirmed(attestation.id, offsiteSha256);
  return { attestationId: attestation.id };
}

/** The real database seam. Identifiers come from the constant list above, never from input. */
function postgresPort(sql) {
  return {
    async readTable(name) {
      return sql`select * from ${sql(name)}`;
    },
    async listUserIds() {
      const rows = await sql`
        select "id" from "users"
         where "privacy_mode" = 'paranoid'
            or exists (select 1 from "paranoid_vaults" v where v."user_id" = "users"."id")
            or exists (select 1 from "paranoid_vault_history" h where h."user_id" = "users"."id")
            or exists (select 1 from "paranoid_vault_retired" r where r."user_id" = "users"."id")
         order by "id"
      `;
      return rows.map((r) => r.id);
    },
    async accountDigest(userId) {
      const rows = await sql.unsafe(PARANOID_V1_ACCOUNT_DIGEST_SQL, [userId]);
      return rows[0].digest;
    },
    async insertAttestation(record) {
      await sql`
        insert into "paranoid_v1_backup_attestations"
          ("id", "archive_file", "archive_sha256", "row_counts", "user_digests", "created_by")
        values (${record.id}, ${record.archiveFile}, ${record.archiveSha256},
                ${sql.json(record.rowCounts)}, ${sql.json(record.userDigests)}, ${record.createdBy})
      `;
    },
    async attestationByArchiveFile(file) {
      const rows = await sql`
        select "id", "archive_sha256" from "paranoid_v1_backup_attestations"
         where "archive_file" = ${file} order by "created_at" desc limit 1
      `;
      return rows.length === 0 ? null : { id: rows[0].id, archiveSha256: rows[0].archive_sha256 };
    },
    async markOffsiteConfirmed(id, sha) {
      await sql`
        update "paranoid_v1_backup_attestations"
           set "offsite_confirmed_at" = now(), "offsite_confirmed_sha256" = ${sha}
         where "id" = ${id}
      `;
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const offsite = flag('--confirm-offsite');
  const archiveArg = flag('--archive');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  if (offsite && !archiveArg) {
    console.error('--confirm-offsite also needs --archive <path to the archive on this host>.');
    process.exit(1);
  }

  const outDir = path.resolve(
    process.env.BT_PARANOID_V1_BACKUP_DIR ?? path.join(homedir(), 'bettertrack-backups'),
  );

  // Fail closed BEFORE connecting: never open a session we are going to abandon.
  if (!offsite) {
    const gitRoot = findGitRoot(outDir);
    if (gitRoot) {
      console.error(
        `Refusing to write the paranoid-v1 backup inside a git working tree.\n` +
          `  requested : ${outDir}\n  git root  : ${gitRoot}\n` +
          `Set BT_PARANOID_V1_BACKUP_DIR to a path outside every repository.`,
      );
      process.exit(1);
    }
  }

  const postgres = loadPostgres();
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const port = postgresPort(sql);

  let exitCode = 0;
  try {
    if (offsite) {
      const { attestationId } = await confirmOffsite({
        port,
        archiveFile: path.resolve(archiveArg),
        offsiteSha256: offsite.trim().toLowerCase(),
      });
      console.log(`Offsite copy confirmed for attestation ${attestationId}.`);
      console.log('The §17 wipe is now unlocked for the accounts this attestation covers.');
      return;
    }

    const result = await runExport({
      port,
      outDir,
      createdBy: process.env.USER ?? 'operator',
    });

    console.log(`Wrote ${result.file} (${statSync(result.file).size} bytes)`);
    for (const table of LEGACY_TABLES) console.log(`  ${table}: ${result.counts[table]} row(s)`);
    console.log(`Accounts covered: ${Object.keys(result.userDigests).length}`);
    console.log(`Archive SHA-256 : ${result.archiveSha256}`);
    console.log(
      '\nVerified against the file on disk (row counts + content digest).\n' +
        'NOTHING has been destroyed and the wipe is still locked.\n\n' +
        'Next, per §17 step 1 ("offsite copy confirmed, THEN any destructive step"):\n' +
        `  1. copy the archive off this host\n` +
        `  2. digest the COPY at its destination (sha256sum)\n` +
        `  3. node scripts/ops/export-paranoid-v1-backup.mjs --confirm-offsite <sha256> --archive ${result.file}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
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
