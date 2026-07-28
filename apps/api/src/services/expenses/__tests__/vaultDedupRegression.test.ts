import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { VAULT_DOCUMENT_V1_VERSION, vaultStrictDocumentV1Schema } from '@bettertrack/contracts';

import { expenseTransactions, paranoidVaults, users } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createParanoidRehydrationService } from '../../account/paranoidRehydrationService';
import { expenseDedupHash } from '../expenseImportService';

const CSV = [
  'Date,Payee,Account number,Transaction type,Payment reference,Amount (EUR),Amount (Foreign Currency),Type Foreign Currency,Exchange Rate',
  '2026-07-01,Original merchant,,MasterCard Payment,,-42.50,,,',
].join('\n');

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('strict vault expense dedup regression', () => {
  it('keeps H(original bank row) through edit and strict restore so re-import skips it', async () => {
    const user = await harness.seedUser();
    const originalBankRow = {
      bookedOn: '2026-07-01',
      direction: 'expense' as const,
      amount: 42.5,
      currency: 'EUR',
      description: 'Original merchant',
    };
    const originalHash = expenseDedupHash(originalBankRow);
    const importInput = { content: CSV, filename: 'n26.csv', bankId: 'n26' };

    const firstImport = await harness.ctx.expenseImports.apply(user.id, importInput);
    expect(firstImport).toMatchObject({ applied: 1, duplicate: 0, error: 0 });

    const [imported] = await harness.db
      .select()
      .from(expenseTransactions)
      .where(eq(expenseTransactions.userId, user.id));
    expect(imported?.dedupHash).toBe(originalHash);

    await harness.ctx.expenses.updateTransaction(user.id, imported!.id, {
      bookedOn: '2026-07-02',
      direction: 'income',
      amount: 45,
      description: 'User-edited description',
    });
    const [edited] = await harness.db
      .select()
      .from(expenseTransactions)
      .where(eq(expenseTransactions.id, imported!.id));
    expect(edited).toMatchObject({
      bookedOn: '2026-07-02',
      direction: 'income',
      amount: '45.00',
      description: 'User-edited description',
      dedupHash: originalHash,
    });
    expect(
      expenseDedupHash({
        bookedOn: edited!.bookedOn,
        direction: edited!.direction,
        amount: Number(edited!.amount),
        currency: edited!.currency,
        description: edited!.description,
      }),
    ).not.toBe(originalHash);

    const restoredDocument = vaultStrictDocumentV1Schema.parse(
      JSON.parse(
        JSON.stringify({
          schemaVersion: VAULT_DOCUMENT_V1_VERSION,
          entities: [
            {
              id: '018f0000-0000-7000-8000-000000000100',
              kind: 'portfolio',
              rev: 1,
              editedAt: edited!.updatedAt.toISOString(),
              editedBy: user.id,
              deletedAt: null,
              data: {
                userId: user.id,
                name: 'Main',
                visibility: 'private',
                sortOrder: 0,
                defaultPayFromCash: false,
                archivedAt: null,
              },
            },
            {
              id: edited!.id,
              kind: 'expenseTransaction',
              rev: 2,
              editedAt: edited!.updatedAt.toISOString(),
              editedBy: user.id,
              deletedAt: null,
              data: {
                userId: edited!.userId,
                categoryId: edited!.categoryId,
                direction: edited!.direction,
                amount: edited!.amount,
                currency: edited!.currency,
                bookedOn: edited!.bookedOn,
                description: edited!.description,
                source: edited!.source,
                dedupHash: edited!.dedupHash,
                createdAt: edited!.createdAt.toISOString(),
                updatedAt: edited!.updatedAt.toISOString(),
              },
            },
          ],
          mergeLog: [],
        }),
      ),
    );
    const restoredEntity = restoredDocument.entities.find(
      (entity) => entity.kind === 'expenseTransaction',
    );
    if (restoredEntity?.kind !== 'expenseTransaction') throw new Error('expense kind changed');
    expect(restoredEntity.data.dedupHash).toBe(originalHash);

    await harness.db
      .delete(expenseTransactions)
      .where(eq(expenseTransactions.id, restoredEntity.id));
    await harness.db
      .update(users)
      .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
      .where(eq(users.id, user.id));
    await harness.db.insert(paranoidVaults).values({
      userId: user.id,
      version: 1,
      formatVersion: 1,
      sizeBytes: 10,
      blob: Buffer.from('ciphertext'),
    });
    await createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
      rehydrationId: '018f0000-0000-7000-8000-000000000101',
      document: restoredDocument,
    });

    const reimportPreview = await harness.ctx.expenseImports.preview(user.id, importInput);
    expect(reimportPreview.counts).toEqual({ total: 1, new: 0, duplicate: 1, error: 0 });
    expect(reimportPreview.rows[0]?.flag).toBe('duplicate');

    const secondImport = await harness.ctx.expenseImports.apply(user.id, importInput);
    expect(secondImport).toMatchObject({ applied: 0, duplicate: 1, error: 0 });
    expect(secondImport.rows).toEqual([
      {
        rowIndex: 2,
        result: 'skipped_duplicate',
        message: 'An identical row already exists.',
      },
    ]);
    const rowsAfterReimport = await harness.db
      .select()
      .from(expenseTransactions)
      .where(eq(expenseTransactions.userId, user.id));
    expect(rowsAfterReimport).toHaveLength(1);
    expect(rowsAfterReimport[0]).toMatchObject({
      id: restoredEntity.id,
      description: 'User-edited description',
      dedupHash: originalHash,
    });
  });
});
