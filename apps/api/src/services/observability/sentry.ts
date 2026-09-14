import type { AppConfig } from '../../config/env';
import type { Logger } from '../../logger';

import type { ScrubbableValue } from './scrubber';

/**
 * The retired external error-tracking seam (§16 2026-07-17 "Sentry is OUT —
 * permanently"; §13.5 V5-P2 arc (d)).
 *
 * The SDK is never initialised, on any code path: this module does not import
 * it, so no client, no transport and no DSN-derived endpoint can be constructed
 * — a restored old `.env` cannot silently resume shipping BetterTrack errors to
 * a third party. `BT_SENTRY_DSN` being set is therefore not configuration, it is
 * a PROBLEM: {@link initObservability} refuses it, says so in the log, and
 * reports it as {@link Observability.refusedDsn} so the caller captures a row on
 * the admin Problems page — the zero-setup replacement and the only management
 * surface the operator is expected to read (§6.12).
 *
 * The handle it returns is still the seam the rest of the process reports
 * through, so every call site stays unconditional and does nothing.
 */
export interface Observability {
  /** Always false: the external SDK is retired and never initialises. */
  readonly enabled: boolean;
  /**
   * True when a DSN was configured and REFUSED. The caller turns this into a
   * captured problem, because a silently ignored DSN is an operator who thinks
   * errors are being collected somewhere they are not.
   */
  readonly refusedDsn: boolean;
  /** Report an exception. A no-op — the DB capture owns this now. */
  captureException(err: unknown, context?: Record<string, ScrubbableValue>): void;
  /** Flush buffered events (graceful shutdown / deterministic tests). */
  flush(timeoutMs?: number): Promise<boolean>;
  /** Flush and shut the client down. */
  close(timeoutMs?: number): Promise<boolean>;
}

/** The one and only handle shape — there is no enabled variant any more. */
function inertObservability(refusedDsn: boolean): Observability {
  return {
    enabled: false,
    refusedDsn,
    captureException() {},
    async flush() {
      return true;
    },
    async close() {
      return true;
    },
  };
}

/** What an operator is told when a retired DSN is found in the env. */
export const SENTRY_REFUSED_MESSAGE =
  'BT_SENTRY_DSN is set but external Sentry is retired: no events are sent. ' +
  'Remove the variable — the admin Problems page is the error surface.';

export interface InitObservabilityOptions {
  /** Identifies the process in the refusal log line (`api` vs `worker`). */
  serverName?: string;
}

export function initObservability(
  config: AppConfig,
  logger: Logger,
  options: InitObservabilityOptions = {},
): Observability {
  if (!config.sentry.dsnConfigured) return inertObservability(false);

  // Loud, and not only in the log: the caller captures this as a problem row.
  logger.error(
    { serverName: options.serverName, release: config.sentry.release },
    SENTRY_REFUSED_MESSAGE,
  );
  return inertObservability(true);
}
