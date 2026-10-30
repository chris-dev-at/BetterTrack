import {
  FEEDBACK_BULK_RESULTS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_NOT_EDITABLE,
  FEEDBACK_OPEN_LIMIT,
  FEEDBACK_OPEN_SUBMISSION_LIMIT,
  FEEDBACK_STATUSES,
  type AdminFeedbackBulkRequest,
  type AdminFeedbackBulkResponse,
  type AdminFeedbackCountsQuery,
  type AdminFeedbackCountsResponse,
  type AdminFeedbackListQuery,
  type AdminFeedbackListResponse,
  type AdminFeedbackSubmission,
  type CreateFeedbackRequest,
  type CreateFeedbackResponse,
  type FeedbackContext,
  type FeedbackThreadMessage,
  type FeedbackThreadQuery,
  type FeedbackThreadResponse,
  type MyFeedbackResponse,
  type MyFeedbackSubmission,
  type SendFeedbackMessageRequest,
  type SendFeedbackMessageResponse,
  type FeedbackBulkResult,
  type UpdateFeedbackArchiveResponse,
  type UpdateFeedbackStatusRequest,
  type UpdateFeedbackStatusResponse,
  type UpdateMyFeedbackRequest,
} from '@bettertrack/contracts';
import { z } from 'zod';

import { isIntegrityConstraintViolation } from '../../data/driverError';
import type { FeedbackMessageRow } from '../../data/schema';
import type {
  AdminFeedbackRow,
  FeedbackRepository,
  FeedbackThreadLookup,
  MyFeedbackRow,
} from '../../data/repositories/feedbackRepository';
import { conflict } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import type { NotificationCenter } from '../notifications/notificationCenter';

const DEFAULT_THREAD_LIMIT = 40;

/**
 * Thread read outcome, carried to the routes so each maps to its own status: a
 * missing/foreign submission is a no-leak 404, an unresolvable cursor a 400.
 */
export type FeedbackThreadResult =
  | { status: 'ok'; thread: FeedbackThreadResponse }
  | { status: 'not_found' }
  | { status: 'invalid_cursor' };

export interface FeedbackAdminActor {
  id: string;
  ip?: string | null;
}

/**
 * Which admin surface wrote a status change or a reply — recorded as
 * `meta.source` on the audit row so a bulk sweep is distinguishable from a
 * one-at-a-time triage. (`source`, not `via`: `meta.via` already means "the
 * shell break-glass script" to the audit presets.)
 */
export type FeedbackAdminSource = 'single' | 'bulk' | 'thread';

/** Options for the admin status write; all optional so existing callers stay valid. */
export interface FeedbackStatusOptions {
  ip?: string | null;
  source?: Exclude<FeedbackAdminSource, 'thread'>;
}

const uuidSchema = z.string().uuid();

function toAdminSubmission(row: AdminFeedbackRow): AdminFeedbackSubmission {
  return {
    id: row.id,
    category: row.category,
    subject: row.subject,
    message: row.message,
    context: row.context as FeedbackContext | null,
    status: row.status,
    lastStatusChangeAt: row.lastStatusChangeAt.toISOString(),
    declinedReason: row.declinedReason,
    shippedVersion: row.shippedVersion,
    deletedByUser: row.deletedByUserAt !== null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    submitter: row.submitter,
    unreadCount: row.unreadCount,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    lastAuthorSide: row.lastAuthorSide,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Which rail is rendering the thread. The two see the same rows, but not the
 * same `senderId`: `authorUserId` on an admin-side row is the replying staff
 * account's internal id, identity the product surfaces to a user nowhere else.
 * The account export already projects it to null for exactly that reason
 * (`services/export/collector.ts`), so the live endpoint the same user calls
 * must not hand back what the export scrubs — otherwise the scrub is one `GET`
 * from being defeated. `authorSide: 'admin'` carries the attribution the
 * submitter actually needs. On the admin rail the id stays: it is the queue's
 * own audit trail of who answered.
 */
type ThreadAudience = 'submitter' | 'admin';

function toThreadMessage(row: FeedbackMessageRow, audience: ThreadAudience): FeedbackThreadMessage {
  const staffRowOnSubmitterRail = audience === 'submitter' && row.authorSide === 'admin';
  return {
    id: row.id,
    feedbackId: row.feedbackId,
    senderId: staffRowOnSubmitterRail ? null : row.authorUserId,
    authorSide: row.authorSide,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

function toThreadResult(
  lookup: FeedbackThreadLookup,
  audience: ThreadAudience,
): FeedbackThreadResult {
  if (lookup.status !== 'ok') return lookup;
  return {
    status: 'ok',
    thread: {
      thread: lookup.page.thread,
      messages: lookup.page.rows.map((row) => toThreadMessage(row, audience)),
      nextCursor: lookup.page.nextCursor,
    },
  };
}

/**
 * The `/feedback/mine` item. Key order is part of what the mobile client has
 * been reading since #1338 — every pre-existing key keeps its position and
 * `editedAt` is appended — so a byte-level diff of an un-edited row shows only
 * the one added key.
 */
function toMySubmission(row: MyFeedbackRow): MyFeedbackSubmission {
  return {
    id: row.id,
    category: row.category,
    subject: row.subject,
    message: row.message,
    status: row.status,
    lastStatusChangeAt: row.lastStatusChangeAt.toISOString(),
    declinedReason: row.declinedReason,
    shippedVersion: row.shippedVersion,
    unreadReplyCount: row.unreadReplyCount,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  };
}

/** Zero-filled `{ [key]: 0 }` for every value of a wire enum. */
function zeroCounts<const K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

export interface FeedbackService {
  /** Persist one authenticated, text-only submission into the owner queue. */
  submit(userId: string, input: CreateFeedbackRequest): Promise<CreateFeedbackResponse>;
  /** Caller-owned status history; ownership is enforced inside the repository. */
  listMine(userId: string): Promise<MyFeedbackResponse>;
  /** Caller-owned, idempotent soft delete; false means absent or owned by somebody else. */
  deleteMine(userId: string, id: string): Promise<boolean>;
  /**
   * Caller-owned edit while the row is still `new`. Null means absent, foreign
   * or tombstoned (a no-leak 404); any other status throws the 409
   * `FEEDBACK_NOT_EDITABLE`.
   */
  editMine(
    userId: string,
    id: string,
    input: UpdateMyFeedbackRequest,
  ): Promise<MyFeedbackSubmission | null>;
  /** Caller-owned thread page; staff `senderId`s are anonymized on this rail. */
  getThreadForSubmitter(
    userId: string,
    id: string,
    input: FeedbackThreadQuery,
  ): Promise<FeedbackThreadResult>;
  sendMessageForSubmitter(
    userId: string,
    id: string,
    input: SendFeedbackMessageRequest,
  ): Promise<SendFeedbackMessageResponse | null>;
  markReadForSubmitter(userId: string, id: string): Promise<boolean>;
  /** Owner-only queue read; authorization is enforced by the parent admin router. */
  listForAdmin(input: AdminFeedbackListQuery): Promise<AdminFeedbackListResponse>;
  /** Zero-filled per-status and per-category counts under the list's filters. */
  countsForAdmin(input: AdminFeedbackCountsQuery): Promise<AdminFeedbackCountsResponse>;
  /** One submission for the helpdesk pane; null when the row is gone. */
  getForAdmin(id: string): Promise<AdminFeedbackSubmission | null>;
  getThreadForAdmin(id: string, input: FeedbackThreadQuery): Promise<FeedbackThreadResult>;
  sendMessageForAdmin(
    adminUserId: string,
    id: string,
    input: SendFeedbackMessageRequest,
    options?: { ip?: string | null },
  ): Promise<SendFeedbackMessageResponse | null>;
  markReadForAdmin(id: string): Promise<boolean>;
  /**
   * Owner-only lifecycle transition, optionally with a staff reply written in
   * the same transaction; returns null when the row vanished.
   */
  updateStatus(
    adminUserId: string,
    id: string,
    input: UpdateFeedbackStatusRequest,
    options?: FeedbackStatusOptions,
  ): Promise<UpdateFeedbackStatusResponse | null>;
  /** Archive/unarchive is admin workspace hygiene, independent of lifecycle status. */
  setArchived(
    id: string,
    archived: boolean,
    actor: FeedbackAdminActor,
  ): Promise<UpdateFeedbackArchiveResponse | null>;
  /**
   * One action over up to 100 submissions, each row in its OWN transaction —
   * see `adminFeedbackBulkResponseSchema` for the per-row result vocabulary and
   * the partial-application contract.
   */
  bulkForAdmin(
    actor: FeedbackAdminActor,
    input: AdminFeedbackBulkRequest,
  ): Promise<AdminFeedbackBulkResponse>;
}

export interface FeedbackServiceDeps {
  repo: FeedbackRepository;
  notify: NotificationCenter;
  audit: AuditService;
}

export function createFeedbackService({
  repo,
  notify,
  audit,
}: FeedbackServiceDeps): FeedbackService {
  /**
   * The submitter-facing side effects of one admin-authored reply: a
   * notification (unless the thread is tombstoned or the admin is replying to
   * their own submission — the same two suppressions the thread route has
   * always applied) and an audit row, always.
   *
   * Idempotency: the notification's dispatcher key is
   * `feedback.reply_created:{messageId}` — one message id, one notification,
   * however often BullMQ redelivers. Callers reach this only for a message
   * they just inserted, so an HTTP retry (which inserts nothing on the status
   * paths) emits nothing.
   */
  async function afterAdminReply(
    actor: FeedbackAdminActor,
    feedbackId: string,
    submitterUserId: string,
    deletedByUserAt: Date | null,
    message: FeedbackMessageRow,
    source: FeedbackAdminSource,
  ): Promise<void> {
    if (deletedByUserAt === null && submitterUserId !== actor.id) {
      await notify.emit({
        type: 'feedback.reply_created',
        userId: submitterUserId,
        feedbackId,
        messageId: message.id,
        occurredAt: message.createdAt.toISOString(),
      });
    }
    await audit.record({
      actorId: actor.id,
      action: AuditAction.FeedbackReplied,
      targetType: 'feedback',
      targetId: feedbackId,
      ip: actor.ip ?? null,
      meta: { messageId: message.id, source },
    });
  }

  /**
   * One status write and everything that follows a REAL change. Shared by the
   * single PATCH and every row of a bulk status action, so both rails emit the
   * same events with the same keys.
   */
  async function applyStatus(
    actor: FeedbackAdminActor,
    id: string,
    input: UpdateFeedbackStatusRequest,
    source: Exclude<FeedbackAdminSource, 'thread'>,
  ) {
    const transition = await repo.setStatus(
      id,
      {
        status: input.status,
        declinedReason: input.declinedReason,
        shippedVersion: input.shippedVersion,
      },
      input.reply !== undefined ? { authorUserId: actor.id, body: input.reply } : undefined,
    );
    if (!transition) return null;
    const { row, changed, previousStatus, message } = transition;
    if (!changed) return transition;

    // Three conditions, each load-bearing: an unchanged row is an HTTP retry
    // (returned above, so it emits nothing), a user-deleted tombstone has left
    // the submitter's rail entirely (it must not push them about a submission
    // they can no longer open), and an admin triaging their own submission is
    // not news to themselves. The admin rail still sees the transition — the
    // tombstone keeps its audit trail.
    //
    // Idempotency: the dispatcher key is
    // `feedback.status_changed:{feedbackId}:{lastStatusChangeAt}`, and the
    // repository allocates a strictly increasing `lastStatusChangeAt` per real
    // transition under the row lock — one transition, one notification.
    if (row.deletedByUserAt === null && row.userId !== actor.id) {
      const occurredAt = row.lastStatusChangeAt.toISOString();
      await notify.emit({
        type: 'feedback.status_changed',
        userId: row.userId,
        feedbackId: row.id,
        status: row.status,
        lastStatusChangeAt: occurredAt,
        occurredAt,
      });
    }
    await audit.record({
      actorId: actor.id,
      action: AuditAction.FeedbackStatusChanged,
      targetType: 'feedback',
      targetId: row.id,
      ip: actor.ip ?? null,
      meta: { from: previousStatus, to: row.status, source },
    });
    // The reply's own event comes second, so a client sees "declined" before
    // "new reply" — each exactly once.
    if (message) {
      await afterAdminReply(actor, row.id, row.userId, row.deletedByUserAt, message, source);
    }
    return transition;
  }

  async function applyArchive(actor: FeedbackAdminActor, id: string, archived: boolean) {
    const result = await repo.setArchived(id, archived, new Date());
    if (!result) return null;

    // A same-state request is deliberately side-effect free. That keeps the
    // PATCH idempotent in the audit trail as well as in the feedback row.
    if (result.changed) {
      await audit.record({
        actorId: actor.id,
        action: archived ? AuditAction.FeedbackArchived : AuditAction.FeedbackUnarchived,
        targetType: 'feedback',
        targetId: result.row.id,
        ip: actor.ip ?? null,
      });
    }
    return result;
  }

  return {
    async submit(userId, input) {
      const row = await repo.create(userId, input);
      if (!row) {
        throw conflict(
          `You already have ${FEEDBACK_OPEN_SUBMISSION_LIMIT} open requests. Please wait for triage or delete an open request before submitting another.`,
          FEEDBACK_OPEN_LIMIT,
        );
      }
      return { id: row.id, createdAt: row.createdAt.toISOString() };
    },

    async listMine(userId) {
      return { submissions: (await repo.listMine(userId)).map(toMySubmission) };
    },

    async deleteMine(userId, id) {
      return Boolean(await repo.deleteMine(userId, id, new Date()));
    },

    async editMine(userId, id, input) {
      // Deliberately silent on both rails: a submitter edit notifies nobody
      // (as a submitter reply notifies nobody), and the admin inbox shows the
      // edit through `editedAt`.
      const result = await repo.editMine(userId, id, input, new Date());
      if (result.status === 'not_found') return null;
      if (result.status === 'not_editable') {
        throw conflict(
          'This submission can no longer be edited because it has already been triaged.',
          FEEDBACK_NOT_EDITABLE,
        );
      }
      return toMySubmission(result.row);
    },

    async getThreadForSubmitter(userId, id, input) {
      return toThreadResult(
        await repo.getThreadForSubmitter(userId, id, {
          cursor: input.cursor,
          limit: input.limit ?? DEFAULT_THREAD_LIMIT,
        }),
        'submitter',
      );
    },

    async sendMessageForSubmitter(userId, id, input) {
      // Deliberately unwired: a submitter reply notifies nobody. Only the
      // admin→submitter direction is routed, because a staff fan-out needs an
      // owner decision on WHICH admins receive it (all, the assignee, the
      // replier) — recorded here rather than assumed closed, so #1341/#1342 can
      // pick it up with the seam already identified.
      const row = await repo.createMessageForSubmitter(userId, id, input.body);
      return row ? { message: toThreadMessage(row, 'submitter') } : null;
    },

    markReadForSubmitter(userId, id) {
      return repo.markReadForSubmitter(userId, id);
    },

    async listForAdmin(input) {
      const { rows, total } = await repo.listForAdmin(input);
      return {
        submissions: rows.map(toAdminSubmission),
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          totalPages: Math.ceil(total / input.limit),
        },
      };
    },

    async countsForAdmin(input) {
      const byStatus = zeroCounts(FEEDBACK_STATUSES);
      const byCategory = zeroCounts(FEEDBACK_CATEGORIES);
      let total = 0;
      for (const { status, category, value } of await repo.countForAdmin(input)) {
        byStatus[status] += value;
        byCategory[category] += value;
        total += value;
      }
      return { total, byStatus, byCategory };
    },

    async getForAdmin(id) {
      const row = await repo.getForAdmin(id);
      return row ? toAdminSubmission(row) : null;
    },

    async getThreadForAdmin(id, input) {
      return toThreadResult(
        await repo.getThreadForAdmin(id, {
          cursor: input.cursor,
          limit: input.limit ?? DEFAULT_THREAD_LIMIT,
        }),
        'admin',
      );
    },

    async sendMessageForAdmin(adminUserId, id, input, options) {
      const created = await repo.createMessageForAdmin(adminUserId, id, input.body);
      if (!created) return null;
      const { row, submitterUserId, deletedByUserAt } = created;

      // A staff reply notifies its submitter only. This also covers the unusual
      // self-helpdesk case: an admin answering their own submission never receives
      // a notification about their own action. A user-deleted thread has left the
      // submitter rail entirely, so it remains silent while admins retain the audit.
      await afterAdminReply(
        { id: adminUserId, ip: options?.ip ?? null },
        id,
        submitterUserId,
        deletedByUserAt,
        row,
        'thread',
      );
      return { message: toThreadMessage(row, 'admin') };
    },

    markReadForAdmin(id) {
      return repo.markReadForAdmin(id);
    },

    async updateStatus(adminUserId, id, input, options) {
      const transition = await applyStatus(
        { id: adminUserId, ip: options?.ip ?? null },
        id,
        input,
        options?.source ?? 'single',
      );
      if (!transition) return null;
      const { row, message } = transition;
      const response: UpdateFeedbackStatusResponse = {
        id: row.id,
        status: row.status,
        lastStatusChangeAt: row.lastStatusChangeAt.toISOString(),
        declinedReason: row.declinedReason,
        shippedVersion: row.shippedVersion,
        updatedAt: row.updatedAt.toISOString(),
      };
      // Only a request that ASKED for a reply learns its fate; every other
      // status PATCH keeps its pre-2026-10-29 response byte for byte.
      if (input.reply !== undefined) {
        response.message = message ? toThreadMessage(message, 'admin') : null;
      }
      return response;
    },

    async setArchived(id, archived, actor) {
      const result = await applyArchive(actor, id, archived);
      if (!result) return null;
      return {
        id: result.row.id,
        archivedAt: result.row.archivedAt ? result.row.archivedAt.toISOString() : null,
        updatedAt: result.row.updatedAt.toISOString(),
      };
    },

    async bulkForAdmin(actor, input) {
      const results: AdminFeedbackBulkResponse['results'] = [];
      const summary = zeroCounts(FEEDBACK_BULK_RESULTS);
      const seen = new Set<string>();

      // Sequential on purpose: each row is its own transaction (the repository
      // methods open one per call), so a refused row rolls back ALONE and the
      // rest still apply; one row's lock is never held while waiting on
      // another's. NOT one batch transaction — documented on the response
      // contract, including that a 5xx mid-batch may leave a prefix applied.
      for (const id of input.ids) {
        let result: FeedbackBulkResult;
        // A malformed id is checked BEFORE it can reach SQL (a non-UUID cast
        // would be a 500), and a repeat is refused rather than silently
        // re-applied, so every input element gets exactly one honest answer.
        const key = id.toLowerCase();
        if (!uuidSchema.safeParse(id).success || seen.has(key)) {
          result = 'invalid';
        } else {
          seen.add(key);
          try {
            if (input.action === 'status') {
              const change: UpdateFeedbackStatusRequest = {
                status: input.status,
                declinedReason: input.declinedReason,
                shippedVersion: input.shippedVersion,
                reply: input.reply,
              };
              const outcome = await applyStatus(actor, id, change, 'bulk');
              result = outcome === null ? 'not_found' : outcome.changed ? 'ok' : 'unchanged';
            } else {
              const outcome = await applyArchive(actor, id, input.action === 'archive');
              result = outcome === null ? 'not_found' : outcome.changed ? 'ok' : 'unchanged';
            }
          } catch (error) {
            // Only a constraint refusal is this ROW's fault; anything else
            // (connection loss, a bug) is an incident and must surface.
            if (!isIntegrityConstraintViolation(error)) throw error;
            result = 'invalid';
          }
        }
        results.push({ id, result });
        summary[result] += 1;
      }
      return { action: input.action, results, summary };
    },
  };
}
