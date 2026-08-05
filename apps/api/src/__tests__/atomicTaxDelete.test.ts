import postgres from 'postgres';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createCashMovementRepository } from '../data/repositories/cashMovementRepository';
import { createCashSourceRepository } from '../data/repositories/cashSourceRepository';
import { createTaxRepository } from '../data/repositories/taxRepository';
import { createTransactionRepository } from '../data/repositories/transactionRepository';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DELETE_PAUSE_LOCK = [1096, 1] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function seedLedgerFixture(symbol: string) {
  const user = await harness.seedUser({
    email: `${symbol.toLowerCase()}@example.com`,
    username: symbol.toLowerCase(),
  });
  const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
  const [asset] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `${symbol} Test AG`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!asset) throw new Error('Failed to seed atomic-delete asset');
  const source = await createCashSourceRepository(harness.db).getOrCreateMain(portfolioId);
  return { user, portfolioId, asset, source };
}

const invalidCorrection = (sourceId: string) => ({
  sourceId,
  kind: 'tax_withholding' as const,
  // Positive withholding deliberately violates the cash-movement sign CHECK.
  // The INSERT therefore fails after the parent DELETE has executed.
  amountEur: 1,
  executedAt: new Date('2025-12-31T12:00:00.000Z'),
  note: 'Injected correction failure',
  taxYear: 2025,
});

const validCorrection = (sourceId: string, note: string) => ({
  sourceId,
  kind: 'tax_refund' as const,
  amountEur: 1,
  executedAt: new Date('2025-12-31T12:00:00.000Z'),
  note,
  taxYear: 2025,
});

describe('atomic parent delete + tax correction', () => {
  it('rolls a transaction delete back when the following correction insert fails', async () => {
    const { user, portfolioId, asset, source } = await seedLedgerFixture('ATOMIC-TX');
    const transactions = createTransactionRepository(harness.db);
    const movements = createCashMovementRepository(harness.db);
    const [transaction] = await transactions.insertMany(portfolioId, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 100,
        fee: 0,
        executedAt: new Date('2025-01-10T12:00:00.000Z'),
        note: null,
      },
    ]);
    if (!transaction) throw new Error('Failed to seed atomic-delete transaction');

    await expect(
      transactions.deleteForUserWithCorrections(user.id, portfolioId, transaction.id, [
        invalidCorrection(source.id),
      ]),
    ).rejects.toThrow();

    expect(await transactions.findByIdForUser(user.id, transaction.id)).toMatchObject({
      id: transaction.id,
      portfolioId,
    });
    expect(await movements.listForPortfolio(portfolioId)).toHaveLength(0);
  });

  it('rolls a dividend delete and its cascades back when the correction insert fails', async () => {
    const { portfolioId, asset, source } = await seedLedgerFixture('ATOMIC-DIV');
    const taxes = createTaxRepository(harness.db);
    const movements = createCashMovementRepository(harness.db);
    const executedAt = new Date('2025-04-01T12:00:00.000Z');
    const created = await taxes.insertDividend(
      portfolioId,
      {
        assetId: asset.id,
        cashSourceId: source.id,
        grossAmountEur: 100,
        executedAt,
        note: null,
        taxMode: 'none',
        taxCountry: null,
        taxAmountEur: null,
      },
      [
        {
          sourceId: source.id,
          kind: 'dividend',
          amountEur: 100,
          executedAt,
          note: null,
          linkDividend: true,
        },
      ],
    );

    await expect(
      taxes.deleteForPortfolioWithCorrections(portfolioId, created.dividend.id, [
        invalidCorrection(source.id),
      ]),
    ).rejects.toThrow();

    expect(await taxes.findByIdForPortfolio(portfolioId, created.dividend.id)).toMatchObject({
      id: created.dividend.id,
      portfolioId,
    });
    expect(await movements.listForPortfolio(portfolioId)).toEqual([
      expect.objectContaining({
        dividendId: created.dividend.id,
        kind: 'dividend',
        amountEur: 100,
      }),
    ]);
  });
});

interface DatabaseLockWait {
  pid: number;
  query: string;
  waitEvent: string | null;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForDatabaseLock(
  observer: ReturnType<typeof postgres>,
  predicate: (row: DatabaseLockWait) => boolean,
  description: string,
): Promise<DatabaseLockWait> {
  const deadline = Date.now() + 5_000;
  let observed: DatabaseLockWait[] = [];
  while (Date.now() < deadline) {
    observed = await observer<DatabaseLockWait[]>`
      SELECT pid, query, wait_event AS "waitEvent"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    const match = observed.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${description}; observed ${JSON.stringify(
      observed.map(({ pid, query, waitEvent }) => ({ pid, query, waitEvent })),
    )}`,
  );
}

/**
 * PGlite has one connection, so this runs in the real-Postgres CI slice. A
 * trigger pauses DELETE after the mutation has taken its portfolio advisory
 * lock. A guarded cash write and the reconciler must then wait on that same
 * lock rather than forming a reverse-order cycle; releasing the trigger lets
 * all three operations complete.
 */
it.skipIf(!REAL_DATABASE_URL)(
  'serializes a transaction delete, guarded cash write and tax reconciliation without deadlock',
  async () => {
    const { user, portfolioId, asset, source } = await seedLedgerFixture('ATOMIC-LOCK');
    const transactions = createTransactionRepository(harness.db);
    const movements = createCashMovementRepository(harness.db);
    const [transaction] = await transactions.insertMany(portfolioId, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 100,
        fee: 0,
        executedAt: new Date('2025-01-10T12:00:00.000Z'),
        note: null,
      },
    ]);
    if (!transaction) throw new Error('Failed to seed lock-order transaction');

    const controller = postgres(REAL_DATABASE_URL!, { max: 1 });
    const observer = postgres(REAL_DATABASE_URL!, { max: 1 });
    const guardedClient = postgres(REAL_DATABASE_URL!, { max: 1 });
    const guardedMovements = createCashMovementRepository(
      drizzlePostgres(guardedClient, { schema }),
    );
    const lockReady = deferred();
    const releaseLock = deferred();
    let deletion: Promise<boolean> | undefined;
    let cashWrite: Promise<unknown> | undefined;
    let reconciliation: Promise<unknown[]> | undefined;

    await observer.unsafe(`
      CREATE OR REPLACE FUNCTION bt_test_pause_atomic_transaction_delete()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${DELETE_PAUSE_LOCK[0]}, ${DELETE_PAUSE_LOCK[1]});
        RETURN OLD;
      END;
      $$
    `);
    await observer.unsafe(
      'DROP TRIGGER IF EXISTS bt_test_pause_atomic_transaction_delete ON transactions',
    );
    await observer.unsafe(`
      CREATE TRIGGER bt_test_pause_atomic_transaction_delete
      BEFORE DELETE ON transactions
      FOR EACH ROW
      EXECUTE FUNCTION bt_test_pause_atomic_transaction_delete()
    `);

    const lockOwner = controller.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${DELETE_PAUSE_LOCK[0]}, ${DELETE_PAUSE_LOCK[1]})`;
      lockReady.resolve();
      await releaseLock.promise;
    });

    try {
      await Promise.race([
        lockReady.promise,
        lockOwner.then(() => {
          throw new Error('Delete-pause lock owner exited before acquiring the lock');
        }),
      ]);

      deletion = transactions.deleteForUserWithCorrections(user.id, portfolioId, transaction.id, [
        validCorrection(source.id, 'Delete correction'),
      ]);
      const deleteWait = await waitForDatabaseLock(
        observer,
        (row) =>
          row.waitEvent === 'advisory' && /delete\s+from\s+"?transactions"?/iu.test(row.query),
        'the transaction delete to pause inside its trigger',
      );

      cashWrite = guardedMovements.insertWithCashLedgerLock(
        portfolioId,
        validCorrection(source.id, 'Guarded cash write'),
        () => undefined,
      );
      const cashWriteWait = await waitForDatabaseLock(
        observer,
        (row) =>
          row.pid !== deleteWait.pid &&
          row.waitEvent === 'advisory' &&
          /pg_advisory_xact_lock/iu.test(row.query),
        'the guarded cash write to wait behind the transaction delete',
      );

      reconciliation = movements.insertReconciled(portfolioId, () => [
        validCorrection(source.id, 'Reconciled correction'),
      ]);
      const reconcileWait = await waitForDatabaseLock(
        observer,
        (row) =>
          row.pid !== deleteWait.pid &&
          row.pid !== cashWriteWait.pid &&
          row.waitEvent === 'advisory' &&
          /pg_advisory_xact_lock/iu.test(row.query),
        'tax reconciliation to wait behind the delete portfolio lock',
      );
      expect(reconcileWait.pid).not.toBe(deleteWait.pid);

      releaseLock.resolve();
      await lockOwner;
      const [deleted, written, reconciled] = await Promise.all([
        deletion,
        cashWrite,
        reconciliation,
      ]);
      expect(deleted).toBe(true);
      expect(written).toBeTruthy();
      expect(reconciled).toHaveLength(1);
      expect(await transactions.findByIdForUser(user.id, transaction.id)).toBeNull();
      expect(await movements.listForPortfolio(portfolioId)).toHaveLength(3);
    } finally {
      releaseLock.resolve();
      await lockOwner.catch(() => {});
      await deletion?.catch(() => {});
      await cashWrite?.catch(() => {});
      await reconciliation?.catch(() => {});
      await observer.unsafe(
        'DROP TRIGGER IF EXISTS bt_test_pause_atomic_transaction_delete ON transactions',
      );
      await observer.unsafe('DROP FUNCTION IF EXISTS bt_test_pause_atomic_transaction_delete()');
      await controller.end();
      await observer.end();
      await guardedClient.end();
    }
  },
  15_000,
);
