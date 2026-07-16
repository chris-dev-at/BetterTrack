import * as Sentry from '@sentry/node';

import type { AppConfig } from '../../config/env';
import type { Logger } from '../../logger';

import { scrubEvent, type ScrubbableValue } from './scrubber';

/**
 * Sentry error tracking (PROJECTPLAN.md §13.4 V4-P5a).
 *
 * Env-gated: {@link initObservability} is a no-op unless `config.sentry.enabled`
 * (BT_SENTRY_DSN is set), so with no DSN the SDK never initializes and API/worker
 * boot is byte-identical. When on, every event is tagged with the deployed
 * release, sampled per the configured rates, and passed through the pure
 * {@link scrubEvent} PII scrubber as `beforeSend` before it can leave the process.
 *
 * The handle it returns is the ONLY way the rest of the process reports errors,
 * so a disabled build calls a harmless no-op instead of reaching into the SDK.
 */
export interface Observability {
  /** True once the SDK actually initialized (DSN present). */
  readonly enabled: boolean;
  /** Report an exception (no-op when disabled). Extra context is scrubbed too. */
  captureException(err: unknown, context?: Record<string, ScrubbableValue>): void;
  /** Flush buffered events (graceful shutdown / deterministic tests). */
  flush(timeoutMs?: number): Promise<boolean>;
  /** Flush and shut the client down. */
  close(timeoutMs?: number): Promise<boolean>;
}

/** Shared no-op used whenever Sentry is disabled. */
const disabledObservability: Observability = {
  enabled: false,
  captureException() {},
  async flush() {
    return true;
  },
  async close() {
    return true;
  },
};

export interface InitObservabilityOptions {
  /** Identifies the process in events (`api` vs `worker`). */
  serverName?: string;
  /**
   * Test seam: a Sentry transport factory to capture envelopes in-memory instead
   * of shipping them over the network. Production leaves this unset (real HTTP).
   */
  transport?: Sentry.NodeOptions['transport'];
}

export function initObservability(
  config: AppConfig,
  logger: Logger,
  options: InitObservabilityOptions = {},
): Observability {
  if (!config.sentry.enabled || !config.sentry.dsn) return disabledObservability;

  Sentry.init({
    dsn: config.sentry.dsn,
    release: config.sentry.release,
    environment: config.sentry.environment,
    serverName: options.serverName,
    sampleRate: config.sentry.errorSampleRate,
    tracesSampleRate: config.sentry.tracesSampleRate,
    // Never let the SDK attach PII on its own (client IP, cookies, request body):
    // the scrubber is the backstop, but not collecting it in the first place is
    // the primary guard.
    sendDefaultPii: false,
    transport: options.transport,
    // The zero-PII gate (§13.4 V4-P5a): every error AND transaction event passes
    // through the pure scrubber before transport.
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });

  logger.info(
    { release: config.sentry.release, environment: config.sentry.environment },
    'Sentry error tracking enabled',
  );

  return {
    enabled: true,
    captureException(err, context) {
      Sentry.captureException(err, context ? { extra: context } : undefined);
    },
    flush: (timeoutMs = 2000) => Sentry.flush(timeoutMs),
    close: (timeoutMs = 2000) => Sentry.close(timeoutMs),
  };
}
