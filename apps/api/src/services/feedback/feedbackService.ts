import {
  FEEDBACK_OPEN_LIMIT,
  FEEDBACK_OPEN_SUBMISSION_LIMIT,
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
  type UpdateFeedbackArchiveResponse,
  type UpdateFeedbackStatusRequest,
  type UpdateFeedbackStatusResponse,
} from '@bettertrack/contracts';

import type { FeedbackMessageRow } from '../../data/schema';
import type {
  AdminFeedbackRow,
  FeedbackRepository,
  FeedbackThreadLookup,
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

function toMySubmission(
  row: Awaited<ReturnType<FeedbackRepository['listMine']>>[number],
): MyFeedbackSubmission {
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
  };
}

export interface FeedbackService {
  /** Persist one authenticated, text-only submission into the owner queue. */
  submit(userId: string, input: CreateFeedbackRequest): Promise<CreateFeedbackResponse>;
  /** Caller-owned status history; ownership is enforced inside the repository. */
  listMine(userId: string): Promise<MyFeedbackResponse>;
  /** Caller-owned, idempotent soft delete; false means absent or owned by somebody else. */
  deleteMine(userId: string, id: string): Promise<boolean>;
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
  /** One submission for the helpdesk pane; null when the row is gone. */
  getForAdmin(id: string): Promise<AdminFeedbackSubmission | null>;
  getThreadForAdmin(id: string, input: FeedbackThreadQuery): Promise<FeedbackThreadResult>;
  sendMessageForAdmin(
    adminUserId: string,
    id: string,
    input: SendFeedbackMessageRequest,
  ): Promise<SendFeedbackMessageResponse | null>;
  markReadForAdmin(id: string): Promise<boolean>;
  /** Owner-only lifecycle transition; returns null when the row vanished. */
  updateStatus(
    adminUserId: string,
    id: string,
    input: UpdateFeedbackStatusRequest,
  ): Promise<UpdateFeedbackStatusResponse | null>;
  /** Archive/unarchive is admin workspace hygiene, independent of lifecycle status. */
  setArchived(
    id: string,
    archived: boolean,
    actor: FeedbackAdminActor,
  ): Promise<UpdateFeedbackArchiveResponse | null>;
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

    async sendMessageForAdmin(adminUserId, id, input) {
      const created = await repo.createMessageForAdmin(adminUserId, id, input.body);
      if (!created) return null;
      const { row, submitterUserId, deletedByUserAt } = created;

      // A staff reply notifies its submitter only. This also covers the unusual
      // self-helpdesk case: an admin answering their own submission never receives
      // a notification about their own action. A user-deleted thread has left the
      // submitter rail entirely, so it remains silent while admins retain the audit.
      if (deletedByUserAt === null && submitterUserId !== adminUserId) {
        await notify.emit({
          type: 'feedback.reply_created',
          userId: submitterUserId,
          feedbackId: id,
          messageId: row.id,
          occurredAt: row.createdAt.toISOString(),
        });
      }
      return { message: toThreadMessage(row, 'admin') };
    },

    markReadForAdmin(id) {
      return repo.markReadForAdmin(id);
    },

    async updateStatus(adminUserId, id, input) {
      const transition = await repo.setStatus(id, input);
      if (!transition) return null;
      const { row, changed } = transition;

      // Three conditions, each load-bearing: an unchanged row is an HTTP retry,
      // a user-deleted tombstone has left the submitter's rail entirely (it must
      // not push them about a submission they can no longer open), and an admin
      // triaging their own submission is not news to themselves. The admin rail
      // still sees the transition — the tombstone keeps its audit trail.
      if (changed && row.deletedByUserAt === null && row.userId !== adminUserId) {
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
      return {
        id: row.id,
        status: row.status,
        lastStatusChangeAt: row.lastStatusChangeAt.toISOString(),
        declinedReason: row.declinedReason,
        shippedVersion: row.shippedVersion,
        updatedAt: row.updatedAt.toISOString(),
      };
    },

    async setArchived(id, archived, actor) {
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

      return {
        id: result.row.id,
        archivedAt: result.row.archivedAt ? result.row.archivedAt.toISOString() : null,
        updatedAt: result.row.updatedAt.toISOString(),
      };
    },
  };
}
