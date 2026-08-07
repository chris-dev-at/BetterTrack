import type { VaultDocument, VaultHeaderDoc } from '@bettertrack/contracts';

import { VaultCryptoError } from '../errors';

import { encryptVaultBlob } from './blobCrypto';
import { splitVaultDocument, type VaultUpgradeReport } from './upgrade';

/**
 * v1 → v2 migration protocol (`docs/VAULTS_V2_DESIGN.md` r2 §11).
 *
 * ```
 * claim ──► write ──► verify ──► flip ──► tombstone
 *   │                                       (v1 read-only, v2 authoritative)
 *   └─ CAS, 15 min TTL, renewable; losers wait and stay read-only on v1
 * ```
 *
 * Every property that makes this safe is a property of the ORDER:
 *
 *  - **the flip is the only commit point.** Before it, v1 is authoritative and
 *    a crashed half-migration is invisible to other clients. After it, v1 is a
 *    tombstone. There is no window where both are authoritative.
 *  - **writes are idempotent** because the doc identities are deterministic
 *    (`vaultId` derived from the legacy vault id, portfolio docs keyed by
 *    `portfolioId`). A resumed run rewrites the same documents rather than
 *    minting duplicates.
 *  - **op `clientId`s are preserved verbatim** into the split docs (r2 §11), so
 *    a replayed op is still recognized as the same op by every executor.
 *
 * The transport is injected so the protocol is testable end to end without a
 * server, and so the same code drives the server backend and Drive.
 */

/** The idempotency key for the whole migration: one legacy vault, one target. */
export interface MigrationIdentity {
  legacyVaultId: string;
  /** Derived from the legacy vault id — the same input always yields this. */
  vaultId: string;
}

export interface MigrationClaim {
  migratingBy: string;
  expiresAt: string;
}

export interface LegacyVaultState {
  claim: MigrationClaim | null;
  /** Set exactly once, by the flip. Its presence means v2 is authoritative. */
  migratedTo: string | null;
  /** CAS token for the legacy row. */
  version: number;
}

export type MigrationDocKind = 'header' | 'common' | 'portfolio';

export interface MigrationDocRef {
  kind: MigrationDocKind;
  /** Present exactly for `kind: 'portfolio'`. */
  portfolioId?: string;
}

/** Everything the protocol needs from the outside world. */
export interface MigrationTransport {
  readLegacyState(legacyVaultId: string): Promise<LegacyVaultState>;
  /** CAS write of the claim. Returns `false` when another client holds it. */
  writeClaim(legacyVaultId: string, claim: MigrationClaim, ifVersion: number): Promise<boolean>;
  /** Idempotent doc write. Rewriting the same identity replaces it. */
  writeDoc(vaultId: string, ref: MigrationDocRef, bytes: Uint8Array): Promise<void>;
  /** List the doc identities that currently exist for the target vault. */
  listDocs(vaultId: string): Promise<MigrationDocRef[]>;
  /** CAS write of `migratedTo` — the single commit point. */
  flip(legacyVaultId: string, vaultId: string, ifVersion: number): Promise<boolean>;
}

export type MigrationStep = 'claim' | 'write' | 'verify' | 'flip' | 'done';

export type MigrationOutcome =
  | { status: 'migrated'; vaultId: string; report: VaultUpgradeReport }
  /** Another client already flipped. Nothing to do; v2 is authoritative. */
  | { status: 'already-migrated'; vaultId: string }
  /** Another client holds a live claim. Stay read-only on v1 and retry later. */
  | { status: 'claimed-by-other'; claim: MigrationClaim };

export interface RunMigrationInput {
  identity: MigrationIdentity;
  /** The decrypted legacy document. */
  document: VaultDocument;
  /** The v2 header this migration publishes, already sealed. */
  header: VaultHeaderDoc;
  headerBytes: Uint8Array;
  contentKey: Uint8Array;
  transport: MigrationTransport;
  clientNonce: string;
  aliases?: Record<string, string>;
  onStep?: (step: MigrationStep) => void;
  now?: () => Date;
  id?: () => string;
  /** Claim lifetime. r2 §11 fixes it at 15 minutes, renewable. */
  claimTtlMs?: number;
}

export const MIGRATION_CLAIM_TTL_MS = 15 * 60 * 1000;

/** A live claim held by somebody else blocks us; our own claim is resumable. */
export function claimIsHeldByOther(
  state: LegacyVaultState,
  clientNonce: string,
  now: Date,
): boolean {
  const claim = state.claim;
  if (claim == null) return false;
  if (claim.migratingBy === clientNonce) return false;
  return Date.parse(claim.expiresAt) > now.getTime();
}

/**
 * Run (or resume) one migration. Safe to call repeatedly: a completed migration
 * returns `already-migrated` without touching anything, and an interrupted one
 * re-lists and continues from the write step.
 */
export async function runVaultMigration(input: RunMigrationInput): Promise<MigrationOutcome> {
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => globalThis.crypto.randomUUID());
  const ttl = input.claimTtlMs ?? MIGRATION_CLAIM_TTL_MS;

  // ── 1. Claim ──
  input.onStep?.('claim');
  let state = await input.transport.readLegacyState(input.identity.legacyVaultId);
  if (state.migratedTo != null) {
    return { status: 'already-migrated', vaultId: state.migratedTo };
  }
  if (claimIsHeldByOther(state, input.clientNonce, now())) {
    return { status: 'claimed-by-other', claim: state.claim! };
  }

  const claim: MigrationClaim = {
    migratingBy: input.clientNonce,
    expiresAt: new Date(now().getTime() + ttl).toISOString(),
  };
  if (!(await input.transport.writeClaim(input.identity.legacyVaultId, claim, state.version))) {
    // Lost the CAS race for the claim; re-read so the caller sees who won.
    state = await input.transport.readLegacyState(input.identity.legacyVaultId);
    if (state.migratedTo != null) {
      return { status: 'already-migrated', vaultId: state.migratedTo };
    }
    return {
      status: 'claimed-by-other',
      claim: state.claim ?? { migratingBy: 'unknown', expiresAt: claim.expiresAt },
    };
  }
  state = { ...state, claim, version: state.version + 1 };

  // ── 2. Write (idempotent, deterministic identities) ──
  input.onStep?.('write');
  const split = splitVaultDocument({
    document: input.document,
    vaultId: input.identity.vaultId,
    aliases: input.aliases,
  });

  await input.transport.writeDoc(input.identity.vaultId, { kind: 'header' }, input.headerBytes);

  const commonBlob = await encryptVaultBlob({
    document: split.commonDoc,
    contentKey: input.contentKey,
    blobVersion: 1,
    deviceId: id(),
    writeId: id(),
    writtenAt: now().toISOString(),
  });
  await input.transport.writeDoc(input.identity.vaultId, { kind: 'common' }, commonBlob.envelope);

  for (const doc of split.portfolioDocs) {
    const blob = await encryptVaultBlob({
      document: doc,
      contentKey: input.contentKey,
      blobVersion: 1,
      deviceId: id(),
      writeId: id(),
      writtenAt: now().toISOString(),
    });
    await input.transport.writeDoc(
      input.identity.vaultId,
      { kind: 'portfolio', portfolioId: doc.portfolioId },
      blob.envelope,
    );
  }

  // ── 3. Verify ──
  input.onStep?.('verify');
  const written = await input.transport.listDocs(input.identity.vaultId);
  const missing = missingDocs(
    written,
    split.portfolioDocs.map((doc) => doc.portfolioId),
  );
  if (missing.length > 0) {
    throw new VaultCryptoError(
      'storage-failed',
      `The migration is incomplete: ${missing.map(describeDoc).join(', ')} did not land. Nothing was committed.`,
    );
  }

  // ── 4. Flip (the single commit point) ──
  input.onStep?.('flip');
  if (
    !(await input.transport.flip(
      input.identity.legacyVaultId,
      input.identity.vaultId,
      state.version,
    ))
  ) {
    const latest = await input.transport.readLegacyState(input.identity.legacyVaultId);
    if (latest.migratedTo != null) {
      return { status: 'already-migrated', vaultId: latest.migratedTo };
    }
    throw new VaultCryptoError(
      'storage-failed',
      'The migration could not be committed. v1 remains authoritative and nothing was lost.',
    );
  }

  input.onStep?.('done');
  return { status: 'migrated', vaultId: input.identity.vaultId, report: split.report };
}

/** Which expected docs are absent from what the store actually lists. */
export function missingDocs(
  written: MigrationDocRef[],
  expectedPortfolioIds: string[],
): MigrationDocRef[] {
  const has = (ref: MigrationDocRef) =>
    written.some(
      (candidate) => candidate.kind === ref.kind && candidate.portfolioId === ref.portfolioId,
    );
  const expected: MigrationDocRef[] = [
    { kind: 'header' },
    { kind: 'common' },
    ...expectedPortfolioIds.map((portfolioId) => ({ kind: 'portfolio' as const, portfolioId })),
  ];
  return expected.filter((ref) => !has(ref));
}

function describeDoc(ref: MigrationDocRef): string {
  return ref.kind === 'portfolio' ? `portfolio ${ref.portfolioId}` : ref.kind;
}
