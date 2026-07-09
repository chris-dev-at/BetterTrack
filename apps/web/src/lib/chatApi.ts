import {
  chatConversationListResponseSchema,
  chatThreadResponseSchema,
  conversationResponseSchema,
  okResponseSchema,
  sendChatMessageResponseSchema,
  type ChatConversation,
  type ChatConversationListResponse,
  type ChatMessage,
  type ChatThreadResponse,
  type SendChatMessageRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the friend-chat surface (PROJECTPLAN.md §13.3 V3-P8),
 * mirroring `socialApi.ts` / `notificationsApi.ts`. Every push over the realtime
 * gateway maps to a refetch here, and each call keeps its TanStack Query poll
 * behaviour, so chat stays fully functional with the socket absent (§4.5).
 */

/** `GET /chat/conversations` — the caller's threads + a total unread badge. */
export async function listConversations(
  signal?: AbortSignal,
): Promise<ChatConversationListResponse> {
  const data = await apiRequest<unknown>('/chat/conversations', { signal });
  return chatConversationListResponseSchema.parse(data);
}

/** `POST /chat/conversations {userId}` — open (or resolve) the 1:1 with a friend. */
export async function openConversation(userId: string): Promise<ChatConversation> {
  const data = await apiRequest<unknown>('/chat/conversations', {
    method: 'POST',
    body: { userId },
  });
  return conversationResponseSchema.parse(data).conversation;
}

/** `GET /chat/conversations/:id/messages` — a page of the thread (newest-first) + its summary. */
export async function getThread(
  conversationId: string,
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ChatThreadResponse> {
  const data = await apiRequest<unknown>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    { query: { cursor: params.cursor, limit: params.limit }, signal },
  );
  return chatThreadResponseSchema.parse(data);
}

/** `POST /chat/conversations/:id/messages` — send text and/or a share chip. */
export async function sendChatMessage(
  conversationId: string,
  body: SendChatMessageRequest,
): Promise<ChatMessage> {
  const data = await apiRequest<unknown>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: 'POST', body },
  );
  return sendChatMessageResponseSchema.parse(data).message;
}

/** `POST /chat/conversations/:id/read` — clear the caller's unread badge (idempotent). */
export async function markConversationRead(conversationId: string): Promise<void> {
  const data = await apiRequest<unknown>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/read`,
    { method: 'POST' },
  );
  okResponseSchema.parse(data);
}
