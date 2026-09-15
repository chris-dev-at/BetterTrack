import type {
  ActiveAnnouncement,
  Announcement,
  AnnouncementDeliveryState,
  AnnouncementSeverity,
  CreateAnnouncementRequest,
  UpdateAnnouncementRequest,
} from '@bettertrack/contracts';
import { ANNOUNCEMENT_NOTIFICATION_TYPE } from '@bettertrack/contracts';

import type {
  AnnouncementRepository,
  UpdateAnnouncementInput,
} from '../../data/repositories/announcementRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { AnnouncementRow } from '../../data/schema';
import { badRequest, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { AuditService } from '../audit/auditService';
import { resolveEmailLocale, type EmailLocale } from '../email/emailI18n';
import { fanOutAnnouncement } from '../notifications/announcementFanOut';

/**
 * Admin-composed in-app announcements (§13.4 V4-P5b; rebuilt by ADMIN-W7a
 * #1909). Owns:
 *  1. Admin CRUD over the composer's rows (list / create / update / delete), each
 *     audit-logged with a stable action tag. **A write never delivers anything.**
 *  2. Publication: {@link AnnouncementService.publishDue} and
 *     {@link AnnouncementService.publishAnnouncement} run the shared
 *     {@link fanOutAnnouncement} primitive — one inbox notification per user in
 *     their stored locale — and are driven by the `announcements.publishDue`
 *     BullMQ job, never by an HTTP request.
 *  3. The user surface — `listActiveForUser` returns the currently-active,
 *     not-dismissed set for the caller in their locale; `dismiss` stamps a per-user
 *     dismissal (idempotent).
 *
 * ── What #1909 changed, and why ──────────────────────────────────────────────
 *
 * Before, `create()` did `if (row.active) await publish(row)` and `update()`
 * published on the `active` false→true edge. `startsAt` was read by nothing but
 * the banner query, so an operator who scheduled an announcement for next
 * Monday and ticked **Active** mailed every user on the spot while the banner
 * waited for Monday — the page's own helper text told them the opposite. And
 * the fan-out ran INSIDE the admin's request, keyset-walking the whole user
 * table before the response came back.
 *
 * Now `startsAt` defers BOTH halves, because both halves read the same window,
 * and the walk happens on a worker.
 *
 * ── Idempotency (§9): two layers, and both are load-bearing ─────────────────
 *
 *  • **Per recipient** — idempotency key `announcementEventKey(id)` =
 *    `account.notice:announcement:<id>:v1`, enforced by the notifications
 *    table's partial unique index on `(user_id, payload->>'eventKey')`. A re-run
 *    inserts exactly the rows that are missing and can never double-notify.
 *  • **Per announcement** — idempotency key `announcements.id WHERE
 *    published_at IS NULL`, enforced by the conditional UPDATE in
 *    `repo.claimPublication`. Of two concurrent runs exactly one records the
 *    publication, so the counts and the audit row happen once.
 *
 * **Walk-then-claim, chosen over claim-then-walk.** Claiming first would make a
 * worker that dies mid-walk permanently un-republishable: the row would already
 * read as published while a suffix of the user base never got its inbox entry,
 * and nothing would ever come back for them. Walking first means a death
 * mid-walk leaves `published_at` NULL and the very next sweep tick redoes the
 * walk; the per-recipient key makes that redo free. The price is that two
 * genuinely simultaneous runs can both WALK — they just cannot both DELIVER or
 * both RECORD. That price is small (the loser inserts nothing) and is paid on a
 * job that fires every five minutes over a handful of rows.
 *
 * Delivery is banner + inbox only. No email / phone push / web push routing runs
 * through the notification matrix — the fan-out inserts inbox rows directly and
 * the banner is a separate SPA surface. That's the V4-P5b acceptance criterion,
 * and #1909 does not widen it.
 */

/** Per-announcement event key: makes a re-publish idempotent per user, forever. */
export function announcementEventKey(id: string): string {
  return `account.notice:announcement:${id}:v1`;
}

/** Audit action tags — the admin write log a change on every mutation. */
const AUDIT = {
  create: 'announcement.create',
  update: 'announcement.update',
  publish: 'announcement.publish',
  unpublish: 'announcement.unpublish',
  delete: 'announcement.delete',
} as const;

export interface AnnouncementServiceActor {
  id: string;
  ip?: string | null;
}

/**
 * How many due announcements one sweep tick takes. A bound rather than a page
 * cursor: the predicate is self-advancing (a published row stops being due), so
 * the next tick simply continues, and a pathological backlog can never turn one
 * run into an unbounded walk of the user table × N announcements.
 */
export const ANNOUNCEMENT_PUBLISH_BATCH = 20;

/**
 * How long the single bounded retry waits after a partial delivery. Long enough
 * for a transient database blip to clear, short enough that the missing
 * recipients get their notice in the same operator session.
 */
export const ANNOUNCEMENT_PUBLISH_RETRY_DELAY_MS = 60_000;

/**
 * Passes one announcement may have. `0` is the first publication; `1` is the
 * single bounded retry after a partial delivery. There is no `2` — a retry that
 * still fails leaves `failed_count` standing on the row for the operator, and
 * the console shows it. An unbounded retry of a fan-out over every account is
 * exactly the shape of failure #1909 exists to remove.
 */
export const ANNOUNCEMENT_PUBLISH_MAX_ATTEMPT = 1;

/** Ask the worker to publish one announcement out of band. */
export interface AnnouncementPublishRequest {
  announcementId: string;
  /** 0 = first publication, 1 = the single bounded retry. */
  attempt: number;
  /** Delay before the job is eligible to run (the retry's backoff). */
  delayMs?: number;
}

/** What one publication pass did — the job logs it and returns its counts. */
export type AnnouncementPublishOutcome =
  | {
      status: 'published' | 'retried';
      users: number;
      inserted: number;
      failed: number;
      /** Whether this pass scheduled the one bounded retry. */
      retryScheduled: boolean;
    }
  | {
      /**
       * Another worker stamped the publication while this one was walking. The
       * per-recipient key means it delivered nothing new; it records nothing.
       */
      status: 'lost-claim';
      users: number;
      inserted: number;
      failed: number;
      retryScheduled: false;
    }
  | {
      status: 'skipped';
      reason: 'not-found' | 'inactive' | 'scheduled' | 'expired' | 'already-published';
    };

/** Aggregate of one sweep tick, shaped for a numbers-only `JobRunSummary`. */
export interface AnnouncementSweepResult {
  /** Rows the due predicate returned. */
  due: number;
  /** Rows this run stamped as published. */
  published: number;
  /** Inbox rows this run actually inserted. */
  inserted: number;
  /** Recipients whose insert threw across this run. */
  failed: number;
  /** Retries this run scheduled (0 or more, at most one per announcement). */
  retriesScheduled: number;
}

export interface AnnouncementServiceDeps {
  repo: AnnouncementRepository;
  users: Pick<UserRepository, 'listRecipientsAfter'>;
  notifications: Pick<NotificationRepository, 'insert'>;
  /** Admin audit trail; every mutation lands one row. */
  audit: AuditService;
  /**
   * Hand one announcement to the `announcements.publishDue` queue. Two callers:
   * a save whose window is already open (so "publish now" does not wait up to a
   * cron interval), and the single bounded retry after a partial delivery.
   *
   * Optional because `config.isTest` builds the context with `queues === null`
   * (BullMQ cannot drive ioredis-mock). Absent, nothing is enqueued and the
   * sweep is the only path — which is also what makes the "a save never fans
   * out" assertions in the service tests mean what they say.
   */
  enqueuePublish?: (request: AnnouncementPublishRequest) => Promise<void>;
  /**
   * Recipients per keyset page in the fan-out walk. Defaults to the shared
   * {@link ANNOUNCEMENT_FAN_OUT_PAGE_SIZE}. A seam rather than a constant so a
   * test can make the walk take more than one page and kill it in between —
   * the only way to exercise "a worker died mid-walk" without a real crash.
   */
  fanOutPageSize?: number;
  logger?: Logger;
  /** Clock seam — used for active-window resolution. */
  now?: () => Date;
}

export interface AnnouncementService {
  // ── Admin CRUD (§13.4 V4-P5b) ─────────────────────────────────────────────
  list(): Promise<Announcement[]>;
  create(input: CreateAnnouncementRequest, actor: AnnouncementServiceActor): Promise<Announcement>;
  update(
    id: string,
    input: UpdateAnnouncementRequest,
    actor: AnnouncementServiceActor,
  ): Promise<Announcement>;
  remove(id: string, actor: AnnouncementServiceActor): Promise<void>;
  // ── Publication (driven by `announcements.publishDue`, #1909) ─────────────
  /** Publish every announcement whose window has opened and which is unstamped. */
  publishDue(): Promise<AnnouncementSweepResult>;
  /** Publish exactly one announcement, re-checking its window first. */
  publishAnnouncement(id: string, attempt?: number): Promise<AnnouncementPublishOutcome>;
  // ── User surface ──────────────────────────────────────────────────────────
  listActiveForUser(
    userId: string,
    userLocale: string | null | undefined,
  ): Promise<ActiveAnnouncement[]>;
  dismiss(userId: string, announcementId: string): Promise<void>;
}

/**
 * The server's single reading of "where is this announcement in its lifecycle".
 *
 * Derived here and nowhere else (#1909): the browser renders the answer, it does
 * not compute it, so two consoles on two machines with two clock skews cannot
 * disagree with each other or with the job.
 *
 * Precedence, and the reason for each step:
 *  1. **expired** wins over everything. A closed window is terminal — the due
 *     predicate refuses it and the banner query hides it — so no combination of
 *     `active` and `publishedAt` can make users see it again. Saying anything
 *     else here would promise a delivery that can never happen.
 *  2. **draft** — not flagged active. Nothing shown, nothing delivered. This
 *     also covers a published announcement the operator switched back off:
 *     `deliveryState` describes what users experience NOW, and the row's
 *     `publishedAt` is still rendered beside it so the history is not lost.
 *  3. **published** — the fan-out completed and the stamp is on the row.
 *  4. **scheduled** — active, but the window has not opened. This is the state
 *     the whole issue exists for: the banner AND the inbox both wait.
 *  5. **publishing** — active, due, unstamped. The job owns it.
 */
export function deriveAnnouncementDeliveryState(
  row: Pick<AnnouncementRow, 'active' | 'startsAt' | 'endsAt' | 'publishedAt'>,
  at: Date,
): AnnouncementDeliveryState {
  const now = at.getTime();
  if (row.endsAt && row.endsAt.getTime() <= now) return 'expired';
  if (!row.active) return 'draft';
  if (row.publishedAt) return 'published';
  if (row.startsAt && row.startsAt.getTime() > now) return 'scheduled';
  return 'publishing';
}

function toAnnouncement(row: AnnouncementRow, at: Date): Announcement {
  return {
    id: row.id,
    severity: row.severity as AnnouncementSeverity,
    titleEn: row.titleEn,
    bodyEn: row.bodyEn,
    titleDe: row.titleDe,
    bodyDe: row.bodyDe,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    active: row.active,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    deliveryState: deriveAnnouncementDeliveryState(row, at),
    deliveredCount: row.deliveredCount,
    failedCount: row.failedCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Render the announcement in one locale (EN fallback for any unknown code). */
function renderForLocale(
  row: AnnouncementRow,
  locale: EmailLocale,
): { title: string; body: string } {
  return locale === 'de'
    ? { title: row.titleDe, body: row.bodyDe }
    : { title: row.titleEn, body: row.bodyEn };
}

export function createAnnouncementService(deps: AnnouncementServiceDeps): AnnouncementService {
  const { repo, users, notifications, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const announcementNotFound = () => notFound('Announcement not found.', 'ANNOUNCEMENT_NOT_FOUND');

  /**
   * Ask the worker for an out-of-band publication pass. Never throws into the
   * caller: a queue that is down must not fail an admin's save, and it costs
   * nothing — the five-minute sweep is the durable path, the enqueue is only
   * what makes "publish now" feel immediate.
   */
  async function requestPublish(request: AnnouncementPublishRequest): Promise<boolean> {
    if (!deps.enqueuePublish) return false;
    try {
      await deps.enqueuePublish(request);
      return true;
    } catch (err) {
      logger?.warn(
        { err, announcementId: request.announcementId, attempt: request.attempt },
        'announcement publish enqueue failed — the scheduled sweep still owns it',
      );
      return false;
    }
  }

  /**
   * One publication pass over one announcement: WALK, then CLAIM.
   *
   * Idempotency keys, stated where they are used (§9):
   *  • per recipient — `payload.eventKey` = {@link announcementEventKey}, backed
   *    by the notifications partial unique index on
   *    `(user_id, payload->>'eventKey')`;
   *  • per announcement — `announcements.id WHERE published_at IS NULL`, backed
   *    by the conditional UPDATE in `repo.claimPublication`.
   *
   * `published_at` is stamped when the walk COMPLETES, whatever `failed` is.
   * The old `failed === 0` condition is precisely what turned one bad recipient
   * insert into an `active = true, published_at IS NULL` row that the resumable
   * edge re-fired on every later edit — an unbounded re-walk of every account,
   * forever, over one transient error. The failure is not swallowed: it lands in
   * `failed_count`, in the `announcement.publish` audit meta, and in exactly one
   * bounded retry.
   */
  async function runPublication(
    row: AnnouncementRow,
    attempt: number,
  ): Promise<AnnouncementPublishOutcome> {
    const eventKey = announcementEventKey(row.id);
    const result = await fanOutAnnouncement({
      users,
      notifications,
      type: ANNOUNCEMENT_NOTIFICATION_TYPE,
      eventKey,
      copy: {
        en: { title: row.titleEn, body: row.bodyEn },
        de: { title: row.titleDe, body: row.bodyDe },
      },
      // The deep-link routes off announcementId so the bell click surfaces the
      // banner-linked content (`NotificationBell.notificationLink` maps
      // `account.notice` to /settings/notifications by default; a payload with
      // `announcementId` lets a future landing surface deep-link precisely).
      payload: { notice: 'announcement', announcementId: row.id },
      ...(deps.fanOutPageSize !== undefined ? { pageSize: deps.fanOutPageSize } : {}),
      logger,
    });

    // A pass over a row that was ALREADY stamped is the bounded retry: there is
    // nothing left to claim, so it merges its yield into the counts instead.
    if (row.publishedAt !== null) {
      await repo.recordDeliveryOutcome(row.id, {
        delivered: result.users - result.failed,
        failed: result.failed,
      });
      await auditPublication(row.id, attempt, result);
      logger?.info(
        {
          announcementId: row.id,
          attempt,
          users: result.users,
          inserted: result.inserted,
          failed: result.failed,
        },
        'announcement publish retry complete',
      );
      return { status: 'retried', ...result, retryScheduled: false };
    }

    const won = await repo.claimPublication(row.id, now(), {
      delivered: result.users - result.failed,
      failed: result.failed,
    });
    if (!won) {
      // Another worker walked the same row concurrently and stamped it first.
      // The eventKey index means this pass inserted nothing it should not have;
      // it records nothing so the counts and the audit stay single.
      logger?.info(
        { announcementId: row.id, inserted: result.inserted },
        'announcement publication already claimed by another run — recording nothing',
      );
      return { status: 'lost-claim', ...result, retryScheduled: false };
    }

    await auditPublication(row.id, attempt, result);

    let retryScheduled = false;
    if (result.failed > 0 && attempt < ANNOUNCEMENT_PUBLISH_MAX_ATTEMPT) {
      retryScheduled = await requestPublish({
        announcementId: row.id,
        attempt: attempt + 1,
        delayMs: ANNOUNCEMENT_PUBLISH_RETRY_DELAY_MS,
      });
      logger?.warn(
        {
          announcementId: row.id,
          users: result.users,
          inserted: result.inserted,
          failed: result.failed,
          retryScheduled,
        },
        'announcement publish incomplete — recorded, with one bounded retry',
      );
    } else {
      logger?.info(
        { announcementId: row.id, users: result.users, inserted: result.inserted },
        'announcement published',
      );
    }
    return { status: 'published', ...result, retryScheduled };
  }

  /**
   * The publication audit row (#1406 W6 builds the reader). `actorId` is null
   * because the actor is the job, not an operator — the admin's own
   * `announcement.create` / `announcement.update` row already names who composed
   * it, and attributing an automatic delivery to the last person who touched the
   * form would put words in their mouth.
   */
  async function auditPublication(
    announcementId: string,
    attempt: number,
    result: { users: number; inserted: number; failed: number },
  ): Promise<void> {
    await audit.record({
      actorId: null,
      action: AUDIT.publish,
      targetType: 'announcement',
      targetId: announcementId,
      ip: null,
      meta: {
        users: result.users,
        inserted: result.inserted,
        failed: result.failed,
        attempt,
      },
    });
  }

  /**
   * Is this row due for its first publication at `at`? The exact predicate the
   * repository's due query uses, applied to a single row so a targeted job can
   * re-check a row that may have changed between enqueue and run.
   *
   * The clause order differs from {@link deriveAnnouncementDeliveryState} on
   * purpose, because the two answer different questions. This one answers "why
   * can this not go out?", where "the operator switched it off" is the more
   * actionable reason to report than "its window had also closed"; the state
   * derivation answers "what do users experience?", where a closed window is
   * terminal and outranks everything else.
   */
  function dueness(
    row: AnnouncementRow,
    at: Date,
  ): 'due' | 'inactive' | 'scheduled' | 'expired' | 'already-published' {
    if (!row.active) return 'inactive';
    if (row.endsAt && row.endsAt.getTime() <= at.getTime()) return 'expired';
    if (row.publishedAt !== null) return 'already-published';
    if (row.startsAt && row.startsAt.getTime() > at.getTime()) return 'scheduled';
    return 'due';
  }

  /**
   * After a write: if the row's window is ALREADY open, ask for an immediate
   * pass so "publish now" does not wait up to a cron interval. A future
   * `startsAt` is deliberately NOT enqueued — deferring it is the entire point
   * of the issue, and the sweep will take it the minute the window opens.
   */
  async function enqueueIfDueNow(row: AnnouncementRow): Promise<void> {
    if (dueness(row, now()) !== 'due') return;
    await requestPublish({ announcementId: row.id, attempt: 0 });
  }

  return {
    async list(): Promise<Announcement[]> {
      const rows = await repo.listAll();
      const at = now();
      return rows.map((row) => toAnnouncement(row, at));
    },

    async create(input, actor): Promise<Announcement> {
      const startsAt =
        input.startsAt === undefined ? null : input.startsAt ? new Date(input.startsAt) : null;
      const endsAt =
        input.endsAt === undefined ? null : input.endsAt ? new Date(input.endsAt) : null;
      const active = input.active ?? false;
      const row = await repo.create({
        severity: input.severity,
        titleEn: input.titleEn,
        bodyEn: input.bodyEn,
        titleDe: input.titleDe,
        bodyDe: input.bodyDe,
        startsAt,
        endsAt,
        active,
        createdBy: actor.id,
      });
      await audit.record({
        actorId: actor.id,
        action: AUDIT.create,
        targetType: 'announcement',
        targetId: row.id,
        ip: actor.ip ?? null,
        meta: { severity: row.severity, active: row.active },
      });
      // Creating in the active state is a request to publish, NOT a
      // publication (#1909): the write returns as soon as the row is durable,
      // and `announcements.publishDue` does the walk. A window that has already
      // opened gets a one-shot job so it still feels immediate.
      await enqueueIfDueNow(row);
      const refreshed = (await repo.findById(row.id)) ?? row;
      return toAnnouncement(refreshed, now());
    },

    async update(id, input, actor): Promise<Announcement> {
      const before = await repo.findById(id);
      if (!before) throw announcementNotFound();

      // Reject a window that would flip start > end (repo has a CHECK too;
      // this gives a clean 400 instead of a raw db error).
      const nextStart =
        input.startsAt === undefined
          ? before.startsAt
          : input.startsAt
            ? new Date(input.startsAt)
            : null;
      const nextEnd =
        input.endsAt === undefined ? before.endsAt : input.endsAt ? new Date(input.endsAt) : null;
      if (nextStart && nextEnd && nextStart.getTime() > nextEnd.getTime()) {
        throw badRequest('endsAt must be at or after startsAt.', 'INVALID_ANNOUNCEMENT_WINDOW');
      }

      const patch: UpdateAnnouncementInput = {};
      if (input.severity !== undefined) patch.severity = input.severity;
      if (input.titleEn !== undefined) patch.titleEn = input.titleEn;
      if (input.bodyEn !== undefined) patch.bodyEn = input.bodyEn;
      if (input.titleDe !== undefined) patch.titleDe = input.titleDe;
      if (input.bodyDe !== undefined) patch.bodyDe = input.bodyDe;
      if (input.startsAt !== undefined) patch.startsAt = nextStart;
      if (input.endsAt !== undefined) patch.endsAt = nextEnd;
      if (input.active !== undefined) patch.active = input.active;

      const updated = await repo.update(id, patch);
      if (!updated) throw announcementNotFound();

      // #1723's resumability edge is gone with the request-path publish it
      // guarded: a publication that stopped midway is now re-driven by the
      // sweep (`published_at IS NULL` is part of the due predicate), so no
      // operator has to re-send a PATCH to unstick it, and no edit can trigger
      // a re-walk of the user table as a side effect.
      const unpublishing = input.active === false && before.active === true;

      await audit.record({
        actorId: actor.id,
        action: AUDIT.update,
        targetType: 'announcement',
        targetId: id,
        ip: actor.ip ?? null,
        meta: {
          severity: updated.severity,
          active: updated.active,
        },
      });

      if (unpublishing) {
        await audit.record({
          actorId: actor.id,
          action: AUDIT.unpublish,
          targetType: 'announcement',
          targetId: id,
          ip: actor.ip ?? null,
        });
      }

      await enqueueIfDueNow(updated);
      const refreshed = (await repo.findById(id)) ?? updated;
      return toAnnouncement(refreshed, now());
    },

    async remove(id, actor): Promise<void> {
      const before = await repo.findById(id);
      if (!before) throw announcementNotFound();
      const ok = await repo.remove(id);
      if (!ok) throw announcementNotFound();
      await audit.record({
        actorId: actor.id,
        action: AUDIT.delete,
        targetType: 'announcement',
        targetId: id,
        ip: actor.ip ?? null,
      });
    },

    async publishDue(): Promise<AnnouncementSweepResult> {
      const at = now();
      const due = await repo.listDuePublications(at, ANNOUNCEMENT_PUBLISH_BATCH);
      const summary: AnnouncementSweepResult = {
        due: due.length,
        published: 0,
        inserted: 0,
        failed: 0,
        retriesScheduled: 0,
      };
      for (const row of due) {
        const outcome = await runPublication(row, 0);
        if (outcome.status === 'skipped') continue;
        summary.inserted += outcome.inserted;
        summary.failed += outcome.failed;
        if (outcome.status === 'published') summary.published += 1;
        if (outcome.retryScheduled) summary.retriesScheduled += 1;
      }
      return summary;
    },

    async publishAnnouncement(id, attempt = 0): Promise<AnnouncementPublishOutcome> {
      const row = await repo.findById(id);
      if (!row) return { status: 'skipped', reason: 'not-found' };
      const state = dueness(row, now());
      // The bounded retry runs over a row that is already stamped — that is
      // exactly what it is for — so `already-published` is only a stop for a
      // first pass. Everything else (deactivated, rescheduled or expired between
      // enqueue and run) stops both.
      if (state === 'already-published' && attempt === 0) {
        return { status: 'skipped', reason: 'already-published' };
      }
      if (state !== 'due' && state !== 'already-published') {
        return { status: 'skipped', reason: state };
      }
      return runPublication(row, attempt);
    },

    async listActiveForUser(userId, userLocale): Promise<ActiveAnnouncement[]> {
      const rows = await repo.listActiveForUser(userId, now());
      const locale = resolveEmailLocale(userLocale);
      return rows.map((row) => {
        const rendered = renderForLocale(row, locale);
        return {
          id: row.id,
          severity: row.severity as AnnouncementSeverity,
          title: rendered.title,
          body: rendered.body,
          publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
        };
      });
    },

    async dismiss(userId, announcementId): Promise<void> {
      const row = await repo.findById(announcementId);
      if (!row) throw announcementNotFound();
      await repo.dismissForUser(userId, announcementId);
    },
  };
}
