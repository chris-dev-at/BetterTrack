import {
  VAULT_DOCUMENT_VERSION,
  VAULT_ENTITY_SCHEMAS,
  cashTagListResponseSchema,
  vaultCommonDocSchema,
  vaultPortfolioDocSchema,
  vaultStrictDocumentV1Schema,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type VaultStrictDocumentV1,
  type VaultStrictEntity,
} from '@bettertrack/contracts';

import { listCashTags } from '../../lib/cashApi';
import type {
  DecryptedPortfolioDocumentSet,
  VaultContentKeyBorrower,
} from './engine/portfolioDocumentSet';
import { toStrictRestoreDocument } from './paranoidDisable';

/**
 * The authoring boundary for E4's strict per-portfolio move-out document.
 *
 * The encrypted common doc is a historical snapshot. Account-common facts can
 * change while this vault stays locked, so they cannot be copied blindly into
 * a move-out request: the server compares those facts exactly and rejects a
 * stale snapshot. This builder therefore re-resolves every referenced cash tag
 * and server-present owner-manual asset immediately before the request is
 * authored. Encrypted manual snapshots cross only for explicitly detached ids.
 */

export const PORTFOLIO_VAULT_RESTORE_DOCUMENT_ERROR_CODES = [
  'VAULT_RESTORE_DOCUMENT_INVALID',
  'VAULT_RESTORE_SCOPE_INVALID',
  'VAULT_RESTORE_MANUAL_SNAPSHOT_UNAVAILABLE',
  'VAULT_RESTORE_MANUAL_SNAPSHOT_INVALID',
  'VAULT_RESTORE_CASH_TAG_MISSING',
  'VAULT_RESTORE_DOCUMENT_SET_CHANGED',
] as const;

export type PortfolioVaultRestoreDocumentErrorCode =
  (typeof PORTFOLIO_VAULT_RESTORE_DOCUMENT_ERROR_CODES)[number];

export class PortfolioVaultRestoreDocumentError extends Error {
  constructor(
    readonly code: PortfolioVaultRestoreDocumentErrorCode,
    message: string,
    readonly missingCashTagIds: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PortfolioVaultRestoreDocumentError';
  }
}

export interface PortfolioVaultRestoreDocumentInput {
  /** Authenticated account id; owner claims and the portfolio anchor must match. */
  userId: string;
  /** The locked stub / portfolio-doc id being restored. */
  portfolioId: string;
  /** Current writer, used only for freshly re-resolved common snapshots. */
  deviceId: string;
  /**
   * The exact authenticated E6 read snapshot being restored. Keeping the
   * envelope headers attached lets the required CAS predicate prove that the
   * plaintext still belongs to the current synchronized document set.
   */
  documentSet: DecryptedPortfolioDocumentSet;
  signal?: AbortSignal;
}

export type CashTagSnapshotResolver = (signal?: AbortSignal) => Promise<unknown>;

export interface ManualAssetSnapshotResolverInput {
  /** Every referenced owner-manual id found in the decrypted common document. */
  assetIds: readonly string[];
  signal?: AbortSignal;
}

/**
 * A lossless view of one manual asset that is still present server-side.
 *
 * Both the asset row and every current value row use vault-entity wire shapes
 * so decimal strings and JSON metadata cross this seam without projection.
 */
export interface CurrentManualAssetSnapshot {
  asset: VaultEntity;
  values: readonly VaultEntity[];
}

export interface ManualAssetSnapshotResolution {
  /** Exact current DB facts, including the complete current value set. */
  serverPresent: readonly CurrentManualAssetSnapshot[];
  /** Identities purged by move-in and therefore restorable from the vault. */
  detachedAssetIds: readonly string[];
}

export type ManualAssetSnapshotResolver = (
  input: ManualAssetSnapshotResolverInput,
) => Promise<ManualAssetSnapshotResolution>;

export interface PortfolioVaultRestoreDocumentDependencies {
  /**
   * E3 custody boundary. The complete authoring operation, including both
   * remote snapshot reads, remains inside one pinned content-key borrow.
   */
  keys: VaultContentKeyBorrower;
  /** Exact envelope-set CAS/sync-owner predicate for `input.documentSet`. */
  isDocumentSetCurrent(set: DecryptedPortfolioDocumentSet): boolean;
  /** Injection seam for tests; production always defaults to the parsed API client. */
  resolveCashTags?: CashTagSnapshotResolver;
  /**
   * Lossless current-state seam. It is required when the portfolio references
   * owner-manual assets: the existing public DTO deliberately rounds decimals
   * and omits metadata, so it cannot safely author E4's exact-CAS document.
   */
  resolveManualAssetSnapshots?: ManualAssetSnapshotResolver;
}

const PORTFOLIO_RESTORE_ENTITY_KINDS = [
  'portfolio',
  'transaction',
  'dividend',
  'cashSource',
  'cashMovement',
  'portfolioSetting',
  'standingOrder',
  'standingOrderRun',
  'importBatch',
  'importRow',
  'cashMovementTag',
  'cashBudget',
] as const satisfies readonly VaultEntityKind[];

type EntityOf<Kind extends VaultEntityKind> = Extract<VaultStrictEntity, { kind: Kind }>;

/**
 * Build the exact strict document accepted by `POST /portfolios/:id/vault/move-out`.
 * This is plumbing only: no portfolio valuation, tax, or other money math lives
 * here. Decimal strings are passed through the strict contracts unchanged.
 */
export async function buildPortfolioVaultRestoreDocument(
  input: PortfolioVaultRestoreDocumentInput,
  dependencies: PortfolioVaultRestoreDocumentDependencies,
): Promise<VaultStrictDocumentV1> {
  const { documentSet } = input;
  input.signal?.throwIfAborted();
  const authored = await dependencies.keys.withContentKey(
    documentSet.vaultId,
    async (_borrowedContentKey, keyId, assertSessionCurrent) => {
      const assertAuthoringCurrent = (): void => {
        input.signal?.throwIfAborted();
        assertSessionCurrent();
        assertDocumentSetCurrent(documentSet, dependencies);
        input.signal?.throwIfAborted();
      };

      assertAuthoringCurrent();
      assertDocumentSetIdentity(documentSet, input.portfolioId, keyId);
      return buildCurrentPortfolioVaultRestoreDocument(input, dependencies, assertAuthoringCurrent);
    },
  );

  // `withContentKey` performs its own post-operation custody assertion. This
  // second CAS gate covers any document update that landed while that final E3
  // stable-session check was in flight. If it fails, `authored` remains local
  // and is discarded instead of crossing the cleartext authoring boundary.
  input.signal?.throwIfAborted();
  assertDocumentSetCurrent(documentSet, dependencies);
  return authored;
}

async function buildCurrentPortfolioVaultRestoreDocument(
  input: PortfolioVaultRestoreDocumentInput,
  dependencies: PortfolioVaultRestoreDocumentDependencies,
  assertAuthoringCurrent: () => void,
): Promise<VaultStrictDocumentV1> {
  const portfolio = vaultPortfolioDocSchema.safeParse(input.documentSet.portfolio.document);
  const common = vaultCommonDocSchema.safeParse(input.documentSet.common.document);
  if (!portfolio.success || !common.success) {
    throw documentInvalid('The unlocked vault documents do not match the current doc-set schema.');
  }
  if (portfolio.data.portfolioId !== input.portfolioId) {
    throw scopeInvalid('The decrypted portfolio document belongs to a different portfolio.');
  }

  // Derived snapshots and fire ledgers are deliberately absent: the server
  // re-derives them after restore and its E4 validator refuses them even as
  // tombstones. Account-common expense/tax/rule rows never enter this record.
  const entities: VaultDocument['entities'] = {};
  const portfolioEntities: VaultStrictEntity[] = [];
  for (const kind of PORTFOLIO_RESTORE_ENTITY_KINDS) {
    const rows = portfolio.data.entities[kind] ?? [];
    if (rows.length > 0) entities[kind] = rows;
    for (const row of rows) portfolioEntities.push(parseStrictEntity(kind, row));
  }

  // Fail before the account-common resolver runs. A sibling row in a decrypted
  // document is corruption/cross-portfolio injection, never a row to trim and
  // silently accept.
  assertPortfolioScope(portfolioEntities, input.userId, input.portfolioId);

  const referencedAssetIds = referencedAssets(portfolioEntities);
  const encryptedManualAssets = referencedManualAssets(
    common.data.entities.customAsset ?? [],
    referencedAssetIds,
    input.userId,
  );
  assertAuthoringCurrent();
  const manualSnapshots = await resolveManualAssetGraph(
    encryptedManualAssets,
    common.data.entities.customAssetValue ?? [],
    input.userId,
    input.signal,
    dependencies.resolveManualAssetSnapshots,
  );
  assertAuthoringCurrent();
  if (manualSnapshots.assets.length > 0) entities.customAsset = manualSnapshots.assets;
  if (manualSnapshots.values.length > 0) entities.customAssetValue = manualSnapshots.values;

  const referencedTagIds = referencedCashTags(portfolioEntities);
  if (referencedTagIds.size > 0) {
    const resolveCashTags = dependencies.resolveCashTags ?? listCashTags;
    assertAuthoringCurrent();
    const rawResponse = await resolveCashTags(input.signal);
    assertAuthoringCurrent();
    const response = cashTagListResponseSchema.safeParse(rawResponse);
    if (!response.success) {
      throw documentInvalid('The current cash-tag response does not match its contract.');
    }
    const tagsById = new Map(response.data.tags.map((tag) => [tag.id, tag]));
    const missingCashTagIds = [...referencedTagIds].filter((id) => !tagsById.has(id)).sort();
    if (missingCashTagIds.length > 0) {
      throw new PortfolioVaultRestoreDocumentError(
        'VAULT_RESTORE_CASH_TAG_MISSING',
        'A cash tag referenced by this portfolio no longer exists in account-common data.',
        missingCashTagIds,
      );
    }

    const encryptedTags = new Map(
      (common.data.entities.cashTag ?? []).map((entity) => [entity.id, entity]),
    );
    entities.cashTag = [...referencedTagIds].sort().map((id) => {
      const tag = tagsById.get(id)!;
      const prior = encryptedTags.get(id);
      return {
        id,
        rev: prior?.rev ?? 0,
        // This is a transient authoring snapshot, not a write back into the
        // encrypted common doc. Its payload is the current server fact; the
        // sync metadata merely makes that fact a valid strict entity.
        editedAt: tag.updatedAt,
        editedBy: input.deviceId,
        deletedAt: null,
        data: {
          userId: input.userId,
          name: tag.name,
          color: tag.color,
          system: tag.system,
          systemKey: tag.systemKey,
          createdAt: tag.createdAt,
          updatedAt: tag.updatedAt,
        },
      } satisfies VaultEntity;
    });
  }

  const legacyDocument: VaultDocument = {
    schemaVersion: VAULT_DOCUMENT_VERSION,
    entities,
    // A per-portfolio move-out reports that portfolio doc's CAS history, never
    // the unrelated common doc's merge diagnostics.
    mergeLog: portfolio.data.mergeLog,
    mirrorProvenance: common.data.mirrorProvenance.filter(
      (entry) => entry.portfolioId === input.portfolioId,
    ),
    clientSecurity: common.data.clientSecurity,
  };

  let strict: VaultStrictDocumentV1;
  try {
    // Reuse the established v1 restore converter for owner-manual identity
    // restatement, strict per-kind parsing, and live-row provenance pruning.
    strict = toStrictRestoreDocument(legacyDocument);
  } catch (error) {
    if (error instanceof PortfolioVaultRestoreDocumentError) throw error;
    throw documentInvalid(
      'The scoped vault graph cannot be authored as a strict restore document.',
    );
  }

  const parsed = vaultStrictDocumentV1Schema.safeParse(strict);
  if (!parsed.success) {
    throw documentInvalid('The authored move-out document does not match the strict contract.');
  }
  assertRestoreScope(parsed.data, input.userId, input.portfolioId);
  assertAuthoringCurrent();
  return parsed.data;
}

function parseStrictEntity(kind: VaultEntityKind, row: VaultEntity): VaultStrictEntity {
  const parsed = VAULT_ENTITY_SCHEMAS[kind].safeParse({ ...row, kind });
  if (!parsed.success) {
    throw documentInvalid(`A vault ${kind} row does not match the strict restore contract.`);
  }
  return parsed.data as VaultStrictEntity;
}

function liveRows<Kind extends VaultEntityKind>(
  entities: readonly VaultStrictEntity[],
  kind: Kind,
): EntityOf<Kind>[] {
  return entities.filter(
    (entity): entity is EntityOf<Kind> => entity.kind === kind && entity.deletedAt === null,
  );
}

function assertPortfolioScope(
  entities: readonly VaultStrictEntity[],
  userId: string,
  portfolioId: string,
): void {
  const anchors = liveRows(entities, 'portfolio');
  if (
    anchors.length !== 1 ||
    anchors[0]!.id !== portfolioId ||
    anchors[0]!.data.userId !== userId ||
    anchors[0]!.data.vaultId !== null ||
    anchors[0]!.data.vaultAlias !== null ||
    anchors[0]!.data.alias !== null
  ) {
    throw scopeInvalid('The restore graph requires exactly one matching plain portfolio anchor.');
  }

  for (const kind of [
    'transaction',
    'dividend',
    'cashSource',
    'cashMovement',
    'portfolioSetting',
    'standingOrder',
    'importBatch',
    'cashBudget',
  ] as const) {
    for (const entity of liveRows(entities, kind)) {
      if (entity.data.portfolioId !== portfolioId) {
        throw scopeInvalid(`A live ${kind} row belongs to another portfolio.`);
      }
    }
  }

  for (const order of liveRows(entities, 'standingOrder')) {
    if (order.data.userId !== userId) {
      throw scopeInvalid('A live standing-order row belongs to another account.');
    }
  }

  const ordersById = new Map(liveRows(entities, 'standingOrder').map((row) => [row.id, row]));
  for (const run of liveRows(entities, 'standingOrderRun')) {
    if (ordersById.get(run.data.standingOrderId)?.data.portfolioId !== portfolioId) {
      throw scopeInvalid('A live standing-order run has no target-portfolio parent.');
    }
  }

  const movementsById = new Map(liveRows(entities, 'cashMovement').map((row) => [row.id, row]));
  for (const link of liveRows(entities, 'cashMovementTag')) {
    if (movementsById.get(link.data.movementId)?.data.portfolioId !== portfolioId) {
      throw scopeInvalid('A live cash-tag link has no target-portfolio movement.');
    }
  }

  const sourcesById = new Map(liveRows(entities, 'cashSource').map((row) => [row.id, row]));
  const batchesById = new Map<string, EntityOf<'importBatch'>>();
  for (const batch of liveRows(entities, 'importBatch')) {
    if (batch.data.ownerId !== userId) {
      throw scopeInvalid('A live import batch belongs to another account.');
    }
    if (
      batch.data.cashSourceId !== null &&
      sourcesById.get(batch.data.cashSourceId)?.data.portfolioId !== portfolioId
    ) {
      throw scopeInvalid('A live import batch references a foreign cash source.');
    }
    if (batchesById.has(batch.id)) {
      throw scopeInvalid('The restore graph contains a duplicate live import batch.');
    }
    batchesById.set(batch.id, batch);
  }
  const importRowIds = new Set<string>();
  for (const row of liveRows(entities, 'importRow')) {
    const batch = batchesById.get(row.data.batchId);
    if (!batch || batch.data.portfolioId !== portfolioId || batch.data.ownerId !== userId) {
      throw scopeInvalid('A live import row has no owning target-portfolio batch.');
    }
    if (importRowIds.has(row.id)) {
      throw scopeInvalid('The restore graph contains a duplicate live import row.');
    }
    importRowIds.add(row.id);
  }
}

function referencedAssets(entities: readonly VaultStrictEntity[]): Set<string> {
  return new Set([
    ...liveRows(entities, 'transaction').map((entity) => entity.data.assetId),
    ...liveRows(entities, 'dividend').map((entity) => entity.data.assetId),
    ...liveRows(entities, 'standingOrder').flatMap((entity) =>
      entity.data.assetId === null ? [] : [entity.data.assetId],
    ),
    ...liveRows(entities, 'importRow').flatMap((entity) =>
      entity.data.assetId === null ? [] : [entity.data.assetId],
    ),
  ]);
}

function referencedCashTags(entities: readonly VaultStrictEntity[]): Set<string> {
  return new Set([
    ...liveRows(entities, 'cashMovementTag').map((entity) => entity.data.tagId),
    ...liveRows(entities, 'cashBudget').map((entity) => entity.data.tagId),
  ]);
}

function referencedManualAssets(
  rows: readonly VaultEntity[],
  referencedAssetIds: ReadonlySet<string>,
  userId: string,
): VaultEntity[] {
  const seen = new Set<string>();
  const result: VaultEntity[] = [];
  for (const row of rows) {
    if (!referencedAssetIds.has(row.id)) continue;
    if (seen.has(row.id)) {
      throw scopeInvalid('The common document contains a duplicate referenced asset snapshot.');
    }
    seen.add(row.id);
    const asset = parseStrictEntity('customAsset', row) as EntityOf<'customAsset'>;
    if (asset.data.ownerId === null) continue; // Catalog snapshot: server re-resolves it.
    if (asset.deletedAt !== null || asset.data.ownerId !== userId) {
      throw scopeInvalid('A referenced manual asset is not a live claim of this account.');
    }
    result.push(row);
  }
  return result;
}

interface ResolvedManualAssetGraph {
  assets: VaultEntity[];
  values: VaultEntity[];
}

interface ParsedCurrentManualAssetSnapshot {
  asset: VaultEntity;
  values: VaultEntity[];
}

async function resolveManualAssetGraph(
  encryptedAssets: readonly VaultEntity[],
  encryptedValues: readonly VaultEntity[],
  userId: string,
  signal: AbortSignal | undefined,
  resolver: ManualAssetSnapshotResolver | undefined,
): Promise<ResolvedManualAssetGraph> {
  if (encryptedAssets.length === 0) return { assets: [], values: [] };
  if (!resolver) {
    throw new PortfolioVaultRestoreDocumentError(
      'VAULT_RESTORE_MANUAL_SNAPSHOT_UNAVAILABLE',
      'Exact current manual-asset snapshots are required to author this restore document.',
    );
  }

  const assetIds = encryptedAssets.map(({ id }) => id).sort();
  const requestedIds = new Set(assetIds);
  // Keep our canonical order isolated even if a resolver violates the
  // readonly input contract and mutates the array it receives.
  const rawResolution = await resolver({ assetIds: [...assetIds], signal });
  const { serverPresent, detachedAssetIds } = parseManualAssetResolution(
    rawResolution,
    requestedIds,
    userId,
  );

  const encryptedById = new Map(encryptedAssets.map((asset) => [asset.id, asset]));
  const encryptedValuesByAssetId = new Map<string, VaultEntity[]>();
  for (const row of encryptedValues) {
    if (row.deletedAt !== null || typeof row.data.assetId !== 'string') continue;
    if (!detachedAssetIds.has(row.data.assetId)) continue;
    const value = parseStrictEntity('customAssetValue', row) as EntityOf<'customAssetValue'>;
    if (value.deletedAt !== null) continue;
    const rows = encryptedValuesByAssetId.get(value.data.assetId) ?? [];
    rows.push(row);
    encryptedValuesByAssetId.set(value.data.assetId, rows);
  }

  const assets: VaultEntity[] = [];
  const values: VaultEntity[] = [];
  // Resolver ordering is not trusted. Stable id order keeps retries byte-stable.
  for (const assetId of assetIds) {
    const current = serverPresent.get(assetId);
    if (current) {
      assets.push(current.asset);
      values.push(...current.values);
      continue;
    }

    // The encrypted snapshot is authoritative only after the resolver has
    // explicitly confirmed that this identity was detached during move-in.
    const encrypted = encryptedById.get(assetId);
    if (!detachedAssetIds.has(assetId) || !encrypted) {
      throw manualSnapshotInvalid('The manual-asset classification is incomplete.');
    }
    assets.push(encrypted);
    values.push(...(encryptedValuesByAssetId.get(assetId) ?? []));
  }

  return { assets, values };
}

function parseManualAssetResolution(
  value: unknown,
  requestedIds: ReadonlySet<string>,
  userId: string,
): {
  serverPresent: Map<string, ParsedCurrentManualAssetSnapshot>;
  detachedAssetIds: Set<string>;
} {
  if (
    !hasExactKeys(value, ['serverPresent', 'detachedAssetIds']) ||
    !Array.isArray(value.serverPresent) ||
    !Array.isArray(value.detachedAssetIds)
  ) {
    throw manualSnapshotInvalid('The manual-asset resolver returned an invalid response shape.');
  }

  const serverPresent = new Map<string, ParsedCurrentManualAssetSnapshot>();
  const valueEntityIds = new Set<string>();
  const valueDates = new Set<string>();
  for (const rawSnapshot of value.serverPresent) {
    if (!hasExactKeys(rawSnapshot, ['asset', 'values']) || !Array.isArray(rawSnapshot.values)) {
      throw manualSnapshotInvalid('A current manual-asset snapshot has an invalid shape.');
    }

    const asset = parseManualSnapshotEntity('customAsset', rawSnapshot.asset);
    if (
      !requestedIds.has(asset.id) ||
      asset.deletedAt !== null ||
      asset.data.ownerId !== userId ||
      asset.data.providerId !== 'manual' ||
      asset.data.providerRef !== asset.id ||
      serverPresent.has(asset.id)
    ) {
      throw manualSnapshotInvalid(
        'A current manual-asset snapshot is unknown, duplicated, deleted, or has invalid identity.',
      );
    }

    const values: VaultEntity[] = [];
    for (const rawValue of rawSnapshot.values) {
      const currentValue = parseManualSnapshotEntity('customAssetValue', rawValue);
      const dateKey = `${asset.id}:${currentValue.data.date}`;
      if (
        currentValue.deletedAt !== null ||
        currentValue.data.assetId !== asset.id ||
        valueEntityIds.has(currentValue.id) ||
        valueDates.has(dateKey)
      ) {
        throw manualSnapshotInvalid(
          'A current manual-asset value is unrelated, duplicated, or deleted.',
        );
      }
      valueEntityIds.add(currentValue.id);
      valueDates.add(dateKey);
      values.push(withoutKind(currentValue));
    }
    values.sort(compareManualValueEntities);
    serverPresent.set(asset.id, { asset: withoutKind(asset), values });
  }

  const detachedAssetIds = new Set<string>();
  for (const assetId of value.detachedAssetIds) {
    if (
      typeof assetId !== 'string' ||
      !requestedIds.has(assetId) ||
      detachedAssetIds.has(assetId) ||
      serverPresent.has(assetId)
    ) {
      throw manualSnapshotInvalid(
        'A detached manual-asset id is unknown, duplicated, or overlaps a current snapshot.',
      );
    }
    detachedAssetIds.add(assetId);
  }

  for (const assetId of requestedIds) {
    if (!serverPresent.has(assetId) && !detachedAssetIds.has(assetId)) {
      throw manualSnapshotInvalid('The manual-asset resolver omitted a requested asset id.');
    }
  }
  return { serverPresent, detachedAssetIds };
}

function parseManualSnapshotEntity<Kind extends 'customAsset' | 'customAssetValue'>(
  kind: Kind,
  value: unknown,
): EntityOf<Kind> {
  if (!isRecord(value)) {
    throw manualSnapshotInvalid(`A current ${kind} snapshot is not an entity object.`);
  }
  const parsed = VAULT_ENTITY_SCHEMAS[kind].safeParse({ ...value, kind });
  if (!parsed.success) {
    throw manualSnapshotInvalid(`A current ${kind} snapshot does not match its exact contract.`);
  }
  return parsed.data as EntityOf<Kind>;
}

function withoutKind(entity: EntityOf<'customAsset' | 'customAssetValue'>): VaultEntity {
  const { kind: _kind, ...row } = entity;
  return row as VaultEntity;
}

function compareManualValueEntities(left: VaultEntity, right: VaultEntity): number {
  const leftDate = typeof left.data.date === 'string' ? left.data.date : '';
  const rightDate = typeof right.data.date === 'string' ? right.data.date : '';
  if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRestoreScope(
  document: VaultStrictDocumentV1,
  userId: string,
  portfolioId: string,
): void {
  assertPortfolioScope(document.entities, userId, portfolioId);

  const assetIds = referencedAssets(document.entities);
  const manualAssetIds = new Set<string>();
  for (const asset of liveRows(document.entities, 'customAsset')) {
    if (
      !assetIds.has(asset.id) ||
      asset.data.ownerId !== userId ||
      asset.data.providerId !== 'manual' ||
      asset.data.providerRef !== asset.id
    ) {
      throw scopeInvalid('A custom-asset restatement is unrelated or not owner-manual.');
    }
    manualAssetIds.add(asset.id);
  }
  for (const value of liveRows(document.entities, 'customAssetValue')) {
    if (!manualAssetIds.has(value.data.assetId)) {
      throw scopeInvalid('A custom value does not belong to a restated manual asset.');
    }
  }

  const tagIds = referencedCashTags(document.entities);
  for (const tag of liveRows(document.entities, 'cashTag')) {
    if (!tagIds.has(tag.id) || tag.data.userId !== userId) {
      throw scopeInvalid('A cash-tag snapshot is unrelated or belongs to another account.');
    }
  }
  if (liveRows(document.entities, 'cashTag').length !== tagIds.size) {
    throw scopeInvalid('The restore graph does not carry every referenced cash-tag snapshot.');
  }

  if (document.mirrorProvenance.some((entry) => entry.portfolioId !== portfolioId)) {
    throw scopeInvalid('Fork provenance belongs to another portfolio.');
  }
}

function assertDocumentSetIdentity(
  set: DecryptedPortfolioDocumentSet,
  portfolioId: string,
  borrowedKeyId: string,
): void {
  const envelopes = [set.header.envelope, set.common.envelope, set.portfolio.envelope];
  if (
    set.portfolioId !== portfolioId ||
    set.portfolio.document.portfolioId !== portfolioId ||
    envelopes.some(
      (envelope) => envelope.vaultId !== set.vaultId || envelope.keyId !== borrowedKeyId,
    )
  ) {
    throw documentSetChanged(
      'The restore source no longer matches the current vault, key, and portfolio identity.',
    );
  }
}

function assertDocumentSetCurrent(
  set: DecryptedPortfolioDocumentSet,
  dependencies: PortfolioVaultRestoreDocumentDependencies,
): void {
  if (dependencies.isDocumentSetCurrent(set)) return;
  throw documentSetChanged(
    'The synchronized vault document set changed while the restore document was authored.',
  );
}

function documentInvalid(message: string): PortfolioVaultRestoreDocumentError {
  return new PortfolioVaultRestoreDocumentError('VAULT_RESTORE_DOCUMENT_INVALID', message);
}

function scopeInvalid(message: string): PortfolioVaultRestoreDocumentError {
  return new PortfolioVaultRestoreDocumentError('VAULT_RESTORE_SCOPE_INVALID', message);
}

function manualSnapshotInvalid(message: string): PortfolioVaultRestoreDocumentError {
  return new PortfolioVaultRestoreDocumentError('VAULT_RESTORE_MANUAL_SNAPSHOT_INVALID', message);
}

function documentSetChanged(message: string): PortfolioVaultRestoreDocumentError {
  return new PortfolioVaultRestoreDocumentError('VAULT_RESTORE_DOCUMENT_SET_CHANGED', message);
}
