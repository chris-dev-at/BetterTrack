import {
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_SCHEMAS,
  vaultStrictDocumentV1Schema,
  type ParanoidDisableResponse,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type VaultStrictDocumentV1,
  type VaultStrictEntity,
} from '@bettertrack/contracts';

import { disableParanoidMode } from '../../../lib/userApi';

const REHYDRATION_ID_PREFIX = 'bettertrack:vault-rehydration:';

/** Strip v2 client-only security material and validate every restore row. */
export function toStrictRestoreDocument(document: VaultDocument): VaultStrictDocumentV1 {
  const entities: VaultStrictEntity[] = [];
  for (const kind of VAULT_ENTITY_KINDS) {
    const rows = document.entities[kind] ?? [];
    for (const row of rows) {
      entities.push(parseStrictEntity(kind, row));
    }
  }
  return vaultStrictDocumentV1Schema.parse({
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities,
    mergeLog: document.mergeLog,
  });
}

export async function disableUnlockedVault(
  document: VaultDocument,
  accountId: string,
): Promise<ParanoidDisableResponse> {
  const storageKey = `${REHYDRATION_ID_PREFIX}${accountId}`;
  const rehydrationId = storedRehydrationId(storageKey) ?? globalThis.crypto.randomUUID();
  rememberRehydrationId(storageKey, rehydrationId);
  const result = await disableParanoidMode({
    rehydrationId,
    document: toStrictRestoreDocument(document),
    confirm: true,
  });
  forgetRehydrationId(storageKey);
  return result;
}

function parseStrictEntity(kind: VaultEntityKind, row: VaultEntity): VaultStrictEntity {
  // The keyed schema keeps the kind/payload relationship exact at runtime. The
  // union return is re-parsed by the strict document before it crosses the API.
  return VAULT_ENTITY_SCHEMAS[kind].parse({ ...row, kind }) as VaultStrictEntity;
}

function storedRehydrationId(key: string): string | null {
  try {
    const value = globalThis.sessionStorage?.getItem(key);
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberRehydrationId(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // A same-tab retry still remains safe server-side if storage is blocked.
  }
}

function forgetRehydrationId(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // No persisted retry marker to remove.
  }
}
