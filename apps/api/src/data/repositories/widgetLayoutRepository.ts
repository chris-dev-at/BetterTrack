import { and, eq } from 'drizzle-orm';

import type { Database } from '../db';
import { widgetLayouts } from '../schema';

/**
 * Per-account widget-composition persistence (mobile board #68 item 3).
 *
 * SCOPING (§10). Every statement in this file is keyed on the FULL primary key
 * `(user_id, namespace)`, and `userId` always arrives from the authenticated
 * principal — never from a request body or a query parameter. There is no
 * "find by namespace" that omits the owner, so a caller cannot name another
 * account's row: a namespace that exists for someone else simply is not found
 * for the caller, which is the same answer as never having saved one.
 *
 * The document is stored verbatim. This layer neither parses nor rewrites it —
 * shape (JSON object) and size are settled at the HTTP edge before anything
 * reaches here.
 */

export interface WidgetLayoutRecord {
  doc: unknown;
  updatedAt: Date;
}

export interface WidgetLayoutRepository {
  /** The caller's document for one namespace, or `null` when never saved. */
  find(userId: string, namespace: string): Promise<WidgetLayoutRecord | null>;
  /** Upsert the caller's document for one namespace; returns what landed. */
  upsert(userId: string, namespace: string, doc: unknown): Promise<WidgetLayoutRecord>;
}

export function createWidgetLayoutRepository(db: Database): WidgetLayoutRepository {
  return {
    async find(userId, namespace) {
      const [row] = await db
        .select({ doc: widgetLayouts.doc, updatedAt: widgetLayouts.updatedAt })
        .from(widgetLayouts)
        .where(and(eq(widgetLayouts.userId, userId), eq(widgetLayouts.namespace, namespace)))
        .limit(1);
      return row ? { doc: row.doc, updatedAt: row.updatedAt } : null;
    },

    /**
     * Last-write-wins upsert. IDEMPOTENCY KEY: the composite primary key
     * `(user_id, namespace)` — the row IS the key, so a retried or duplicated
     * PUT converges on the same single row instead of accumulating versions.
     * Re-sending an identical document therefore changes nothing but the stamp.
     *
     * The stamp is written and returned from the same statement, so the revision
     * the caller records is exactly the one that landed; a follow-up SELECT could
     * observe a newer write from the user's other device and hand back a stamp
     * that never belonged to this response.
     */
    async upsert(userId, namespace, doc) {
      const now = new Date();
      const [row] = await db
        .insert(widgetLayouts)
        .values({ userId, namespace, doc, updatedAt: now })
        .onConflictDoUpdate({
          target: [widgetLayouts.userId, widgetLayouts.namespace],
          set: { doc, updatedAt: now },
        })
        .returning({ doc: widgetLayouts.doc, updatedAt: widgetLayouts.updatedAt });
      // The upsert always writes exactly one row; a missing RETURNING row would
      // mean the statement did not run, which must not read as a silent success.
      if (!row) throw new Error('widget layout upsert returned no row');
      return { doc: row.doc, updatedAt: row.updatedAt };
    },
  };
}
