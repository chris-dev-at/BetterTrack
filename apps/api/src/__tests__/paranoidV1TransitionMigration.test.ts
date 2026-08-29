import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { describe, expect, it } from 'vitest';

/**
 * Migration `0101_paranoid_v1_transition` — the E9 / §17 transition machinery.
 *
 * The single most important property asserted here is a NEGATIVE one: applying
 * this migration must not wipe anybody. Merge is deploy on the production host,
 * so this file runs unattended the moment the PR lands — while §17 step 1 is
 * explicit that the owner-run verified ciphertext backup comes first and that
 * only "THEN any destructive step" may follow. So the migration ships the
 * quarantine tables and the attestation gate; `paranoidV1WipeService` executes
 * behind that gate, per account, once an attestation exists.
 *
 * The other load-bearing property is that the quarantine is INERT: it carries no
 * foreign key back to `users`, so an account deletion between the wipe and the
 * §19 deletion train cannot cascade away the very rows the quarantine preserves.
 * That is the lesson `0089_vault_v2_quarantine` learned the hard way (its step 4
 * severs every inbound cascade before renaming).
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function journal(): JournalEntry[] {
  const parsed = JSON.parse(readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return [...parsed.entries].sort((a, b) => a.idx - b.idx);
}

/** Apply one migration file the way drizzle's migrator does: statement chunks, one transaction. */
async function applyMigration(client: PGlite, tag: string): Promise<void> {
  const sql = readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
  const chunks = sql
    .split(/-->\s*statement-breakpoint\s*/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  await client.exec('BEGIN');
  try {
    for (const chunk of chunks) {
      await client.exec(chunk);
    }
    await client.exec('COMMIT');
  } catch (err) {
    await client.exec('ROLLBACK');
    throw err;
  }
}

const TAG = '0102_paranoid_v1_transition';

const U1 = '019756a0-0000-7000-8000-0000000e9001';
const U2 = '019756a0-0000-7000-8000-0000000e9002';
const ATT = '019756a0-0000-7000-8000-0000000e90a1';

/** Boot a PGlite with every migration up to and including `throughTag` applied. */
async function boot(throughTag: string): Promise<PGlite> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const tags = journal().map((e) => e.tag);
  const stop = tags.indexOf(throughTag);
  if (stop < 0) throw new Error(`migration ${throughTag} is not in the journal`);
  for (const tag of tags.slice(0, stop + 1)) {
    await applyMigration(client, tag);
  }
  return client;
}

/** A live v1 paranoid account with a row in every one of the seven legacy tables. */
async function seedLegacyParanoidAccount(client: PGlite, userId: string): Promise<void> {
  await client.exec(`
    INSERT INTO "users" ("id", "email", "username", "password_hash", "privacy_mode", "paranoid_media_set")
    VALUES ('${userId}', '${userId}@example.test', 'u${userId.slice(-8)}', 'x', 'paranoid', ARRAY['server']::text[]);
  `);
  await client.exec(`
    INSERT INTO "paranoid_vaults" ("user_id", "version", "format_version", "size_bytes", "blob")
    VALUES ('${userId}', 7, 1, 3, '\\x414243'::bytea);
    INSERT INTO "paranoid_vault_history" ("id", "user_id", "version", "format_version", "size_bytes", "blob")
    VALUES (gen_random_uuid(), '${userId}', 6, 1, 3, '\\x414244'::bytea);
    INSERT INTO "paranoid_enable_transitions" ("user_id", "expires_at")
    VALUES ('${userId}', now() + interval '10 minutes');
    INSERT INTO "paranoid_vault_server_candidates" ("id", "user_id", "version", "format_version", "size_bytes", "blob", "expires_at")
    VALUES (gen_random_uuid(), '${userId}', 8, 1, 3, '\\x414245'::bytea, now() + interval '10 minutes');
    INSERT INTO "paranoid_vault_retirements" ("user_id", "retired_version", "retirement_proof_public_key")
    VALUES ('${userId}', 5, 'pk-legacy');
    INSERT INTO "paranoid_vault_retired" ("id", "user_id", "version", "format_version", "size_bytes", "blob", "created_at")
    VALUES (gen_random_uuid(), '${userId}', 5, 1, 3, '\\x414246'::bytea, now());
    INSERT INTO "paranoid_rehydration_receipts" ("user_id", "rehydration_id")
    VALUES ('${userId}', gen_random_uuid());
  `);
}

async function count(client: PGlite, table: string): Promise<number> {
  const res = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`);
  return res.rows[0]!.n;
}

const LEGACY_TABLES = [
  'paranoid_vaults',
  'paranoid_vault_history',
  'paranoid_enable_transitions',
  'paranoid_vault_server_candidates',
  'paranoid_vault_retirements',
  'paranoid_vault_retired',
  'paranoid_rehydration_receipts',
] as const;

const QUARANTINE_TABLES = LEGACY_TABLES.map((t) => `zz_paranoid_v1_backup_${t}`);

describe('migration 0102_paranoid_v1_transition', () => {
  it('is appended, not edited: next free idx with a strictly newer `when`', () => {
    const entries = journal();
    const mine = entries.find((e) => e.tag === TAG);
    expect(mine, `${TAG} must be in the journal`).toBeDefined();
    const previous = entries[entries.indexOf(mine!) - 1]!;
    expect(mine!.idx).toBe(previous.idx + 1);
    expect(mine!.when).toBeGreaterThan(previous.when);
    // It must be the tail: nothing may sort after it.
    expect(entries[entries.length - 1]!.tag).toBe(TAG);
  });

  it('wipes nobody at deploy time — every legacy row and the paranoid mode survive', async () => {
    // Boot to the migration immediately BEFORE this one, seed a live paranoid
    // account, then apply this one on top — that is the production shape.
    const client = await boot(journal().at(-2)!.tag);
    try {
      await seedLegacyParanoidAccount(client, U1);
      await applyMigration(client, TAG);

      for (const table of LEGACY_TABLES) {
        expect(await count(client, table), `${table} must be untouched by the deploy`).toBe(1);
      }
      const user = await client.query<{ privacy_mode: string; paranoid_media_set: string[] }>(
        `SELECT "privacy_mode", "paranoid_media_set" FROM "users" WHERE "id" = '${U1}'`,
      );
      expect(user.rows[0]!.privacy_mode).toBe('paranoid');
      expect(user.rows[0]!.paranoid_media_set).toEqual(['server']);

      // ...and the quarantine it created is empty. The wipe fills it, not this.
      for (const table of QUARANTINE_TABLES) {
        expect(await count(client, table), `${table} must start empty`).toBe(0);
      }
      expect(await count(client, 'paranoid_v1_backup_attestations')).toBe(0);
      expect(await count(client, 'paranoid_v1_wipe_receipts')).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('quarantine tables carry no cascade from `users` — deleting the account keeps the backup', async () => {
    const client = await boot(TAG);
    try {
      await seedLegacyParanoidAccount(client, U2);
      await client.exec(`
        INSERT INTO "paranoid_v1_backup_attestations"
          ("id", "archive_file", "archive_sha256", "row_counts", "user_digests", "created_by")
        VALUES ('${ATT}', '/backups/a.json', repeat('a', 64), '{}'::jsonb, '{}'::jsonb, 'owner');
        INSERT INTO "zz_paranoid_v1_backup_paranoid_vaults"
          ("user_id", "version", "format_version", "size_bytes", "blob", "created_at", "updated_at", "attestation_id")
        VALUES ('${U2}', 7, 1, 3, '\\x414243'::bytea, now(), now(), '${ATT}');
      `);

      await client.exec(`DELETE FROM "users" WHERE "id" = '${U2}'`);

      // The live rows went with the account (their FK cascades, by design).
      expect(await count(client, 'paranoid_vaults')).toBe(0);
      // The quarantine did NOT: it is the backup of record until the §19 train.
      expect(await count(client, 'zz_paranoid_v1_backup_paranoid_vaults')).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('an attestation cannot claim an offsite copy without the digest that proves it', async () => {
    const client = await boot(TAG);
    try {
      await expect(
        client.exec(`
          INSERT INTO "paranoid_v1_backup_attestations"
            ("id", "archive_file", "archive_sha256", "row_counts", "user_digests", "created_by", "offsite_confirmed_at")
          VALUES (gen_random_uuid(), '/b.json', repeat('b', 64), '{}'::jsonb, '{}'::jsonb, 'owner', now());
        `),
      ).rejects.toThrow(/paranoid_v1_backup_attestations_offsite_pair/u);
    } finally {
      await client.close();
    }
  });
});
