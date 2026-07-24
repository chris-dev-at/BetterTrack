import {
  readVaultServerHeader,
  VaultEnvelopeError,
  type VaultMetadata,
} from '@bettertrack/contracts';

import type {
  ParanoidVaultRepository,
  ParanoidVaultRetention,
} from '../../data/repositories/paranoidVaultRepository';
import type { ParanoidVaultRow } from '../../data/schema';

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

export interface ParanoidVaultService {
  /** The current opaque blob + metadata, or `null` when none exists yet. */
  get(userId: string): Promise<ParanoidVaultRow | null>;
  /** Blob metadata only (version/size/format/updatedAt) — never any content. */
  getMetadata(userId: string): Promise<VaultMetadata | null>;
  /** Compare-and-swap write. Never overwrites newer ciphertext. */
  put(input: ParanoidVaultPutInput): Promise<ParanoidVaultPutResult>;
}

function metadataOf(row: ParanoidVaultRow): VaultMetadata {
  return {
    version: row.version,
    formatVersion: row.formatVersion,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createParanoidVaultService(deps: ParanoidVaultServiceDeps): ParanoidVaultService {
  const now = deps.now ?? (() => new Date());

  return {
    async get(userId) {
      return deps.vaults.getCurrent(userId);
    },

    async getMetadata(userId) {
      const row = await deps.vaults.getCurrent(userId);
      return row ? metadataOf(row) : null;
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
  };
}
