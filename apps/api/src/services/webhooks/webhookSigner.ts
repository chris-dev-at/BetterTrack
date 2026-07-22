import { createHmac, timingSafeEqual } from 'node:crypto';

import { WEBHOOK_SIGNATURE_SCHEME, type WebhookEventPayload } from '@bettertrack/contracts';

/**
 * Webhook payload signing (§13.5 V5-P10). Pure functions, no I/O — the delivery
 * dispatcher signs with the subscription's decrypted secret, and the same
 * `verify*` a receiver would run backs the integration test.
 *
 * Signature = `sha256=<hex>` where hex is HMAC-SHA256 of `` `${timestamp}.${body}` ``
 * under the secret (the GitHub/Stripe convention). Binding the timestamp in
 * means a captured body cannot be replayed under a fresh timestamp.
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

/** Constant-time signature check (receiver-side; used by the integration test). */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
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
