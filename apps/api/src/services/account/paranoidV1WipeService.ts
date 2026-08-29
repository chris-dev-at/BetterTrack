import { timingSafeEqual } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import type { Database } from '../../data/db';
import { paranoidV1BackupAttestations, paranoidV1WipeReceipts, users } from '../../data/schema';
import { paranoidV1AccountDigestQuery, resultRows } from './paranoidV1TransitionSql';

/**
 * PARANOID E9 — §17 step 2: "Wipe + reset".
 *
 * `docs/paranoid-design.md` §17, ruled (C) "backup + wipe" on 2026-08-20 (§21 Q3):
 *
 *   "Wipe + reset: one migration retires the account-level rows (quarantined
 *    behind the backup, `zz_`-prefix pattern), flips affected accounts'
 *    `privacy_mode` to `normal`, and clears the account-kill state. Those
 *    accounts come back feature-complete and empty of previously vaulted
 *    content; the legacy passphrase and recovery kit die with the wipe."
 *
 * ── Why this is a service and not the migration body ────────────────────────
 * Because §17 step 1 puts the owner's verified backup FIRST — "offsite copy
 * confirmed, THEN any destructive step. The owner runs/authorizes the backup" —
 * and merge is deploy on the production host. A migration body runs unattended
 * the instant the PR lands, so a wipe written there would execute BEFORE the
 * backup that §17 makes its precondition: the exact inversion the ruling forbids.
 *
 * `0102_paranoid_v1_transition` therefore ships the quarantine and the gate, and
 * this service performs the retirement per account, behind that gate, once
 * `scripts/ops/export-paranoid-v1-backup.mjs` has recorded a verified,
 * offsite-confirmed attestation. §17's "quarantined BEHIND the backup" is
 * implemented literally: the backup is the thing standing in front.
 *
 * ── Reachability ────────────────────────────────────────────────────────────
 * Nothing wires this to an HTTP route, and a test asserts that. §17 makes the
 * wipe an owner-run operation; a route would put an irreversible account-level
 * destruction one authenticated request away from a caller who cannot satisfy
 * its precondition. The service is fail-closed regardless — every exit above the
 * destructive block is a refusal — but the absence of a route is the first line,
 * and the gate is the second.
 *
 * ── Ordering, inside one transaction ────────────────────────────────────────
 * Locks are taken BEFORE the digest is recomputed, and the digest is recomputed
 * BEFORE anything is written. A concurrent v1 vault write therefore either
 * committed before our read — in which case the digest no longer matches the
 * archive and we refuse — or is blocked on our lock until the wipe commits. There
 * is no window in which we destroy a byte the backup does not contain.
 *
 * Idempotency key: `paranoid_v1_wipe_receipts.user_id` (its primary key). A second
 * wipe of the same account is refused rather than re-run, so a retried operator
 * command can never double-quarantine or re-flip an account.
 */

/** Every refusal is fail-closed: it returns before the destructive block. */
export type ParanoidV1WipeRefusal =
  /** No offsite-confirmed attestation names this account. */
  | 'NO_VERIFIED_BACKUP'
  /** An attestation exists, but §17's "offsite copy confirmed" step never ran. */
  | 'BACKUP_NOT_OFFSITE_CONFIRMED'
  /** The account's legacy rows moved after the archive was taken. */
  | 'BACKUP_STALE'
  /** This account already has a wipe receipt. */
  | 'ALREADY_WIPED';

export interface ParanoidV1WipeOutcome {
  ok: boolean;
  refusal?: ParanoidV1WipeRefusal;
  attestationId?: string;
}

/** Constant-time hex compare of two server-computed digests. */
function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * The seven quarantine moves, in the order §19 lists the tables. Each is a single
 * `INSERT ... SELECT`, which copies `bytea` ciphertext byte-exact inside the
 * transaction — no round trip through JavaScript on the one path in this codebase
 * that must not corrupt what it is preserving. Column lists are explicit so a
 * future column added to a live table fails loudly here instead of being dropped
 * silently from the quarantine.
 */
const QUARANTINE_MOVES: ReadonlyArray<
  (userId: string, attestationId: string) => ReturnType<typeof sql>
> = [
  (u, a) => sql`
    insert into "zz_paranoid_v1_backup_paranoid_vaults"
      ("user_id", "version", "format_version", "size_bytes", "blob", "retirement_proof_public_key",
       "migrating_by", "migration_expires_at", "migrated_to", "created_at", "updated_at", "attestation_id")
    select "user_id", "version", "format_version", "size_bytes", "blob", "retirement_proof_public_key",
           "migrating_by", "migration_expires_at", "migrated_to", "created_at", "updated_at", ${a}::uuid
      from "paranoid_vaults" where "user_id" = ${u}`,
  (u, a) => sql`
    insert into "zz_paranoid_v1_backup_paranoid_vault_history"
      ("history_id", "user_id", "version", "format_version", "size_bytes", "blob", "created_at", "attestation_id")
    select "id", "user_id", "version", "format_version", "size_bytes", "blob", "created_at", ${a}::uuid
      from "paranoid_vault_history" where "user_id" = ${u}`,
  (u, a) => sql`
    insert into "zz_paranoid_v1_backup_paranoid_enable_transitions"
      ("user_id", "expires_at", "created_at", "updated_at", "attestation_id")
    select "user_id", "expires_at", "created_at", "updated_at", ${a}::uuid
      from "paranoid_enable_transitions" where "user_id" = ${u}`,
  (u, a) => sql`
    insert into "zz_paranoid_v1_backup_paranoid_vault_server_candidates"
      ("candidate_id", "user_id", "version", "format_version", "size_bytes", "blob",
       "retirement_proof_public_key", "created_at", "expires_at", "attestation_id")
    select "id", "user_id", "version", "format_version", "size_bytes", "blob",
           "retirement_proof_public_key", "created_at", "expires_at", ${a}::uuid
      from "paranoid_vault_server_candidates" where "user_id" = ${u}`,
  (u, a) => sql`
    insert into "zz_paranoid_v1_backup_paranoid_vault_retirements"
      ("user_id", "retired_version", "retirement_proof_public_key", "retired_at", "attestation_id")
    select "user_id", "retired_version", "retirement_proof_public_key", "retired_at", ${a}::uuid
      from "paranoid_vault_retirements" where "user_id" = ${u}`,
  (u, a) => sql`
    insert into "zz_paranoid_v1_backup_paranoid_vault_retired"
      ("retired_id", "user_id", "version", "format_version", "size_bytes", "blob",
       "created_at", "retired_at", "attestation_id")
    select "id", "user_id", "version", "format_version", "size_bytes", "blob",
           "created_at", "retired_at", ${a}::uuid
      from "paranoid_vault_retired" where "user_id" = ${u}`,
  (u, a) => sql`
    insert into "zz_paranoid_v1_backup_paranoid_rehydration_receipts"
      ("user_id", "rehydration_id", "completed_at", "attestation_id")
    select "user_id", "rehydration_id", "completed_at", ${a}::uuid
      from "paranoid_rehydration_receipts" where "user_id" = ${u}`,
];

/**
 * Deletion order is the reverse of nothing in particular — these seven tables
 * reference `users`, never each other — but it is fixed so the statement log of a
 * production wipe is stable and reviewable.
 */
const LEGACY_DELETES = [
  'paranoid_rehydration_receipts',
  'paranoid_vault_retired',
  'paranoid_vault_retirements',
  'paranoid_vault_server_candidates',
  'paranoid_enable_transitions',
  'paranoid_vault_history',
  'paranoid_vaults',
] as const;

/**
 * Retire ONE account's v1 paranoid surface. Returns a refusal instead of throwing
 * for every precondition failure, so an operator sweeping a list of accounts gets
 * a per-account verdict rather than a half-finished run.
 */
export async function wipeParanoidV1Account(
  db: Database,
  userId: string,
): Promise<ParanoidV1WipeOutcome> {
  return db.transaction(async (tx) => {
    // ── Locks first ─────────────────────────────────────────────────────────
    // The user row carries `privacy_mode` and the media columns this wipe flips;
    // the vault row is what a concurrent v1 sync would update. Taking both before
    // reading the digest closes the check-then-act window.
    //
    // `FOR UPDATE` on the USER row is the load-bearing half, and it works because
    // every v1 vault write already funnels through `withLockedPrivacyModes`, which
    // takes `SELECT … FOR KEY SHARE` on that same row (`paranoidEnforcementRepository.ts`,
    // used by `paranoidVaultRepository.ts` on the CAS write paths). KEY SHARE
    // conflicts with FOR UPDATE, so a concurrent sync either committed before this
    // read — and the digest below no longer matches, so we refuse — or it waits
    // until this transaction commits and then finds the rows gone. It holds across
    // connections, so the dedicated privacy-lock pool being a different pool than
    // this one is irrelevant.
    //
    // Caveat for readers of the suite: under `NODE_ENV=test` that helper swaps the
    // database lock for an in-process one, so the tests below prove the ordering of
    // the CHECKS, not this database-level exclusion.
    const locked = await tx.execute(
      sql`select "id", "privacy_mode"::text as privacy_mode, "paranoid_media_set",
                 "paranoid_drive_attested_version"
            from "users" where "id" = ${userId} for update`,
    );
    const lockedRows = resultRows<{
      privacy_mode: string;
      paranoid_media_set: string[] | null;
      paranoid_drive_attested_version: number | null;
    }>(locked);
    if (lockedRows.length === 0) return { ok: false, refusal: 'NO_VERIFIED_BACKUP' };
    await tx.execute(sql`select 1 from "paranoid_vaults" where "user_id" = ${userId} for update`);

    // ── Already done? ───────────────────────────────────────────────────────
    // The receipt's primary key is the idempotency key for the whole operation.
    const existing = await tx
      .select({ userId: paranoidV1WipeReceipts.userId })
      .from(paranoidV1WipeReceipts)
      .where(eq(paranoidV1WipeReceipts.userId, userId));
    if (existing.length > 0) return { ok: false, refusal: 'ALREADY_WIPED' };

    // ── The gate: an attestation that names this account ────────────────────
    const attestations = await tx
      .select({
        id: paranoidV1BackupAttestations.id,
        userDigests: paranoidV1BackupAttestations.userDigests,
        offsiteConfirmedAt: paranoidV1BackupAttestations.offsiteConfirmedAt,
      })
      .from(paranoidV1BackupAttestations)
      .orderBy(sql`${paranoidV1BackupAttestations.createdAt} desc`);

    const covering = attestations.filter(
      (a) => typeof (a.userDigests as Record<string, unknown>)?.[userId] === 'string',
    );
    if (covering.length === 0) return { ok: false, refusal: 'NO_VERIFIED_BACKUP' };

    // §17: "offsite copy confirmed, THEN any destructive step."
    const confirmed = covering.filter((a) => a.offsiteConfirmedAt !== null);
    if (confirmed.length === 0) return { ok: false, refusal: 'BACKUP_NOT_OFFSITE_CONFIRMED' };

    // ── Is the archive still a true description of this account? ────────────
    const liveDigestRows = resultRows<{ digest: string }>(
      await tx.execute(paranoidV1AccountDigestQuery(userId)),
    );
    const liveDigest = liveDigestRows[0]?.digest ?? '';

    const attestation = confirmed.find((a) =>
      digestsEqual((a.userDigests as Record<string, string>)[userId]!, liveDigest),
    );
    if (!attestation) return { ok: false, refusal: 'BACKUP_STALE' };

    // ══ Past this line, and only past this line, anything is destroyed. ══════

    for (const move of QUARANTINE_MOVES) {
      await tx.execute(move(userId, attestation.id));
    }
    for (const table of LEGACY_DELETES) {
      await tx.execute(sql`delete from ${sql.raw(`"${table}"`)} where "user_id" = ${userId}`);
    }

    // The account comes back feature-complete and empty of vaulted content. The
    // media columns must be cleared in the SAME statement as the mode: the
    // `users_paranoid_media_state` CHECK requires `normal` to carry neither, and
    // that pair IS the account-kill state `bearerAuth` reads.
    await tx
      .update(users)
      .set({ privacyMode: 'normal', paranoidMediaSet: null, paranoidDriveAttestedVersion: null })
      .where(eq(users.id, userId));

    const prior = lockedRows[0]!;
    await tx.insert(paranoidV1WipeReceipts).values({
      userId,
      attestationId: attestation.id,
      priorPrivacyMode: prior.privacy_mode,
      priorMediaSet: prior.paranoid_media_set,
      priorDriveAttestedVersion: prior.paranoid_drive_attested_version,
    });

    return { ok: true, attestationId: attestation.id };
  });
}
