import {
  vaultDocumentV1Schema,
  type VaultDocumentV1,
  type VaultEntity,
  type VaultEntityKind,
  type VaultMergeRecord,
} from '@bettertrack/contracts';

import { VaultCryptoError } from './errors';

export const VAULT_MERGE_LOG_LIMIT = 20;

export interface MergeVaultDocumentsInput {
  left: VaultDocumentV1;
  leftVersion: number;
  right: VaultDocumentV1;
  rightVersion: number;
  /** A known locally pending write is an offline fork, even when it dominates. */
  forceDivergent?: boolean;
  /** Device recording this deterministic merged successor. */
  deviceId: string;
  /** An injected clock makes merge records reproducible in matrix tests. */
  mergedAt: string;
}

export interface MergedVaultDocument {
  document: VaultDocumentV1;
  vaultVersion: number;
  /** Whether a new CAS successor must be written. */
  divergent: boolean;
}

/**
 * §4's entity-atomic merge. It never combines fields: a whole entity wins by
 * revision, timestamp, then writer device ID. An edit always beats a tombstone
 * at the same revision so an offline delete cannot silently erase money data.
 */
export function mergeVaultDocuments(input: MergeVaultDocumentsInput): MergedVaultDocument {
  assertVersion(input.leftVersion);
  assertVersion(input.rightVersion);
  const left = parseDocument(input.left);
  const right = parseDocument(input.right);

  // Only a strictly newer document that contains every winner from its older
  // parent is a safe linear successor. Dominance in the other direction is
  // evidence of an unmarked offline fork, not causal ancestry. Equal-version
  // documents are linear only when their decrypted contents are identical.
  if (!input.forceDivergent) {
    if (input.leftVersion > input.rightVersion && documentDominates(left, right)) {
      return { document: left, vaultVersion: input.leftVersion, divergent: false };
    }
    if (input.rightVersion > input.leftVersion && documentDominates(right, left)) {
      return { document: right, vaultVersion: input.rightVersion, divergent: false };
    }
    if (input.leftVersion === input.rightVersion && canonicalJson(left) === canonicalJson(right)) {
      return { document: left, vaultVersion: input.leftVersion, divergent: false };
    }
  }

  const vaultVersion = Math.max(input.leftVersion, input.rightVersion) + 1;
  const entityKinds = new Set<VaultEntityKind>([
    ...(Object.keys(left.entities) as VaultEntityKind[]),
    ...(Object.keys(right.entities) as VaultEntityKind[]),
  ]);
  const entities: VaultDocumentV1['entities'] = {};
  for (const kind of [...entityKinds].sort(compareText)) {
    const merged = mergeEntityKind(left.entities[kind] ?? [], right.entities[kind] ?? []);
    if (merged.length > 0) entities[kind] = merged;
  }

  const record: VaultMergeRecord = {
    mergedAt: input.mergedAt,
    parents: [...new Set([input.leftVersion, input.rightVersion])].sort((a, b) => a - b),
    into: vaultVersion,
    deviceId: input.deviceId,
  };
  return {
    vaultVersion,
    divergent: true,
    document: {
      schemaVersion: left.schemaVersion,
      entities,
      mergeLog: canonicalMergeLog([...left.mergeLog, ...right.mergeLog, record]),
    },
  };
}

/** Returns the single deterministic winning atomic entity for an id. */
export function chooseVaultEntity(left: VaultEntity, right: VaultEntity): VaultEntity {
  if (left.rev !== right.rev) return left.rev > right.rev ? left : right;

  const leftLive = left.deletedAt === null;
  const rightLive = right.deletedAt === null;
  // The delete/edit rule is deliberately evaluated before timestamps at equal
  // revision. Re-deletion is a new rev, therefore it wins normally later.
  if (leftLive !== rightLive) return leftLive ? left : right;

  const editedAt = compareText(left.editedAt, right.editedAt);
  if (editedAt !== 0) return editedAt > 0 ? left : right;
  return compareText(left.editedBy, right.editedBy) >= 0 ? left : right;
}

/** True only when every atomic state in `right` already loses to `left`. */
export function documentDominates(left: VaultDocumentV1, right: VaultDocumentV1): boolean {
  for (const [kind, entities] of Object.entries(right.entities) as [
    VaultEntityKind,
    VaultEntity[],
  ][]) {
    const candidates = new Map((left.entities[kind] ?? []).map((entity) => [entity.id, entity]));
    for (const rightEntity of entities) {
      const leftEntity = candidates.get(rightEntity.id);
      if (
        leftEntity == null ||
        !sameEntity(chooseVaultEntity(leftEntity, rightEntity), leftEntity)
      ) {
        return false;
      }
    }
  }
  return true;
}

function mergeEntityKind(left: VaultEntity[], right: VaultEntity[]): VaultEntity[] {
  const byId = new Map<string, VaultEntity>();
  for (const entity of [...left, ...right]) {
    const existing = byId.get(entity.id);
    byId.set(entity.id, existing == null ? entity : chooseVaultEntity(existing, entity));
  }
  return [...byId.values()].sort((a, b) => compareText(a.id, b.id));
}

function canonicalMergeLog(records: VaultMergeRecord[]): VaultMergeRecord[] {
  const unique = new Map<string, VaultMergeRecord>();
  for (const record of records) unique.set(canonicalJson(record), record);
  return [...unique.values()]
    .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))
    .slice(-VAULT_MERGE_LOG_LIMIT);
}

function parseDocument(document: VaultDocumentV1): VaultDocumentV1 {
  const parsed = vaultDocumentV1Schema.safeParse(document);
  if (!parsed.success) {
    throw new VaultCryptoError(
      'document-invalid',
      'Vault document does not match the current schema.',
    );
  }
  return parsed.data;
}

function sameEntity(left: VaultEntity, right: VaultEntity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new VaultCryptoError('envelope-invalid', 'Vault versions must be positive integers.');
  }
}
