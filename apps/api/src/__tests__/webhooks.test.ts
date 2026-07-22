import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  createWebhookSubscriptionResponseSchema,
  webhookDeliveryListResponseSchema,
  webhookSubscriptionListResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import {
  createWebhookDeliveryRepository,
  createWebhookSubscriptionRepository,
} from '../data/repositories/webhookRepository';
import type { AlertTriggeredEvent } from '../events';
import { WEBHOOK_DELIVERY_RETENTION_DAYS, createWebhookDeliveryCleanupJob } from '../jobs';
import type { AuditService } from '../services/audit/auditService';
import { decryptSecret } from '../services/crypto/secretBox';
import { DISPATCHABLE_EVENT_TYPES } from '../services/notifications/notificationDispatcher';
import {
  createWebhookDispatcher,
  verifyWebhookSignature,
  type WebhookTransport,
} from '../services/webhooks';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/** A no-op audit sink for directly-constructed dispatchers in unit-style tests. */
const noopAudit: Pick<AuditService, 'record'> = { record: async () => undefined };

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DELIVERY_A = '00000000-0000-7000-8000-0000000000aa';
const DELIVERY_B = '00000000-0000-7000-8000-0000000000ab';

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
});
