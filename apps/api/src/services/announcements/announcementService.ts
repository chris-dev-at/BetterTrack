import type {
  Announcement,
  AnnouncementBearerAckGate,
  AnnouncementDeliveryState,
  AnnouncementReceiptFilter,
  AnnouncementReceiptRow,
  AnnouncementReceiptState,
  AnnouncementReceiptsResponse,
  AnnouncementSeverity,
  AnnouncementStatsResponse,
  CreateAnnouncementRequest,
  UpdateAnnouncementRequest,
} from '@bettertrack/contracts';
import {
  ANNOUNCEMENT_ERROR_CODES,
  ANNOUNCEMENT_NOTIFICATION_TYPE,
  ANNOUNCEMENT_RECEIPTS_CSV_COLUMNS,
  ANNOUNCEMENT_RECEIPTS_PAGE_MAX,
  ANNOUNCEMENT_NOTIFY_EMAIL_AFTER_DAYS_DEFAULT,
} from '@bettertrack/contracts';

import type {
  AnnouncementRepository,
  UpdateAnnouncementInput,
} from '../../data/repositories/announcementRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type {
  AnnouncementReceiptRepository,
  ReceiptCursor,
  ReceiptLogRow,
} from '../../data/repositories/announcementReceiptRepository';
import type { AnnouncementRow } from '../../data/schema';
import { ApiError, badRequest, conflict, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { AuditService } from '../audit/auditService';
import { fanOutAnnouncement } from '../notifications/announcementFanOut';
import { announcementContentSha256, inboxCopy } from './announcementContent';
import {
  assertAnnouncementComplete,
  assertAnnouncementContent,
  assertEditable,
  assertNoLockedChange,
  assertWindow,
  type PatchableField,
} from './announcementValidation';

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
  /**
   * An operator asked for the recipients a publication missed to be delivered
   * again (#1943). Unlike {@link AUDIT.publish} this is NOT the job speaking:
   * it names the admin who clicked, their IP, and the counts they acted on.
   */
  redeliver: 'announcement.redeliver',
  /**
   * The operator's Publish (draft → published), §6.19.11. Named apart from
   * {@link AUDIT.publish}, which has meant one delivery pass since #1909.
   */
  release: 'announcement.release',
  archive: 'announcement.archive',
  receiptsExport: 'announcement.receipts_export',
} as const;

/** The announcement audit vocabulary, exported for the audit console's filters. */
export const ANNOUNCEMENT_AUDIT_ACTIONS = AUDIT;

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

/**
 * The attempt number a MANUAL redelivery carries (#1943) — deliberately one
 * above the automatic ladder's last rung.
 *
 * Two properties follow from that single fact, and both are load-bearing:
 *  • it is `> ANNOUNCEMENT_PUBLISH_MAX_ATTEMPT`, so a manual pass can never
 *    schedule a retry of ITS own — one re-run per click, never a loop;
 *  • it is a distinct segment in the queue's dedupe job id, so a manual pass is
 *    never collapsed into the automatic first publication or its retry.
 */
export const ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT = ANNOUNCEMENT_PUBLISH_MAX_ATTEMPT + 1;

/**
 * How tightly two manual redeliveries of the same announcement coalesce.
 *
 * The automatic window is the cron interval (five minutes), which is right for
 * a burst of saves: anything it swallows the sweep picks up anyway. A manual
 * click has no such backstop — nothing re-runs it — so swallowing the operator's
 * SECOND click for five minutes would reproduce the very "button does nothing"
 * this issue exists to remove. Thirty seconds is the honest middle: an
 * impatient double-click collapses into one walk, a deliberate retry a minute
 * later is its own pass.
 */
export const ANNOUNCEMENT_REDELIVER_DEDUPE_WINDOW_MS = 30_000;

/** Ask the worker to publish one announcement out of band. */
export interface AnnouncementPublishRequest {
  announcementId: string;
  /**
   * 0 = first publication, 1 = the single bounded retry,
   * {@link ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT} = an operator-initiated
   * redelivery.
   */
  attempt: number;
  /** Delay before the job is eligible to run (the retry's backoff). */
  delayMs?: number;
  /**
   * Who asked, when a human did (#1943). `undefined` on the automatic passes:
   * the actor there is the job, and attributing an automatic delivery to the
   * last person who touched the form would put words in their mouth. Set, it is
   * carried into the pass's own `announcement.publish` audit row, so the
   * outcome of an operator's click is attributable to that operator.
   */
  actorId?: string;
  /**
   * Override the job-id dedupe window for this request (#1943). Defaults to the
   * queue's own window; a manual redelivery narrows it — see
   * {@link ANNOUNCEMENT_REDELIVER_DEDUPE_WINDOW_MS}.
   */
  dedupeWindowMs?: number;
}

/**
 * What a successful enqueue reports back: the identity BullMQ will key the pass
 * on. The route hands it to the operator so two clicks that were deliberately
 * collapsed are visibly the same job rather than a silent no-op.
 */
export interface AnnouncementPublishEnqueued {
  jobId: string;
}

/** What `redeliver()` accepted — a queued pass, never a completed delivery. */
export interface AnnouncementRedeliverResult {
  announcementId: string;
  jobId: string;
  attempt: number;
  /** The counts the operator acted on, not the outcome (which is the job's). */
  failedCount: number;
  deliveredCount: number | null;
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
       * The conditional claim did not match: another worker stamped the
       * publication while this one was walking, or the announcement was
       * switched off mid-walk. The per-recipient key means nothing was
       * delivered twice, and this pass records nothing at all.
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
  /**
   * The audience walk (§6.19.8): user-kind accounts in the announcement's
   * audience only, keyset-paged. Admins never get a row.
   */
  users: Pick<UserRepository, 'listAnnouncementAudienceAfter'>;
  notifications: Pick<NotificationRepository, 'insert'>;
  /** Stats and the acknowledgement log (§6.19.9). */
  receipts?: Pick<AnnouncementReceiptRepository, 'stats' | 'listReceiptLog'>;
  /**
   * Where `BT_ANNOUNCEMENT_ACK_GATE_BEARER` is read at request time (Chief
   * ruling 2026-10-30: never writable through the API). Defaults to
   * `process.env`.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Admin audit trail; every mutation lands one row. */
  audit: AuditService;
  /**
   * Hand one announcement to the `announcements.publishDue` queue. Three
   * callers: a save whose window is already open (so "publish now" does not
   * wait up to a cron interval), the single bounded retry after a partial
   * delivery, and an operator's manual redelivery (#1943).
   *
   * Optional because `config.isTest` builds the context with `queues === null`
   * (BullMQ cannot drive ioredis-mock). Absent, nothing is enqueued and the
   * sweep is the only path — which is also what makes the "a save never fans
   * out" assertions in the service tests mean what they say. The manual
   * redelivery is the one caller that REFUSES to pretend in that case: it has
   * no sweep behind it, so it answers 503 rather than an accepted-looking 202.
   */
  enqueuePublish?: (request: AnnouncementPublishRequest) => Promise<AnnouncementPublishEnqueued>;
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
  // ── Admin CRUD (§13.4 V4-P5b; lifecycle §6.19.4) ──────────────────────────
  list(): Promise<Announcement[]>;
  /** The bearer acknowledgement gate's deployment state, read now. */
  bearerAckGate(): AnnouncementBearerAckGate;
  create(input: CreateAnnouncementRequest, actor: AnnouncementServiceActor): Promise<Announcement>;
  update(
    id: string,
    input: UpdateAnnouncementRequest,
    actor: AnnouncementServiceActor,
  ): Promise<Announcement>;
  remove(id: string, actor: AnnouncementServiceActor): Promise<void>;
  publish(id: string, actor: AnnouncementServiceActor): Promise<Announcement>;
  unpublish(id: string, actor: AnnouncementServiceActor): Promise<Announcement>;
  archive(id: string, actor: AnnouncementServiceActor): Promise<Announcement>;
  stats(id: string): Promise<AnnouncementStatsResponse>;
  receipts(
    id: string,
    query: { state: AnnouncementReceiptFilter; cursor?: string; limit: number },
  ): Promise<AnnouncementReceiptsResponse>;
  receiptsCsv(
    id: string,
    state: AnnouncementReceiptFilter,
    actor: AnnouncementServiceActor,
  ): Promise<{ filename: string; csv: string }>;
  /**
   * Operator-initiated re-run of ONE announcement's fan-out (#1943), for a
   * published row still carrying failed recipients. Queues a targeted pass and
   * returns its identity; it never walks the user table on the request path.
   */
  redeliver(id: string, actor: AnnouncementServiceActor): Promise<AnnouncementRedeliverResult>;
  // ── Publication (driven by `announcements.publishDue`, #1909) ─────────────
  /** Publish every announcement whose window has opened and which is unstamped. */
  publishDue(): Promise<AnnouncementSweepResult>;
  /** Publish exactly one announcement, re-checking its window first. */
  publishAnnouncement(
    id: string,
    attempt?: number,
    actorId?: string,
  ): Promise<AnnouncementPublishOutcome>;
}

/**
 * The server's single reading of "where is this announcement in its lifecycle".
 *
 * Derived here and nowhere else (#1909): the browser renders the answer, it does
 * not compute it, so two consoles on two machines with two clock skews cannot
 * disagree with each other or with the job.
 *
 * Precedence, and the reason for each step:
 *  1. **archived** — withdrawn by an operator (§6.19.4); terminal.
 *  2. **expired** — the window closed. Terminal for delivery: the due
 *     predicate refuses it and users stop seeing it (for ack_required this is
 *     the lapse).
 *  3. **draft** — nothing shown, nothing delivered.
 *  4. **published** — the fan-out completed and the stamp is on the row.
 *  5. **scheduled** — published, but the window has not opened: the banner
 *     AND the inbox both wait.
 *  6. **publishing** — published, due, unstamped. The job owns it.
 */
export function deriveAnnouncementDeliveryState(
  row: Pick<AnnouncementRow, 'lifecycle' | 'startsAt' | 'endsAt' | 'publishedAt'>,
  at: Date,
): AnnouncementDeliveryState {
  const now = at.getTime();
  if (row.lifecycle === 'archived') return 'archived';
  if (row.endsAt && row.endsAt.getTime() <= now) return 'expired';
  if (row.lifecycle === 'draft') return 'draft';
  if (row.publishedAt) return 'published';
  if (row.startsAt && row.startsAt.getTime() > now) return 'scheduled';
  return 'publishing';
}

const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toAnnouncement(row: AnnouncementRow, at: Date): Announcement {
  return {
    id: row.id,
    severity: row.severity as AnnouncementSeverity,
    titleEn: row.titleEn,
    bodyEn: row.bodyEn,
    titleDe: row.titleDe,
    bodyDe: row.bodyDe,
    startsAt: isoOrNull(row.startsAt),
    endsAt: isoOrNull(row.endsAt),
    active: row.lifecycle === 'published',
    publishedAt: isoOrNull(row.publishedAt),
    deliveryState: deriveAnnouncementDeliveryState(row, at),
    deliveredCount: row.deliveredCount,
    failedCount: row.failedCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    kind: row.kind,
    audience: row.audience,
    lifecycle: row.lifecycle,
    bodyFormat: row.bodyFormat,
    releasedAt: isoOrNull(row.releasedAt),
    audienceCutoffAt: isoOrNull(row.audienceCutoffAt),
    archivedAt: isoOrNull(row.archivedAt),
    lapseRecordedAt: isoOrNull(row.lapseRecordedAt),
    notifyByEmail: row.notifyByEmail,
    notifyByEmailAfterDays: row.notifyByEmailAfterDays,
    emailPassRecordedAt: isoOrNull(row.emailPassRecordedAt),
  };
}

/** One state per log row (contract §7.4): the obligation for ack_required, the visit otherwise. */
function receiptState(kind: AnnouncementRow['kind'], r: ReceiptLogRow): AnnouncementReceiptState {
  if (r.accountStatus === 'deleted' || r.acknowledgedAt) return 'acknowledged';
  if (kind === 'ack_required') return r.lapsedAt ? 'lapsed' : 'pending';
  if (r.dismissedAt) return 'dismissed';
  return r.seenAt ? 'seen' : 'unseen';
}

function toReceiptRow(kind: AnnouncementRow['kind'], r: ReceiptLogRow): AnnouncementReceiptRow {
  return {
    userId: r.userId,
    subjectToken: r.subjectToken,
    username: r.username,
    accountCreatedAt: isoOrNull(r.accountCreatedAt),
    accountStatus: r.accountStatus,
    state: receiptState(kind, r),
    seenAt: isoOrNull(r.seenAt),
    dismissedAt: isoOrNull(r.dismissedAt),
    acknowledgedAt: isoOrNull(r.acknowledgedAt),
    acknowledgedVia: r.acknowledgedVia,
    acknowledgedLocale: r.acknowledgedLocale as 'en' | 'de' | null,
    contentSha256: r.acknowledgedContentSha256,
    lapsedAt: isoOrNull(r.lapsedAt),
    lapseReason: r.lapseReason,
  };
}

function encodeCursor(cursor: ReceiptCursor): string {
  return Buffer.from(JSON.stringify([cursor.segment === 'live' ? 'l' : 'd', cursor.after])).toString(
    'base64url',
  );
}

function decodeCursor(raw: string | undefined): ReceiptCursor | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string') {
      if (parsed[0] === 'l') return { segment: 'live', after: parsed[1] };
      if (parsed[0] === 'd') return { segment: 'deleted', after: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw badRequest('The receipts cursor is not valid.', 'VALIDATION_ERROR');
}

/** One CSV cell: quoted when needed, and never a spreadsheet formula. */
function csvCell(value: string | null): string {
  if (value === null) return '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
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
  async function requestPublish(
    request: AnnouncementPublishRequest,
  ): Promise<AnnouncementPublishEnqueued | null> {
    if (!deps.enqueuePublish) return null;
    try {
      return await deps.enqueuePublish(request);
    } catch (err) {
      logger?.warn(
        { err, announcementId: request.announcementId, attempt: request.attempt },
        'announcement publish enqueue failed — the scheduled sweep still owns it',
      );
      return null;
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
    actorId?: string,
  ): Promise<AnnouncementPublishOutcome> {
    const eventKey = announcementEventKey(row.id);
    // The walk covers the announcement's AUDIENCE only (§6.19.8): user-kind
    // accounts, and for `existing_at_publish` those created strictly before
    // the frozen cutoff. The audience is immutable once published, so every
    // pass of one announcement walks the same set.
    const audience = { kind: row.audience, cutoffAt: row.audienceCutoffAt };
    const result = await fanOutAnnouncement({
      users: {
        listRecipientsAfter: (afterId, limit) =>
          users.listAnnouncementAudienceAfter(afterId, limit, audience),
      },
      notifications,
      type: ANNOUNCEMENT_NOTIFICATION_TYPE,
      eventKey,
      // The plain-text projection (contract §6): the whole body for `notice`,
      // an excerpt for `once` / `ack_required` (read in full through the
      // per-id route). Never markup.
      copy: { en: inboxCopy(row, 'en'), de: inboxCopy(row, 'de') },
      // The deep-link routes off announcementId so the bell click surfaces the
      // banner-linked content (`NotificationBell.notificationLink` maps
      // `account.notice` to /settings/notifications by default; a payload with
      // `announcementId` lets a future landing surface deep-link precisely).
      payload: { notice: 'announcement', announcementId: row.id, announcementKind: row.kind },
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
      await auditPublication(row.id, attempt, result, actorId);
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
      // The conditional claim did not match. Two ways that happens, and the
      // re-read says which so the log is actionable: another worker walked the
      // same row concurrently and stamped it first, or an operator switched the
      // announcement off DURING this walk. Either way this pass records
      // nothing — the eventKey index means it inserted nothing it should not
      // have, and leaving `published_at` NULL keeps a cancelled announcement
      // re-publishable if the operator changes their mind.
      const after = await repo.findById(row.id);
      logger?.info(
        {
          announcementId: row.id,
          inserted: result.inserted,
          reason: !after ? 'deleted' : after.publishedAt ? 'claimed-by-another-run' : 'deactivated',
        },
        'announcement publication not claimed — recording nothing',
      );
      return { status: 'lost-claim', ...result, retryScheduled: false };
    }

    await auditPublication(row.id, attempt, result, actorId);

    let retryScheduled = false;
    if (result.failed > 0 && attempt < ANNOUNCEMENT_PUBLISH_MAX_ATTEMPT) {
      retryScheduled =
        (await requestPublish({
          announcementId: row.id,
          attempt: attempt + 1,
          delayMs: ANNOUNCEMENT_PUBLISH_RETRY_DELAY_MS,
        })) !== null;
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
   * for the automatic passes because the actor is the job, not an operator —
   * the admin's own `announcement.create` / `announcement.update` row already
   * names who composed it, and attributing an automatic delivery to the last
   * person who touched the form would put words in their mouth.
   *
   * A pass an operator ASKED for is the exception (#1943): the click is carried
   * in the job payload and lands here, so the outcome of a manual redelivery —
   * its recipients, its inserts, its remaining failures — is attributable to
   * the person who ordered it rather than reading as one more automatic sweep.
   */
  async function auditPublication(
    announcementId: string,
    attempt: number,
    result: { users: number; inserted: number; failed: number },
    actorId?: string,
  ): Promise<void> {
    await audit.record({
      actorId: actorId ?? null,
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
    if (row.lifecycle !== 'published') return 'inactive';
    if (row.endsAt && row.endsAt.getTime() <= at.getTime()) return 'expired';
    if (row.publishedAt !== null) return 'already-published';
    if (row.startsAt && row.startsAt.getTime() > at.getTime()) return 'scheduled';
    return 'due';
  }

  /**
   * Publish exactly one announcement, RE-READING it first.
   *
   * The fresh read is the point (#1941 review): the sweep's batch is a snapshot
   * taken before the first walk, and a targeted job's payload was written
   * before it was ever picked up. In both cases an operator can have switched
   * the announcement off, moved its window, or had another worker publish it in
   * between — and a fan-out is 100 % of the user base, so acting on a stale row
   * is not a small mistake. One extra indexed SELECT per due announcement (the
   * batch is 20, the sweep runs every five minutes) buys that.
   */
  async function publishOne(
    id: string,
    attempt: number,
    actorId?: string,
  ): Promise<AnnouncementPublishOutcome> {
    const row = await repo.findById(id);
    if (!row) return { status: 'skipped', reason: 'not-found' };
    const state = dueness(row, now());
    // The bounded retry and the manual redelivery both run over a row that is
    // already stamped — that is exactly what they are for — so
    // `already-published` is only a stop for a first pass. Everything else
    // (deactivated, rescheduled or expired between enqueue and run) stops all
    // three.
    if (state === 'already-published' && attempt === 0) {
      return { status: 'skipped', reason: 'already-published' };
    }
    if (state !== 'due' && state !== 'already-published') {
      return { status: 'skipped', reason: state };
    }
    return runPublication(row, attempt, actorId);
  }

  /**
   * Can this row's failed recipients be re-delivered right now (#1943), and if
   * not, WHY not — in the operator's terms rather than the job's?
   *
   * The checks mirror what the queued pass would do when it re-reads the row
   * ({@link dueness} + the already-published branch of {@link runPublication}).
   * They are applied here as well, at the request, so the console refuses
   * plainly instead of returning an accepted-looking 202 for a pass the worker
   * would silently skip a second later.
   */
  function redeliverability(
    row: AnnouncementRow,
    at: Date,
  ): 'ready' | 'nothing-failed' | 'not-published' | 'inactive' | 'expired' {
    if (row.lifecycle !== 'published') return 'inactive';
    if (row.endsAt && row.endsAt.getTime() <= at.getTime()) return 'expired';
    if (row.publishedAt === null) return 'not-published';
    if (!row.failedCount) return 'nothing-failed';
    return 'ready';
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

    bearerAckGate(): AnnouncementBearerAckGate {
      const env = deps.env ?? process.env;
      return env.BT_ANNOUNCEMENT_ACK_GATE_BEARER?.trim() === 'first_party' ? 'first_party' : 'off';
    },

    /** Always a draft; nothing is delivered or shown until publish (§6.19.4). */
    async create(input, actor): Promise<Announcement> {
      const kind = input.kind ?? 'notice';
      const notifyByEmail = input.notifyByEmail ?? false;
      const notifyByEmailAfterDays =
        input.notifyByEmailAfterDays ?? ANNOUNCEMENT_NOTIFY_EMAIL_AFTER_DAYS_DEFAULT;
      if (
        kind !== 'ack_required' &&
        (notifyByEmail || notifyByEmailAfterDays !== ANNOUNCEMENT_NOTIFY_EMAIL_AFTER_DAYS_DEFAULT)
      ) {
        // The route's schema refuses this first; the service holds the line
        // for any other caller (the DB CHECK is the last one).
        throw badRequest('The e-mail fields are available for ack_required only.', 'VALIDATION_ERROR', {
          fieldErrors: notifyByEmail
            ? { notifyByEmail: ['ack_required only'] }
            : { notifyByEmailAfterDays: ['ack_required only'] },
        });
      }
      const startsAt = input.startsAt ? new Date(input.startsAt) : null;
      const endsAt = input.endsAt ? new Date(input.endsAt) : null;
      assertWindow(startsAt, endsAt, now(), false);
      const content = {
        kind,
        format: 'markdown' as const,
        titleEn: input.titleEn,
        bodyEn: input.bodyEn,
        titleDe: input.titleDe ?? null,
        bodyDe: input.bodyDe ?? null,
      };
      assertAnnouncementContent(content);
      const row = await repo.create({
        kind,
        audience: input.audience ?? 'everyone',
        severity: input.severity,
        titleEn: content.titleEn,
        bodyEn: content.bodyEn,
        titleDe: content.titleDe,
        bodyDe: content.bodyDe,
        startsAt,
        endsAt,
        notifyByEmail,
        notifyByEmailAfterDays,
        createdBy: actor.id,
      });
      await audit.record({
        actorId: actor.id,
        action: AUDIT.create,
        targetType: 'announcement',
        targetId: row.id,
        ip: actor.ip ?? null,
        meta: {
          kind: row.kind,
          audience: row.audience,
          severity: row.severity,
          notifyByEmail: row.notifyByEmail,
        },
      });
      return toAnnouncement(row, now());
    },

    /**
     * Contract §7.3. A draft takes any change. After publishing: `kind`,
     * `audience`, `startsAt` and the e-mail fields are locked; notice/once
     * take content and `endsAt`; ack_required only `endsAt` (its text is
     * immutable, so the log always names what was acknowledged). An ended or
     * archived announcement takes nothing. A field sent with its current
     * value is not a change.
     */
    async update(id, input, actor): Promise<Announcement> {
      const before = await repo.findById(id);
      if (!before) throw announcementNotFound();
      const at = now();
      assertEditable(before, at);

      const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);
      const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
      const changed: PatchableField[] = [];
      const patch: UpdateAnnouncementInput = {};
      const scalar = [
        'kind',
        'audience',
        'severity',
        'titleEn',
        'bodyEn',
        'titleDe',
        'bodyDe',
        'notifyByEmail',
        'notifyByEmailAfterDays',
      ] as const;
      for (const key of scalar) {
        const value = input[key];
        if (value === undefined || value === before[key]) continue;
        changed.push(key);
        (patch as Record<string, unknown>)[key] = value;
      }
      for (const key of ['startsAt', 'endsAt'] as const) {
        if (input[key] === undefined) continue;
        const value = toDate(input[key]);
        if (same(value, before[key])) continue;
        changed.push(key);
        patch[key] = value;
      }
      assertNoLockedChange(before, changed);
      if (changed.length === 0) return toAnnouncement(before, at);

      const kind = patch.kind ?? before.kind;
      if (kind !== 'ack_required') {
        // The e-mail fields belong to ack_required alone. A kind change away
        // from it clears them unless the request set them (which the
        // contract's schema already refuses with 400 VALIDATION_ERROR).
        if ((patch.notifyByEmail ?? before.notifyByEmail) === true) {
          if (input.notifyByEmail === true) {
            throw badRequest('notifyByEmail is available for ack_required announcements only.', 'VALIDATION_ERROR', {
              fieldErrors: { notifyByEmail: ['ack_required only'] },
            });
          }
          patch.notifyByEmail = false;
        }
        const days = patch.notifyByEmailAfterDays ?? before.notifyByEmailAfterDays;
        if (days !== ANNOUNCEMENT_NOTIFY_EMAIL_AFTER_DAYS_DEFAULT) {
          if (input.notifyByEmailAfterDays !== undefined) {
            throw badRequest(
              'notifyByEmailAfterDays is available for ack_required announcements only.',
              'VALIDATION_ERROR',
              { fieldErrors: { notifyByEmailAfterDays: ['ack_required only'] } },
            );
          }
          patch.notifyByEmailAfterDays = ANNOUNCEMENT_NOTIFY_EMAIL_AFTER_DAYS_DEFAULT;
        }
      }
      const startsAt = patch.startsAt !== undefined ? patch.startsAt : before.startsAt;
      const endsAt = patch.endsAt !== undefined ? patch.endsAt : before.endsAt;
      // After publish a new end must lie in the future (or be null).
      assertWindow(startsAt, endsAt, at, before.lifecycle !== 'draft' && changed.includes('endsAt'));
      const contentChanged = changed.some((f) =>
        ['kind', 'titleEn', 'bodyEn', 'titleDe', 'bodyDe'].includes(f),
      );
      if (contentChanged) {
        assertAnnouncementContent({
          kind,
          format: before.bodyFormat,
          titleEn: patch.titleEn ?? before.titleEn,
          bodyEn: patch.bodyEn ?? before.bodyEn,
          titleDe: patch.titleDe !== undefined ? patch.titleDe : before.titleDe,
          bodyDe: patch.bodyDe !== undefined ? patch.bodyDe : before.bodyDe,
        });
      }

      const updated = await repo.update(id, patch);
      if (!updated) throw announcementNotFound();
      const meta: Record<string, unknown> = { fields: changed };
      if (contentChanged && before.lifecycle !== 'draft') {
        // §6.19.11: content edits after publish carry the hashes before/after.
        meta.contentSha256Before = {
          en: announcementContentSha256(before, 'en'),
          ...(before.titleDe !== null && before.bodyDe !== null
            ? { de: announcementContentSha256(before, 'de') }
            : {}),
        };
        meta.contentSha256After = {
          en: announcementContentSha256(updated, 'en'),
          ...(updated.titleDe !== null && updated.bodyDe !== null
            ? { de: announcementContentSha256(updated, 'de') }
            : {}),
        };
      }
      await audit.record({
        actorId: actor.id,
        action: AUDIT.update,
        targetType: 'announcement',
        targetId: id,
        ip: actor.ip ?? null,
        meta,
      });
      if (updated.lifecycle === 'published') await enqueueIfDueNow(updated);
      return toAnnouncement(updated, now());
    },

    /** Contract §7.2: draft → published, freezing the audience cutoff. */
    async publish(id, actor): Promise<Announcement> {
      const before = await repo.findById(id);
      if (!before) throw announcementNotFound();
      if (before.lifecycle !== 'draft') {
        throw conflict('Only a draft can be published.', ANNOUNCEMENT_ERROR_CODES.notDraft);
      }
      const at = now();
      assertAnnouncementComplete(before);
      assertAnnouncementContent({
        kind: before.kind,
        format: before.bodyFormat,
        titleEn: before.titleEn,
        bodyEn: before.bodyEn,
        titleDe: before.titleDe,
        bodyDe: before.bodyDe,
      });
      assertWindow(before.startsAt, before.endsAt, at, true);
      const row = await repo.publish(id, actor.id, at);
      if (!row) {
        throw conflict('Only a draft can be published.', ANNOUNCEMENT_ERROR_CODES.notDraft);
      }
      const audienceSize = deps.receipts ? (await deps.receipts.stats(row, at)).audience : null;
      await audit.record({
        actorId: actor.id,
        action: AUDIT.release,
        targetType: 'announcement',
        targetId: id,
        ip: actor.ip ?? null,
        meta: {
          kind: row.kind,
          audience: row.audience,
          audienceCutoffAt: isoOrNull(row.audienceCutoffAt),
          startsAt: isoOrNull(row.startsAt),
          endsAt: isoOrNull(row.endsAt),
          audienceSize,
          notifyByEmail: row.notifyByEmail,
          notifyByEmailAfterDays: row.notifyByEmailAfterDays,
        },
      });
      await enqueueIfDueNow(row);
      return toAnnouncement(row, now());
    },

    /** Contract §7.2: published → draft, only before the window opens. */
    async unpublish(id, actor): Promise<Announcement> {
      const before = await repo.findById(id);
      if (!before) throw announcementNotFound();
      if (before.lifecycle !== 'published') {
        throw conflict('This announcement is not published.', ANNOUNCEMENT_ERROR_CODES.notPublished);
      }
      const at = now();
      const row = await repo.unpublish(id, at);
      if (!row) {
        throw conflict(
          'The window has opened; archive the announcement instead.',
          ANNOUNCEMENT_ERROR_CODES.alreadyLive,
        );
      }
      await audit.record({
        actorId: actor.id,
        action: AUDIT.unpublish,
        targetType: 'announcement',
        targetId: id,
        ip: actor.ip ?? null,
      });
      return toAnnouncement(row, now());
    },

    /** Contract §7.2: published → archived; idempotent on an archived one. */
    async archive(id, actor): Promise<Announcement> {
      const outcome = await repo.archive(id, actor.id, now());
      switch (outcome.status) {
        case 'not-found':
          throw announcementNotFound();
        case 'not-published':
          throw conflict(
            'A draft is deleted, not archived.',
            ANNOUNCEMENT_ERROR_CODES.notPublished,
          );
        case 'already-archived':
          return toAnnouncement(outcome.row, now());
        default:
          await audit.record({
            actorId: actor.id,
            action: AUDIT.archive,
            targetType: 'announcement',
            targetId: id,
            ip: actor.ip ?? null,
            meta: { kind: outcome.row.kind, pendingAtArchive: outcome.pendingAtArchive },
          });
          return toAnnouncement(outcome.row, now());
      }
    },

    async stats(id): Promise<AnnouncementStatsResponse> {
      const row = await repo.findById(id);
      if (!row || !deps.receipts) throw announcementNotFound();
      const at = now();
      const counts = await deps.receipts.stats(row, at);
      return {
        announcementId: row.id,
        kind: row.kind,
        audience: counts.audience,
        seen: counts.seen,
        dismissed: counts.dismissed,
        acknowledged: counts.acknowledged,
        acknowledgedByDeletedAccounts: counts.acknowledgedByDeletedAccounts,
        lapsed: counts.lapsed,
        pending:
          row.kind === 'ack_required'
            ? Math.max(0, counts.audience - counts.acknowledged - counts.lapsed)
            : null,
        lapseRecorded: row.lapseRecordedAt !== null,
        computedAt: at.toISOString(),
      };
    },

    async receipts(id, query): Promise<AnnouncementReceiptsResponse> {
      const row = await repo.findById(id);
      if (!row || !deps.receipts) throw announcementNotFound();
      const page = await deps.receipts.listReceiptLog(
        row,
        query.state,
        decodeCursor(query.cursor),
        query.limit,
        now(),
      );
      return {
        items: page.items.map((r) => toReceiptRow(row.kind, r)),
        nextCursor: page.next ? encodeCursor(page.next) : null,
      };
    },

    /** Every page of the log as CSV; each download is audited (§6.19.11). */
    async receiptsCsv(id, state, actor) {
      const row = await repo.findById(id);
      if (!row || !deps.receipts) throw announcementNotFound();
      const lines = [ANNOUNCEMENT_RECEIPTS_CSV_COLUMNS.join(',')];
      let cursor: ReceiptCursor | null = null;
      let rows = 0;
      const at = now();
      do {
        const page = await deps.receipts.listReceiptLog(
          row,
          state,
          cursor,
          ANNOUNCEMENT_RECEIPTS_PAGE_MAX,
          at,
        );
        for (const item of page.items) {
          const r = toReceiptRow(row.kind, item);
          lines.push(
            [
              r.userId,
              r.subjectToken,
              r.username,
              r.accountCreatedAt,
              r.accountStatus,
              r.state,
              r.seenAt,
              r.dismissedAt,
              r.acknowledgedAt,
              r.acknowledgedVia,
              r.acknowledgedLocale,
              r.contentSha256,
              r.lapsedAt,
              r.lapseReason,
            ]
              .map(csvCell)
              .join(','),
          );
          rows += 1;
        }
        cursor = page.next;
      } while (cursor !== null);
      await audit.record({
        actorId: actor.id,
        action: AUDIT.receiptsExport,
        targetType: 'announcement',
        targetId: id,
        ip: actor.ip ?? null,
        meta: { state, rows },
      });
      return { filename: `announcement-${id}-receipts.csv`, csv: `${lines.join('\r\n')}\r\n` };
    },

    /**
     * Re-run ONE announcement's fan-out for the recipients a publication missed
     * (#1943). Queues; never walks.
     *
     * Before this, a delivery that failed twice left the row stamped with
     * `failedCount > 0` and the console showed "N failed" with nothing attached
     * to it: the automatic ladder is deliberately bounded at one retry, so the
     * missing inbox rows were simply never written.
     *
     * **Why a job and not the request.** The fan-out is a keyset walk of the
     * entire user table. Running it inside the admin's HTTP request is the exact
     * defect #1909 removed, and no bounded targeted path exists — the service's
     * only fan-out primitive is that walk. So this hands ONE targeted pass to
     * the existing `announcements.publishDue` queue and answers 202 with the job
     * identity; the console polls the list for the result.
     *
     * **Why it cannot re-stamp or double count.** The queued pass re-reads the
     * row, finds `published_at` already set, and takes the retry branch: it
     * walks, then REPLACES the counts from its own outcome
     * (`users - failed` / `failed`) via `recordDeliveryOutcome`. `publishedAt`
     * is only ever written by the conditional claim, which that branch never
     * reaches. And each recipient's row is keyed by
     * {@link announcementEventKey}, so the re-walk inserts exactly the rows that
     * are missing and nobody is notified twice.
     *
     * The audit row is written AFTER the enqueue, carrying the job id: a row
     * claiming a redelivery that was never queued would be worse than none. If
     * the audit write itself fails the request 500s, but the trail is not lost —
     * the pass records its own `announcement.publish` row naming the same actor.
     */
    async redeliver(id, actor): Promise<AnnouncementRedeliverResult> {
      const row = await repo.findById(id);
      if (!row) throw announcementNotFound();

      switch (redeliverability(row, now())) {
        case 'nothing-failed':
          throw conflict(
            'This announcement has no failed deliveries to retry.',
            'ANNOUNCEMENT_NOTHING_TO_REDELIVER',
          );
        case 'not-published':
          throw conflict(
            'This announcement has not been published yet.',
            'ANNOUNCEMENT_NOTHING_TO_REDELIVER',
          );
        case 'inactive':
          throw conflict(
            'Re-activate this announcement before retrying its delivery.',
            'ANNOUNCEMENT_NOT_REDELIVERABLE',
          );
        case 'expired':
          throw conflict(
            'This announcement’s display window has closed; it can no longer be delivered.',
            'ANNOUNCEMENT_NOT_REDELIVERABLE',
          );
        default:
          break;
      }

      const attempt = ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT;
      const enqueued = await requestPublish({
        announcementId: row.id,
        attempt,
        actorId: actor.id,
        dedupeWindowMs: ANNOUNCEMENT_REDELIVER_DEDUPE_WINDOW_MS,
      });
      if (!enqueued) {
        // No sweep stands behind a manual redelivery — `publishDue` only takes
        // UNSTAMPED rows — so an accepted-looking 202 here would be the same
        // "the button did nothing" the issue is about.
        throw new ApiError(
          503,
          'ANNOUNCEMENT_REDELIVER_UNAVAILABLE',
          'The delivery queue is unavailable. Try again shortly.',
        );
      }

      await audit.record({
        actorId: actor.id,
        action: AUDIT.redeliver,
        targetType: 'announcement',
        targetId: row.id,
        ip: actor.ip ?? null,
        // The counts the operator ACTED ON, plus the job that will change them.
        meta: {
          attempt,
          jobId: enqueued.jobId,
          delivered: row.deliveredCount,
          failed: row.failedCount,
        },
      });

      logger?.info(
        { announcementId: row.id, attempt, jobId: enqueued.jobId, failed: row.failedCount },
        'announcement redelivery queued by an operator',
      );

      return {
        announcementId: row.id,
        jobId: enqueued.jobId,
        attempt,
        failedCount: row.failedCount ?? 0,
        deliveredCount: row.deliveredCount,
      };
    },

    /** Drafts only (contract §7.3); anything published is archived instead. */
    async remove(id, actor): Promise<void> {
      const before = await repo.findById(id);
      if (!before) throw announcementNotFound();
      const ok = await repo.removeDraft(id);
      if (!ok) {
        throw conflict(
          'A published announcement is archived, not deleted.',
          ANNOUNCEMENT_ERROR_CODES.notDraft,
        );
      }
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
        // Cheap guard on the snapshot first: a batch of 20 can straddle an
        // `endsAt`, so a row that was due when the list was taken may have left
        // its window before its turn came. `publishOne` then re-reads, which is
        // what catches an operator switching it off mid-batch.
        if (dueness(row, now()) !== 'due') continue;
        const outcome = await publishOne(row.id, 0);
        if (outcome.status === 'skipped') continue;
        summary.inserted += outcome.inserted;
        summary.failed += outcome.failed;
        if (outcome.status === 'published') summary.published += 1;
        if (outcome.retryScheduled) summary.retriesScheduled += 1;
      }
      return summary;
    },

    publishAnnouncement(id, attempt = 0, actorId?: string): Promise<AnnouncementPublishOutcome> {
      return publishOne(id, attempt, actorId);
    },
  };
}
