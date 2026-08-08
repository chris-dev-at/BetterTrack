import {
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_DOCUMENT_VERSION,
  VAULT_MERGE_LOG_LIMIT,
  vaultDocumentSchema,
  vaultEntitySchema,
  vaultMergeRecordSchema,
  vaultVersionSchema,
  type VaultClientSecurity,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type VaultMergeRecord,
} from '@bettertrack/contracts';

import { VaultCryptoError } from './errors';
import {
  carriedForkProvenance,
  forkProvenanceDominates,
  mergeForkProvenance,
  pruneForkProvenance,
} from './mirrorProvenance';

// The bound is a WRITE-side trim (`appendMergeRecord` below); parsing tolerates
// any length (r3, mobile A1.2). Re-exported so existing imports keep working.
export { VAULT_MERGE_LOG_LIMIT };

export interface MergeVaultDocumentsInput {
  left: VaultDocument;
  leftVersion: number;
  right: VaultDocument;
  rightVersion: number;
  /** A known locally pending write is an offline fork, even when it dominates. */
  forceDivergent?: boolean;
  /** Device recording this deterministic merged successor. */
  deviceId: string;
  /** An injected clock makes merge records reproducible in matrix tests. */
  mergedAt: string;
}

export interface MergedVaultDocument {
  document: VaultDocument;
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
  const entities: VaultDocument['entities'] = {};
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
  const clientSecurity = mergedClientSecurity(left, right);
  const union = mergeForkProvenance(left.mirrorProvenance, right.mirrorProvenance);
  const common = {
    entities,
    mergeLog: appendMergeRecord(left.mergeLog, right.mergeLog, record),
    // §7.1 severed-fork provenance is content-addressed, not entity-atomic: the
    // union keyed by logical identity is what every replica converges on, and a
    // merge must never be the step that loses an identity map. It is pruned
    // against the MERGED entities, so a row one side deleted takes its provenance
    // with it instead of the union resurrecting an alias the server would reject.
    mirrorProvenance: pruneForkProvenance(union, entities),
  };
  const document: VaultDocument =
    clientSecurity == null
      ? { schemaVersion: VAULT_DOCUMENT_V1_VERSION, ...common }
      : { schemaVersion: VAULT_DOCUMENT_VERSION, ...common, clientSecurity };

  return {
    vaultVersion,
    divergent: true,
    document,
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
export function documentDominates(left: VaultDocument, right: VaultDocument): boolean {
  return documentDominatesParsed(parseDocument(left), parseDocument(right));
}

function documentDominatesParsed(left: VaultDocument, right: VaultDocument): boolean {
  // A linear successor must already carry the loser's fork provenance; otherwise
  // taking it verbatim would silently drop an identity the other replica captured.
  // Both sides are pruned against their OWN entities first: an entry whose row the
  // loser itself deleted is not an identity to preserve, and treating it as one
  // would force a divergent merge on every reconcile without ever converging.
  if (!forkProvenanceDominates(carriedForkProvenance(left), carriedForkProvenance(right))) {
    return false;
  }
  const leftSecurity = clientSecurityOf(left);
  const rightSecurity = clientSecurityOf(right);
  if (rightSecurity != null && leftSecurity == null) return false;
  if (
    leftSecurity != null &&
    rightSecurity != null &&
    canonicalJson(leftSecurity) !== canonicalJson(rightSecurity)
  ) {
    throw documentInvalid('Vault retirement proof material diverged across replicas.');
  }
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

function mergedClientSecurity(
  left: VaultDocument,
  right: VaultDocument,
): VaultClientSecurity | undefined {
  const leftSecurity = clientSecurityOf(left);
  const rightSecurity = clientSecurityOf(right);
  if (leftSecurity == null && rightSecurity == null) return undefined;
  if (leftSecurity == null) return rightSecurity;
  if (rightSecurity == null) return leftSecurity;
  if (canonicalJson(leftSecurity) !== canonicalJson(rightSecurity)) {
    throw documentInvalid('Vault retirement proof material diverged across replicas.');
  }
  return leftSecurity;
}

function clientSecurityOf(document: VaultDocument): VaultClientSecurity | undefined {
  return document.schemaVersion === VAULT_DOCUMENT_VERSION ? document.clientSecurity : undefined;
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

function parseDocument(document: VaultDocument): VaultDocument {
  const parsed = vaultDocumentSchema.safeParse(document);
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

function sameDocument(left: VaultDocument, right: VaultDocument): boolean {
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
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor == null || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        ancestors.delete(value);
        throw documentInvalid(
          'Vault arrays may contain only dense enumerable indexed data properties.',
        );
      }
      entries.push(canonicalJson(descriptor.value, ancestors));
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      ancestors.delete(value);
      throw documentInvalid('Vault arrays may contain only indexed JSON values.');
    }
    const result = `[${entries.join(',')}]`;
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
    const entries = Reflect.ownKeys(value).map((key): [string, unknown] => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== 'string' ||
        descriptor == null ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        ancestors.delete(value);
        throw documentInvalid(
          'Vault objects may contain only enumerable string-keyed data properties.',
        );
      }
      return [key, descriptor.value];
    });
    const result = `{${entries
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
  if (!Number.isSafeInteger(version) || !vaultVersionSchema.safeParse(version).success) {
    throw new VaultCryptoError(
      'envelope-invalid',
      'Vault versions must be positive safe integers.',
    );
  }
}

function documentInvalid(message: string): VaultCryptoError {
  return new VaultCryptoError('document-invalid', message);
}
