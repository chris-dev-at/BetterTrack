import { and, count, desc, eq, gte, ne, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  usageDaily,
  usageEvents,
  users,
  type NewUsageDailyRow,
  type NewUsageEventRow,
} from '../schema';

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
}

export function createUsageAnalyticsRepository(db: Database): UsageAnalyticsRepository {
  return {
    async upsertEvents(rows: UsageEventUpsert[]): Promise<void> {
      if (rows.length === 0) return;
      const values: NewUsageEventRow[] = rows.map((r) => ({
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
          target: [usageEvents.userId, usageEvents.feature, usageEvents.assetId, usageEvents.day],
          set: {
            hits: sql`${usageEvents.hits} + excluded.hits`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
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
  };
}
