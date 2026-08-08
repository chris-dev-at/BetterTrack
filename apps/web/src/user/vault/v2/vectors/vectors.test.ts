import { webcrypto } from 'node:crypto';

import { vaultV2Vectors } from '@bettertrack/domain/vaultVectors';
import { beforeAll, describe, expect, it } from 'vitest';

import { base64ToBytes, bytesToBase64 } from '../../bytes';
import { decryptVaultBlob } from '../blobCrypto';
import { openVaultHeader } from '../headerCrypto';
import { importRecoveryKitV2 } from '../recoveryKit';
import { parseVaultQrPayload, unwrapVaultQrPayload } from '../qr';
import {
  buildHeaderVector,
  buildMigrationVector,
  buildMultiSlotVector,
  buildPartitionVector,
  buildQrVector,
  buildRecoveryKitVector,
} from './buildVectors';

/**
 * The six conformance families (`docs/VAULTS_V2_DESIGN.md` r3 §25).
 *
 * Two guarantees per family: the REAL crypto path reproduces the frozen bytes
 * published in `@bettertrack/domain/vaultVectors` (so a byte drift breaks the
 * build, and the mobile port has an exact oracle), and the bytes actually open
 * — decrypt/unwrap/import round-trips. Real Argon2id runs here; that is the
 * point of a conformance vector.
 */

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('vault v2 conformance vectors (r3 §25)', () => {
  it('family 1 — header derive/wrap/unwrap incl. the mac', async () => {
    const regenerated = await buildHeaderVector();
    // Byte-exact against the published oracle.
    expect(regenerated.headerBytesBase64).toBe(vaultV2Vectors.v2Header.headerBytesBase64);
    expect(regenerated.header.mac).toEqual(vaultV2Vectors.v2Header.header.mac);

    // And it opens: verified seal + the pinned content key.
    const opened = await openVaultHeader(
      vaultV2Vectors.v2Header.header,
      vaultV2Vectors.v2Header.passphrase,
    );
    expect(opened.sealState).toBe('verified');
    expect(bytesToBase64(opened.contentKey)).toBe(vaultV2Vectors.v2Header.contentKeyBase64);
  });

  it('family 2 — multi-slot keySlots[] (either phrase opens the same K_c)', async () => {
    const regenerated = await buildMultiSlotVector();
    expect(regenerated.headerBytesBase64).toBe(vaultV2Vectors.v2MultiSlot.headerBytesBase64);

    const header = vaultV2Vectors.v2MultiSlot.header;
    expect(header.keySlots).toHaveLength(2);
    const first = await openVaultHeader(header, vaultV2Vectors.v2MultiSlot.firstPassphrase);
    const second = await openVaultHeader(header, vaultV2Vectors.v2MultiSlot.secondPassphrase);
    expect(bytesToBase64(first.contentKey)).toBe(vaultV2Vectors.v2MultiSlot.contentKeyBase64);
    expect(bytesToBase64(second.contentKey)).toBe(vaultV2Vectors.v2MultiSlot.contentKeyBase64);
  });

  it('family 3 — per-portfolio split across all 26 kinds', () => {
    const regenerated = buildPartitionVector();
    expect(regenerated).toEqual(vaultV2Vectors.v2Partition);
    // The partition is exact: 26 covered, 13 common, no orphans, no remainder.
    expect(vaultV2Vectors.v2Partition.coveredKinds).toHaveLength(26);
    expect(vaultV2Vectors.v2Partition.commonKinds).toHaveLength(13);
    expect(vaultV2Vectors.v2Partition.report.orphans).toEqual([]);
    expect(vaultV2Vectors.v2Partition.report.entitiesIn).toBe(
      vaultV2Vectors.v2Partition.report.entitiesOut,
    );
  });

  it('family 4 — full migration transcript, byte-exact (derived K_c, deterministic IVs)', async () => {
    const regenerated = await buildMigrationVector();
    const oracle = vaultV2Vectors.v2Migration;
    expect(regenerated.derivedVaultId).toBe(oracle.derivedVaultId);
    expect(regenerated.contentKeyBase64).toBe(oracle.contentKeyBase64);
    expect(regenerated.headerBytesBase64).toBe(oracle.headerBytesBase64);
    expect(regenerated.commonEnvelopeBase64).toBe(oracle.commonEnvelopeBase64);
    expect(regenerated.portfolioEnvelopes).toEqual(oracle.portfolioEnvelopes);

    // The transcript's blobs decrypt under the derived K_c.
    const contentKey = base64ToBytes(oracle.contentKeyBase64, 'envelope-invalid');
    const common = await decryptVaultBlob(
      base64ToBytes(oracle.commonEnvelopeBase64, 'envelope-invalid'),
      contentKey,
    );
    expect(common.document.docKind).toBe('common');
    for (const portfolio of oracle.portfolioEnvelopes) {
      const doc = await decryptVaultBlob(
        base64ToBytes(portfolio.envelopeBase64, 'envelope-invalid'),
        contentKey,
      );
      if (doc.document.docKind !== 'portfolio') throw new Error('expected a portfolio doc');
      expect(doc.document.portfolioId).toBe(portfolio.portfolioId);
    }
  });

  it('family 5 — recovery kit v2', () => {
    const regenerated = buildRecoveryKitVector();
    expect(regenerated.kitBase64).toBe(vaultV2Vectors.v2RecoveryKit.kitBase64);
    const imported = importRecoveryKitV2(
      base64ToBytes(vaultV2Vectors.v2RecoveryKit.kitBase64, 'recovery-kit-invalid'),
    );
    expect(imported).toMatchObject({
      formatVersion: 2,
      vaultId: vaultV2Vectors.v2RecoveryKit.vaultId,
      backends: vaultV2Vectors.v2RecoveryKit.backends,
      passphrase: vaultV2Vectors.v2RecoveryKit.passphrase,
    });
  });

  it('family 6 — canonical QR string + code KDF', async () => {
    const regenerated = await buildQrVector();
    expect(regenerated.payload).toBe(vaultV2Vectors.v2Qr.payload);

    const parsed = parseVaultQrPayload(vaultV2Vectors.v2Qr.payload);
    if (!parsed.ok) throw new Error('the canonical QR payload must parse');
    const unwrapped = await unwrapVaultQrPayload(parsed.payload, vaultV2Vectors.v2Qr.code);
    expect(unwrapped).toEqual({
      ok: true,
      passphrase: vaultV2Vectors.v2Header.passphrase,
    });
  });
});
