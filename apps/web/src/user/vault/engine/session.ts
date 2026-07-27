import {
  customTaxParamsSchema,
  VAULT_DOCUMENT_VERSION,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_ROW_SCHEMAS,
  VAULT_ENTITY_SCHEMAS,
  vaultDocumentV1Schema,
  type VaultDocumentV1,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';

import type { VaultSyncEngine, VaultSyncState } from '../sync';
import { moneyFailure } from './errors';
import type { ClientTaxReport } from './types';

export interface ValidatedVaultSnapshot {
  document: VaultDocumentV1;
  vaultVersion: number;
  vaultKeyId: string;
  writeId: string;
  ownerUserId: string;
}

/** Obtain one authenticated, strict snapshot of the decrypted in-memory vault. */
export function validatedVaultSnapshot(engine: VaultSyncEngine): ValidatedVaultSnapshot {
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
  if (candidate.header.schemaVersion !== VAULT_DOCUMENT_VERSION) {
    throw moneyFailure(
      'VAULT_UNSUPPORTED_VERSION',
      `Vault envelope schema version ${candidate.header.schemaVersion} is not supported.`,
    );
  }
  const raw = candidate.document as unknown;
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'schemaVersion' in raw &&
    (raw as { schemaVersion: unknown }).schemaVersion !== VAULT_DOCUMENT_VERSION
  ) {
    throw moneyFailure(
      'VAULT_UNSUPPORTED_VERSION',
      `Vault document version ${String((raw as { schemaVersion: unknown }).schemaVersion)} is not supported.`,
    );
  }
  const parsed = vaultDocumentV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw moneyFailure('VAULT_CORRUPT', 'The decrypted vault document is malformed.', {
      details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
    });
  }
  validateStrictEntities(parsed.data);
  validatePersistedTaxFacts(parsed.data);
  const ownerUserId = validateRelationships(parsed.data);
  return {
    document: parsed.data,
    vaultVersion: candidate.header.vaultVersion,
    vaultKeyId: candidate.header.keyId,
    writeId: candidate.header.writeId,
    ownerUserId,
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
  document: VaultDocumentV1,
  kind: VaultEntityKind,
): readonly VaultEntity[] {
  return (document.entities[kind] ?? []).filter((entity) => entity.deletedAt === null);
}

export function requireLiveEntity(
  document: VaultDocumentV1,
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

function validateStrictEntities(document: VaultDocumentV1): void {
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

function validatePersistedTaxFacts(document: VaultDocumentV1): void {
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
  if (mode === 'none' && amountEur !== null && !isZeroDecimal(amountEur)) {
    invalidTaxFacts(kind, id, 'none-mode rows cannot carry a frozen tax amount');
  }
}

function isZeroDecimal(value: string): boolean {
  return /^-?0(?:\.0+)?$/.test(value);
}

function invalidTaxFacts(kind: 'transaction' | 'dividend', id: string, reason: string): never {
  throw moneyFailure('VAULT_CORRUPT', `Vault ${kind} ${id} is unreachable: ${reason}.`);
}

function validateRelationships(document: VaultDocumentV1): string {
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
  const orderPortfolio = new Map(
    liveEntities(document, 'standingOrder').map((order) => [order.id, field(order, 'portfolioId')]),
  );

  for (const kind of [
    'transaction',
    'dividend',
    'cashSource',
    'cashMovement',
    'portfolioSetting',
    'standingOrder',
    'importBatch',
    'portfolioDailySnapshot',
    'portfolioSnapshotState',
  ] as const) {
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
  for (const order of liveEntities(document, 'standingOrder')) {
    if (field(order, 'userId') !== ownerUserId) {
      invalidReference('standingOrder', order.id, 'userId');
    }
    const assetId = nullableField(order, 'assetId');
    if (assetId !== null && !assetIds.has(assetId)) {
      invalidReference('standingOrder', order.id, 'assetId');
    }
  }
  const runKeys = new Set<string>();
  for (const run of liveEntities(document, 'standingOrderRun')) {
    if (!orderPortfolio.has(field(run, 'standingOrderId'))) {
      invalidReference('standingOrderRun', run.id, 'standingOrderId');
    }
    const key = `${field(run, 'standingOrderId')}\u0000${field(run, 'periodKey')}`;
    if (runKeys.has(key)) {
      throw moneyFailure('VAULT_CORRUPT', `Vault contains duplicate standing-order run ${key}.`);
    }
    runKeys.add(key);
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
