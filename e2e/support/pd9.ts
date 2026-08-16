import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The root e2e context has no direct drizzle dependency; resolve the API
// package's own pinned copy, just as this harness resolves its production
// repositories through `apps/api` below.
import { and, count, eq, inArray, sql } from '../../apps/api/node_modules/drizzle-orm/index.js';

import { VAULT_RETIRED_SERVER_MIN_RETENTION_MS } from '../../packages/contracts/src/vault';
import { createDatabase } from '../../apps/api/src/data/db';
import { withLockedPrivacyModes } from '../../apps/api/src/data/repositories/paranoidEnforcementRepository';
import { createAlertRepository } from '../../apps/api/src/data/repositories/alertRepository';
import {
  createExpenseBudgetRepository,
  createExpenseCategoryRepository,
  createExpenseTransactionRepository,
} from '../../apps/api/src/data/repositories/expenseRepository';
import { createImportRepository } from '../../apps/api/src/data/repositories/importRepository';
import { createNotificationRepository } from '../../apps/api/src/data/repositories/notificationRepository';
import { createUserRepository } from '../../apps/api/src/data/repositories/userRepository';
import * as schema from '../../apps/api/src/data/schema';
import type { Logger } from '../../apps/api/src/logger';
import { createRedis } from '../../apps/api/src/redis';
import { createParanoidModeGuard } from '../../apps/api/src/services/account/paranoidEnforcement';
import {
  alertFireLockKey,
  alertFireWindowStart,
  runAlertsEvaluation,
} from '../../apps/api/src/services/alerts/alertEvaluator';
import { createExpenseBudgetService } from '../../apps/api/src/services/expenses/budgetService';
import { PARANOID_VAULT_TABLE_NAMES } from '../../apps/api/src/services/export/manifest';
import { createNotificationCenter } from '../../apps/api/src/services/notifications/notificationCenter';
import {
  createNotificationDispatcher,
  type DispatchableEvent,
} from '../../apps/api/src/services/notifications/notificationDispatcher';
import { PARANOID_PROBE_HANDLER_NAMES } from '../../apps/api/src/data/repositories/paranoidTransitionRepository';
import { createStubMarketData } from '../../apps/api/src/testing/marketDataStubs';

import { DATABASE_URL, REDIS_URL } from './config';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

/**
 * How long {@link Pd9Harness.fireAlert} waits for the fire to CONVERGE — the
 * alert row persisted `triggered` and its inbox row written. The scheduled
 * `alerts.evaluate` worker writes the same row, and it emits through the
 * durable dispatch queue, so the delivery half can land a moment after the
 * status flip. Any single read is a race; the budget is what bounds it.
 */
const PD9_ALERT_CONVERGENCE_TIMEOUT_MS = 45_000;

/** Gap between convergence polls; each poll also re-runs the focused evaluation. */
const PD9_ALERT_POLL_INTERVAL_MS = 1_000;

export const PD9_TRACEABILITY = [
  {
    criterion: 'Design note §16-logged + owner-acked BEFORE code',
    assertion: '[PD9-A1] binding design precondition',
  },
  {
    criterion: 'Mode on ⇒ server stores no cleartext portfolio data (schema/probe test)',
    assertion: '[PD9-A2] complete DB cleartext probe',
  },
  {
    criterion:
      'Drive-only round trip: zero portfolio rows server-side and the app remains fully functional (e2e)',
    assertion: '[PD9-A3] Drive-only enable and zero active server medium round trip',
  },
  {
    criterion: 'Media switching migrates the blob correctly (test)',
    assertion: '[PD9-A4] verified media ordering and retained-source failure',
  },
  {
    criterion: 'Social/sharing surfaces are absent for the account (matrix test)',
    assertion: '[PD9-A5] killed/kept browser route matrix',
  },
  {
    criterion: 'A client computes correct stats from encrypted fixture data (test)',
    assertion: '[PD9-A6] known custom-asset totals without portfolio API reads',
  },
  {
    criterion: 'Alerts still fire (test)',
    assertion: '[PD9-A7] real evaluator and notification dispatcher',
  },
] as const;

/**
 * Repository precondition for composing/running PD9. The binding note and the
 * project decision log must agree on the current affirmative owner approval
 * and #896's retired-recovery semantics before the destructive browser flow
 * starts. A §15 row without an executable assertion also fails the gate.
 */
export async function assertPd9DesignPrecondition(): Promise<void> {
  const [document, projectPlan] = await Promise.all([
    readFile(join(process.cwd(), 'docs/paranoid-design.md'), 'utf8'),
    readFile(join(process.cwd(), 'PROJECTPLAN.md'), 'utf8'),
  ]);
  const normalized = (value: string) => value.replace(/\s+/g, ' ');
  const status = normalized(document.slice(0, document.indexOf('**The model in one paragraph.**')));
  const approvalEvidence = [
    '§16-logged 2026-07-21 (issue #651)',
    'owner-approved before composition',
    '`v5-p13-pd9-20260724` brief on issue #733',
    '#654 gate is explicitly superseded and is not approval evidence',
  ];
  if (approvalEvidence.some((evidence) => !status.includes(evidence))) {
    throw new Error('PD9 design status is missing its current affirmative owner-approval record.');
  }
  if (
    status.includes('implementation is **not even composed** until') ||
    status.includes('ack gate is a filed `awaiting-owner` issue')
  ) {
    throw new Error('PD9 design status still relies on the superseded pending-ack gate.');
  }

  const sectionFive = normalized(
    document.slice(document.indexOf('## 5.'), document.indexOf('## 6.')),
  );
  const retirementSemantics = [
    'active server medium',
    'retired recovery set',
    'seven-day minimum retention window',
    'fresh Drive readback',
    'client-held Ed25519 proof',
    'a media PATCH or client attestation alone never does',
    'Total server ciphertext reaches zero only through the separate retention-qualified signed purge gate',
  ];
  if (
    VAULT_RETIRED_SERVER_MIN_RETENTION_MS !== 7 * 24 * 60 * 60 * 1000 ||
    retirementSemantics.some((evidence) => !sectionFive.includes(evidence)) ||
    sectionFive.includes('hard-deletes the blob + its entire bounded history server-side')
  ) {
    throw new Error(
      'PD9 design §5 does not encode the approved #896 retirement and purge semantics.',
    );
  }

  const decisionLog = normalized(projectPlan.slice(projectPlan.indexOf('## 16. Decision Log')));
  const loggedDecision = [
    'V5-P13 PD6/PD9 media-removal COD reconciliation',
    'issue #895 / PR #896',
    'owner audit on #733',
    'seven-day minimum retention',
    'zero active server-medium ciphertext',
    'A successful signed purge leaves zero server ciphertext',
  ];
  if (loggedDecision.some((evidence) => !decisionLog.includes(evidence))) {
    throw new Error('PD9 design §5 reconciliation is missing from PROJECTPLAN §16.');
  }

  const sectionFifteen = document.slice(document.indexOf('## 15.'), document.indexOf('## 16.'));
  const documented = sectionFifteen
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| §13.5') && !line.startsWith('| -'),
    )
    .map((line) => line.split('|')[1]!.trim());
  const mapped = PD9_TRACEABILITY.map((row) => row.criterion);
  if (
    documented.length !== mapped.length ||
    documented.some((criterion, index) => criterion !== mapped[index])
  ) {
    throw new Error('PD9 traceability no longer maps every design §15 criterion in order.');
  }
}

export interface Pd9CleartextScope {
  userId: string;
  portfolioIds: string[];
  customAssetIds: string[];
  standingOrderIds: string[];
  importBatchIds: string[];
  expenseBudgetIds: string[];
  cashMovementIds: string[];
  cashBudgetIds: string[];
  cashRuleIds: string[];
}

export type Pd9CleartextProbe = Record<string, number>;

export interface Pd9PurgeOnlyFixture {
  importBatchId: string;
  importRowId: string;
  portfolioId: string;
  snapshotDate: string;
  budgetId: string;
  periodKey: string;
}

export interface Pd9VaultStorageProbe {
  active: { rows: number; bytes: number };
  history: { rows: number; bytes: number };
  candidates: { rows: number; bytes: number };
  retired: { rows: number; bytes: number };
  retirements: number;
}

/**
 * The converged outcome of one kept-alert proof. `status` + `notifications` are
 * the invariant §15 asks for; the remaining counters are diagnostics that ride
 * along into the spec's assertion message when convergence times out.
 */
export interface Pd9AlertFireResult {
  /** Alerts seen across every focused evaluation this call ran. */
  evaluated: number;
  /** Fires this harness itself performed (0 when the scheduled worker won). */
  fired: number;
  /** Focused evaluations run before the observation below. */
  attempts: number;
  /** Milliseconds spent converging. */
  elapsedMs: number;
  /** The alert row's persisted status at the final observation. */
  status: string;
  /** Inbox rows written for this alert's fire (any trigger window). */
  notifications: number;
}

export interface Pd9Harness {
  findUserIdByEmail(email: string): Promise<string>;
  captureCleartextScope(email: string): Promise<Pd9CleartextScope>;
  probeCleartext(scope: Pd9CleartextScope): Promise<Pd9CleartextProbe>;
  seedPurgeOnlyFixture(input: {
    email: string;
    portfolioId: string;
    assetId: string;
  }): Promise<Pd9PurgeOnlyFixture>;
  purgeOnlyCounts(fixture: Pd9PurgeOnlyFixture): Promise<Record<string, number>>;
  vaultStorage(email: string): Promise<Pd9VaultStorageProbe>;
  fireAlert(input: { email: string; alertId: string }): Promise<Pd9AlertFireResult>;
  evaluateRestoredCurrentBudget(email: string): Promise<{
    emitted: DispatchableEvent[];
    fireRows: number;
  }>;
  /**
   * Seed the LEGACY expense island the way a pre-fusion account still carries
   * it: one Groceries budget and one current-period transaction, written
   * through the real repositories. The island's HTTP writes are retired
   * (410 EXPENSE_AREA_RETIRED — V5 cash fusion), but the rows themselves are
   * exactly what PD9 must prove the vault carries through enable → purge →
   * disable → restore, so the fixture bypasses HTTP the same way this harness
   * drives every other queue-/worker-only path: real repositories, the same
   * Playwright database, no product change.
   */
  seedLegacyExpenseFixture(input: {
    email: string;
    bookedOn: string;
    description: string;
  }): Promise<void>;
  dispose(): Promise<void>;
}

/** Build PD9's service/DB harness against the same stack Playwright is driving. */
export function createPd9Harness(): Pd9Harness {
  const { db, client } = createDatabase(DATABASE_URL);
  const redis = createRedis(REDIS_URL);
  const users = createUserRepository(db);
  const paranoid = createParanoidModeGuard({
    privacyModeFor: async (userId) => (await users.findById(userId))?.privacyMode ?? null,
    withLockedPrivacyModes: (userIds, run) => withLockedPrivacyModes(db, userIds, run),
  });

  async function userIdFor(email: string): Promise<string> {
    const user = await users.findByEmail(email);
    if (!user) throw new Error(`PD9 could not resolve the browser user ${email}.`);
    return user.id;
  }

  return {
    findUserIdByEmail: userIdFor,

    async captureCleartextScope(email) {
      const userId = await userIdFor(email);
      const portfolioIds = await ids(
        db
          .select({ id: schema.portfolios.id })
          .from(schema.portfolios)
          .where(eq(schema.portfolios.userId, userId)),
      );
      const [customAssetIds, standingOrderIds, importBatchIds, expenseBudgetIds, cashRuleIds] =
        await Promise.all([
          ids(
            db
              .select({ id: schema.assets.id })
              .from(schema.assets)
              .where(eq(schema.assets.ownerId, userId)),
          ),
          ids(
            db
              .select({ id: schema.standingOrders.id })
              .from(schema.standingOrders)
              .where(eq(schema.standingOrders.userId, userId)),
          ),
          ids(
            db
              .select({ id: schema.importBatches.id })
              .from(schema.importBatches)
              .where(eq(schema.importBatches.ownerId, userId)),
          ),
          ids(
            db
              .select({ id: schema.expenseBudgets.id })
              .from(schema.expenseBudgets)
              .where(eq(schema.expenseBudgets.userId, userId)),
          ),
          ids(
            db
              .select({ id: schema.cashRules.id })
              .from(schema.cashRules)
              .where(eq(schema.cashRules.userId, userId)),
          ),
        ]);
      const [cashMovementIds, cashBudgetIds] = await Promise.all([
        portfolioIds.length === 0
          ? []
          : ids(
              db
                .select({ id: schema.portfolioCashMovements.id })
                .from(schema.portfolioCashMovements)
                .where(inArray(schema.portfolioCashMovements.portfolioId, portfolioIds)),
            ),
        portfolioIds.length === 0
          ? []
          : ids(
              db
                .select({ id: schema.cashBudgets.id })
                .from(schema.cashBudgets)
                .where(inArray(schema.cashBudgets.portfolioId, portfolioIds)),
            ),
      ]);
      return {
        userId,
        portfolioIds,
        customAssetIds,
        standingOrderIds,
        importBatchIds,
        expenseBudgetIds,
        cashMovementIds,
        cashBudgetIds,
        cashRuleIds,
      };
    },

    async probeCleartext(scope) {
      const handlers: Record<string, () => Promise<number>> = {
        assets: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.assets)
              .where(eq(schema.assets.ownerId, scope.userId)),
          ),
        cash_budget_fires: () =>
          probeIds(scope.cashBudgetIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.cashBudgetFires)
              .where(inArray(schema.cashBudgetFires.budgetId, values)),
          ),
        cash_budgets: () =>
          probeIds(scope.portfolioIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.cashBudgets)
              .where(inArray(schema.cashBudgets.portfolioId, values)),
          ),
        cash_movement_tags: () =>
          probeIds(scope.cashMovementIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.cashMovementTags)
              .where(inArray(schema.cashMovementTags.movementId, values)),
          ),
        cash_rule_tags: () =>
          probeIds(scope.cashRuleIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.cashRuleTags)
              .where(inArray(schema.cashRuleTags.ruleId, values)),
          ),
        cash_rules: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.cashRules)
              .where(eq(schema.cashRules.userId, scope.userId)),
          ),
        cash_tags: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.cashTags)
              .where(eq(schema.cashTags.userId, scope.userId)),
          ),
        dividends: () =>
          probeIds(scope.portfolioIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.dividends)
              .where(inArray(schema.dividends.portfolioId, values)),
          ),
        expense_budget_fires: () =>
          probeIds(scope.expenseBudgetIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.expenseBudgetFires)
              .where(inArray(schema.expenseBudgetFires.budgetId, values)),
          ),
        expense_budgets: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.expenseBudgets)
              .where(eq(schema.expenseBudgets.userId, scope.userId)),
          ),
        expense_categories: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.expenseCategories)
              .where(eq(schema.expenseCategories.userId, scope.userId)),
          ),
        expense_rules: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.expenseRules)
              .where(eq(schema.expenseRules.userId, scope.userId)),
          ),
        expense_transactions: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.expenseTransactions)
              .where(eq(schema.expenseTransactions.userId, scope.userId)),
          ),
        import_batches: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.importBatches)
              .where(eq(schema.importBatches.ownerId, scope.userId)),
          ),
        import_rows: () =>
          probeIds(scope.importBatchIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.importRows)
              .where(inArray(schema.importRows.batchId, values)),
          ),
        portfolio_cash_movements: () =>
          probeIds(scope.portfolioIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.portfolioCashMovements)
              .where(inArray(schema.portfolioCashMovements.portfolioId, values)),
          ),
        portfolio_cash_sources: () =>
          probeIds(scope.portfolioIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.portfolioCashSources)
              .where(inArray(schema.portfolioCashSources.portfolioId, values)),
          ),
        portfolio_daily_snapshots: () =>
          probeIds(scope.portfolioIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.portfolioDailySnapshots)
              .where(inArray(schema.portfolioDailySnapshots.portfolioId, values)),
          ),
        portfolio_settings: () =>
          probeIds(scope.portfolioIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.portfolioSettings)
              .where(inArray(schema.portfolioSettings.portfolioId, values)),
          ),
        portfolio_snapshot_state: () =>
          probeIds(scope.portfolioIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.portfolioSnapshotState)
              .where(inArray(schema.portfolioSnapshotState.portfolioId, values)),
          ),
        portfolios: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.portfolios)
              .where(eq(schema.portfolios.userId, scope.userId)),
          ),
        price_history: () =>
          probeIds(scope.customAssetIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.priceHistory)
              .where(inArray(schema.priceHistory.assetId, values)),
          ),
        standing_order_runs: () =>
          probeIds(scope.standingOrderIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.standingOrderRuns)
              .where(inArray(schema.standingOrderRuns.standingOrderId, values)),
          ),
        standing_orders: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.standingOrders)
              .where(eq(schema.standingOrders.userId, scope.userId)),
          ),
        transactions: () =>
          probeIds(scope.portfolioIds, (values) =>
            db
              .select({ value: count() })
              .from(schema.transactions)
              .where(inArray(schema.transactions.portfolioId, values)),
          ),
        user_tax_settings: () =>
          probe(
            db
              .select({ value: count() })
              .from(schema.userTaxSettings)
              .where(eq(schema.userTaxSettings.userId, scope.userId)),
          ),
      };
      assertSameNames('PD9 probe', Object.keys(handlers), PARANOID_VAULT_TABLE_NAMES);
      assertSameNames('production probe', PARANOID_PROBE_HANDLER_NAMES, PARANOID_VAULT_TABLE_NAMES);
      return Object.fromEntries(
        await Promise.all(
          Object.entries(handlers).map(async ([name, handler]) => [name, await handler()]),
        ),
      );
    },

    async seedPurgeOnlyFixture({ email, portfolioId, assetId }) {
      const userId = await userIdFor(email);
      const snapshotDate = '2001-01-02';
      const imports = createImportRepository(db);
      const importBatch = await imports.createBatch(
        {
          ownerId: userId,
          portfolioId,
          brokerId: 'pd9-fixture',
          filename: 'pd9-applied.csv',
        },
        [
          {
            rowIndex: 1,
            raw: 'PD9,APPLIED,ROW',
            kind: 'buy',
            flag: 'mapped',
            message: null,
            executedAt: new Date('2001-01-02T12:00:00.000Z'),
            isin: null,
            symbol: 'PD9',
            name: null,
            quantity: 2,
            price: 400,
            fee: null,
            amountEur: null,
            currency: 'EUR',
            note: null,
            assetId,
            contentHash: 'pd9-applied-import-row',
          },
        ],
      );
      const [importRow] = await imports.listRows(importBatch.id);
      if (!importRow) throw new Error('PD9 import-row fixture insert returned no row.');
      await imports.setRowResults([{ id: importRow.id, result: 'applied', resultMessage: null }]);
      if (!(await imports.claimPendingBatch(importBatch.id, null))) {
        throw new Error('PD9 import-batch fixture could not be marked applied.');
      }
      await db.insert(schema.portfolioDailySnapshots).values({
        portfolioId,
        date: snapshotDate,
        valueEur: '1000',
        costBasisEur: '800',
        plEur: '200',
        flowEur: '0',
        cashBySource: {},
        assetValues: { [assetId]: 1000 },
      });
      await db
        .insert(schema.portfolioSnapshotState)
        .values({
          portfolioId,
          computedThrough: snapshotDate,
        })
        .onConflictDoUpdate({
          target: schema.portfolioSnapshotState.portfolioId,
          set: { computedThrough: snapshotDate },
        });

      const [budget] = await db
        .select({ id: schema.expenseBudgets.id })
        .from(schema.expenseBudgets)
        .where(eq(schema.expenseBudgets.userId, userId))
        .limit(1);
      if (!budget) throw new Error('PD9 expected the authenticated budget fixture.');
      const [fire] = await db
        .select({
          id: schema.expenseBudgetFires.id,
          periodKey: schema.expenseBudgetFires.periodKey,
        })
        .from(schema.expenseBudgetFires)
        .where(eq(schema.expenseBudgetFires.budgetId, budget.id));
      if (!fire) throw new Error('PD9 expected the current-period budget fire marker.');
      return {
        importBatchId: importBatch.id,
        importRowId: importRow.id,
        portfolioId,
        snapshotDate,
        budgetId: budget.id,
        periodKey: fire.periodKey,
      };
    },

    async purgeOnlyCounts(fixture) {
      const [batch, row, snapshot, snapshotState, budgetFire] = await Promise.all([
        probe(
          db
            .select({ value: count() })
            .from(schema.importBatches)
            .where(eq(schema.importBatches.id, fixture.importBatchId)),
        ),
        probe(
          db
            .select({ value: count() })
            .from(schema.importRows)
            .where(eq(schema.importRows.id, fixture.importRowId)),
        ),
        probe(
          db
            .select({ value: count() })
            .from(schema.portfolioDailySnapshots)
            .where(
              and(
                eq(schema.portfolioDailySnapshots.portfolioId, fixture.portfolioId),
                eq(schema.portfolioDailySnapshots.date, fixture.snapshotDate),
              ),
            ),
        ),
        probe(
          db
            .select({ value: count() })
            .from(schema.portfolioSnapshotState)
            .where(eq(schema.portfolioSnapshotState.portfolioId, fixture.portfolioId)),
        ),
        probe(
          db
            .select({ value: count() })
            .from(schema.expenseBudgetFires)
            .where(
              and(
                eq(schema.expenseBudgetFires.budgetId, fixture.budgetId),
                eq(schema.expenseBudgetFires.periodKey, fixture.periodKey),
              ),
            ),
        ),
      ]);
      return {
        importBatch: batch,
        importRow: row,
        portfolioDailySnapshot: snapshot,
        portfolioSnapshotState: snapshotState,
        expenseBudgetFire: budgetFire,
      };
    },

    async vaultStorage(email) {
      const userId = await userIdFor(email);
      const [active, history, candidates, retired, retirements] = await Promise.all([
        db
          .select({ sizeBytes: schema.paranoidVaults.sizeBytes })
          .from(schema.paranoidVaults)
          .where(eq(schema.paranoidVaults.userId, userId)),
        db
          .select({ sizeBytes: schema.paranoidVaultHistory.sizeBytes })
          .from(schema.paranoidVaultHistory)
          .where(eq(schema.paranoidVaultHistory.userId, userId)),
        db
          .select({ sizeBytes: schema.paranoidVaultServerCandidates.sizeBytes })
          .from(schema.paranoidVaultServerCandidates)
          .where(eq(schema.paranoidVaultServerCandidates.userId, userId)),
        db
          .select({ sizeBytes: schema.paranoidVaultRetired.sizeBytes })
          .from(schema.paranoidVaultRetired)
          .where(eq(schema.paranoidVaultRetired.userId, userId)),
        db
          .select({ id: schema.paranoidVaultRetirements.userId })
          .from(schema.paranoidVaultRetirements)
          .where(eq(schema.paranoidVaultRetirements.userId, userId)),
      ]);
      return {
        active: bytesProbe(active),
        history: bytesProbe(history),
        candidates: bytesProbe(candidates),
        retired: bytesProbe(retired),
        retirements: retirements.length,
      };
    },

    async fireAlert({ email, alertId }) {
      const userId = await userIdFor(email);
      const alerts = createAlertRepository(db);
      const dispatcher = createNotificationDispatcher({
        bus: { publish: async () => {} },
        repo: createNotificationRepository(db),
        users,
        resolveAlert: (id) => alerts.findNotificationContext(id),
        logger: silentLogger,
      });
      const center = createNotificationCenter({
        enqueue: (event) => dispatcher.dispatch(event),
        logger: silentLogger,
      });
      const scopedAlerts = {
        ...alerts,
        async listActiveWithAsset() {
          return (await alerts.listActiveWithAsset({ includeCustomAssets: false })).filter(
            (row) => row.userId === userId && row.id === alertId,
          );
        },
        async listActiveCustomAssetOwnerIds() {
          return [];
        },
        async listActiveCustomAssetsForUser() {
          return [];
        },
        async countActiveForeignCustomAssetAlerts() {
          return 0;
        },
      };
      /**
       * The observable §15 invariant: the alert row is persisted `triggered`
       * AND the fire produced its inbox row. Two writers reach that state — this
       * focused evaluation and the real minute-scheduled `alerts.evaluate`
       * worker, which sweeps every active GLOBAL alert with no per-account
       * filter (`paranoid.runAllowed` only gates the custom-asset rail). So the
       * harness converges on the invariant instead of sampling it once: a
       * single read can legitimately observe `active` while the worker sits
       * between its `SET NX` fire lock and `recordTriggered`.
       */
      const observe = async (): Promise<{ status: string; notifications: number }> => {
        const [alert, notifications] = await Promise.all([
          alerts.findByIdForUser(userId, alertId, { includeCustomAssets: false }),
          probe(
            db
              .select({ value: count() })
              .from(schema.notifications)
              .where(
                and(
                  eq(schema.notifications.userId, userId),
                  sql`${schema.notifications.payload} ->> 'eventKey' like ${`alert.triggered:${alertId}:%`}`,
                ),
              ),
          ),
        ]);
        if (!alert) throw new Error('PD9 alert vanished during evaluation.');
        return { status: alert.status, notifications };
      };

      const startedAt = Date.now();
      const deadline = startedAt + PD9_ALERT_CONVERGENCE_TIMEOUT_MS;
      let evaluated = 0;
      let fired = 0;
      let attempts = 0;
      for (;;) {
        const observed = await observe();
        const converged = observed.status === 'triggered' && observed.notifications > 0;
        if (converged || Date.now() >= deadline) {
          return { evaluated, fired, attempts, elapsedMs: Date.now() - startedAt, ...observed };
        }

        // The per-(alert, minute) idempotency lock is `SET NX EX 120` and is
        // never released. A scheduled worker run that claimed it and then failed
        // its REAL upstream quote call (the nightly runner has no quote
        // provider; this harness uses a stub) would otherwise lock this focused
        // evaluation out for the lock's full TTL — two whole trigger windows.
        // Dropping the current window's key is safe for this fixture: the alert
        // is one-shot, so a re-fire needs a still-active row; the dispatcher
        // dedupes `alert.triggered` per (alert, minute); and the spec's bell
        // assertion reads an unread COUNT, never an exact number. The next
        // iteration recomputes the window, so a minute rollover between the
        // delete and the evaluator's own clock read just retries.
        await redis.del(alertFireLockKey(alertId, alertFireWindowStart(Date.now())));
        const result = await runAlertsEvaluation({
          alertRepo: scopedAlerts,
          marketData: createStubMarketData({
            quote: () => ({
              value: {
                price: 500,
                currency: 'EUR',
                dayChangePct: null,
                asOf: new Date().toISOString(),
              },
              stale: false,
              asOf: 0,
            }),
          }),
          redis,
          paranoid,
          notify: center,
          logger: silentLogger,
        });
        evaluated += result.evaluated;
        fired += result.fired;
        attempts += 1;
        await delay(PD9_ALERT_POLL_INTERVAL_MS);
      }
    },

    async evaluateRestoredCurrentBudget(email) {
      const userId = await userIdFor(email);
      const emitted: DispatchableEvent[] = [];
      const budgets = createExpenseBudgetRepository(db);
      const service = createExpenseBudgetService({
        categories: createExpenseCategoryRepository(db),
        transactions: createExpenseTransactionRepository(db),
        budgets,
        notify: {
          async emit(event) {
            emitted.push(event);
            return true;
          },
        },
        logger: silentLogger,
      });
      await service.evaluate(userId);
      await service.evaluate(userId);
      const budgetRows = await budgets.listForOwner(userId);
      const fireRows = await probeIds(
        budgetRows.map((budget) => budget.id),
        (values) =>
          db
            .select({ value: count() })
            .from(schema.expenseBudgetFires)
            .where(inArray(schema.expenseBudgetFires.budgetId, values)),
      );
      return { emitted, fireRows };
    },

    async seedLegacyExpenseFixture({ email, bookedOn, description }) {
      const userId = await userIdFor(email);
      const categories = createExpenseCategoryRepository(db);
      const groceries = (await categories.listForOwner(userId)).find(
        (category) => category.name === 'Groceries',
      );
      if (!groceries) {
        throw new Error('PD9 expected the default Groceries category to exist.');
      }
      await createExpenseBudgetRepository(db).create(userId, {
        categoryId: groceries.id,
        amount: 200,
        currency: 'EUR',
      });
      await createExpenseTransactionRepository(db).create(userId, {
        categoryId: groceries.id,
        direction: 'expense',
        amount: 300,
        currency: 'EUR',
        bookedOn,
        description,
        source: 'manual',
      });
      // The retired HTTP write path evaluated budgets as a side effect, and
      // the €300 spend against the €200 target booked the current period's
      // fire marker — the purge-only row the PD9 counts assert on. Run the
      // REAL evaluation so the repository seeding carries the same state.
      const service = createExpenseBudgetService({
        categories,
        transactions: createExpenseTransactionRepository(db),
        budgets: createExpenseBudgetRepository(db),
        notify: {
          async emit() {
            return true;
          },
        },
        logger: silentLogger,
      });
      await service.evaluate(userId);
    },

    async dispose() {
      await Promise.all([redis.quit(), client.end({ timeout: 5 })]);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ids(query: PromiseLike<Array<{ id: string }>>): Promise<string[]> {
  return (await query).map((row) => row.id);
}

async function probe(query: PromiseLike<Array<{ value: number }>>): Promise<number> {
  const [row] = await query;
  return Number(row?.value ?? 0);
}

async function probeIds(
  values: readonly string[],
  query: (values: string[]) => PromiseLike<Array<{ value: number }>>,
): Promise<number> {
  return values.length === 0 ? 0 : probe(query([...values]));
}

function bytesProbe(rows: ReadonlyArray<{ sizeBytes: number }>): { rows: number; bytes: number } {
  return {
    rows: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
  };
}

function assertSameNames(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((name, index) => name !== right[index])) {
    throw new Error(`${label} coverage drifted from the paranoid vault classification.`);
  }
}
