import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
} from 'drizzle-orm';

import type { Database } from '../db';
import {
  usageDaily,
  usageEvents,
  portfolios,
  users,
  type NewUsageDailyRow,
  type NewUsageEventRow,
} from '../schema';
import { withFreshLockedPrivacyModes } from './paranoidEnforcementRepository';
// Reused, not re-declared: sharing the constant is what keeps the flush's lock
// hold bounded by the SAME number as the admin batch if that number ever moves.
import { PARANOID_ADMIN_METADATA_LOCK_CHUNK } from './paranoidTransitionRepository';

/**
 * The sentinel feature key in {@link usageDaily} that carries the all-features
 * per-day totals (its `activeUsers` is the day's distinct-user count). Kept out
 * of the per-feature counters. Mirrors the same constant in the service — the
 * DB and service must agree, so it lives here where the SQL uses it.
 */
export const USAGE_TOTAL_FEATURE = '*';

/** One folded activity row to upsert (a hit count for a user/feature/day). */
export interface UsageEventUpsert {
  userId: string;
  feature: string;
  assetId: string;
  /** Ephemeral enforcement metadata; never written to usage_events. */
  targetPortfolioId?: string | null;
  /** Ephemeral marker for portfolio-unattributed asset quote reads. */
  suppressIfAnyVault?: boolean;
  day: string;
  hits: number;
  lastSeenAt: Date;
}

export interface UsageFeatureCount {
  feature: string;
  events: number;
}

export interface UsageTopAssetCount {
  assetId: string;
  views: number;
}

export interface UsageDailyPoint {
  day: string;
  events: number;
  activeUsers: number;
}

export interface UsageAnalyticsRepository {
  /**
   * Fold a batch of activity rows in, keyed by (user, feature, asset, day):
   * a new key inserts, a repeat bumps `hits` and refreshes `last_seen_at`. The
   * append-side of usage capture — cheap and idempotent per key.
   */
  upsertEvents(rows: UsageEventUpsert[]): Promise<void>;
  /**
   * Recompute the {@link usageDaily} rollup for one day from the raw events:
   * replaces that day's rows with fresh per-feature aggregates plus the `'*'`
   * total row. Idempotent — re-running converges to the same rows.
   */
  rollupDay(day: string): Promise<void>;
  /** Distinct users with any activity since (inclusive) `sinceDay`. */
  distinctActiveUsers(sinceDay: string): Promise<number>;
  /** Distinct users with ANY activity ever (the "activated" funnel stage). */
  activatedUsers(): Promise<number>;
  /** Total registered accounts (the top of the funnel). */
  totalUsers(): Promise<number>;
  /** Per-feature event totals since `sinceDay`, served from the rollup. */
  featureCounters(sinceDay: string): Promise<UsageFeatureCount[]>;
  /** The all-features per-day activity series since `sinceDay`, from the rollup. */
  dailySeries(sinceDay: string): Promise<UsageDailyPoint[]>;
  /** Most-viewed assets since `sinceDay` (from raw events, excludes no-asset rows). */
  topAssets(sinceDay: string, limit: number): Promise<UsageTopAssetCount[]>;
  /**
   * Delete at most `limit` raw event rows whose `day` is before `cutoff` (the
   * retention sweep's bounded drain). Raw events are one row per user × feature
   * × asset × day — i.e. a per-user viewing history — and nothing but a per-user
   * paranoid transition ever removed one. The {@link usageDaily} rollup is
   * aggregate and is deliberately NOT swept with them, so the admin analytics
   * series survives its own raw history.
   */
  deleteEventsOlderThan(cutoff: Date, limit: number): Promise<number>;
}

export function createUsageAnalyticsRepository(
  db: Database,
  /**
   * The DEDICATED privacy-lock pool (`server.ts` / `worker.ts`), never the
   * request pool — `withFreshLockedPrivacyModes` holds an open transaction
   * across the insert below, and a lock reserved on the pool it then needs a
   * connection from can deadlock. Required, not defaulted: silently falling back
   * to `db` would degrade the guarantee without anyone noticing.
   */
  lockDb: Database,
): UsageAnalyticsRepository {
  return {
    async upsertEvents(rows: UsageEventUpsert[]): Promise<void> {
      if (rows.length === 0) return;
      // Second line of defence for paranoid accounts (§13.5 V5-P13 arc b), and
      // the one that closes the enable RACE. `usageCapture` drops the signal at
      // request time, but the service buffers in memory and flushes on a timer,
      // so signals taken while the account was still `normal` can arrive AFTER
      // the enable transaction purged the table — re-creating exactly the
      // holdings-roster rows that were just deleted, with nothing left to sweep
      // them again.
      //
      // An UNLOCKED re-read would not close that: paranoid enable flips
      // `privacy_mode` in its LAST statement but takes `FOR UPDATE` on the row
      // in its FIRST (`lockState`), so a plain SELECT landing anywhere inside
      // the transaction still sees `normal`, admits the batch, and its INSERT
      // then lands the instant the enable commits — after the in-transaction
      // zero-probe has already passed. The window is the whole transaction.
      //
      // So take the same `FOR KEY SHARE` lock every other guarded action takes.
      // It conflicts with exactly one thing, the transition's `FOR UPDATE`:
      //  - flush locks first  → enable waits, then purges these rows;
      //  - enable locks first → flush waits, then reads `paranoid` and drops them.
      // Holding it ACROSS the insert is the point; releasing before writing
      // would restore the race.
      //
      // CHUNKED by the same rule and the same constant as the admin metadata
      // batch: a flush buffer spans every account active in the window, so an
      // unchunked lock would grow both the `FOR KEY SHARE` hold and the
      // `inArray` list with the account table, and a transition's `FOR UPDATE`
      // would wait behind all of it. Chunking is safe here because the guarantee
      // is per-account — a user's rows live in exactly one chunk and are locked
      // for it, so no chunk depends on another.
      const byUser = new Map<string, UsageEventUpsert[]>();
      for (const row of rows) {
        const bucket = byUser.get(row.userId);
        if (bucket) bucket.push(row);
        else byUser.set(row.userId, [row]);
      }
      const ids = [...byUser.keys()];
      for (let index = 0; index < ids.length; index += PARANOID_ADMIN_METADATA_LOCK_CHUNK) {
        const chunk = ids.slice(index, index + PARANOID_ADMIN_METADATA_LOCK_CHUNK);
        await withFreshLockedPrivacyModes(lockDb, chunk, async (modes) => {
          // Fail closed: only a confirmed-`normal` account is written. A `null`
          // mode means the row no longer resolves (deleted mid-flush), which
          // would otherwise fail the FK and lose the whole batch.
          const normalRows = chunk
            .filter((userId) => modes.get(userId) === 'normal')
            .flatMap((userId) => byUser.get(userId) ?? []);
          if (normalRows.length === 0) return;

          // E2 re-keys the second admission check per portfolio. These reads
          // happen while the account KEY SHARE lock above is held. E4's move-in
          // commit takes the conflicting account FOR UPDATE lock, so either:
          //   flush wins -> its rows land before E4's purge, or
          //   move-in wins -> this re-read sees vault_id and drops the buffer.
          // That closes #1344's post-purge resurrection window without killing
          // telemetry for a same-account plain sibling.
          const targetIds = [
            ...new Set(
              normalRows.flatMap((row) => (row.targetPortfolioId ? [row.targetPortfolioId] : [])),
            ),
          ];
          const plainTargets =
            targetIds.length === 0
              ? []
              : await db
                  .select({ id: portfolios.id, userId: portfolios.userId })
                  .from(portfolios)
                  .where(
                    and(
                      inArray(portfolios.id, targetIds),
                      inArray(portfolios.userId, chunk),
                      isNull(portfolios.vaultId),
                    ),
                  );
          const plainTargetKeys = new Set(plainTargets.map((row) => `${row.userId}|${row.id}`));
          const vaultSensitiveUsers = [
            ...new Set(
              normalRows.filter((row) => row.suppressIfAnyVault === true).map((row) => row.userId),
            ),
          ];
          const usersWithVault =
            vaultSensitiveUsers.length === 0
              ? []
              : await db
                  .selectDistinct({ userId: portfolios.userId })
                  .from(portfolios)
                  .where(
                    and(
                      inArray(portfolios.userId, vaultSensitiveUsers),
                      isNotNull(portfolios.vaultId),
                    ),
                  );
          const vaultedUsers = new Set(usersWithVault.map((row) => row.userId));
          const admitted = normalRows.filter((row) => {
            if (row.suppressIfAnyVault === true && vaultedUsers.has(row.userId)) return false;
            if (!row.targetPortfolioId) return true;
            return plainTargetKeys.has(`${row.userId}|${row.targetPortfolioId}`);
          });
          if (admitted.length === 0) return;

          // Different in-memory privacy keys can map to the same persisted
          // uniqueness key after admission. Fold them again so one INSERT never
          // attempts to update the same ON CONFLICT row twice.
          const folded = new Map<string, UsageEventUpsert>();
          for (const row of admitted) {
            const key = `${row.userId}|${row.feature}|${row.assetId}|${row.day}`;
            const previous = folded.get(key);
            if (previous) {
              previous.hits += row.hits;
              if (row.lastSeenAt > previous.lastSeenAt) previous.lastSeenAt = row.lastSeenAt;
            } else {
              folded.set(key, { ...row });
            }
          }
          const values: NewUsageEventRow[] = [...folded.values()].map((r) => ({
            userId: r.userId,
            feature: r.feature,
            assetId: r.assetId,
            day: r.day,
            hits: r.hits,
            lastSeenAt: r.lastSeenAt,
          }));
          await db
            .insert(usageEvents)
            .values(values)
            .onConflictDoUpdate({
              target: [
                usageEvents.userId,
                usageEvents.feature,
                usageEvents.assetId,
                usageEvents.day,
              ],
              set: {
                hits: sql`${usageEvents.hits} + excluded.hits`,
                lastSeenAt: sql`excluded.last_seen_at`,
              },
            });
        });
      }
    },

    async rollupDay(day: string): Promise<void> {
      // Per-feature aggregates for the day…
      const perFeature = await db
        .select({
          feature: usageEvents.feature,
          events: sql<number>`sum(${usageEvents.hits})`,
          activeUsers: sql<number>`count(distinct ${usageEvents.userId})`,
        })
        .from(usageEvents)
        .where(eq(usageEvents.day, day))
        .groupBy(usageEvents.feature);
      // …plus the all-features total (distinct users across every feature).
      const [total] = await db
        .select({
          events: sql<number>`coalesce(sum(${usageEvents.hits}), 0)`,
          activeUsers: sql<number>`count(distinct ${usageEvents.userId})`,
        })
        .from(usageEvents)
        .where(eq(usageEvents.day, day));

      const rows: NewUsageDailyRow[] = perFeature.map((r) => ({
        day,
        feature: r.feature,
        events: Number(r.events),
        activeUsers: Number(r.activeUsers),
      }));
      if (total && Number(total.events) > 0) {
        rows.push({
          day,
          feature: USAGE_TOTAL_FEATURE,
          events: Number(total.events),
          activeUsers: Number(total.activeUsers),
        });
      }

      // Replace the day's rows atomically — idempotent re-materialization.
      await db.transaction(async (tx) => {
        await tx.delete(usageDaily).where(eq(usageDaily.day, day));
        if (rows.length > 0) await tx.insert(usageDaily).values(rows);
      });
    },

    async distinctActiveUsers(sinceDay: string): Promise<number> {
      const [row] = await db
        .select({ value: sql<number>`count(distinct ${usageEvents.userId})` })
        .from(usageEvents)
        .where(gte(usageEvents.day, sinceDay));
      return Number(row?.value ?? 0);
    },

    async activatedUsers(): Promise<number> {
      const [row] = await db
        .select({ value: sql<number>`count(distinct ${usageEvents.userId})` })
        .from(usageEvents);
      return Number(row?.value ?? 0);
    },

    async totalUsers(): Promise<number> {
      const [row] = await db.select({ value: count() }).from(users);
      return row?.value ?? 0;
    },

    async featureCounters(sinceDay: string): Promise<UsageFeatureCount[]> {
      const rows = await db
        .select({
          feature: usageDaily.feature,
          events: sql<number>`sum(${usageDaily.events})`,
        })
        .from(usageDaily)
        .where(and(gte(usageDaily.day, sinceDay), ne(usageDaily.feature, USAGE_TOTAL_FEATURE)))
        .groupBy(usageDaily.feature)
        .orderBy(desc(sql`sum(${usageDaily.events})`));
      return rows.map((r) => ({ feature: r.feature, events: Number(r.events) }));
    },

    async dailySeries(sinceDay: string): Promise<UsageDailyPoint[]> {
      const rows = await db
        .select({
          day: usageDaily.day,
          events: usageDaily.events,
          activeUsers: usageDaily.activeUsers,
        })
        .from(usageDaily)
        .where(and(gte(usageDaily.day, sinceDay), eq(usageDaily.feature, USAGE_TOTAL_FEATURE)))
        .orderBy(usageDaily.day);
      return rows.map((r) => ({
        day: r.day,
        events: Number(r.events),
        activeUsers: Number(r.activeUsers),
      }));
    },

    async topAssets(sinceDay: string, limit: number): Promise<UsageTopAssetCount[]> {
      const rows = await db
        .select({
          assetId: usageEvents.assetId,
          views: sql<number>`sum(${usageEvents.hits})`,
        })
        .from(usageEvents)
        .where(and(gte(usageEvents.day, sinceDay), ne(usageEvents.assetId, '')))
        .groupBy(usageEvents.assetId)
        .orderBy(desc(sql`sum(${usageEvents.hits})`))
        .limit(limit);
      return rows.map((r) => ({ assetId: r.assetId, views: Number(r.views) }));
    },

    async deleteEventsOlderThan(cutoff: Date, limit: number): Promise<number> {
      // `day` is a DATE column, so the cutoff instant is compared as its
      // calendar day: a row is eligible once its whole day is past the window.
      const cutoffDay = cutoff.toISOString().slice(0, 10);
      const candidates = db
        .select({ id: usageEvents.id })
        .from(usageEvents)
        .where(lt(usageEvents.day, cutoffDay))
        .orderBy(asc(usageEvents.day), asc(usageEvents.id))
        .limit(limit);
      const deleted = await db
        .delete(usageEvents)
        .where(inArray(usageEvents.id, candidates))
        .returning({ id: usageEvents.id });
      return deleted.length;
    },
  };
}
