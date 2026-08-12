import fixture from './v2.fixture.json';

import type { VaultVectorKdfParams } from './v1';

/**
 * Vaults v2 conformance vectors — the six families of `docs/VAULTS_V2_DESIGN.md`
 * §16 / r3 §25, published as the shared oracle both clients replay.
 *
 * The bytes are produced by the platform hardening pass's real crypto path
 * (real Argon2id m=65536/t=3/p=1, AES-256-GCM, HKDF-SHA256), byte-frozen here.
 * `packages/domain` stays pure: it carries the frozen JSON and these types, no
 * crypto — and, like `./v1`, it imports NOTHING from other packages (design r3
 * build ruling): even type-only contracts imports would drag the contracts
 * sources into this package's minimal-lib compile graph. The `VaultVector*`
 * interfaces are local structural mirrors; the web replay suite parses every
 * fixture through the real zod schemas, so mirror/contract drift fails there.
 *
 * Everything is deterministic — fixed passphrases, a counting byte source for
 * what would be random, and the r3 §18 migration derivations, which are pure
 * in the legacy key.
 */

// ── Structural mirrors of the v2 contract shapes ─────────────────────────────

/** Mirror of `VaultBackends` (`vaultBackendsSchema`). */
export type VaultVectorBackends = 'server' | 'drive' | 'both';

/** Mirror of `VaultKeySlot` (`vaultKeySlotSchema`). */
export interface VaultVectorKeySlot {
  slotId: string;
  kind: 'passphrase';
  wrappedKey: string;
}

/** Mirror of `VaultPortfolioIndexEntry` (`vaultPortfolioIndexEntrySchema`). */
export interface VaultVectorPortfolioIndexEntry {
  portfolioId: string;
  alias: string;
}

/** Mirror of `VaultHeaderMac` (`vaultHeaderMacSchema`, r3 §21). */
export interface VaultVectorHeaderMac {
  v: 1;
  tag: string;
}

/** Mirror of `VaultHeaderDoc` (`vaultHeaderDocSchema`, formatVersion 2). */
export interface VaultVectorHeaderDoc {
  formatVersion: 2;
  vaultId: string;
  name: string;
  kdfSalt: string;
  kdf: VaultVectorKdfParams;
  keySlots: VaultVectorKeySlot[];
  portfolios: VaultVectorPortfolioIndexEntry[];
  backends: VaultVectorBackends;
  headerVersion: number;
  deviceId: string;
  writeId: string;
  writtenAt: string;
  mac?: VaultVectorHeaderMac;
}

// ── The six families ─────────────────────────────────────────────────────────

export interface V2HeaderVector {
  passphrase: string;
  header: VaultVectorHeaderDoc;
  headerBytesBase64: string;
  contentKeyBase64: string;
}

export interface V2MultiSlotVector {
  firstPassphrase: string;
  secondPassphrase: string;
  header: VaultVectorHeaderDoc;
  headerBytesBase64: string;
  contentKeyBase64: string;
}

export interface V2PartitionVector {
  coveredKinds: string[];
  commonKinds: string[];
  portfolioDocs: Array<{ portfolioId: string; kinds: string[] }>;
  index: VaultVectorPortfolioIndexEntry[];
  report: { entitiesIn: number; entitiesOut: number; orphans: unknown[] };
}

export interface V2MigrationVector {
  legacyVaultKeyBase64: string;
  scopeId: string;
  derivedVaultId: string;
  contentKeyBase64: string;
  headerBytesBase64: string;
  commonEnvelopeBase64: string;
  portfolioEnvelopes: Array<{ portfolioId: string; envelopeBase64: string }>;
}

export interface V2RecoveryKitVector {
  vaultId: string;
  vaultName: string;
  backends: VaultVectorBackends;
  passphrase: string;
  kitBase64: string;
}

export interface V2QrVector {
  vaultId: string;
  name: string;
  code: string;
  payload: string;
}

export interface VaultV2Vectors {
  v2Header: V2HeaderVector;
  v2MultiSlot: V2MultiSlotVector;
  v2Partition: V2PartitionVector;
  v2Migration: V2MigrationVector;
  v2RecoveryKit: V2RecoveryKitVector;
  v2Qr: V2QrVector;
}

export const vaultV2Vectors = fixture as unknown as VaultV2Vectors;
