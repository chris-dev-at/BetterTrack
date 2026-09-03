import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  WEBHOOK_SIGNATURE_SCHEME,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  type WebhookEventPayload,
} from '@bettertrack/contracts';

/**
 * Webhook payload signing (§13.5 V5-P10). Pure functions, no I/O — the delivery
 * dispatcher signs with the subscription's decrypted secret, and the same
 * `verify*` a receiver would run backs the integration test.
 *
 * Signature = `sha256=<hex>` where hex is HMAC-SHA256 of `` `${timestamp}.${body}` ``
 * under the secret (the GitHub/Stripe convention). Binding the timestamp in
 * means the timestamp cannot be changed without invalidating the MAC — but the
 * captured triple (timestamp, body, signature) stays valid forever on its own,
 * so {@link verifyWebhookSignature} additionally requires the timestamp to be
 * fresh within {@link WEBHOOK_SIGNATURE_TOLERANCE_SECONDS}. That freshness
 * window is what bounds replay; receivers should apply the same bound.
 */

/**
 * The minimal event shape a delivery signs. A concrete typed domain event is
 * structurally assignable to this; at runtime the whole event (all its fields)
 * is what {@link buildWebhookPayload} serializes into `data`.
 */
export interface SignableEvent {
  type: string;
  occurredAt: string;
}

/** Compute the `X-BetterTrack-Signature` header value. */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `${WEBHOOK_SIGNATURE_SCHEME}=${mac}`;
}

export interface VerifyWebhookSignatureOptions {
  /** Receiver-side "now" in epoch milliseconds. Defaults to the system clock. */
  now?: number;
  /**
   * Half-width of the accepted timestamp window, in seconds. Defaults to
   * {@link WEBHOOK_SIGNATURE_TOLERANCE_SECONDS}; `Infinity` disables the
   * freshness check for a receiver that dedupes on the delivery id instead.
   */
  toleranceSeconds?: number;
}

/**
 * Constant-time signature check plus the freshness window (receiver-side; used
 * by the integration test).
 *
 * Returns false — never throws — when the timestamp is not a plain epoch-second
 * integer, when it sits further than `toleranceSeconds` from `now` in either
 * direction (an old capture replayed, or a clock too far ahead), or when the MAC
 * does not match.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  options: VerifyWebhookSignatureOptions = {},
): boolean {
  const { now = Date.now(), toleranceSeconds = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } = options;

  if (!/^\d{1,15}$/.test(timestamp)) return false;
  const skewSeconds = Math.abs(now / 1000 - Number(timestamp));
  if (!(skewSeconds <= toleranceSeconds)) return false;

  const expected = signWebhookPayload(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Build the wire payload (envelope) for a delivery: a stable delivery `id`,
 * the event `type`, the event's `createdAt`, and the raw event as `data`. The
 * body the signature covers is exactly `JSON.stringify(payload)`.
 */
export function buildWebhookPayload(
  deliveryId: string,
  event: SignableEvent,
): { payload: WebhookEventPayload; body: string } {
  const payload: WebhookEventPayload = {
    id: deliveryId,
    type: event.type as WebhookEventPayload['type'],
    createdAt: event.occurredAt,
    // The event carries only the subscribing user's own data (no secrets). The
    // static type is narrow, but every runtime field serializes into `data`.
    data: event as unknown as Record<string, unknown>,
  };
  return { payload, body: JSON.stringify(payload) };
}
