import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  VAULT_ENTITY_ROW_SCHEMAS,
  portfolioVaultImportBatchCaptureRowSchema,
  portfolioVaultImportRowCaptureRowSchema,
} from '@bettertrack/contracts';

import { importBatches, importRows, type ImportBatchRow, type ImportRowRow } from '../../schema';
import {
  importBatchCaptureData,
  importRowCaptureData,
} from '../portfolioVaultTransitionRepository';

/**
 * #1529 — the lossless import-capture read is a HAND-LISTED full-row
 * projection, exactly the trap `vault.ts` warns about: a column the assembler
 * forgets is dropped silently, and `.optional()` on the document schema cannot
 * tell "absent because old document" from "absent because the assembler
 * forgot". This suite pins the projection against BOTH ends — every persisted
 * column of the table and every field of the vault-document row contract — so
 * a new column or a renamed field fails here before it can be lost on a move.
 */

const AT = new Date('2026-08-21T10:00:00.000Z');

const BATCH: ImportBatchRow = {
  id: '019c8400-0000-7000-8000-000000000101',
  ownerId: '019c8400-0000-7000-8000-000000000102',
  portfolioId: '019c8400-0000-7000-8000-000000000103',
  brokerId: 'test-vector',
  filename: 'projection.csv',
  status: 'applied',
  cashSourceId: '019c8400-0000-7000-8000-000000000104',
  createdAt: AT,
  appliedAt: AT,
  understanding: {
    mappings: [
      { header: 'Datum', field: 'date', confidence: 0.99, reason: 'header', needsReview: false },
    ],
    unmappedHeaders: ['Notiz'],
    delimiter: ';',
    encoding: 'utf-8',
    dateLocale: 'de-AT',
    numberLocale: 'de-AT',
    dateLocaleAmbiguous: false,
  },
};

const ROW: ImportRowRow = {
  id: '019c8400-0000-7000-8000-000000000105',
  batchId: BATCH.id,
  rowIndex: 3,
  raw: '2026-08-20;SAP;buy;0,12345678;123,456789',
  kind: 'buy',
  flag: 'mapped',
  message: null,
  executedAt: AT,
  isin: 'DE0007164600',
  symbol: 'SAP',
  name: 'SAP SE',
  quantity: '0.12345678',
  price: '123.456789',
  fee: '0.000000',
  amountEur: null,
  currency: 'EUR',
  note: 'projection vector',
  assetId: '019c8400-0000-7000-8000-000000000106',
  contentHash: 'projection-content-hash',
  result: 'applied',
  resultMessage: null,
  candidates: [
    {
      id: '019c8400-0000-7000-8000-000000000107',
      symbol: 'SAP.DE',
      name: 'SAP SE',
      currency: 'EUR',
      exchange: 'XETRA',
      type: 'stock',
    },
  ],
  ruleTagIds: ['019c8400-0000-7000-8000-000000000108'],
  resolvedBy: 'user',
  kindUndecided: false,
};

describe('import-capture projection completeness (#1529)', () => {
  it('projects every persisted import_batches column except the id, and nothing else', () => {
    const data = importBatchCaptureData(BATCH);
    const columns = Object.keys(getTableColumns(importBatches)).filter((key) => key !== 'id');
    expect(Object.keys(data).sort()).toEqual([...columns].sort());
    expect(Object.keys(data).sort()).toEqual(
      Object.keys(VAULT_ENTITY_ROW_SCHEMAS.importBatch.shape).sort(),
    );
    // Exact, not degraded: the capture row parses through the strict server
    // contract AND the document contract without either touching a value.
    const strict = portfolioVaultImportBatchCaptureRowSchema.parse(data);
    expect(strict).toEqual(data);
    expect(VAULT_ENTITY_ROW_SCHEMAS.importBatch.parse(data)).toEqual(data);
    expect(data.createdAt).toBe(AT.toISOString());
    expect(data.appliedAt).toBe(AT.toISOString());
  });

  it('projects every persisted import_rows column except the id, with decimals as exact strings', () => {
    const data = importRowCaptureData(ROW);
    const columns = Object.keys(getTableColumns(importRows)).filter((key) => key !== 'id');
    expect(Object.keys(data).sort()).toEqual([...columns].sort());
    expect(Object.keys(data).sort()).toEqual(
      Object.keys(VAULT_ENTITY_ROW_SCHEMAS.importRow.shape).sort(),
    );
    const strict = portfolioVaultImportRowCaptureRowSchema.parse(data);
    expect(strict).toEqual(data);
    expect(VAULT_ENTITY_ROW_SCHEMAS.importRow.parse(data)).toEqual(data);
    expect(data).toMatchObject({
      quantity: '0.12345678',
      price: '123.456789',
      fee: '0.000000',
      amountEur: null,
      executedAt: AT.toISOString(),
      candidates: ROW.candidates,
      ruleTagIds: ROW.ruleTagIds,
      resolvedBy: 'user',
      kindUndecided: false,
    });
  });

  it('keeps nulls as nulls (never absent) so a restored row re-reads byte-identically', () => {
    const data = importRowCaptureData({
      ...ROW,
      candidates: null,
      ruleTagIds: null,
      resolvedBy: null,
      executedAt: null,
      quantity: null,
    });
    expect('candidates' in data && data.candidates === null).toBe(true);
    expect('ruleTagIds' in data && data.ruleTagIds === null).toBe(true);
    expect('resolvedBy' in data && data.resolvedBy === null).toBe(true);
    expect(data.executedAt).toBeNull();
    expect(data.quantity).toBeNull();
    const batch = importBatchCaptureData({ ...BATCH, understanding: null, appliedAt: null });
    expect('understanding' in batch && batch.understanding === null).toBe(true);
    expect(batch.appliedAt).toBeNull();
  });
});
