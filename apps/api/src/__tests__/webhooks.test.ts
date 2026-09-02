import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PARANOID_KILLED_WEBHOOK_EVENT_TYPES,
  PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_AUTO_DISABLE_WINDOW_MS,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_DELIVERY_REFUSED_ERROR,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_URL_BLOCKED_CODE,
  createWebhookSubscriptionResponseSchema,
  isParanoidKilledWebhookEventType,
  webhookDeliveryListResponseSchema,
  webhookSubscriptionListResponseSchema,
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
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  WEBHOOK_DELIVER_ATTEMPTS,
  WebhookDeliveryRetryError,
  bindParanoidJob,
  createWebhookDeliverJob,
  createWebhookDeliveryCleanupJob,
  jobOptionsForQueue,
  type JobDefinition,
} from '../jobs';
import { isParanoidKilledWebhookEvent } from '../services/account/paranoidEnforcement';
import { AuditAction, type AuditService } from '../services/audit/auditService';
import { decryptSecret, encryptSecret } from '../services/crypto/secretBox';
import { DISPATCHABLE_EVENT_TYPES } from '../services/notifications/notificationDispatcher';
import type { OutboundUrlResolver } from '../services/security/outboundUrlGuard';
import {
  createWebhookBridge,
  createWebhookDispatcher,
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

/** A uuid-shaped delivery id from a counter (the log column is a uuid). */
function deliveryId(n: number): string {
  return `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
}

let harness: TestHarness;
let recorder: ReturnType<typeof recordingTransport>;

/** The stored subscription row — the failure streak + its window anchor. */
async function subscriptionRow(
  db: TestHarness['db'],
  id: string,
): Promise<typeof schema.webhookSubscriptions.$inferSelect> {
  const [row] = await db
    .select()
    .from(schema.webhookSubscriptions)
    .where(eq(schema.webhookSubscriptions.id, id));
  expect(row).toBeDefined();
  return row!;
}

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
): Promise<{ agent: Agent; userId: string; id: string; secret: string }> {
  const user = await harness.seedUser({
    email: `wh-${Math.round(Math.random() * 1e9)}@bettertrack.test`,
    username: `wh${Math.round(Math.random() * 1e9)}`,
  });
  const agent = await loginAgent(harness.app, user.email, user.password);
  const res = await agent
    .post('/api/v1/settings/webhooks')
    .set(...XRW)
    .send({ url: 'https://receiver.test/hook', eventTypes });
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
  const HOUR_MS = 60 * 60 * 1000;

  /**
   * A dispatcher on an injectable clock, so a test can place terminal failures
   * at chosen instants and exercise the auto-disable WINDOW rather than merely
   * their adjacency in a loop.
   */
  function clockedDispatcher(options: {
    h: TestHarness;
    transport: WebhookTransport;
    now: () => number;
    audit?: Pick<AuditService, 'record'>;
    encryptionKey?: Buffer;
  }): ReturnType<typeof createWebhookDispatcher> {
    return createWebhookDispatcher({
      subscriptions: createWebhookSubscriptionRepository(options.h.db),
      deliveries: createWebhookDeliveryRepository(options.h.db),
      transport: options.transport,
      encryptionKey: options.encryptionKey ?? options.h.ctx.config.twoFactor.encryptionKey,
      audit: options.audit ?? noopAudit,
      logger: options.h.ctx.logger,
      dnsResolver: publicTestResolver,
      now: options.now,
    });
  }

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
    expect(opts.backoff).toEqual({ type: 'exponential', delay: BACKOFF_BASE_MS });

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

  it('survives a transient outage: a streak older than the window restarts instead of tripping', async () => {
    const { id, userId } = await createSubscription(['alert.triggered']);
    const failing = recordingTransport(500);
    const clock = { ms: Date.parse('2026-08-01T09:00:00.000Z') };
    const opened = clock.ms;
    const dispatcher = clockedDispatcher({
      h: harness,
      transport: failing.transport,
      now: () => clock.ms,
    });
    let sent = 0;
    const failOnce = async (): Promise<string> => {
      sent += 1;
      const result = await dispatcher.deliver(
        { subscriptionId: id, deliveryId: deliveryId(sent), event: alertEvent(userId) },
        { attempt: 1, maxAttempts: 1 },
      );
      return result.outcome;
    };

    // A blip: N-1 terminal failures an hour apart, comfortably inside the window.
    for (let i = 0; i < WEBHOOK_AUTO_DISABLE_THRESHOLD - 1; i += 1) {
      expect(await failOnce()).toBe('failed');
      clock.ms += HOUR_MS;
    }
    const duringOutage = await subscriptionRow(harness.db, id);
    expect(duringOutage.enabled).toBe(true);
    expect(duringOutage.consecutiveFailures).toBe(WEBHOOK_AUTO_DISABLE_THRESHOLD - 1);
    expect(duringOutage.failureWindowStartedAt?.getTime()).toBe(opened);

    // The receiver then behaves for longer than the window before blipping once
    // more. Under the old lifetime counter that lone failure was the fifth and
    // killed the subscription; it must now open a fresh streak instead.
    clock.ms += WEBHOOK_AUTO_DISABLE_WINDOW_MS + 1_000;
    const reopened = clock.ms;
    expect(await failOnce()).toBe('failed');
    const afterQuiet = await subscriptionRow(harness.db, id);
    expect(afterQuiet.enabled).toBe(true);
    expect(afterQuiet.disabledReason).toBeNull();
    expect(afterQuiet.consecutiveFailures).toBe(1);
    expect(afterQuiet.failureWindowStartedAt?.getTime()).toBe(reopened);

    // The restarted streak still trips: the window decays failures, it does not
    // exempt a receiver that keeps failing.
    for (let i = 0; i < WEBHOOK_AUTO_DISABLE_THRESHOLD - 2; i += 1) {
      clock.ms += HOUR_MS;
      expect(await failOnce()).toBe('failed');
    }
    clock.ms += HOUR_MS;
    expect(await failOnce()).toBe('disabled');
    expect((await subscriptionRow(harness.db, id)).enabled).toBe(false);
  });

  it('disables on N failures inside the window and audits the windowed count', async () => {
    const { id, userId } = await createSubscription(['alert.triggered']);
    const failing = recordingTransport(500);
    const clock = { ms: Date.parse('2026-08-01T09:00:00.000Z') };
    const opened = clock.ms;
    const audited: Parameters<AuditService['record']>[0][] = [];
    const dispatcher = clockedDispatcher({
      h: harness,
      transport: failing.transport,
      now: () => clock.ms,
      audit: {
        record: async (entry) => {
          audited.push(entry);
        },
      },
    });

    // Spread across four hours apiece — never adjacent, but all inside one window.
    const step = Math.floor(WEBHOOK_AUTO_DISABLE_WINDOW_MS / (WEBHOOK_AUTO_DISABLE_THRESHOLD + 1));
    for (let i = 0; i < WEBHOOK_AUTO_DISABLE_THRESHOLD; i += 1) {
      if (i > 0) clock.ms += step;
      const result = await dispatcher.deliver(
        { subscriptionId: id, deliveryId: deliveryId(i + 1), event: alertEvent(userId) },
        { attempt: 1, maxAttempts: 1 },
      );
      expect(result.outcome).toBe(i === WEBHOOK_AUTO_DISABLE_THRESHOLD - 1 ? 'disabled' : 'failed');
    }
    expect(clock.ms - opened).toBeLessThan(WEBHOOK_AUTO_DISABLE_WINDOW_MS);

    const disabled = await subscriptionRow(harness.db, id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledReason).toBe('auto');
    expect(disabled.consecutiveFailures).toBe(WEBHOOK_AUTO_DISABLE_THRESHOLD);
    // The anchor stays at the FIRST failure of the streak, not the last.
    expect(disabled.failureWindowStartedAt?.getTime()).toBe(opened);

    expect(audited.map((entry) => entry.action)).toEqual([AuditAction.WebhookAutoDisabled]);
    expect(audited[0]!.targetId).toBe(id);
    expect(audited[0]!.meta).toMatchObject({ failures: WEBHOOK_AUTO_DISABLE_THRESHOLD });
  });

  it('a successful delivery clears the streak and its window anchor', async () => {
    const { id, userId } = await createSubscription(['alert.triggered']);
    const clock = { ms: Date.parse('2026-08-01T09:00:00.000Z') };
    const failing = clockedDispatcher({
      h: harness,
      transport: recordingTransport(500).transport,
      now: () => clock.ms,
    });
    const healthy = clockedDispatcher({
      h: harness,
      transport: recordingTransport(200).transport,
      now: () => clock.ms,
    });

    for (let i = 0; i < WEBHOOK_AUTO_DISABLE_THRESHOLD - 1; i += 1) {
      await failing.deliver(
        { subscriptionId: id, deliveryId: deliveryId(i + 1), event: alertEvent(userId) },
        { attempt: 1, maxAttempts: 1 },
      );
      clock.ms += HOUR_MS;
    }
    expect((await subscriptionRow(harness.db, id)).consecutiveFailures).toBe(
      WEBHOOK_AUTO_DISABLE_THRESHOLD - 1,
    );

    const ok = await healthy.deliver(
      { subscriptionId: id, deliveryId: deliveryId(50), event: alertEvent(userId) },
      { attempt: 1, maxAttempts: 1 },
    );
    expect(ok.outcome).toBe('delivered');
    const cleared = await subscriptionRow(harness.db, id);
    expect(cleared.consecutiveFailures).toBe(0);
    expect(cleared.failureWindowStartedAt).toBeNull();

    // And the next failure opens a brand-new window rather than resuming the old.
    clock.ms += HOUR_MS;
    const resumed = await failing.deliver(
      { subscriptionId: id, deliveryId: deliveryId(51), event: alertEvent(userId) },
      { attempt: 1, maxAttempts: 1 },
    );
    expect(resumed.outcome).toBe('failed');
    const restarted = await subscriptionRow(harness.db, id);
    expect(restarted.consecutiveFailures).toBe(1);
    expect(restarted.failureWindowStartedAt?.getTime()).toBe(clock.ms);
  });

  it('auto-disables after N failures within the window, records + audits it, and re-enables manually', async () => {
    const failing = recordingTransport(500);
    const h = await createTestApp({ webhookTransport: failing.transport });
    const user = await h.seedUser();
    const agent = await loginAgent(h.app, user.email, user.password);
    const created = await agent
      .post('/api/v1/settings/webhooks')
      .set(...XRW)
      .send({ url: 'https://down.test/hook', eventTypes: ['alert.triggered'] });
    const subId = createWebhookSubscriptionResponseSchema.parse(created.body).subscription.id;

    // Each fire is one terminal failure (test seam runs a single attempt), and
    // all N land back-to-back on the real clock — i.e. inside one window.
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

    // Windowed, not a lifetime tally: the N failures share one streak whose
    // anchor is set and whose span ended well inside the window.
    const disabledRow = await subscriptionRow(h.db, subId);
    expect(disabledRow.failureWindowStartedAt).not.toBeNull();
    expect(disabledRow.disabledAt).not.toBeNull();
    expect(
      disabledRow.disabledAt!.getTime() - disabledRow.failureWindowStartedAt!.getTime(),
    ).toBeLessThan(WEBHOOK_AUTO_DISABLE_WINDOW_MS);

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
    // A clean slate includes the window anchor, so the next failure opens a
    // fresh window instead of resuming the one that disabled the subscription.
    expect((await subscriptionRow(h.db, subId)).failureWindowStartedAt).toBeNull();

    // And it delivers again.
    await h.ctx.webhookBridge.handleEvent(alertEvent(user.id));
    expect(failing.requests).toHaveLength(1);
  });

  it('counts an undecryptable secret toward auto-disable, within the same window', async () => {
    const { agent, id, userId } = await createSubscription(['alert.triggered']);
    const deliveries = createWebhookDeliveryRepository(harness.db);
    const clock = { ms: Date.parse('2026-08-01T09:00:00.000Z') };
    const opened = clock.ms;
    const dispatcher = clockedDispatcher({
      h: harness,
      transport: recorder.transport,
      // A key the subscription's envelope was not sealed with → every delivery
      // fails at decrypt, terminally.
      encryptionKey: Buffer.alloc(32, 0xff),
      now: () => clock.ms,
    });

    // An hour apart rather than back-to-back: what disables the subscription is
    // that the N failures share a window, not that they are adjacent calls.
    for (let index = 0; index < WEBHOOK_AUTO_DISABLE_THRESHOLD; index += 1) {
      if (index > 0) clock.ms += HOUR_MS;
      const result = await dispatcher.deliver(
        {
          subscriptionId: id,
          deliveryId: deliveryId(index + 1),
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
    expect((await subscriptionRow(harness.db, id)).failureWindowStartedAt?.getTime()).toBe(opened);

    const log = await deliveries.listForSubscription(id, WEBHOOK_AUTO_DISABLE_THRESHOLD);
    expect(log).toHaveLength(WEBHOOK_AUTO_DISABLE_THRESHOLD);
    expect(log.every((delivery) => delivery.error === 'secret unavailable')).toBe(true);
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
    expect(killedByRegistry).toHaveLength(18);
    expect([...PARANOID_KILLED_WEBHOOK_EVENT_TYPES].sort()).toEqual([...killedByRegistry].sort());
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
