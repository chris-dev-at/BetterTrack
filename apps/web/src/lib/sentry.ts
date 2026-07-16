import * as Sentry from '@sentry/react';

/**
 * Web error tracking (PROJECTPLAN.md §13.4 V4-P5a).
 *
 * Env-gated on `VITE_SENTRY_DSN`: with no DSN the SDK never initializes and the
 * SPA boots byte-identically. When on, every event carries the build-time
 * release ({@link __APP_RELEASE__}) that matches the API's, and the default
 * integrations capture uncaught errors AND unhandled promise rejections; the
 * {@link ErrorBoundary} additionally reports render errors via {@link reportError}.
 */
export function initWebObservability(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    release: __APP_RELEASE__,
    environment: import.meta.env.MODE,
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
  });
}

/**
 * Report an exception. A no-op when Sentry is not initialized (no DSN), so
 * callers never need to guard.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
