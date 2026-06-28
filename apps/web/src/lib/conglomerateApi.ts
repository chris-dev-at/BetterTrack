import {
  backtestPreviewResponseSchema,
  conglomerateDetailSchema,
  type BacktestPreviewRange,
  type BacktestPreviewResponse,
  type ConglomerateDetail,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

export async function createConglomerateDraft(name: string): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>('/conglomerates', {
    method: 'POST',
    body: { name },
  });
  return conglomerateDetailSchema.parse(data);
}

export async function getConglomerate(
  id: string,
  signal?: AbortSignal,
): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}`, { signal });
  return conglomerateDetailSchema.parse(data);
}

export async function saveConglomeratePositions(
  id: string,
  positions: Array<{ assetId: string; weightPct: number }>,
): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}/positions`, {
    method: 'PUT',
    body: { positions },
  });
  return conglomerateDetailSchema.parse(data);
}

export async function activateConglomerate(id: string): Promise<ConglomerateDetail> {
  const data = await apiRequest<unknown>(`/conglomerates/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
  });
  return conglomerateDetailSchema.parse(data);
}

export async function previewBacktest(
  range: BacktestPreviewRange,
  positions: Array<{ assetId: string; weightPct: number }>,
  signal?: AbortSignal,
): Promise<BacktestPreviewResponse> {
  const data = await apiRequest<unknown>('/backtest/preview', {
    method: 'POST',
    body: { range, positions },
    signal,
  });
  return backtestPreviewResponseSchema.parse(data);
}
