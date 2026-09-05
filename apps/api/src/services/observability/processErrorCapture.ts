import type { Logger } from '../../logger';

import type { ProblemService } from './problemService';

/**
 * Process-level error capture (§13.5 V5-P2 arc (d)).
 *
 * Capture was wired only where an error is HANDED to us — the express error
 * handler, the BullMQ failure hooks, the provider breaker. An error thrown
 * outside all of them (a rejected promise in a `res.on('finish')` listener, a
 * socket handler, an unref'd timer) took the process down with no `problems`
 * row at all: the single largest class the retired Sentry SDK used to own, and
 * the one an operator most needs after a container restarts on its own.
 *
 * Both signals are FATAL here, exactly as they are without a listener — Node's
 * default for an unhandled rejection has been `throw` (⇒ `uncaughtException` ⇒
 * exit 1) since v15, and installing a listener silently changes that. So this
 * captures, drains the write with a bounded wait, and then exits 1: the process
 * dies the way it did before, one row richer.
 */
export type FatalErrorSource = 'unhandledRejection' | 'uncaughtException';

/** Which process the captured row names. */
export type CapturingProcess = 'api' | 'worker';

/** The `process`-shaped surface this binds to (a fake in tests). */
export interface ProcessErrorTarget {
  on(event: FatalErrorSource, listener: (err: unknown) => void): unknown;
  off?(event: FatalErrorSource, listener: (err: unknown) => void): unknown;
}

export interface ProcessErrorCaptureDeps {
  problems: Pick<ProblemService, 'captureError' | 'flush'>;
  logger: Logger;
  /** Identifies the process in the captured row's context. */
  process: CapturingProcess;
  /** Emitter to bind to. Defaults to the real `process`. */
  target?: ProcessErrorTarget;
  /** Terminate the process. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /**
   * Ceiling on how long the capture write may hold termination open. A wedged
   * DB write must not turn a crash into a hang — the row is worth waiting for,
   * not worth waiting forever for.
   */
  flushTimeoutMs?: number;
}

export interface ProcessErrorCapture {
  /**
   * The registered handler, exposed so a test can drive it directly instead of
   * crashing the runner. Resolves once the row is drained and `exit` was called.
   */
  handle(source: FatalErrorSource, err: unknown): Promise<void>;
  /** Detach the listeners (tests). */
  unregister(): void;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

export function registerProcessErrorCapture(deps: ProcessErrorCaptureDeps): ProcessErrorCapture {
  const { problems, logger } = deps;
  const target = deps.target ?? (process as unknown as ProcessErrorTarget);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const flushTimeoutMs = deps.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  let dying = false;

  const handle = async (source: FatalErrorSource, err: unknown): Promise<void> => {
    // A second fatal while the first is draining must not restart the drain (or
    // double-exit): the first one already owns termination.
    if (dying) return;
    dying = true;
    try {
      // Everything stored goes through the same scrubber as any other capture,
      // so a rejection carrying a token or an address lands redacted.
      problems.captureError(err, { process: deps.process, source });
      logger.error({ err, source, process: deps.process }, 'fatal process error — capturing');
      await Promise.race([
        problems.flush(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, flushTimeoutMs).unref();
        }),
      ]);
    } catch (captureErr) {
      logger.error({ err: captureErr }, 'failed to capture a fatal process error');
    } finally {
      exit(1);
    }
  };

  const onRejection = (err: unknown): void => void handle('unhandledRejection', err);
  const onException = (err: unknown): void => void handle('uncaughtException', err);
  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);

  return {
    handle,
    unregister() {
      target.off?.('unhandledRejection', onRejection);
      target.off?.('uncaughtException', onException);
    },
  };
}
