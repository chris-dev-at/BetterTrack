import { readFileSync } from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cashMovementsResponseSchema,
  expenseBudgetListResponseSchema,
  expenseTransactionListResponseSchema,
  portfolioListResponseSchema,
  vaultStrictDocumentV1Schema,
} from '@bettertrack/contracts';

import {
  expenseBudgets,
  expenseCategories,
  expenseTransactions,
  paranoidVaults,
  portfolioCashMovements,
  portfolioCashSources,
  portfolios,
  userTaxSettings,
  users,
} from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createParanoidRehydrationService } from '../../account/paranoidRehydrationService';
import { expenseDedupHash } from '../expenseImportService';

/**
 * The server half of the paranoid capture round trip (issue #1858).
 *
 * Enable hard-deletes the cleartext of every `vault`-classified table and
 * disable restores it from the client document ALONE, so a field the capture
 * fails to carry is destroyed irreversibly. `dedupHash` was such a field: the
 * capture stamped a literal `null` over the bank importer's only idempotency
 * key, and after a round trip the same statement booked every row a second time
 * (NULLs never collide in `UNIQUE(user, dedup_hash)`).
 *
 * The old version of this file could not see that, because it hand-wrote the
 * restore document with the correct hash in it. It now consumes
 * `apps/web/src/user/vault/ui/paranoidCaptureRoundTrip.fixture.json`, whose
 * `document` is produced by the SHIPPED capture — `migration.test.ts`
 * regenerates it from the same file's `reads` and fails if it differs — so what
 * runs through the restore below is the browser's real output, not this test's
 * idea of it. `reads` is seeded into a real database first and asserted against
 * the shipped endpoints, which closes the loop: server read → real capture →
 * real restore → server read.
 */

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../../web/src/user/vault/ui/paranoidCaptureRoundTrip.fixture.json',
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  capture: { userId: string; deviceId: string; now: string };
  reads: Record<string, unknown>;
  document: unknown;
};

/** The fixture's reads, proved to be well-formed DTOs before anything uses them. */
const reads = {
  portfolios: portfolioListResponseSchema.parse(fixture.reads.portfolios),
  cash: cashMovementsResponseSchema.parse(fixture.reads.cash),
  expenseTransactions: expenseTransactionListResponseSchema.parse(
    fixture.reads.expenseTransactions,
  ),
  expenseBudgets: expenseBudgetListResponseSchema.parse(fixture.reads.expenseBudgets),
  expenseCategories: (
    fixture.reads.expenseCategories as {
      categories: {
        id: string;
        name: string;
        direction: 'expense' | 'income';
        color: string;
        createdAt: string;
        updatedAt: string;
      }[];
    }
  ).categories,
};

/** The statement the account already imported, byte-for-byte re-offered later. */
const CSV = [
  'Date,Payee,Account number,Transaction type,Payment reference,Amount (EUR),Amount (Foreign Currency),Type Foreign Currency,Exchange Rate',
  '2026-07-01,Original merchant,,MasterCard Payment,,-42.50,,,',
].join('\n');
const IMPORT_INPUT = { content: CSV, filename: 'n26.csv', bankId: 'n26' };
const ORIGINAL_BANK_ROW = {
  bookedOn: '2026-07-01',
  direction: 'expense' as const,
  amount: 42.5,
  currency: 'EUR',
  description: 'Original merchant',
};

const REHYDRATION_ID = '018f0000-0000-7000-8000-000000000101';
/** Fixed clock: the budgets list evaluates "the current period". */
const NOW = new Date('2026-07-15T12:00:00.000Z');

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ budgetNow: () => NOW });
});

/** Write the fixture's account into the database exactly as its reads describe it. */
async function seedFixtureAccount(userId: string): Promise<void> {
  const portfolio = reads.portfolios.portfolios[0]!;
  await harness.db.insert(portfolios).values({
    id: portfolio.id,
    userId,
    name: portfolio.name,
    visibility: portfolio.visibility,
    sortOrder: portfolio.sortOrder,
    defaultPayFromCash: portfolio.defaultPayFromCash,
    archivedAt: null,
  });
  for (const source of reads.cash.sources) {
    await harness.db.insert(portfolioCashSources).values({
      id: source.id,
      portfolioId: portfolio.id,
      name: source.name,
      type: source.type,
      isMain: source.isMain,
      archivedAt: null,
      createdAt: new Date(source.createdAt),
    });
  }
  for (const movement of reads.cash.movements) {
    await harness.db.insert(portfolioCashMovements).values({
      id: movement.id,
      portfolioId: portfolio.id,
      sourceId: movement.sourceId,
      kind: movement.kind,
      amountEur: String(movement.amountEur),
      executedAt: new Date(movement.executedAt),
      note: movement.note,
      source: movement.source,
      dedupHash: movement.dedupHash ?? null,
      createdAt: new Date(movement.createdAt),
    });
  }
  for (const category of reads.expenseCategories) {
    await harness.db.insert(expenseCategories).values({
      id: category.id,
      userId,
      name: category.name,
      direction: category.direction,
      color: category.color,
      createdAt: new Date(category.createdAt),
      updatedAt: new Date(category.updatedAt),
    });
  }
  for (const transaction of reads.expenseTransactions.transactions) {
    await harness.db.insert(expenseTransactions).values({
      id: transaction.id,
      userId,
      categoryId: transaction.categoryId,
      direction: transaction.direction,
      amount: String(transaction.amount),
      currency: transaction.currency,
      bookedOn: transaction.bookedOn,
      description: transaction.description,
      source: transaction.source,
      dedupHash: transaction.dedupHash ?? null,
      createdAt: new Date(transaction.createdAt),
      updatedAt: new Date(transaction.updatedAt),
    });
  }
  for (const budget of reads.expenseBudgets.budgets) {
    await harness.db.insert(expenseBudgets).values({
      id: budget.id,
      userId,
      categoryId: budget.categoryId,
      amount: String(budget.amount),
      currency: budget.currency,
      createdAt: new Date(budget.createdAt),
      updatedAt: new Date(budget.updatedAt),
    });
  }
}

/**
 * What enable does to these tables: the cleartext is GONE, and the encrypted
 * document is the only copy left. Everything restored below therefore comes from
 * the capture, with no server row to quietly fill a gap.
 */
async function purgeAsEnableWould(userId: string, portfolioId: string): Promise<void> {
  await harness.db.delete(expenseBudgets).where(eq(expenseBudgets.userId, userId));
  await harness.db.delete(expenseTransactions).where(eq(expenseTransactions.userId, userId));
  await harness.db.delete(expenseCategories).where(eq(expenseCategories.userId, userId));
  await harness.db
    .delete(portfolioCashMovements)
    .where(eq(portfolioCashMovements.portfolioId, portfolioId));
  await harness.db
    .delete(portfolioCashSources)
    .where(eq(portfolioCashSources.portfolioId, portfolioId));
  await harness.db.delete(portfolios).where(eq(portfolios.userId, userId));
  await harness.db.delete(userTaxSettings).where(eq(userTaxSettings.userId, userId));
  await harness.db
    .update(users)
    .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
    .where(eq(users.id, userId));
  await harness.db.insert(paranoidVaults).values({
    userId,
    version: 1,
    formatVersion: 1,
    sizeBytes: 10,
    blob: Buffer.from('ciphertext'),
  });
}

/** The shipped capture's document, bound to the account under test. */
function restoreDocumentFor(userId: string) {
  return vaultStrictDocumentV1Schema.parse(
    // Only the account id is rebound — every field of every entity is the
    // capture's own output, including the two this issue is about.
    JSON.parse(JSON.stringify(fixture.document).replaceAll(fixture.capture.userId, userId)),
  );
}

describe('paranoid round trip through the shipped capture', () => {
  it('restores the bank-import dedup key, so re-importing the same statement books nothing', async () => {
    const user = await harness.seedUser();
    const portfolioId = reads.portfolios.portfolios[0]!.id;
    const importedRow = reads.expenseTransactions.transactions[0]!;
    const importHash = expenseDedupHash(ORIGINAL_BANK_ROW);

    // The fixture's key is the real importer's key for the statement row — and
    // NOT a hash of the row as it now reads, because the user edited its text
    // afterwards. That is the whole point of storing it: content cannot rebuild it.
    expect(importedRow.dedupHash).toBe(importHash);
    expect(
      expenseDedupHash({
        bookedOn: importedRow.bookedOn,
        direction: importedRow.direction,
        amount: importedRow.amount,
        currency: importedRow.currency,
        description: importedRow.description,
      }),
    ).not.toBe(importHash);

    await seedFixtureAccount(user.id);
    // The account before enable, through the endpoints the capture drains.
    expect(await harness.ctx.portfolio.getCashMovements(user.id, portfolioId)).toEqual(reads.cash);
    expect(await harness.ctx.expenses.listTransactions(user.id, {})).toEqual(
      reads.expenseTransactions,
    );
    expect(await harness.ctx.expenseBudgets.listBudgets(user.id)).toEqual(reads.expenseBudgets);

    await purgeAsEnableWould(user.id, portfolioId);
    await createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
      rehydrationId: REHYDRATION_ID,
      document: restoreDocumentFor(user.id),
    });

    // The key came back out of the vault. This single assertion is what the old
    // hand-written document could not make honestly.
    const [restored] = await harness.db
      .select()
      .from(expenseTransactions)
      .where(eq(expenseTransactions.userId, user.id));
    expect(restored?.dedupHash).toBe(importHash);

    // The statement is offered again. With the key intact it is recognised; with
    // the key nulled by the round trip it would book a second copy of every row.
    const preview = await harness.ctx.expenseImports.preview(user.id, IMPORT_INPUT);
    expect(preview.counts).toEqual({ total: 1, new: 0, duplicate: 1, error: 0 });
    expect(preview.rows[0]?.flag).toBe('duplicate');

    const secondImport = await harness.ctx.expenseImports.apply(user.id, IMPORT_INPUT);
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
      id: importedRow.id,
      description: importedRow.description,
      dedupHash: importHash,
    });

    // …and every OTHER captured field of the three vault-classified kinds came
    // back unchanged too, so the next field to go missing fails here.
    expect(await harness.ctx.portfolio.getCashMovements(user.id, portfolioId)).toEqual(reads.cash);
    expect(await harness.ctx.expenses.listTransactions(user.id, {})).toEqual(
      reads.expenseTransactions,
    );
    expect(await harness.ctx.expenseBudgets.listBudgets(user.id)).toEqual(reads.expenseBudgets);
  });

  it('keeps the budgets in age order, which their ids alone would reverse', async () => {
    const user = await harness.seedUser();
    const portfolioId = reads.portfolios.portfolios[0]!.id;
    const [older, newer] = reads.expenseBudgets.budgets;
    // The fixture is built so age order and id order disagree: a round trip that
    // stamps one migration instant on both rows falls back to the id order, and
    // the list silently reverses.
    expect(older!.createdAt < newer!.createdAt).toBe(true);
    expect(older!.id > newer!.id).toBe(true);

    await seedFixtureAccount(user.id);
    const before = await harness.ctx.expenseBudgets.listBudgets(user.id);

    await purgeAsEnableWould(user.id, portfolioId);
    await createParanoidRehydrationService({ db: harness.db }).rehydrate(user.id, {
      rehydrationId: REHYDRATION_ID,
      document: restoreDocumentFor(user.id),
    });

    const after = await harness.ctx.expenseBudgets.listBudgets(user.id);
    expect(after.budgets.map((budget) => budget.id)).toEqual(
      before.budgets.map((budget) => budget.id),
    );
    expect(after.budgets.map((budget) => [budget.createdAt, budget.updatedAt])).toEqual(
      before.budgets.map((budget) => [budget.createdAt, budget.updatedAt]),
    );
    expect(after.budgets.map((budget) => budget.createdAt)).not.toContain(
      fixture.capture.now, // the instant the capture ran, which used to be stamped here
    );
  });
});
