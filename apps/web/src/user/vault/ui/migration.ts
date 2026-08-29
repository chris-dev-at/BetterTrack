import {
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_ENTITY_ROW_SCHEMAS,
  type CustomTaxParams,
  type CashMovement,
  type CashMovementsResponse,
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

import { getAssetDetail } from '../../../lib/assetApi';
import { listAllCashBudgets, listCashRules, listCashTags } from '../../../lib/cashApi';
import {
  listExpenseBudgets,
  listExpenseCategories,
  listExpenseRules,
  listExpenseTransactions,
} from '../../../lib/expensesApi';
import { getTaxYearReport, getTaxYearReports, listDividends } from '../../../lib/portfolioApi';
import { apiPortfolioStore, type PortfolioStore } from '../../../lib/portfolioStore';
import { listStandingOrderRuns } from '../../../lib/standingOrdersApi';
import { getParanoidNormalRevision } from '../../../lib/userApi';
import { markRateLimitHandledLocally } from '../../../lib/apiClient';
import { assetSnapshotRow } from '../assetSnapshot';
import { emptyVaultDocument } from './enable';

export interface NormalVaultCaptureProgress {
  completedRequests: number;
}

export interface CaptureRequestScheduler {
  run<T>(request: () => Promise<T>): Promise<T>;
}

export interface CaptureRequestSchedulerOptions {
  signal: AbortSignal;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onRequestStart?: (startedAt: number) => void;
}

export interface NormalVaultMigrationOptions {
  userId: string;
  deviceId?: string;
  store?: PortfolioStore;
  now?: () => string;
  id?: () => string;
  signal?: AbortSignal;
  onProgress?: (progress: NormalVaultCaptureProgress) => void;
  /** Injectable only so capture protocol tests do not spend real rate-limit time. */
  requestScheduler?: CaptureRequestScheduler;
}

/**
 * A capture is the document AND the token that binds it to the commit. They
 * travel together deliberately: an enable that shipped the document alone would
 * be exactly the unguarded read-then-destroy this type exists to prevent.
 */
export interface NormalVaultCapture {
  document: VaultDocument;
  /**
   * `GET /account/paranoid/normal-revision`, read before the FIRST row read of
   * the accepted pass AND unchanged when re-read after its last — so this token
   * covers the whole build, not just its opening instant.
   */
  normalDataRevision: string;
}

/**
 * How many times a capture will rebuild its document trying to land on a server
 * state that did not move underneath it. Two, because every write the capture
 * itself provokes is one-shot: the lazy seeds below insert only when their table
 * is empty for this account, and the tax reconciler posts nothing once the open
 * year's correction delta is zero. A settled read is therefore always reached on
 * the second pass; a third would only paper over an account something else is
 * actively writing, which has to fail loudly instead.
 */
export const CAPTURE_STABILITY_ATTEMPTS = 2;

/**
 * The general limiter allows 60 requests per ten seconds. Capture deliberately
 * owns only one third of that window, leaving room for the login/dashboard
 * reads that opened the wizard and for ordinary background refetches.
 */
export const CAPTURE_REQUEST_WINDOW_MS = 10_000;
export const CAPTURE_REQUEST_BUDGET = 20;
export const CAPTURE_REQUEST_MIN_SPACING_MS =
  Math.floor(CAPTURE_REQUEST_WINDOW_MS / CAPTURE_REQUEST_BUDGET) + 1;

/**
 * Serialize capture reads and space their starts so every rolling ten-second
 * window stays within {@link CAPTURE_REQUEST_BUDGET}. The queue stops before
 * starting any more reads after the first failure.
 */
export function createCaptureRequestScheduler({
  signal,
  now = monotonicNow,
  wait = waitForCaptureBudget,
  onRequestStart,
}: CaptureRequestSchedulerOptions): CaptureRequestScheduler {
  let tail: Promise<void> = Promise.resolve();
  let lastStartedAt: number | null = null;
  let stopped = false;
  let failure: unknown;

  return {
    run<T>(request: () => Promise<T>): Promise<T> {
      const scheduled = tail.then(async () => {
        if (stopped) throw failure;
        signal.throwIfAborted();
        if (lastStartedAt != null) {
          const remaining = lastStartedAt + CAPTURE_REQUEST_MIN_SPACING_MS - now();
          if (remaining > 0) await wait(remaining, signal);
        }
        signal.throwIfAborted();
        lastStartedAt = now();
        onRequestStart?.(lastStartedAt);
        try {
          return await request();
        } catch (cause) {
          stopped = true;
          failure = cause;
          throw cause;
        }
      });
      tail = scheduled.then(
        () => undefined,
        () => undefined,
      );
      return scheduled;
    },
  };
}

type CaptureRead = <T>(request: () => Promise<T>) => Promise<T>;

const immediateCaptureRead: CaptureRead = (request) => request();

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function waitForCaptureBudget(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function linkedCaptureSignal(parent?: AbortSignal): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) relayAbort();
  else parent?.addEventListener('abort', relayAbort, { once: true });
  markRateLimitHandledLocally(controller.signal);
  return {
    signal: controller.signal,
    release: () => parent?.removeEventListener('abort', relayAbort),
  };
}

/**
 * The account would not hold still: the revision moved across the document build
 * on every attempt, so no document this client built provably matches the state
 * the enable commit would purge.
 *
 * Deliberately its own type, and deliberately fatal. Shipping the newest token
 * with the older document — or the older token, hoping the server disagrees
 * politely — is precisely the "CAS passes, rows missing" outcome the token
 * exists to prevent. The wizard maps this to copy that names the real cause
 * (something else is writing to the account) instead of the generic
 * "collection failed" retry advice.
 */
export class VaultCaptureUnstableError extends Error {
  constructor(readonly attempts: number) {
    super(
      `The normal account changed during ${attempts} consecutive capture attempts; no stable copy could be taken.`,
    );
    this.name = 'VaultCaptureUnstableError';
  }
}

/**
 * Read the complete currently-restorable normal-account graph before enable,
 * bound to the server revision it was read at.
 *
 * Protocol: read the token, build the document, read the token AGAIN, and accept
 * the pair only when the two agree — validate-then-accept, not read-then-hope.
 * The accepted token's window therefore provably contains the whole document
 * build, which is the property the server's compare-and-swap (re-derived under
 * the account lock, immediately before the first destructive statement) needs in
 * order to mean anything.
 *
 * The second read is not extra caution about other sessions. THE CAPTURE'S OWN
 * READS WRITE. Five of them seed or self-heal rows in tables the revision hashes:
 *
 * - `GET /portfolios` materializes "Main" (`portfolios`);
 * - `GET /portfolios/:id/cash` materializes its main source
 *   (`portfolio_cash_sources`);
 * - `GET …/reports/tax-years` and `…/tax-years/:year` run the #635 self-heal,
 *   posting each documented year's pending tax correction (`portfolio_cash_movements`,
 *   and through the auto-tagger `cash_movement_tags` / `cash_tags`);
 * - `GET /cash/tags` seeds the app-owned system tags (`cash_tags`).
 *
 * (`GET /expenses/categories` used to seed the retired area's starter set too;
 * it is a pure read since #1550.)
 *
 * Three of those are self-covering — the read that seeds also returns what it
 * seeded. The tax reconciler is not: it inserts CASH MOVEMENTS, while
 * `getCashMovements` sits in the same `Promise.all` as the year list and runs
 * strictly before the per-year reports. Those corrections are missing from the
 * very `cash` array the document ships. A single-pass capture is therefore not
 * merely stale, it is INCOMPLETE — and enable hard-deletes the rows it missed
 * while disable restores from the document alone.
 *
 * So the mismatch is discarded whole and the document rebuilt; the second pass
 * reads state its own first pass already settled, and its `cash` array contains
 * the corrections the first pass provoked.
 *
 * Derived snapshots/import staging/fire ledgers are deliberately omitted: PD3
 * marks them purge-only and re-derives their successors after rehydration.
 */
export async function captureNormalVault(
  options: NormalVaultMigrationOptions,
): Promise<NormalVaultCapture> {
  const captureSignal = linkedCaptureSignal(options.signal);
  const scheduler =
    options.requestScheduler ?? createCaptureRequestScheduler({ signal: captureSignal.signal });
  let completedRequests = 0;
  const read: CaptureRead = async (request) => {
    const result = await scheduler.run(request);
    completedRequests += 1;
    options.onProgress?.({ completedRequests });
    return result;
  };
  const captureOptions = { ...options, signal: captureSignal.signal };

  try {
    let revision = (await read(() => getParanoidNormalRevision(captureSignal.signal))).revision;
    for (let attempt = 1; attempt <= CAPTURE_STABILITY_ATTEMPTS; attempt += 1) {
      const document = await buildNormalVaultDocument(captureOptions, read);
      const settled = (await read(() => getParanoidNormalRevision(captureSignal.signal))).revision;
      if (settled === revision) return { document, normalDataRevision: revision };
      // Carry the closing token into the next attempt as its opening one: nothing
      // runs between the two, so the window the next document is judged against is
      // at worst slightly wider than that build. Wider can only refuse a capture
      // that was fine — never accept one that was not.
      revision = settled;
    }
    throw new VaultCaptureUnstableError(CAPTURE_STABILITY_ATTEMPTS);
  } finally {
    captureSignal.release();
  }
}

/** The row-reading half of {@link captureNormalVault}; exported for tests. */
export async function buildNormalVaultDocument(
  options: NormalVaultMigrationOptions,
  read: CaptureRead = immediateCaptureRead,
): Promise<VaultDocument> {
  const store = options.store ?? apiPortfolioStore;
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? (() => globalThis.crypto.randomUUID());
  const deviceId = options.deviceId ?? id();
  const signal = options.signal;
  const document = emptyVaultDocument();
  if (document.schemaVersion !== VAULT_DOCUMENT_V1_VERSION) return document;

  const buckets = new Map<VaultEntityKind, VaultEntity[]>();
  // Every entity kind that references an asset MUST contribute to this map so
  // the emitted local asset table is complete: transactions and dividends via
  // their embedded DTO asset, custom assets via the owner's full list, and
  // standing orders via an explicit asset read below (their list DTO names an
  // id but carries no type/currency/exchange). A reference this map misses
  // would unlock as `VAULT_CORRUPT` — after the irreversible purge.
  const assets = new Map<string, PortfolioAsset & { providerId?: string; providerRef?: string }>();
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

  const portfolios = await read(() => store.listPortfolios(signal, true));
  const portfolioFacts = await Promise.all(
    portfolios.portfolios.map(async (portfolio) => {
      signal?.throwIfAborted();
      const [transactions, cash, dividends, tax, taxYears] = await Promise.all([
        listAllTransactions(store, portfolio.id, signal, read),
        listAllCashMovements(store, portfolio.id, signal, read),
        read(() => listDividends(portfolio.id, undefined, signal)),
        read(() => store.getPortfolioTaxSettings(portfolio.id, signal)),
        read(() => getTaxYearReports(portfolio.id, signal)),
      ]);
      const reports = await Promise.all(
        taxYears.years.map((year) => read(() => getTaxYearReport(portfolio.id, year.year, signal))),
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
        // Board #69: captured with the row, or enable→disable would silently
        // reset every portfolio's Icon (the #729 irreversible-loss class).
        kind: portfolio.kind ?? null,
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
      // The movement's tag links (V5 cash fusion) — system tags stamped at book
      // time plus any user tags. The ledger DTO carries only the tag ids, so
      // synthesize a join-row id; the (movementId, tagId) pair is the identity
      // the restore actually keys on. Absent when a surface has not served tags.
      for (const tagId of movement.tags ?? []) {
        append('cashMovementTag', id(), {
          movementId: movement.id,
          tagId,
          createdAt: movement.createdAt,
        });
      }
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

  const customAssets = await read(() => store.listCustomAssets(signal));
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

  // A pending `buy-asset` standing order may reference an asset the account has
  // never traded — nothing above has snapshotted it. The list DTO carries only
  // `assetId`/`assetSymbol`/`assetName`, so resolve the full asset before the
  // local asset table is emitted; a reference that cannot be resolved refuses
  // the enable rather than migrating a dangling id.
  const standingOrders = await read(() => store.listStandingOrders(undefined, signal));
  for (const order of standingOrders.orders) {
    const assetId = order.assetId;
    if (assetId == null || assets.has(assetId)) continue;
    signal?.throwIfAborted();
    const detail = await read(() => getAssetDetail(assetId, signal));
    if (detail.asset.isCustom) {
      // Owner customs were listed exhaustively above; a custom asset resolving
      // only here has ownership facts this client cannot prove. Refuse.
      throw new Error(
        `Vault migration cannot prove ownership of asset ${assetId} referenced by standing order ${order.id}.`,
      );
    }
    assets.set(assetId, detail.asset);
  }

  for (const asset of assets.values()) {
    append('customAsset', asset.id, assetSnapshotRow(asset, options.userId));
    if (asset.isCustom) {
      const points = await read(() => store.getValuePoints(asset.id, signal));
      for (const point of points.points) {
        append('customAssetValue', id(), {
          assetId: asset.id,
          date: point.date,
          close: decimal(point.value),
        });
      }
    }
  }

  const userTax = await read(() => store.getTaxSettings(signal));
  append('taxSetting', id(), taxSettingRow(options.userId, userTax, now()));

  // The authoritative exactly-once ledger, read RAW — not reconstructed from the
  // order's `lastPeriodKey`/`lastRunAt` watermark. The engine claims a period
  // BEFORE it books and deliberately leaves the claim behind as an un-retried
  // tombstone when booking (or `markBooked`) fails afterwards, so a claim can
  // legally exist that no watermark mentions. Synthesizing runs from the
  // watermark dropped exactly those rows — and since enable hard-purges
  // `standing_order_runs` and disable restores it from this document alone, the
  // scheduler would afterwards re-book a period that was intentionally closed:
  // a duplicate money booking. Every row rides, under its real id.
  const runLedger = await read(() => listStandingOrderRuns(signal));
  const orderIds = new Set(standingOrders.orders.map((order) => order.id));
  const capturedRuns = new Set<string>();
  for (const run of runLedger.runs) {
    if (!orderIds.has(run.standingOrderId)) {
      // The ledger is scoped to the caller's own orders server-side, so this can
      // only mean the two reads raced an order deletion. Refuse rather than
      // migrate a dangling claim the restore boundary would reject after the
      // purge.
      throw new Error(
        `Vault migration read a standing-order run for unknown order ${run.standingOrderId}.`,
      );
    }
    append('standingOrderRun', run.id, {
      standingOrderId: run.standingOrderId,
      periodKey: run.periodKey,
      bookedAt: run.bookedAt,
    });
    capturedRuns.add(runKey(run.standingOrderId, run.periodKey));
  }

  for (const order of standingOrders.orders) {
    // The invariant the RESTORE enforces ("a standing-order run watermark
    // requires its authoritative run row") — checked here, before the purge,
    // because the server only checks it at disable, when the cleartext rows are
    // already gone and refusing means the account cannot leave paranoid mode.
    if (order.lastPeriodKey != null && !capturedRuns.has(runKey(order.id, order.lastPeriodKey))) {
      throw new Error(
        `Vault migration read no run row for the booked period ${order.lastPeriodKey} of standing order ${order.id}.`,
      );
    }
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
  }

  const [categories, expenseTransactions, rules, budgets] = await Promise.all([
    read(() => listExpenseCategories(signal)),
    listAllExpenseTransactions(signal, read),
    read(() => listExpenseRules(signal)),
    read(() => listExpenseBudgets(undefined, signal)),
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

  // V5 cash fusion — the tag / rule / budget layer on the cash ledger. Every one
  // of these tables is `vault`-classified: enable hard-purges them server-side
  // and disable restores them from the document ALONE, so a row that never
  // reaches the vault is lost for good on the one-way round trip. Tags are
  // account-scoped (system tags stamped at book time plus user tags); rules and
  // their tag links likewise; budgets are per portfolio and read RAW (all
  // periods) because the per-month progress list cannot enumerate other months'
  // month-specific rows.
  const [cashTags, cashRules, cashBudgets] = await Promise.all([
    read(() => listCashTags(signal)),
    read(() => listCashRules(signal)),
    read(() => listAllCashBudgets(signal)),
  ]);
  for (const tag of cashTags.tags) {
    append(
      'cashTag',
      tag.id,
      {
        userId: options.userId,
        name: tag.name,
        color: tag.color,
        system: tag.system,
        systemKey: tag.systemKey,
        createdAt: tag.createdAt,
        updatedAt: tag.updatedAt,
      },
      tag.updatedAt,
    );
  }
  for (const rule of cashRules.rules) {
    append(
      'cashRule',
      rule.id,
      {
        userId: options.userId,
        matchType: rule.matchType,
        pattern: rule.pattern,
        priority: rule.priority,
        enabled: rule.enabled,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      },
      rule.updatedAt,
    );
    for (const tagId of rule.tagIds) {
      append('cashRuleTag', id(), {
        ruleId: rule.id,
        tagId,
        createdAt: rule.createdAt,
      });
    }
  }
  for (const budget of cashBudgets.budgets) {
    append(
      'cashBudget',
      budget.id,
      {
        portfolioId: budget.portfolioId,
        tagId: budget.tagId,
        periodKey: budget.period,
        amount: decimal(budget.amount),
        currency: budget.currency,
        createdAt: budget.createdAt,
        updatedAt: budget.updatedAt,
      },
      budget.updatedAt,
    );
  }

  return {
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities: Object.fromEntries(buckets),
    mergeLog: [],
  };
}

/** The (order, period) pair the run ledger and the order watermark share. */
export function runKey(standingOrderId: string, periodKey: string): string {
  return `${standingOrderId}\u0000${periodKey}`;
}

export async function listAllTransactions(
  store: PortfolioStore,
  portfolioId: string,
  signal?: AbortSignal,
  read: CaptureRead = immediateCaptureRead,
): Promise<Transaction[]> {
  const rows: Transaction[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(() =>
      store.listTransactions(portfolioId, { cursor, limit: 200 }, signal),
    );
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor != null);
  return rows;
}

/** Drain the paged cash ledger: migration must capture every row before purge. */
export async function listAllCashMovements(
  store: PortfolioStore,
  portfolioId: string,
  signal?: AbortSignal,
  read: CaptureRead = immediateCaptureRead,
): Promise<CashMovementsResponse> {
  const movements: CashMovement[] = [];
  let firstPage: CashMovementsResponse | undefined;
  let cursor: string | undefined;
  do {
    const page = await read(() =>
      store.getCashMovements(portfolioId, { cursor, limit: 200 }, signal),
    );
    firstPage ??= page;
    movements.push(...page.movements);
    cursor = page.nextCursor ?? undefined;
  } while (cursor != null);
  if (!firstPage) throw new Error('Cash ledger pagination returned no first page.');
  return { ...firstPage, movements, nextCursor: null };
}

/**
 * The expense endpoint has no cursor. Page by booking day and re-read the
 * boundary day so a page split never drops rows. If one day itself reaches the
 * endpoint cap, abort before enable—the client cannot prove completeness.
 */
async function listAllExpenseTransactions(
  signal?: AbortSignal,
  read: CaptureRead = immediateCaptureRead,
): Promise<ExpenseTransaction[]> {
  const rows = new Map<string, ExpenseTransaction>();
  let to: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await read(() =>
      listExpenseTransactions({ limit: 500, ...(to ? { to } : {}) }, signal),
    );
    if (page.transactions.length < 500) {
      for (const transaction of page.transactions) rows.set(transaction.id, transaction);
      return [...rows.values()];
    }

    const boundaryDay = page.transactions.at(-1)?.bookedOn;
    if (boundaryDay == null) {
      throw new Error('Expense migration could not establish a complete page boundary.');
    }
    const boundary = await read(() =>
      listExpenseTransactions({ from: boundaryDay, to: boundaryDay, limit: 500 }, signal),
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

/**
 * Tax facts as FROZEN on the row at recording time. `taxMode`/`taxCountry`/
 * `taxParams` are never rewritten by a later mode switch, so the portfolio's
 * *current* settings say nothing about how a historical row was taxed — an
 * account that settled 2024 under AT and later moved to DE must migrate its
 * 2024 sells as AT. The year reports are the only endpoint that exposes them,
 * and enable is one-way and destructive: what cannot be proven is refused, not
 * guessed.
 */
export interface FrozenTaxFacts {
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
export function frozenTaxFacts(
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

export function frozenFactsForTransaction(
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

export function frozenFactsForDividend(
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

export function decimal(value: number): string {
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
