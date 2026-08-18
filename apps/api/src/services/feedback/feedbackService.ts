import type { CreateFeedbackRequest, CreateFeedbackResponse } from '@bettertrack/contracts';

import type { FeedbackRepository } from '../../data/repositories/feedbackRepository';

export interface FeedbackService {
  /** Persist one authenticated, text-only submission into the owner queue. */
  submit(userId: string, input: CreateFeedbackRequest): Promise<CreateFeedbackResponse>;
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
  };
}
