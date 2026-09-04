import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { CASH_SYSTEM_TAGS, type CashSystemTagKey } from '@bettertrack/contracts';

import type { Database } from '../db';
import {
  cashMovementTags,
  cashTags,
  portfolioCashMovements,
  portfolios,
  type CashTagRow,
} from '../schema';

/**
 * Cash-tag persistence (V5 cash fusion, PROJECTPLAN.md §10 for the scoping
 * rules). Tags are the flat, per-user labels that replaced `expense_categories`;
 * `cash_movement_tags` is what makes a movement carry several of them.
 *
 * ── THE OWNERSHIP INVARIANT NO FOREIGN KEY CAN EXPRESS ──
 *
 * A `cash_movement_tags` row is only legal when the tag's `user_id` and the
 * movement's `portfolio.user_id` are the SAME account. Tags reach users directly;
 * movements reach them only through `portfolios`. Postgres cannot join those two
 * paths in a constraint, so this repository is the only thing standing between a
 * caller and cross-account tagging — and it enforces BOTH sides in the same
 * statement, never in a controller:
 *
 *  - {@link CashTagRepository.replaceMovementTags} resolves the movement through
 *    `portfolios.user_id = :userId` and every tag through `cash_tags.user_id =
 *    :userId` BEFORE writing. If either side does not fully resolve it writes
 *    nothing and reports the miss, so the service can 404. There is no partial
 *    write and no path where a foreign id is silently dropped from a set that
 *    otherwise succeeds.
 *  - Reads are scoped the same way, so an id belonging to another account is
 *    simply not found and existence never leaks (§8).
 */

/** A tag as stored. */
export interface CashTagRecord {
  id: string;
  userId: string;
  name: string;
  color: string;
  system: boolean;
  systemKey: CashSystemTagKey | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCashTagInput {
  name: string;
  color: string;
}

export interface UpdateCashTagPatch {
  name?: string;
  color?: string;
}

/** Outcome of a whole-set movement retag. */
export interface ReplaceMovementTagsResult {
  /** False when the movement is not in a portfolio this owner owns. */
  movementFound: boolean;
  /**
   * The ledger the movement lives in, resolved by the SAME owner-scoped lookup
   * that decides `movementFound` — `null` when it did not resolve. Reported so
   * the caller can run the cash-write seam (#1754: a retag changes what the
   * movement counts against) without a second, unscoped lookup.
   */
  portfolioId: string | null;
  /** Ids the caller sent that are not this owner's tags. */
  unknownTagIds: string[];
  /** The tag set now on the movement (empty when nothing was written). */
  tags: CashTagRecord[];
}

function toTag(row: CashTagRow): CashTagRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    color: row.color,
    system: row.system,
    // The column is plain text; only a key the contract knows is surfaced, so a
    // row written by a newer build cannot smuggle an unknown key into a response.
    systemKey: (row.systemKey as CashSystemTagKey | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Ordering used everywhere a tag list is returned: app-owned first, then name. */
const TAG_ORDER = [asc(cashTags.system), asc(cashTags.name)];

export function createCashTagRepository(db: Database) {
  /** Tags in a set, scoped to the owner. Used to validate every incoming id. */
  async function ownedTagsIn(userId: string, tagIds: readonly string[]): Promise<CashTagRecord[]> {
    if (tagIds.length === 0) return [];
    const rows = await db
      .select()
      .from(cashTags)
      .where(and(eq(cashTags.userId, userId), inArray(cashTags.id, [...tagIds])));
    return rows.map(toTag);
  }

  return {
    /** Every tag the owner has — system tags included, they are theirs to see. */
    async listForOwner(userId: string): Promise<CashTagRecord[]> {
      const rows = await db
        .select()
        .from(cashTags)
        .where(eq(cashTags.userId, userId))
        // Descending on `system` would put user tags first; the app-owned set is
        // the stable spine of the list, so it leads.
        .orderBy(...TAG_ORDER);
      return rows.map(toTag);
    },

    async findByIdForOwner(userId: string, tagId: string): Promise<CashTagRecord | null> {
      const rows = await db
        .select()
        .from(cashTags)
        .where(and(eq(cashTags.userId, userId), eq(cashTags.id, tagId)))
        .limit(1);
      const row = rows[0];
      return row ? toTag(row) : null;
    },

    /**
     * Resolve one app-owned tag by its stable key. The engine addresses system
     * tags this way and never by name, so renaming or translating one never
     * breaks auto-tagging.
     */
    async findSystemTag(userId: string, key: CashSystemTagKey): Promise<CashTagRecord | null> {
      const rows = await db
        .select()
        .from(cashTags)
        .where(and(eq(cashTags.userId, userId), eq(cashTags.systemKey, key)))
        .limit(1);
      const row = rows[0];
      return row ? toTag(row) : null;
    },

    ownedTagsIn,

    async create(userId: string, input: CreateCashTagInput): Promise<CashTagRecord> {
      const [row] = await db
        .insert(cashTags)
        .values({ userId, name: input.name, color: input.color, system: false, systemKey: null })
        .returning();
      return toTag(row!);
    },

    /**
     * Rename / re-tint. `system` and `systemKey` are deliberately not patchable:
     * a system tag may be renamed (it is addressed by its key) but can never be
     * turned into a user tag or vice versa.
     */
    async update(
      userId: string,
      tagId: string,
      patch: UpdateCashTagPatch,
    ): Promise<CashTagRecord | null> {
      if (patch.name === undefined && patch.color === undefined) {
        return this.findByIdForOwner(userId, tagId);
      }
      const [row] = await db
        .update(cashTags)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(cashTags.userId, userId), eq(cashTags.id, tagId)))
        .returning();
      return row ? toTag(row) : null;
    },

    /**
     * Hard delete, cascading the tag's movement links, rule links and budgets.
     * A tag holds no money and no history, so there is nothing to preserve — the
     * amounts, dates and sources of every row it labelled are untouched. The
     * service refuses this for a system tag before it gets here.
     */
    async delete(userId: string, tagId: string): Promise<boolean> {
      const deleted = await db
        .delete(cashTags)
        .where(and(eq(cashTags.userId, userId), eq(cashTags.id, tagId)))
        .returning({ id: cashTags.id });
      return deleted.length > 0;
    },

    /**
     * Seed the app-owned set for one owner. Idempotent through
     * `UNIQUE(user, system_key)`.
     *
     * A TAKEN NAME MUST NOT LEAVE A GAP. Migration 0076 seeded with a bare
     * `ON CONFLICT DO NOTHING`, so a user who already owned a tag called "Fees"
     * got no `fees` system tag at all — and auto-tagging for that kind would then
     * silently do nothing forever, with no way for the user to notice or fix it. A
     * system tag is identified by its `systemKey`, never by its name, so a clash
     * is disambiguated instead of skipped and the user may rename it afterwards.
     */
    async ensureSystemTags(userId: string): Promise<void> {
      const held = await db
        .select({ name: cashTags.name, systemKey: cashTags.systemKey })
        .from(cashTags)
        .where(eq(cashTags.userId, userId));
      const takenNames = new Set(held.map((row) => row.name.toLowerCase()));
      const heldKeys = new Set(held.map((row) => row.systemKey).filter((key) => key !== null));

      const missing = CASH_SYSTEM_TAGS.filter((seed) => !heldKeys.has(seed.key)).flatMap((seed) => {
        const taken = takenNames.has(seed.name.toLowerCase());
        const name = taken ? `${seed.name} (built-in)` : seed.name;
        // Both forms taken is genuinely unresolvable — skip rather than loop.
        if (taken && takenNames.has(name.toLowerCase())) return [];
        takenNames.add(name.toLowerCase());
        return [{ userId, name, color: seed.color, system: true, systemKey: seed.key }];
      });
      if (missing.length === 0) return;

      // Still `onConflictDoNothing`: two concurrent first-reads must not make one
      // of them fail, and the unique keys make the loser a no-op.
      await db.insert(cashTags).values(missing).onConflictDoNothing();
    },

    /** The tag sets of many movements at once, for the ledger read. */
    async tagIdsForMovements(
      portfolioId: string,
      movementIds: readonly string[],
    ): Promise<Map<string, string[]>> {
      const byMovement = new Map<string, string[]>();
      if (movementIds.length === 0) return byMovement;
      const rows = await db
        .select({
          movementId: cashMovementTags.movementId,
          tagId: cashMovementTags.tagId,
        })
        .from(cashMovementTags)
        .innerJoin(
          portfolioCashMovements,
          eq(portfolioCashMovements.id, cashMovementTags.movementId),
        )
        // The portfolio predicate is redundant given the id list, but it keeps the
        // query honest: this read can only ever see one portfolio's links.
        .where(
          and(
            eq(portfolioCashMovements.portfolioId, portfolioId),
            inArray(cashMovementTags.movementId, [...movementIds]),
          ),
        );
      for (const row of rows) {
        const existing = byMovement.get(row.movementId);
        if (existing) existing.push(row.tagId);
        else byMovement.set(row.movementId, [row.tagId]);
      }
      return byMovement;
    },

    /** The tag set on one movement, scoped through its portfolio's owner. */
    async tagsForMovement(userId: string, movementId: string): Promise<CashTagRecord[]> {
      const rows = await db
        .select({ tag: cashTags })
        .from(cashMovementTags)
        .innerJoin(cashTags, eq(cashTags.id, cashMovementTags.tagId))
        .innerJoin(
          portfolioCashMovements,
          eq(portfolioCashMovements.id, cashMovementTags.movementId),
        )
        .innerJoin(portfolios, eq(portfolios.id, portfolioCashMovements.portfolioId))
        .where(
          and(
            eq(cashMovementTags.movementId, movementId),
            // BOTH sides of the invariant, in one predicate.
            eq(portfolios.userId, userId),
            sql`${portfolios.vaultId} IS NULL`,
            eq(cashTags.userId, userId),
          ),
        )
        .orderBy(...TAG_ORDER);
      return rows.map((row) => toTag(row.tag));
    },

    /**
     * Replace a movement's whole tag set.
     *
     * THE SECURITY BOUNDARY. Both sides are resolved against `:userId` first and
     * the write only happens when both resolve completely:
     *  - the movement must sit in a portfolio this owner owns;
     *  - every id must be one of this owner's tags.
     * A miss on either side returns without opening a write, so a caller can
     * never half-apply a set or attach a foreign tag. Whole-set replacement (not
     * add/remove deltas) is what keeps the client's view and the stored set
     * convergent without a per-tag round trip.
     */
    async replaceMovementTags(
      userId: string,
      movementId: string,
      tagIds: readonly string[],
    ): Promise<ReplaceMovementTagsResult> {
      const owned = await db
        .select({
          id: portfolioCashMovements.id,
          portfolioId: portfolioCashMovements.portfolioId,
        })
        .from(portfolioCashMovements)
        .innerJoin(portfolios, eq(portfolios.id, portfolioCashMovements.portfolioId))
        .where(
          and(
            eq(portfolioCashMovements.id, movementId),
            eq(portfolios.userId, userId),
            sql`${portfolios.vaultId} IS NULL`,
          ),
        )
        .limit(1);
      const portfolioId = owned[0]?.portfolioId ?? null;
      if (portfolioId === null) {
        return { movementFound: false, portfolioId: null, unknownTagIds: [], tags: [] };
      }

      // A client may legally repeat an id (the unique key makes it a no-op), so
      // de-duplicate before comparing counts — otherwise a duplicate would read
      // as an unknown tag.
      const requested = [...new Set(tagIds)];
      const ownedTags = await ownedTagsIn(userId, requested);
      if (ownedTags.length !== requested.length) {
        const found = new Set(ownedTags.map((tag) => tag.id));
        return {
          movementFound: true,
          portfolioId,
          unknownTagIds: requested.filter((id) => !found.has(id)),
          tags: [],
        };
      }

      await db.transaction(async (tx) => {
        // Delete-then-insert inside one transaction: a reader never sees a
        // half-replaced set, and a re-send of the same set is a no-op in outcome.
        await tx.delete(cashMovementTags).where(eq(cashMovementTags.movementId, movementId));
        if (requested.length > 0) {
          await tx
            .insert(cashMovementTags)
            .values(requested.map((tagId) => ({ movementId, tagId })))
            .onConflictDoNothing({
              target: [cashMovementTags.movementId, cashMovementTags.tagId],
            });
        }
      });

      const ordered = [...ownedTags].sort(
        (left, right) =>
          Number(left.system) - Number(right.system) || left.name.localeCompare(right.name),
      );
      return { movementFound: true, portfolioId, unknownTagIds: [], tags: ordered };
    },

    /**
     * Attach ONE tag to a movement without disturbing what is already there —
     * the auto-tagging path. Scoped on both sides like the replace, and a no-op
     * when the pair already exists (`UNIQUE(movement, tag)` is the idempotency
     * key), so re-booking or replaying an event never duplicates a label.
     */
    async attachTagWithinPortfolio(
      portfolioId: string,
      movementId: string,
      tagId: string,
    ): Promise<boolean> {
      // One statement: the row is inserted only if the movement really is in this
      // portfolio AND the tag really belongs to that portfolio's owner. Nothing
      // here trusts the caller's pairing.
      const inserted = await db.execute(sql`
        INSERT INTO ${cashMovementTags} ("id", "movement_id", "tag_id")
        SELECT gen_random_uuid(), ${movementId}, ${tagId}
        FROM ${portfolioCashMovements} pm
        JOIN ${portfolios} p ON p."id" = pm."portfolio_id"
        JOIN ${cashTags} t ON t."id" = ${tagId} AND t."user_id" = p."user_id"
        WHERE pm."id" = ${movementId}
          AND pm."portfolio_id" = ${portfolioId}
          AND p."vault_id" IS NULL
        ON CONFLICT ("movement_id", "tag_id") DO NOTHING
        RETURNING "id"
      `);
      const rows = (inserted as { rows?: unknown[] }).rows ?? (inserted as unknown[]);
      return rows.length > 0;
    },
  };
}

export type CashTagRepository = ReturnType<typeof createCashTagRepository>;
