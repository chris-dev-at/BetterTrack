import type { VaultDocument, VaultEntity, VaultEntityKind } from '@bettertrack/contracts';
import { VAULT_ENTITY_KINDS } from '@bettertrack/contracts';

import { bytesToBase64 } from '../../bytes';
import { encodeHeaderDoc } from '../api';
import { addPassphraseSlot, buildVaultHeader } from '../headerCrypto';
import { buildMigrationBlobs } from '../migration';
import {
  deriveMigrationContentKey,
  deriveMigrationHeaderMaterial,
  deriveMigrationVaultId,
  migrationHeaderRandom,
} from '../migrationCrypto';
import { buildVaultQrPayload } from '../qr';
import { serializeRecoveryKitV2 } from '../recoveryKit';
import { splitVaultDocument } from '../upgrade';

/**
 * The deterministic generator behind the six vector families
 * (`docs/VAULTS_V2_DESIGN.md` r3 §25). It runs the REAL crypto path — real
 * Argon2id (64 MiB, t=3), real AES-256-GCM, real HKDF — over fixed inputs, so
 * the bytes it emits are exactly what a conforming client (web or the mobile
 * port) reproduces. `packages/domain` stays pure: it holds the frozen JSON
 * this produces, never this code.
 *
 * Determinism comes from three places and nothing else: a counting byte source
 * for anything that would otherwise be random, the fixed 12-word passphrases,
 * and the r3 §18 migration derivations (which are pure in the legacy key).
 */

// ── Fixed inputs ─────────────────────────────────────────────────────────────

export const VECTOR_PASSPHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
export const VECTOR_SECOND_PASSPHRASE =
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
export const VECTOR_VAULT_ID = '4f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a01';
export const VECTOR_PORTFOLIO_A = '11111111-1111-4111-8111-111111111111';
export const VECTOR_PORTFOLIO_B = '22222222-2222-4222-8222-222222222222';
export const VECTOR_DEVICE_ID = '2f2f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a02';
export const VECTOR_WRITE_ID = '6f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a03';
export const VECTOR_WRITTEN_AT = '2026-08-08T09:00:00.000Z';
export const VECTOR_QR_CODE = '1199T5HY';
/** The legacy BTVAULT1 content key a migration derives K_c from (fixed 32 bytes). */
export const VECTOR_LEGACY_VAULT_KEY = Uint8Array.from(
  { length: 32 },
  (_, i) => (i * 7 + 3) & 0xff,
);
export const VECTOR_MIGRATION_SCOPE_ID = 'user-vector-42';

/** A counting byte source; the ONLY source of "randomness" in the vectors. */
function counting(start = 0): (length: number) => Uint8Array {
  let cursor = start;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) bytes[i] = (cursor + i) % 256;
    cursor = (cursor + length) % 256;
    return bytes;
  };
}

const WRITE = {
  deviceId: VECTOR_DEVICE_ID,
  writeId: VECTOR_WRITE_ID,
  writtenAt: VECTOR_WRITTEN_AT,
};

function vectorEntity(id: string, data: Record<string, unknown> = {}): VaultEntity {
  return {
    id,
    rev: 1,
    editedAt: VECTOR_WRITTEN_AT,
    editedBy: VECTOR_DEVICE_ID,
    deletedAt: null,
    data,
  };
}

// ── Family 1: v2 header derive / wrap / unwrap (incl. the mac) ────────────────

export async function buildHeaderVector() {
  const built = await buildVaultHeader({
    vaultId: VECTOR_VAULT_ID,
    name: 'Drive vault',
    backends: 'drive',
    passphrase: VECTOR_PASSPHRASE,
    portfolios: [{ portfolioId: VECTOR_PORTFOLIO_A, alias: 'Tech' }],
    ...WRITE,
    randomBytes: counting(7),
  });
  return {
    passphrase: VECTOR_PASSPHRASE,
    header: built.header,
    headerBytesBase64: bytesToBase64(encodeHeaderDoc(built.header)),
    contentKeyBase64: bytesToBase64(built.contentKey),
  };
}

// ── Family 2: multi-slot keySlots[] ──────────────────────────────────────────

export async function buildMultiSlotVector() {
  const built = await buildVaultHeader({
    vaultId: VECTOR_VAULT_ID,
    name: 'Shared vault',
    backends: 'server',
    passphrase: VECTOR_PASSPHRASE,
    ...WRITE,
    randomBytes: counting(20),
  });
  const twoSlot = await addPassphraseSlot(
    built.header,
    built.contentKey,
    VECTOR_SECOND_PASSPHRASE,
    WRITE,
    counting(120),
  );
  return {
    firstPassphrase: VECTOR_PASSPHRASE,
    secondPassphrase: VECTOR_SECOND_PASSPHRASE,
    header: twoSlot,
    headerBytesBase64: bytesToBase64(encodeHeaderDoc(twoSlot)),
    contentKeyBase64: bytesToBase64(built.contentKey),
  };
}

// ── Family 3: per-portfolio split across ALL 26 entity kinds ──────────────────

/** A v1 account touching every one of the 26 contract kinds, two portfolios. */
export function vectorFullAccount(): VaultDocument {
  const STANDING_ORDER = 'aaaa1111-1111-4111-8111-111111111111';
  const IMPORT_BATCH = 'bbbb2222-2222-4222-8222-222222222222';
  const CASH_MOVEMENT = 'dddd4444-4444-4444-8444-444444444444';
  const CASH_BUDGET = 'cccc3333-3333-4333-8333-333333333333';
  const CASH_TAG = '66666666-6666-4666-8666-666666666666';
  const CASH_RULE = 'a4444444-4444-4444-8444-444444444445';
  const EXPENSE_CATEGORY = 'a5555555-5555-4555-8555-555555555556';
  const EXPENSE_BUDGET = 'a6666666-6666-4666-8666-666666666667';
  const perKind: Partial<Record<VaultEntityKind, VaultEntity[]>> = {
    portfolio: [
      vectorEntity(VECTOR_PORTFOLIO_A, { name: 'Tech' }),
      vectorEntity(VECTOR_PORTFOLIO_B, { name: 'Pension' }),
    ],
    transaction: [
      vectorEntity('a0000000-0000-4000-8000-000000000001', { portfolioId: VECTOR_PORTFOLIO_A }),
    ],
    dividend: [
      vectorEntity('a0000000-0000-4000-8000-000000000002', { portfolioId: VECTOR_PORTFOLIO_B }),
    ],
    cashSource: [
      vectorEntity('a0000000-0000-4000-8000-000000000003', { portfolioId: VECTOR_PORTFOLIO_A }),
    ],
    cashMovement: [vectorEntity(CASH_MOVEMENT, { portfolioId: VECTOR_PORTFOLIO_B })],
    cashMovementTag: [
      vectorEntity('a0000000-0000-4000-8000-000000000004', {
        movementId: CASH_MOVEMENT,
        tagId: CASH_TAG,
      }),
    ],
    portfolioSetting: [
      vectorEntity('a0000000-0000-4000-8000-000000000005', { portfolioId: VECTOR_PORTFOLIO_A }),
    ],
    standingOrder: [vectorEntity(STANDING_ORDER, { portfolioId: VECTOR_PORTFOLIO_A })],
    standingOrderRun: [
      vectorEntity('a0000000-0000-4000-8000-000000000006', { standingOrderId: STANDING_ORDER }),
    ],
    importBatch: [vectorEntity(IMPORT_BATCH, { portfolioId: VECTOR_PORTFOLIO_B })],
    importRow: [vectorEntity('a0000000-0000-4000-8000-000000000007', { batchId: IMPORT_BATCH })],
    portfolioDailySnapshot: [
      vectorEntity('a0000000-0000-4000-8000-000000000008', { portfolioId: VECTOR_PORTFOLIO_A }),
    ],
    portfolioSnapshotState: [
      vectorEntity('a0000000-0000-4000-8000-000000000009', { portfolioId: VECTOR_PORTFOLIO_B }),
    ],
    // common-scoped
    taxSetting: [vectorEntity('b0000000-0000-4000-8000-000000000001', { mode: 'country' })],
    customAsset: [vectorEntity('b0000000-0000-4000-8000-000000000002', { symbol: 'PRIV' })],
    customAssetValue: [
      vectorEntity('b0000000-0000-4000-8000-000000000003', {
        assetId: 'b0000000-0000-4000-8000-000000000002',
      }),
    ],
    cashTag: [vectorEntity(CASH_TAG, { name: 'Rent' })],
    cashRule: [vectorEntity(CASH_RULE, { name: 'Groceries' })],
    cashBudget: [vectorEntity(CASH_BUDGET, { tagId: CASH_TAG })],
    expenseCategory: [vectorEntity(EXPENSE_CATEGORY, { name: 'Food' })],
    expenseRule: [vectorEntity('b0000000-0000-4000-8000-000000000004', { name: 'Fuel' })],
    expenseBudget: [vectorEntity(EXPENSE_BUDGET, { categoryId: EXPENSE_CATEGORY })],
    expenseTransaction: [
      vectorEntity('b0000000-0000-4000-8000-000000000005', {
        categoryId: EXPENSE_CATEGORY,
        amount: '10',
      }),
    ],
    expenseBudgetFire: [
      vectorEntity('b0000000-0000-4000-8000-000000000006', { budgetId: EXPENSE_BUDGET }),
    ],
    cashBudgetFire: [
      vectorEntity('b0000000-0000-4000-8000-000000000007', { budgetId: CASH_BUDGET }),
    ],
    cashRuleTag: [
      vectorEntity('b0000000-0000-4000-8000-000000000008', { ruleId: CASH_RULE, tagId: CASH_TAG }),
    ],
  };
  return { schemaVersion: 1, entities: perKind as VaultDocument['entities'], mergeLog: [] };
}

export function buildPartitionVector() {
  const split = splitVaultDocument({ document: vectorFullAccount(), vaultId: VECTOR_VAULT_ID });
  return {
    coveredKinds: [...VAULT_ENTITY_KINDS],
    commonKinds: Object.keys(split.commonDoc.entities).sort(),
    portfolioDocs: split.portfolioDocs.map((doc) => ({
      portfolioId: doc.portfolioId,
      kinds: Object.keys(doc.entities).sort(),
    })),
    index: split.index,
    report: split.report,
  };
}

// ── Family 4: full migration transcript, byte-exact ──────────────────────────

export async function buildMigrationVector() {
  const contentKey = await deriveMigrationContentKey(VECTOR_LEGACY_VAULT_KEY);
  const vaultId = await deriveMigrationVaultId(VECTOR_MIGRATION_SCOPE_ID);
  const headerMaterial = await deriveMigrationHeaderMaterial(contentKey);

  const document: VaultDocument = {
    schemaVersion: 1,
    entities: {
      portfolio: [vectorEntity(VECTOR_PORTFOLIO_A, { name: 'Tech' })],
      transaction: [
        vectorEntity('c0000000-0000-4000-8000-000000000001', { portfolioId: VECTOR_PORTFOLIO_A }),
      ],
      customAsset: [vectorEntity('c0000000-0000-4000-8000-000000000002', { symbol: 'AAA' })],
    },
    mergeLog: [],
  };

  // The successor header, built deterministically from the derived material and
  // the legacy free-text passphrase (r2 §9 keeps it for v1-migrated vaults).
  const built = await buildVaultHeader({
    vaultId,
    name: 'My vault',
    backends: 'server',
    passphrase: VECTOR_PASSPHRASE,
    legacyPassphrase: true,
    contentKey,
    kdfSalt: bytesToBase64(Uint8Array.from({ length: 16 }, (_, i) => (i + 1) & 0xff)),
    portfolios: [{ portfolioId: VECTOR_PORTFOLIO_A, alias: 'Tech' }],
    deviceId: VECTOR_DEVICE_ID,
    writeId: VECTOR_WRITE_ID,
    writtenAt: VECTOR_WRITTEN_AT,
    randomBytes: migrationHeaderRandom(headerMaterial),
  });

  const split = splitVaultDocument({ document, vaultId });
  const blobs = await buildMigrationBlobs({ split, contentKey, writtenAt: VECTOR_WRITTEN_AT });

  return {
    legacyVaultKeyBase64: bytesToBase64(VECTOR_LEGACY_VAULT_KEY),
    scopeId: VECTOR_MIGRATION_SCOPE_ID,
    derivedVaultId: vaultId,
    contentKeyBase64: bytesToBase64(contentKey),
    headerBytesBase64: bytesToBase64(encodeHeaderDoc(built.header)),
    commonEnvelopeBase64: bytesToBase64(blobs.common.envelope),
    portfolioEnvelopes: blobs.portfolios.map((p) => ({
      portfolioId: p.portfolioId,
      envelopeBase64: bytesToBase64(p.blob.envelope),
    })),
  };
}

// ── Family 5: recovery kit v2 ────────────────────────────────────────────────

export function buildRecoveryKitVector() {
  const kit = serializeRecoveryKitV2({
    vaultId: VECTOR_VAULT_ID,
    vaultName: 'Drive vault',
    backends: 'drive',
    passphrase: VECTOR_PASSPHRASE,
  });
  return {
    vaultId: VECTOR_VAULT_ID,
    vaultName: 'Drive vault',
    backends: 'drive' as const,
    passphrase: VECTOR_PASSPHRASE,
    kitBase64: bytesToBase64(kit.bytes),
  };
}

// ── Family 6: canonical QR string ────────────────────────────────────────────

export async function buildQrVector() {
  const payload = await buildVaultQrPayload({
    vaultId: VECTOR_VAULT_ID,
    name: 'Drive vault',
    passphrase: VECTOR_PASSPHRASE,
    code: VECTOR_QR_CODE,
    randomBytes: counting(5),
  });
  return { vaultId: VECTOR_VAULT_ID, name: 'Drive vault', code: VECTOR_QR_CODE, payload };
}

/** The whole vector set, produced once by the real crypto path. */
export async function buildAllVectors() {
  return {
    v2Header: await buildHeaderVector(),
    v2MultiSlot: await buildMultiSlotVector(),
    v2Partition: buildPartitionVector(),
    v2Migration: await buildMigrationVector(),
    v2RecoveryKit: buildRecoveryKitVector(),
    v2Qr: await buildQrVector(),
  };
}
