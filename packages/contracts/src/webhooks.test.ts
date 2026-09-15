import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_DELIVERY_ERRORS,
  WEBHOOK_DELIVERY_NETWORK_ERROR,
  WEBHOOK_EVENT_PAYLOAD_SCHEMAS,
  WEBHOOK_EVENT_TYPES,
  normalizeWebhookDeliveryError,
  webhookDeliveryFailureReason,
  webhookDeliverySchema,
  webhookEventPayloadSchema,
} from './webhooks';

/**
 * The delivered body is contract-defined per event type (§13.5 V5-P10): `data`
 * is an allowlist, not an open record, so a receiver can only ever be told what
 * somebody decided to disclose for that type.
 */
describe('webhook payload allowlist', () => {
  it('declares exactly one strict payload schema per catalog type', () => {
    expect(Object.keys(WEBHOOK_EVENT_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...WEBHOOK_EVENT_TYPES].sort(),
    );
    for (const type of WEBHOOK_EVENT_TYPES) {
      const schema = WEBHOOK_EVENT_PAYLOAD_SCHEMAS[type];
      // `.strict()`: an undeclared field is a parse error, never a silent
      // passenger on the wire.
      expect(schema._def.unknownKeys, type).toBe('strict');
      // Every payload names its recipient — always the subscription owner.
      expect(Object.keys(schema.shape), type).toContain('userId');
    }
  });

  it('accepts a declared body and refuses an extra field, a wrong shape, or an unknown type', () => {
    const body = {
      id: 'delivery-1',
      type: 'chat.message' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
      data: {
        userId: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        senderId: 'sender-1',
        senderUsername: 'sender',
      },
    };

    expect(webhookEventPayloadSchema.parse(body)).toEqual(body);
    // The field the allowlist exists to keep off the wire.
    expect(
      webhookEventPayloadSchema.safeParse({
        ...body,
        data: { ...body.data, bodyPreview: 'private text' },
      }).success,
    ).toBe(false);
    // A mirror payload cannot be delivered under a chat type…
    expect(
      webhookEventPayloadSchema.safeParse({
        ...body,
        data: {
          userId: 'user-1',
          chainId: 'chain-1',
          chainName: 'Chain',
          actorUsername: 'actor',
          refId: 'ref-1',
        },
      }).success,
    ).toBe(false);
    // …and an event outside the catalog has no payload at all.
    expect(
      webhookEventPayloadSchema.safeParse({ ...body, type: 'portfolio.changed' }).success,
    ).toBe(false);
  });
});

/**
 * The delivery log's `error` is a CLOSED set (§13.5 V5-P10). The field used to be
 * free text and the dispatcher used to pass the socket's own message through, so
 * a subscriber could read `connect ECONNREFUSED 172.18.0.4:5432` back out of
 * their own delivery log — a confirmed port oracle on whatever the outbound
 * guard still allows. The contract now says what it always claimed.
 */
describe('webhook delivery log: the scrubbed error contract', () => {
  const row = {
    id: '00000000-0000-7000-8000-0000000000aa',
    eventType: 'alert.triggered',
    status: 'failed',
    responseStatus: null,
    attempts: 1,
    createdAt: '2026-07-02T08:00:00.000Z',
  } as const;

  it.each(WEBHOOK_DELIVERY_ERRORS)('accepts the canonical reason %s', (error) => {
    expect(webhookDeliverySchema.safeParse({ ...row, error }).success).toBe(true);
  });

  it.each([
    'connect ECONNREFUSED 172.18.0.4:5432',
    "Hostname/IP does not match certificate's altnames: Host: db. is not in the cert",
    'socket hang up',
    'HTTP 401',
  ])('refuses receiver- or socket-provided text (%s)', (error) => {
    expect(webhookDeliverySchema.safeParse({ ...row, error }).success).toBe(false);
  });

  it('maps a row written before the closed set onto the structural reason', () => {
    // The 30-day log still holds free-text rows; they must read back scrubbed
    // rather than fail the response schema.
    expect(normalizeWebhookDeliveryError('connect ECONNREFUSED 172.18.0.4:5432')).toBe(
      WEBHOOK_DELIVERY_NETWORK_ERROR,
    );
    expect(normalizeWebhookDeliveryError('HTTP 500')).toBe(WEBHOOK_DELIVERY_NETWORK_ERROR);
    expect(normalizeWebhookDeliveryError(null)).toBeNull();
    for (const error of WEBHOOK_DELIVERY_ERRORS) {
      expect(normalizeWebhookDeliveryError(error)).toBe(error);
    }
  });

  it('classifies every canonical reason, so no failure is an unexplained badge', () => {
    const reasons = WEBHOOK_DELIVERY_ERRORS.map((error) =>
      webhookDeliveryFailureReason({ status: 'failed', responseStatus: null, error }),
    );
    expect(reasons).toEqual([
      // A row whose responseStatus survived is classified 'http' by status; the
      // constant itself carries the same meaning when read on its own.
      'http',
      'refused',
      'unresolved',
      'timeout',
      'secret',
      'unsubscribed',
      'network',
    ]);
  });
});
