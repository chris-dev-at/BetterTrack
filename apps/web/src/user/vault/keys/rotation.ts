import {
  inspectVaultDocEnvelope,
  vaultCommonDocSchema,
  vaultPortfolioDocSchema,
  type VaultDocEnvelopeHeader,
  type VaultDocKind,
  type VaultHeaderDoc,
  type VaultKeyFingerprint,
  type VaultKeySlot,
} from '@bettertrack/contracts';

import { equalBytes, utf8, zeroBytes } from '../bytes';
import { type RandomBytes, secureRandomBytes } from '../crypto';
import { normalizeMnemonic } from '../bip39/mnemonic';
import {
  decryptVaultDoc,
  encryptVaultDoc,
  openVaultHeaderWithMnemonic,
  type VerifiedVaultHeaderOpen,
} from './documents';
import { VaultKeyCoreError, asVaultKeyCoreError } from './errors';
import {
  createVaultKeyMaterial,
  selectActiveSeedKeySlot,
  type VaultContentKeyMaterial,
} from './keyCore';

export interface RotationWriteMetadata {
  docVersion: number;
  deviceId: string;
  writeId: string;
  writtenAt: string;
}

export interface VaultRotationDocumentManifestEntry {
  docId: string;
  docKind: VaultDocKind;
  docVersion: number;
}

export interface RotatedVaultDocument {
  docId: string;
  previousDocVersion: number;
  header: VaultDocEnvelopeHeader;
  envelope: Uint8Array;
}

export interface VaultRotationReadBackDocument {
  docId: string;
  envelope: Uint8Array;
}

export interface VaultRotationRoundTrip {
  /** Opaque E4/E5 destination id, for example `server` or a Drive connection id. */
  target: string;
  documents: readonly VaultRotationReadBackDocument[];
}

export interface VaultRotationCommitPlan {
  vaultId: string;
  keyFingerprint: VaultKeyFingerprint;
  keySlot: VaultKeySlot;
  documents: readonly RotatedVaultDocument[];
  requiredRoundTripTargets: readonly string[];
  historyInvalidation: {
    scope: 'all-prior-versions';
    documents: readonly { docId: string; throughDocVersion: number }[];
  };
}

export interface VaultRotationStageResult {
  /** Opaque id for the non-authoritative candidate set written by E4/E5. */
  stageId: string;
  /** E3 authenticates every byte read back; a boolean receipt is insufficient. */
  roundTrips: readonly VaultRotationRoundTrip[];
}

export interface VaultRotationFinalizeResult {
  historyInvalidated: true;
}

export interface RotateVaultDocumentsInput {
  vaultId: string;
  currentMnemonic: string;
  currentFingerprint?: VaultKeyFingerprint;
  /** Generate and ceremony-confirm these words before starting external writes. */
  newMnemonic: string;
  newKeyId: string;
  documents: readonly Uint8Array[];
  /** Authoritative current inventory supplied by E4's synchronized manifest. */
  expectedDocuments: readonly VaultRotationDocumentManifestEntry[];
  /** Every selected storage destination must return a complete opaque read-back. */
  requiredRoundTripTargets: readonly string[];
  metadataFor: (currentHeader: VaultDocEnvelopeHeader, index: number) => RotationWriteMetadata;
  /**
   * E4/E5 write non-authoritative candidates while retaining every current and
   * historical version, then return bytes freshly read from every destination.
   */
  stage: (plan: VaultRotationCommitPlan) => Promise<VaultRotationStageResult>;
  /** Promote the already-verified stage and only then invalidate old history. */
  finalize: (input: {
    plan: VaultRotationCommitPlan;
    stageId: string;
  }) => Promise<VaultRotationFinalizeResult>;
  randomBytes?: RandomBytes;
}

export interface VaultRotationResult {
  mnemonic: string;
  keyMaterial: VaultContentKeyMaterial;
  documents: readonly RotatedVaultDocument[];
  historyInvalidated: true;
}

/**
 * Fresh words always mean fresh K_c and a verified full-doc rewrite. There is
 * deliberately no phrase-only rewrap path.
 */
export async function rotateVaultDocuments(
  input: RotateVaultDocumentsInput,
): Promise<VaultRotationResult> {
  try {
    return await rotateVaultDocumentsInternal(input);
  } catch (cause) {
    throw asVaultKeyCoreError('rotation-failed', 'Vault rotation failed closed.', cause);
  }
}

async function rotateVaultDocumentsInternal(
  input: RotateVaultDocumentsInput,
): Promise<VaultRotationResult> {
  if (input.documents.length === 0) {
    throw new VaultKeyCoreError('rotation-failed', 'Rotation requires the complete document set.');
  }
  requireUniqueRoundTripTargets(input.requiredRoundTripTargets);
  const inspected = input.documents.map((envelope) => {
    const result = inspectVaultDocEnvelope(envelope);
    if (result.status === 'update-required') {
      throw new VaultKeyCoreError(
        'update-required',
        'A vault document needs a newer app before rotation.',
      );
    }
    return result;
  });
  assertManifest(
    inspected.map(({ header }) => header),
    input.expectedDocuments,
  );

  const first = inspected[0]!;
  if (first.header.vaultId !== input.vaultId) {
    throw new VaultKeyCoreError('rotation-failed', 'Document set belongs to another vault.');
  }
  if (input.newKeyId === first.header.keyId) {
    throw new VaultKeyCoreError('rotation-failed', 'Rotation requires a fresh content-key id.');
  }
  const headerIndexes = indexesOfKind(
    inspected.map(({ header }) => header),
    'header',
  );
  const commonIndexes = indexesOfKind(
    inspected.map(({ header }) => header),
    'common',
  );
  if (headerIndexes.length !== 1 || commonIndexes.length !== 1) {
    throw new VaultKeyCoreError(
      'rotation-failed',
      'A complete vault has exactly one header and one common document.',
    );
  }
  assertConsistentEnvelopeSet(inspected.map(({ header }) => header));

  const headerIndex = headerIndexes[0]!;
  const openedHeader = await openVaultHeaderWithMnemonic({
    envelope: input.documents[headerIndex]!,
    mnemonic: input.currentMnemonic,
    expectedVaultId: input.vaultId,
    expectedFingerprint: input.currentFingerprint,
  });
  const plaintexts: Uint8Array[] = new Array(input.documents.length);
  const rotatedPlaintexts: Uint8Array[] = [];
  let nextKey: VaultContentKeyMaterial | undefined;
  try {
    plaintexts[headerIndex] = openedHeader.plaintext;
    for (let index = 0; index < input.documents.length; index += 1) {
      if (index === headerIndex) continue;
      const header = inspected[index]!.header;
      const decrypted = await decryptVaultDoc({
        envelope: input.documents[index]!,
        contentKey: openedHeader.contentKey,
        expected: {
          vaultId: input.vaultId,
          docId: header.docId,
          docKind: header.docKind,
          accountBinding: header.accountBinding,
          docVersion: header.docVersion,
          keyId: header.keyId,
        },
      });
      plaintexts[index] = decrypted.plaintext;
    }
    assertCompleteDocumentTopology(
      inspected.map(({ header }) => header),
      plaintexts,
      openedHeader.document,
    );

    const mnemonic = input.newMnemonic;
    if (normalizeMnemonic(mnemonic) === normalizeMnemonic(input.currentMnemonic)) {
      throw new VaultKeyCoreError('rotation-failed', 'Rotation requires a fresh seed phrase.');
    }
    nextKey = await createVaultKeyMaterial({
      mnemonic,
      vaultId: input.vaultId,
      keyId: input.newKeyId,
      randomBytes: input.randomBytes ?? secureRandomBytes,
    });
    if (nextKey.keyFingerprint === openedHeader.keyFingerprint) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Rotation must replace the content key and fingerprint.',
      );
    }

    for (let index = 0; index < plaintexts.length; index += 1) {
      rotatedPlaintexts[index] =
        index === headerIndex
          ? serializeRotatedHeader(openedHeader.document, nextKey.keySlot)
          : plaintexts[index]!;
    }

    const documents: RotatedVaultDocument[] = [];
    for (let index = 0; index < inspected.length; index += 1) {
      const current = inspected[index]!.header;
      const metadata = input.metadataFor(current, index);
      if (!Number.isInteger(metadata.docVersion) || metadata.docVersion <= current.docVersion) {
        throw new VaultKeyCoreError(
          'rotation-failed',
          'Rotated document versions must increase monotonically.',
        );
      }
      const encrypted = await encryptVaultDoc({
        plaintext: rotatedPlaintexts[index]!,
        contentKey: nextKey.contentKey,
        header: {
          keyId: nextKey.keyId,
          keySlots: [nextKey.keySlot],
          vaultId: current.vaultId,
          docId: current.docId,
          docKind: current.docKind,
          accountBinding: current.accountBinding,
          docVersion: metadata.docVersion,
          schemaVersion: current.schemaVersion,
          deviceId: metadata.deviceId,
          writeId: metadata.writeId,
          writtenAt: metadata.writtenAt,
        },
        randomBytes: input.randomBytes ?? secureRandomBytes,
      });
      await verifyDocumentPlaintext(
        encrypted.envelope,
        encrypted.header,
        rotatedPlaintexts[index]!,
        nextKey.contentKey,
      );
      documents.push({
        docId: current.docId,
        previousDocVersion: current.docVersion,
        header: encrypted.header,
        envelope: encrypted.envelope,
      });
    }

    await proveHeaderCredentialCutover(
      input.currentMnemonic,
      mnemonic,
      input.vaultId,
      documents[headerIndex]!.envelope,
      nextKey,
    );
    const plan: VaultRotationCommitPlan = {
      vaultId: input.vaultId,
      keyFingerprint: nextKey.keyFingerprint,
      keySlot: nextKey.keySlot,
      documents,
      requiredRoundTripTargets: [...input.requiredRoundTripTargets],
      historyInvalidation: {
        scope: 'all-prior-versions',
        documents: documents.map((document) => ({
          docId: document.docId,
          throughDocVersion: document.previousDocVersion,
        })),
      },
    };
    let staged: VaultRotationStageResult;
    try {
      staged = await input.stage(plan);
    } catch (cause) {
      throw new VaultKeyCoreError('rotation-failed', 'Rotation candidate staging failed.', {
        cause,
      });
    }
    if (typeof staged.stageId !== 'string' || staged.stageId.trim() === '') {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Rotation adapter did not identify its staged candidate set.',
      );
    }
    await verifyCommittedRoundTrips(
      staged.roundTrips,
      input.requiredRoundTripTargets,
      documents,
      rotatedPlaintexts,
      input.currentMnemonic,
      mnemonic,
      nextKey,
      headerIndex,
    );
    let finalized: VaultRotationFinalizeResult;
    try {
      finalized = await input.finalize({ plan, stageId: staged.stageId });
    } catch (cause) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Rotation promotion or history invalidation failed.',
        { cause },
      );
    }
    if (finalized.historyInvalidated !== true) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Rotation adapter did not confirm prior-history invalidation.',
      );
    }
    const result: VaultRotationResult = {
      mnemonic,
      keyMaterial: nextKey,
      documents,
      historyInvalidated: true,
    };
    nextKey = undefined;
    return result;
  } finally {
    zeroBytes(openedHeader.contentKey);
    if (nextKey != null) zeroBytes(nextKey.contentKey);
    for (const plaintext of new Set([...plaintexts, ...rotatedPlaintexts])) {
      if (plaintext != null) zeroBytes(plaintext);
    }
  }
}

function assertManifest(
  headers: readonly VaultDocEnvelopeHeader[],
  expected: readonly VaultRotationDocumentManifestEntry[],
): void {
  if (headers.length !== expected.length) {
    throw new VaultKeyCoreError(
      'rotation-failed',
      'Rotation input does not match the authoritative document manifest.',
    );
  }
  const manifest = new Map<string, VaultRotationDocumentManifestEntry>();
  for (const entry of expected) {
    if (manifest.has(entry.docId)) {
      throw new VaultKeyCoreError('rotation-failed', 'Rotation manifest contains duplicate docs.');
    }
    manifest.set(entry.docId, entry);
  }
  const seen = new Set<string>();
  for (const header of headers) {
    const entry = manifest.get(header.docId);
    if (
      entry == null ||
      seen.has(header.docId) ||
      entry.docKind !== header.docKind ||
      entry.docVersion !== header.docVersion
    ) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Rotation input does not match the authoritative document manifest.',
      );
    }
    seen.add(header.docId);
  }
}

function assertConsistentEnvelopeSet(headers: readonly VaultDocEnvelopeHeader[]): void {
  const first = headers[0]!;
  const docIds = new Set<string>();
  selectActiveSeedKeySlot(first.keySlots, first.keyId);
  for (const header of headers) {
    selectActiveSeedKeySlot(header.keySlots, header.keyId);
    if (
      header.vaultId !== first.vaultId ||
      header.keyId !== first.keyId ||
      header.accountBinding !== first.accountBinding ||
      !equalKeySlots(header.keySlots, first.keySlots) ||
      docIds.has(header.docId)
    ) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Rotation document set is mixed, incomplete, or duplicated.',
      );
    }
    docIds.add(header.docId);
  }
}

function assertCompleteDocumentTopology(
  headers: readonly VaultDocEnvelopeHeader[],
  plaintexts: readonly Uint8Array[],
  headerDocument: VaultHeaderDoc,
): void {
  const expectedPortfolioIds = new Set(headerDocument.portfolios.map(({ id }) => id));
  if (expectedPortfolioIds.size !== headerDocument.portfolios.length) {
    throw new VaultKeyCoreError('rotation-failed', 'Vault header repeats a portfolio id.');
  }
  const portfolioIndexes = indexesOfKind(headers, 'portfolio');
  const commonIndex = indexesOfKind(headers, 'common')[0]!;
  if (!vaultCommonDocSchema.safeParse(parseJson(plaintexts[commonIndex]!, 'common')).success) {
    throw new VaultKeyCoreError(
      'rotation-failed',
      'Vault common document does not match the current schema.',
    );
  }
  if (portfolioIndexes.length !== expectedPortfolioIds.size) {
    throw new VaultKeyCoreError(
      'rotation-failed',
      'Rotation is missing one or more portfolio documents.',
    );
  }
  const actualPortfolioIds = new Set<string>();
  for (const index of portfolioIndexes) {
    const value = parseJson(plaintexts[index]!, 'portfolio');
    const parsed = vaultPortfolioDocSchema.safeParse(value);
    if (
      !parsed.success ||
      !expectedPortfolioIds.has(parsed.data.portfolioId) ||
      actualPortfolioIds.has(parsed.data.portfolioId)
    ) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Portfolio documents do not match the authenticated header roster.',
      );
    }
    actualPortfolioIds.add(parsed.data.portfolioId);
  }
}

function serializeRotatedHeader(document: VaultHeaderDoc, keySlot: VaultKeySlot): Uint8Array {
  return utf8(JSON.stringify({ ...document, keySlots: [keySlot] }));
}

async function verifyDocumentPlaintext(
  envelope: Uint8Array,
  header: VaultDocEnvelopeHeader,
  expectedPlaintext: Uint8Array,
  contentKey: Uint8Array,
): Promise<void> {
  const verified = await decryptVaultDoc({
    envelope,
    contentKey,
    expected: {
      vaultId: header.vaultId,
      docId: header.docId,
      docKind: header.docKind,
      accountBinding: header.accountBinding,
      docVersion: header.docVersion,
      keyId: header.keyId,
    },
  });
  try {
    if (!equalBytes(verified.plaintext, expectedPlaintext)) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Rotated document verification changed plaintext bytes.',
      );
    }
  } finally {
    zeroBytes(verified.plaintext);
  }
}

async function verifyCommittedRoundTrips(
  roundTrips: readonly VaultRotationRoundTrip[],
  requiredTargets: readonly string[],
  written: readonly RotatedVaultDocument[],
  plaintexts: readonly Uint8Array[],
  oldMnemonic: string,
  newMnemonic: string,
  nextKey: VaultContentKeyMaterial,
  headerIndex: number,
): Promise<void> {
  if (roundTrips.length !== requiredTargets.length) {
    throw new VaultKeyCoreError(
      'rotation-failed',
      'Rotation did not return every required storage round trip.',
    );
  }
  const required = new Set(requiredTargets);
  const seenTargets = new Set<string>();
  for (const roundTrip of roundTrips) {
    if (!required.has(roundTrip.target) || seenTargets.has(roundTrip.target)) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'Rotation returned an unexpected or duplicate storage round trip.',
      );
    }
    seenTargets.add(roundTrip.target);
    if (roundTrip.documents.length !== written.length) {
      throw new VaultKeyCoreError(
        'rotation-failed',
        'A storage round trip omitted a rotated document.',
      );
    }
    const readBacks = new Map<string, Uint8Array>();
    for (const document of roundTrip.documents) {
      if (readBacks.has(document.docId)) {
        throw new VaultKeyCoreError(
          'rotation-failed',
          'A storage round trip duplicated a rotated document.',
        );
      }
      readBacks.set(document.docId, document.envelope);
    }
    for (let index = 0; index < written.length; index += 1) {
      const document = written[index]!;
      const readBack = readBacks.get(document.docId);
      if (readBack == null || !equalBytes(readBack, document.envelope)) {
        throw new VaultKeyCoreError(
          'rotation-failed',
          'A storage round trip did not return the exact committed envelope.',
        );
      }
      await verifyDocumentPlaintext(
        readBack,
        document.header,
        plaintexts[index]!,
        nextKey.contentKey,
      );
    }
    await proveHeaderCredentialCutover(
      oldMnemonic,
      newMnemonic,
      nextKey.vaultId,
      readBacks.get(written[headerIndex]!.docId)!,
      nextKey,
    );
  }
}

async function proveHeaderCredentialCutover(
  oldMnemonic: string,
  newMnemonic: string,
  vaultId: string,
  headerEnvelope: Uint8Array,
  nextKey: VaultContentKeyMaterial,
): Promise<void> {
  await expectAuthenticationFailure(oldMnemonic, vaultId, headerEnvelope);
  let reopened: VerifiedVaultHeaderOpen | undefined;
  try {
    reopened = await openVaultHeaderWithMnemonic({
      envelope: headerEnvelope,
      mnemonic: newMnemonic,
      expectedVaultId: vaultId,
      expectedFingerprint: nextKey.keyFingerprint,
    });
    if (!equalBytes(reopened.contentKey, nextKey.contentKey)) {
      throw new VaultKeyCoreError('rotation-failed', 'New words did not reopen the rotated key.');
    }
  } finally {
    if (reopened != null) {
      zeroBytes(reopened.plaintext);
      zeroBytes(reopened.contentKey);
    }
  }
}

async function expectAuthenticationFailure(
  mnemonic: string,
  vaultId: string,
  headerEnvelope: Uint8Array,
): Promise<void> {
  try {
    const reopened = await openVaultHeaderWithMnemonic({
      envelope: headerEnvelope,
      mnemonic,
      expectedVaultId: vaultId,
    });
    zeroBytes(reopened.plaintext);
    zeroBytes(reopened.contentKey);
  } catch (cause) {
    if (cause instanceof VaultKeyCoreError && cause.code === 'authentication-failed') return;
    throw cause;
  }
  throw new VaultKeyCoreError('rotation-failed', 'Old words still open the rotated vault header.');
}

function requireUniqueRoundTripTargets(targets: readonly string[]): void {
  if (
    targets.length === 0 ||
    targets.some((target) => target.trim() === '') ||
    new Set(targets).size !== targets.length
  ) {
    throw new VaultKeyCoreError(
      'rotation-failed',
      'Rotation requires a unique read-back target for every selected medium.',
    );
  }
}

function indexesOfKind(headers: readonly VaultDocEnvelopeHeader[], kind: VaultDocKind): number[] {
  const indexes: number[] = [];
  for (const [index, header] of headers.entries()) {
    if (header.docKind === kind) indexes.push(index);
  }
  return indexes;
}

function equalKeySlots(left: readonly VaultKeySlot[], right: readonly VaultKeySlot[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (slot, index) =>
        slot.keyId === right[index]?.keyId &&
        slot.slot === right[index]?.slot &&
        slot.wrappedKc === right[index]?.wrappedKc,
    )
  );
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new VaultKeyCoreError('rotation-failed', `Vault ${label} document is invalid.`, {
      cause,
    });
  }
}
