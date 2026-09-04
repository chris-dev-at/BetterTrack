import { describe, expect, it } from 'vitest';

import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from '@bettertrack/contracts';

import type { ChatMessageEvent, DomainEvent, MirrorNotificationEvent } from '../../../events';
import { buildWebhookPayload, signWebhookPayload, verifyWebhookSignature } from '../webhookSigner';

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

  /**
   * The envelope used to carry the whole runtime event. It now carries the
   * per-type allowlist (`WEBHOOK_EVENT_PAYLOAD_SCHEMAS`), so the fields the
   * event holds for internal use — a private message preview, other accounts'
   * ids — never reach a receiver. The signature covers exactly those bytes.
   */
  it('discloses only the allowlisted fields and serializes the exact signed body', () => {
    const event: ChatMessageEvent = {
      type: 'chat.message',
      occurredAt: '2025-01-01T00:00:00.000Z',
      userId: 'user-123',
      senderId: 'sender-456',
      senderUsername: 'sender',
      conversationId: 'conversation-789',
      messageId: 'message-abc',
      bodyPreview: 'BANK-PIN-4711 meet me at noon',
      hasChip: false,
    };

    const built = buildWebhookPayload('delivery-123', event);

    expect(built).not.toBeNull();
    expect(built!.payload).toEqual({
      id: 'delivery-123',
      type: 'chat.message',
      createdAt: event.occurredAt,
      data: {
        userId: 'user-123',
        conversationId: 'conversation-789',
        messageId: 'message-abc',
        senderId: 'sender-456',
        senderUsername: 'sender',
      },
    });
    expect(built!.body).toBe(JSON.stringify(built!.payload));
    expect(built!.body).not.toContain('BANK-PIN-4711');
    expect(built!.body).not.toContain('hasChip');
  });

  it('keeps a mirror notice free of the internal privacy principals', () => {
    const event: MirrorNotificationEvent = {
      type: 'mirror.member_removed',
      occurredAt: '2025-01-01T00:00:00.000Z',
      userId: 'recipient-1',
      chainId: 'chain-1',
      chainName: 'Household',
      actorId: 'actor-2',
      ownerId: 'owner-3',
      subjectUserIds: ['subject-4'],
      actorUsername: 'actor',
      refId: 'ref-1',
    };

    const built = buildWebhookPayload('delivery-124', event);

    expect(built!.payload.data).toEqual({
      userId: 'recipient-1',
      chainId: 'chain-1',
      chainName: 'Household',
      actorUsername: 'actor',
      refId: 'ref-1',
    });
    for (const principal of ['actor-2', 'owner-3', 'subject-4']) {
      expect(built!.body).not.toContain(principal);
    }
  });

  it('refuses to serialize an event outside the subscribable catalog', () => {
    const event: DomainEvent = {
      type: 'portfolio.changed',
      userId: 'user-123',
      portfolioId: 'portfolio-1',
      occurredAt: '2025-01-01T00:00:00.000Z',
    };

    expect(buildWebhookPayload('delivery-125', event)).toBeNull();
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
