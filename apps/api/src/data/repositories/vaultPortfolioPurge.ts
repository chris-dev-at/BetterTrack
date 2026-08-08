import { count, eq, inArray } from 'drizzle-orm';

import {
  PARANOID_TABLE_CLASSIFICATION,
  PARANOID_VAULT_TABLE_NAMES,
} from '../../services/export/manifest';
import {
  cashBudgetFires,
  cashBudgets,
  cashMovementTags,
  dividends,
  importBatches,
  importRows,
  portfolioCashMovements,
  portfolioCashSources,
  portfolioDailySnapshots,
  portfolioSettings,
  portfolioSnapshotState,
  standingOrderRuns,
  standingOrders,
  transactions,
} from '../schema';
import type { Database } from '../db';

/**
 * Vaults v2 (§3) — the PORTFOLIO-scoped counterpart of the account-level purge
 * sweep in `paranoidTransitionRepository.ts`. Joining a portfolio to a vault
 * hard-deletes exactly the cleartext rows that belong to THAT portfolio; the
 * account's other, normal portfolios are untouched.
 *
 * The mechanics deliberately mirror the account sweep: one executable handler
 * per classified table, a hand-authored leaves-before-parents order, a
 * completeness assertion that runs BEFORE any destructive statement, and a
 * zero-cleartext probe afterwards that turns a missed table into a failed
 * transaction rather than a silent leak.
 */

export interface VaultPortfolioPurgeScope {
  tx: Database;
  portfolioId: string;
  /** Resolved before the first delete — the join tables need their parents' ids. */
  cashMovementIds: readonly string[];
  cashBudgetIds: readonly string[];
  standingOrderIds: readonly string[];
  importBatchIds: readonly string[];
}

type PurgeHandler = (scope: VaultPortfolioPurgeScope) => Promise<unknown>;
type ProbeHandler = (scope: VaultPortfolioPurgeScope) => Promise<number>;

const ifIds = async (ids: readonly string[], run: (ids: string[]) => Promise<unknown>) => {
  if (ids.length > 0) await run([...ids]);
};

const probeIds = async (
  ids: readonly string[],
  run: (ids: string[]) => PromiseLike<Array<{ value: number }>>,
): Promise<number> => {
  if (ids.length === 0) return 0;
  const [row] = await run([...ids]);
  return Number(row?.value ?? 0);
};

const probe = async (query: PromiseLike<Array<{ value: number }>>): Promise<number> => {
  const [row] = await query;
  return Number(row?.value ?? 0);
};

/**
 * Every `vault`-classified table that is NOT scoped to a single portfolio, with
 * the binding reason it survives a join. Together with
 * {@link VAULT_PORTFOLIO_PURGE_ORDER} this must exhaust
 * `PARANOID_VAULT_TABLE_NAMES` — so a future vault-classified table cannot enter
 * the account sweep without making an explicit per-portfolio decision here.
 */
export const VAULT_PORTFOLIO_ACCOUNT_SCOPED_TABLES: Readonly<Record<string, string>> = {
  portfolios:
    'the portfolio row itself survives the join — it is what carries `vault_id`; only its content dies',
  assets:
    'custom assets are user-owned and reachable from every portfolio of the account; purging them for one vaulted portfolio would break the normal ones. This is the design’s acknowledged ticker-visibility caveat (VAULTS_V2_DESIGN §4).',
  price_history: 'custom-asset value points follow their asset, which is user-scoped (above)',
  cash_tags: 'user-scoped classification vocabulary shared with the account’s normal portfolios',
  cash_rules: 'user-scoped auto-tagging rules shared with the account’s normal portfolios',
  cash_rule_tags: 'follows `cash_rules`, which is user-scoped',
  user_tax_settings: 'the tax mode is a per-USER setting (V3-P4), never per portfolio',
  expense_categories:
    'the expense island carries no portfolio reference at all (schema.ts §Expenses)',
  expense_transactions: 'the expense island carries no portfolio reference at all',
  expense_rules: 'the expense island carries no portfolio reference at all',
  expense_budgets: 'the expense island carries no portfolio reference at all',
  expense_budget_fires: 'follows `expense_budgets`, which carries no portfolio reference',
};

/** One executable delete per portfolio-scoped table. */
const PURGE_HANDLERS: Record<string, PurgeHandler> = {
  cash_budget_fires: ({ cashBudgetIds, tx }) =>
    ifIds(cashBudgetIds, (ids) =>
      tx.delete(cashBudgetFires).where(inArray(cashBudgetFires.budgetId, ids)),
    ),
  cash_movement_tags: ({ cashMovementIds, tx }) =>
    ifIds(cashMovementIds, (ids) =>
      tx.delete(cashMovementTags).where(inArray(cashMovementTags.movementId, ids)),
    ),
  standing_order_runs: ({ standingOrderIds, tx }) =>
    ifIds(standingOrderIds, (ids) =>
      tx.delete(standingOrderRuns).where(inArray(standingOrderRuns.standingOrderId, ids)),
    ),
  import_rows: ({ importBatchIds, tx }) =>
    ifIds(importBatchIds, (ids) => tx.delete(importRows).where(inArray(importRows.batchId, ids))),
  portfolio_daily_snapshots: ({ portfolioId, tx }) =>
    tx.delete(portfolioDailySnapshots).where(eq(portfolioDailySnapshots.portfolioId, portfolioId)),
  portfolio_snapshot_state: ({ portfolioId, tx }) =>
    tx.delete(portfolioSnapshotState).where(eq(portfolioSnapshotState.portfolioId, portfolioId)),
  dividends: ({ portfolioId, tx }) =>
    tx.delete(dividends).where(eq(dividends.portfolioId, portfolioId)),
  portfolio_cash_movements: ({ portfolioId, tx }) =>
    tx.delete(portfolioCashMovements).where(eq(portfolioCashMovements.portfolioId, portfolioId)),
  transactions: ({ portfolioId, tx }) =>
    tx.delete(transactions).where(eq(transactions.portfolioId, portfolioId)),
  portfolio_cash_sources: ({ portfolioId, tx }) =>
    tx.delete(portfolioCashSources).where(eq(portfolioCashSources.portfolioId, portfolioId)),
  portfolio_settings: ({ portfolioId, tx }) =>
    tx.delete(portfolioSettings).where(eq(portfolioSettings.portfolioId, portfolioId)),
  cash_budgets: ({ portfolioId, tx }) =>
    tx.delete(cashBudgets).where(eq(cashBudgets.portfolioId, portfolioId)),
  standing_orders: ({ portfolioId, tx }) =>
    tx.delete(standingOrders).where(eq(standingOrders.portfolioId, portfolioId)),
  import_batches: ({ portfolioId, tx }) =>
    tx.delete(importBatches).where(eq(importBatches.portfolioId, portfolioId)),
};

/**
 * Dependency-safe destructive order: leaves disappear before their parents.
 * Membership is checked mechanically by {@link assertVaultPortfolioPurgeCompleteness};
 * only the ORDER is hand-authored.
 */
export const VAULT_PORTFOLIO_PURGE_ORDER = [
  'cash_budget_fires',
  'cash_movement_tags',
  'standing_order_runs',
  'import_rows',
  'portfolio_daily_snapshots',
  'portfolio_snapshot_state',
  'dividends',
  'portfolio_cash_movements',
  'transactions',
  'portfolio_cash_sources',
  'portfolio_settings',
  'cash_budgets',
  'standing_orders',
  'import_batches',
] as const;

/** One scope-aware zero-cleartext query per purged table. */
const PROBE_HANDLERS: Record<string, ProbeHandler> = {
  cash_budget_fires: ({ cashBudgetIds, tx }) =>
    probeIds(cashBudgetIds, (ids) =>
      tx
        .select({ value: count() })
        .from(cashBudgetFires)
        .where(inArray(cashBudgetFires.budgetId, ids)),
    ),
  cash_movement_tags: ({ cashMovementIds, tx }) =>
    probeIds(cashMovementIds, (ids) =>
      tx
        .select({ value: count() })
        .from(cashMovementTags)
        .where(inArray(cashMovementTags.movementId, ids)),
    ),
  standing_order_runs: ({ standingOrderIds, tx }) =>
    probeIds(standingOrderIds, (ids) =>
      tx
        .select({ value: count() })
        .from(standingOrderRuns)
        .where(inArray(standingOrderRuns.standingOrderId, ids)),
    ),
  import_rows: ({ importBatchIds, tx }) =>
    probeIds(importBatchIds, (ids) =>
      tx.select({ value: count() }).from(importRows).where(inArray(importRows.batchId, ids)),
    ),
  portfolio_daily_snapshots: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(portfolioDailySnapshots)
        .where(eq(portfolioDailySnapshots.portfolioId, portfolioId)),
    ),
  portfolio_snapshot_state: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(portfolioSnapshotState)
        .where(eq(portfolioSnapshotState.portfolioId, portfolioId)),
    ),
  dividends: ({ portfolioId, tx }) =>
    probe(
      tx.select({ value: count() }).from(dividends).where(eq(dividends.portfolioId, portfolioId)),
    ),
  portfolio_cash_movements: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    ),
  transactions: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(transactions)
        .where(eq(transactions.portfolioId, portfolioId)),
    ),
  portfolio_cash_sources: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(portfolioCashSources)
        .where(eq(portfolioCashSources.portfolioId, portfolioId)),
    ),
  portfolio_settings: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(portfolioSettings)
        .where(eq(portfolioSettings.portfolioId, portfolioId)),
    ),
  cash_budgets: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(cashBudgets)
        .where(eq(cashBudgets.portfolioId, portfolioId)),
    ),
  standing_orders: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(standingOrders)
        .where(eq(standingOrders.portfolioId, portfolioId)),
    ),
  import_batches: ({ portfolioId, tx }) =>
    probe(
      tx
        .select({ value: count() })
        .from(importBatches)
        .where(eq(importBatches.portfolioId, portfolioId)),
    ),
};

export const VAULT_PORTFOLIO_PURGE_HANDLER_NAMES = Object.keys(PURGE_HANDLERS).sort();
export const VAULT_PORTFOLIO_PROBE_HANDLER_NAMES = Object.keys(PROBE_HANDLERS).sort();

/**
 * Runs before the first DELETE, exactly like the account sweep's own gate. It
 * proves three things at once: the purge and probe maps agree with the declared
 * order, every purged table really is `vault`-classified, and the purged set
 * plus {@link VAULT_PORTFOLIO_ACCOUNT_SCOPED_TABLES} exhausts the account-level
 * vault axis — so a new vault table has to be classified here too.
 */
export function assertVaultPortfolioPurgeCompleteness(): void {
  const purged = [...VAULT_PORTFOLIO_PURGE_ORDER].sort();
  for (const [label, actual] of [
    ['purge handlers', VAULT_PORTFOLIO_PURGE_HANDLER_NAMES],
    ['probe handlers', VAULT_PORTFOLIO_PROBE_HANDLER_NAMES],
  ] as const) {
    if (actual.join(' ') !== purged.join(' ')) {
      throw new Error(
        `vault portfolio purge ${label} disagree with the purge order: ` +
          `${actual.join(', ')} vs ${purged.join(', ')}`,
      );
    }
  }
  for (const table of purged) {
    if (PARANOID_TABLE_CLASSIFICATION[table] !== 'vault') {
      throw new Error(`vault portfolio purge targets a non-vault table: ${table}`);
    }
  }
  const covered = new Set([...purged, ...Object.keys(VAULT_PORTFOLIO_ACCOUNT_SCOPED_TABLES)]);
  const missing = PARANOID_VAULT_TABLE_NAMES.filter((table) => !covered.has(table));
  if (missing.length > 0) {
    throw new Error(
      `vault portfolio purge omitted vault-classified table(s): ${missing.join(', ')}. ` +
        'Either purge them per portfolio or record why they are account-scoped.',
    );
  }
  const unknown = [...covered].filter((table) => !PARANOID_VAULT_TABLE_NAMES.includes(table));
  if (unknown.length > 0) {
    throw new Error(`vault portfolio purge classifies non-vault table(s): ${unknown.join(', ')}`);
  }
}

/** Resolve the parent ids the join-table deletes need, before anything is destroyed. */
export async function collectVaultPortfolioPurgeScope(
  tx: Database,
  portfolioId: string,
): Promise<VaultPortfolioPurgeScope> {
  const [movements, budgets, orders, batches] = await Promise.all([
    tx
      .select({ id: portfolioCashMovements.id })
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, portfolioId)),
    tx
      .select({ id: cashBudgets.id })
      .from(cashBudgets)
      .where(eq(cashBudgets.portfolioId, portfolioId)),
    tx
      .select({ id: standingOrders.id })
      .from(standingOrders)
      .where(eq(standingOrders.portfolioId, portfolioId)),
    tx
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(eq(importBatches.portfolioId, portfolioId)),
  ]);
  return {
    tx,
    portfolioId,
    cashMovementIds: movements.map((row) => row.id),
    cashBudgetIds: budgets.map((row) => row.id),
    standingOrderIds: orders.map((row) => row.id),
    importBatchIds: batches.map((row) => row.id),
  };
}

/**
 * Hard-delete every cleartext row of ONE portfolio, then prove zero remain.
 * Must run inside the join transaction: a probe failure throws, which rolls the
 * whole join back (blob write included) rather than leaving a half-vaulted
 * portfolio whose rows are still readable.
 */
export async function purgeVaultPortfolioRows(tx: Database, portfolioId: string): Promise<void> {
  assertVaultPortfolioPurgeCompleteness();
  const scope = await collectVaultPortfolioPurgeScope(tx, portfolioId);
  for (const table of VAULT_PORTFOLIO_PURGE_ORDER) {
    await PURGE_HANDLERS[table]!(scope);
  }
  for (const table of VAULT_PORTFOLIO_PURGE_ORDER) {
    const remaining = await PROBE_HANDLERS[table]!(scope);
    if (remaining !== 0) {
      throw new Error(`vault portfolio zero-cleartext probe failed for ${table}`);
    }
  }
}

/**
 * Whether any cleartext row of a portfolio still exists. Used by leave to refuse
 * repopulating on top of surviving rows (the portfolio-scoped analogue of the
 * account rehydration's `ensureNoExistingRestorableRows`).
 */
export async function hasVaultPortfolioCleartextRows(
  tx: Database,
  portfolioId: string,
): Promise<boolean> {
  const scope = await collectVaultPortfolioPurgeScope(tx, portfolioId);
  for (const table of VAULT_PORTFOLIO_PURGE_ORDER) {
    if ((await PROBE_HANDLERS[table]!(scope)) !== 0) return true;
  }
  return false;
}
