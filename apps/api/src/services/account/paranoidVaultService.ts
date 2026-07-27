import { createHash } from 'node:crypto';

import {
  readVaultServerHeader,
  VAULT_MEDIA_PROOF_MAX_AGE_MS,
  VAULT_RETIRED_PURGE_MIN_AGE_MS,
  VaultEnvelopeError,
  type VaultHistoryListQuery,
  type VaultHistoryListResponse,
  type VaultMediaPatchRequest,
  type VaultMediaSet,
  type VaultMediaStateResponse,
  type VaultMediaVerification,
  type VaultMetadata,
} from '@bettertrack/contracts';

import type {
  ParanoidVaultRepository,
  ParanoidVaultRetention,
} from '../../data/repositories/paranoidVaultRepository';
import type { ParanoidVaultHistoryRow, ParanoidVaultRow } from '../../data/schema';

/**
 * Paranoid-vault service (§13.5 V5-P13 arc b, `docs/paranoid-design.md` §2, §4).
 * The business layer over the blind server blob store: it enforces the size cap,
 * reads ONLY the safe envelope header (`formatVersion` + `vaultVersion`) needed
 * for versioning — never the ciphertext — and drives the repository's atomic
 * compare-and-swap. It never decrypts, parses past that header, logs, or indexes
 * the payload.
 */

export interface ParanoidVaultServiceDeps {
  vaults: ParanoidVaultRepository;
  /** Server-enforced ciphertext (envelope) size cap in bytes (§2, env-tunable). */
  maxBytes: number;
  /** Bounded ciphertext history window (§4, env-tunable). */
  retention: ParanoidVaultRetention;
  /** Injected clock so archive/prune timestamps stay deterministic in tests. */
  now?: () => Date;
  /** Security floor; injectable only so the rejection/eligibility boundary is deterministic. */
  retiredPurgeMinAgeMs?: number;
}

export interface ParanoidVaultPutInput {
  userId: string;
  /**
   * CAS precondition: the version the client expects to be current (from
   * `If-Match`), or `null` to CREATE (from `If-None-Match: *`).
   */
  expectedVersion: number | null;
  /** The raw opaque envelope bytes to store. */
  blob: Buffer;
}

export type ParanoidVaultPutResult =
  | { status: 'ok'; version: number; updatedAt: Date }
  | { status: 'precondition_failed'; currentVersion: number | null }
  | { status: 'too_large'; sizeBytes: number; maxBytes: number }
  | { status: 'malformed'; reason: string };

export type ParanoidVaultMediaMutationResult =
  | { status: 'ok'; media: VaultMediaStateResponse; idempotent: boolean }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'precondition_failed'; mediaSet: VaultMediaSet }
  | { status: 'invalid_transition' }
  | { status: 'verification_required' }
  | { status: 'verification_invalid' };

export type ParanoidVaultRetiredPurgeServiceResult =
  | {
      status: 'ok';
      media: VaultMediaStateResponse;
      purgedVersions: number;
      purgedBytes: number;
    }
  | { status: 'not_found' }
  | { status: 'mode_required' }
  | { status: 'media_invalid' }
  | { status: 'proof_invalid' }
  | { status: 'retention_not_met'; eligibleAt: Date };

export interface ParanoidVaultService {
  /** The current opaque blob + metadata, or `null` when none exists yet. */
  get(userId: string): Promise<ParanoidVaultRow | null>;
  /** Blob metadata only (version/size/format/updatedAt) — never any content. */
  getMetadata(userId: string): Promise<VaultMetadata | null>;
  /** Bounded newest-first metadata page; never selects ciphertext bytes. */
  listHistory(userId: string, input: VaultHistoryListQuery): Promise<VaultHistoryListResponse>;
  /** One owner-scoped retained opaque blob, or `null` when absent. */
  getHistory(userId: string, version: number): Promise<ParanoidVaultHistoryRow | null>;
  /** Compare-and-swap write. Never overwrites newer ciphertext. */
  put(input: ParanoidVaultPutInput): Promise<ParanoidVaultPutResult>;
  /** Portfolio-free durable media state for the current paranoid account. */
  getMediaState(userId: string): Promise<VaultMediaStateResponse | null>;
  /** One-medium-at-a-time verified migrate-then-drop transition. */
  patchMedia(
    userId: string,
    request: VaultMediaPatchRequest,
  ): Promise<ParanoidVaultMediaMutationResult>;
  /** Explicitly purge retired ciphertext after both safety gates pass. */
  purgeRetiredServer(
    userId: string,
    proof: VaultMediaVerification,
  ): Promise<ParanoidVaultRetiredPurgeServiceResult>;
}

function metadataOf(row: ParanoidVaultRow): VaultMetadata {
  return {
    version: row.version,
    formatVersion: row.formatVersion,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sameMediaSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((medium) => right.includes(medium));
}

function envelopeSha256(blob: Uint8Array): string {
  return createHash('sha256').update(blob).digest('hex');
}

function proofIsFresh(proof: VaultMediaVerification, now: Date): boolean {
  const verifiedAt = new Date(proof.verifiedAt).getTime();
  const delta = now.getTime() - verifiedAt;
  return Number.isFinite(verifiedAt) && delta >= -60_000 && delta <= VAULT_MEDIA_PROOF_MAX_AGE_MS;
}

export function createParanoidVaultService(deps: ParanoidVaultServiceDeps): ParanoidVaultService {
  const now = deps.now ?? (() => new Date());
  const retiredPurgeMinAgeMs = deps.retiredPurgeMinAgeMs ?? VAULT_RETIRED_PURGE_MIN_AGE_MS;

  async function mediaState(userId: string): Promise<VaultMediaStateResponse | null> {
    const snapshot = await deps.vaults.getMediaSnapshot(userId);
    if (snapshot === null || snapshot.privacyMode !== 'paranoid' || snapshot.mediaSet === null) {
      return null;
    }
    const retired = snapshot.retiredHead;
    return {
      mediaSet: snapshot.mediaSet,
      driveAttestedVersion: snapshot.driveAttestedVersion,
      retiredServer:
        retired?.retiredAt == null
          ? null
          : {
              latestVersion: retired.version,
              retiredAt: retired.retiredAt.toISOString(),
              purgeEligibleAt: new Date(
                retired.retiredAt.getTime() + retiredPurgeMinAgeMs,
              ).toISOString(),
            },
    };
  }

  return {
    async get(userId) {
      return deps.vaults.getCurrent(userId);
    },

    async getMetadata(userId) {
      const row = await deps.vaults.getCurrent(userId);
      return row ? metadataOf(row) : null;
    },

    async listHistory(userId, input) {
      const page = await deps.vaults.listHistory(userId, input);
      return {
        items: page.items.map((row) => ({
          version: row.version,
          createdAt: row.createdAt.toISOString(),
          sizeBytes: row.sizeBytes,
          medium: 'server' as const,
        })),
        nextCursor: page.nextCursor,
      };
    },

    async getHistory(userId, version) {
      return deps.vaults.getHistory(userId, version);
    },

    async put({ userId, expectedVersion, blob }) {
      // Size cap FIRST — an oversized payload is rejected before any parse or
      // persistence.
      if (blob.length > deps.maxBytes) {
        return { status: 'too_large', sizeBytes: blob.length, maxBytes: deps.maxBytes };
      }

      // Read ONLY the safe header fields the blind store is entitled to.
      let header: { formatVersion: number; vaultVersion: number };
      try {
        header = readVaultServerHeader(blob);
      } catch (err) {
        if (err instanceof VaultEnvelopeError) {
          return { status: 'malformed', reason: err.message };
        }
        throw err;
      }

      // The envelope's version must strictly advance the precondition — a
      // client always writes `last seen + 1` (or a merged max(parents)+1). A
      // non-advancing version is a malformed/stale write, never persisted.
      if (expectedVersion !== null && header.vaultVersion <= expectedVersion) {
        return {
          status: 'malformed',
          reason: 'envelope vaultVersion does not advance the If-Match version',
        };
      }
      if (expectedVersion === null) {
        const media = await deps.vaults.getMediaSnapshot(userId);
        const minimumKnownVersion = Math.max(
          media?.driveAttestedVersion ?? 0,
          media?.retiredHead?.version ?? 0,
        );
        if (
          media?.privacyMode === 'paranoid' &&
          media.mediaSet !== null &&
          !media.mediaSet.includes('server') &&
          header.vaultVersion < minimumKnownVersion
        ) {
          return {
            status: 'malformed',
            reason: 'staged server vaultVersion is older than the durable Drive state',
          };
        }
      }

      const result = await deps.vaults.compareAndSwap({
        userId,
        expectedVersion,
        version: header.vaultVersion,
        formatVersion: header.formatVersion,
        sizeBytes: blob.length,
        blob,
        retention: deps.retention,
        now: now(),
      });
      return result;
    },

    getMediaState(userId) {
      return mediaState(userId);
    },

    async patchMedia(userId, request) {
      const snapshot = await deps.vaults.getMediaSnapshot(userId);
      if (!snapshot) return { status: 'not_found' };
      if (snapshot.privacyMode !== 'paranoid' || snapshot.mediaSet === null) {
        return { status: 'mode_required' };
      }

      const currentMediaSet = snapshot.mediaSet;
      if (sameMediaSet(currentMediaSet, request.mediaSet)) {
        return {
          status: 'ok',
          media: (await mediaState(userId))!,
          idempotent: true,
        };
      }
      if (!sameMediaSet(currentMediaSet, request.expectedMediaSet)) {
        return { status: 'precondition_failed', mediaSet: currentMediaSet };
      }

      const added = request.mediaSet.filter((medium) => !currentMediaSet.includes(medium));
      const removed = currentMediaSet.filter((medium) => !request.mediaSet.includes(medium));
      if (added.length + removed.length !== 1) return { status: 'invalid_transition' };

      const verification = request.verification;
      if (!verification) return { status: 'verification_required' };
      const expectedVerifiedMedium =
        added[0] ?? request.mediaSet.find((medium) => medium !== removed[0]);
      const checkedAt = now();
      const minimumKnownVersion = Math.max(
        snapshot.driveAttestedVersion ?? 0,
        snapshot.retiredHead?.version ?? 0,
      );
      if (
        verification.medium !== expectedVerifiedMedium ||
        !proofIsFresh(verification, checkedAt) ||
        snapshot.current === null ||
        verification.vaultVersion !== snapshot.current.version ||
        verification.vaultVersion < minimumKnownVersion ||
        verification.envelopeSha256 !== envelopeSha256(snapshot.current.blob)
      ) {
        return { status: 'verification_invalid' };
      }

      const transition = await deps.vaults.transitionMedia({
        userId,
        expectedMediaSet: request.expectedMediaSet,
        mediaSet: request.mediaSet,
        driveAttestedVersion: request.mediaSet.includes('drive') ? verification.vaultVersion : null,
        expectedServerVersion: snapshot.current.version,
        now: checkedAt,
      });
      switch (transition.status) {
        case 'ok':
          return {
            status: 'ok',
            media: (await mediaState(userId))!,
            idempotent: transition.idempotent,
          };
        case 'not_found':
          return { status: 'not_found' };
        case 'mode_required':
          return { status: 'mode_required' };
        case 'precondition_failed':
          return {
            status: 'precondition_failed',
            mediaSet: transition.mediaSet,
          };
        case 'server_version_changed':
          return { status: 'verification_invalid' };
      }
    },

    async purgeRetiredServer(userId, proof) {
      const snapshot = await deps.vaults.getMediaSnapshot(userId);
      if (!snapshot) return { status: 'not_found' };
      if (snapshot.privacyMode !== 'paranoid' || snapshot.mediaSet === null) {
        return { status: 'mode_required' };
      }
      if (!sameMediaSet(snapshot.mediaSet, ['drive'])) return { status: 'media_invalid' };
      const retired = snapshot.retiredHead;
      if (!retired) {
        return {
          status: 'ok',
          media: (await mediaState(userId))!,
          purgedVersions: 0,
          purgedBytes: 0,
        };
      }

      const checkedAt = now();
      if (
        proof.medium !== 'drive' ||
        !proofIsFresh(proof, checkedAt) ||
        proof.vaultVersion < retired.version ||
        (proof.vaultVersion === retired.version &&
          proof.envelopeSha256 !== envelopeSha256(retired.blob))
      ) {
        return { status: 'proof_invalid' };
      }

      const purged = await deps.vaults.purgeRetired({
        userId,
        proofVersion: proof.vaultVersion,
        now: checkedAt,
        minRetirementAgeMs: retiredPurgeMinAgeMs,
      });
      switch (purged.status) {
        case 'ok':
          return {
            status: 'ok',
            media: (await mediaState(userId))!,
            purgedVersions: purged.purgedVersions,
            purgedBytes: purged.purgedBytes,
          };
        case 'not_found':
          return { status: 'not_found' };
        case 'mode_required':
          return { status: 'mode_required' };
        case 'media_invalid':
          return { status: 'media_invalid' };
        case 'proof_version_too_old':
        case 'unretired_history':
          return { status: 'proof_invalid' };
        case 'retention_not_met':
          return { status: 'retention_not_met', eligibleAt: purged.eligibleAt };
      }
    },
  };
}
