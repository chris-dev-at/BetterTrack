import {
  alertListResponseSchema,
  alertSchema,
  alertSharingResponseSchema,
  type Alert,
  type AlertListResponse,
  type AlertSharingResponse,
  type CreateAlertRequest,
  type UpdateAlertRequest,
  type UpdateAlertSharingRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the price-alert CRUD surface (PROJECTPLAN.md §14, V3-P10 arc
 * b — API in #334). Every response is parsed through its contract schema,
 * mirroring `notificationsApi.ts` / `conglomerateApi.ts`, so the SPA and the
 * server can't silently drift.
 */

/** Shared TanStack Query key — the Workboard panel and the asset-page inline
 * widget both read the same cached list (the inline widget filters by asset),
 * so a mutation from either surface refreshes both. */
export const ALERTS_QUERY_KEY = ['alerts'] as const;

/** `GET /alerts` — all of the caller's alerts, newest asset identity embedded. */
export async function listAlerts(signal?: AbortSignal): Promise<AlertListResponse> {
  const data = await apiRequest<unknown>('/alerts', { signal });
  return alertListResponseSchema.parse(data);
}

/** `POST /alerts` — create an alert; `refPrice` is snapshotted server-side. */
export async function createAlert(body: CreateAlertRequest): Promise<Alert> {
  const data = await apiRequest<unknown>('/alerts', { method: 'POST', body });
  return alertSchema.parse(data);
}

/** `PATCH /alerts/:id` — tweak threshold and/or repeat (kind + asset immutable). */
export async function updateAlert(id: string, body: UpdateAlertRequest): Promise<Alert> {
  const data = await apiRequest<unknown>(`/alerts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
  return alertSchema.parse(data);
}

/** `POST /alerts/:id/rearm` — reset a fired one-shot back to `active` (§14). */
export async function rearmAlert(id: string): Promise<Alert> {
  const data = await apiRequest<unknown>(`/alerts/${encodeURIComponent(id)}/rearm`, {
    method: 'POST',
  });
  return alertSchema.parse(data);
}

/** `DELETE /alerts/:id` — remove an alert. */
export async function deleteAlert(id: string): Promise<void> {
  await apiRequest<unknown>(`/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Query key for the caller's alert-visibility setting (#455). */
export const ALERT_SHARING_QUERY_KEY = ['alerts', 'sharing'] as const;

/** `GET /alerts/sharing` — whether the caller's alerts are visible to followers (#455). */
export async function getAlertSharing(signal?: AbortSignal): Promise<AlertSharingResponse> {
  const data = await apiRequest<unknown>('/alerts/sharing', { signal });
  return alertSharingResponseSchema.parse(data);
}

/** `PUT /alerts/sharing` — expose/hide the caller's alerts to followers (#455).
 * Enabling requires `acknowledgeFollowers: true` (privacy friction ladder). */
export async function updateAlertSharing(
  body: UpdateAlertSharingRequest,
): Promise<AlertSharingResponse> {
  const data = await apiRequest<unknown>('/alerts/sharing', { method: 'PUT', body });
  return alertSharingResponseSchema.parse(data);
}
