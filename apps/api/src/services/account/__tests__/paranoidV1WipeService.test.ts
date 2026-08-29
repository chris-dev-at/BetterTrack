import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  paranoidEnableTransitions,
  paranoidRehydrationReceipts,
  paranoidV1BackupAttestations,
  paranoidV1WipeReceipts,
  paranoidVaultHistory,
  paranoidVaultRetired,
  paranoidVaultRetirements,
  paranoidVaultServerCandidates,
  paranoidVaults,
  users,
} from '../../../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../../../testing/createTestApp';
import {
  PARANOID_V1_WIPE_CANDIDATES_SQL,
  paranoidV1AccountDigestQuery,
  resultRows,
} from '../paranoidV1TransitionSql';
import { wipeParanoidV1Account } from '../paranoidV1WipeService';

/**
 * `paranoidV1WipeService` — §17 step 2, the destructive half of the ruled (C)
 * "backup + wipe" transition.
 *
 * §17 step 1 fixes the order and this suite exists to prove the code obeys it:
 * "dump every `paranoid_vaults` account blob + bounded history to a verified
 * archive on the prod host, offsite copy confirmed, THEN any destructive step."
 *
 * So there are three ways to be refused before anything is destroyed — no
 * attestation, an attestation whose offsite copy was never confirmed, and an
 * attestation that no longer describes the account — and each of the three is
 * asserted to leave every byte in place. The precondition is re-checked inside
 * the wipe's own transaction, after the row locks are taken, so nothing can slip
 * in between the check and the destruction.
 *
 * PROJECTPLAN §16 (2026-07-28) is the governing rule: "unverifiable client
 * assertions may retire bytes but are non-destructive by construction". Only a
 * fact the server established itself may destroy.
 */

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

const ATT_A = '019756a0-0000-7000-8000-0000000e9aa1';

/** Turn a seeded user into a live v1 paranoid account with a row in all seven tables. */
async function seedLegacyParanoid(
  user: SeededUser,
  media: { mediaSet?: string[]; driveAttestedVersion?: number } = {},
): Promise<void> {
  await harness.db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: media.mediaSet ?? ['server'],
      paranoidDriveAttestedVersion: media.driveAttestedVersion ?? null,
    })
    .where(eq(users.id, user.id));
  await harness.db.insert(paranoidVaults).values({
    userId: user.id,
    version: 7,
    formatVersion: 1,
    sizeBytes: 3,
    blob: Buffer.from('ABC'),
  });
  await harness.db.insert(paranoidVaultHistory).values({
    userId: user.id,
    version: 6,
    formatVersion: 1,
    sizeBytes: 3,
    blob: Buffer.from('ABD'),
  });
  await harness.db
    .insert(paranoidEnableTransitions)
    .values({ userId: user.id, expiresAt: new Date(Date.now() + 600_000) });
  await harness.db.insert(paranoidVaultServerCandidates).values({
    userId: user.id,
    version: 8,
    formatVersion: 1,
    sizeBytes: 3,
    blob: Buffer.from('ABE'),
    expiresAt: new Date(Date.now() + 600_000),
  });
  await harness.db.insert(paranoidVaultRetirements).values({
    userId: user.id,
    retiredVersion: 5,
    retirementProofPublicKey: 'pk-legacy',
  });
  await harness.db.insert(paranoidVaultRetired).values({
    userId: user.id,
    version: 5,
    formatVersion: 1,
    sizeBytes: 3,
    blob: Buffer.from('ABF'),
    createdAt: new Date(),
  });
  // `rehydration_id` is globally unique, so it is derived from the account: two
  // seeded paranoid accounts in one test must not collide on it.
  await harness.db
    .insert(paranoidRehydrationReceipts)
    .values({ userId: user.id, rehydrationId: randomUUID() });
}

/** The digest the ops script would have recorded for this account right now. */
async function currentDigest(userId: string): Promise<string> {
  const rows = resultRows<{ digest: string }>(
    await harness.db.execute(paranoidV1AccountDigestQuery(userId)),
  );
  return rows[0]!.digest;
}

/** Insert an attestation exactly as the verified ops export would have. */
async function attest(
  userIds: string[],
  options: { offsiteConfirmed: boolean; digests?: Record<string, string> } = {
    offsiteConfirmed: true,
  },
): Promise<string> {
  const digests: Record<string, string> = options.digests ?? {};
  if (!options.digests) {
    for (const id of userIds) digests[id] = await currentDigest(id);
  }
  await harness.db.insert(paranoidV1BackupAttestations).values({
    id: ATT_A,
    archiveFile: '/backups/paranoid-v1.json',
    archiveSha256: 'a'.repeat(64),
    rowCounts: {},
    userDigests: digests,
    createdBy: 'owner',
    ...(options.offsiteConfirmed
      ? { offsiteConfirmedAt: new Date(), offsiteConfirmedSha256: 'a'.repeat(64) }
      : {}),
  });
  return ATT_A;
}

async function liveRowCounts(userId: string): Promise<Record<string, number>> {
  const one = async (table: string): Promise<number> => {
    const rows = resultRows<{ n: number }>(
      await harness.db.execute(
        sql`select count(*)::int as n from ${sql.raw(`"${table}"`)} where "user_id" = ${userId}`,
      ),
    );
    return rows[0]!.n;
  };
  const out: Record<string, number> = {};
  for (const t of [
    'paranoid_vaults',
    'paranoid_vault_history',
    'paranoid_enable_transitions',
    'paranoid_vault_server_candidates',
    'paranoid_vault_retirements',
    'paranoid_vault_retired',
    'paranoid_rehydration_receipts',
  ]) {
    out[t] = await one(t);
  }
  return out;
}

async function quarantineRowCounts(userId: string): Promise<Record<string, number>> {
  const one = async (table: string): Promise<number> => {
    const rows = resultRows<{ n: number }>(
      await harness.db.execute(
        sql`select count(*)::int as n from ${sql.raw(`"zz_paranoid_v1_backup_${table}"`)} where "user_id" = ${userId}`,
      ),
    );
    return rows[0]!.n;
  };
  const out: Record<string, number> = {};
  for (const t of [
    'paranoid_vaults',
    'paranoid_vault_history',
    'paranoid_enable_transitions',
    'paranoid_vault_server_candidates',
    'paranoid_vault_retirements',
    'paranoid_vault_retired',
    'paranoid_rehydration_receipts',
  ]) {
    out[t] = await one(t);
  }
  return out;
}

const ALL_SEVEN_PRESENT = {
  paranoid_vaults: 1,
  paranoid_vault_history: 1,
  paranoid_enable_transitions: 1,
  paranoid_vault_server_candidates: 1,
  paranoid_vault_retirements: 1,
  paranoid_vault_retired: 1,
  paranoid_rehydration_receipts: 1,
};

const ALL_SEVEN_GONE = {
  paranoid_vaults: 0,
  paranoid_vault_history: 0,
  paranoid_enable_transitions: 0,
  paranoid_vault_server_candidates: 0,
  paranoid_vault_retirements: 0,
  paranoid_vault_retired: 0,
  paranoid_rehydration_receipts: 0,
};

async function privacyOf(userId: string): Promise<{
  privacyMode: string;
  paranoidMediaSet: string[] | null;
}> {
  const row = await harness.db
    .select({ privacyMode: users.privacyMode, paranoidMediaSet: users.paranoidMediaSet })
    .from(users)
    .where(eq(users.id, userId));
  return row[0]!;
}

describe('paranoidV1WipeService — §17 step 2, gated on the verified backup', () => {
  it('refuses without any attestation, and destroys nothing', async () => {
    const user = await harness.seedUser();
    await seedLegacyParanoid(user);

    const outcome = await wipeParanoidV1Account(harness.db, user.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('NO_VERIFIED_BACKUP');
    expect(await liveRowCounts(user.id)).toEqual(ALL_SEVEN_PRESENT);
    expect((await privacyOf(user.id)).privacyMode).toBe('paranoid');
  });

  it('refuses while the offsite copy is unconfirmed — §17 orders it before any destructive step', async () => {
    const user = await harness.seedUser();
    await seedLegacyParanoid(user);
    await attest([user.id], { offsiteConfirmed: false });

    const outcome = await wipeParanoidV1Account(harness.db, user.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('BACKUP_NOT_OFFSITE_CONFIRMED');
    expect(await liveRowCounts(user.id)).toEqual(ALL_SEVEN_PRESENT);
    expect((await privacyOf(user.id)).privacyMode).toBe('paranoid');
  });

  it('refuses when the account changed after the backup, rather than destroy against a stale archive', async () => {
    const user = await harness.seedUser();
    await seedLegacyParanoid(user);
    await attest([user.id], { offsiteConfirmed: true });

    // The user syncs a newer vault version after the archive was taken.
    await harness.db
      .update(paranoidVaults)
      .set({ version: 9, blob: Buffer.from('NEWER') })
      .where(eq(paranoidVaults.userId, user.id));

    const outcome = await wipeParanoidV1Account(harness.db, user.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('BACKUP_STALE');
    expect(await liveRowCounts(user.id)).toEqual(ALL_SEVEN_PRESENT);
    expect((await privacyOf(user.id)).privacyMode).toBe('paranoid');
  });

  it('wipes behind a confirmed, current attestation: rows quarantined, mode normal, kill state cleared', async () => {
    const user = await harness.seedUser();
    await seedLegacyParanoid(user);
    await attest([user.id], { offsiteConfirmed: true });

    const outcome = await wipeParanoidV1Account(harness.db, user.id);
    expect(outcome.ok).toBe(true);

    // The live v1 surface is empty for this account...
    expect(await liveRowCounts(user.id)).toEqual(ALL_SEVEN_GONE);
    // ...and every row is in the quarantine, not destroyed (§17: "quarantined").
    expect(await quarantineRowCounts(user.id)).toEqual(ALL_SEVEN_PRESENT);

    // privacy_mode → normal, and the media columns the CHECK ties to it are cleared:
    // that pair IS the account-kill state the bearer rail reads.
    const after = await privacyOf(user.id);
    expect(after.privacyMode).toBe('normal');
    expect(after.paranoidMediaSet).toBeNull();

    // The receipt records what was flipped and owes the one-time notice.
    const receipt = await harness.db
      .select()
      .from(paranoidV1WipeReceipts)
      .where(eq(paranoidV1WipeReceipts.userId, user.id));
    expect(receipt).toHaveLength(1);
    expect(receipt[0]!.priorPrivacyMode).toBe('paranoid');
    expect(receipt[0]!.priorMediaSet).toEqual(['server']);
    expect(receipt[0]!.noticeAcknowledgedAt).toBeNull();

    // The quarantined ciphertext is byte-identical to what was taken away.
    const kept = resultRows<{ blob: Buffer }>(
      await harness.db.execute(
        sql`select "blob" from "zz_paranoid_v1_backup_paranoid_vaults" where "user_id" = ${user.id}`,
      ),
    );
    expect(Buffer.from(kept[0]!.blob).toString()).toBe('ABC');
  });

  it('refuses a second wipe of the same account instead of guessing what that means', async () => {
    const user = await harness.seedUser();
    await seedLegacyParanoid(user);
    await attest([user.id], { offsiteConfirmed: true });

    expect((await wipeParanoidV1Account(harness.db, user.id)).ok).toBe(true);
    const second = await wipeParanoidV1Account(harness.db, user.id);

    expect(second.ok).toBe(false);
    expect(second.refusal).toBe('ALREADY_WIPED');
    const receipts = await harness.db
      .select()
      .from(paranoidV1WipeReceipts)
      .where(eq(paranoidV1WipeReceipts.userId, user.id));
    expect(receipts).toHaveLength(1);
  });

  it('touches only the named account — an uncovered paranoid account is left alone', async () => {
    const covered = await harness.seedUser({
      email: 'e9-covered@example.test',
      username: 'e9covered',
    });
    const bystander = await harness.seedUser({
      email: 'e9-bystander@example.test',
      username: 'e9bystander',
    });
    await seedLegacyParanoid(covered);
    await seedLegacyParanoid(bystander);
    await attest([covered.id], { offsiteConfirmed: true });

    expect((await wipeParanoidV1Account(harness.db, covered.id)).ok).toBe(true);

    // The bystander is not in `user_digests`, so the same attestation cannot reach it.
    const outcome = await wipeParanoidV1Account(harness.db, bystander.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('NO_VERIFIED_BACKUP');
    expect(await liveRowCounts(bystander.id)).toEqual(ALL_SEVEN_PRESENT);
    expect((await privacyOf(bystander.id)).privacyMode).toBe('paranoid');
  });

  it('refuses a drive-bearing account: the server never held those bytes to back up', async () => {
    // §17's safety argument is explicitly conditional — "every live paranoid
    // account is server-media-only in practice … The wipe migration still
    // verifies actual `paranoid_media_set` values rather than assuming." A vault
    // on Drive is unreachable from the server, so the archive provably cannot
    // contain it and no attestation may authorise destroying its locked stubs.
    const user = await harness.seedUser({ email: 'e9-drive@example.test', username: 'e9drive' });
    await seedLegacyParanoid(user, { mediaSet: ['server', 'drive'] });
    await attest([user.id], { offsiteConfirmed: true });

    const outcome = await wipeParanoidV1Account(harness.db, user.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('DRIVE_MEDIA_PRESENT');
    expect(await liveRowCounts(user.id)).toEqual(ALL_SEVEN_PRESENT);
    expect((await privacyOf(user.id)).privacyMode).toBe('paranoid');
  });

  it('refuses on a drive attestation version even if the media set were tampered flat', async () => {
    const user = await harness.seedUser({ email: 'e9-drivev@example.test', username: 'e9drivev' });
    await seedLegacyParanoid(user, { mediaSet: ['drive'], driveAttestedVersion: 4 });
    await attest([user.id], { offsiteConfirmed: true });

    const outcome = await wipeParanoidV1Account(harness.db, user.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('DRIVE_MEDIA_PRESENT');
    expect(await liveRowCounts(user.id)).toEqual(ALL_SEVEN_PRESENT);
  });

  it('lists exactly the accounts an operator may wipe, and drops them once wiped', async () => {
    // The statement `pnpm wipe:paranoid-v1` runs, executed verbatim: `jsonb_each_text`
    // over the digest map plus the `::uuid` cast typechecks nowhere and fails at
    // runtime, and an operator reading a wrong list is how the wrong account gets
    // destroyed.
    const listed = async (): Promise<string[]> =>
      resultRows<{ user_id: string }>(
        await harness.db.execute(sql.raw(PARANOID_V1_WIPE_CANDIDATES_SQL)),
      ).map((r) => r.user_id);

    const covered = await harness.seedUser({ email: 'e9-l1@example.test', username: 'e9l1' });
    const unconfirmed = await harness.seedUser({ email: 'e9-l2@example.test', username: 'e9l2' });
    await seedLegacyParanoid(covered);
    await seedLegacyParanoid(unconfirmed);

    expect(await listed(), 'no attestation yet').toEqual([]);

    await attest([covered.id], { offsiteConfirmed: true });
    expect(await listed()).toEqual([covered.id]);

    // An attestation whose offsite copy was never confirmed must not list its
    // accounts — that is §17 step 1's ordering, visible to the operator.
    await harness.db.insert(paranoidV1BackupAttestations).values({
      id: '019756a0-0000-7000-8000-0000000e9aa2',
      archiveFile: '/backups/unconfirmed.json',
      archiveSha256: 'b'.repeat(64),
      rowCounts: {},
      userDigests: { [unconfirmed.id]: await currentDigest(unconfirmed.id) },
      createdBy: 'owner',
    });
    expect(await listed(), 'unconfirmed offsite copy stays out of the list').toEqual([covered.id]);

    // Once wiped, the account leaves the list — so a re-run is not a re-wipe.
    expect((await wipeParanoidV1Account(harness.db, covered.id)).ok).toBe(true);
    expect(await listed()).toEqual([]);
  });

  it('is imported by nothing under http/ or jobs/ — the wipe has no request-driven entry point', () => {
    // §17 makes the wipe an owner-run operation behind a server-verified backup.
    // A route or a queued job would put an irreversible account-level destruction
    // one request (or one enqueue) away from a caller who cannot satisfy that
    // precondition. This walks the whole of `http/` and `jobs/` rather than
    // spot-checking three files, so a NEW route file cannot quietly wire it up.
    const apiSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [full] : [];
      });

    const scanned = [...walk(path.join(apiSrc, 'http')), ...walk(path.join(apiSrc, 'jobs'))];
    // Guard the scanner itself: an empty sweep would make the assertion vacuous.
    expect(scanned.length).toBeGreaterThan(20);

    // Match a real import specifier or a real call — not a prose mention. The
    // routes deliberately DOCUMENT that the wipe has no route, and a bare
    // substring scan flags that comment as if it were a wiring.
    const WIRES_UP =
      /from\s+['"][^'"]*paranoidV1WipeService['"]|require\(\s*['"][^'"]*paranoidV1WipeService['"]|\bwipeParanoidV1Account\s*\(/u;
    const importers = scanned.filter((file) => WIRES_UP.test(readFileSync(file, 'utf8')));
    expect(importers.map((f) => path.relative(apiSrc, f))).toEqual([]);
  });
});
