/**
 * Client-local v1→v2 migration claim for **Drive-only** vaults
 * (`docs/VAULTS_V2_DESIGN.md` r3 §11 variant, closing mobile finding A2.3).
 *
 * The server-coordinated claim (r2 §11) is a CAS on the legacy account-vault
 * row — which a Drive-only install cannot use, because Drive-only means there
 * is no account and never will be. The coordination point moves onto the same
 * medium the data lives on, following §13's copy → verify → marker → retire
 * pattern:
 *
 *  - **claim**   = a marker file `btv2.migration.claim` holding
 *                  `{ nonce, expiresAt }`. Exactly one such file exists; a
 *                  takeover UPDATES it in place rather than creating a second.
 *  - **flip**    = the `btv2.{vaultId}.migrated` marker. Its presence is the
 *                  commit point, exactly as `migratedTo` is server-side.
 *  - **resume**  = re-list; the marker's absence means v1 is authoritative and
 *                  the write step re-runs idempotently (byte-identical under
 *                  the r3 derived migration key).
 *
 * Drive's appDataFolder has no compare-and-swap, so this module uses the same
 * approximation discipline as the Drive vault adapter: observe → act →
 * **re-list and read back** → believe only what the read-back shows. A racing
 * create can momentarily leave two claim files; the deterministic winner is the
 * lexicographically smallest Drive file id, every loser deletes its own file,
 * and no claimant proceeds until a re-read shows its nonce alone.
 */

export const DRIVE_MIGRATION_CLAIM_FILE = 'btv2.migration.claim';

/** `btv2.{vaultId}.migrated` — §13's rename-migration commit marker. */
export function driveMigratedMarkerName(vaultId: string): string {
  return `btv2.${vaultId}.migrated`;
}

/** r2 §11 fixes the claim lifetime at 15 minutes, renewable. */
export const DRIVE_MIGRATION_CLAIM_TTL_MS = 15 * 60 * 1000;

export interface DriveClaimFileRef {
  id: string;
  name: string;
}

/**
 * The minimal Drive surface the claim needs. The production binding rides the
 * same authorized-fetch machinery as `driveDataHome`; tests inject a fake.
 * Every method may throw — a transport failure aborts the attempt without
 * changing the claim's meaning (the TTL, not the error, is the recovery).
 */
export interface DriveClaimFilesPort {
  /** Every appDataFolder file with exactly this name (duplicates included). */
  list(name: string): Promise<DriveClaimFileRef[]>;
  create(name: string, bytes: Uint8Array): Promise<DriveClaimFileRef>;
  read(ref: DriveClaimFileRef): Promise<Uint8Array>;
  update(ref: DriveClaimFileRef, bytes: Uint8Array): Promise<void>;
  remove(ref: DriveClaimFileRef): Promise<void>;
}

export interface DriveMigrationClaim {
  nonce: string;
  expiresAt: string;
}

export type DriveClaimResult =
  | { status: 'held'; claim: DriveMigrationClaim }
  | { status: 'claimed-by-other'; claim: DriveMigrationClaim }
  /** The `btv2.{vaultId}.migrated` marker exists: v2 is authoritative. */
  | { status: 'already-migrated' };

export interface DriveClaimInput {
  port: DriveClaimFilesPort;
  /** The successor vault id, checked for its commit marker before anything else. */
  vaultId: string;
  clientNonce: string;
  now?: () => Date;
  ttlMs?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function serializeClaim(claim: DriveMigrationClaim): Uint8Array {
  return encoder.encode(JSON.stringify({ claim: 1, ...claim }));
}

/**
 * `null` when the bytes are not a well-formed claim. An unparseable claim file
 * (an interrupted write, or garbage) cannot PROVE a live holder, so it is
 * treated like an expired one: taken over in place, never trusted, never left
 * to deadlock the migration forever.
 */
export function parseDriveClaim(bytes: Uint8Array): DriveMigrationClaim | null {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  const value = raw as { claim?: unknown; nonce?: unknown; expiresAt?: unknown } | null;
  if (value == null || value.claim !== 1) return null;
  if (typeof value.nonce !== 'string' || value.nonce.length === 0) return null;
  if (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt))) {
    return null;
  }
  return { nonce: value.nonce, expiresAt: value.expiresAt };
}

function isLive(claim: DriveMigrationClaim | null, now: Date): claim is DriveMigrationClaim {
  return claim != null && Date.parse(claim.expiresAt) > now.getTime();
}

/** Deterministic winner among duplicate claim files: smallest Drive file id. */
function winnerOf(refs: DriveClaimFileRef[]): DriveClaimFileRef {
  return [...refs].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )[0]!;
}

async function markerExists(port: DriveClaimFilesPort, vaultId: string): Promise<boolean> {
  return (await port.list(driveMigratedMarkerName(vaultId))).length > 0;
}

/**
 * Acquire (or resume) the Drive-local migration claim.
 *
 * Safe to call repeatedly: our own live claim renews, a foreign live claim is
 * reported for waiting, and an expired or unparseable claim is taken over IN
 * PLACE. Nothing here is trusted until a re-read confirms it — Drive gives no
 * CAS, so the read-back IS the arbitration.
 */
export async function claimDriveMigration(input: DriveClaimInput): Promise<DriveClaimResult> {
  const now = input.now ?? (() => new Date());
  const ttl = input.ttlMs ?? DRIVE_MIGRATION_CLAIM_TTL_MS;
  const { port } = input;

  if (await markerExists(port, input.vaultId)) return { status: 'already-migrated' };

  const mine = (): DriveMigrationClaim => ({
    nonce: input.clientNonce,
    expiresAt: new Date(now().getTime() + ttl).toISOString(),
  });

  const existing = await port.list(DRIVE_MIGRATION_CLAIM_FILE);
  if (existing.length === 0) {
    const created = await port.create(DRIVE_MIGRATION_CLAIM_FILE, serializeClaim(mine()));
    // Re-list: a simultaneous claimant may have created a second file. The
    // smallest file id wins deterministically on every device; every loser
    // deletes ITS OWN file (never the winner's) and waits.
    const after = await port.list(DRIVE_MIGRATION_CLAIM_FILE);
    const winner = winnerOf(after.length > 0 ? after : [created]);
    if (winner.id !== created.id) {
      await port.remove(created);
      const claim = parseDriveClaim(await port.read(winner));
      if (isLive(claim, now()) && claim.nonce !== input.clientNonce) {
        return { status: 'claimed-by-other', claim };
      }
      // The winner is expired/garbage or unexpectedly ours: fall through to a
      // fresh attempt next call rather than looping here.
      return {
        status: 'claimed-by-other',
        claim: claim ?? { nonce: 'unknown', expiresAt: new Date(0).toISOString() },
      };
    }
    return confirmHeld(port, winner, input.clientNonce, now());
  }

  const winner = winnerOf(existing);
  // Duplicate leftovers that lost an earlier race and were not cleaned up: any
  // non-winner file we can prove is OURS is removed; foreign ones are left for
  // their writers (deleting another device's file on a guess is how a real
  // claim gets lost).
  for (const ref of existing) {
    if (ref.id === winner.id) continue;
    const claim = parseDriveClaim(await port.read(ref).catch(() => new Uint8Array()));
    if (claim?.nonce === input.clientNonce) await port.remove(ref);
  }

  const current = parseDriveClaim(await port.read(winner));
  if (isLive(current, now()) && current.nonce !== input.clientNonce) {
    return { status: 'claimed-by-other', claim: current };
  }

  // Ours, expired, or unparseable → take over IN PLACE (update, never a second
  // create), then believe only the read-back.
  await port.update(winner, serializeClaim(mine()));
  return confirmHeld(port, winner, input.clientNonce, now());
}

/**
 * Extend our own live claim. Deliberately stricter than {@link claimDriveMigration},
 * mirroring the server repository's renew: it never takes over — a holder whose
 * claim lapsed or was overwritten must go back through the claim step, where it
 * can legitimately lose.
 */
export async function renewDriveMigrationClaim(input: DriveClaimInput): Promise<DriveClaimResult> {
  const now = input.now ?? (() => new Date());
  const ttl = input.ttlMs ?? DRIVE_MIGRATION_CLAIM_TTL_MS;
  const { port } = input;

  if (await markerExists(port, input.vaultId)) return { status: 'already-migrated' };

  const existing = await port.list(DRIVE_MIGRATION_CLAIM_FILE);
  if (existing.length === 0) {
    return {
      status: 'claimed-by-other',
      claim: { nonce: 'unknown', expiresAt: new Date(0).toISOString() },
    };
  }
  const winner = winnerOf(existing);
  const current = parseDriveClaim(await port.read(winner));
  if (!isLive(current, now()) || current.nonce !== input.clientNonce) {
    return {
      status: 'claimed-by-other',
      claim: current ?? { nonce: 'unknown', expiresAt: new Date(0).toISOString() },
    };
  }
  const renewed: DriveMigrationClaim = {
    nonce: input.clientNonce,
    expiresAt: new Date(now().getTime() + ttl).toISOString(),
  };
  await port.update(winner, serializeClaim(renewed));
  return confirmHeld(port, winner, input.clientNonce, now());
}

/**
 * The Drive flip: write the `btv2.{vaultId}.migrated` marker, then retire the
 * claim file. Idempotent — an existing marker is acknowledged, not an error —
 * and ordered so a crash between the two steps leaves the SAFE state (marker
 * present, stale claim file that every later reader ignores in favour of the
 * marker).
 */
export async function markDriveMigrated(
  port: DriveClaimFilesPort,
  vaultId: string,
  clientNonce: string,
): Promise<{ status: 'ok' } | { status: 'claim-lost'; claim: DriveMigrationClaim | null }> {
  const markerName = driveMigratedMarkerName(vaultId);
  const markers = await port.list(markerName);
  if (markers.length === 0) {
    // The marker commits only for the live claim holder: re-check ownership at
    // the last moment, so a taken-over loser cannot flip on top of the winner.
    const claims = await port.list(DRIVE_MIGRATION_CLAIM_FILE);
    if (claims.length > 0) {
      const current = parseDriveClaim(await port.read(winnerOf(claims)));
      if (current != null && current.nonce !== clientNonce) {
        return { status: 'claim-lost', claim: current };
      }
    }
    await port.create(markerName, encoder.encode(JSON.stringify({ migrated: 1, vaultId })));
  }
  // Retire the claim file — ours or expired garbage; the marker now rules.
  for (const ref of await port.list(DRIVE_MIGRATION_CLAIM_FILE)) {
    await port.remove(ref);
  }
  return { status: 'ok' };
}

async function confirmHeld(
  port: DriveClaimFilesPort,
  ref: DriveClaimFileRef,
  clientNonce: string,
  now: Date,
): Promise<DriveClaimResult> {
  const readBack = parseDriveClaim(await port.read(ref));
  if (isLive(readBack, now) && readBack.nonce === clientNonce) {
    return { status: 'held', claim: readBack };
  }
  return {
    status: 'claimed-by-other',
    claim: readBack ?? { nonce: 'unknown', expiresAt: new Date(0).toISOString() },
  };
}
