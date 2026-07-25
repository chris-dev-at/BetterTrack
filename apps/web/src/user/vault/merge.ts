import {
  vaultDocumentV1Schema,
  vaultEntitySchema,
  vaultMergeRecordSchema,
  vaultVersionSchema,
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

interface NormalizedInstant {
  epochSecond: number;
  fraction: string;
}

const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?Z$/;

/**
 * Entity-atomic vault merge. A whole entity wins by revision, live state,
 * normalized edit instant, writer device, then canonical serialized content.
 */
export function mergeVaultDocuments(input: MergeVaultDocumentsInput): MergedVaultDocument {
  assertVersion(input.leftVersion);
  assertVersion(input.rightVersion);
  const left = parseDocument(input.left);
  const right = parseDocument(input.right);

  // A strictly newer document containing every winning entity from the older
  // parent is already a linear successor. Equal-version byte-equivalent
  // documents likewise need no new merge generation.
  if (!input.forceDivergent) {
    if (input.leftVersion > input.rightVersion && documentDominatesParsed(left, right)) {
      return { document: left, vaultVersion: input.leftVersion, divergent: false };
    }
    if (input.rightVersion > input.leftVersion && documentDominatesParsed(right, left)) {
      return { document: right, vaultVersion: input.rightVersion, divergent: false };
    }
    if (input.leftVersion === input.rightVersion && sameDocument(left, right)) {
      return { document: left, vaultVersion: input.leftVersion, divergent: false };
    }
  }

  const vaultVersion = Math.max(input.leftVersion, input.rightVersion) + 1;
  assertVersion(vaultVersion);

  const entityKinds = new Set<VaultEntityKind>([
    ...(Object.keys(left.entities) as VaultEntityKind[]),
    ...(Object.keys(right.entities) as VaultEntityKind[]),
  ]);
  const entities: VaultDocumentV1['entities'] = {};
  for (const kind of [...entityKinds].sort(compareText)) {
    const merged = mergeEntityKind(left.entities[kind] ?? [], right.entities[kind] ?? []);
    if (merged.length > 0) entities[kind] = merged;
  }

  const record = parseMergeRecord({
    mergedAt: input.mergedAt,
    parents: [...new Set([input.leftVersion, input.rightVersion])].sort((a, b) => a - b),
    into: vaultVersion,
    deviceId: input.deviceId,
  });

  return {
    vaultVersion,
    divergent: true,
    document: {
      schemaVersion: left.schemaVersion,
      entities,
      mergeLog: appendMergeRecord(left.mergeLog, right.mergeLog, record),
    },
  };
}

/**
 * Returns the deterministic winning atomic entity for one id.
 *
 * Both entities are validated before any early winner is selected, so malformed
 * timestamps fail closed even when revision or live state would otherwise decide
 * the comparison.
 */
export function chooseVaultEntity(left: VaultEntity, right: VaultEntity): VaultEntity {
  const parsedLeft = parseEntity(left);
  const parsedRight = parseEntity(right);
  if (parsedLeft.id !== parsedRight.id) {
    throw documentInvalid('Vault merge candidates must have the same entity id.');
  }

  const leftInstant = parseInstant(parsedLeft.editedAt);
  const rightInstant = parseInstant(parsedRight.editedAt);

  if (parsedLeft.rev !== parsedRight.rev) {
    return parsedLeft.rev > parsedRight.rev ? parsedLeft : parsedRight;
  }

  const leftLive = parsedLeft.deletedAt === null;
  const rightLive = parsedRight.deletedAt === null;
  if (leftLive !== rightLive) return leftLive ? parsedLeft : parsedRight;

  const editedAt = compareInstants(leftInstant, rightInstant);
  if (editedAt !== 0) return editedAt > 0 ? parsedLeft : parsedRight;

  const editedBy = compareText(parsedLeft.editedBy, parsedRight.editedBy);
  if (editedBy !== 0) return editedBy > 0 ? parsedLeft : parsedRight;

  const wholeEntity = compareText(canonicalJson(parsedLeft), canonicalJson(parsedRight));
  return wholeEntity >= 0 ? parsedLeft : parsedRight;
}

/** True only when every atomic state in `right` already loses to `left`. */
export function documentDominates(left: VaultDocumentV1, right: VaultDocumentV1): boolean {
  return documentDominatesParsed(parseDocument(left), parseDocument(right));
}

function documentDominatesParsed(left: VaultDocumentV1, right: VaultDocumentV1): boolean {
  for (const [kind, entities] of Object.entries(right.entities) as [
    VaultEntityKind,
    VaultEntity[],
  ][]) {
    const candidates = entityMap(left.entities[kind] ?? []);
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
  return [...entityMap([...left, ...right]).values()].sort((a, b) => compareText(a.id, b.id));
}

function entityMap(entities: VaultEntity[]): Map<string, VaultEntity> {
  const byId = new Map<string, VaultEntity>();
  for (const entity of entities) {
    const parsed = parseEntity(entity);
    const existing = byId.get(parsed.id);
    byId.set(parsed.id, existing == null ? parsed : chooseVaultEntity(existing, parsed));
  }
  return byId;
}

function appendMergeRecord(
  left: VaultMergeRecord[],
  right: VaultMergeRecord[],
  appended: VaultMergeRecord,
): VaultMergeRecord[] {
  const appendedKey = canonicalJson(appended);
  const uniqueHistory = new Map<string, VaultMergeRecord>();
  for (const record of [...left, ...right]) {
    const key = canonicalJson(record);
    if (key !== appendedKey) uniqueHistory.set(key, record);
  }

  const history = [...uniqueHistory.entries()]
    .sort(([leftKey, leftRecord], [rightKey, rightRecord]) => {
      const mergedAt = compareInstants(
        parseInstant(leftRecord.mergedAt, 'mergeLog mergedAt'),
        parseInstant(rightRecord.mergedAt, 'mergeLog mergedAt'),
      );
      return mergedAt === 0 ? compareText(leftKey, rightKey) : mergedAt;
    })
    .slice(-(VAULT_MERGE_LOG_LIMIT - 1))
    .map(([, record]) => record);
  return [...history, appended];
}

function parseDocument(document: VaultDocumentV1): VaultDocumentV1 {
  const parsed = vaultDocumentV1Schema.safeParse(document);
  if (!parsed.success) {
    throw documentInvalid('Vault document does not match the current schema.');
  }
  canonicalJson(parsed.data);
  return parsed.data;
}

function parseEntity(entity: VaultEntity): VaultEntity {
  const parsed = vaultEntitySchema.safeParse(entity);
  if (!parsed.success) {
    throw documentInvalid('Vault entity does not match the current schema.');
  }
  canonicalJson(parsed.data);
  return parsed.data;
}

function parseMergeRecord(record: VaultMergeRecord): VaultMergeRecord {
  const parsed = vaultMergeRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw documentInvalid('Vault merge metadata does not match the current schema.');
  }
  return parsed.data;
}

function parseInstant(value: string, field = 'entity editedAt'): NormalizedInstant {
  const match = INSTANT_PATTERN.exec(value);
  if (match == null) {
    throw documentInvalid(`Vault ${field} must be a parseable RFC 3339 instant.`);
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText = '00',
    fractionText = '',
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw documentInvalid(`Vault ${field} must be a parseable RFC 3339 instant.`);
  }

  return {
    epochSecond: date.getTime() / 1_000,
    fraction: fractionText.replace(/0+$/, ''),
  };
}

function compareInstants(left: NormalizedInstant, right: NormalizedInstant): number {
  if (left.epochSecond !== right.epochSecond) {
    return left.epochSecond < right.epochSecond ? -1 : 1;
  }
  const width = Math.max(left.fraction.length, right.fraction.length);
  return compareText(left.fraction.padEnd(width, '0'), right.fraction.padEnd(width, '0'));
}

function sameDocument(left: VaultDocumentV1, right: VaultDocumentV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameEntity(left: VaultEntity, right: VaultEntity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw documentInvalid('Vault documents may contain only finite JSON numbers.');
    }
    if (Object.is(value, -0)) return '-0';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    assertAcyclic(value, ancestors);
    const result = `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    assertAcyclic(value, ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      ancestors.delete(value);
      throw documentInvalid('Vault documents may contain only plain JSON objects.');
    }
    const result = `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`)
      .join(',')}}`;
    ancestors.delete(value);
    return result;
  }
  throw documentInvalid('Vault documents may contain only JSON values.');
}

function assertAcyclic(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) {
    throw documentInvalid('Vault documents may not contain cyclic values.');
  }
  ancestors.add(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertVersion(version: number): void {
  if (!vaultVersionSchema.safeParse(version).success) {
    throw new VaultCryptoError('envelope-invalid', 'Vault versions must be positive integers.');
  }
}

function documentInvalid(message: string): VaultCryptoError {
  return new VaultCryptoError('document-invalid', message);
}
