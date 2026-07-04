import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { notificationSettingsResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';
import * as schema from '../data/schema';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

type Agent = ReturnType<typeof request.agent>;

async function getSettings(agent: Agent) {
  const res = await agent.get('/api/v1/settings/notifications');
  expect(res.status).toBe(200);
  const parsed = notificationSettingsResponseSchema.safeParse(res.body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : null;
}

function patchSettings(agent: Agent, body: Record<string, unknown>) {
  return agent
    .patch('/api/v1/settings/notifications')
    .set(...XRW)
    .send(body);
}

/** The `enabled` flag for a channel as the dispatcher's repo would read it. */
async function channelRow(userId: string, channel: 'inapp' | 'email') {
  const [row] = await harness.db
    .select({ enabled: schema.notificationSettings.enabled })
    .from(schema.notificationSettings)
    .where(
      and(
        eq(schema.notificationSettings.userId, userId),
        eq(schema.notificationSettings.channel, channel),
      ),
    );
  return row;
}

describe('GET /api/v1/settings/notifications', () => {
  it('requires authentication', async () => {
    const res = await request.agent(harness.app).get('/api/v1/settings/notifications');
    expect(res.status).toBe(401);
  });

  it('defaults in-app on and email on when the user has no rows', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const settings = await getSettings(agent);
    expect(settings).toEqual({ inapp: { enabled: true }, email: { enabled: true } });
  });
});

describe('PATCH /api/v1/settings/notifications', () => {
  it('persists an email toggle; a follow-up GET reflects it', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const patched = await patchSettings(agent, { email: { enabled: false } });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ inapp: { enabled: true }, email: { enabled: false } });

    const settings = await getSettings(agent);
    expect(settings?.email.enabled).toBe(false);

    // Toggling back on is reflected too.
    const reenabled = await patchSettings(agent, { email: { enabled: true } });
    expect(reenabled.status).toBe(200);
    expect((await getSettings(agent))?.email.enabled).toBe(true);
  });

  it('disabling email is reflected in the settings row the dispatcher reads', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    await patchSettings(agent, { email: { enabled: false } });

    // The dispatcher (email path) reads channelEnabled(user, 'email'): this row
    // is exactly what makes it stop sending this user email.
    const row = await channelRow(alice.id, 'email');
    expect(row?.enabled).toBe(false);
  });

  it('cannot disable in-app — the attempt is ignored and it stays on', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const res = await patchSettings(agent, { inapp: { enabled: false } });
    expect(res.status).toBe(200);
    expect(res.body.inapp.enabled).toBe(true);

    // No suppressing row is written, so the dispatcher's default (on) holds.
    expect(await channelRow(alice.id, 'inapp')).toBeUndefined();
    expect((await getSettings(agent))?.inapp.enabled).toBe(true);
  });

  it('rejects an empty body (no channel toggle)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const res = await patchSettings(agent, {});
    expect(res.status).toBe(400);
  });

  it('is strictly session-user scoped — one user cannot read or write another', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await patchSettings(bobAgent, { email: { enabled: false } });

    // Alice's settings are untouched by Bob's write.
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    expect((await getSettings(aliceAgent))?.email.enabled).toBe(true);
    expect(await channelRow(alice.id, 'email')).toBeUndefined();

    // Bob still sees his own change.
    expect((await getSettings(bobAgent))?.email.enabled).toBe(false);
    expect((await channelRow(bob.id, 'email'))?.enabled).toBe(false);
  });
});
