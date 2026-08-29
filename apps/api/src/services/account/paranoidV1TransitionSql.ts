import { sql, type SQL } from 'drizzle-orm';

/**
 * The account-digest statement shared by §17's two halves.
 *
 * `scripts/ops/export-paranoid-v1-backup.mjs` runs it once per covered account at
 * backup time and stores the result in `paranoid_v1_backup_attestations.user_digests`.
 * `paranoidV1WipeService` runs the SAME statement inside the wipe transaction and
 * refuses unless the digest still matches. That comparison is what stops an
 * account whose vault changed after the backup from being destroyed against a
 * stale archive — so the two sides must agree exactly, and
 * `exportParanoidV1Backup.test.ts` pins them to each other byte for byte.
 *
 * Design notes, all load-bearing:
 *
 *  * The digest is computed IN POSTGRES, not in JavaScript. The ops script speaks
 *    the raw `postgres` driver and the service speaks drizzle; those two return
 *    different JS shapes for `bytea`, `timestamptz` and `text[]`, so any digest
 *    computed after the values crossed into JS would have to re-canonicalise them
 *    identically on both sides — an invisible way for the check to silently stop
 *    meaning anything. One SQL string executed by both sides has no such seam.
 *
 *  * `sha256()` is a PostgreSQL 11+ BUILT-IN. It needs no `pgcrypto`, so the
 *    statement runs unchanged on the prod host and under PGlite in tests.
 *
 *  * `t::text` renders a whole row in the table's column order, `bytea` included
 *    as `\x…` hex — the ciphertext is covered, not just its length.
 *
 *  * `ORDER BY tbl, repr` inside `string_agg` makes the result independent of
 *    physical row order, which Postgres never promises.
 *
 *  * The user id is bound ONCE, through the `target` CTE, so both callers can
 *    parameterise a single `$1` instead of interpolating an id eight times.
 *
 *  * The `users` row is part of the digest: `privacy_mode` and the two paranoid
 *    media columns are exactly what the wipe flips, so they belong to the state
 *    the backup attests to.
 *
 * An account with no legacy rows at all digests the empty string — a real,
 * stable value. The wipe never relies on that alone; it requires an attestation
 * that names the account.
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

/**
 * The same statement as a drizzle fragment with the account id bound as a real
 * parameter. Splitting on the single `$1` keeps the text identical to the ops
 * script's copy while never interpolating an id into SQL.
 */
export function paranoidV1AccountDigestQuery(userId: string): SQL {
  const [before, after] = PARANOID_V1_ACCOUNT_DIGEST_SQL.split('$1');
  /* istanbul ignore next -- guarded by the byte-for-byte drift test */
  if (after === undefined) {
    throw new Error('PARANOID_V1_ACCOUNT_DIGEST_SQL lost its $1 placeholder');
  }
  return sql`${sql.raw(before!)}${userId}${sql.raw(after)}`;
}

/**
 * `db.execute` hands back `{ rows }` on some drivers and a bare array on others
 * (the same quirk `cashRuleTagStamp.ts` documents). The wipe reads its digest
 * through this, so getting it wrong would mean comparing against `undefined` —
 * which must never silently look like a match.
 */
export function resultRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * The seven v1 tables §19 lists under "Dies at the end of §17", in the order the
 * archive dumps them. `paranoid_vaults` leads because it is the row §17 step 1
 * names explicitly ("every `paranoid_vaults` account blob + bounded history").
 */
export const PARANOID_V1_LEGACY_TABLES = [
  'paranoid_vaults',
  'paranoid_vault_history',
  'paranoid_enable_transitions',
  'paranoid_vault_server_candidates',
  'paranoid_vault_retirements',
  'paranoid_vault_retired',
  'paranoid_rehydration_receipts',
] as const;

/**
 * The operator's "what would this wipe touch?" listing — the accounts named by an
 * attestation whose offsite copy is confirmed, minus the ones already wiped.
 *
 * A LISTING only. It deliberately does not re-implement the digest check, because
 * duplicating a gate is how a gate drifts: `paranoidV1WipeService` re-runs every
 * check inside its own transaction and is the sole authority. A row here means
 * "eligible-looking", never "will be wiped".
 *
 * It lives here rather than inline in the script so the suite can execute the
 * exact statement an operator runs — `jsonb_each_text` over a `jsonb` map plus the
 * `::uuid` cast is the kind of SQL that typechecks fine and fails at runtime.
 */
export const PARANOID_V1_WIPE_CANDIDATES_SQL = `
select distinct d.key as user_id, a."id" as attestation_id
  from "paranoid_v1_backup_attestations" a
  cross join lateral jsonb_each_text(a."user_digests") d
 where a."offsite_confirmed_at" is not null
   and not exists (
     select 1 from "paranoid_v1_wipe_receipts" r where r."user_id" = d.key::uuid
   )
 order by d.key
`.trim();

export type ParanoidV1LegacyTable = (typeof PARANOID_V1_LEGACY_TABLES)[number];
