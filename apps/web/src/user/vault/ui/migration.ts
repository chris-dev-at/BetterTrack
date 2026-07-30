import {
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_ENTITY_ROW_SCHEMAS,
  type PortfolioAsset,
  type PortfolioTaxSettingsResponse,
  type ExpenseTransaction,
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

    const recordedTax = transactionTaxFacts(fact.reports);
    for (const transaction of fact.transactions) {
      assets.set(transaction.asset.id, transaction.asset);
      const taxFact = recordedTax.get(transaction.id);
      const settings = taxSettingsForRecordedMode(taxFact?.taxMode ?? null, fact.tax);
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
          taxMode: taxFact?.taxMode ?? null,
          taxCountry: settings.country,
          taxAmountEur: taxFact?.taxAmountEur == null ? null : decimal(taxFact.taxAmountEur),
          taxParams: settings.custom,
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
      const settings = taxSettingsForRecordedMode(dividend.taxMode, fact.tax);
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
          taxParams: settings.custom,
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
    append('customAsset', asset.id, {
      providerId: asset.isCustom ? 'manual' : 'yahoo',
      providerRef: asset.symbol,
      ownerId: asset.isCustom ? options.userId : null,
      type: asset.type,
      symbol: asset.symbol,
      name: asset.name,
      exchange: asset.exchange,
      currency: asset.currency,
      meta: asset.isCustom
        ? { category: asset.category ?? 'other', smoothing: asset.smoothing === true }
        : null,
      searchText: `${asset.symbol} ${asset.name}`.trim(),
    });
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

function transactionTaxFacts(
  reports: Awaited<ReturnType<typeof getTaxYearReport>>[],
): Map<string, { taxMode: TransactionTaxMode; taxAmountEur: number | null }> {
  const result = new Map<string, { taxMode: TransactionTaxMode; taxAmountEur: number | null }>();
  for (const report of reports) {
    for (const position of report.positions) {
      for (const sell of position.sells) {
        result.set(sell.transactionId, {
          taxMode: sell.taxMode,
          taxAmountEur: sell.taxAmountEur,
        });
      }
    }
  }
  return result;
}

type TransactionTaxMode = TaxSettingsResponse['mode'] | null;

function taxSettingsForRecordedMode(
  mode: TransactionTaxMode,
  settings: PortfolioTaxSettingsResponse,
): { country: TaxSettingsResponse['country']; custom: TaxSettingsResponse['custom'] | null } {
  const source = settings.override ?? settings.effective;
  return {
    country: mode === 'country_specific' ? source.country : null,
    custom: mode === 'custom' ? (source.custom ?? null) : null,
  };
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
