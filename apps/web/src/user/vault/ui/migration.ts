import {
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_ENTITY_ROW_SCHEMAS,
  type CustomTaxParams,
  type Dividend,
  type ExpenseTransaction,
  type PortfolioAsset,
  type TaxCountry,
  type TaxMode,
  type TaxSettingsResponse,
  type Transaction,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';

import {
  listExpenseBudgets,
  listExpenseCategories,
  listExpenseRules,
  listExpenseTransactions,
} from '../../../lib/expensesApi';
import { getTaxYearReport, getTaxYearReports, listDividends } from '../../../lib/portfolioApi';
import { apiPortfolioStore, type PortfolioStore } from '../../../lib/portfolioStore';
import { emptyVaultDocument } from './enable';

export interface NormalVaultMigrationOptions {
  userId: string;
  deviceId?: string;
  store?: PortfolioStore;
  now?: () => string;
  id?: () => string;
  signal?: AbortSignal;
}

/**
 * Read the complete currently-restorable normal-account graph before enable.
 * Derived snapshots/import staging/fire ledgers are deliberately omitted: PD3
 * marks them purge-only and re-derives their successors after rehydration.
 *
 * One documented gap inside a restorable kind: only a standing order's LAST run
 * (`lastPeriodKey` + `lastRunAt`) is migrated, because that is all the standing
 * orders endpoint exposes. Earlier `standing_order_runs` rows are purged at
 * enable and do not come back on disable. Dueness is unaffected — the scheduler
 * reads `lastPeriodKey`, and the client materializer derives the same
 * deterministic occurrence ids — so the loss is historical run bookkeeping only.
 */
export async function buildNormalVaultDocument(
  options: NormalVaultMigrationOptions,
): Promise<VaultDocument> {
  const store = options.store ?? apiPortfolioStore;
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? (() => globalThis.crypto.randomUUID());
  const deviceId = options.deviceId ?? id();
  const signal = options.signal;
  const document = emptyVaultDocument();
  if (document.schemaVersion !== VAULT_DOCUMENT_V1_VERSION) return document;

  const buckets = new Map<VaultEntityKind, VaultEntity[]>();
  const assets = new Map<string, PortfolioAsset>();
  const append = (
    kind: VaultEntityKind,
    entityId: string,
    data: Record<string, unknown>,
    editedAt = now(),
  ) => {
    const parsed = VAULT_ENTITY_ROW_SCHEMAS[kind].parse(data);
    const entity: VaultEntity = {
      id: entityId,
      rev: 1,
      editedAt,
      editedBy: deviceId,
      deletedAt: null,
      data: parsed,
    };
    const bucket = buckets.get(kind) ?? [];
    bucket.push(entity);
    buckets.set(kind, bucket);
  };

  const portfolios = await store.listPortfolios(signal, true);
  const portfolioFacts = await Promise.all(
    portfolios.portfolios.map(async (portfolio) => {
      signal?.throwIfAborted();
      const [transactions, cash, dividends, tax, taxYears] = await Promise.all([
        listAllTransactions(store, portfolio.id, signal),
        store.getCashMovements(portfolio.id, signal),
        listDividends(portfolio.id, undefined, signal),
        store.getPortfolioTaxSettings(portfolio.id, signal),
        getTaxYearReports(portfolio.id, signal),
      ]);
      const reports = await Promise.all(
        taxYears.years.map((year) => getTaxYearReport(portfolio.id, year.year, signal)),
      );
      return { portfolio, transactions, cash, dividends, tax, reports };
    }),
  );

  for (const fact of portfolioFacts) {
    const { portfolio } = fact;
    append(
      'portfolio',
      portfolio.id,
      {
        userId: options.userId,
        name: portfolio.name,
        visibility: portfolio.visibility,
        sortOrder: portfolio.sortOrder,
        defaultPayFromCash: portfolio.defaultPayFromCash,
        archivedAt: portfolio.archivedAt,
      },
      portfolio.archivedAt ?? now(),
    );

    const recordedTax = frozenTaxFacts(fact.reports);
    for (const transaction of fact.transactions) {
      assets.set(transaction.asset.id, transaction.asset);
      const taxFact = frozenFactsForTransaction(transaction, recordedTax);
      append(
        'transaction',
        transaction.id,
        {
          portfolioId: portfolio.id,
          assetId: transaction.assetId,
          side: transaction.side,
          quantity: decimal(transaction.quantity),
          price: decimal(transaction.price),
          fee: decimal(transaction.fee),
          executedAt: transaction.executedAt,
          note: transaction.note,
          taxMode: taxFact.taxMode,
          taxCountry: taxFact.taxCountry,
          taxAmountEur: taxFact.taxAmountEur == null ? null : decimal(taxFact.taxAmountEur),
          taxParams: taxFact.taxParams,
          allowUncovered: transaction.allowUncovered,
          uncoveredEntryPrice:
            transaction.uncoveredEntryPrice == null
              ? null
              : decimal(transaction.uncoveredEntryPrice),
          source: transaction.source,
        },
        transaction.executedAt,
      );
    }

    for (const source of fact.cash.sources) {
      append(
        'cashSource',
        source.id,
        {
          portfolioId: portfolio.id,
          name: source.name,
          type: source.type,
          isMain: source.isMain,
          archivedAt: source.archivedAt,
          createdAt: source.createdAt,
        },
        source.createdAt,
      );
    }
    for (const movement of fact.cash.movements) {
      append(
        'cashMovement',
        movement.id,
        {
          portfolioId: portfolio.id,
          sourceId: movement.sourceId,
          kind: movement.kind,
          amountEur: decimal(movement.amountEur),
          transactionId: movement.transactionId,
          transferId: movement.transferId,
          counterpartSourceId: movement.counterpartSourceId,
          dividendId: movement.dividendId,
          taxYear: movement.taxYear,
          executedAt: movement.executedAt,
          note: movement.note,
          source: movement.source,
          dedupHash: null,
          originalCurrency: movement.originalCurrency ?? null,
          createdAt: movement.createdAt,
        },
        movement.createdAt,
      );
    }
    for (const dividend of fact.dividends.dividends) {
      assets.set(dividend.asset.id, dividend.asset);
      const taxFact = frozenFactsForDividend(dividend, recordedTax);
      append(
        'dividend',
        dividend.id,
        {
          portfolioId: portfolio.id,
          assetId: dividend.assetId,
          cashSourceId: dividend.cashSourceId,
          grossAmountEur: decimal(dividend.grossAmountEur),
          executedAt: dividend.executedAt,
          note: dividend.note,
          taxMode: dividend.taxMode,
          taxCountry: dividend.taxCountry,
          taxAmountEur: dividend.taxAmountEur == null ? null : decimal(dividend.taxAmountEur),
          taxParams: taxFact.taxParams,
          source: dividend.source,
          createdAt: dividend.createdAt,
        },
        dividend.createdAt,
      );
    }
    if (fact.tax.override != null) {
      append('portfolioSetting', id(), {
        portfolioId: portfolio.id,
        key: 'tax',
        value: fact.tax.override,
        updatedAt: now(),
      });
    }
  }

  const customAssets = await store.listCustomAssets(signal);
  for (const item of customAssets.assets) {
    assets.set(item.id, {
      id: item.id,
      symbol: item.symbol,
      name: item.name,
      exchange: null,
      currency: item.currency,
      type: item.type,
      isCustom: true,
      category: item.category,
      smoothing: item.smoothing,
    });
  }
  for (const asset of assets.values()) {
    append('customAsset', asset.id, assetSnapshotRow(asset, options.userId));
    if (asset.isCustom) {
      const points = await store.getValuePoints(asset.id, signal);
      for (const point of points.points) {
        append('customAssetValue', id(), {
          assetId: asset.id,
          date: point.date,
          close: decimal(point.value),
        });
      }
    }
  }

  const userTax = await store.getTaxSettings(signal);
  append('taxSetting', id(), taxSettingRow(options.userId, userTax, now()));

  const standingOrders = await store.listStandingOrders(undefined, signal);
  for (const order of standingOrders.orders) {
    append(
      'standingOrder',
      order.id,
      {
        userId: options.userId,
        portfolioId: order.portfolioId,
        kind: order.kind,
        assetId: order.assetId,
        amount: decimal(order.amount),
        currency: order.currency,
        label: order.label,
        cadence: order.cadence,
        anchorDay: order.anchorDay,
        startDate: order.startDate,
        endDate: order.endDate,
        status: order.status,
        lastRunAt: order.lastRunAt,
        lastPeriodKey: order.lastPeriodKey,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
      order.updatedAt,
    );
    if (order.lastPeriodKey != null && order.lastRunAt != null) {
      append('standingOrderRun', id(), {
        standingOrderId: order.id,
        periodKey: order.lastPeriodKey,
        bookedAt: order.lastRunAt,
      });
    }
  }

  const [categories, expenseTransactions, rules, budgets] = await Promise.all([
    listExpenseCategories(signal),
    listAllExpenseTransactions(signal),
    listExpenseRules(signal),
    listExpenseBudgets(undefined, signal),
  ]);
  for (const category of categories.categories) {
    append(
      'expenseCategory',
      category.id,
      {
        userId: options.userId,
        name: category.name,
        direction: category.direction,
        color: category.color,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      },
      category.updatedAt,
    );
  }
  for (const expense of expenseTransactions) {
    append(
      'expenseTransaction',
      expense.id,
      {
        userId: options.userId,
        categoryId: expense.categoryId,
        direction: expense.direction,
        amount: decimal(expense.amount),
        currency: expense.currency,
        bookedOn: expense.bookedOn,
        description: expense.description,
        source: expense.source,
        dedupHash: null,
        createdAt: expense.createdAt,
        updatedAt: expense.updatedAt,
      },
      expense.updatedAt,
    );
  }
  for (const rule of rules.rules) {
    append(
      'expenseRule',
      rule.id,
      {
        userId: options.userId,
        categoryId: rule.categoryId,
        matchType: rule.matchType,
        pattern: rule.pattern,
        priority: rule.priority,
        enabled: rule.enabled,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      },
      rule.updatedAt,
    );
  }
  for (const budget of budgets.budgets) {
    const migratedAt = now();
    append(
      'expenseBudget',
      budget.id,
      {
        userId: options.userId,
        categoryId: budget.categoryId,
        amount: decimal(budget.amount),
        currency: budget.currency,
        createdAt: migratedAt,
        updatedAt: migratedAt,
      },
      migratedAt,
    );
  }

  return {
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities: Object.fromEntries(buckets),
    mergeLog: [],
  };
}

async function listAllTransactions(
  store: PortfolioStore,
  portfolioId: string,
  signal?: AbortSignal,
): Promise<Transaction[]> {
  const rows: Transaction[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listTransactions(portfolioId, { cursor, limit: 200 }, signal);
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor != null);
  return rows;
}

/**
 * The expense endpoint has no cursor. Page by booking day and re-read the
 * boundary day so a page split never drops rows. If one day itself reaches the
 * endpoint cap, abort before enable—the client cannot prove completeness.
 */
async function listAllExpenseTransactions(signal?: AbortSignal): Promise<ExpenseTransaction[]> {
  const rows = new Map<string, ExpenseTransaction>();
  let to: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await listExpenseTransactions({ limit: 500, ...(to ? { to } : {}) }, signal);
    if (page.transactions.length < 500) {
      for (const transaction of page.transactions) rows.set(transaction.id, transaction);
      return [...rows.values()];
    }

    const boundaryDay = page.transactions.at(-1)?.bookedOn;
    if (boundaryDay == null) {
      throw new Error('Expense migration could not establish a complete page boundary.');
    }
    const boundary = await listExpenseTransactions(
      { from: boundaryDay, to: boundaryDay, limit: 500 },
      signal,
    );
    if (boundary.transactions.length >= 500) {
      throw new Error('Expense migration cannot prove completeness for one booking day.');
    }
    for (const transaction of page.transactions) {
      if (transaction.bookedOn > boundaryDay) rows.set(transaction.id, transaction);
    }
    for (const transaction of boundary.transactions) rows.set(transaction.id, transaction);
    to = previousIsoDay(boundaryDay);
  }
}

function previousIsoDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Expense migration encountered an invalid booking day.');
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** The public catalog every non-custom asset row in this deployment came from. */
const CATALOG_PROVIDER_ID = 'yahoo';

/**
 * A row of the vault's LOCAL ASSET TABLE. One is emitted for every asset the
 * document references — market-catalog ones included — because the client
 * engine resolves each transaction, dividend and standing order through this
 * bucket (`engine/session.ts` graph validation, `engine/model.ts`), and a
 * paranoid client has to render and value a position without any
 * portfolio-linked server call.
 *
 * Only the OWNER's custom assets are vault data, though. A market asset lives
 * in the global `assets` table, survives the enable purge untouched, and is
 * re-resolved server-side on rehydration (`resolveReferencedAssets`), so its
 * snapshot here is client-only and is dropped again at the restore boundary
 * (`toStrictRestoreDocument`) — the server refuses a document that carries one.
 * Its `providerId`/`providerRef` therefore describe the public catalog the row
 * came from: that is the pair the §11 autonomy seam reads when a future client
 * fetches quotes without BetterTrack's API.
 *
 * A custom asset's identity must instead match, field for field, what the
 * server writes for a manual asset (`customAssetRepository.create`):
 * `providerId: 'manual'`, `providerRef: <the asset id>`, `ownerId: <owner>`.
 * `validateCustomAssetFacts` re-checks all three on the way back — over
 * tombstones too — and enable is one-way, so a mismatch would leave the account
 * with no exit but destruction.
 */
function assetSnapshotRow(asset: PortfolioAsset, userId: string): Record<string, unknown> {
  return {
    providerId: asset.isCustom ? 'manual' : CATALOG_PROVIDER_ID,
    providerRef: asset.isCustom ? asset.id : asset.symbol,
    ownerId: asset.isCustom ? userId : null,
    type: asset.type,
    symbol: asset.symbol,
    name: asset.name,
    exchange: asset.exchange,
    currency: asset.currency,
    meta: asset.isCustom
      ? { category: asset.category ?? 'other', smoothing: asset.smoothing === true }
      : null,
    searchText: `${asset.symbol} ${asset.name}`.trim(),
  };
}

/**
 * Tax facts as FROZEN on the row at recording time. `taxMode`/`taxCountry`/
 * `taxParams` are never rewritten by a later mode switch, so the portfolio's
 * *current* settings say nothing about how a historical row was taxed — an
 * account that settled 2024 under AT and later moved to DE must migrate its
 * 2024 sells as AT. The year reports are the only endpoint that exposes them,
 * and enable is one-way and destructive: what cannot be proven is refused, not
 * guessed.
 */
interface FrozenTaxFacts {
  taxMode: TaxMode | null;
  taxCountry: TaxCountry | null;
  taxParams: CustomTaxParams | null;
  taxAmountEur: number | null;
}

const NO_TAX_FACTS: FrozenTaxFacts = {
  taxMode: null,
  taxCountry: null,
  taxParams: null,
  taxAmountEur: null,
};

/** Every sell and dividend in the reports, keyed by row id. */
function frozenTaxFacts(
  reports: Awaited<ReturnType<typeof getTaxYearReport>>[],
): Map<string, FrozenTaxFacts> {
  const result = new Map<string, FrozenTaxFacts>();
  for (const report of reports) {
    for (const position of report.positions) {
      for (const sell of position.sells) {
        result.set(sell.transactionId, {
          taxMode: sell.taxMode,
          taxCountry: sell.taxCountry,
          taxParams: sell.taxParams,
          taxAmountEur: sell.taxAmountEur,
        });
      }
      for (const dividend of position.dividends) {
        result.set(dividend.dividendId, {
          taxMode: dividend.taxMode,
          taxCountry: dividend.taxCountry,
          taxParams: dividend.taxParams,
          taxAmountEur: dividend.taxAmountEur,
        });
      }
    }
  }
  return result;
}

function frozenFactsForTransaction(
  transaction: Transaction,
  recorded: Map<string, FrozenTaxFacts>,
): FrozenTaxFacts {
  // Buys carry no tax facts at all (the server rejects a rehydrated buy that
  // does), so nothing has to be proven for them.
  if (transaction.side !== 'sell') return NO_TAX_FACTS;
  const facts = recorded.get(transaction.id);
  if (facts === undefined) {
    throw new Error(`Vault migration cannot prove the frozen tax facts of sell ${transaction.id}.`);
  }
  // No second read to cross-check against, unlike a dividend: `transactionSchema`
  // exposes no frozen tax columns at all (packages/contracts/src/portfolio.ts),
  // so the year report is the ONLY endpoint that states a sell's recorded
  // mode/country/amount. `assertProvenTaxFacts` is therefore the whole guard.
  return assertProvenTaxFacts(facts, `sell ${transaction.id}`);
}

function frozenFactsForDividend(
  dividend: Dividend,
  recorded: Map<string, FrozenTaxFacts>,
): FrozenTaxFacts {
  const facts = recorded.get(dividend.id);
  if (facts === undefined) {
    throw new Error(
      `Vault migration cannot prove the frozen tax facts of dividend ${dividend.id}.`,
    );
  }
  // The dividend list and the year report read the same frozen columns — this
  // is the one row kind with two independent reads — so a disagreement means
  // one of them is stale: refuse rather than pick a side in a one-way
  // migration.
  if (facts.taxMode !== dividend.taxMode || facts.taxCountry !== dividend.taxCountry) {
    throw new Error(`Vault migration found conflicting tax facts for dividend ${dividend.id}.`);
  }
  return assertProvenTaxFacts(facts, `dividend ${dividend.id}`);
}

/**
 * The frozen-fact shape the server re-checks on rehydration
 * (`paranoidRehydrationService.validFrozenTaxShape`): a country belongs to
 * `country_specific` rows only, a parameter snapshot to `custom` rows only.
 * Anything else would be written into the vault and then hard-purged server
 * side, so it must stop the enable instead.
 */
function assertProvenTaxFacts(facts: FrozenTaxFacts, label: string): FrozenTaxFacts {
  const valid =
    facts.taxMode === 'country_specific'
      ? facts.taxCountry !== null && facts.taxParams === null
      : facts.taxMode === 'custom'
        ? facts.taxCountry === null && facts.taxParams !== null
        : facts.taxCountry === null && facts.taxParams === null;
  if (!valid) {
    throw new Error(`Vault migration read inconsistent frozen tax facts for ${label}.`);
  }
  return facts;
}

function taxSettingRow(userId: string, settings: TaxSettingsResponse, updatedAt: string) {
  return {
    userId,
    mode: settings.mode,
    country: settings.country,
    manualDefaultAmountEur:
      settings.manualDefaultAmountEur == null ? null : decimal(settings.manualDefaultAmountEur),
    manualDefaultRatePct:
      settings.manualDefaultRatePct == null ? null : decimal(settings.manualDefaultRatePct),
    customParams: settings.custom ?? null,
    updatedAt,
  };
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Vault migration encountered a non-finite number.');
  const source = String(value);
  if (!/[eE]/.test(source)) return source;
  const [coefficient = '0', exponentSource = '0'] = source.toLowerCase().split('e');
  const exponent = Number(exponentSource);
  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole = '', fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  const expanded =
    decimalIndex <= 0
      ? `0.${'0'.repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${'0'.repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return negative ? `-${expanded}` : expanded;
}
