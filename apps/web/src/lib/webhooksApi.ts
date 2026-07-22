import {
  createWebhookSubscriptionResponseSchema,
  webhookDeliveryListResponseSchema,
  webhookSubscriptionListResponseSchema,
  webhookSubscriptionResponseSchema,
  type CreateWebhookSubscriptionRequest,
  type CreateWebhookSubscriptionResponse,
  type UpdateWebhookSubscriptionRequest,
  type WebhookDeliveryListResponse,
  type WebhookSubscriptionListResponse,
  type WebhookSubscriptionResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for outbound webhooks (§13.5 V5-P10) — the Settings → API Access
 * surface. The signing secret is only ever present in the `POST` response and is
 * shown to the user exactly once.
 */

/** `GET /settings/webhooks` — the caller's subscriptions (never the secret). */
export async function listWebhooks(signal?: AbortSignal): Promise<WebhookSubscriptionListResponse> {
  const data = await apiRequest<unknown>('/settings/webhooks', { signal });
  return webhookSubscriptionListResponseSchema.parse(data);
}

/** `POST /settings/webhooks` — create; the response carries the one-time secret. */
export async function createWebhook(
  input: CreateWebhookSubscriptionRequest,
): Promise<CreateWebhookSubscriptionResponse> {
  const data = await apiRequest<unknown>('/settings/webhooks', { method: 'POST', body: input });
  return createWebhookSubscriptionResponseSchema.parse(data);
}

/** `PATCH /settings/webhooks/:id` — edit (URL / events / pause / re-enable). */
export async function updateWebhook(
  id: string,
  input: UpdateWebhookSubscriptionRequest,
): Promise<WebhookSubscriptionResponse> {
  const data = await apiRequest<unknown>(`/settings/webhooks/${id}`, {
    method: 'PATCH',
    body: input,
  });
  return webhookSubscriptionResponseSchema.parse(data);
}

/** `DELETE /settings/webhooks/:id` — remove a subscription. */
export async function deleteWebhook(id: string): Promise<void> {
  await apiRequest<void>(`/settings/webhooks/${id}`, { method: 'DELETE' });
}

/** `GET /settings/webhooks/:id/deliveries` — the bounded delivery log. */
export async function listWebhookDeliveries(
  id: string,
  signal?: AbortSignal,
): Promise<WebhookDeliveryListResponse> {
  const data = await apiRequest<unknown>(`/settings/webhooks/${id}/deliveries`, { signal });
  return webhookDeliveryListResponseSchema.parse(data);
}
