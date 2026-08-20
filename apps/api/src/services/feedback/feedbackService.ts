import type {
  AdminFeedbackListQuery,
  AdminFeedbackListResponse,
  AdminFeedbackSubmission,
  CreateFeedbackRequest,
  CreateFeedbackResponse,
  FeedbackContext,
  FeedbackThreadMessage,
  FeedbackThreadQuery,
  FeedbackThreadResponse,
  MyFeedbackResponse,
  MyFeedbackSubmission,
  SendFeedbackMessageRequest,
  SendFeedbackMessageResponse,
  UpdateFeedbackStatusRequest,
  UpdateFeedbackStatusResponse,
} from '@bettertrack/contracts';

import type { FeedbackMessageRow } from '../../data/schema';
import type {
  AdminFeedbackRow,
  FeedbackRepository,
  FeedbackThreadLookup,
} from '../../data/repositories/feedbackRepository';

const DEFAULT_THREAD_LIMIT = 40;

/**
 * Thread read outcome, carried to the routes so each maps to its own status: a
 * missing/foreign submission is a no-leak 404, an unresolvable cursor a 400.
 */
export type FeedbackThreadResult =
  | { status: 'ok'; thread: FeedbackThreadResponse }
  | { status: 'not_found' }
  | { status: 'invalid_cursor' };

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
    submitter: row.submitter,
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
  getThreadForAdmin(id: string, input: FeedbackThreadQuery): Promise<FeedbackThreadResult>;
  sendMessageForAdmin(
    adminUserId: string,
    id: string,
    input: SendFeedbackMessageRequest,
  ): Promise<SendFeedbackMessageResponse | null>;
  markReadForAdmin(id: string): Promise<boolean>;
  /** Owner-only lifecycle transition; returns null when the row vanished. */
  updateStatus(
    id: string,
    input: UpdateFeedbackStatusRequest,
  ): Promise<UpdateFeedbackStatusResponse | null>;
}

export interface FeedbackServiceDeps {
  repo: FeedbackRepository;
}

export function createFeedbackService({ repo }: FeedbackServiceDeps): FeedbackService {
  return {
    async submit(userId, input) {
      const row = await repo.create(userId, input);
      return { id: row.id, createdAt: row.createdAt.toISOString() };
    },

    async listMine(userId) {
      return { submissions: (await repo.listMine(userId)).map(toMySubmission) };
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
      const row = await repo.createMessageForAdmin(adminUserId, id, input.body);
      return row ? { message: toThreadMessage(row, 'admin') } : null;
    },

    markReadForAdmin(id) {
      return repo.markReadForAdmin(id);
    },

    async updateStatus(id, input) {
      const row = await repo.setStatus(id, input, new Date());
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        lastStatusChangeAt: row.lastStatusChangeAt.toISOString(),
        declinedReason: row.declinedReason,
        shippedVersion: row.shippedVersion,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  };
}
