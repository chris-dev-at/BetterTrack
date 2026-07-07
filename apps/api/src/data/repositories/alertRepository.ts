import { and, eq } from 'drizzle-orm';

import type { AlertKind, AlertStatus } from '@bettertrack/contracts';

import type { Database } from '../db';
import { alerts, assets } from '../schema';
import type { AssetRow } from '../schema';

/**
 * Price-alert persistence (PROJECTPLAN.md §14, V3-P10 arc b). The CRUD reads are
 * always scoped by `user_id` so a foreign alert id is indistinguishable from a
 * missing one (no IDOR, §10). The evaluator reads (`listActiveWithAsset`,
 * `recordTriggered`, `findNotificationContext`) run system-wide — the minute job
 * is not acting on behalf of a logged-in user.
 *
 * `threshold`/`ref_price` are stored in the existing `numeric` columns (§14
 * schema, no migration here) and parsed back to numbers at this boundary.
 */

/** Asset identity embedded in a CRUD alert record. */
export interface AlertAssetInfo {
  id: string;
  symbol: string;
  name: string;
  currency: string;
  type: AssetRow['type'];
}

/** One alert as read back on the CRUD surface, with its asset identity. */
export interface AlertRecord {
  id: string;
  userId: string;
  assetId: string;
  kind: AlertKind;
  threshold: number;
  refPrice: number | null;
  repeat: boolean;
  status: AlertStatus;
  lastTriggeredAt: Date | null;
  asset: AlertAssetInfo;
}

/** An active alert plus everything the evaluator needs to route a cached quote. */
export interface ActiveAlert {
  id: string;
  userId: string;
  assetId: string;
  kind: AlertKind;
  threshold: number;
  refPrice: number | null;
  repeat: boolean;
  lastTriggeredAt: Date | null;
  providerId: string;
  providerRef: string;
  symbol: string;
  name: string;
  currency: string;
  type: AssetRow['type'];
}

/** The display context the notification dispatcher renders an `alert.triggered` from. */
export interface AlertNotificationContext {
  userId: string;
  assetId: string;
  symbol: string;
  name: string;
  currency: string;
  kind: AlertKind;
  threshold: number;
}

export interface CreateAlertInput {
  userId: string;
  assetId: string;
  kind: AlertKind;
  threshold: number;
  refPrice: number | null;
  repeat: boolean;
}

const CRUD_COLUMNS = {
  id: alerts.id,
  userId: alerts.userId,
  assetId: alerts.assetId,
  kind: alerts.kind,
  threshold: alerts.threshold,
  refPrice: alerts.refPrice,
  repeat: alerts.repeat,
  status: alerts.status,
  lastTriggeredAt: alerts.lastTriggeredAt,
  symbol: assets.symbol,
  name: assets.name,
  currency: assets.currency,
  type: assets.type,
} as const;

type CrudRow = {
  id: string;
  userId: string;
  assetId: string;
  kind: AlertKind;
  threshold: string;
  refPrice: string | null;
  repeat: boolean;
  status: AlertStatus;
  lastTriggeredAt: Date | null;
  symbol: string;
  name: string;
  currency: string;
  type: AssetRow['type'];
};

function toRecord(row: CrudRow): AlertRecord {
  return {
    id: row.id,
    userId: row.userId,
    assetId: row.assetId,
    kind: row.kind,
    threshold: Number(row.threshold),
    refPrice: row.refPrice === null ? null : Number(row.refPrice),
    repeat: row.repeat,
    status: row.status,
    lastTriggeredAt: row.lastTriggeredAt,
    asset: {
      id: row.assetId,
      symbol: row.symbol,
      name: row.name,
      currency: row.currency,
      type: row.type,
    },
  };
}

export function createAlertRepository(db: Database) {
  return {
    /** Create an alert. `status` starts `active`; `refPrice` is caller-captured. */
    async create(input: CreateAlertInput): Promise<AlertRecord> {
      const [inserted] = await db
        .insert(alerts)
        .values({
          userId: input.userId,
          assetId: input.assetId,
          kind: input.kind,
          threshold: String(input.threshold),
          refPrice: input.refPrice === null ? null : String(input.refPrice),
          repeat: input.repeat,
          status: 'active',
        })
        .returning({ id: alerts.id });
      if (!inserted) throw new Error('alert insert returned no row');
      const record = await this.findByIdForUser(input.userId, inserted.id);
      if (!record) throw new Error('alert vanished after insert');
      return record;
    },

    /** The caller's alerts, newest first, each with its asset identity. */
    async listForUser(userId: string): Promise<AlertRecord[]> {
      const rows = await db
        .select(CRUD_COLUMNS)
        .from(alerts)
        .innerJoin(assets, eq(alerts.assetId, assets.id))
        .where(eq(alerts.userId, userId))
        .orderBy(alerts.id);
      return rows.map((r) => toRecord(r as CrudRow)).reverse();
    },

    /** One owned alert, or null when the id is missing or another user's (§10). */
    async findByIdForUser(userId: string, id: string): Promise<AlertRecord | null> {
      const [row] = await db
        .select(CRUD_COLUMNS)
        .from(alerts)
        .innerJoin(assets, eq(alerts.assetId, assets.id))
        .where(and(eq(alerts.id, id), eq(alerts.userId, userId)))
        .limit(1);
      return row ? toRecord(row as CrudRow) : null;
    },

    /**
     * Patch an owned alert's threshold/repeat. Returns the updated record, or
     * null when the id is not the caller's. `patch` with no fields is a no-op
     * read.
     */
    async update(
      userId: string,
      id: string,
      patch: { threshold?: number; repeat?: boolean },
    ): Promise<AlertRecord | null> {
      const set: { threshold?: string; repeat?: boolean } = {};
      if (patch.threshold !== undefined) set.threshold = String(patch.threshold);
      if (patch.repeat !== undefined) set.repeat = patch.repeat;
      if (Object.keys(set).length > 0) {
        const updated = await db
          .update(alerts)
          .set(set)
          .where(and(eq(alerts.id, id), eq(alerts.userId, userId)))
          .returning({ id: alerts.id });
        if (updated.length === 0) return null;
      }
      return this.findByIdForUser(userId, id);
    },

    /** Re-arm an owned alert: reset it to `active`. Returns null if not the caller's. */
    async rearm(userId: string, id: string): Promise<AlertRecord | null> {
      const updated = await db
        .update(alerts)
        .set({ status: 'active' })
        .where(and(eq(alerts.id, id), eq(alerts.userId, userId)))
        .returning({ id: alerts.id });
      if (updated.length === 0) return null;
      return this.findByIdForUser(userId, id);
    },

    /** Delete an owned alert. Returns false when the id is not the caller's. */
    async remove(userId: string, id: string): Promise<boolean> {
      const removed = await db
        .delete(alerts)
        .where(and(eq(alerts.id, id), eq(alerts.userId, userId)))
        .returning({ id: alerts.id });
      return removed.length > 0;
    },

    // --- evaluator reads (system-wide, not user-scoped) --------------------

    /** Every `active` alert joined with its asset's provider routing + identity. */
    async listActiveWithAsset(): Promise<ActiveAlert[]> {
      const rows = await db
        .select({
          id: alerts.id,
          userId: alerts.userId,
          assetId: alerts.assetId,
          kind: alerts.kind,
          threshold: alerts.threshold,
          refPrice: alerts.refPrice,
          repeat: alerts.repeat,
          lastTriggeredAt: alerts.lastTriggeredAt,
          providerId: assets.providerId,
          providerRef: assets.providerRef,
          symbol: assets.symbol,
          name: assets.name,
          currency: assets.currency,
          type: assets.type,
        })
        .from(alerts)
        .innerJoin(assets, eq(alerts.assetId, assets.id))
        .where(eq(alerts.status, 'active'));
      return rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        assetId: r.assetId,
        kind: r.kind,
        threshold: Number(r.threshold),
        refPrice: r.refPrice === null ? null : Number(r.refPrice),
        repeat: r.repeat,
        lastTriggeredAt: r.lastTriggeredAt,
        providerId: r.providerId,
        providerRef: r.providerRef,
        symbol: r.symbol,
        name: r.name,
        currency: r.currency,
        type: r.type,
      }));
    },

    /**
     * Record a fire: stamp `last_triggered_at` and set the resulting status
     * (`triggered` for one-shot, `active` for repeat). System-wide by id — the
     * caller (evaluator) has already authorized the fire.
     */
    async recordTriggered(id: string, status: AlertStatus, triggeredAt: Date): Promise<void> {
      await db
        .update(alerts)
        .set({ status, lastTriggeredAt: triggeredAt })
        .where(eq(alerts.id, id));
    },

    /** The dispatcher's render context for one alert, or null if it is gone. */
    async findNotificationContext(id: string): Promise<AlertNotificationContext | null> {
      const [row] = await db
        .select({
          userId: alerts.userId,
          assetId: alerts.assetId,
          kind: alerts.kind,
          threshold: alerts.threshold,
          symbol: assets.symbol,
          name: assets.name,
          currency: assets.currency,
        })
        .from(alerts)
        .innerJoin(assets, eq(alerts.assetId, assets.id))
        .where(eq(alerts.id, id))
        .limit(1);
      if (!row) return null;
      return {
        userId: row.userId,
        assetId: row.assetId,
        symbol: row.symbol,
        name: row.name,
        currency: row.currency,
        kind: row.kind,
        threshold: Number(row.threshold),
      };
    },
  };
}

export type AlertRepository = ReturnType<typeof createAlertRepository>;
