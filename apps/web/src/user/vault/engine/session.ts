import {
  STANDING_ORDER_AMOUNT_MAX,
  customTaxParamsSchema,
  taxSettingsResponseSchema,
  updateTaxSettingsRequestSchema,
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_DOCUMENT_VERSION,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_ROW_SCHEMAS,
  VAULT_ENTITY_SCHEMAS,
  vaultDocumentSchema,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';

import type { VaultSyncEngine, VaultSyncState } from '../sync';
import { dueStandingOrderOccurrence, isStandingOrderScheduleDay } from '../standingOrders/schedule';
import { moneyFailure } from './errors';
import type { ClientTaxReport } from './types';

export interface ValidatedVaultSnapshot {
  document: VaultDocument;
  /** Collision-free identity of every authenticated document in this snapshot. */
  snapshotId: string;
  vaultVersion: number;
  vaultKeyId: string;
  writeId: string;
  ownerUserId: string;
}

/**
 * Read-only snapshot seam used by the E6 split-document adapter. Legacy v1
 * sessions still enter through `VaultSyncEngine`; a per-vault document set can
 * now invoke the same engine without fabricating a legacy envelope or sync
 * writer around already-authenticated plaintext.
 */
export interface VaultMoneySnapshotSource {
  validatedSnapshot(): ValidatedVaultSnapshot;
  assertSnapshotCurrent(snapshot: ValidatedVaultSnapshot): void;
}

export type VaultMoneySnapshotAccess = VaultSyncEngine | VaultMoneySnapshotSource;

export interface VaultDocumentSession {
  document: VaultDocument;
  ownerUserId: string;
}

/**
 * Open one raw decrypted document through the exact validation path every
 * unlock takes: strict entity schemas, frozen tax facts, persisted tax
 * settings, and the full relationship graph. This is the client-side validator
 * of record — {@link validatedVaultSnapshot} delegates here, and the enable
 * flow proves a freshly built document against it BEFORE the first medium
 * write, while "your normal account is unchanged" is still true. A document
 * this function accepts is a document the unlock gate will accept; one it
 * rejects would have been `VAULT_CORRUPT` after the irreversible purge.
 */
export function openVaultSession(raw: unknown): VaultDocumentSession {
  return openVaultSessionWithOptions(raw, false);
}

function openVaultSessionWithOptions(
  raw: unknown,
  isolateStandingOrders: boolean,
): VaultDocumentSession {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'schemaVersion' in raw &&
    (raw as { schemaVersion: unknown }).schemaVersion !== VAULT_DOCUMENT_V1_VERSION &&
    (raw as { schemaVersion: unknown }).schemaVersion !== VAULT_DOCUMENT_VERSION
  ) {
    throw moneyFailure(
      'VAULT_UNSUPPORTED_VERSION',
      `Vault document version ${String((raw as { schemaVersion: unknown }).schemaVersion)} is not supported.`,
    );
  }
  const parsed = vaultDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw moneyFailure('VAULT_CORRUPT', 'The decrypted vault document is malformed.', {
      details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
    });
  }
  validateStrictEntities(parsed.data, isolateStandingOrders);
  validatePersistedTaxFacts(parsed.data);
  validatePersistedTaxSettings(parsed.data);
  const ownerUserId = validateRelationships(parsed.data, isolateStandingOrders);
  return { document: parsed.data, ownerUserId };
}

/** Obtain one authenticated, strict snapshot of the decrypted in-memory vault. */
export function validatedVaultSnapshot(engine: VaultSyncEngine): ValidatedVaultSnapshot {
  return validatedSnapshot(engine, false);
}

/** Resolve either the legacy sync-backed snapshot or E6's split-doc source. */
export function validatedMoneySnapshot(access: VaultMoneySnapshotAccess): ValidatedVaultSnapshot {
  return isSnapshotSource(access) ? access.validatedSnapshot() : validatedVaultSnapshot(access);
}

/**
 * Validate a scan candidate without letting one corrupt standing-order row hide
 * every later order. All document, non-order entity, and run-row structural
 * validation remains active; the materializer validates each order it can book
 * — active and due — together with that order's own run-to-schedule
 * reachability, in isolation. A paused or not-due order is left untouched until
 * it can book again; strict derivations keep reporting its corruption.
 */
export function validatedStandingOrderSnapshot(engine: VaultSyncEngine): ValidatedVaultSnapshot {
  return validatedSnapshot(engine, true);
}

/**
 * Re-read a scan snapshot only when the authenticated candidate actually moved.
 * Validating a whole document per order is measurable on app open — where most
 * orders are already booked and nothing else is writing — while a scan that
 * races an unrelated local write still continues against fresh rows.
 */
export function refreshedStandingOrderSnapshot(
  engine: VaultSyncEngine,
  snapshot: ValidatedVaultSnapshot,
): ValidatedVaultSnapshot {
  const state = engine.state;
  assertAuthoritativeSyncState(state, 'while the client operation was running');
  const active = state.active;
  if (
    active !== null &&
    snapshot.snapshotId === legacySnapshotId(active.header) &&
    active.header.vaultVersion === snapshot.vaultVersion &&
    active.header.keyId === snapshot.vaultKeyId &&
    active.header.writeId === snapshot.writeId
  ) {
    return snapshot;
  }
  return validatedStandingOrderSnapshot(engine);
}

function validatedSnapshot(
  engine: VaultSyncEngine,
  isolateStandingOrders: boolean,
): ValidatedVaultSnapshot {
  const state = engine.state;
  assertAuthoritativeSyncState(state, 'before money data is read');
  const candidate = state.active;
  if (candidate === null) {
    throw moneyFailure(
      'VAULT_DATA_UNAVAILABLE',
      'No authenticated decrypted vault document is active.',
      { retryable: true },
    );
  }
  if (
    candidate.header.schemaVersion !== VAULT_DOCUMENT_V1_VERSION &&
    candidate.header.schemaVersion !== VAULT_DOCUMENT_VERSION
  ) {
    throw moneyFailure(
      'VAULT_UNSUPPORTED_VERSION',
      `Vault envelope schema version ${candidate.header.schemaVersion} is not supported.`,
    );
  }
  const session = openVaultSessionWithOptions(candidate.document as unknown, isolateStandingOrders);
  if (session.document.schemaVersion !== candidate.header.schemaVersion) {
    throw moneyFailure(
      'VAULT_UNSUPPORTED_VERSION',
      'The vault document does not match its authenticated envelope schema version.',
    );
  }
  return {
    document: session.document,
    snapshotId: legacySnapshotId(candidate.header),
    vaultVersion: candidate.header.vaultVersion,
    vaultKeyId: candidate.header.keyId,
    writeId: candidate.header.writeId,
    ownerUserId: session.ownerUserId,
  };
}

/** Detect a lock, document replacement, or mutation that raced a long operation. */
export function assertVaultSnapshotCurrent(
  engine: VaultSyncEngine,
  snapshot: ValidatedVaultSnapshot,
): void {
  const state = engine.state;
  assertAuthoritativeSyncState(state, 'while the client operation was running');
  if (state.active === null) {
    throw moneyFailure(
      'VAULT_DATA_UNAVAILABLE',
      'The authenticated vault candidate disappeared during the client operation.',
      { retryable: true },
    );
  }
  if (
    snapshot.snapshotId !== legacySnapshotId(state.active.header) ||
    state.active.header.vaultVersion !== snapshot.vaultVersion ||
    state.active.header.keyId !== snapshot.vaultKeyId ||
    state.active.header.writeId !== snapshot.writeId
  ) {
    throw moneyFailure(
      'OPERATION_ABORTED',
      'The vault changed while the client operation was running.',
      { retryable: true },
    );
  }
}

/** Recheck the exact source used by {@link validatedMoneySnapshot}. */
export function assertMoneySnapshotCurrent(
  access: VaultMoneySnapshotAccess,
  snapshot: ValidatedVaultSnapshot,
): void {
  if (isSnapshotSource(access)) {
    access.assertSnapshotCurrent(snapshot);
    return;
  }
  assertVaultSnapshotCurrent(access, snapshot);
}

function isSnapshotSource(access: VaultMoneySnapshotAccess): access is VaultMoneySnapshotSource {
  return 'validatedSnapshot' in access;
}

/** Bind an in-memory report to the authenticated vault and selected portfolio. */
export function assertTaxReportScope(
  snapshot: ValidatedVaultSnapshot,
  portfolioId: string,
  tax: ClientTaxReport,
): void {
  const portfolioExists = liveEntities(snapshot.document, 'portfolio').some(
    (entity) => entity.id === portfolioId,
  );
  if (
    !portfolioExists ||
    tax.ownerUserId !== snapshot.ownerUserId ||
    tax.vaultKeyId !== snapshot.vaultKeyId ||
    tax.portfolioId !== portfolioId ||
    tax.snapshotId !== snapshot.snapshotId ||
    tax.vaultVersion !== snapshot.vaultVersion ||
    tax.writeId !== snapshot.writeId
  ) {
    throw moneyFailure(
      'OPERATION_ABORTED',
      'The tax report does not belong to the active vault and portfolio.',
      { retryable: true },
    );
  }
}

function legacySnapshotId(header: {
  vaultVersion: number;
  keyId: string;
  writeId: string;
}): string {
  return JSON.stringify(['vault-document-v1', header.vaultVersion, header.keyId, header.writeId]);
}

function assertAuthoritativeSyncState(state: VaultSyncState, phase: string): void {
  if (state.status === 'locked') {
    throw moneyFailure('VAULT_LOCKED', `The vault is locked ${phase}.`, { retryable: true });
  }
  if (state.status === 'corrupt') {
    throw moneyFailure('VAULT_CORRUPT', `The vault is corrupt ${phase}.`);
  }
  if (state.status === 'conflict' || state.status === 'unresolved') {
    throw moneyFailure(
      'VAULT_DATA_UNAVAILABLE',
      `The vault sync state is ${state.status} ${phase}; no authoritative money result is available.`,
      { retryable: true, details: { syncStatus: state.status } },
    );
  }
}

export function liveEntities(
  document: VaultDocument,
  kind: VaultEntityKind,
): readonly VaultEntity[] {
  return (document.entities[kind] ?? []).filter((entity) => entity.deletedAt === null);
}

export function requireLiveEntity(
  document: VaultDocument,
  kind: VaultEntityKind,
  id: string,
): VaultEntity {
  const entity = liveEntities(document, kind).find((candidate) => candidate.id === id);
  if (entity === undefined) {
    throw moneyFailure(
      kind === 'portfolio' ? 'PORTFOLIO_NOT_FOUND' : 'VAULT_CORRUPT',
      `${kind} ${id} is missing from the active vault.`,
    );
  }
  return entity;
}

/**
 * Build one document-scoped validator for the catch-up scanner. The asset
 * currencies and the run claims are indexed once per document so validating an
 * order stays O(1) in assets and in that order's own runs.
 */
export function createStandingOrderScanValidator(
  document: VaultDocument,
): (entity: VaultEntity) => void {
  const assets = liveEntities(document, 'customAsset');
  const assetCurrency = new Map(
    assets.map((asset) => [
      asset.id,
      VAULT_ENTITY_ROW_SCHEMAS.customAsset.parse(asset.data).currency,
    ]),
  );
  const runsByOrder = indexStandingOrderRuns(document);
  return (entity) => validateStandingOrderForScan(document, entity, assetCurrency, runsByOrder);
}

/** Validate one standing order independently for the catch-up scanner. */
function validateStandingOrderForScan(
  document: VaultDocument,
  entity: VaultEntity,
  assetCurrency: ReadonlyMap<string, string>,
  runsByOrder: StandingOrderRunIndex,
): void {
  const row = VAULT_ENTITY_ROW_SCHEMAS.standingOrder.parse(entity.data);
  const portfolio = liveEntities(document, 'portfolio').find(
    (candidate) => candidate.id === row.portfolioId,
  );
  if (portfolio === undefined || field(portfolio, 'userId') !== row.userId) {
    invalidReference('standingOrder', entity.id, 'portfolioId');
  }
  if (row.assetId !== null && !assetCurrency.has(row.assetId)) {
    throw moneyFailure(
      'VAULT_CORRUPT',
      `Vault standingOrder ${entity.id} references an unavailable asset.`,
    );
  }
  validatePersistedStandingOrder(entity, assetCurrency, runsByOrder);
  for (const run of runsByOrder.get(entity.id) ?? []) {
    if (!isPersistedStandingOrderOccurrence(entity, run.periodKey)) {
      invalidStandingOrder(
        entity.id,
        `run ${run.id} does not belong to a reachable schedule occurrence`,
      );
    }
  }
}

type StandingOrderRunIndex = ReadonlyMap<string, readonly { id: string; periodKey: string }[]>;

/** Group the live run claims by their standing order, parsing each row once. */
function indexStandingOrderRuns(document: VaultDocument): StandingOrderRunIndex {
  const index = new Map<string, { id: string; periodKey: string }[]>();
  for (const run of liveEntities(document, 'standingOrderRun')) {
    const row = VAULT_ENTITY_ROW_SCHEMAS.standingOrderRun.parse(run.data);
    const claims = index.get(row.standingOrderId);
    const claim = { id: run.id, periodKey: row.periodKey };
    if (claims === undefined) index.set(row.standingOrderId, [claim]);
    else claims.push(claim);
  }
  return index;
}

function validateStrictEntities(document: VaultDocument, isolateStandingOrders: boolean): void {
  const knownKinds = new Set<string>(VAULT_ENTITY_KINDS);
  for (const kind of Object.keys(document.entities)) {
    if (!knownKinds.has(kind)) {
      throw moneyFailure('VAULT_UNSUPPORTED_ENTITY', `Unsupported vault entity kind ${kind}.`);
    }
  }
  for (const kind of VAULT_ENTITY_KINDS) {
    const ids = new Set<string>();
    for (const entity of document.entities[kind] ?? []) {
      if (ids.has(entity.id)) {
        throw moneyFailure('VAULT_CORRUPT', `Vault entity ${kind}/${entity.id} is duplicated.`);
      }
      ids.add(entity.id);
      if (isolateStandingOrders && kind === 'standingOrder') continue;
      const schema = VAULT_ENTITY_SCHEMAS[kind];
      const result = schema.safeParse({ ...entity, kind });
      if (!result.success) {
        throw moneyFailure('VAULT_CORRUPT', `Vault entity ${kind}/${entity.id} is malformed.`, {
          details: { issues: result.error.issues.map((issue) => issue.path.join('.')) },
        });
      }
    }
  }
}

function validatePersistedTaxFacts(document: VaultDocument): void {
  for (const entity of document.entities.transaction ?? []) {
    const row = VAULT_ENTITY_ROW_SCHEMAS.transaction.parse(entity.data);
    if (
      row.side === 'buy' &&
      (row.taxMode !== null ||
        row.taxCountry !== null ||
        row.taxAmountEur !== null ||
        row.taxParams !== null)
    ) {
      invalidTaxFacts('transaction', entity.id, 'buy transactions cannot carry frozen tax facts');
    }
    validateFrozenTaxShape(
      'transaction',
      entity.id,
      row.taxMode,
      row.taxCountry,
      row.taxAmountEur,
      row.taxParams,
    );
  }

  for (const entity of document.entities.dividend ?? []) {
    const row = VAULT_ENTITY_ROW_SCHEMAS.dividend.parse(entity.data);
    validateFrozenTaxShape(
      'dividend',
      entity.id,
      row.taxMode,
      row.taxCountry,
      row.taxAmountEur,
      row.taxParams,
    );
  }
}

function validateFrozenTaxShape(
  kind: 'transaction' | 'dividend',
  id: string,
  mode: 'none' | 'manual_per_trade' | 'country_specific' | 'custom' | null,
  country: 'AT' | 'DE' | 'FI' | null,
  amountEur: string | null,
  params: unknown,
): void {
  const shapeIsValid =
    mode === null
      ? country === null && params === null
      : mode === 'country_specific'
        ? country !== null && params === null
        : mode === 'custom'
          ? country === null && customTaxParamsSchema.safeParse(params).success
          : country === null && params === null;
  if (!shapeIsValid) {
    invalidTaxFacts(kind, id, 'frozen tax mode, country, and parameters are inconsistent');
  }
  if (mode === 'country_specific' && !isClientSupportedTaxCountry(country)) {
    unsupportedTaxCountry(kind, id, country);
  }
  if (mode === 'none' && amountEur !== null && !isZeroDecimal(amountEur)) {
    invalidTaxFacts(kind, id, 'none-mode rows cannot carry a frozen tax amount');
  }
  if (
    mode === 'manual_per_trade' &&
    amountEur !== null &&
    amountEur.startsWith('-') &&
    !isZeroDecimal(amountEur)
  ) {
    invalidTaxFacts(kind, id, 'manual tax amounts cannot be negative');
  }
}

function isZeroDecimal(value: string): boolean {
  return /^-?0(?:\.0+)?$/.test(value);
}

function invalidTaxFacts(kind: 'transaction' | 'dividend', id: string, reason: string): never {
  throw moneyFailure('VAULT_CORRUPT', `Vault ${kind} ${id} is unreachable: ${reason}.`);
}

function unsupportedTaxCountry(
  kind: 'transaction' | 'dividend' | 'taxSetting' | 'portfolioSetting',
  id: string,
  country: unknown,
): never {
  throw moneyFailure(
    'TAX_MODE_UNSUPPORTED',
    `Vault ${kind} ${id} uses tax country ${String(country)}, which the paranoid client engine does not support.`,
  );
}

function isClientSupportedTaxCountry(country: unknown): country is 'AT' | 'DE' {
  return country === 'AT' || country === 'DE';
}

function validatePersistedTaxSettings(document: VaultDocument): void {
  for (const entity of liveEntities(document, 'taxSetting')) {
    const row = VAULT_ENTITY_ROW_SCHEMAS.taxSetting.parse(entity.data);
    const amount =
      row.manualDefaultAmountEur === null
        ? null
        : persistedTaxDecimal(
            row.manualDefaultAmountEur,
            20,
            6,
            'taxSetting',
            entity.id,
            'manual default amount',
          );
    const rate =
      row.manualDefaultRatePct === null
        ? null
        : persistedTaxDecimal(
            row.manualDefaultRatePct,
            9,
            6,
            'taxSetting',
            entity.id,
            'manual default rate',
          );
    if (amount !== null && amount < 0n) {
      invalidTaxSetting('taxSetting', entity.id, 'the manual default amount is negative');
    }
    if (rate !== null && (rate < 0n || rate > 100n * 10n ** 6n)) {
      invalidTaxSetting('taxSetting', entity.id, 'the manual default rate is outside 0..100');
    }

    const countryPresent = row.country !== null;
    const customPresent = row.customParams !== null;
    const manualDefaultPresent = amount !== null || rate !== null;
    if (
      (row.mode === 'country_specific') !== countryPresent ||
      (row.mode === 'custom') !== customPresent ||
      (row.mode !== 'manual_per_trade' && manualDefaultPresent) ||
      (amount !== null && rate !== null) ||
      (row.mode === 'custom' && !customTaxParamsSchema.safeParse(row.customParams).success)
    ) {
      invalidTaxSetting(
        'taxSetting',
        entity.id,
        'mode, country, custom parameters, and manual defaults are inconsistent',
      );
    }
    if (row.mode === 'country_specific' && !isClientSupportedTaxCountry(row.country)) {
      unsupportedTaxCountry('taxSetting', entity.id, row.country);
    }
  }

  for (const entity of liveEntities(document, 'portfolioSetting')) {
    const row = VAULT_ENTITY_ROW_SCHEMAS.portfolioSetting.parse(entity.data);
    if (row.key === 'tax') {
      const stored = taxSettingsResponseSchema.safeParse(row.value);
      if (!stored.success || !validPortfolioTaxOverride(row.value)) {
        invalidTaxSetting('portfolioSetting', entity.id, 'the stored tax override is malformed');
      }
      if (
        stored.data.mode === 'country_specific' &&
        !isClientSupportedTaxCountry(stored.data.country)
      ) {
        unsupportedTaxCountry('portfolioSetting', entity.id, stored.data.country);
      }
    }
  }
}

/** Portfolio tax overrides are stored in response shape but obey request invariants. */
function validPortfolioTaxOverride(value: unknown): boolean {
  const stored = taxSettingsResponseSchema.safeParse(value);
  if (!stored.success) return false;
  const normalized = {
    mode: stored.data.mode,
    ...(stored.data.country === null ? {} : { country: stored.data.country }),
    ...(stored.data.custom === undefined ? {} : { custom: stored.data.custom }),
    ...(stored.data.manualDefaultAmountEur === undefined
      ? {}
      : { manualDefaultAmountEur: stored.data.manualDefaultAmountEur }),
    ...(stored.data.manualDefaultRatePct === undefined
      ? {}
      : { manualDefaultRatePct: stored.data.manualDefaultRatePct }),
  };
  return updateTaxSettingsRequestSchema.safeParse(normalized).success;
}

function persistedTaxDecimal(
  value: string,
  precision: number,
  scale: number,
  kind: 'taxSetting' | 'portfolioSetting',
  id: string,
  label: string,
): bigint {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (match === null) {
    invalidTaxSetting(kind, id, `${label} is not a decimal`);
  }
  const fraction = match[3] ?? '';
  const integerDigits = match[2]!.replace(/^0+/, '');
  if (fraction.length > scale || integerDigits.length > precision - scale) {
    invalidTaxSetting(kind, id, `${label} exceeds its persisted numeric bounds`);
  }
  const magnitude = BigInt(`${match[2]}${fraction}`) * 10n ** BigInt(scale - fraction.length);
  return match[1] === '-' ? -magnitude : magnitude;
}

function invalidTaxSetting(
  kind: 'taxSetting' | 'portfolioSetting',
  id: string,
  reason: string,
): never {
  throw moneyFailure('VAULT_CORRUPT', `Vault ${kind} ${id} is unreachable: ${reason}.`);
}

function validateRelationships(document: VaultDocument, isolateStandingOrders: boolean): string {
  const portfolios = liveEntities(document, 'portfolio');
  const owners = new Set(portfolios.map((portfolio) => field(portfolio, 'userId')));
  if (owners.size !== 1) {
    throw moneyFailure(
      'VAULT_INVALID_OWNERSHIP',
      'A decrypted vault must contain portfolios for exactly one owner.',
    );
  }
  const ownerUserId = [...owners][0];
  if (ownerUserId === undefined) {
    throw moneyFailure('VAULT_INVALID_OWNERSHIP', 'The decrypted vault has no portfolio owner.');
  }
  const portfolioIds = new Set(portfolios.map((portfolio) => portfolio.id));
  const assets = liveEntities(document, 'customAsset');
  const assetIds = new Set(assets.map((asset) => asset.id));
  const assetCurrency = new Map(
    assets.map((asset) => [
      asset.id,
      VAULT_ENTITY_ROW_SCHEMAS.customAsset.parse(asset.data).currency,
    ]),
  );
  for (const asset of assets) {
    const assetOwner = nullableField(asset, 'ownerId');
    if (assetOwner !== null && assetOwner !== ownerUserId) {
      invalidReference('customAsset', asset.id, 'ownerId');
    }
  }
  const sourcePortfolio = new Map(
    liveEntities(document, 'cashSource').map((source) => [source.id, field(source, 'portfolioId')]),
  );
  const transactionPortfolio = new Map(
    liveEntities(document, 'transaction').map((transaction) => [
      transaction.id,
      field(transaction, 'portfolioId'),
    ]),
  );
  const dividendPortfolio = new Map(
    liveEntities(document, 'dividend').map((dividend) => [
      dividend.id,
      field(dividend, 'portfolioId'),
    ]),
  );

  const portfolioScopedKinds = [
    'transaction',
    'dividend',
    'cashSource',
    'cashMovement',
    'portfolioSetting',
    'standingOrder',
    'importBatch',
    'portfolioDailySnapshot',
    'portfolioSnapshotState',
  ] as const;
  for (const kind of portfolioScopedKinds) {
    if (isolateStandingOrders && kind === 'standingOrder') continue;
    for (const entity of liveEntities(document, kind)) {
      const portfolioId = field(entity, 'portfolioId');
      if (!portfolioIds.has(portfolioId)) invalidReference(kind, entity.id, 'portfolioId');
    }
  }
  const portfolioSettingKeys = new Set<string>();
  for (const setting of liveEntities(document, 'portfolioSetting')) {
    const key = `${field(setting, 'portfolioId')}\u0000${field(setting, 'key')}`;
    if (portfolioSettingKeys.has(key)) {
      throw moneyFailure('VAULT_CORRUPT', `Vault contains duplicate portfolio setting ${key}.`);
    }
    portfolioSettingKeys.add(key);
  }
  for (const transaction of liveEntities(document, 'transaction')) {
    if (!assetIds.has(field(transaction, 'assetId'))) {
      invalidReference('transaction', transaction.id, 'assetId');
    }
  }
  for (const dividend of liveEntities(document, 'dividend')) {
    if (!assetIds.has(field(dividend, 'assetId'))) {
      invalidReference('dividend', dividend.id, 'assetId');
    }
    const portfolioId = field(dividend, 'portfolioId');
    if (sourcePortfolio.get(field(dividend, 'cashSourceId')) !== portfolioId) {
      invalidReference('dividend', dividend.id, 'cashSourceId');
    }
  }
  for (const movement of liveEntities(document, 'cashMovement')) {
    const portfolioId = field(movement, 'portfolioId');
    if (sourcePortfolio.get(field(movement, 'sourceId')) !== portfolioId) {
      invalidReference('cashMovement', movement.id, 'sourceId');
    }
    const transactionId = nullableField(movement, 'transactionId');
    if (transactionId !== null && transactionPortfolio.get(transactionId) !== portfolioId) {
      invalidReference('cashMovement', movement.id, 'transactionId');
    }
    const counterpartSourceId = nullableField(movement, 'counterpartSourceId');
    if (counterpartSourceId !== null && sourcePortfolio.get(counterpartSourceId) !== portfolioId) {
      invalidReference('cashMovement', movement.id, 'counterpartSourceId');
    }
    const dividendId = nullableField(movement, 'dividendId');
    if (dividendId !== null && dividendPortfolio.get(dividendId) !== portfolioId) {
      invalidReference('cashMovement', movement.id, 'dividendId');
    }
  }
  const valueKeys = new Set<string>();
  for (const value of liveEntities(document, 'customAssetValue')) {
    if (!assetIds.has(field(value, 'assetId'))) {
      invalidReference('customAssetValue', value.id, 'assetId');
    }
    const key = `${field(value, 'assetId')}\u0000${field(value, 'date')}`;
    if (valueKeys.has(key)) {
      throw moneyFailure('VAULT_CORRUPT', `Vault contains duplicate custom-asset value ${key}.`);
    }
    valueKeys.add(key);
  }
  if (!isolateStandingOrders) {
    const runsByOrder = indexStandingOrderRuns(document);
    for (const order of liveEntities(document, 'standingOrder')) {
      if (field(order, 'userId') !== ownerUserId) {
        invalidReference('standingOrder', order.id, 'userId');
      }
      const assetId = nullableField(order, 'assetId');
      if (assetId !== null && !assetIds.has(assetId)) {
        invalidReference('standingOrder', order.id, 'assetId');
      }
      validatePersistedStandingOrder(order, assetCurrency, runsByOrder);
    }
  }
  /*
   * Runs are historical claims. Their order may legally be tombstoned while
   * the runs stay live (a portfolio-delete cascade racing a booking on another
   * device), so the reference resolves against live AND tombstoned orders.
   */
  const anyOrderById = new Map(
    (document.entities.standingOrder ?? []).map((order) => [order.id, order] as const),
  );
  const runKeys = new Set<string>();
  for (const run of liveEntities(document, 'standingOrderRun')) {
    const standingOrderId = field(run, 'standingOrderId');
    const order = anyOrderById.get(standingOrderId);
    if (order === undefined) {
      invalidReference('standingOrderRun', run.id, 'standingOrderId');
    }
    const periodKey = field(run, 'periodKey');
    const key = `${standingOrderId}\u0000${periodKey}`;
    if (runKeys.has(key)) {
      throw moneyFailure('VAULT_CORRUPT', `Vault contains duplicate standing-order run ${key}.`);
    }
    runKeys.add(key);
    if (!isolateStandingOrders && !isPersistedStandingOrderOccurrence(order, periodKey)) {
      invalidStandingOrder(
        order.id,
        `run ${run.id} does not belong to a reachable schedule occurrence`,
      );
    }
  }
  const taxSettings = liveEntities(document, 'taxSetting');
  if (taxSettings.length > 1) {
    throw moneyFailure('VAULT_CORRUPT', 'A vault may contain at most one tax setting.');
  }
  for (const taxSetting of taxSettings) {
    if (field(taxSetting, 'userId') !== ownerUserId) {
      invalidReference('taxSetting', taxSetting.id, 'userId');
    }
  }
  const importOwner = new Map<string, string>();
  for (const batch of liveEntities(document, 'importBatch')) {
    if (field(batch, 'ownerId') !== ownerUserId) {
      invalidReference('importBatch', batch.id, 'ownerId');
    }
    importOwner.set(batch.id, field(batch, 'ownerId'));
  }
  for (const row of liveEntities(document, 'importRow')) {
    if (importOwner.get(field(row, 'batchId')) !== ownerUserId) {
      invalidReference('importRow', row.id, 'batchId');
    }
  }
  const categoryOwner = new Map<string, string>();
  for (const category of liveEntities(document, 'expenseCategory')) {
    if (field(category, 'userId') !== ownerUserId) {
      invalidReference('expenseCategory', category.id, 'userId');
    }
    categoryOwner.set(category.id, ownerUserId);
  }
  for (const transaction of liveEntities(document, 'expenseTransaction')) {
    if (field(transaction, 'userId') !== ownerUserId) {
      invalidReference('expenseTransaction', transaction.id, 'userId');
    }
    const categoryId = nullableField(transaction, 'categoryId');
    if (categoryId !== null && categoryOwner.get(categoryId) !== ownerUserId) {
      invalidReference('expenseTransaction', transaction.id, 'categoryId');
    }
  }
  for (const kind of ['expenseRule', 'expenseBudget'] as const) {
    for (const entity of liveEntities(document, kind)) {
      if (field(entity, 'userId') !== ownerUserId) {
        invalidReference(kind, entity.id, 'userId');
      }
      if (categoryOwner.get(field(entity, 'categoryId')) !== ownerUserId) {
        invalidReference(kind, entity.id, 'categoryId');
      }
    }
  }
  const budgetIds = new Set(liveEntities(document, 'expenseBudget').map((entity) => entity.id));
  for (const fire of liveEntities(document, 'expenseBudgetFire')) {
    if (!budgetIds.has(field(fire, 'budgetId'))) {
      invalidReference('expenseBudgetFire', fire.id, 'budgetId');
    }
  }
  return ownerUserId;
}

function validatePersistedStandingOrder(
  entity: VaultEntity,
  assetCurrency: ReadonlyMap<string, string>,
  runsByOrder: StandingOrderRunIndex,
): void {
  const row = VAULT_ENTITY_ROW_SCHEMAS.standingOrder.parse(entity.data);
  const isBuy = row.kind === 'buy-asset';
  if (isBuy !== (row.assetId !== null)) {
    invalidStandingOrder(entity.id, 'an asset is required exactly for an asset buy');
  }
  if (isBuy) {
    if (assetCurrency.get(row.assetId!) !== row.currency) {
      invalidStandingOrder(entity.id, 'the buy currency does not match its asset');
    }
  } else if (row.currency !== 'EUR') {
    invalidStandingOrder(entity.id, 'cash orders must use EUR');
  }

  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > STANDING_ORDER_AMOUNT_MAX) {
    invalidStandingOrder(entity.id, 'the amount is outside the persisted positive bounds');
  }
  if (
    (row.cadence === 'daily' && row.anchorDay !== null) ||
    (row.cadence === 'monthly' &&
      (row.anchorDay === null || row.anchorDay < 1 || row.anchorDay > 31))
  ) {
    invalidStandingOrder(entity.id, 'cadence and anchor day are inconsistent');
  }

  try {
    dueStandingOrderOccurrence(row, row.startDate);
  } catch (cause) {
    throw moneyFailure(
      'VAULT_CORRUPT',
      `Vault standingOrder ${entity.id} has an unreachable schedule.`,
      { cause },
    );
  }

  if ((row.lastRunAt === null) !== (row.lastPeriodKey === null)) {
    invalidStandingOrder(entity.id, 'the run watermark is incomplete');
  }
  if (row.lastPeriodKey !== null) {
    if (!isPersistedStandingOrderOccurrence(entity, row.lastPeriodKey)) {
      invalidStandingOrder(entity.id, 'the run watermark is outside its schedule');
    }
    const matchingRun = (runsByOrder.get(entity.id) ?? []).some(
      (run) => run.periodKey === row.lastPeriodKey,
    );
    if (!matchingRun) {
      invalidStandingOrder(entity.id, 'the run watermark has no durable period claim');
    }
  }
}

/**
 * Historical run/watermark period keys validate against the cadence, anchor,
 * and start-date lattice only: the server allows shrinking `endDate` below an
 * already-booked period, so persisted history past the current endDate is a
 * reachable state, not corruption. New bookings stay strictly endDate-clamped
 * in the portfolio store's due assertion.
 */
function isPersistedStandingOrderOccurrence(entity: VaultEntity, periodKey: string): boolean {
  const row = VAULT_ENTITY_ROW_SCHEMAS.standingOrder.parse(entity.data);
  try {
    return isStandingOrderScheduleDay(row, periodKey);
  } catch {
    return false;
  }
}

function invalidStandingOrder(id: string, reason: string): never {
  throw moneyFailure('VAULT_CORRUPT', `Vault standingOrder ${id} is unreachable: ${reason}.`);
}

function field(entity: VaultEntity, key: string): string {
  const value = entity.data[key];
  if (typeof value !== 'string') {
    throw moneyFailure('VAULT_CORRUPT', `${entity.id}.${key} must be a string.`);
  }
  return value;
}

function nullableField(entity: VaultEntity, key: string): string | null {
  const value = entity.data[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw moneyFailure('VAULT_CORRUPT', `${entity.id}.${key} must be a string or null.`);
  }
  return value;
}

function invalidReference(kind: VaultEntityKind, id: string, key: string): never {
  throw moneyFailure(
    'VAULT_INVALID_OWNERSHIP',
    `Vault entity ${kind}/${id} has an invalid ${key} relationship.`,
  );
}
