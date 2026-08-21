import {
  VAULT_DOC_SCHEMA_VERSION,
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_DOCUMENT_VERSION,
  type VaultCommonDoc,
  type VaultConfig,
  type VaultHeaderDoc,
  type VaultMedia,
} from '@bettertrack/contracts';
import { uuidv7 } from 'uuidv7';

import {
  createVault,
  createVaultDocument,
  readVaultHeaderDocument,
  transitionVaultMedia,
} from '../../lib/vaultApi';
import { utf8, zeroBytes } from './bytes';
import { endpointVaultKeystore } from './keystore/runtime';
import { acknowledgePlainCustodyRisk } from './keystore';
import {
  deriveAccountBinding,
  deriveKeyFingerprint,
  deriveVaultWrapKey,
  generateContentKey,
  wrapContentKey,
} from './keys';
import { encryptVaultDoc } from './keys/documents';
import { createVaultRetirementProofManager } from './media/retirementProof';

export interface ProvisionVaultInput {
  accountId: string;
  name: string;
  media: readonly VaultMedia[];
  driveConnectionId: string | null;
  mnemonic: string;
  custody: 'wrapped' | 'plain';
  devicePassword?: string;
  plainRiskAcknowledged: boolean;
}

/**
 * Provision the E1/E3 server-backed shape. Drive document creation is owned by
 * E5's per-document data home; refusing before config creation keeps this
 * branch from leaving a half-created Drive vault while that adapter is absent.
 */
export async function provisionVault(input: ProvisionVaultInput): Promise<VaultConfig> {
  if (input.media.includes('drive')) {
    throw new Error('per-vault-drive-provisioning-unavailable');
  }

  const headerDocId = uuidv7();
  const commonDocId = uuidv7();
  const keyId = uuidv7();
  const deviceId = uuidv7();
  const contentKey = generateContentKey();
  const retirementProof = createVaultRetirementProofManager();
  let wrapKey: Uint8Array | undefined;

  try {
    const [keyFingerprint, proofDocument, accountBinding] = await Promise.all([
      deriveKeyFingerprint(contentKey),
      retirementProof.ensure({
        schemaVersion: VAULT_DOCUMENT_V1_VERSION,
        entities: {},
        mergeLog: [],
        mirrorProvenance: [],
      }),
      deriveAccountBinding(input.accountId),
    ]);
    if (proofDocument.document.schemaVersion !== VAULT_DOCUMENT_VERSION) {
      throw new Error('retirement-proof-provisioning-failed');
    }
    const clientSecurity = proofDocument.document.clientSecurity;
    const vault = await createVault({
      name: input.name,
      headerDocId,
      commonDocId,
      media: [...input.media],
      driveConnectionId: input.driveConnectionId,
      keyFingerprint,
      retirementProofPublicKey: clientSecurity.retirementProof.publicKey,
    });

    wrapKey = await deriveVaultWrapKey(input.mnemonic, vault.id);
    const keySlot = await wrapContentKey({
      contentKey,
      wrapKey,
      vaultId: vault.id,
      keyId,
    });
    const writtenAt = new Date().toISOString();
    const headerDocument: VaultHeaderDoc = {
      schemaVersion: VAULT_DOC_SCHEMA_VERSION,
      name: input.name,
      portfolios: [],
      keySlots: [keySlot],
      driveConnection: null,
      created: { at: writtenAt, deviceId },
    };
    const commonDocument: VaultCommonDoc = {
      schemaVersion: VAULT_DOC_SCHEMA_VERSION,
      entities: {},
      mergeLog: [],
      mirrorProvenance: [],
      clientSecurity,
    };
    const base = {
      keyId,
      keySlots: [keySlot],
      vaultId: vault.id,
      accountBinding,
      docVersion: 1,
      schemaVersion: VAULT_DOC_SCHEMA_VERSION,
      deviceId,
      writtenAt,
    };
    const headerPlaintext = utf8(JSON.stringify(headerDocument));
    const commonPlaintext = utf8(JSON.stringify(commonDocument));
    let header: Awaited<ReturnType<typeof encryptVaultDoc>>;
    let common: Awaited<ReturnType<typeof encryptVaultDoc>>;
    try {
      [header, common] = await Promise.all([
        encryptVaultDoc({
          plaintext: headerPlaintext,
          contentKey,
          header: {
            ...base,
            docId: headerDocId,
            docKind: 'header',
            writeId: uuidv7(),
          },
        }),
        encryptVaultDoc({
          plaintext: commonPlaintext,
          contentKey,
          header: {
            ...base,
            docId: commonDocId,
            docKind: 'common',
            writeId: uuidv7(),
          },
        }),
      ]);
    } finally {
      zeroBytes(headerPlaintext);
      zeroBytes(commonPlaintext);
    }
    let attestedVault: VaultConfig;
    try {
      await Promise.all([
        createVaultDocument(vault.id, headerDocId, header.envelope),
        createVaultDocument(vault.id, commonDocId, common.envelope),
      ]);
      const attested = await transitionVaultMedia(vault.id, {
        transitionId: uuidv7(),
        expected: {
          media: vault.media,
          driveConnectionId: vault.driveConnectionId,
          mediaAttestedAt: vault.mediaAttestedAt,
        },
        next: {
          media: vault.media,
          driveConnectionId: vault.driveConnectionId,
        },
        verification: {
          kind: 'server',
          docs: [header, common].map((document) => ({
            docId: document.header.docId,
            docVersion: document.header.docVersion,
            writeId: document.header.writeId,
          })),
        },
      });
      attestedVault = {
        ...vault,
        mediaAttestedAt: attested.mediaAttestedAt,
        mediaAttestedDriveConnectionId: attested.mediaAttestedDriveConnectionId,
      };
    } finally {
      zeroBytes(header.envelope);
      zeroBytes(common.envelope);
    }

    const fetchHeaderEnvelope = () => readVaultHeaderDocument(vault.id, headerDocId);
    if (input.custody === 'plain') {
      if (!input.plainRiskAcknowledged) throw new Error('plain-custody-acknowledgment-required');
      await endpointVaultKeystore.storePlainAfterVerifiedOpen({
        vaultId: vault.id,
        mnemonic: input.mnemonic,
        acknowledgment: acknowledgePlainCustodyRisk(vault.id),
        expectedFingerprint: vault.keyFingerprint,
        fetchHeaderEnvelope,
      });
    } else {
      await endpointVaultKeystore.storeAfterVerifiedOpen({
        vaultId: vault.id,
        mnemonic: input.mnemonic,
        devicePassword: input.devicePassword,
        expectedFingerprint: vault.keyFingerprint,
        fetchHeaderEnvelope,
      });
    }
    return attestedVault;
  } finally {
    retirementProof.clear();
    if (wrapKey != null) zeroBytes(wrapKey);
    zeroBytes(contentKey);
  }
}
