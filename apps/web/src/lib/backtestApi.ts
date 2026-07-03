import {
  backtestResponseSchema,
  type BacktestBenchmark,
  type BacktestPreviewPosition,
  type BacktestPreviewRange,
  type BacktestResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/** `POST /backtest/preview` — typed client (PROJECTPLAN.md §6.5, §6.6, §7.2). */
export async function previewBacktest(
  positions: BacktestPreviewPosition[],
  range: BacktestPreviewRange,
  benchmark?: BacktestBenchmark | null,
  signal?: AbortSignal,
): Promise<BacktestResponse> {
  const data = await apiRequest<unknown>('/backtest/preview', {
    method: 'POST',
    body: { positions, range, benchmark: benchmark ?? undefined },
    signal,
  });
  return backtestResponseSchema.parse(data);
}
