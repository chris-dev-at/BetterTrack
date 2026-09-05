import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PARANOID_KILLED_WEBHOOK_EVENT_TYPES,
  PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_DELIVERY_REFUSED_ERROR,
  WEBHOOK_DELIVERY_SECRET_ERROR,
  WEBHOOK_DELIVERY_UNSUBSCRIBED_ERROR,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_PAYLOAD_SCHEMAS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_URL_BLOCKED_CODE,
  createWebhookSubscriptionResponseSchema,
  isParanoidKilledWebhookEventType,
  webhookDeliveryListResponseSchema,
  webhookEventPayloadSchema,
  webhookSubscriptionListResponseSchema,
  type WebhookEventType,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import {
  createWebhookDeliveryRepository,
  createWebhookSubscriptionRepository,
} from '../data/repositories/webhookRepository';
import type {
  AlertTriggeredEvent,
  DividendEventNotice,
  DomainEvent,
  FollowAlertCreatedEvent,
  FollowAlertFiredEvent,
  MirrorNotificationEvent,
  PortfolioSharedEvent,
  StandingOrderSkippedEvent,
  WatchlistSharedEvent,
} from '../events';
import {
  BACKOFF_BASE_MS,
  QUEUE_NAMES,
  WEBHOOK_BACKOFF_JITTER,
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  WEBHOOK_DELIVER_ATTEMPTS,
  WEBHOOK_DELIVER_CONCURRENCY,
  WEBHOOK_DELIVER_LIMITER,
  WebhookDeliveryRetryError,
  bindParanoidJob,
  createWebhookDeliverJob,
  createWebhookDeliveryCleanupJob,
  jobOptionsForQueue,
  type JobDefinition,
} from '../jobs';
import { isParanoidKilledWebhookEvent } from '../services/account/paranoidEnforcement';
import type { AuditService } from '../services/audit/auditService';
import { decryptSecret, encryptSecret } from '../services/crypto/secretBox';
import { DISPATCHABLE_EVENT_TYPES } from '../services/notifications/notificationDispatcher';
import type {
  OutboundUrlResolver,
  ResolvedOutboundUrl,
} from '../services/security/outboundUrlGuard';
import {
  WEBHOOK_PERMANENT_RESPONSE_STATUSES,
  createWebhookBridge,
  createWebhookDispatcher,
  isPermanentWebhookStatus,
  verifyWebhookSignature,
  type WebhookDeliveryJob,
  type WebhookTransport,
} from '../services/webhooks';
import { createTestApp, publicTestResolver, type TestHarness } from '../testing/createTestApp';

/** A no-op audit sink for directly-constructed dispatchers in unit-style tests. */
const noopAudit: Pick<AuditService, 'record'> = { record: async () => undefined };

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DELIVERY_A = '00000000-0000-7000-8000-0000000000aa';
const DELIVERY_B = '00000000-0000-7000-8000-0000000000ab';
const MIRROR_WEBHOOK_TYPES: readonly MirrorNotificationEvent['type'][] = [
  'mirror.invite',
  'mirror.member_joined',
  'mirror.member_left',
  'mirror.member_removed',
  'mirror.removed',
  'mirror.ownership_transferred',
  'mirror.chain_dissolved',
  'mirror.sync_stalled',
];
type FollowAlertEvent = FollowAlertCreatedEvent | FollowAlertFiredEvent;
const FOLLOW_ALERT_WEBHOOK_TYPES: readonly FollowAlertEvent['type'][] = [
  'follow.alert.created',
  'follow.alert.fired',
];

type Agent = ReturnType<typeof request.agent>;

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** The addresses the guard vetted for this attempt; the transport must pin them. */
  target: ResolvedOutboundUrl;
}

/** A transport that records every POST and replies with a scripted status. */
function recordingTransport(status = 200): {
  transport: WebhookTransport;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    transport: {
      async send(req) {
        requests.push(req);
        return { ok: status >= 200 && status < 300, status };
      },
    },
  };
}

let harness: TestHarness;
let recorder: ReturnType<typeof recordingTransport>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Log in a fresh user + create a subscription; returns agent, id, and the one-time secret. */
async function createSubscription(
  eventTypes: string[],
  url = 'https://receiver.test/hook',
): Promise<{ agent: Agent; userId: string; id: string; secret: string }> {
  const user = await harness.seedUser({
    email: `wh-${Math.round(Math.random() * 1e9)}@bettertrack.test`,
    username: `wh${Math.round(Math.random() * 1e9)}`,
  });
  const agent = await loginAgent(harness.app, user.email, user.password);
  const res = await agent
    .post('/api/v1/settings/webhooks')
    .set(...XRW)
    .send({ url, eventTypes });
  expect(res.status).toBe(201);
  const parsed = createWebhookSubscriptionResponseSchema.parse(res.body);
  return { agent, userId: user.id, id: parsed.subscription.id, secret: parsed.secret };
}

function alertEvent(userId: string): AlertTriggeredEvent {
  return {
    type: 'alert.triggered',
    userId,
    alertId: '00000000-0000-7000-8000-000000000001',
    assetId: '00000000-0000-7000-8000-000000000002',
    occurredAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  recorder = recordingTransport(200);
  harness = await createTestApp({ webhookTransport: recorder.transport });
});

afterEach(() => {
  recorder.requests.length = 0;
});

describe('webhook subscription CRUD + one-time secret', () => {
  it('returns the signing secret exactly once and stores only its encrypted form', async () => {
    const { agent, id, secret } = await createSubscription(['alert.triggered']);

    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);

    // Stored form is the AES-256-GCM envelope, never the plaintext — and it
    // decrypts back to exactly the secret shown once.
    const [row] = await harness.db
      .select()
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, id));
    expect(row).toBeDefined();
    expect(row!.secretEncrypted).not.toContain(secret);
    expect(decryptSecret(row!.secretEncrypted, harness.ctx.config.twoFactor.encryptionKey)).toBe(
      secret,
    );

    // Re-fetching the subscription never carries the secret.
    const list = await agent.get('/api/v1/settings/webhooks');
    expect(list.status).toBe(200);
    const parsed = webhookSubscriptionListResponseSchema.parse(list.body);
    expect(parsed.subscriptions).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(secret);
  });

  it('rejects an unknown event type, an empty selection, and a non-http URL', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const base = { url: 'https://receiver.test/hook' };

    const badType = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ ...base, eventTypes: ['not.a.real.event'] });
    expect(badType.status).toBe(400);

    const empty = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ ...base, eventTypes: [] });
    expect(empty.status).toBe(400);

    const badUrl = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ url: 'ftp://nope', eventTypes: ['alert.triggered'] });
    expect(badUrl.status).toBe(400);
  });

  it('audit-logs creation and deletion; delete cascades the delivery log', async () => {
    const { agent, id } = await createSubscription(['alert.triggered']);
    const del = await agent.delete(`/api/v1/settings/webhooks/${id}`).set(...XRW);
    expect(del.status).toBe(204);

    const gone = await agent.get('/api/v1/settings/webhooks');
    expect(webhookSubscriptionListResponseSchema.parse(gone.body).subscriptions).toHaveLength(0);

    const actions = (
      await harness.db.select({ action: schema.auditLog.action }).from(schema.auditLog)
    ).map((r) => r.action);
    expect(actions).toContain('webhook.created');
    expect(actions).toContain('webhook.deleted');
  });

  it('cannot manage webhooks with an API key (session-only)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const key = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'k', scopes: ['social:read', 'social:write'] });
    const token = key.body.token as string;

    const res = await request(harness.app)
      .get('/api/v1/settings/webhooks')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
  });
});

describe('signed delivery', () => {
  it('delivers with a pre-upgrade envelope derived from a multi-secret session config', async () => {
    const sessionSecret = 'newer-cookie-secret-value,older-cookie-secret-value';
    const h = await createTestApp({
      env: { SESSION_SECRET: sessionSecret },
      webhookTransport: recorder.transport,
    });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = createWebhookSubscriptionResponseSchema.parse(
      (
        await agent
          .post('/api/v1/settings/webhooks')
          .set(...XRW)
          .send({ url: 'https://receiver.test/pre-upgrade', eventTypes: ['alert.triggered'] })
      ).body,
    );

    // Before #879, webhook envelopes used the hash of the complete raw
    // SESSION_SECRET value, including every comma-separated cookie key.
    const preUpgradeKey = createHash('sha256').update(`bt-2fa:${sessionSecret}`).digest();
    await h.db
      .update(schema.webhookSubscriptions)
      .set({ secretEncrypted: encryptSecret(created.secret, preUpgradeKey) })
      .where(eq(schema.webhookSubscriptions.id, created.subscription.id));

    await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));

    expect(recorder.requests).toHaveLength(1);
    const delivered = recorder.requests[0]!;
    expect(delivered.url).toBe('https://receiver.test/pre-upgrade');
    expect(
      verifyWebhookSignature(
        created.secret,
        delivered.headers[WEBHOOK_TIMESTAMP_HEADER]!,
        delivered.body,
        delivered.headers[WEBHOOK_SIGNATURE_HEADER]!,
      ),
    ).toBe(true);
  });

  it('delivers a valid-signature, timestamped payload a receiver can verify', async () => {
    const { userId, id, secret } = await createSubscription(['alert.triggered']);

    const event = alertEvent(userId);
    await harness.ctx.webhookBridge.handleEvent(event);

    expect(recorder.requests).toHaveLength(1);
    const [req] = recorder.requests;
    expect(req!.url).toBe('https://receiver.test/hook');

    const signature = req!.headers[WEBHOOK_SIGNATURE_HEADER]!;
    const timestamp = req!.headers[WEBHOOK_TIMESTAMP_HEADER]!;
    expect(req!.headers[WEBHOOK_EVENT_HEADER]).toBe('alert.triggered');
    expect(req!.headers[WEBHOOK_DELIVERY_HEADER]).toBeTruthy();

    // The receiver-side check succeeds only with the real secret + exact body.
    expect(verifyWebhookSignature(secret, timestamp, req!.body, signature)).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', timestamp, req!.body, signature)).toBe(false);

    // …and only while the timestamp is fresh: the captured triple (timestamp,
    // body, signature) stops verifying once the published tolerance elapses, so
    // a receiver following the reference verifier cannot be replayed forever.
    const signedAtMs = Number(timestamp) * 1000;
    expect(
      verifyWebhookSignature(secret, timestamp, req!.body, signature, {
        now: signedAtMs + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS * 1000,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature(secret, timestamp, req!.body, signature, {
        now: signedAtMs + (WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1) * 1000,
      }),
    ).toBe(false);

    const payload = JSON.parse(req!.body) as { type: string; data: { alertId: string } };
    expect(payload.type).toBe('alert.triggered');
    expect(payload.data.alertId).toBe(event.alertId);

    // The delivery is recorded as a success in the bounded log.
    const log = webhookDeliveryListResponseSchema.parse(await deliveriesFor(id));
    expect(log.deliveries).toHaveLength(1);
    expect(log.deliveries[0]!.status).toBe('success');
    expect(log.deliveries[0]!.eventType).toBe('alert.triggered');
  });

  it('fires only for the subscribing user’s own data', async () => {
    const a = await createSubscription(['alert.triggered']);
    const b = await createSubscription(['alert.triggered']);

    // An event owned by user B must not reach user A's subscription.
    await harness.ctx.webhookBridge.handleEvent(alertEvent(b.userId));
    expect(recorder.requests).toHaveLength(1);

    const aLog = webhookDeliveryListResponseSchema.parse(await deliveriesFor(a.id));
    const bLog = webhookDeliveryListResponseSchema.parse(await deliveriesFor(b.id));
    expect(aLog.deliveries).toHaveLength(0);
    expect(bLog.deliveries).toHaveLength(1);
  });

  it('does not deliver an event type the subscription did not select', async () => {
    const { userId, id } = await createSubscription(['budget.exceeded']);
    await harness.ctx.webhookBridge.handleEvent(alertEvent(userId));
    expect(recorder.requests).toHaveLength(0);
    const log = webhookDeliveryListResponseSchema.parse(await deliveriesFor(id));
    expect(log.deliveries).toHaveLength(0);
  });

  it('skips stale portfolio events after the owner enters paranoid mode', async () => {
    const { userId, id } = await createSubscription(['dividend.event']);
    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(schema.users.id, userId));
    const event: DividendEventNotice = {
      type: 'dividend.event',
      userId,
      assetId: '00000000-0000-7000-8000-000000000003',
      symbol: 'PRIVATE',
      exDate: '2026-08-01T00:00:00.000Z',
      payDate: null,
      amount: 1,
      currency: 'EUR',
      occurredAt: new Date().toISOString(),
    };

    await harness.ctx.webhookBridge.handleEvent(event);
    expect(recorder.requests).toHaveLength(0);
    const log = webhookDeliveryListResponseSchema.parse(await deliveriesFor(id));
    expect(log.deliveries).toHaveLength(0);
  });

  it('skips stale sharing events for a paranoid recipient or sharing owner', async () => {
    const recipient = await createSubscription(['portfolio.shared', 'watchlist.shared']);
    const owner = await harness.seedUser({
      email: 'webhook-sharing-owner@bettertrack.test',
      username: 'webhook_sharing_owner',
    });
    const enqueued: WebhookDeliveryJob[] = [];
    const bridge = createWebhookBridge({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      enqueue: async (job) => {
        enqueued.push(job);
      },
      logger: harness.ctx.logger,
      paranoid: harness.ctx.paranoidGuard,
    });

    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(schema.users.id, owner.id));
    const ownerEvent: PortfolioSharedEvent = {
      type: 'portfolio.shared',
      userId: recipient.userId,
      actorId: owner.id,
      actorUsername: owner.username,
      portfolioId: '00000000-0000-7000-8000-000000000071',
      occurredAt: '2026-07-27T00:00:00.000Z',
    };
    await bridge.handleEvent(ownerEvent);

    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'normal',
        paranoidMediaSet: null,
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(schema.users.id, owner.id));
    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(schema.users.id, recipient.userId));
    const recipientEvent: WatchlistSharedEvent = {
      type: 'watchlist.shared',
      userId: recipient.userId,
      actorId: owner.id,
      actorUsername: owner.username,
      watchlistId: '00000000-0000-7000-8000-000000000072',
      occurredAt: '2026-07-27T00:00:00.000Z',
    };
    await bridge.handleEvent(recipientEvent);

    expect(enqueued).toEqual([]);
  });

  it('checks alert owner and follower before enqueueing either follow-alert webhook', async () => {
    const recipient = await createSubscription([...FOLLOW_ALERT_WEBHOOK_TYPES]);
    const owner = await harness.seedUser({
      email: 'webhook-alert-owner@bettertrack.test',
      username: 'webhook_alert_owner',
    });
    const enqueued: WebhookDeliveryJob[] = [];
    const bridge = createWebhookBridge({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      enqueue: async (job) => {
        enqueued.push(job);
      },
      logger: harness.ctx.logger,
      paranoid: harness.ctx.paranoidGuard,
    });
    const event = (type: FollowAlertEvent['type']): FollowAlertEvent => ({
      type,
      userId: recipient.userId,
      actorId: owner.id,
      actorUsername: owner.username,
      alertId: '00000000-0000-7000-8000-000000000073',
      assetId: '00000000-0000-7000-8000-000000000074',
      occurredAt: '2026-07-27T00:00:00.000Z',
    });
    const setMode = async (userId: string, privacyMode: 'normal' | 'paranoid') => {
      await harness.db
        .update(schema.users)
        .set({
          privacyMode,
          paranoidMediaSet: privacyMode === 'paranoid' ? ['drive'] : null,
          paranoidDriveAttestedVersion: privacyMode === 'paranoid' ? 1 : null,
        })
        .where(eq(schema.users.id, userId));
    };

    await setMode(owner.id, 'paranoid');
    for (const type of FOLLOW_ALERT_WEBHOOK_TYPES) await bridge.handleEvent(event(type));
    await setMode(owner.id, 'normal');
    await setMode(recipient.userId, 'paranoid');
    for (const type of FOLLOW_ALERT_WEBHOOK_TYPES) await bridge.handleEvent(event(type));

    expect(enqueued).toEqual([]);
  });

  it('checks alert owner and follower again at queued delivery for both follow-alert events', async () => {
    const delivered: string[] = [];
    const definition = {
      name: 'webhooks.deliver',
      async handler(job) {
        delivered.push(job.data.event.type);
      },
    } as JobDefinition<'webhooks.deliver'>;
    const checked: Array<{ type: string; userIds: readonly string[] }> = [];
    let pendingType = '';
    const guarded = bindParanoidJob(definition, {
      mode: 'event',
      runIfAllowed: async (userIds) => {
        checked.push({ type: pendingType, userIds });
        return false;
      },
    });

    for (const [index, type] of FOLLOW_ALERT_WEBHOOK_TYPES.entries()) {
      pendingType = type;
      const event: FollowAlertEvent = {
        type,
        userId: `follower-${index}`,
        actorId: `owner-${index}`,
        actorUsername: 'owner',
        alertId: '00000000-0000-7000-8000-000000000075',
        assetId: '00000000-0000-7000-8000-000000000076',
        occurredAt: '2026-07-27T00:00:00.000Z',
      };
      await guarded.handler(
        {
          data: {
            subscriptionId: `subscription-${index}`,
            deliveryId: `delivery-${index}`,
            event,
          },
        } as never,
        { logger: harness.ctx.logger } as never,
      );
    }

    expect(delivered).toEqual([]);
    expect(checked).toEqual(
      FOLLOW_ALERT_WEBHOOK_TYPES.map((type, index) => ({
        type,
        userIds: [`follower-${index}`, `owner-${index}`],
      })),
    );
  });

  it('drops a stale queued portfolio delivery after its target moves into a vault', async () => {
    const delivered: string[] = [];
    const checkedSubjects: string[][] = [];
    const definition = {
      name: 'webhooks.deliver',
      async handler(job) {
        delivered.push(job.data.event.type);
      },
    } as JobDefinition<'webhooks.deliver'>;
    const guarded = bindParanoidJob(definition, {
      mode: 'event',
      isEventAllowed: async (event) => event.type !== 'standing_order.skipped',
      runIfAllowed: async (userIds, action) => {
        checkedSubjects.push([...userIds]);
        await action();
        return true;
      },
    });
    const event: DomainEvent = {
      // TEST VECTOR: this is an actually subscribable payload whose portfolio
      // must be re-attributed from standingOrderId after the account lock.
      type: 'standing_order.skipped',
      userId: 'normal-owner',
      standingOrderId: '018f1412-0000-7000-8000-000000000101',
      periodKey: '2026-08-21',
      outcome: 'deferred',
      orderLabel: 'TEST VECTOR order',
      occurredAt: '2026-08-21T10:00:00.000Z',
    };

    await guarded.handler(
      {
        data: {
          subscriptionId: 'subscription-stale-vault',
          deliveryId: 'delivery-stale-vault',
          event,
        },
      } as never,
      { logger: harness.ctx.logger } as never,
    );

    expect(delivered).toEqual([]);
    // The vault re-check runs inside the subject-locked action; a pre-lock check
    // would leave a move-in race between admission and external delivery.
    expect(checkedSubjects).toEqual([['normal-owner']]);
  });

  it('checks mirror recipient, actor, owner, and affected subjects before webhook enqueue', async () => {
    const recipient = await createSubscription([...MIRROR_WEBHOOK_TYPES]);
    const actor = await harness.seedUser({
      email: 'webhook-mirror-actor@bettertrack.test',
      username: 'webhook_mirror_actor',
    });
    const owner = await harness.seedUser({
      email: 'webhook-mirror-owner@bettertrack.test',
      username: 'webhook_mirror_owner',
    });
    const subject = await harness.seedUser({
      email: 'webhook-mirror-subject@bettertrack.test',
      username: 'webhook_mirror_subject',
    });
    const enqueued: WebhookDeliveryJob[] = [];
    const bridge = createWebhookBridge({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      enqueue: async (job) => {
        enqueued.push(job);
      },
      logger: harness.ctx.logger,
      paranoid: harness.ctx.paranoidGuard,
    });
    const event = (type: MirrorNotificationEvent['type']): MirrorNotificationEvent => ({
      type,
      userId: recipient.userId,
      chainId: '00000000-0000-7000-8000-000000000081',
      chainName: 'Private chain',
      actorId: actor.id,
      ownerId: owner.id,
      subjectUserIds: [subject.id],
      actorUsername: actor.username,
      refId: `ref:${type}`,
      occurredAt: '2026-07-27T00:00:00.000Z',
    });
    const setMode = async (userId: string, privacyMode: 'normal' | 'paranoid') => {
      await harness.db
        .update(schema.users)
        .set({
          privacyMode,
          paranoidMediaSet: privacyMode === 'paranoid' ? ['drive'] : null,
          paranoidDriveAttestedVersion: privacyMode === 'paranoid' ? 1 : null,
        })
        .where(eq(schema.users.id, userId));
    };

    await setMode(actor.id, 'paranoid');
    for (const type of MIRROR_WEBHOOK_TYPES) await bridge.handleEvent(event(type));
    await setMode(actor.id, 'normal');
    await setMode(owner.id, 'paranoid');
    await bridge.handleEvent(event('mirror.invite'));
    await setMode(owner.id, 'normal');
    await setMode(subject.id, 'paranoid');
    await bridge.handleEvent(event('mirror.member_removed'));

    expect(enqueued).toEqual([]);
  });

  it('checks every mirror principal again when each queued webhook delivery runs', async () => {
    const delivered: string[] = [];
    const definition = {
      name: 'webhooks.deliver',
      async handler(job) {
        delivered.push(job.data.event.type);
      },
    } as JobDefinition<'webhooks.deliver'>;
    const checked: Array<{ type: string; userIds: readonly string[] }> = [];
    let pendingType = '';
    const guarded = bindParanoidJob(definition, {
      mode: 'event',
      runIfAllowed: async (userIds, _action) => {
        checked.push({ type: pendingType, userIds });
        return false;
      },
    });

    for (const [index, type] of MIRROR_WEBHOOK_TYPES.entries()) {
      pendingType = type;
      const event: MirrorNotificationEvent = {
        type,
        userId: `recipient-${index}`,
        chainId: '00000000-0000-7000-8000-000000000082',
        chainName: 'Queued chain',
        actorId: `actor-${index}`,
        ownerId: `owner-${index}`,
        subjectUserIds: [`subject-${index}`, `owner-${index}`],
        actorUsername: 'actor',
        refId: `queued:${index}`,
        occurredAt: '2026-07-27T00:00:00.000Z',
      };
      await guarded.handler(
        {
          data: {
            subscriptionId: `subscription-${index}`,
            deliveryId: `delivery-${index}`,
            event,
          },
        } as never,
        { logger: harness.ctx.logger } as never,
      );
    }

    expect(delivered).toEqual([]);
    expect(checked).toEqual(
      MIRROR_WEBHOOK_TYPES.map((type, index) => ({
        type,
        userIds: [`recipient-${index}`, `actor-${index}`, `owner-${index}`, `subject-${index}`],
      })),
    );
  });

  it('isolates a failed enqueue, exposes it for retry, and preserves replay delivery ids', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const ids: string[] = [];

    for (let index = 0; index < 3; index += 1) {
      const created = await agent
        .post('/api/v1/settings/webhooks')
        .set(...XRW)
        .send({ url: `https://receiver.test/hook-${index}`, eventTypes: ['alert.triggered'] });
      expect(created.status).toBe(201);
      ids.push(createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id);
    }

    const failedId = ids[1]!;
    const enqueued: WebhookDeliveryJob[] = [];
    const bridge = createWebhookBridge({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      enqueue: async (job) => {
        if (job.subscriptionId === failedId) throw new Error('queue unavailable');
        enqueued.push(job);
      },
      logger: harness.ctx.logger,
    });
    const event = alertEvent(user.id);

    await expect(bridge.handleEvent(event)).rejects.toThrow(
      'webhook bridge: 1 delivery enqueue failed',
    );
    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((job) => job.subscriptionId)).toEqual(
      expect.arrayContaining([ids[0], ids[2]]),
    );

    const replayed: WebhookDeliveryJob[] = [];
    const replayBridge = createWebhookBridge({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      enqueue: async (job) => {
        replayed.push(job);
      },
      logger: harness.ctx.logger,
    });
    await replayBridge.handleEvent(event);
    await replayBridge.handleEvent(event);

    expect(replayed).toHaveLength(6);
    for (const id of ids) {
      const deliveries = replayed.filter((job) => job.subscriptionId === id);
      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]!.deliveryId).toBe(deliveries[1]!.deliveryId);
    }
  });

  it('preserves a standing-order skip delivery id after its display label is edited', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({
        url: 'https://receiver.test/standing-order',
        eventTypes: ['standing_order.skipped'],
      });
    expect(created.status).toBe(201);

    const enqueued: WebhookDeliveryJob[] = [];
    const bridge = createWebhookBridge({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      enqueue: async (job) => {
        enqueued.push(job);
      },
      logger: harness.ctx.logger,
    });
    const event: StandingOrderSkippedEvent = {
      type: 'standing_order.skipped',
      userId: user.id,
      standingOrderId: '00000000-0000-7000-8000-000000000111',
      periodKey: '2026-08-01',
      outcome: 'deferred',
      orderLabel: 'Old label',
      occurredAt: '2026-08-01T00:00:00.000Z',
    };

    await bridge.handleEvent(event);
    await bridge.handleEvent({ ...event, orderLabel: 'Edited label' });

    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]!.event).not.toEqual(enqueued[1]!.event);
    expect(enqueued[0]!.deliveryId).toBe(enqueued[1]!.deliveryId);
  });

  /** Read the delivery log for a subscription through its owner. */
  async function deliveriesFor(id: string): Promise<unknown> {
    const owner = await harness.db
      .select({ userId: schema.webhookSubscriptions.userId })
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, id));
    // Read straight from the service (bypasses the per-test agent bookkeeping).
    const deliveries = await harness.ctx.webhooks.listDeliveries(owner[0]!.userId, id);
    return { deliveries };
  }
});

describe('failure handling: retry decision, auto-disable, re-enable', () => {
  it('is retryable on a non-final attempt (logging nothing) and terminal on the last', async () => {
    const failing = recordingTransport(500);
    const h = await createTestApp({ webhookTransport: failing.transport });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ url: 'https://down.test/hook', eventTypes: ['alert.triggered'] });
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    // Drive the dispatcher directly to exercise the multi-attempt retry decision
    // (the createTestApp seam always runs a single terminal attempt).
    const deliveries = createWebhookDeliveryRepository(h.db);
    const dispatcher = createWebhookDispatcher({
      subscriptions: createWebhookSubscriptionRepository(h.db),
      deliveries,
      transport: failing.transport,
      encryptionKey: h.ctx.config.twoFactor.encryptionKey,
      audit: noopAudit,
      logger: h.ctx.logger,
      dnsResolver: publicTestResolver,
    });

    // Attempt 1 of 3 → still retryable; nothing is written to the log yet.
    const retry = await dispatcher.deliver(
      { subscriptionId: subId, deliveryId: DELIVERY_A, event: alertEvent(user.id) },
      { attempt: 1, maxAttempts: 3 },
    );
    expect(retry.outcome).toBe('retry');
    expect(await deliveries.listForSubscription(subId, 10)).toHaveLength(0);

    // Attempt 3 of 3 → terminal; a single failed row with the attempt count.
    const terminal = await dispatcher.deliver(
      { subscriptionId: subId, deliveryId: DELIVERY_B, event: alertEvent(user.id) },
      { attempt: 3, maxAttempts: 3 },
    );
    expect(terminal.outcome).toBe('failed');
    const log = await deliveries.listForSubscription(subId, 10);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe('failed');
    expect(log[0]!.attempts).toBe(3);
  });

  it('spends the declared five attempts before a 500 receiver costs a failure', async () => {
    const failing = recordingTransport(500);
    const h = await createTestApp({ webhookTransport: failing.transport });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ url: 'https://down.test/hook', eventTypes: ['alert.triggered'] });
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    const deliveries = createWebhookDeliveryRepository(h.db);
    const job = createWebhookDeliverJob({
      dispatcher: createWebhookDispatcher({
        subscriptions: createWebhookSubscriptionRepository(h.db),
        deliveries,
        transport: failing.transport,
        encryptionKey: h.ctx.config.twoFactor.encryptionKey,
        audit: noopAudit,
        logger: h.ctx.logger,
        dnsResolver: publicTestResolver,
      }),
    });

    // The options a job enqueued with no explicit opts actually carries — the
    // queue seeding, not the constant the handler falls back to.
    const opts = jobOptionsForQueue(QUEUE_NAMES.webhooksDeliver);
    expect(opts.attempts).toBe(WEBHOOK_DELIVER_ATTEMPTS);
    // The ladder carries jitter: BullMQ's exponential backoff is otherwise
    // exactly `(2^n - 1) * delay`, so 20 subscriptions pointed at one struggling
    // receiver would retry in perfect lockstep, four synchronised bursts deep.
    expect(WEBHOOK_BACKOFF_JITTER).toBeGreaterThan(0);
    expect(opts.backoff).toEqual({
      type: 'exponential',
      delay: BACKOFF_BASE_MS,
      jitter: WEBHOOK_BACKOFF_JITTER,
    });

    const data = {
      subscriptionId: subId,
      deliveryId: DELIVERY_A,
      event: alertEvent(user.id),
    };
    // Replay BullMQ's retry loop: `attemptsMade` counts the attempts already
    // spent, so run N sees N-1.
    for (let attemptsMade = 0; attemptsMade < WEBHOOK_DELIVER_ATTEMPTS - 1; attemptsMade += 1) {
      await expect(
        job.handler({ data, opts, attemptsMade } as never, {} as never),
      ).rejects.toBeInstanceOf(WebhookDeliveryRetryError);
      // Nothing terminal is recorded while retries remain.
      expect(await deliveries.listForSubscription(subId, 10)).toHaveLength(0);
    }
    const stillHealthy = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(stillHealthy.subscriptions[0]!.consecutiveFailures).toBe(0);

    // The fifth attempt is terminal: one failed row, one failure on the streak.
    await job.handler(
      { data, opts, attemptsMade: WEBHOOK_DELIVER_ATTEMPTS - 1 } as never,
      {} as never,
    );
    const log = await deliveries.listForSubscription(subId, 10);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe('failed');
    expect(log[0]!.attempts).toBe(WEBHOOK_DELIVER_ATTEMPTS);
    expect(failing.requests).toHaveLength(WEBHOOK_DELIVER_ATTEMPTS);

    const afterList = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(afterList.subscriptions[0]!.consecutiveFailures).toBe(1);
    // Five attempts cost one failure, not five: the subscription stays enabled.
    expect(afterList.subscriptions[0]!.enabled).toBe(true);
  });

  it('auto-disables after N consecutive failures, records + audits it, and re-enables manually', async () => {
    const failing = recordingTransport(500);
    const h = await createTestApp({ webhookTransport: failing.transport });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ url: 'https://down.test/hook', eventTypes: ['alert.triggered'] });
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    // Each fire is one terminal failure (test seam runs a single attempt).
    for (let i = 0; i < WEBHOOK_AUTO_DISABLE_THRESHOLD; i += 1) {
      await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));
    }

    // The subscription is now disabled with an 'auto' reason — visible in the API.
    const afterList = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(afterList.subscriptions[0]!.enabled).toBe(false);
    expect(afterList.subscriptions[0]!.disabledReason).toBe('auto');
    expect(afterList.subscriptions[0]!.consecutiveFailures).toBe(WEBHOOK_AUTO_DISABLE_THRESHOLD);

    // The disable is audit-logged.
    const actions = (
      await h.db.select({ action: schema.auditLog.action }).from(schema.auditLog)
    ).map((r) => r.action);
    expect(actions).toContain('webhook.auto_disabled');

    // A disabled subscription stops delivering entirely.
    failing.requests.length = 0;
    await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));
    expect(failing.requests).toHaveLength(0);

    // Manual re-enable clears the failure state.
    const reenabled = await agent
      .patch(`/api/v1/settings/webhooks/${subId}`)
      .set(...XRW)
      .send({ enabled: true });
    expect(reenabled.status).toBe(200);
    expect(reenabled.body.subscription.enabled).toBe(true);
    expect(reenabled.body.subscription.disabledReason).toBeNull();
    expect(reenabled.body.subscription.consecutiveFailures).toBe(0);

    // And it delivers again.
    await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));
    expect(failing.requests).toHaveLength(1);
  });

  it('counts an undecryptable secret toward auto-disable', async () => {
    const { agent, id, userId } = await createSubscription(['alert.triggered']);
    const deliveries = createWebhookDeliveryRepository(harness.db);
    const dispatcher = createWebhookDispatcher({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      deliveries,
      transport: recorder.transport,
      encryptionKey: Buffer.alloc(32, 0xff),
      audit: noopAudit,
      logger: harness.ctx.logger,
      dnsResolver: publicTestResolver,
    });

    for (let index = 0; index < WEBHOOK_AUTO_DISABLE_THRESHOLD; index += 1) {
      const result = await dispatcher.deliver(
        {
          subscriptionId: id,
          deliveryId: `00000000-0000-8000-8000-${String(index + 1).padStart(12, '0')}`,
          event: alertEvent(userId),
        },
        { attempt: 1, maxAttempts: 1 },
      );
      expect(result.outcome).toBe(
        index === WEBHOOK_AUTO_DISABLE_THRESHOLD - 1 ? 'disabled' : 'failed',
      );
    }

    const afterList = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(afterList.subscriptions[0]!.enabled).toBe(false);
    expect(afterList.subscriptions[0]!.disabledReason).toBe('auto');
    expect(afterList.subscriptions[0]!.consecutiveFailures).toBe(WEBHOOK_AUTO_DISABLE_THRESHOLD);

    const log = await deliveries.listForSubscription(id, WEBHOOK_AUTO_DISABLE_THRESHOLD);
    expect(log).toHaveLength(WEBHOOK_AUTO_DISABLE_THRESHOLD);
    expect(log.every((delivery) => delivery.error === WEBHOOK_DELIVERY_SECRET_ERROR)).toBe(true);
  });

  it('classifies which receiver answers are worth retrying', () => {
    // An allowlist, not "every 4xx": the answer must be one that cannot change.
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(isPermanentWebhookStatus(status)).toBe(true);
      expect(WEBHOOK_PERMANENT_RESPONSE_STATUSES).toContain(status);
    }
    // A throttled, timed-out or broken receiver is exactly what backoff is for.
    for (const status of [408, 425, 429, 500, 502, 503, 504, null]) {
      expect(isPermanentWebhookStatus(status)).toBe(false);
    }
  });

  it('spends one attempt on a permanently-refused delivery and the full ladder on a 429', async () => {
    const gone = recordingTransport(410);
    const h = await createTestApp({ webhookTransport: gone.transport });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ url: 'https://gone.test/hook', eventTypes: ['alert.triggered'] });
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    const deliveries = createWebhookDeliveryRepository(h.db);
    const dispatcherFor = (transport: WebhookTransport) =>
      createWebhookDispatcher({
        subscriptions: createWebhookSubscriptionRepository(h.db),
        deliveries,
        transport,
        encryptionKey: h.ctx.config.twoFactor.encryptionKey,
        audit: noopAudit,
        logger: h.ctx.logger,
        dnsResolver: publicTestResolver,
      });

    // Attempt 1 of 5. A deleted receiver route answers the same thing every
    // time, so the ladder ends here: ONE signed POST, not five per event.
    const refused = await dispatcherFor(gone.transport).deliver(
      { subscriptionId: subId, deliveryId: DELIVERY_A, event: alertEvent(user.id) },
      { attempt: 1, maxAttempts: WEBHOOK_DELIVER_ATTEMPTS },
    );
    expect(refused.outcome).toBe('failed');
    expect(gone.requests).toHaveLength(1);

    // Still recorded as a failure WITH its status: the early stop must not
    // weaken the auto-disable streak.
    const log = await deliveries.listForSubscription(subId, 10);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe('failed');
    expect(log[0]!.attempts).toBe(1);
    expect(log[0]!.responseStatus).toBe(410);
    expect(log[0]!.error).toBe('HTTP 410');
    const afterRefusal = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(afterRefusal.subscriptions[0]!.consecutiveFailures).toBe(1);
    expect(afterRefusal.subscriptions[0]!.enabled).toBe(true);

    // A 429 says "later", not "never" — it still consumes the ladder.
    const throttled = recordingTransport(429);
    const retry = await dispatcherFor(throttled.transport).deliver(
      { subscriptionId: subId, deliveryId: DELIVERY_B, event: alertEvent(user.id) },
      { attempt: 1, maxAttempts: WEBHOOK_DELIVER_ATTEMPTS },
    );
    expect(retry.outcome).toBe('retry');
    expect(retry.status).toBe(429);
    // Nothing terminal recorded while retries remain.
    expect(await deliveries.listForSubscription(subId, 10)).toHaveLength(1);
  });

  it('drops a queued delivery whose event type the subscription no longer lists', async () => {
    const sending = recordingTransport(200);
    const h = await createTestApp({ webhookTransport: sending.transport });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({
        url: 'https://receiver.test/hook',
        eventTypes: ['alert.triggered', 'friend.request'],
      });
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    const deliveries = createWebhookDeliveryRepository(h.db);
    const job = createWebhookDeliverJob({
      dispatcher: createWebhookDispatcher({
        subscriptions: createWebhookSubscriptionRepository(h.db),
        deliveries,
        transport: sending.transport,
        encryptionKey: h.ctx.config.twoFactor.encryptionKey,
        audit: noopAudit,
        logger: h.ctx.logger,
        dnsResolver: publicTestResolver,
      }),
    });

    // The delivery was queued while the subscription still carried the type…
    const data = { subscriptionId: subId, deliveryId: DELIVERY_A, event: alertEvent(user.id) };
    // …and the owner revokes that type before the queue gets to it.
    const patched = await agent
      .patch(`/api/v1/settings/webhooks/${subId}`)
      .set(...XRW)
      .send({ eventTypes: ['friend.request'] });
    expect(patched.status).toBe(200);

    await job.handler(
      {
        data,
        opts: jobOptionsForQueue(QUEUE_NAMES.webhooksDeliver),
        attemptsMade: 0,
      } as never,
      {} as never,
    );

    // The revoked endpoint never sees the event…
    expect(sending.requests).toHaveLength(0);
    // …and the log says why, rather than leaving the delivery unaccounted for.
    const log = await deliveries.listForSubscription(subId, 10);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe('failed');
    expect(log[0]!.responseStatus).toBeNull();
    expect(log[0]!.error).toBe(WEBHOOK_DELIVERY_UNSUBSCRIBED_ERROR);

    // The owner's own change is not a receiver failure: the streak stays put.
    const after = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(after.subscriptions[0]!.consecutiveFailures).toBe(0);
    expect(after.subscriptions[0]!.enabled).toBe(true);
  });

  it('flips a failed row to success when the replayed delivery finally lands', async () => {
    // The bridge derives the delivery id from the logical event, so replaying
    // the same event re-uses the row an earlier attempt already failed.
    let status = 500;
    const requests: RecordedRequest[] = [];
    const flaky: WebhookTransport = {
      async send(req) {
        requests.push(req);
        return { ok: status >= 200 && status < 300, status };
      },
    };
    const h = await createTestApp({ webhookTransport: flaky });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ url: 'https://flaky.test/hook', eventTypes: ['alert.triggered'] });
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    const event = alertEvent(user.id);
    await h.ctx.webhookBridge.handleEvent(event);

    const deliveries = createWebhookDeliveryRepository(h.db);
    const failedLog = await deliveries.listForSubscription(subId, 10);
    expect(failedLog).toHaveLength(1);
    expect(failedLog[0]!.status).toBe('failed');
    const deliveryId = failedLog[0]!.id;

    // Same logical event, re-enqueued (the notifications job retries the whole
    // fan-out when one subscription's enqueue failed) — and this time it lands.
    status = 200;
    await h.ctx.webhookBridge.handleEvent(event);

    const healedLog = await deliveries.listForSubscription(subId, 10);
    expect(healedLog).toHaveLength(1);
    expect(healedLog[0]!.id).toBe(deliveryId);
    expect(healedLog[0]!.status).toBe('success');
    expect(healedLog[0]!.responseStatus).toBe(200);
    expect(healedLog[0]!.error).toBeNull();

    // …and the subscription is stamped as delivered, not left looking dead.
    const after = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(after.subscriptions[0]!.consecutiveFailures).toBe(0);
    expect(after.subscriptions[0]!.lastSuccessAt).not.toBeNull();
    expect(after.subscriptions[0]!.lastDeliveryAt).not.toBeNull();
  });
});

describe('delivery-log retention', () => {
  it('the cleanup job prunes deliveries older than the retention window', async () => {
    const { id } = await createSubscription(['alert.triggered']);
    const deliveries = createWebhookDeliveryRepository(harness.db);

    const old = new Date(Date.now() - (WEBHOOK_DELIVERY_RETENTION_DAYS + 10) * MS_PER_DAY);
    const fresh = new Date();
    await deliveries.record({
      id: '00000000-0000-7000-8000-0000000000f1',
      subscriptionId: id,
      eventType: 'alert.triggered',
      status: 'success',
      responseStatus: 200,
      attempts: 1,
      error: null,
      createdAt: old,
    });
    await deliveries.record({
      id: '00000000-0000-7000-8000-0000000000f2',
      subscriptionId: id,
      eventType: 'alert.triggered',
      status: 'success',
      responseStatus: 200,
      attempts: 1,
      error: null,
      createdAt: fresh,
    });

    const job = createWebhookDeliveryCleanupJob({ deliveries });
    await job.handler({} as never, { logger: harness.ctx.logger } as never);

    const remaining = await deliveries.listForSubscription(id, 100);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe('00000000-0000-7000-8000-0000000000f2');
  });

  it('drains more rows than one batch holds without an unbounded delete', async () => {
    const { id } = await createSubscription(['alert.triggered']);
    const deliveries = createWebhookDeliveryRepository(harness.db);
    const old = new Date(Date.now() - (WEBHOOK_DELIVERY_RETENTION_DAYS + 10) * MS_PER_DAY);

    for (let index = 0; index < 5; index += 1) {
      await deliveries.record({
        id: `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`,
        subscriptionId: id,
        eventType: 'alert.triggered',
        status: 'failed',
        responseStatus: 500,
        attempts: WEBHOOK_DELIVER_ATTEMPTS,
        error: 'down',
        createdAt: new Date(old.getTime() + index * 1000),
      });
    }
    await deliveries.record({
      id: '00000000-0000-7000-8000-000000000199',
      subscriptionId: id,
      eventType: 'alert.triggered',
      status: 'success',
      responseStatus: 200,
      attempts: 1,
      error: null,
      createdAt: new Date(),
    });

    const deleteOlderThan = vi.spyOn(deliveries, 'deleteOlderThan');
    const job = createWebhookDeliveryCleanupJob({ deliveries, batchSize: 2 });
    await job.handler({} as never, { logger: harness.ctx.logger } as never);

    // Three bounded statements (2 + 2 + the short batch that proves convergence),
    // never one DELETE over the whole eligible range.
    expect(deleteOlderThan.mock.calls.map(([, limit]) => limit)).toEqual([2, 2, 2]);
    const remaining = await deliveries.listForSubscription(id, 100);
    expect(remaining.map((row) => row.id)).toEqual(['00000000-0000-7000-8000-000000000199']);
  });
});

describe('subscribable catalog', () => {
  it('matches the user-scoped dispatchable domain events (no drift)', () => {
    // Every catalog type is a dispatchable (user-scoped, userId-bearing) event…
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(DISPATCHABLE_EVENT_TYPES).toContain(type);
    }
    // …and every dispatchable event is subscribable — the sets are identical.
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual([...DISPATCHABLE_EVENT_TYPES].sort());
  });

  it('exhaustively classifies the catalog and derives the paranoid registry decision', () => {
    expect(Object.keys(PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS)).toEqual([
      ...WEBHOOK_EVENT_TYPES,
    ]);

    for (const type of WEBHOOK_EVENT_TYPES) {
      const classification = PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS[type];
      expect(classification.reason.trim(), `${type} needs a rationale`).not.toBe('');
      expect(classification.reason, `${type} rationale must stay on one line`).not.toMatch(
        /[\r\n]/,
      );
      expect(isParanoidKilledWebhookEvent({ type } as DomainEvent), type).toBe(
        classification.disposition === 'killed',
      );
    }

    // Both the SPA and the API registry consume this record-derived projection.
    const killedByRegistry = WEBHOOK_EVENT_TYPES.filter((type) =>
      isParanoidKilledWebhookEvent({ type } as DomainEvent),
    );
    expect(killedByRegistry).toHaveLength(19);
    expect([...PARANOID_KILLED_WEBHOOK_EVENT_TYPES].sort()).toEqual([...killedByRegistry].sort());
    // V5-P8 comments hang off shared items, and paranoid sharing is disabled.
    expect(PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS['comment.created'].disposition).toBe(
      'killed',
    );
    expect(PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS['feedback.status_changed'].disposition).toBe(
      'allowed',
    );
    expect(PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS['feedback.reply_created'].disposition).toBe(
      'allowed',
    );
    // `portfolio.changed` is killed by the registry but is not subscribable, so
    // the contracts list is a strict subset of the registry union by design.
    expect(isParanoidKilledWebhookEvent({ type: 'portfolio.changed' } as DomainEvent)).toBe(true);
    expect(WEBHOOK_EVENT_TYPES as readonly string[]).not.toContain('portfolio.changed');
  });

  it('returns false for a webhook event type outside the current catalog', () => {
    expect(isParanoidKilledWebhookEventType('future.unknown')).toBe(false);
    expect(isParanoidKilledWebhookEventType('constructor')).toBe(false);
    expect(isParanoidKilledWebhookEventType('toString')).toBe(false);
    expect(isParanoidKilledWebhookEventType('__proto__')).toBe(false);
  });
});

/**
 * Payload disclosure (§13.5 V5-P10). A delivery body is a per-type ALLOWLIST
 * projection of the domain event, never the event itself: the runtime event
 * carries private message text and other accounts' internal ids, and a receiver
 * URL may legitimately be plain `http:`. The contract
 * ({@link WEBHOOK_EVENT_PAYLOAD_SCHEMAS}) declares each type's disclosure, and
 * every schema is strict — so a field nobody decided to publish cannot ride
 * along.
 *
 * These deliveries run through the dispatcher directly (a real subscription, a
 * real secret, the real signing path). The bridge's separate vaulted-portfolio
 * attribution would otherwise require chain/portfolio/holding rows for a third
 * of the catalog, and it is not what composes the body.
 */
describe('delivered payload: the per-type disclosure allowlist', () => {
  /** Every field the allowlist drops carries this marker in the sample events. */
  const LEAK = 'disclosure-leak';
  const OTHER_ACCOUNT = '00000000-0000-7000-8000-00000000feed';
  const OTHER_OWNER = '00000000-0000-7000-8000-00000000fee1';
  const OTHER_SUBJECT = '00000000-0000-7000-8000-00000000fee2';

  function directDispatcher(transport: WebhookTransport) {
    return createWebhookDispatcher({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      deliveries: createWebhookDeliveryRepository(harness.db),
      transport,
      encryptionKey: harness.ctx.config.twoFactor.encryptionKey,
      audit: noopAudit,
      logger: harness.ctx.logger,
      dnsResolver: publicTestResolver,
    });
  }

  /** A representative event for `type`, with a marker in every droppable field. */
  function sampleEvent(type: WebhookEventType, userId: string): DomainEvent {
    const occurredAt = '2026-08-01T00:00:00.000Z';
    const base = { userId, occurredAt } as const;
    const actor = { actorId: OTHER_ACCOUNT, actorUsername: 'other_account' } as const;
    if (type.startsWith('mirror.')) {
      return {
        ...base,
        type: type as MirrorNotificationEvent['type'],
        chainId: '00000000-0000-7000-8000-000000000301',
        chainName: 'Household chain',
        actorId: OTHER_ACCOUNT,
        ownerId: OTHER_OWNER,
        subjectUserIds: [OTHER_SUBJECT],
        actorUsername: 'other_account',
        refId: '00000000-0000-7000-8000-000000000302',
      };
    }
    switch (type) {
      case 'alert.triggered':
        return { ...base, type, alertId: 'alert-1', assetId: 'asset-1' };
      case 'friend.request':
      case 'friend.accepted':
        return { ...base, type, ...actor, requestId: 'request-1' };
      case 'portfolio.shared':
        return { ...base, type, ...actor, portfolioId: 'portfolio-1' };
      case 'watchlist.shared':
        return { ...base, type, ...actor, watchlistId: 'watchlist-1' };
      case 'conglomerate.shared':
        return { ...base, type, ...actor, conglomerateId: 'conglomerate-1' };
      case 'friend.activity':
        return {
          ...base,
          type,
          ...actor,
          itemKind: 'watchlist',
          itemId: 'watchlist-1',
          activity: 'buy',
          assetSymbol: 'AAPL',
          refId: `${LEAK}-transaction`,
        };
      case 'follow.published':
        return {
          ...base,
          type,
          ...actor,
          itemKind: 'portfolio',
          itemId: 'portfolio-1',
          itemName: 'Retirement',
        };
      case 'follow.alert.created':
      case 'follow.alert.fired':
        return { ...base, type, ...actor, alertId: 'alert-1', assetId: 'asset-1' };
      case 'account.temp_password':
      case 'account.data_export':
        return { ...base, type };
      case 'earnings.reminder':
        return {
          ...base,
          type,
          assetId: 'asset-1',
          symbol: 'AAPL',
          name: `${LEAK}-company-name`,
          earningsDate: '2026-08-15',
          estimated: false,
        };
      case 'chat.message':
        return {
          ...base,
          type,
          senderId: OTHER_ACCOUNT,
          senderUsername: 'other_account',
          conversationId: 'conversation-1',
          messageId: 'message-1',
          bodyPreview: `${LEAK}-private message text`,
          hasChip: false,
        };
      case 'dividend.event':
        return {
          ...base,
          type,
          assetId: 'asset-1',
          symbol: 'AAPL',
          exDate: '2026-08-10',
          payDate: '2026-08-20',
          amount: 0.24,
          currency: 'USD',
        };
      case 'budget.exceeded':
        return {
          ...base,
          type,
          budgetId: 'budget-1',
          categoryId: 'tag-1',
          categoryName: `${LEAK}-category`,
          portfolioId: 'portfolio-1',
          period: '2026-08',
          amount: 100,
          spent: 140,
          currency: 'EUR',
        };
      case 'standing_order.skipped':
        return {
          ...base,
          type,
          standingOrderId: 'standing-order-1',
          periodKey: '2026-08-01',
          outcome: 'dropped',
          // Exercised so the sweep below sees every declared field, optional
          // ones included.
          droppedCount: 3,
          orderLabel: `${LEAK}-order-label`,
        };
      case 'feedback.status_changed':
        return {
          ...base,
          type,
          feedbackId: 'feedback-1',
          status: 'triaged',
          lastStatusChangeAt: occurredAt,
        };
      case 'feedback.reply_created':
        return { ...base, type, feedbackId: 'feedback-1', messageId: 'message-1' };
      case 'comment.created':
        return {
          ...base,
          type,
          ...actor,
          itemKind: 'idea',
          itemId: 'idea-1',
          itemName: 'My idea',
          commentId: 'comment-1',
        };
      default:
        throw new Error(`no sample event for ${type}`);
    }
  }

  it('delivers all 28 catalog types, each validating against its declared schema', async () => {
    const { userId, id, secret } = await createSubscription([...WEBHOOK_EVENT_TYPES]);
    const dispatcher = directDispatcher(recorder.transport);

    for (const [index, type] of WEBHOOK_EVENT_TYPES.entries()) {
      const result = await dispatcher.deliver(
        {
          subscriptionId: id,
          deliveryId: `00000000-0000-7000-8000-0000000002${index.toString(16).padStart(2, '0')}`,
          event: sampleEvent(type, userId),
        },
        { attempt: 1, maxAttempts: 1 },
      );
      expect(result.outcome, type).toBe('delivered');
    }

    // Every type still delivers — this narrows payloads, it does not drop events.
    expect(recorder.requests).toHaveLength(WEBHOOK_EVENT_TYPES.length);

    for (const [index, type] of WEBHOOK_EVENT_TYPES.entries()) {
      const req = recorder.requests[index]!;
      expect(req.headers[WEBHOOK_EVENT_HEADER], type).toBe(type);

      // The signature still covers the exact bytes sent, inside the published
      // replay window (#1702) and nowhere outside it.
      const timestamp = req.headers[WEBHOOK_TIMESTAMP_HEADER]!;
      const signature = req.headers[WEBHOOK_SIGNATURE_HEADER]!;
      const signedAtMs = Number(timestamp) * 1000;
      expect(verifyWebhookSignature(secret, timestamp, req.body, signature), type).toBe(true);
      expect(
        verifyWebhookSignature(secret, timestamp, req.body, signature, {
          now: signedAtMs + (WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1) * 1000,
        }),
        type,
      ).toBe(false);

      // Strict per-type parse: the body carries every declared field and NO
      // field outside the type's allowlist.
      const parsed = webhookEventPayloadSchema.parse(JSON.parse(req.body));
      expect(parsed.type, type).toBe(type);
      expect(Object.keys(parsed.data).sort(), type).toEqual(
        Object.keys(WEBHOOK_EVENT_PAYLOAD_SCHEMAS[type].shape).sort(),
      );
      // Nothing the allowlist drops rode along.
      expect(req.body, type).not.toContain(LEAK);
    }
  });

  it('never puts the chat message text on the wire', async () => {
    const { userId, id } = await createSubscription(['chat.message']);
    const messageText = 'IBAN AT61 1904 3002 3457 3201 — do not publish this';

    // Through the bridge: subscribe, emit, inspect what the receiver got.
    await harness.ctx.webhookBridge.handleEvent({
      type: 'chat.message',
      userId,
      senderId: OTHER_ACCOUNT,
      senderUsername: 'other_account',
      conversationId: '00000000-0000-7000-8000-000000000401',
      messageId: '00000000-0000-7000-8000-000000000402',
      bodyPreview: messageText,
      hasChip: false,
      occurredAt: '2026-08-01T00:00:00.000Z',
    });

    expect(recorder.requests).toHaveLength(1);
    const body = recorder.requests[0]!.body;
    expect(body).not.toContain(messageText);
    expect(body).not.toContain('IBAN');
    expect(body).not.toContain('bodyPreview');
    const parsed = webhookEventPayloadSchema.parse(JSON.parse(body));
    expect(parsed).toEqual({
      id: expect.any(String),
      type: 'chat.message',
      createdAt: '2026-08-01T00:00:00.000Z',
      data: {
        userId,
        conversationId: '00000000-0000-7000-8000-000000000401',
        messageId: '00000000-0000-7000-8000-000000000402',
        senderId: OTHER_ACCOUNT,
        senderUsername: 'other_account',
      },
    });
    expect((await deliveriesForSubscription(id)).length).toBe(1);
  });

  it('never puts another account’s uuid on the wire for a mirror notice', async () => {
    const { userId, id } = await createSubscription([...MIRROR_WEBHOOK_TYPES]);
    const manager = await harness.seedUser({
      email: 'webhook-mirror-manager@bettertrack.test',
      username: 'webhook_mirror_manager',
    });
    const dispatcher = directDispatcher(recorder.transport);

    for (const [index, type] of MIRROR_WEBHOOK_TYPES.entries()) {
      const event: MirrorNotificationEvent = {
        type,
        userId,
        chainId: '00000000-0000-7000-8000-000000000501',
        chainName: 'Household chain',
        actorId: manager.id,
        ownerId: manager.id,
        subjectUserIds: [manager.id],
        actorUsername: manager.username,
        refId: '00000000-0000-7000-8000-000000000502',
        occurredAt: '2026-08-01T00:00:00.000Z',
      };
      await dispatcher.deliver(
        {
          subscriptionId: id,
          deliveryId: `00000000-0000-7000-8000-0000000005${index.toString(16).padStart(2, '0')}`,
          event,
        },
        { attempt: 1, maxAttempts: 1 },
      );
    }

    expect(recorder.requests).toHaveLength(MIRROR_WEBHOOK_TYPES.length);
    for (const req of recorder.requests) {
      expect(req.body).not.toContain(manager.id);
      expect(req.body).not.toContain('actorId');
      expect(req.body).not.toContain('ownerId');
      expect(req.body).not.toContain('subjectUserIds');
    }
  });

  it('names a comment’s author by username only, never by account id', async () => {
    const { userId, id } = await createSubscription(['comment.created']);
    const author = await harness.seedUser({
      email: 'webhook-comment-author@bettertrack.test',
      username: 'webhook_comment_author',
    });

    await directDispatcher(recorder.transport).deliver(
      {
        subscriptionId: id,
        deliveryId: '00000000-0000-7000-8000-000000000601',
        event: {
          type: 'comment.created',
          userId,
          actorId: author.id,
          actorUsername: author.username,
          itemKind: 'conglomerate',
          itemId: '00000000-0000-7000-8000-000000000602',
          itemName: 'Dividend basket',
          commentId: '00000000-0000-7000-8000-000000000603',
          occurredAt: '2026-08-01T00:00:00.000Z',
        },
      },
      { attempt: 1, maxAttempts: 1 },
    );

    const body = recorder.requests[0]!.body;
    expect(body).not.toContain('actorId');
    expect(body).not.toContain(author.id);
    expect(webhookEventPayloadSchema.parse(JSON.parse(body)).data).toEqual({
      userId,
      commentId: '00000000-0000-7000-8000-000000000603',
      itemKind: 'conglomerate',
      itemId: '00000000-0000-7000-8000-000000000602',
      itemName: 'Dividend basket',
      actorUsername: author.username,
    });
  });

  /** Delivery-log rows for a subscription, read straight from the service. */
  async function deliveriesForSubscription(id: string) {
    const owner = await harness.db
      .select({ userId: schema.webhookSubscriptions.userId })
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, id));
    return harness.ctx.webhooks.listDeliveries(owner[0]!.userId, id);
  }
});

/**
 * Queue fairness (§13.5 V5-P10). One global FIFO carries every user's
 * deliveries, and a black-holed receiver holds its slot for the full transport
 * timeout on each attempt. The delivery job therefore declares its own worker
 * concurrency and rate limiter instead of inheriting BullMQ's default of 1.
 */
describe('delivery-queue fairness', () => {
  const stalledJob = (subscriptionId: string, userId: string): WebhookDeliveryJob => ({
    subscriptionId,
    deliveryId: '00000000-0000-7000-8000-000000000701',
    event: alertEvent(userId),
  });

  it('declares an explicit concurrency and rate limiter on the delivery worker', () => {
    const definition = createWebhookDeliverJob({
      dispatcher: { deliver: async () => ({ outcome: 'skipped', status: null }) },
    });

    // Not BullMQ's implicit global FIFO of 1 — a future refactor that drops
    // these back to the default fails here.
    expect(WEBHOOK_DELIVER_CONCURRENCY).toBeGreaterThan(1);
    expect(definition.workerOptions?.concurrency).toBe(WEBHOOK_DELIVER_CONCURRENCY);
    expect(definition.workerOptions?.limiter).toEqual(WEBHOOK_DELIVER_LIMITER);
  });

  it('processes another user’s delivery while a black-holed receiver stalls', async () => {
    const stalling = await createSubscription(['alert.triggered'], 'https://black-hole.test/hook');
    const healthy = await createSubscription(['alert.triggered'], 'https://healthy.test/hook');

    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    const transport: WebhookTransport = {
      async send(req) {
        // The black hole accepts the connection and never answers, exactly like
        // a receiver that burns the full transport timeout.
        if (req.url.includes('black-hole')) await blocked;
        delivered.push(req.url);
        return { ok: true, status: 200 };
      },
    };
    const dispatcher = createWebhookDispatcher({
      subscriptions: createWebhookSubscriptionRepository(harness.db),
      deliveries: createWebhookDeliveryRepository(harness.db),
      transport,
      encryptionKey: harness.ctx.config.twoFactor.encryptionKey,
      audit: noopAudit,
      logger: harness.ctx.logger,
      dnsResolver: publicTestResolver,
    });

    // The worker loop BullMQ runs: one shared FIFO drained by `concurrency`
    // slots (`jobs/worker.ts` passes `workerOptions` straight through).
    const runQueue = (jobs: WebhookDeliveryJob[], concurrency: number): Promise<unknown> => {
      const pending = [...jobs];
      return Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (let job = pending.shift(); job; job = pending.shift()) {
            await dispatcher.deliver(job, { attempt: 1, maxAttempts: 1 });
          }
        }),
      );
    };

    const jobs = [
      stalledJob(stalling.id, stalling.userId),
      {
        subscriptionId: healthy.id,
        deliveryId: '00000000-0000-7000-8000-000000000702',
        event: alertEvent(healthy.userId),
      },
    ];

    const declared = runQueue(jobs, WEBHOOK_DELIVER_CONCURRENCY);
    // The healthy receiver is served while the black hole is still hanging.
    await vi.waitFor(() => expect(delivered).toContain('https://healthy.test/hook'));

    // …which is exactly what the previous single-slot default could not do.
    const single = runQueue(
      [
        {
          subscriptionId: stalling.id,
          deliveryId: '00000000-0000-7000-8000-000000000703',
          event: { ...alertEvent(stalling.userId), alertId: 'alert-2' },
        },
        {
          subscriptionId: healthy.id,
          deliveryId: '00000000-0000-7000-8000-000000000704',
          event: { ...alertEvent(healthy.userId), alertId: 'alert-2' },
        },
      ],
      1,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivered.filter((url) => url === 'https://healthy.test/hook')).toHaveLength(1);

    release();
    await declared;
    await single;
    expect(delivered.filter((url) => url === 'https://black-hole.test/hook')).toHaveLength(2);
    expect(delivered.filter((url) => url === 'https://healthy.test/hook')).toHaveLength(2);
  });
});

/**
 * Outbound safety (PROJECTPLAN.md §8) for the one user-supplied URL in the
 * product. The destination is guarded at create/update AND re-resolved on every
 * delivery attempt, so neither a literal internal address nor a hostname that
 * rebinds after creation can turn a subscription into a blind-SSRF probe of the
 * deployment. Plain http and RFC1918 LAN receivers stay allowed — that is the
 * self-hosted case the contract records.
 */
describe('destination guard: user-supplied webhook URLs cannot reach the deployment', () => {
  const loopbackResolver: OutboundUrlResolver = async () => [{ address: '127.0.0.1', family: 4 }];

  async function postSubscription(agent: Agent, url: string) {
    return agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ url, eventTypes: ['alert.triggered'] });
  }

  it.each([
    ['IPv4 loopback', 'http://127.0.0.1:3000/api/health'],
    ['loopback by name', 'http://localhost:3000/api/health'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]:3000/api/health'],
    ['unspecified address', 'http://0.0.0.0:8080/hook'],
    ['broadcast address', 'http://255.255.255.255/hook'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/hook'],
  ])('refuses %s at create and writes no row', async (_label, url) => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await postSubscription(agent, url);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(WEBHOOK_URL_BLOCKED_CODE);

    const list = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(list.subscriptions).toHaveLength(0);
    expect(await harness.db.select().from(schema.webhookSubscriptions)).toHaveLength(0);
  });

  it('refuses a hostname that resolves to loopback at create time', async () => {
    const h = await createTestApp({ webhookUrlResolver: loopbackResolver });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);

    const res = await postSubscription(agent, 'https://rebind.test/hook');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(WEBHOOK_URL_BLOCKED_CODE);
    expect(await h.db.select().from(schema.webhookSubscriptions)).toHaveLength(0);
  });

  it('still accepts a plain-http RFC1918 LAN receiver', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await postSubscription(agent, 'http://192.168.1.50:9000/hook');
    expect(res.status).toBe(201);
    expect(createWebhookSubscriptionResponseSchema.parse(res.body).subscription.url).toBe(
      'http://192.168.1.50:9000/hook',
    );
  });

  it('refuses an update to a blocked destination and leaves the stored URL intact', async () => {
    const { agent, id } = await createSubscription(['alert.triggered']);

    const res = await agent
      .patch(`/api/v1/settings/webhooks/${id}`)
      .set(...XRW)
      .send({ url: 'http://127.0.0.1:3000/api/health' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(WEBHOOK_URL_BLOCKED_CODE);

    const list = webhookSubscriptionListResponseSchema.parse(
      (await agent.get('/api/v1/settings/webhooks')).body,
    );
    expect(list.subscriptions[0]!.url).toBe('https://receiver.test/hook');
  });

  it('refuses at DELIVERY a host that was public at create time and now rebinds', async () => {
    let rebound = false;
    const rebinding: OutboundUrlResolver = async () =>
      rebound ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
    const delivering = recordingTransport(200);
    const h = await createTestApp({
      webhookTransport: delivering.transport,
      webhookUrlResolver: rebinding,
    });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await postSubscription(agent, 'https://rebind.test/hook');
    expect(created.status).toBe(201);
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    // Public at create time → the first delivery goes out normally.
    await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));
    expect(delivering.requests).toHaveLength(1);

    // The hostname now points at loopback: the next attempt is refused BEFORE
    // anything is signed or sent, proving the check is re-resolved per attempt.
    rebound = true;
    await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));
    expect(delivering.requests).toHaveLength(1);

    const log = await h.ctx.webhooks.listDeliveries(user.id, subId);
    expect(log).toHaveLength(2);
    const refused = log.find((delivery) => delivery.status === 'failed');
    expect(refused).toBeDefined();
    expect(refused!.responseStatus).toBeNull();
    expect(refused!.error).toBe(WEBHOOK_DELIVERY_REFUSED_ERROR);
  });

  it('pins the address the guard vetted into the delivery the transport sends', async () => {
    // The guard's answer only helps if the socket uses it. The dispatcher must
    // resolve once per attempt and hand those addresses to the transport, which
    // pins them — otherwise the transport's own lookup could land elsewhere.
    const resolver = vi.fn(publicTestResolver);
    const delivering = recordingTransport(200);
    const h = await createTestApp({
      webhookTransport: delivering.transport,
      webhookUrlResolver: resolver,
    });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    expect((await postSubscription(agent, 'https://receiver.test/hook')).status).toBe(201);
    const resolutionsAtCreate = resolver.mock.calls.length;

    await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));

    expect(delivering.requests).toHaveLength(1);
    const delivered = delivering.requests[0]!;
    // Exactly one resolution for the attempt — the vetted one, not one of two.
    expect(resolver.mock.calls.length - resolutionsAtCreate).toBe(1);
    // The hostname is preserved (Host header/SNI/certificate) while the socket
    // may only go to the vetted address.
    expect(delivered.target.url.href).toBe('https://receiver.test/hook');
    expect(delivered.target.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('records a refusal as terminal — it consumes no retry attempt', async () => {
    const h = await createTestApp();
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await postSubscription(agent, 'https://rebind.test/hook');
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    // Same subscription, but the destination now resolves to loopback.
    const sending = recordingTransport(200);
    const deliveries = createWebhookDeliveryRepository(h.db);
    const dispatcher = createWebhookDispatcher({
      subscriptions: createWebhookSubscriptionRepository(h.db),
      deliveries,
      transport: sending.transport,
      encryptionKey: h.ctx.config.twoFactor.encryptionKey,
      audit: noopAudit,
      logger: h.ctx.logger,
      dnsResolver: loopbackResolver,
    });

    // Attempt 1 of 3: a transport failure would be 'retry' here — a refusal is
    // terminal immediately, so BullMQ never re-runs it against the internal host.
    const result = await dispatcher.deliver(
      { subscriptionId: subId, deliveryId: DELIVERY_A, event: alertEvent(user.id) },
      { attempt: 1, maxAttempts: 3 },
    );
    expect(result.outcome).toBe('failed');
    expect(result.status).toBeNull();
    expect(sending.requests).toHaveLength(0);

    const log = await deliveries.listForSubscription(subId, 10);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe('failed');
    expect(log[0]!.attempts).toBe(1);
    expect(log[0]!.responseStatus).toBeNull();
    expect(log[0]!.error).toBe(WEBHOOK_DELIVERY_REFUSED_ERROR);
  });

  it('leaves the delivery log useless as an internal port scanner', async () => {
    // Two destinations that differ only in what they would have hit: a service
    // that is listening (the API itself) and one that is not. Both are refused
    // before any connection, so the log rows are byte-identical in shape.
    let rebound = false;
    const perHost: OutboundUrlResolver = async (hostname) => {
      if (!rebound) return [{ address: '93.184.216.34', family: 4 }];
      return hostname === 'open.rebind.test'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    };
    const probing = recordingTransport(200);
    const h = await createTestApp({
      webhookTransport: probing.transport,
      webhookUrlResolver: perHost,
    });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const openSub = createWebhookSubscriptionResponseSchema.parse(
      (await postSubscription(agent, 'https://open.rebind.test/probe')).body,
    ).subscription.id;
    const closedSub = createWebhookSubscriptionResponseSchema.parse(
      (await postSubscription(agent, 'https://closed.rebind.test/probe')).body,
    ).subscription.id;

    rebound = true;
    await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));
    expect(probing.requests).toHaveLength(0);

    const shape = async (id: string) =>
      (await h.ctx.webhooks.listDeliveries(user.id, id)).map((delivery) => ({
        status: delivery.status,
        responseStatus: delivery.responseStatus,
        error: delivery.error,
      }));
    const expected = [
      { status: 'failed', responseStatus: null, error: WEBHOOK_DELIVERY_REFUSED_ERROR },
    ];
    expect(await shape(openSub)).toEqual(expected);
    expect(await shape(closedSub)).toEqual(expected);
  });
});
