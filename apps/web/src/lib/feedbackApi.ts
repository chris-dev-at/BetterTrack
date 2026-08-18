import {
  createFeedbackResponseSchema,
  type CreateFeedbackRequest,
  type CreateFeedbackResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for authenticated in-app feedback. This stays write-only until
 * the later "my submissions" surface lands.
 */
export async function submitFeedback(body: CreateFeedbackRequest): Promise<CreateFeedbackResponse> {
  const data = await apiRequest<unknown>('/feedback', { method: 'POST', body });
  return createFeedbackResponseSchema.parse(data);
}
