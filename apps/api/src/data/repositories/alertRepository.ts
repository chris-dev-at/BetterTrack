import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';

import type { AlertKind, AlertStatus } from '@bettertrack/contracts';

import type { Database } from '../db';
import { alerts, assets } from '../schema';
import type { AssetRow } from '../schema';

/**
 * Price-alert persistence (PROJECTPLAN.md §14, V3-P10 arc b). The CRUD reads are
 * always scoped by `user_id` so a foreign alert id is indistinguishable from a
 * missing one (no IDOR, §10). The evaluator reads (`listActiveWithAsset`,
 * `claimTrigger`, `findNotificationContext`) run system-wide — the minute job
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

export interface AlertAssetVisibilityOptions {
  /** False restricts CRUD joins to global market assets before identity is selected. */
  includeCustomAssets?: boolean;
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

type ActiveAlertRow = Omit<ActiveAlert, 'threshold' | 'refPrice'> & {
  threshold: string;
  refPrice: string | null;
};

function toActiveAlert(row: ActiveAlertRow): ActiveAlert {
  return {
    ...row,
    threshold: Number(row.threshold),
    refPrice: row.refPrice === null ? null : Number(row.refPrice),
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
    async listForUser(
      userId: string,
      options?: AlertAssetVisibilityOptions,
    ): Promise<AlertRecord[]> {
      const rows = await db
        .select(CRUD_COLUMNS)
        .from(alerts)
        .innerJoin(assets, eq(alerts.assetId, assets.id))
        .where(
          and(
            eq(alerts.userId, userId),
            options?.includeCustomAssets === false ? isNull(assets.ownerId) : undefined,
          ),
        )
        .orderBy(alerts.id);
      return rows.map((r) => toRecord(r as CrudRow)).reverse();
    },

    /** One owned alert, or null when the id is missing or another user's (§10). */
    async findByIdForUser(
      userId: string,
      id: string,
      options?: AlertAssetVisibilityOptions,
    ): Promise<AlertRecord | null> {
      const [row] = await db
        .select(CRUD_COLUMNS)
        .from(alerts)
        .innerJoin(assets, eq(alerts.assetId, assets.id))
        .where(
          and(
            eq(alerts.id, id),
            eq(alerts.userId, userId),
            options?.includeCustomAssets === false ? isNull(assets.ownerId) : undefined,
          ),
        )
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
      options?: AlertAssetVisibilityOptions,
    ): Promise<AlertRecord | null> {
      if (!(await this.findByIdForUser(userId, id, options))) return null;
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
      return this.findByIdForUser(userId, id, options);
    },

    /**
     * Re-arm an owned alert: reset it to `active` AND clear `last_triggered_at`.
     * Returns null if not the caller's.
     *
     * Clearing the stamp is what makes the re-arm real: `last_triggered_at` is
     * the evaluator's 24 h cooldown marker (§14), so leaving it standing meant a
     * re-armed alert whose condition is still met stayed silent for the rest of
     * the cooldown — the user asked for it to be armed again and got a `200`
     * saying it was. The stamp is a cooldown anchor, not an audit trail (the
     * fire's notification row is that), so a re-arm resets it to "never fired".
     */
    async rearm(
      userId: string,
      id: string,
      options?: AlertAssetVisibilityOptions,
    ): Promise<AlertRecord | null> {
      if (!(await this.findByIdForUser(userId, id, options))) return null;
      const updated = await db
        .update(alerts)
        .set({ status: 'active', lastTriggeredAt: null })
        .where(and(eq(alerts.id, id), eq(alerts.userId, userId)))
        .returning({ id: alerts.id });
      if (updated.length === 0) return null;
      return this.findByIdForUser(userId, id, options);
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

    /**
     * Every `active` alert joined with its asset's provider routing + identity.
     *
     * `includeCustomAssets: false` restricts the join to GLOBAL market assets
     * before any identity column is selected — the evaluator's unguarded rail.
     * An account-owned (custom) asset's symbol, name and manual provider ref
     * are that account's own content, so the evaluator reads them only through
     * {@link listActiveCustomAssetsForUser}, inside the owner's transition lock.
     */
    async listActiveWithAsset(options?: AlertAssetVisibilityOptions): Promise<ActiveAlert[]> {
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
        .where(
          and(
            eq(alerts.status, 'active'),
            options?.includeCustomAssets === false ? isNull(assets.ownerId) : undefined,
          ),
        );
      return rows.map(toActiveAlert);
    },

    /**
     * The distinct accounts owning at least one `active` alert on one of THEIR
     * OWN custom assets. Identity only: no alert rule, no asset identity and no
     * provider ref is selected, so the evaluator can discover which accounts to
     * lock without first reading killed content.
     */
    async listActiveCustomAssetOwnerIds(): Promise<string[]> {
      const rows = await db
        .selectDistinct({ userId: alerts.userId })
        .from(alerts)
        .innerJoin(assets, eq(alerts.assetId, assets.id))
        .where(and(eq(alerts.status, 'active'), eq(assets.ownerId, alerts.userId)));
      return rows.map((r) => r.userId);
    },

    /**
     * The third rail, made explicit: `active` alerts whose asset is a CUSTOM
     * asset owned by someone OTHER than the alert's owner. Neither evaluator
     * rail can serve these — the global rail excludes owned assets and the
     * per-owner rail only locks the alert's own account, which is not the
     * account whose content the asset is. Unreachable today (alert creation is
     * owner-scoped and chain assets are `MIRROR_ASSET_NOT_SYNCABLE`), so the
     * fail-closed drop stands; counting it means the gap is logged rather than
     * living implicitly between two `where` clauses.
     */
    async countActiveForeignCustomAssetAlerts(): Promise<number> {
      const rows = await db
        .select({ id: alerts.id })
        .from(alerts)
        .innerJoin(assets, eq(alerts.assetId, assets.id))
        .where(
          and(
            eq(alerts.status, 'active'),
            isNotNull(assets.ownerId),
            ne(assets.ownerId, alerts.userId),
          ),
        );
      return rows.length;
    },

    /**
     * One account's `active` alerts on its OWN custom assets. The evaluator
     * calls this only inside that account's transition lock, so a winning
     * paranoid enable means the query never runs at all.
     */
    async listActiveCustomAssetsForUser(userId: string): Promise<ActiveAlert[]> {
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
        .where(
          and(eq(alerts.status, 'active'), eq(alerts.userId, userId), eq(assets.ownerId, userId)),
        );
      return rows.map(toActiveAlert);
    },

    /**
     * Claim a fire ATOMICALLY: stamp `last_triggered_at` and set the resulting
     * status (`triggered` for one-shot, `active` for repeat) — but only while
     * the row still carries the exact pre-fire snapshot the caller read.
     *
     * This is the evaluator's real idempotency guard. Its snapshot always comes
     * from a `status = 'active'` read, so the witness is that status plus the
     * observed `last_triggered_at` (null-safe: a never-fired alert must still be
     * never-fired). Two evaluator runs that both loaded the same pre-fire row —
     * a BullMQ re-delivery of a stalled run, a second worker replica, a raised
     * concurrency — therefore compete for one claim and exactly one wins,
     * whether or not they share a minute window. Returns true for the winner.
     *
     * System-wide by id: the caller (evaluator) has already authorized the fire.
     */
    async claimTrigger(input: {
      id: string;
      /** The `last_triggered_at` the caller observed (the CAS witness). */
      expectedLastTriggeredAt: Date | null;
      status: AlertStatus;
      triggeredAt: Date;
    }): Promise<boolean> {
      const claimed = await db
        .update(alerts)
        .set({ status: input.status, lastTriggeredAt: input.triggeredAt })
        .where(
          and(
            eq(alerts.id, input.id),
            eq(alerts.status, 'active'),
            input.expectedLastTriggeredAt === null
              ? isNull(alerts.lastTriggeredAt)
              : eq(alerts.lastTriggeredAt, input.expectedLastTriggeredAt),
          ),
        )
        .returning({ id: alerts.id });
      return claimed.length > 0;
    },

    /**
     * Undo a claim this run took but could not deliver (the notification
     * enqueue failed): restore the pre-fire snapshot so the next run retries the
     * alert instead of leaving it `triggered`/on cooldown with nothing sent
     * (#367). Conditional on the claim still being exactly as written, so a
     * concurrent re-arm or edit is never clobbered. Returns true when restored.
     */
    async releaseTriggerClaim(input: {
      id: string;
      /** What this run wrote when it claimed. */
      claimedStatus: AlertStatus;
      claimedAt: Date;
      /** The `last_triggered_at` to put back. */
      lastTriggeredAt: Date | null;
    }): Promise<boolean> {
      const released = await db
        .update(alerts)
        .set({ status: 'active', lastTriggeredAt: input.lastTriggeredAt })
        .where(
          and(
            eq(alerts.id, input.id),
            eq(alerts.status, input.claimedStatus),
            eq(alerts.lastTriggeredAt, input.claimedAt),
          ),
        )
        .returning({ id: alerts.id });
      return released.length > 0;
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
