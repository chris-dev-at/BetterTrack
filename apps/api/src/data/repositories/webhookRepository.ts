import { and, arrayContains, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  webhookDeliveries,
  webhookSubscriptions,
  type WebhookDeliveryRow,
  type WebhookSubscriptionRow,
} from '../schema';

/**
 * Outbound-webhook persistence (§13.5 V5-P10, issue 1/2). Two repos:
 * subscriptions (user-owned CRUD + the dispatcher's failure accounting) and the
 * bounded delivery log. The signing secret is only ever the AES-256-GCM
 * envelope column — the plaintext never reaches this layer.
 */

export interface CreateWebhookSubscriptionInput {
  userId: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  secretEncrypted: string;
}

/**
 * A partial subscription patch. Fields left `undefined` are untouched; a field
 * explicitly set to `null` clears the column. The service builds these so a
 * re-enable resets the whole failure state in one write.
 */
export interface UpdateWebhookSubscriptionPatch {
  url?: string;
  description?: string | null;
  eventTypes?: string[];
  enabled?: boolean;
  disabledReason?: string | null;
  disabledAt?: Date | null;
  consecutiveFailures?: number;
  failureWindowStartedAt?: Date | null;
}

export function createWebhookSubscriptionRepository(db: Database) {
  return {
    async create(input: CreateWebhookSubscriptionInput): Promise<WebhookSubscriptionRow> {
      const [row] = await db
        .insert(webhookSubscriptions)
        .values({
          userId: input.userId,
          url: input.url,
          description: input.description,
          eventTypes: input.eventTypes,
          secretEncrypted: input.secretEncrypted,
        })
        .returning();
      if (!row) throw new Error('Failed to insert webhook subscription');
      return row;
    },

    /** A user's subscriptions, newest first. */
    async listForUser(userId: string): Promise<WebhookSubscriptionRow[]> {
      return db
        .select()
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.userId, userId))
        .orderBy(desc(webhookSubscriptions.createdAt));
    },

    /** How many subscriptions the user already has (enforces the per-user cap). */
    async countForUser(userId: string): Promise<number> {
      const rows = await db
        .select({ id: webhookSubscriptions.id })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.userId, userId));
      return rows.length;
    },

    /** A subscription the caller owns, or undefined (→ 404 without id-probing). */
    async findByIdForUser(userId: string, id: string): Promise<WebhookSubscriptionRow | undefined> {
      const [row] = await db
        .select()
        .from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.userId, userId)))
        .limit(1);
      return row;
    },

    /**
     * The enabled subscriptions of `userId` that listen to `eventType` — the
     * fan-out lookup for one incoming event. Only ever a user's OWN
     * subscriptions, so a delivery can only carry that user's own data.
     */
    async findEnabledForUserEvent(
      userId: string,
      eventType: string,
    ): Promise<WebhookSubscriptionRow[]> {
      return db
        .select()
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.userId, userId),
            eq(webhookSubscriptions.enabled, true),
            arrayContains(webhookSubscriptions.eventTypes, [eventType]),
          ),
        );
    },

    /** Load by id alone — the delivery job's lookup (ownership already implied). */
    async findById(id: string): Promise<WebhookSubscriptionRow | undefined> {
      const [row] = await db
        .select()
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, id))
        .limit(1);
      return row;
    },

    /** Apply a user-scoped patch; returns the updated row or undefined (not owner). */
    async update(
      userId: string,
      id: string,
      patch: UpdateWebhookSubscriptionPatch,
    ): Promise<WebhookSubscriptionRow | undefined> {
      const [row] = await db
        .update(webhookSubscriptions)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.userId, userId)))
        .returning();
      return row;
    },

    /** Delete a subscription the caller owns (cascades its deliveries). */
    async delete(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.userId, userId)))
        .returning({ id: webhookSubscriptions.id });
      return rows.length > 0;
    },

    // ── Delivery accounting (dispatcher-side; not user-scoped) ────────────────

    /** A delivered event: clear the failure streak and stamp the success. */
    async recordSuccess(id: string, at: Date): Promise<void> {
      await db
        .update(webhookSubscriptions)
        .set({
          consecutiveFailures: 0,
          // The streak is gone, so its window anchor goes with it — the column
          // is null exactly when the counter is 0.
          failureWindowStartedAt: null,
          lastDeliveryAt: at,
          lastSuccessAt: at,
          updatedAt: at,
        })
        .where(eq(webhookSubscriptions.id, id));
    },

    /**
     * A permanently-failed delivery: advance the WINDOWED streak, returning the
     * new count.
     *
     * The streak is anchored at its first failure. A failure landing while that
     * anchor is still inside `windowMs` extends the streak; one landing after
     * it starts a fresh streak at 1 with a new anchor, so failures spread over
     * months never accumulate into an auto-disable.
     */
    async incrementFailure(id: string, at: Date, windowMs: number): Promise<number> {
      // Explicit `::timestamptz` on both interpolated instants, matching the
      // repository precedent (notificationRepository.markRead): the driver
      // sends them as untyped parameters otherwise and leaves the resolution to
      // Postgres' inference.
      const windowStartIso = new Date(at.getTime() - windowMs).toISOString();
      const atIso = at.toISOString();
      // Decided in SQL, not in JS: the whole read-decide-write is one atomic
      // statement, so concurrent failed deliveries for one subscription can
      // neither lose a bump nor race on restarting the window.
      const withinWindow = sql`${webhookSubscriptions.failureWindowStartedAt} is not null and ${webhookSubscriptions.failureWindowStartedAt} > ${windowStartIso}::timestamptz`;
      const [row] = await db
        .update(webhookSubscriptions)
        .set({
          consecutiveFailures: sql`case when ${withinWindow} then ${webhookSubscriptions.consecutiveFailures} + 1 else 1 end`,
          failureWindowStartedAt: sql`case when ${withinWindow} then ${webhookSubscriptions.failureWindowStartedAt} else ${atIso}::timestamptz end`,
          lastDeliveryAt: at,
          updatedAt: at,
        })
        .where(eq(webhookSubscriptions.id, id))
        .returning({ consecutiveFailures: webhookSubscriptions.consecutiveFailures });
      return row?.consecutiveFailures ?? 0;
    },

    /** Auto-disable after the streak crosses the threshold. */
    async disable(id: string, reason: string, at: Date): Promise<void> {
      await db
        .update(webhookSubscriptions)
        .set({ enabled: false, disabledReason: reason, disabledAt: at, updatedAt: at })
        .where(eq(webhookSubscriptions.id, id));
    },
  };
}

export interface RecordWebhookDeliveryInput {
  /** Stable delivery id (minted at enqueue, reused across BullMQ retries). */
  id: string;
  subscriptionId: string;
  eventType: string;
  status: 'success' | 'failed';
  responseStatus: number | null;
  attempts: number;
  error: string | null;
  createdAt?: Date;
}

export function createWebhookDeliveryRepository(db: Database) {
  return {
    /**
     * Record a delivery outcome. Idempotent on the delivery id (a BullMQ retry
     * that reaches a terminal outcome twice writes one row): returns `true` only
     * when the row was newly inserted, so the caller applies the streak
     * side-effects exactly once.
     */
    async record(input: RecordWebhookDeliveryInput): Promise<boolean> {
      const rows = await db
        .insert(webhookDeliveries)
        .values({
          id: input.id,
          subscriptionId: input.subscriptionId,
          eventType: input.eventType,
          status: input.status,
          responseStatus: input.responseStatus,
          attempts: input.attempts,
          error: input.error,
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        })
        .onConflictDoNothing({ target: webhookDeliveries.id })
        .returning({ id: webhookDeliveries.id });
      return rows.length > 0;
    },

    /** The subscription's delivery log, newest first, capped at `limit`. */
    async listForSubscription(
      subscriptionId: string,
      limit: number,
    ): Promise<WebhookDeliveryRow[]> {
      return db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit);
    },

    /**
     * Retention: delete at most `limit` oldest deliveries before `cutoff`;
     * returns how many. The scheduled sweep repeats this bounded statement
     * until it returns fewer than `limit`, avoiding one unbounded full-table
     * delete over a log that grows with every event of every subscription.
     */
    async deleteOlderThan(cutoff: Date, limit: number): Promise<number> {
      const candidates = db
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(lt(webhookDeliveries.createdAt, cutoff))
        .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id))
        .limit(limit);
      const rows = await db
        .delete(webhookDeliveries)
        .where(inArray(webhookDeliveries.id, candidates))
        .returning({ id: webhookDeliveries.id });
      return rows.length;
    },
  };
}

export type WebhookSubscriptionRepository = ReturnType<typeof createWebhookSubscriptionRepository>;
export type WebhookDeliveryRepository = ReturnType<typeof createWebhookDeliveryRepository>;
