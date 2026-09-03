import { describe, expect, it } from 'vitest';

import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from '@bettertrack/contracts';

import {
  buildWebhookPayload,
  signWebhookPayload,
  type SignableEvent,
  verifyWebhookSignature,
} from '../webhookSigner';

const SECRET = 'whsec_vector_secret';
const TIMESTAMP = '1735689600';
/** The vector's timestamp as receiver-side "now" — i.e. a perfectly fresh delivery. */
const SIGNED_AT_MS = Number(TIMESTAMP) * 1000;
const BODY =
  '{"id":"delivery-123","type":"alert.triggered","createdAt":"2025-01-01T00:00:00.000Z","data":{"alertId":"alert-123"}}';
const SIGNATURE = 'sha256=078f70ed47cabd06bcd6eafb198e2100d3c02809df75906980e5e4372e14352e';

describe('webhook signer', () => {
  it('produces the fixed HMAC-SHA256 signature vector', () => {
    expect(signWebhookPayload(SECRET, TIMESTAMP, BODY)).toBe(SIGNATURE);
    expect(verifyWebhookSignature(SECRET, TIMESTAMP, BODY, SIGNATURE, { now: SIGNED_AT_MS })).toBe(
      true,
    );
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
      const options = { now: SIGNED_AT_MS };
      expect(() =>
        verifyWebhookSignature(secret, timestamp, body, signature, options),
      ).not.toThrow();
      expect(verifyWebhookSignature(secret, timestamp, body, signature, options)).toBe(false);
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

/**
 * Replay window. Binding the timestamp into the MAC stops an attacker re-stamping
 * a captured body, but the captured triple itself stays valid arithmetic forever
 * — so the reference verifier every receiver is pointed at bounds its age.
 */
describe('webhook signature freshness window', () => {
  const fresh = (nowMs: number, options: { toleranceSeconds?: number } = {}): boolean =>
    verifyWebhookSignature(SECRET, TIMESTAMP, BODY, SIGNATURE, { now: nowMs, ...options });

  const OFFSETS = [
    ['exactly at the tolerance, replayed late', WEBHOOK_SIGNATURE_TOLERANCE_SECONDS, true],
    ['exactly at the tolerance, clock ahead', -WEBHOOK_SIGNATURE_TOLERANCE_SECONDS, true],
    ['one second past the tolerance', WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1, false],
    [
      'one second past the tolerance in the future',
      -(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1),
      false,
    ],
    ['a day later', 86_400, false],
  ] as const;

  it.each(OFFSETS)('%s → %s', (_label, offsetSeconds, accepted) => {
    expect(fresh(SIGNED_AT_MS + offsetSeconds * 1000)).toBe(accepted);
  });

  it('is bounded by a small window by default', () => {
    expect(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS).toBeGreaterThan(0);
    expect(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS).toBeLessThanOrEqual(600);
  });

  it('lets a receiver widen or disable the window explicitly', () => {
    const dayLater = SIGNED_AT_MS + 86_400_000;
    expect(fresh(dayLater, { toleranceSeconds: 86_400 })).toBe(true);
    expect(fresh(dayLater, { toleranceSeconds: Infinity })).toBe(true);
    expect(fresh(dayLater, { toleranceSeconds: 0 })).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['non-numeric', 'not-a-timestamp'],
    ['negative', '-1735689600'],
    ['fractional', '1735689600.5'],
    ['milliseconds instead of seconds', String(SIGNED_AT_MS)],
    ['absurdly long', '9'.repeat(20)],
  ])('refuses a %s timestamp without throwing', (_label, timestamp) => {
    expect(() =>
      verifyWebhookSignature(SECRET, timestamp, BODY, SIGNATURE, { now: SIGNED_AT_MS }),
    ).not.toThrow();
    expect(verifyWebhookSignature(SECRET, timestamp, BODY, SIGNATURE, { now: SIGNED_AT_MS })).toBe(
      false,
    );
  });

  it('still rejects a fresh timestamp whose signature does not match', () => {
    expect(
      verifyWebhookSignature(SECRET, TIMESTAMP, BODY, `sha256=${'0'.repeat(64)}`, {
        now: SIGNED_AT_MS,
      }),
    ).toBe(false);
  });
});
