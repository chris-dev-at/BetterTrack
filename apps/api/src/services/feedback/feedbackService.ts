import type {
  AdminFeedbackListQuery,
  AdminFeedbackListResponse,
  AdminFeedbackSubmission,
  CreateFeedbackRequest,
  CreateFeedbackResponse,
  FeedbackContext,
  UpdateFeedbackStatusRequest,
  UpdateFeedbackStatusResponse,
} from '@bettertrack/contracts';

import type {
  AdminFeedbackRow,
  FeedbackRepository,
} from '../../data/repositories/feedbackRepository';

function toAdminSubmission(row: AdminFeedbackRow): AdminFeedbackSubmission {
  return {
    id: row.id,
    category: row.category,
    subject: row.subject,
    message: row.message,
    context: row.context as FeedbackContext | null,
    status: row.status,
    submitter: row.submitter,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface FeedbackService {
  /** Persist one authenticated, text-only submission into the owner queue. */
  submit(userId: string, input: CreateFeedbackRequest): Promise<CreateFeedbackResponse>;
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
      return { id: row.id, createdAt: row.createdAt.toISOString() };
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
      const row = await repo.setStatus(id, input.status, new Date());
      if (!row) return null;
      return { id: row.id, status: row.status, updatedAt: row.updatedAt.toISOString() };
    },
  };
}
