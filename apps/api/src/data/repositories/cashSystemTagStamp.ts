import { sql } from 'drizzle-orm';

import { CASH_SYSTEM_TAGS } from '@bettertrack/contracts';

import { SYSTEM_TAG_FOR_KIND } from '../../services/cash/cashAutoTag';
import type { CashMovementKind } from '../../domain/cashLedger';

/**
 * AUTO-TAGGING, at the only moment it is correct to do it: when a cash movement
 * row is created (V5 cash fusion).
 *
 * ── WHY THIS LIVES IN THE DATA LAYER ──
 *
 * Movements are booked from eleven places — buys and sells, dividends, tax
 * settlements and their read-path self-heal, transfers, set-balance, deposits,
 * withdrawals, standing orders and paranoid restore. Stamping from each of those
 * services would mean eleven chances to forget, and a movement that slipped
 * through would be silently unlabelled forever, because nothing re-stamps an
 * existing row. Hanging it off the three INSERT paths instead means a new booking
 * site gets auto-tagging by construction.
 *
 * It is one statement, against tables this layer already owns, and it takes the
 * caller's executor so it runs INSIDE the transaction that wrote the movements —
 * a rolled-back booking takes its labels with it.
 *
 * ── THE OWNERSHIP INVARIANT, IN SQL ──
 *
 * A `cash_movement_tags` row is only legal when the tag's `user_id` equals the
 * movement's `portfolio.user_id`, and no foreign key can say so. The statement
 * below resolves the tag THROUGH the portfolio's owner rather than taking a tag
 * id from anyone, so there is no input that could produce a cross-account link.
 *
 * ── IDEMPOTENCY KEY: `UNIQUE(movement_id, tag_id)` ──
 *
 * `ON CONFLICT DO NOTHING` on that natural key. Replaying a booking, re-running a
 * restore, or stamping the same batch twice all converge on one link per pair.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──
 *
 * It never removes a tag and never touches a movement it did not just insert. So
 * a user's own tags survive, and a user who REMOVES a system tag keeps it removed.
 * Editing the underlying trade deletes the old movement and books a new one with
 * a new id: the new row is stamped fresh and carries no user tags, because those
 * belonged to a row whose amount or date may no longer be the same. That is the
 * one place a manual tag can be lost, and it is asserted in `cashTagging.test.ts`.
 */

/** Minimal executor: `Database` or a drizzle transaction both satisfy it. */
export interface SystemTagStampExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/** A movement row that has just been inserted. */
export interface StampableMovement {
  id: string;
  kind: CashMovementKind;
}

/** `db.execute` hands back `{ rows }` on some drivers and a bare array on others. */
function rowCount(result: unknown): number {
  const rows = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Seed the app-owned tag set for whoever owns `portfolioId`. Idempotent through
 * `UNIQUE(user_id, system_key)`.
 *
 * NAME COLLISIONS DO NOT CREATE A GAP. Migration 0076 seeded with a bare
 * `ON CONFLICT DO NOTHING`, so a user who already owned a tag called "Fees" got
 * no `fees` system tag at all — and auto-tagging for that kind would then
 * silently do nothing forever. A system tag's identity is its `system_key`, not
 * its name, so a taken name is disambiguated rather than skipped; the user is
 * free to rename it afterwards, which cannot break assignment.
 */
async function seedSystemTagsForOwner(
  executor: SystemTagStampExecutor,
  portfolioId: string,
): Promise<void> {
  const seeds = CASH_SYSTEM_TAGS.map(
    (seed) => sql`(${seed.key}::text, ${seed.name}::text, ${seed.color}::text)`,
  );
  await executor.execute(sql`
    INSERT INTO "cash_tags" ("id", "user_id", "name", "color", "system", "system_key")
    SELECT
      gen_random_uuid(),
      p."user_id",
      CASE
        WHEN EXISTS (
          SELECT 1 FROM "cash_tags" c
          WHERE c."user_id" = p."user_id" AND lower(c."name") = lower(s."name")
        )
        THEN s."name" || ' (built-in)'
        ELSE s."name"
      END,
      s."color",
      true,
      s."key"
    FROM "portfolios" p
    CROSS JOIN (VALUES ${sql.join(seeds, sql`, `)}) AS s("key", "name", "color")
    WHERE p."id" = ${portfolioId}
    ON CONFLICT DO NOTHING
  `);
}

/**
 * Stamp each freshly-inserted movement with its portfolio owner's app-owned tag.
 *
 * SELF-HEALING. Migration 0076 seeded system tags `FROM users`, i.e. only for
 * accounts that existed when it ran, and nothing seeded them for accounts created
 * afterwards. So the link insert can legitimately match no tag row. When it
 * inserts nothing, the owner's set is seeded and the link is retried ONCE — which
 * means an account provisioned at any point, through any path, gets correct labels
 * from its very first booking without registration needing to know this exists.
 * In steady state the first statement succeeds and the seed never runs.
 *
 * NEVER THROWS. Booking the money is what the caller came for; a labelling
 * failure must not roll back a recorded trade, dividend or transfer. A movement
 * that fails to be labelled is recoverable by hand — a lost transaction is not.
 */
export async function stampSystemTags(
  executor: SystemTagStampExecutor,
  portfolioId: string,
  movements: readonly StampableMovement[],
): Promise<void> {
  if (movements.length === 0) return;
  const link = () => {
    const pairs = movements.map(
      (movement) => sql`(${movement.id}::uuid, ${SYSTEM_TAG_FOR_KIND[movement.kind]}::text)`,
    );
    return executor.execute(sql`
      INSERT INTO "cash_movement_tags" ("id", "movement_id", "tag_id")
      SELECT gen_random_uuid(), v."movement_id", t."id"
      FROM (VALUES ${sql.join(pairs, sql`, `)}) AS v("movement_id", "system_key")
      JOIN "portfolio_cash_movements" pm
        ON pm."id" = v."movement_id" AND pm."portfolio_id" = ${portfolioId}
      JOIN "portfolios" p ON p."id" = pm."portfolio_id"
      -- The tag is resolved from the PORTFOLIO'S OWNER, never from an argument,
      -- so a cross-account link is unrepresentable here.
      JOIN "cash_tags" t ON t."user_id" = p."user_id" AND t."system_key" = v."system_key"
      ON CONFLICT ("movement_id", "tag_id") DO NOTHING
      RETURNING "id"
    `);
  };

  try {
    if (rowCount(await link()) > 0) return;
    // Nothing linked: either every link already existed (a replay — the retry is
    // then a cheap no-op) or this owner has no system tags yet.
    await seedSystemTagsForOwner(executor, portfolioId);
    await link();
  } catch {
    // A labelling fault must not take the money write down with it.
  }
}
