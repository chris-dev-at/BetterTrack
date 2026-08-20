import {
  FEEDBACK_OPEN_LIMIT,
  FEEDBACK_OPEN_SUBMISSION_LIMIT,
  type AdminFeedbackListQuery,
  type AdminFeedbackListResponse,
  type AdminFeedbackSubmission,
  type CreateFeedbackRequest,
  type CreateFeedbackResponse,
  type FeedbackContext,
  type MyFeedbackResponse,
  type MyFeedbackSubmission,
  type UpdateFeedbackStatusRequest,
  type UpdateFeedbackStatusResponse,
} from '@bettertrack/contracts';

import type {
  AdminFeedbackRow,
  FeedbackRepository,
} from '../../data/repositories/feedbackRepository';
import { conflict } from '../../errors';

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
    submitter: row.submitter,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
    // Reserved for #1339's thread/read-marker model.
    unreadReplyCount: 0,
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
  /** Owner-only queue read; authorization is enforced by the parent admin router. */
  listForAdmin(input: AdminFeedbackListQuery): Promise<AdminFeedbackListResponse>;
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
