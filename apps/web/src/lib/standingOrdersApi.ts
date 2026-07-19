import {
  standingOrderListResponseSchema,
  standingOrderSchema,
  type CreateStandingOrderRequest,
  type StandingOrder,
  type StandingOrderListResponse,
  type UpdateStandingOrderRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the standing-orders API (PROJECTPLAN.md §13.5 V5-P6b arc
 * (a), engine issue #593). Every response is parsed through its contract
 * schema so the management surface works against validated shapes rather than
 * raw JSON. Reads are `list`/`get`; mutations are `create`/`update` plus the
 * lifecycle triggers `pause`/`resume`/`remove`. Every mutation invalidates the
 * shared list query key.
 */

export const STANDING_ORDERS_QUERY_KEY = ['standingOrders'] as const;

/** `GET /standing-orders[?portfolioId=]` — the caller's orders (optionally one portfolio). */
export async function listStandingOrders(
  portfolioId?: string,
  signal?: AbortSignal,
): Promise<StandingOrderListResponse> {
  const data = await apiRequest<unknown>('/standing-orders', {
    query: portfolioId ? { portfolioId } : undefined,
    signal,
  });
  return standingOrderListResponseSchema.parse(data);
}

/** `POST /standing-orders` — create a recurring buy / cash-add / cash-deduct. */
export async function createStandingOrder(
  body: CreateStandingOrderRequest,
): Promise<StandingOrder> {
  const data = await apiRequest<unknown>('/standing-orders', {
    method: 'POST',
    body,
  });
  return standingOrderSchema.parse(data);
}

/** `PATCH /standing-orders/:id` — edit amount / label / end date. */
export async function updateStandingOrder(
  id: string,
  patch: UpdateStandingOrderRequest,
): Promise<StandingOrder> {
  const data = await apiRequest<unknown>(`/standing-orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
  return standingOrderSchema.parse(data);
}

/** `POST /standing-orders/:id/pause` — stop firing (keeps history; no back-fill on resume). */
export async function pauseStandingOrder(id: string): Promise<StandingOrder> {
  const data = await apiRequest<unknown>(`/standing-orders/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
  });
  return standingOrderSchema.parse(data);
}

/** `POST /standing-orders/:id/resume` — resume firing from the current period on. */
export async function resumeStandingOrder(id: string): Promise<StandingOrder> {
  const data = await apiRequest<unknown>(`/standing-orders/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
  });
  return standingOrderSchema.parse(data);
}

/** `DELETE /standing-orders/:id` — remove an order (its run history cascades). */
export async function deleteStandingOrder(id: string): Promise<void> {
  await apiRequest<unknown>(`/standing-orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
