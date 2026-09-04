import { QTY_EPSILON } from '@bettertrack/domain/holdings';
import { count, eq, inArray, or } from 'drizzle-orm';

import type { Database } from '../../data/db';
import {
  alerts,
  announcementDismissals,
  apiKeys,
  assets,
  cashBudgets,
  cashMovementTags,
  cashRuleTags,
  cashRules,
  cashTags,
  chatConversations,
  chatMessages,
  conglomeratePositions,
  conglomerates,
  dividends,
  expenseBudgets,
  expenseCategories,
  expenseRules,
  expenseTransactions,
  externalIdentities,
  feedback,
  feedbackMessages,
  friendRequests,
  friendships,
  ideas,
  itemFollows,
  notificationSettings,
  notifications,
  oauthClients,
  oauthGrants,
  portfolioCashMovements,
  portfolioCashSources,
  portfolioSettings,
  portfolios,
  priceHistory,
  shareAudienceLinks,
  shareAudienceMembers,
  shareAudiences,
  shareLinks,
  sharedItemActivityPrefs,
  taxYearChanges,
  transactions,
  userFollows,
  userTaxSettings,
  users,
  watchlists,
  workboardItems,
} from '../../data/schema';

import { EXPORT_MAX_ROWS, ExportTooLargeError } from './limits';
import { EXPORTED_ENTITY_NAMES, PARANOID_SERVER_EXPORTED_ENTITY_NAMES } from './manifest';

/**
 * The assembled contents of one user's export (§13.4 V4-P6a, #494), before zip
 * packaging: one JSON-serializable array per exported entity, plus the three
 * derived CSVs (transactions / cash movements / holdings). Rows are sanitized —
 * every secret/credential column is stripped — and only the requesting user's
 * rows are ever selected.
 */
export interface CollectedExport {
  /** Entity name → its rows (keys match {@link EXPORTED_ENTITY_NAMES}). */
  entities: Record<string, unknown[]>;
  csv: {
    transactions: string;
    cashMovements: string;
    holdings: string;
  };
}

/**
 * Decimal places of the `numeric(20,8)` quantity columns the holdings CSV sums.
 * A net position is only meaningful to this scale, so anything past it is float
 * artefact from the summation, not data.
 */
const QUANTITY_SCALE = 8;

/**
 * Columns never written to an export, matched by their (camelCase) property name
 * as Drizzle returns them: password/token/secret hashes, the raw legacy share
 * token, and opaque binary caches. Stripping is by key name so a future sensitive
 * column on an already-exported table is dropped by default rather than leaked.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'passwordHash',
  'securityGeneration',
  'twoFactorSecret',
  'pinHash',
  'tokenHash',
  'clientSecretHash',
  'logoBytes',
  'codeHash',
  'downloadTokenHash',
  'token',
]);

/** Columns whose meaning is sensitive only on one exported entity. */
const ENTITY_SENSITIVE_KEYS = {
  // The OIDC `sub` is an opaque provider identifier. Feedback subjects with the
  // same property name are user-authored account data and must remain exported.
  externalIdentities: new Set(['subject']),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

type EntityWithSensitiveKeys = keyof typeof ENTITY_SENSITIVE_KEYS;

function stripSensitive<T extends Record<string, unknown>>(
  row: T,
  entity?: EntityWithSensitiveKeys,
): Record<string, unknown> {
  const entitySensitiveKeys = entity ? ENTITY_SENSITIVE_KEYS[entity] : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!SENSITIVE_KEYS.has(key) && !entitySensitiveKeys?.has(key)) out[key] = value;
  }
  return out;
}

function sanitize(
  rows: Record<string, unknown>[],
  entity?: EntityWithSensitiveKeys,
): Record<string, unknown>[] {
  return rows.map((row) => stripSensitive(row, entity));
}

/**
 * The submitter-visible columns of the `feedback` table (#1470). The export ZIP
 * is the submitter's copy of their own submissions, so the collector projects
 * this set explicitly instead of selecting the row: the admin-workspace columns
 * (`archivedAt` from #1443, `adminLastReadAt` from #1339) are invisible on every
 * submitter surface — `/feedback/mine` and the thread routes never render them —
 * and the export must not be the one place they leak. Projecting rather than
 * denylisting also fails closed: a future admin-side column added to the table
 * without touching this file stays out of the ZIP by default.
 */
const FEEDBACK_EXPORT_COLUMNS = {
  id: feedback.id,
  userId: feedback.userId,
  category: feedback.category,
  subject: feedback.subject,
  message: feedback.message,
  context: feedback.context,
  status: feedback.status,
  lastStatusChangeAt: feedback.lastStatusChangeAt,
  declinedReason: feedback.declinedReason,
  shippedVersion: feedback.shippedVersion,
  submitterLastReadAt: feedback.submitterLastReadAt,
  deletedByUserAt: feedback.deletedByUserAt,
  createdAt: feedback.createdAt,
  updatedAt: feedback.updatedAt,
} as const;

/**
 * Support-thread replies from staff belong in the export — their bodies were
 * addressed to this user — but `authorUserId` on an admin-side row is the
 * replying account's internal id, identity the product never surfaces to a user
 * anywhere else. Project it to null; `authorSide: 'admin'` already carries the
 * meaning. Submitter-authored rows keep their (own) id verbatim.
 */
function projectFeedbackMessages(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => (row.authorSide === 'admin' ? { ...row, authorUserId: null } : row));
}

/**
 * One CSV cell: JSON-safe stringify, quoting anything with a comma/quote/newline.
 * Also neutralizes spreadsheet formula injection — a leading `=`, `+`, `-`, `@`
 * (or tab/CR) in user-controlled text (e.g. `transactions.note`) is prefixed with
 * a single quote so Excel/Sheets render the cell as literal text instead of
 * evaluating it. Genuine numbers (incl. negatives like `-100.5`) are left intact.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const risky = /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw);
  const s = risky ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  // Trailing newline so the file is a well-formed text file even when empty.
  return `${lines.join('\n')}\n`;
}

/**
 * Invariant guard: the collector must assemble EXACTLY the entities the
 * classification claims are exported — both directions.
 *
 *  - a declared entity the collector never builds would ship an empty file that
 *    silently claims coverage;
 *  - a STRAY entity the collector builds whose table is still classified `skip`
 *    is the more dangerous direction, because the manifest's `skippedTables`
 *    would tell the reader that data is absent while the ZIP contains it.
 *
 * The stray direction is why this runs on the FULL assembled set rather than on
 * the already-narrowed one: filtering by the allowed set first (as this guard
 * did until #1711) discards the stray before it can be reported, leaving only
 * the missing direction detectable. `serverOnly` narrowing is a mechanical
 * subset of the declared set, so checking the full set covers both modes.
 */
export function assertCollectorCoverage(built: readonly string[]): void {
  const declared = new Set(EXPORTED_ENTITY_NAMES);
  const stray = [...built].filter((entity) => !declared.has(entity)).sort();
  const seen = new Set(built);
  const missing = EXPORTED_ENTITY_NAMES.filter((entity) => !seen.has(entity));
  if (stray.length > 0 || missing.length > 0) {
    throw new Error(
      `export collector/manifest drift: missing [${missing.join(', ')}], stray [${stray.join(', ')}]`,
    );
  }
}

/**
 * Collect every user-owned entity for `userId` into a {@link CollectedExport}.
 * Ownership is resolved up front for the indirected tables (a portfolio's
 * transactions/cash, a conglomerate's positions/links, an audience's members,
 * a custom asset's price points) so every query is strictly the caller's rows.
 */
export async function collectUserExport(
  db: Database,
  userId: string,
  options: { serverOnly?: boolean; maxRows?: number } = {},
): Promise<CollectedExport> {
  const maxRows = options.maxRows ?? EXPORT_MAX_ROWS;
  // Owner-id sets that the indirected tables key off. Resolved first so their
  // dependents can `inArray` on them (empty set ⇒ no rows, never a broad scan).
  const [portfolioRows, conglomerateRows, audienceRows, customAssetRows, feedbackRows] =
    await Promise.all([
      db
        .select({ id: portfolios.id, vaultId: portfolios.vaultId })
        .from(portfolios)
        .where(eq(portfolios.userId, userId)),
      db
        .select({ id: conglomerates.id })
        .from(conglomerates)
        .where(eq(conglomerates.ownerId, userId)),
      db
        .select({ id: shareAudiences.id })
        .from(shareAudiences)
        .where(eq(shareAudiences.ownerId, userId)),
      db.select({ id: assets.id }).from(assets).where(eq(assets.ownerId, userId)),
      db.select(FEEDBACK_EXPORT_COLUMNS).from(feedback).where(eq(feedback.userId, userId)),
    ]);
  // A vault-backed portfolio row is only a locked config stub. Its cleartext
  // descendants are forbidden by the per-vault model, but filter them here too
  // as a fail-closed export boundary in case stale/invalid rows survive a race or
  // an interrupted move-in. The stub itself remains ordinary account config.
  const cleartextPortfolioIds = portfolioRows.filter((r) => r.vaultId === null).map((r) => r.id);
  const conglomerateIds = conglomerateRows.map((r) => r.id);
  const audienceIds = audienceRows.map((r) => r.id);
  const customAssetIds = customAssetRows.map((r) => r.id);
  const feedbackIds = feedbackRows.map((r) => r.id);

  /** Query a table only when its owner-id set is non-empty. */
  const inIds = async <T>(ids: string[], run: (ids: string[]) => Promise<T[]>): Promise<T[]> =>
    ids.length === 0 ? [] : run(ids);

  // ── Pre-flight row ceiling (#1714) ────────────────────────────────────────
  // The collection below materializes every row of every exported table at
  // once, and the packaging then copies those rows three more times. Counting
  // the append-only tables first — the only ones that grow without a user
  // action per row — refuses a runaway account BEFORE a single row is
  // allocated, so an oversized export fails cleanly instead of OOM-killing the
  // worker that hosts every other background job.
  const countRows = async (rows: PromiseLike<{ value: number }[]>): Promise<number> =>
    Number((await rows)[0]?.value ?? 0);
  /** Count only when the owner-id set is non-empty (an empty set is zero rows). */
  const countScoped = async (
    ids: string[],
    run: (ids: string[]) => PromiseLike<{ value: number }[]>,
  ): Promise<number> => (ids.length === 0 ? 0 : countRows(run(ids)));
  const growthRows = await Promise.all([
    countScoped(cleartextPortfolioIds, (ids) =>
      db
        .select({ value: count() })
        .from(transactions)
        .where(inArray(transactions.portfolioId, ids)),
    ),
    countScoped(cleartextPortfolioIds, (ids) =>
      db
        .select({ value: count() })
        .from(portfolioCashMovements)
        .where(inArray(portfolioCashMovements.portfolioId, ids)),
    ),
    countScoped(cleartextPortfolioIds, (ids) =>
      db.select({ value: count() }).from(dividends).where(inArray(dividends.portfolioId, ids)),
    ),
    countScoped(customAssetIds, (ids) =>
      db.select({ value: count() }).from(priceHistory).where(inArray(priceHistory.assetId, ids)),
    ),
    countRows(
      db.select({ value: count() }).from(notifications).where(eq(notifications.userId, userId)),
    ),
    countRows(
      db.select({ value: count() }).from(chatMessages).where(eq(chatMessages.senderId, userId)),
    ),
    // The expense ledger is the expense area's analogue of `transactions`: an
    // append-only, user-scoped table this export now materializes in full
    // (V5-P9). The remaining expense/cash-fusion tables are per-user config
    // (categories, rules, budgets, tags) or link rows whose count is the
    // counted movements times the hand-created tags applied to each, so they
    // stay out of the pre-flight for the same reason the other config tables
    // do: the multiplier is a user action per row, not growth.
    countRows(
      db
        .select({ value: count() })
        .from(expenseTransactions)
        .where(eq(expenseTransactions.userId, userId)),
    ),
  ]);
  const totalGrowthRows = growthRows.reduce((sum, value) => sum + value, 0);
  if (totalGrowthRows > maxRows) {
    throw new ExportTooLargeError('rows', totalGrowthRows, maxRows);
  }

  const [
    accountRows,
    apiKeyRows,
    externalIdentityRows,
    oauthClientRows,
    oauthGrantRows,
    watchlistRows,
    workboardItemRows,
    alertRows,
    notificationRows,
    notificationSettingRows,
    feedbackMessageRows,
    ideaRows,
    taxSettingRows,
    taxYearChangeRows,
    friendRequestRows,
    friendshipRows,
    userFollowRows,
    shareAudienceRowsFull,
    sharedItemActivityPrefRows,
    itemFollowRows,
    chatConversationRows,
    chatMessageRows,
    announcementDismissalRows,
    transactionRows,
    cashSourceRows,
    dividendRows,
    cashMovementRows,
    portfolioSettingRows,
    conglomerateFull,
    conglomeratePositionRows,
    conglomerateShareLinkRows,
    shareAudienceMemberRows,
    shareAudienceLinkRows,
    customAssetFull,
    customAssetPriceRows,
    portfolioFull,
    expenseCategoryRows,
    expenseTransactionRows,
    expenseRuleRows,
    expenseBudgetRows,
    cashTagRows,
    cashBudgetRows,
    cashRuleRows,
  ] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)),
    db.select().from(apiKeys).where(eq(apiKeys.userId, userId)),
    db.select().from(externalIdentities).where(eq(externalIdentities.userId, userId)),
    db.select().from(oauthClients).where(eq(oauthClients.userId, userId)),
    db.select().from(oauthGrants).where(eq(oauthGrants.userId, userId)),
    db.select().from(watchlists).where(eq(watchlists.userId, userId)),
    db.select().from(workboardItems).where(eq(workboardItems.userId, userId)),
    db.select().from(alerts).where(eq(alerts.userId, userId)),
    db.select().from(notifications).where(eq(notifications.userId, userId)),
    db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)),
    inIds(feedbackIds, (ids) =>
      db.select().from(feedbackMessages).where(inArray(feedbackMessages.feedbackId, ids)),
    ),
    db.select().from(ideas).where(eq(ideas.ownerId, userId)),
    db.select().from(userTaxSettings).where(eq(userTaxSettings.userId, userId)),
    db.select().from(taxYearChanges).where(eq(taxYearChanges.userId, userId)),
    db
      .select()
      .from(friendRequests)
      .where(or(eq(friendRequests.fromUser, userId), eq(friendRequests.toUser, userId))),
    db
      .select()
      .from(friendships)
      .where(or(eq(friendships.userA, userId), eq(friendships.userB, userId))),
    db
      .select()
      .from(userFollows)
      .where(or(eq(userFollows.followerId, userId), eq(userFollows.followedId, userId))),
    db.select().from(shareAudiences).where(eq(shareAudiences.ownerId, userId)),
    db.select().from(sharedItemActivityPrefs).where(eq(sharedItemActivityPrefs.viewerId, userId)),
    db.select().from(itemFollows).where(eq(itemFollows.userId, userId)),
    db
      .select()
      .from(chatConversations)
      .where(or(eq(chatConversations.userA, userId), eq(chatConversations.userB, userId))),
    // A user's OWN authored messages only — never the partner's content.
    db.select().from(chatMessages).where(eq(chatMessages.senderId, userId)),
    db.select().from(announcementDismissals).where(eq(announcementDismissals.userId, userId)),
    inIds(cleartextPortfolioIds, (ids) =>
      db.select().from(transactions).where(inArray(transactions.portfolioId, ids)),
    ),
    inIds(cleartextPortfolioIds, (ids) =>
      db.select().from(portfolioCashSources).where(inArray(portfolioCashSources.portfolioId, ids)),
    ),
    inIds(cleartextPortfolioIds, (ids) =>
      db.select().from(dividends).where(inArray(dividends.portfolioId, ids)),
    ),
    inIds(cleartextPortfolioIds, (ids) =>
      db
        .select()
        .from(portfolioCashMovements)
        .where(inArray(portfolioCashMovements.portfolioId, ids)),
    ),
    inIds(cleartextPortfolioIds, (ids) =>
      db.select().from(portfolioSettings).where(inArray(portfolioSettings.portfolioId, ids)),
    ),
    db.select().from(conglomerates).where(eq(conglomerates.ownerId, userId)),
    inIds(conglomerateIds, (ids) =>
      db
        .select()
        .from(conglomeratePositions)
        .where(inArray(conglomeratePositions.conglomerateId, ids)),
    ),
    inIds(conglomerateIds, (ids) =>
      db.select().from(shareLinks).where(inArray(shareLinks.conglomerateId, ids)),
    ),
    inIds(audienceIds, (ids) =>
      db.select().from(shareAudienceMembers).where(inArray(shareAudienceMembers.audienceId, ids)),
    ),
    inIds(audienceIds, (ids) =>
      db.select().from(shareAudienceLinks).where(inArray(shareAudienceLinks.audienceId, ids)),
    ),
    db.select().from(assets).where(eq(assets.ownerId, userId)),
    inIds(customAssetIds, (ids) =>
      db.select().from(priceHistory).where(inArray(priceHistory.assetId, ids)),
    ),
    db.select().from(portfolios).where(eq(portfolios.userId, userId)),
    // V5-P9 expense area + V5 cash fusion. The expense tables, the tags and the
    // rules all carry `user_id` directly; the per-tag budgets are portfolio-
    // scoped exactly like the cash movements they budget, so they ride the same
    // cleartext-portfolio id set (a vault-backed portfolio has no cleartext
    // descendants to export).
    db.select().from(expenseCategories).where(eq(expenseCategories.userId, userId)),
    db.select().from(expenseTransactions).where(eq(expenseTransactions.userId, userId)),
    db.select().from(expenseRules).where(eq(expenseRules.userId, userId)),
    db.select().from(expenseBudgets).where(eq(expenseBudgets.userId, userId)),
    db.select().from(cashTags).where(eq(cashTags.userId, userId)),
    inIds(cleartextPortfolioIds, (ids) =>
      db.select().from(cashBudgets).where(inArray(cashBudgets.portfolioId, ids)),
    ),
    db.select().from(cashRules).where(eq(cashRules.userId, userId)),
  ]);

  // The two link tables key off rows resolved above rather than off the user, so
  // they follow the same "own id set first, empty set short-circuits" shape: a
  // movement link is scoped to the caller's own exported movements (never to the
  // tag, which would carry links to movements this export deliberately omits),
  // and a rule link to the caller's own rules.
  //
  // The movement link binds the *portfolio* ids rather than the movement ids it
  // is logically scoped by: the two sets select exactly the same links (the
  // exported movements ARE the movements of `cleartextPortfolioIds`), but the
  // movement set grows with the ledger, and the pre-flight ceiling admits up to
  // `EXPORT_MAX_ROWS` movements while the postgres extended protocol refuses a
  // statement above 65_534 bind parameters. Binding movement ids would therefore
  // fail a large-but-supported account with an opaque driver error instead of
  // the typed `ExportTooLargeError` the ceilings exist to guarantee. Every other
  // id set bound here is hand-created config, so it stays at human scale.
  const cashRuleIds = cashRuleRows.map((r) => r.id);
  const [cashMovementTagRows, cashRuleTagRows] = await Promise.all([
    inIds(cleartextPortfolioIds, (ids) =>
      db
        .select()
        .from(cashMovementTags)
        .where(
          inArray(
            cashMovementTags.movementId,
            db
              .select({ id: portfolioCashMovements.id })
              .from(portfolioCashMovements)
              .where(inArray(portfolioCashMovements.portfolioId, ids)),
          ),
        ),
    ),
    inIds(cashRuleIds, (ids) =>
      db.select().from(cashRuleTags).where(inArray(cashRuleTags.ruleId, ids)),
    ),
  ]);

  const allEntities: Record<string, unknown[]> = {
    account: sanitize(accountRows),
    apiKeys: sanitize(apiKeyRows),
    externalIdentities: sanitize(externalIdentityRows, 'externalIdentities'),
    oauthClients: sanitize(oauthClientRows),
    oauthGrants: sanitize(oauthGrantRows),
    watchlists: sanitize(watchlistRows),
    workboardItems: sanitize(workboardItemRows),
    alerts: sanitize(alertRows),
    notifications: sanitize(notificationRows),
    notificationSettings: sanitize(notificationSettingRows),
    // Already narrowed to {@link FEEDBACK_EXPORT_COLUMNS} at the query, so no
    // admin-workspace column reaches the ZIP here either.
    feedback: sanitize(feedbackRows),
    feedbackMessages: projectFeedbackMessages(sanitize(feedbackMessageRows)),
    conglomerates: sanitize(conglomerateFull),
    conglomeratePositions: sanitize(conglomeratePositionRows),
    conglomerateShareLinks: sanitize(conglomerateShareLinkRows),
    ideas: sanitize(ideaRows),
    portfolios: sanitize(portfolioFull),
    transactions: sanitize(transactionRows),
    cashSources: sanitize(cashSourceRows),
    dividends: sanitize(dividendRows),
    cashMovements: sanitize(cashMovementRows),
    portfolioSettings: sanitize(portfolioSettingRows),
    taxSettings: sanitize(taxSettingRows),
    taxYearChanges: sanitize(taxYearChangeRows),
    friendRequests: sanitize(friendRequestRows),
    friendships: sanitize(friendshipRows),
    userFollows: sanitize(userFollowRows),
    shareAudiences: sanitize(shareAudienceRowsFull),
    shareAudienceMembers: sanitize(shareAudienceMemberRows),
    shareAudienceLinks: sanitize(shareAudienceLinkRows),
    sharedItemActivityPrefs: sanitize(sharedItemActivityPrefRows),
    itemFollows: sanitize(itemFollowRows),
    chatConversations: sanitize(chatConversationRows),
    chatMessages: sanitize(chatMessageRows),
    announcementDismissals: sanitize(announcementDismissalRows),
    customAssets: sanitize(customAssetFull),
    customAssetPriceHistory: sanitize(customAssetPriceRows),
    expenseCategories: sanitize(expenseCategoryRows),
    expenseTransactions: sanitize(expenseTransactionRows),
    expenseRules: sanitize(expenseRuleRows),
    expenseBudgets: sanitize(expenseBudgetRows),
    cashTags: sanitize(cashTagRows),
    cashMovementTags: sanitize(cashMovementTagRows),
    cashBudgets: sanitize(cashBudgetRows),
    cashRules: sanitize(cashRuleRows),
    cashRuleTags: sanitize(cashRuleTagRows),
  };
  // Checked BEFORE the serverOnly narrowing, so a stray entity is caught rather
  // than filtered away (see {@link assertCollectorCoverage}).
  assertCollectorCoverage(Object.keys(allEntities));

  const allowedEntities = new Set(
    options.serverOnly ? PARANOID_SERVER_EXPORTED_ENTITY_NAMES : EXPORTED_ENTITY_NAMES,
  );
  const entities = Object.fromEntries(
    Object.entries(allEntities).filter(([entity]) => allowedEntities.has(entity)),
  );

  // ── Derived CSVs (transactions / cash movements / holdings) ────────────────
  const csvTransactions = toCsv(
    ['id', 'portfolioId', 'assetId', 'side', 'quantity', 'price', 'fee', 'executedAt', 'note'],
    transactionRows.map((t) => [
      t.id,
      t.portfolioId,
      t.assetId,
      t.side,
      t.quantity,
      t.price,
      t.fee,
      t.executedAt,
      t.note,
    ]),
  );

  const csvCashMovements = toCsv(
    ['id', 'portfolioId', 'sourceId', 'kind', 'amountEur', 'taxYear', 'executedAt', 'note'],
    cashMovementRows.map((m) => [
      m.id,
      m.portfolioId,
      m.sourceId,
      m.kind,
      m.amountEur,
      m.taxYear,
      m.executedAt,
      m.note,
    ]),
  );

  // Holdings: net position per (portfolio, asset) from the transaction ledger —
  // sum of buy quantities minus sell quantities. Derived, so it needs no market
  // data and stays self-contained in the export.
  //
  // Quantities are `numeric(20,8)` strings, so summing them in floats leaves
  // dust: buy 0.1 + buy 0.2 − sell 0.3 nets 5.55e-17, which a strict `!== 0`
  // filter keeps and the CSV then prints in scientific notation — a fully closed
  // position appearing as a held one, disagreeing with the app's own holdings
  // view. `QTY_EPSILON` is the domain's answer to exactly that (a held quantity
  // within it of zero IS flat); the export uses the same rule rather than a
  // second one.
  //
  // The same float sum leaves the same dust on a position that is genuinely
  // held — buy 0.1 + buy 0.2 nets `0.30000000000000004` — so the net is first
  // snapped back to the column's own scale (`numeric(20,8)`), which is exactly
  // the precision the stored quantities carry. Beyond that scale there is no
  // information to preserve, only artefact, and the CSV then agrees with the
  // app's holdings view for the held case too, not only the closed one.
  const holdingsMap = new Map<string, { portfolioId: string; assetId: string; net: number }>();
  for (const t of transactionRows) {
    const key = `${t.portfolioId}:${t.assetId}`;
    const signed = (t.side === 'sell' ? -1 : 1) * Number(t.quantity);
    const existing = holdingsMap.get(key);
    if (existing) existing.net += signed;
    else holdingsMap.set(key, { portfolioId: t.portfolioId, assetId: t.assetId, net: signed });
  }
  const csvHoldings = toCsv(
    ['portfolioId', 'assetId', 'netQuantity'],
    [...holdingsMap.values()]
      .map((h) => ({ ...h, net: Number(h.net.toFixed(QUANTITY_SCALE)) }))
      .filter((h) => Math.abs(h.net) > QTY_EPSILON)
      .map((h) => [h.portfolioId, h.assetId, h.net]),
  );

  return {
    entities,
    csv: { transactions: csvTransactions, cashMovements: csvCashMovements, holdings: csvHoldings },
  };
}
