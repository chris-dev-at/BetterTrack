import type { QueueRegistry } from '../queues';
import { QUEUE_NAMES, type JobDefinition } from '../types';

import type {
  AnnouncementPublishRequest,
  AnnouncementService,
} from '../../services/announcements/announcementService';

/**
 * `announcements.publishDue` — publication of admin-composed announcements
 * (PROJECTPLAN.md §9; ADMIN-W7a, #1909).
 *
 * ── Why this job exists ─────────────────────────────────────────────────────
 *
 * The composer has always offered `startsAt` and `endsAt`, and until now they
 * filtered the BANNER only. Delivery happened inline in the admin's `POST` /
 * `PATCH`: ticking **Active** walked the whole user table on the request thread
 * and inserted an inbox notification for every account, immediately. An operator
 * who scheduled an announcement for next Monday therefore mailed everyone today
 * and showed the banner on Monday — the page's own helper text promised the
 * opposite. There was no announcements job at all.
 *
 * Now the window governs both halves, because both halves read the same
 * predicate, and the walk happens here, off the request.
 *
 * ── Two entry points, one body ──────────────────────────────────────────────
 *
 *  • **the sweep** (empty payload, the repeatable schedule) — publishes every
 *    announcement whose window has opened and which has never been stamped.
 *    This is the durable path: if every targeted enqueue below were lost, the
 *    next tick would still publish everything that is due.
 *  • **a targeted pass** (`{ announcementId, attempt }`) — enqueued by a save
 *    whose window is already open, so "publish now" does not wait up to five
 *    minutes, and by the single bounded retry after a partial delivery. It
 *    RE-CHECKS the window before walking: an announcement deactivated,
 *    rescheduled or expired between enqueue and run is skipped, not delivered.
 *
 * ── Idempotency (§9 — the key, stated in code) ──────────────────────────────
 *
 * Two layers, named where they are enforced in `announcementService.ts`:
 *
 *  1. **Per recipient** — `payload.eventKey` =
 *     `account.notice:announcement:<id>:v1`, backed by the notifications
 *     table's partial unique index on `(user_id, payload->>'eventKey')`. Running
 *     this job twice over one announcement inserts nothing the second time.
 *  2. **Per announcement** — `announcements.id WHERE published_at IS NULL`,
 *     backed by a conditional UPDATE (`repo.claimPublication`). Two workers that
 *     walked the same row concurrently both reach it and exactly one wins, so
 *     `delivered_count` is recorded once and the `announcement.publish` audit
 *     row happens once.
 *
 * The order is **walk, then claim**. Claiming first would leave an announcement
 * permanently half-delivered if the worker died mid-walk: the row would read as
 * published while a suffix of the user base never got its notice. Walking first
 * means a death mid-walk leaves the stamp NULL and the next tick simply redoes
 * the walk — free, because of layer 1. The accepted cost is that two truly
 * simultaneous runs may both walk; they cannot both deliver or both record.
 *
 * ── Failure handling ────────────────────────────────────────────────────────
 *
 * A per-recipient insert failure does NOT fail the run and does NOT leave the
 * announcement unstamped. The old `failed === 0` stamp condition is exactly what
 * made one transient error into an unbounded re-walk of every account on every
 * later edit. The failure is recorded in `failed_count` and in the audit meta,
 * and one bounded retry is enqueued — one, never a ladder.
 */

export const ANNOUNCEMENT_PUBLISH_SCHEDULER_ID = 'announcements.publishDue';
/**
 * Every five minutes. A banner is not a trading signal: five minutes is a
 * schedule an operator experiences as "it went out", while keeping the sweep's
 * cost — one indexed query over a table with a handful of rows — negligible.
 * A save whose window is already open does not wait for it at all.
 */
export const ANNOUNCEMENT_PUBLISH_CRON = '*/5 * * * *';
/** The deploy timezone, matching every other scheduled job in this folder. */
export const ANNOUNCEMENT_PUBLISH_TZ = 'Europe/Vienna';

export interface AnnouncementPublishJobDeps {
  announcements: Pick<AnnouncementService, 'publishDue' | 'publishAnnouncement'>;
}

/**
 * The producer side of the targeted pass, in one place so the API context and
 * the worker cannot map the request onto the queue differently. `delayMs` is the
 * retry's backoff; without it the job is eligible immediately.
 */
export function createAnnouncementPublishEnqueuer(
  queues: QueueRegistry,
): (request: AnnouncementPublishRequest) => Promise<void> {
  return async (request: AnnouncementPublishRequest): Promise<void> => {
    await queues.enqueue(
      QUEUE_NAMES.announcementsPublishDue,
      { announcementId: request.announcementId, attempt: request.attempt },
      ...(request.delayMs !== undefined ? [{ delay: request.delayMs }] : []),
    );
  };
}

export function createAnnouncementPublishJob(
  deps: AnnouncementPublishJobDeps,
): JobDefinition<'announcements.publishDue'> {
  return {
    name: QUEUE_NAMES.announcementsPublishDue,
    schedule: {
      id: ANNOUNCEMENT_PUBLISH_SCHEDULER_ID,
      pattern: ANNOUNCEMENT_PUBLISH_CRON,
      tz: ANNOUNCEMENT_PUBLISH_TZ,
    },
    async handler(job, ctx) {
      const announcementId = job.data?.announcementId;
      if (announcementId) {
        const attempt = job.data?.attempt ?? 0;
        const outcome = await deps.announcements.publishAnnouncement(announcementId, attempt);
        if (outcome.status === 'skipped') {
          // Not an error: the window closed, the operator switched it off, or
          // the sweep got there first. Logged so a "why did my announcement not
          // go out" question has an answer.
          ctx.logger.info(
            { announcementId, attempt, reason: outcome.reason },
            'announcements.publishDue skipped one announcement',
          );
          return { due: 0, published: 0, inserted: 0, failed: 0, retriesScheduled: 0 };
        }
        return {
          due: 1,
          published: outcome.status === 'published' ? 1 : 0,
          inserted: outcome.inserted,
          failed: outcome.failed,
          retriesScheduled: outcome.retryScheduled ? 1 : 0,
        };
      }

      const summary = await deps.announcements.publishDue();
      if (summary.due > 0) {
        ctx.logger.info(summary, 'announcements.publishDue complete');
      }
      // Counts only — never an id (`JobRunSummary` is numbers-only, and the
      // admin operations cockpit renders a job's return value). Spread into a
      // plain record so the summary satisfies that index signature.
      return { ...summary };
    },
  };
}
