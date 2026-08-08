import type { MirrorMemberStatus, VaultMirrorProvenance } from '@bettertrack/contracts';
import type { VaultStrictDocumentV1 } from '@bettertrack/contracts';
import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';

import type { Database } from '../db';

import {
  assetIdentities,
  assets,
  dividends,
  cashBudgets,
  cashMovementTags,
  cashRuleTags,
  cashRules,
  cashTags,
  expenseBudgets,
  expenseCategories,
  expenseRules,
  expenseTransactions,
  mirrorChainMembers,
  mirrorChainOps,
  mirrorRows,
  portfolioCashMovements,
  portfolioCashSources,
  portfolios,
  portfolioSettings,
  priceHistory,
  standingOrderRuns,
  standingOrders,
  transactions,
  userTaxSettings,
} from '../schema';

/**
 * Transaction-bound source-row primitives for paranoid disable rehydration. This
 * is deliberately not a public write repository: callers receive an executor
 * only from the dedicated rehydration transaction, so no method can commit a
 * partial document or emit the normal write-path's effects before the batch does.
 */

type Entity = VaultStrictDocumentV1['entities'][number];
type EntityOf<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

export interface ParanoidRehydrationReferencedAsset {
  id: string;
  currency: string;
}

export interface ParanoidRehydrationSourceRepository {
  findReferencedGlobalAssets(
    assetIds: readonly string[],
  ): Promise<readonly ParanoidRehydrationReferencedAsset[]>;
  hasExistingRestorableRows(userId: string): Promise<boolean>;
  listRetainedCustomAssetIdentityIds(userId: string): Promise<readonly string[]>;
  retireRetainedCustomAssetIdentities(userId: string, assetIds: readonly string[]): Promise<void>;
  restoreCustomAssets(rows: readonly EntityOf<'customAsset'>[]): Promise<void>;
  restoreCustomAssetValues(rows: readonly EntityOf<'customAssetValue'>[]): Promise<void>;
  restorePortfolios(rows: readonly EntityOf<'portfolio'>[]): Promise<void>;
  restoreCashSources(rows: readonly EntityOf<'cashSource'>[]): Promise<void>;
  restoreTaxSettings(row: EntityOf<'taxSetting'> | undefined): Promise<void>;
  restorePortfolioSettings(rows: readonly EntityOf<'portfolioSetting'>[]): Promise<void>;
  restoreTransactions(rows: readonly EntityOf<'transaction'>[]): Promise<void>;
  restoreDividends(rows: readonly EntityOf<'dividend'>[]): Promise<void>;
  restoreCashMovements(rows: readonly EntityOf<'cashMovement'>[]): Promise<void>;
  restoreStandingOrders(rows: readonly EntityOf<'standingOrder'>[]): Promise<void>;
  restoreStandingOrderRuns(rows: readonly EntityOf<'standingOrderRun'>[]): Promise<void>;
  restoreExpenseCategories(rows: readonly EntityOf<'expenseCategory'>[]): Promise<void>;
  restoreExpenseTransactions(rows: readonly EntityOf<'expenseTransaction'>[]): Promise<void>;
  restoreExpenseRules(rows: readonly EntityOf<'expenseRule'>[]): Promise<void>;
  restoreExpenseBudgets(rows: readonly EntityOf<'expenseBudget'>[]): Promise<void>;
  // V5 cash fusion: the classification layer on the portfolio cash ledger. It
  // has writers as of phase 2, so a paranoid disable that could not restore it
  // would silently drop every tag, budget and rule the user has.
  restoreCashTags(rows: readonly EntityOf<'cashTag'>[]): Promise<void>;
  restoreCashRules(rows: readonly EntityOf<'cashRule'>[]): Promise<void>;
  restoreCashRuleTags(rows: readonly EntityOf<'cashRuleTag'>[]): Promise<void>;
  restoreCashBudgets(rows: readonly EntityOf<'cashBudget'>[]): Promise<void>;
  restoreCashMovementTags(rows: readonly EntityOf<'cashMovementTag'>[]): Promise<void>;
}

const REHYDRATION_INSERT_CHUNK_SIZE = 1_000;

async function forEachChunk<T>(
  rows: readonly T[],
  insert: (chunk: readonly T[]) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += REHYDRATION_INSERT_CHUNK_SIZE) {
    await insert(rows.slice(offset, offset + REHYDRATION_INSERT_CHUNK_SIZE));
  }
}

export function createParanoidRehydrationSourceRepository(
  tx: Database,
): ParanoidRehydrationSourceRepository {
  return {
    async findReferencedGlobalAssets(assetIds) {
      if (!assetIds.length) return [];
      const found: ParanoidRehydrationReferencedAsset[] = [];
      await forEachChunk(assetIds, async (chunk) => {
        found.push(
          ...(await tx
            .select({ id: assets.id, currency: assets.currency })
            .from(assets)
            .where(and(inArray(assets.id, [...chunk]), isNull(assets.ownerId)))),
        );
      });
      return found;
    },

    async hasExistingRestorableRows(userId) {
      const present = await Promise.all([
        tx
          .select({ id: assets.id })
          .from(assets)
          .where(and(eq(assets.ownerId, userId), eq(assets.providerId, 'manual')))
          .limit(1),
        tx
          .select({ id: portfolios.id })
          .from(portfolios)
          .where(eq(portfolios.userId, userId))
          .limit(1),
        tx
          .select({ id: expenseCategories.id })
          .from(expenseCategories)
          .where(eq(expenseCategories.userId, userId))
          .limit(1),
        tx
          .select({ id: expenseTransactions.id })
          .from(expenseTransactions)
          .where(eq(expenseTransactions.userId, userId))
          .limit(1),
        tx
          .select({ id: standingOrders.id })
          .from(standingOrders)
          .where(eq(standingOrders.userId, userId))
          .limit(1),
        tx
          .select({ userId: userTaxSettings.userId })
          .from(userTaxSettings)
          .where(eq(userTaxSettings.userId, userId))
          .limit(1),
      ]);
      return present.some((records) => records.length > 0);
    },

    async listRetainedCustomAssetIdentityIds(userId) {
      const retained = await tx
        .select({ id: assetIdentities.id })
        .from(assetIdentities)
        .where(eq(assetIdentities.ownerId, userId))
        .for('update');
      return retained.map((identity) => identity.id);
    },

    async retireRetainedCustomAssetIdentities(userId, assetIds) {
      await forEachChunk(assetIds, async (chunk) => {
        await tx
          .delete(assetIdentities)
          .where(and(eq(assetIdentities.ownerId, userId), inArray(assetIdentities.id, [...chunk])));
      });
    },

    async restoreCustomAssets(rows) {
      await forEachChunk(rows, async (chunk) => {
        // The database insert trigger creates a missing opaque identity or
        // verifies that a retained identity carries this account's claim.
        // Keeping that invariant in the database covers this strict restore and
        // every other asset writer.
        await tx.insert(assets).values(
          chunk.map((entity) => ({
            id: entity.id,
            ownerId: entity.data.ownerId,
            providerId: entity.data.providerId,
            providerRef: entity.data.providerRef,
            type: entity.data.type,
            symbol: entity.data.symbol,
            name: entity.data.name,
            exchange: entity.data.exchange,
            currency: entity.data.currency,
            meta: entity.data.meta,
            // `search_text` is GENERATED ALWAYS from symbol + name. PostgreSQL
            // reproduces the carried value; generated columns cannot be inserted.
          })),
        );
      });
    },

    async restoreCustomAssetValues(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(priceHistory).values(
          chunk.map((entity) => ({
            assetId: entity.data.assetId,
            date: entity.data.date,
            close: entity.data.close,
          })),
        );
      });
    },

    async restorePortfolios(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(portfolios).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            name: entity.data.name,
            visibility: entity.data.visibility,
            sortOrder: entity.data.sortOrder,
            defaultPayFromCash: entity.data.defaultPayFromCash,
            archivedAt: entity.data.archivedAt ? new Date(entity.data.archivedAt) : null,
            // Absent (a vault written before the column existed) and null both
            // restore as "unclassified" — the column's own zero value, so
            // nothing is invented and nothing the vault carried is dropped.
            kind: entity.data.kind ?? null,
          })),
        );
      });
    },

    async restoreCashSources(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(portfolioCashSources).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            name: entity.data.name,
            type: entity.data.type,
            isMain: entity.data.isMain,
            archivedAt: entity.data.archivedAt ? new Date(entity.data.archivedAt) : null,
            createdAt: new Date(entity.data.createdAt),
          })),
        );
      });
    },

    async restoreTaxSettings(row) {
      if (!row) return;
      await tx.insert(userTaxSettings).values({
        userId: row.data.userId,
        mode: row.data.mode,
        country: row.data.country,
        manualDefaultAmountEur: row.data.manualDefaultAmountEur,
        manualDefaultRatePct: row.data.manualDefaultRatePct,
        customParams: row.data.customParams,
        updatedAt: new Date(row.data.updatedAt),
      });
    },

    async restorePortfolioSettings(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(portfolioSettings).values(
          chunk.map((entity) => ({
            portfolioId: entity.data.portfolioId,
            key: entity.data.key,
            value: entity.data.value,
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreTransactions(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(transactions).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            assetId: entity.data.assetId,
            side: entity.data.side,
            quantity: entity.data.quantity,
            price: entity.data.price,
            fee: entity.data.fee,
            executedAt: new Date(entity.data.executedAt),
            note: entity.data.note,
            taxMode: entity.data.taxMode,
            taxCountry: entity.data.taxCountry,
            taxAmountEur: entity.data.taxAmountEur,
            taxParams: entity.data.taxParams,
            allowUncovered: entity.data.allowUncovered,
            uncoveredEntryPrice: entity.data.uncoveredEntryPrice,
            source: entity.data.source,
          })),
        );
      });
    },

    async restoreDividends(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(dividends).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            assetId: entity.data.assetId,
            cashSourceId: entity.data.cashSourceId,
            grossAmountEur: entity.data.grossAmountEur,
            executedAt: new Date(entity.data.executedAt),
            note: entity.data.note,
            taxMode: entity.data.taxMode,
            taxCountry: entity.data.taxCountry,
            taxAmountEur: entity.data.taxAmountEur,
            taxParams: entity.data.taxParams,
            source: entity.data.source,
            createdAt: new Date(entity.data.createdAt),
          })),
        );
      });
    },

    async restoreCashMovements(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(portfolioCashMovements).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            sourceId: entity.data.sourceId,
            kind: entity.data.kind,
            amountEur: entity.data.amountEur,
            transactionId: entity.data.transactionId,
            transferId: entity.data.transferId,
            counterpartSourceId: entity.data.counterpartSourceId,
            dividendId: entity.data.dividendId,
            taxYear: entity.data.taxYear,
            executedAt: new Date(entity.data.executedAt),
            note: entity.data.note,
            source: entity.data.source,
            // V5 cash fusion: both must round-trip. Losing `dedupHash` would let
            // a re-imported bank statement duplicate every row it already landed.
            dedupHash: entity.data.dedupHash,
            originalCurrency: entity.data.originalCurrency,
            createdAt: new Date(entity.data.createdAt),
          })),
        );
      });
    },

    async restoreStandingOrders(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(standingOrders).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            portfolioId: entity.data.portfolioId,
            kind: entity.data.kind,
            assetId: entity.data.assetId,
            amount: entity.data.amount,
            currency: entity.data.currency,
            label: entity.data.label,
            cadence: entity.data.cadence,
            anchorDay: entity.data.anchorDay,
            startDate: entity.data.startDate,
            endDate: entity.data.endDate,
            status: entity.data.status,
            // The separately restored run rows are the authoritative no-replay
            // fence; these displays retain the highest known booking as a fast path.
            lastRunAt: entity.data.lastRunAt ? new Date(entity.data.lastRunAt) : null,
            lastPeriodKey: entity.data.lastPeriodKey,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreStandingOrderRuns(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(standingOrderRuns).values(
          chunk.map((entity) => ({
            id: entity.id,
            standingOrderId: entity.data.standingOrderId,
            periodKey: entity.data.periodKey,
            bookedAt: new Date(entity.data.bookedAt),
          })),
        );
      });
    },

    async restoreExpenseCategories(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(expenseCategories).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            name: entity.data.name,
            direction: entity.data.direction,
            color: entity.data.color,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreExpenseTransactions(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(expenseTransactions).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            categoryId: entity.data.categoryId,
            direction: entity.data.direction,
            amount: entity.data.amount,
            currency: entity.data.currency,
            bookedOn: entity.data.bookedOn,
            description: entity.data.description,
            source: entity.data.source,
            dedupHash: entity.data.dedupHash,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreExpenseRules(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(expenseRules).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            categoryId: entity.data.categoryId,
            matchType: entity.data.matchType,
            pattern: entity.data.pattern,
            priority: entity.data.priority,
            enabled: entity.data.enabled,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreExpenseBudgets(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(expenseBudgets).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            categoryId: entity.data.categoryId,
            amount: entity.data.amount,
            currency: entity.data.currency,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    // ── V5 cash fusion ───────────────────────────────────────────────────────
    // Ordering is the caller's job and it matters: tags before the rules,
    // budgets and movement links that reference them, and movement links after
    // the movements themselves. `validateGraph` proves the references first, so
    // these are plain inserts with no conflict handling — a duplicate here means
    // a malformed vault, which must fail loudly rather than be absorbed.

    async restoreCashTags(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(cashTags).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            name: entity.data.name,
            color: entity.data.color,
            system: entity.data.system,
            systemKey: entity.data.systemKey,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreCashRules(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(cashRules).values(
          chunk.map((entity) => ({
            id: entity.id,
            userId: entity.data.userId,
            matchType: entity.data.matchType,
            pattern: entity.data.pattern,
            priority: entity.data.priority,
            enabled: entity.data.enabled,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreCashRuleTags(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(cashRuleTags).values(
          chunk.map((entity) => ({
            id: entity.id,
            ruleId: entity.data.ruleId,
            tagId: entity.data.tagId,
            createdAt: new Date(entity.data.createdAt),
          })),
        );
      });
    },

    async restoreCashBudgets(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(cashBudgets).values(
          chunk.map((entity) => ({
            id: entity.id,
            portfolioId: entity.data.portfolioId,
            tagId: entity.data.tagId,
            periodKey: entity.data.periodKey,
            amount: entity.data.amount,
            currency: entity.data.currency,
            createdAt: new Date(entity.data.createdAt),
            updatedAt: new Date(entity.data.updatedAt),
          })),
        );
      });
    },

    async restoreCashMovementTags(rows) {
      await forEachChunk(rows, async (chunk) => {
        await tx.insert(cashMovementTags).values(
          chunk.map((entity) => ({
            id: entity.id,
            movementId: entity.data.movementId,
            tagId: entity.data.tagId,
            createdAt: new Date(entity.data.createdAt),
          })),
        );
      });
    },
  };
}

/**
 * Severed-fork MIRRORCHAIN provenance reads (`docs/paranoid-design.md` §7.1).
 *
 * Two callers, both non-destructive: the enable wizard's capture read (while
 * `mirror_rows` still exists) and disable-time validation (after it has cascaded
 * away, proving the encrypted map against the append-only oplog). Reads only —
 * they are deliberately usable outside the restore transaction so an invalid
 * document is refused before any mutation transaction opens.
 */

/**
 * One ENDED membership tombstone: its own identity, the chain, and the watermark
 * its copy stopped at. `id` is what the encrypted provenance names — a re-joined
 * account holds several tombstones per chain, each with its own copy and its own
 * (higher) watermark, and an older retained fork must be proved against ITS row.
 */
export interface ParanoidForkMembership {
  id: string;
  chainId: string;
  status: MirrorMemberStatus;
  appliedSeq: number;
}

/** One oplog row, still un-parsed: the service validates the payload contract. */
export interface ParanoidForkChainOp {
  mirrorId: string | null;
  seq: number;
  kind: string;
  actorUserId: string | null;
  payload: unknown;
}

export interface ParanoidForkProvenanceRepository {
  /** The caller's ended memberships; an active one is deliberately excluded. */
  listEndedMemberships(userId: string): Promise<readonly ParanoidForkMembership[]>;
  /**
   * Every op of `chainId` at or below `maxSeq` that speaks for one of
   * `logicalIds` — either through its own `mirror_id`, or as the `cash.transfer`
   * op that minted a second leg id which never appears in that column.
   */
  listChainOpsForLogicalIds(
    chainId: string,
    logicalIds: readonly string[],
    maxSeq: number,
  ): Promise<readonly ParanoidForkChainOp[]>;
  /** Capture read: the caller's own retained fork identity map. */
  listRetainedForkProvenance(userId: string): Promise<readonly VaultMirrorProvenance[]>;
}

export function createParanoidForkProvenanceRepository(
  db: Database,
): ParanoidForkProvenanceRepository {
  return {
    async listEndedMemberships(userId) {
      return db
        .select({
          id: mirrorChainMembers.id,
          chainId: mirrorChainMembers.chainId,
          status: mirrorChainMembers.status,
          appliedSeq: mirrorChainMembers.appliedSeq,
        })
        .from(mirrorChainMembers)
        .where(and(eq(mirrorChainMembers.userId, userId), ne(mirrorChainMembers.status, 'active')));
    },

    async listChainOpsForLogicalIds(chainId, logicalIds, maxSeq) {
      if (!logicalIds.length) return [];
      const found: ParanoidForkChainOp[] = [];
      await forEachChunk(logicalIds, async (chunk) => {
        const ids = [...chunk];
        found.push(
          ...(await db
            .select({
              mirrorId: mirrorChainOps.mirrorId,
              seq: mirrorChainOps.seq,
              kind: mirrorChainOps.kind,
              actorUserId: mirrorChainOps.actorUserId,
              payload: mirrorChainOps.payload,
            })
            .from(mirrorChainOps)
            .where(
              and(
                eq(mirrorChainOps.chainId, chainId),
                lte(mirrorChainOps.seq, maxSeq),
                or(
                  inArray(mirrorChainOps.mirrorId, ids),
                  and(
                    eq(mirrorChainOps.kind, 'cash.transfer'),
                    inArray(sql`${mirrorChainOps.payload} ->> 'inMirrorId'`, ids),
                  ),
                ),
              ),
            )),
        );
      });
      return found;
    },

    /**
     * The membership join is what makes the record self-selecting later: each
     * retained row is attributed to the ENDED tombstone that owns its copy —
     * `(chain_id, portfolio_id)` identifies exactly one membership per account,
     * because re-joining mints a fresh copy rather than reviving the fork's one.
     * A still-ACTIVE membership never matches, so a live chain's rows (and any
     * co-member's row) stay out of the response by construction.
     */
    async listRetainedForkProvenance(userId) {
      return db
        .select({
          chainId: mirrorRows.chainId,
          membershipId: mirrorChainMembers.id,
          kind: mirrorRows.kind,
          mirrorId: mirrorRows.mirrorId,
          portfolioId: mirrorRows.portfolioId,
          localId: mirrorRows.localId,
        })
        .from(mirrorRows)
        .innerJoin(portfolios, eq(portfolios.id, mirrorRows.portfolioId))
        .innerJoin(
          mirrorChainMembers,
          and(
            eq(mirrorChainMembers.chainId, mirrorRows.chainId),
            eq(mirrorChainMembers.portfolioId, mirrorRows.portfolioId),
            eq(mirrorChainMembers.userId, userId),
            ne(mirrorChainMembers.status, 'active'),
          ),
        )
        .where(eq(portfolios.userId, userId));
    },
  };
}
