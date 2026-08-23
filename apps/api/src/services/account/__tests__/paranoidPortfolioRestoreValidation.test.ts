import type { VaultMirrorProvenance, VaultStrictDocumentV1 } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { Database } from '../../../data/db';
import { validateParanoidRestoreDocument } from '../paranoidRehydrationService';

const USER_ID = '018f6a3e-0000-7000-8000-00000000aaaa';
const PORTFOLIO_ID = '018f6a3e-1111-7000-8000-000000000001';
const OTHER_PORTFOLIO_ID = '018f6a3e-1111-7000-8000-000000000002';
const DEVICE_ID = '018f6a3e-2222-7000-8000-000000000001';
const CASH_SOURCE_ID = '018f6a3e-3333-7000-8000-000000000001';
const MOVEMENT_ID = '018f6a3e-4444-7000-8000-000000000001';
const IMPORT_BATCH_ID = '018f6a3e-5555-7000-8000-000000000001';
const IMPORT_ROW_ID = '018f6a3e-6666-7000-8000-000000000001';
const EDITED_AT = '2026-08-20T12:00:00.000Z';

type Entity = VaultStrictDocumentV1['entities'][number];

function entity<K extends Entity['kind']>(
  id: string,
  kind: K,
  data: Extract<Entity, { kind: K }>['data'],
): Extract<Entity, { kind: K }> {
  return {
    id,
    kind,
    rev: 0,
    editedAt: EDITED_AT,
    editedBy: DEVICE_ID,
    deletedAt: null,
    data,
  } as Extract<Entity, { kind: K }>;
}

function portfolio(id = PORTFOLIO_ID): Extract<Entity, { kind: 'portfolio' }> {
  return entity(id, 'portfolio', {
    userId: USER_ID,
    name: 'TEST VECTOR portfolio',
    visibility: 'private',
    sortOrder: 0,
    defaultPayFromCash: false,
    archivedAt: null,
    kind: null,
    vaultId: null,
    alias: null,
    vaultAlias: null,
  });
}

function cashSource(): Extract<Entity, { kind: 'cashSource' }> {
  return entity(CASH_SOURCE_ID, 'cashSource', {
    portfolioId: PORTFOLIO_ID,
    name: 'Main',
    type: 'cash',
    isMain: true,
    archivedAt: null,
    createdAt: EDITED_AT,
  });
}

function importBatch(portfolioId = PORTFOLIO_ID): Extract<Entity, { kind: 'importBatch' }> {
  return entity(IMPORT_BATCH_ID, 'importBatch', {
    ownerId: USER_ID,
    portfolioId,
    brokerId: 'test-broker',
    filename: 'TEST-VECTOR.csv',
    status: 'applied',
    cashSourceId: null,
    createdAt: EDITED_AT,
    appliedAt: EDITED_AT,
  });
}

function importRow(batchId = IMPORT_BATCH_ID): Extract<Entity, { kind: 'importRow' }> {
  return entity(IMPORT_ROW_ID, 'importRow', {
    batchId,
    rowIndex: 1,
    raw: '2026-08-20,BUY,TEST',
    kind: 'buy',
    flag: 'mapped',
    message: null,
    executedAt: EDITED_AT,
    isin: null,
    symbol: 'TEST',
    name: 'Test asset',
    quantity: '1.00000000',
    price: '1.000000',
    fee: '0.000000',
    amountEur: null,
    currency: 'EUR',
    note: null,
    assetId: null,
    contentHash: 'test-vector-content-hash',
    result: 'applied',
    resultMessage: null,
  });
}

function document(
  entities: VaultStrictDocumentV1['entities'],
  mirrorProvenance: VaultMirrorProvenance[] = [],
): VaultStrictDocumentV1 {
  return { schemaVersion: 1, entities, mergeLog: [], mirrorProvenance };
}

/**
 * Empty provenance returns before its repository read. This proxy makes every
 * focused case prove that validation rejects (or succeeds) before DB access,
 * and therefore before any restore writer can run.
 */
const NO_DATABASE_ACCESS = new Proxy({} as Database, {
  get() {
    throw new Error('portfolio restore validation unexpectedly accessed the database');
  },
});

async function validate(restoreDocument: VaultStrictDocumentV1, portfolioId = PORTFOLIO_ID) {
  return validateParanoidRestoreDocument({
    db: NO_DATABASE_ACCESS,
    userId: USER_ID,
    portfolioId,
    document: restoreDocument,
  });
}

describe('E4 per-portfolio strict restore validation', () => {
  it('accepts exactly one same-UUID anchor and returns typed live import rows', async () => {
    const validated = await validate(document([portfolio(), importBatch(), importRow()]));

    expect(validated.entities.map((row) => [row.kind, row.id])).toEqual([
      ['portfolio', PORTFOLIO_ID],
      ['importBatch', IMPORT_BATCH_ID],
      ['importRow', IMPORT_ROW_ID],
    ]);
  });

  it('rejects a cross-portfolio import batch before any DB access or write', async () => {
    await expect(
      validate(document([portfolio(), importBatch(OTHER_PORTFOLIO_ID), importRow()])),
    ).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      message: expect.stringContaining('belongs to another portfolio'),
    });
  });

  it('rejects an import row without a target-portfolio batch', async () => {
    await expect(
      validate(document([portfolio(), importRow('018f6a3e-5555-7000-8000-000000000099')])),
    ).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      message: expect.stringContaining('has no owning target-portfolio batch'),
    });
  });

  it('rejects an option-B insolvent cash ledger before any DB access or write', async () => {
    const withdrawal = entity(MOVEMENT_ID, 'cashMovement', {
      portfolioId: PORTFOLIO_ID,
      sourceId: CASH_SOURCE_ID,
      kind: 'withdrawal',
      amountEur: '-1.000000',
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      executedAt: EDITED_AT,
      note: null,
      source: 'manual',
      dedupHash: null,
      originalCurrency: null,
      createdAt: EDITED_AT,
    });

    await expect(validate(document([portfolio(), cashSource(), withdrawal]))).rejects.toMatchObject(
      {
        code: 'INVALID_CASH_LEDGER',
        message: expect.stringContaining(`cashMovement[${MOVEMENT_ID}]`),
      },
    );
  });

  it('rejects cross-portfolio fork provenance before any DB access or write', async () => {
    const provenance: VaultMirrorProvenance = {
      chainId: '018f6a3e-7777-7000-8000-000000000001',
      membershipId: '018f6a3e-7777-7000-8000-000000000002',
      kind: 'transaction',
      mirrorId: '018f6a3e-7777-7000-8000-000000000003',
      portfolioId: OTHER_PORTFOLIO_ID,
      localId: '018f6a3e-7777-7000-8000-000000000004',
    };

    await expect(validate(document([portfolio()], [provenance]))).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      message: expect.stringContaining('mirrorProvenance[transaction:'),
    });
  });

  it('rejects derived rows and unrelated account-common rows', async () => {
    const snapshot = entity('018f6a3e-8888-7000-8000-000000000001', 'portfolioDailySnapshot', {
      portfolioId: PORTFOLIO_ID,
      date: '2026-08-20',
      valueEur: '1.000000',
      costBasisEur: '1.000000',
      plEur: '0.000000',
      flowEur: '0.000000',
      cashBySource: {},
      assetValues: {},
      computedAt: EDITED_AT,
    });
    const taxSetting = entity('018f6a3e-8888-7000-8000-000000000002', 'taxSetting', {
      userId: USER_ID,
      mode: 'none',
      country: null,
      manualDefaultAmountEur: null,
      manualDefaultRatePct: null,
      customParams: null,
      updatedAt: EDITED_AT,
    });

    await expect(validate(document([portfolio(), snapshot]))).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      message: expect.stringContaining('must not carry derived portfolioDailySnapshot rows'),
    });
    await expect(validate(document([portfolio(), taxSetting]))).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      message: expect.stringContaining('must not carry account-common taxSetting rows'),
    });

    await expect(
      validate(document([portfolio(), { ...taxSetting, deletedAt: EDITED_AT }])),
    ).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
      message: expect.stringContaining('must not carry account-common taxSetting rows'),
    });
  });
});
