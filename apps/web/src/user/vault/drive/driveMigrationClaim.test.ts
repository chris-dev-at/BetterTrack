import { describe, expect, it } from 'vitest';

import {
  claimDriveMigration,
  DRIVE_MIGRATION_CLAIM_FILE,
  driveMigratedMarkerName,
  markDriveMigrated,
  parseDriveClaim,
  renewDriveMigrationClaim,
  type DriveClaimFilesPort,
  type DriveClaimFileRef,
} from './driveMigrationClaim';

/**
 * The Drive-only migration claim (r3 §11 variant, mobile A2.3).
 *
 * Every test drives the marker-file protocol through an in-memory fake of the
 * minimal Drive port. The fake reproduces the two Drive behaviours the design
 * has to survive: no compare-and-swap (an update is last-writer-wins) and no
 * unique names (a racing create leaves duplicates).
 */

const VAULT_ID = '4f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a01';
const NONCE_A = 'client-nonce-aaaaaaaaaaaaaaaa';
const NONCE_B = 'client-nonce-bbbbbbbbbbbbbbbb';

const T0 = new Date('2026-08-08T10:00:00.000Z');
const at = (offsetMs: number) => () => new Date(T0.getTime() + offsetMs);

interface FakeFile {
  id: string;
  name: string;
  bytes: Uint8Array;
}

function fakeDrive(): DriveClaimFilesPort & {
  files: Map<string, FakeFile>;
  /** Force the next single create to also plant a rival file first (a race). */
  raceOnCreate?: (name: string) => void;
} {
  const files = new Map<string, FakeFile>();
  let nextId = 1;
  const port = {
    files,
    raceOnCreate: undefined as ((name: string) => void) | undefined,
    async list(name: string): Promise<DriveClaimFileRef[]> {
      return [...files.values()]
        .filter((file) => file.name === name)
        .map(({ id, name: fileName }) => ({ id, name: fileName }));
    },
    async create(name: string, bytes: Uint8Array): Promise<DriveClaimFileRef> {
      port.raceOnCreate?.(name);
      port.raceOnCreate = undefined;
      const id = `file-${String(nextId++).padStart(4, '0')}`;
      files.set(id, { id, name, bytes: bytes.slice() });
      return { id, name };
    },
    async read(ref: DriveClaimFileRef): Promise<Uint8Array> {
      const file = files.get(ref.id);
      if (!file) throw new Error(`no such file ${ref.id}`);
      return file.bytes.slice();
    },
    async update(ref: DriveClaimFileRef, bytes: Uint8Array): Promise<void> {
      const file = files.get(ref.id);
      if (!file) throw new Error(`no such file ${ref.id}`);
      file.bytes = bytes.slice();
    },
    async remove(ref: DriveClaimFileRef): Promise<void> {
      files.delete(ref.id);
    },
  };
  return port;
}

function plantClaim(
  drive: ReturnType<typeof fakeDrive>,
  id: string,
  nonce: string,
  expiresAt: string,
): void {
  drive.files.set(id, {
    id,
    name: DRIVE_MIGRATION_CLAIM_FILE,
    bytes: new TextEncoder().encode(JSON.stringify({ claim: 1, nonce, expiresAt })),
  });
}

describe('drive-only migration claim (r3 §11 variant)', () => {
  it('acquires a fresh claim and renews it', async () => {
    const drive = fakeDrive();
    const held = await claimDriveMigration({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_A,
      now: at(0),
    });
    expect(held).toMatchObject({ status: 'held', claim: { nonce: NONCE_A } });
    expect(drive.files.size).toBe(1);

    const renewed = await renewDriveMigrationClaim({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_A,
      now: at(5 * 60_000),
    });
    expect(renewed.status).toBe('held');
    if (renewed.status !== 'held') throw new Error('unreachable');
    expect(Date.parse(renewed.claim.expiresAt)).toBe(T0.getTime() + 20 * 60_000);
  });

  it('makes the loser wait while a foreign claim is live — and admits it after expiry', async () => {
    const drive = fakeDrive();
    await claimDriveMigration({ port: drive, vaultId: VAULT_ID, clientNonce: NONCE_A, now: at(0) });

    const refused = await claimDriveMigration({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_B,
      now: at(60_000),
    });
    expect(refused).toMatchObject({ status: 'claimed-by-other', claim: { nonce: NONCE_A } });

    // Past the TTL the takeover happens IN PLACE: still exactly one claim file.
    const takeover = await claimDriveMigration({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_B,
      now: at(16 * 60_000),
    });
    expect(takeover).toMatchObject({ status: 'held', claim: { nonce: NONCE_B } });
    expect(drive.files.size).toBe(1);
  });

  it('resumes its own claim instead of treating it as foreign', async () => {
    const drive = fakeDrive();
    await claimDriveMigration({ port: drive, vaultId: VAULT_ID, clientNonce: NONCE_A, now: at(0) });
    const resumed = await claimDriveMigration({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_A,
      now: at(60_000),
    });
    expect(resumed).toMatchObject({ status: 'held', claim: { nonce: NONCE_A } });
  });

  it('resolves a create race deterministically: smallest file id wins, the loser deletes only its own file', async () => {
    const drive = fakeDrive();
    // B's create is interleaved so that A's file lands FIRST (smaller id): the
    // fake plants A's rival file just before B's own create call returns.
    drive.raceOnCreate = () => {
      plantClaim(drive, 'file-0000', NONCE_A, new Date(T0.getTime() + 15 * 60_000).toISOString());
    };
    const lost = await claimDriveMigration({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_B,
      now: at(0),
    });
    expect(lost).toMatchObject({ status: 'claimed-by-other', claim: { nonce: NONCE_A } });
    // Exactly the winner's file remains.
    const remaining = [...drive.files.values()].filter(
      (file) => file.name === DRIVE_MIGRATION_CLAIM_FILE,
    );
    expect(remaining).toHaveLength(1);
    expect(parseDriveClaim(remaining[0]!.bytes)).toMatchObject({ nonce: NONCE_A });
  });

  it('treats an unparseable claim file as expired and takes it over in place', async () => {
    const drive = fakeDrive();
    drive.files.set('file-0000', {
      id: 'file-0000',
      name: DRIVE_MIGRATION_CLAIM_FILE,
      bytes: new TextEncoder().encode('not json at all'),
    });
    const held = await claimDriveMigration({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_A,
      now: at(0),
    });
    expect(held).toMatchObject({ status: 'held', claim: { nonce: NONCE_A } });
    expect(drive.files.size).toBe(1);
  });

  it('never renews across a takeover — the lapsed holder must re-claim', async () => {
    const drive = fakeDrive();
    await claimDriveMigration({ port: drive, vaultId: VAULT_ID, clientNonce: NONCE_A, now: at(0) });
    await claimDriveMigration({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_B,
      now: at(16 * 60_000),
    });

    const stale = await renewDriveMigrationClaim({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_A,
      now: at(17 * 60_000),
    });
    expect(stale).toMatchObject({ status: 'claimed-by-other', claim: { nonce: NONCE_B } });
  });

  it('commits with the marker, retires the claim, and stays idempotent', async () => {
    const drive = fakeDrive();
    await claimDriveMigration({ port: drive, vaultId: VAULT_ID, clientNonce: NONCE_A, now: at(0) });

    expect(await markDriveMigrated(drive, VAULT_ID, NONCE_A)).toEqual({ status: 'ok' });
    expect(
      [...drive.files.values()].filter((file) => file.name === DRIVE_MIGRATION_CLAIM_FILE),
    ).toHaveLength(0);
    expect(
      [...drive.files.values()].filter((file) => file.name === driveMigratedMarkerName(VAULT_ID)),
    ).toHaveLength(1);

    // Replay: acknowledged, no second marker.
    expect(await markDriveMigrated(drive, VAULT_ID, NONCE_A)).toEqual({ status: 'ok' });
    expect(
      [...drive.files.values()].filter((file) => file.name === driveMigratedMarkerName(VAULT_ID)),
    ).toHaveLength(1);
  });

  it('refuses the marker for a claimant that lost its claim — the Drive analogue of A2.2', async () => {
    const drive = fakeDrive();
    await claimDriveMigration({ port: drive, vaultId: VAULT_ID, clientNonce: NONCE_A, now: at(0) });
    // A stalls; B takes over past the TTL.
    await claimDriveMigration({
      port: drive,
      vaultId: VAULT_ID,
      clientNonce: NONCE_B,
      now: at(16 * 60_000),
    });

    const refused = await markDriveMigrated(drive, VAULT_ID, NONCE_A);
    expect(refused).toMatchObject({ status: 'claim-lost', claim: { nonce: NONCE_B } });
    // B's claim file survives untouched.
    const claims = [...drive.files.values()].filter(
      (file) => file.name === DRIVE_MIGRATION_CLAIM_FILE,
    );
    expect(claims).toHaveLength(1);
    expect(parseDriveClaim(claims[0]!.bytes)).toMatchObject({ nonce: NONCE_B });
  });

  it('answers already-migrated once the marker exists, before touching any claim', async () => {
    const drive = fakeDrive();
    await claimDriveMigration({ port: drive, vaultId: VAULT_ID, clientNonce: NONCE_A, now: at(0) });
    await markDriveMigrated(drive, VAULT_ID, NONCE_A);

    for (const call of [claimDriveMigration, renewDriveMigrationClaim]) {
      const res = await call({
        port: drive,
        vaultId: VAULT_ID,
        clientNonce: NONCE_B,
        now: at(20 * 60_000),
      });
      expect(res).toEqual({ status: 'already-migrated' });
    }
  });
});
