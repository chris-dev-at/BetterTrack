import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_EVENT_PAYLOAD_SCHEMAS,
  WEBHOOK_EVENT_TYPES,
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
