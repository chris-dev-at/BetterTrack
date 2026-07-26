import { describe, expect, it } from 'vitest';

import {
  buildWebhookPayload,
  signWebhookPayload,
  type SignableEvent,
  verifyWebhookSignature,
} from '../webhookSigner';

const SECRET = 'whsec_vector_secret';
const TIMESTAMP = '1735689600';
const BODY =
  '{"id":"delivery-123","type":"alert.triggered","createdAt":"2025-01-01T00:00:00.000Z","data":{"alertId":"alert-123"}}';
const SIGNATURE = 'sha256=078f70ed47cabd06bcd6eafb198e2100d3c02809df75906980e5e4372e14352e';

describe('webhook signer', () => {
  it('produces the fixed HMAC-SHA256 signature vector', () => {
    expect(signWebhookPayload(SECRET, TIMESTAMP, BODY)).toBe(SIGNATURE);
    expect(verifyWebhookSignature(SECRET, TIMESTAMP, BODY, SIGNATURE)).toBe(true);
  });

  it.each([
    ['secret', 'whsec_changed_secret', TIMESTAMP, BODY, SIGNATURE],
    ['timestamp', SECRET, '1735689601', BODY, SIGNATURE],
    ['body', SECRET, TIMESTAMP, `${BODY} `, SIGNATURE],
    ['digest', SECRET, TIMESTAMP, BODY, `sha256=${'0'.repeat(64)}`],
    ['malformed-length signature', SECRET, TIMESTAMP, BODY, 'sha256=bad'],
  ])(
    'returns false without throwing for a changed %s',
    (_changed, secret, timestamp, body, signature) => {
      expect(() => verifyWebhookSignature(secret, timestamp, body, signature)).not.toThrow();
      expect(verifyWebhookSignature(secret, timestamp, body, signature)).toBe(false);
    },
  );

  it('preserves the event in its envelope and serializes the exact signed body', () => {
    const event: SignableEvent & {
      userId: string;
      alertId: string;
      metadata: { source: string };
    } = {
      type: 'alert.triggered',
      occurredAt: '2025-01-01T00:00:00.000Z',
      userId: 'user-123',
      alertId: 'alert-123',
      metadata: { source: 'price-alert' },
    };

    const { payload, body } = buildWebhookPayload('delivery-123', event);

    expect(payload).toEqual({
      id: 'delivery-123',
      type: event.type,
      createdAt: event.occurredAt,
      data: event,
    });
    expect(body).toBe(JSON.stringify(payload));
  });
});
