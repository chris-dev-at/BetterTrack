import type { Logger } from './logger';
import type { UsageAnalyticsService } from './services/analytics/usageAnalyticsService';
import type { ProblemService } from './services/observability/problemService';

/**
 * Shutdown drain for the first-party telemetry buffers (PROJECTPLAN.md §13.5
 * V5-P2).
 *
 * Both producers keep work in memory that only a flush turns into rows:
 * `problems.captureError` issues a fire-and-forget DB write, and
 * `usageAnalytics` folds signals in a Map until its 15 s timer fires. Closing
 * the DB pool underneath either one silently discards it — which is why the
 * errors most likely to PRECEDE a restart (an unhandled 500, an OOM kill) were
 * exactly the ones that never reached the Problems page, and why every restart
 * dropped up to a flush interval of DAU / feature-counter signal.
 *
 * The drain is **bounded**: a wedged write must not hold termination open, so
 * the flush races a timeout and shutdown continues either way (loudly — the
 * timeout is logged, never silent).
 */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

export interface FlushTelemetryBuffersDeps {
  problems: Pick<ProblemService, 'flush'>;
  /** Omitted by processes that never capture usage signals (e.g. the worker). */
  usageAnalytics?: Pick<UsageAnalyticsService, 'stop'>;
  logger?: Logger;
  /** Ceiling on the drain. Defaults to {@link SHUTDOWN_FLUSH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Await the telemetry buffers, bounded by {@link FlushTelemetryBuffersDeps.timeoutMs}.
 * Never rejects: a failing flush is logged, because shutdown must proceed.
 */
export async function flushTelemetryBuffers(deps: FlushTelemetryBuffersDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_FLUSH_TIMEOUT_MS;

  // `Promise.resolve().then(...)` so a SYNCHRONOUS throw out of either flush is
  // caught here too, rather than escaping into the caller's shutdown try block.
  const drained = Promise.allSettled([
    Promise.resolve().then(() => deps.problems.flush()),
    Promise.resolve().then(() => deps.usageAnalytics?.stop()),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        deps.logger?.error({ err: result.reason }, 'telemetry flush failed during shutdown');
      }
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    drained.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (timedOut) {
    deps.logger?.warn(
      { timeoutMs },
      'telemetry flush timed out during shutdown — continuing; some captures may be lost',
    );
  }
}
