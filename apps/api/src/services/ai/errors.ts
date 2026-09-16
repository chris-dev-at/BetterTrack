import {
  AI_CAP_EXCEEDED,
  AI_ENDPOINT_NOT_LOCAL,
  AI_PROVIDER_ERROR,
  AI_UNAVAILABLE,
  AI_UNUSABLE_OUTPUT,
} from '@bettertrack/contracts';

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

/**
 * The admin named an endpoint outside the internal network (§16 2026-07-22 —
 * LOCAL AI ONLY, #1656 defect 1).
 *
 * A 400 rather than a 403: this is a malformed value in the request, and the
 * admin who sent it is entitled to know precisely why so they can fix it. The
 * message names the remedy for the one legitimate way this fires on a correct
 * configuration — a deployment whose API shares the operator's flat LAN, where
 * the outbound guard derives that LAN as the deployment's own service network.
 */
export class AiEndpointNotLocalError extends ApiError {
  constructor(
    message = 'The AI endpoint must be on the internal network (a private or loopback address). If this deployment shares the LAN the Ollama host is on, declare the real service network in BT_OUTBOUND_DEPLOYMENT_SUBNETS.',
  ) {
    super(400, AI_ENDPOINT_NOT_LOCAL, message);
  }
}

/**
 * The provider answered, but nothing usable could be extracted from what it
 * said (#1656 defect 5).
 *
 * 422, not the 502 this used to raise: the endpoint is healthy, the request was
 * well-formed, and the caller's daily-cap unit HAS been refunded — so a client
 * must be able to tell this from an unreachable provider, and "rephrase" is the
 * correct next step rather than "the local model is down".
 */
export class AiUnusableOutputError extends ApiError {
  constructor(message = 'Could not turn that description into a basket. Try rephrasing.') {
    super(422, AI_UNUSABLE_OUTPUT, message);
  }
}
