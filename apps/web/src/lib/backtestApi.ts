import {
  backtestResponseSchema,
  type BacktestBenchmarkInput,
  type BacktestMode,
  type BacktestPreviewPosition,
  type BacktestPreviewRange,
  type BacktestResponse,
  type RebalanceFrequency,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/** `POST /backtest/preview` request params (V4-P7: benchmark choice + rebalance schedule). */
export interface BacktestPreviewParams {
  positions: BacktestPreviewPosition[];
  range: BacktestPreviewRange;
  /** Exactly one benchmark at a time (preset / catalog asset / own conglomerate), or none. */
  benchmark?: BacktestBenchmarkInput | null;
  mode?: BacktestMode;
  rebalance?: RebalanceFrequency;
}

/** `POST /backtest/preview` — typed client (PROJECTPLAN.md §6.5, §6.6, §7.2, §14, §13.4 V4-P7). */
export async function previewBacktest(
  params: BacktestPreviewParams,
  signal?: AbortSignal,
): Promise<BacktestResponse> {
  const data = await apiRequest<unknown>('/backtest/preview', {
    method: 'POST',
    body: {
      positions: params.positions,
      range: params.range,
      benchmark: params.benchmark ?? undefined,
      mode: params.mode ?? 'clip',
      rebalance: params.rebalance ?? 'none',
    },
    signal,
  });
  return backtestResponseSchema.parse(data);
}
