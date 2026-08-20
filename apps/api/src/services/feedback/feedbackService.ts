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
  FeedbackThreadPage,
} from '../../data/repositories/feedbackRepository';

const DEFAULT_THREAD_LIMIT = 40;

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

function toThreadMessage(row: FeedbackMessageRow): FeedbackThreadMessage {
  return {
    id: row.id,
    feedbackId: row.feedbackId,
    senderId: row.authorUserId,
    authorSide: row.authorSide,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

function toThreadResponse(page: FeedbackThreadPage): FeedbackThreadResponse {
  return {
    thread: page.thread,
    messages: page.rows.map(toThreadMessage),
    nextCursor: page.nextCursor,
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
  getThreadForSubmitter(
    userId: string,
    id: string,
    input: FeedbackThreadQuery,
  ): Promise<FeedbackThreadResponse | null>;
  sendMessageForSubmitter(
    userId: string,
    id: string,
    input: SendFeedbackMessageRequest,
  ): Promise<SendFeedbackMessageResponse | null>;
  markReadForSubmitter(userId: string, id: string): Promise<boolean>;
  /** Owner-only queue read; authorization is enforced by the parent admin router. */
  listForAdmin(input: AdminFeedbackListQuery): Promise<AdminFeedbackListResponse>;
  getThreadForAdmin(id: string, input: FeedbackThreadQuery): Promise<FeedbackThreadResponse | null>;
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
      const page = await repo.getThreadForSubmitter(userId, id, {
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_THREAD_LIMIT,
      });
      return page ? toThreadResponse(page) : null;
    },

    async sendMessageForSubmitter(userId, id, input) {
      const row = await repo.createMessageForSubmitter(userId, id, input.body);
      return row ? { message: toThreadMessage(row) } : null;
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
      const page = await repo.getThreadForAdmin(id, {
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_THREAD_LIMIT,
      });
      return page ? toThreadResponse(page) : null;
    },

    async sendMessageForAdmin(adminUserId, id, input) {
      const row = await repo.createMessageForAdmin(adminUserId, id, input.body);
      return row ? { message: toThreadMessage(row) } : null;
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
