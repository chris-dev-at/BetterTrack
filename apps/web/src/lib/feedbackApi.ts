import {
  createFeedbackResponseSchema,
  feedbackThreadResponseSchema,
  myFeedbackResponseSchema,
  okResponseSchema,
  sendFeedbackMessageResponseSchema,
  type CreateFeedbackRequest,
  type CreateFeedbackResponse,
  type FeedbackThreadQuery,
  type FeedbackThreadResponse,
  type MyFeedbackResponse,
  type SendFeedbackMessageRequest,
  type SendFeedbackMessageResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for authenticated in-app feedback and the caller-owned support
 * thread. Every response is parsed by the shared contract before it reaches a
 * user surface.
 */
export async function submitFeedback(body: CreateFeedbackRequest): Promise<CreateFeedbackResponse> {
  const data = await apiRequest<unknown>('/feedback', { method: 'POST', body });
  return createFeedbackResponseSchema.parse(data);
}

/** `GET /feedback/mine` — only the authenticated submitter's submissions. */
export async function listMyFeedback(signal?: AbortSignal): Promise<MyFeedbackResponse> {
  const data = await apiRequest<unknown>('/feedback/mine', { signal });
  return myFeedbackResponseSchema.parse(data);
}

/** `GET /feedback/:id/messages` — newest-first, cursor-paginated support thread. */
export async function getFeedbackThread(
  id: string,
  params: Partial<FeedbackThreadQuery> = {},
  signal?: AbortSignal,
): Promise<FeedbackThreadResponse> {
  const data = await apiRequest<unknown>(`/feedback/${encodeURIComponent(id)}/messages`, {
    query: { cursor: params.cursor, limit: params.limit },
    signal,
  });
  return feedbackThreadResponseSchema.parse(data);
}

/** `POST /feedback/:id/messages` — a submitter reply in their own thread. */
export async function sendFeedbackMessage(
  id: string,
  body: SendFeedbackMessageRequest,
): Promise<SendFeedbackMessageResponse> {
  const data = await apiRequest<unknown>(`/feedback/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body,
  });
  return sendFeedbackMessageResponseSchema.parse(data);
}

/** `POST /feedback/:id/read` — idempotently advances the submitter's read marker. */
export async function markFeedbackRead(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/feedback/${encodeURIComponent(id)}/read`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}
