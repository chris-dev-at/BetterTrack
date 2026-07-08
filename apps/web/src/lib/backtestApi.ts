import {
  backtestResponseSchema,
  type BacktestBenchmark,
  type BacktestMode,
  type BacktestPreviewPosition,
  type BacktestPreviewRange,
  type BacktestResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/** `POST /backtest/preview` — typed client (PROJECTPLAN.md §6.5, §6.6, §7.2, §14). */
export async function previewBacktest(
  positions: BacktestPreviewPosition[],
  range: BacktestPreviewRange,
  benchmark?: BacktestBenchmark | null,
  mode: BacktestMode = 'clip',
  signal?: AbortSignal,
): Promise<BacktestResponse> {
  const data = await apiRequest<unknown>('/backtest/preview', {
    method: 'POST',
    body: { positions, range, benchmark: benchmark ?? undefined, mode },
    signal,
  });
  return backtestResponseSchema.parse(data);
}
