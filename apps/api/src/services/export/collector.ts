import { eq, inArray, or } from 'drizzle-orm';

import type { Database } from '../../data/db';
import {
  alerts,
  announcementDismissals,
  apiKeys,
  assets,
  chatConversations,
  chatMessages,
  conglomeratePositions,
  conglomerates,
  dividends,
  externalIdentities,
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
  transactions,
  userFollows,
  userTaxSettings,
  users,
  watchlists,
  workboardItems,
} from '../../data/schema';

import { EXPORTED_ENTITY_NAMES } from './manifest';

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
 * Columns never written to an export, matched by their (camelCase) property name
 * as Drizzle returns them: password/token/secret hashes, the raw legacy share
 * token, and the federated `subject` (an opaque provider id). Stripping is by
 * key name so a future sensitive column on an already-exported table is dropped
 * by default rather than leaked.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'passwordHash',
  'twoFactorSecret',
  'pinHash',
  'tokenHash',
  'clientSecretHash',
  'codeHash',
  'downloadTokenHash',
  'token',
  'subject',
]);

function stripSensitive<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!SENSITIVE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

function sanitize(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(stripSensitive);
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
 * Collect every user-owned entity for `userId` into a {@link CollectedExport}.
 * Ownership is resolved up front for the indirected tables (a portfolio's
 * transactions/cash, a conglomerate's positions/links, an audience's members,
 * a custom asset's price points) so every query is strictly the caller's rows.
 */
export async function collectUserExport(db: Database, userId: string): Promise<CollectedExport> {
  // Owner-id sets that the indirected tables key off. Resolved first so their
  // dependents can `inArray` on them (empty set ⇒ no rows, never a broad scan).
  const [portfolioRows, conglomerateRows, audienceRows, customAssetRows] = await Promise.all([
    db.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.userId, userId)),
    db
      .select({ id: conglomerates.id })
      .from(conglomerates)
      .where(eq(conglomerates.ownerId, userId)),
    db
      .select({ id: shareAudiences.id })
      .from(shareAudiences)
      .where(eq(shareAudiences.ownerId, userId)),
    db.select({ id: assets.id }).from(assets).where(eq(assets.ownerId, userId)),
  ]);
  const portfolioIds = portfolioRows.map((r) => r.id);
  const conglomerateIds = conglomerateRows.map((r) => r.id);
  const audienceIds = audienceRows.map((r) => r.id);
  const customAssetIds = customAssetRows.map((r) => r.id);

  /** Query a table only when its owner-id set is non-empty. */
  const inIds = async <T>(ids: string[], run: (ids: string[]) => Promise<T[]>): Promise<T[]> =>
    ids.length === 0 ? [] : run(ids);

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
    ideaRows,
    taxSettingRows,
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
    db.select().from(ideas).where(eq(ideas.ownerId, userId)),
    db.select().from(userTaxSettings).where(eq(userTaxSettings.userId, userId)),
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
    inIds(portfolioIds, (ids) =>
      db.select().from(transactions).where(inArray(transactions.portfolioId, ids)),
    ),
    inIds(portfolioIds, (ids) =>
      db.select().from(portfolioCashSources).where(inArray(portfolioCashSources.portfolioId, ids)),
    ),
    inIds(portfolioIds, (ids) =>
      db.select().from(dividends).where(inArray(dividends.portfolioId, ids)),
    ),
    inIds(portfolioIds, (ids) =>
      db
        .select()
        .from(portfolioCashMovements)
        .where(inArray(portfolioCashMovements.portfolioId, ids)),
    ),
    inIds(portfolioIds, (ids) =>
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
  ]);

  const entities: Record<string, unknown[]> = {
    account: sanitize(accountRows),
    apiKeys: sanitize(apiKeyRows),
    externalIdentities: sanitize(externalIdentityRows),
    oauthClients: sanitize(oauthClientRows),
    oauthGrants: sanitize(oauthGrantRows),
    watchlists: sanitize(watchlistRows),
    workboardItems: sanitize(workboardItemRows),
    alerts: sanitize(alertRows),
    notifications: sanitize(notificationRows),
    notificationSettings: sanitize(notificationSettingRows),
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
  };

  // Invariant guard: the collector must produce exactly the entities the
  // classification claims are exported — no missing key, no stray extra. The
  // completeness test asserts this too; failing fast here makes a wiring slip
  // obvious at build time.
  const produced = Object.keys(entities).sort();
  const expected = [...EXPORTED_ENTITY_NAMES];
  if (produced.length !== expected.length || produced.some((k, i) => k !== expected[i])) {
    throw new Error(
      `export collector/manifest drift: produced [${produced.join(', ')}] vs expected [${expected.join(', ')}]`,
    );
  }

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
      .filter((h) => h.net !== 0)
      .map((h) => [h.portfolioId, h.assetId, h.net]),
  );

  return {
    entities,
    csv: { transactions: csvTransactions, cashMovements: csvCashMovements, holdings: csvHoldings },
  };
}
