import { AI_CAP_EXCEEDED, AI_PROVIDER_ERROR, AI_UNAVAILABLE } from '@bettertrack/contracts';

import { ApiError } from '../../errors';

/**
 * Typed AI-layer errors (PROJECTPLAN.md §13.5 V5-P12, §8 envelope). They extend
 * {@link ApiError} so the HTTP error handler maps them to the shared
 * `{ error: { code, message, details? } }` shape with the right status — no
 * per-route try/catch needed. Codes are shared with the web client via
 * `@bettertrack/contracts` so the two never drift.
 */

/** No provider is configured (or the AI feature flag is off): the layer is disabled. */
export class AiUnavailableError extends ApiError {
  constructor(message = 'AI is not available.') {
    super(503, AI_UNAVAILABLE, message);
  }
}

/** The caller has spent their per-user daily completion budget. */
export class AiCapExceededError extends ApiError {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Daily AI limit reached. Try again tomorrow.',
  ) {
    super(429, AI_CAP_EXCEEDED, message, { retryAfter: retryAfterSeconds });
  }
}

/** The configured (local) provider failed to answer a completion. */
export class AiProviderError extends ApiError {
  constructor(message = 'The AI provider failed to respond.') {
    super(502, AI_PROVIDER_ERROR, message);
  }
}
