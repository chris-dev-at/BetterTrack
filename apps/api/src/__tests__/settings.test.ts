import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  NOTIFICATION_TYPES,
  accountSettingsResponseSchema,
  meResponseSchema,
  notificationSettingsResponseSchema,
} from '@bettertrack/contracts';

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

/** The stored `config` override map for a channel, as the dispatcher would read it. */
async function channelConfig(userId: string, channel: 'inapp' | 'email') {
  const [row] = await harness.db
    .select({ config: schema.notificationSettings.config })
    .from(schema.notificationSettings)
    .where(
      and(
        eq(schema.notificationSettings.userId, userId),
        eq(schema.notificationSettings.channel, channel),
      ),
    );
  return row?.config as Record<string, boolean> | null | undefined;
}

describe('GET /api/v1/settings/notifications', () => {
  it('requires authentication', async () => {
    const res = await request.agent(harness.app).get('/api/v1/settings/notifications');
    expect(res.status).toBe(401);
  });

  it('defaults every type to both channels on when the user has no rows', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const settings = await getSettings(agent);
    expect(Object.keys(settings!.matrix).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    for (const type of NOTIFICATION_TYPES) {
      expect(settings!.matrix[type]).toEqual({ inapp: true, email: true });
    }
  });
});

describe('PATCH /api/v1/settings/notifications', () => {
  it('persists a per-type routing override; a follow-up GET reflects it', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    // Route friend requests to email-only, leaving every other type at default.
    const patched = await patchSettings(agent, {
      matrix: { 'friend.request': { inapp: false, email: true } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.matrix['friend.request']).toEqual({ inapp: false, email: true });
    // Untouched types keep the default.
    expect(patched.body.matrix['friend.accepted']).toEqual({ inapp: true, email: true });

    const settings = await getSettings(agent);
    expect(settings!.matrix['friend.request']).toEqual({ inapp: false, email: true });

    // Stored in the existing config jsonb (no new columns).
    expect((await channelConfig(alice.id, 'inapp'))?.['friend.request']).toBe(false);
    expect((await channelConfig(alice.id, 'email'))?.['friend.request']).toBe(true);
  });

  it('supports muting a type (both channels off) and merges independent updates', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    await patchSettings(agent, { matrix: { 'friend.request': { inapp: true, email: false } } });
    await patchSettings(agent, { matrix: { 'portfolio.shared': { inapp: false, email: false } } });

    const settings = await getSettings(agent);
    // Both overrides persist independently; the first is not clobbered by the second.
    expect(settings!.matrix['friend.request']).toEqual({ inapp: true, email: false });
    expect(settings!.matrix['portfolio.shared']).toEqual({ inapp: false, email: false });
    expect(settings!.matrix['friend.accepted']).toEqual({ inapp: true, email: true });
  });

  it('rejects an empty body (no type routing)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    expect((await patchSettings(agent, {})).status).toBe(400);
    expect((await patchSettings(agent, { matrix: {} })).status).toBe(400);
  });

  it('rejects an unknown notification type', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const res = await patchSettings(agent, {
      matrix: { 'not.a.type': { inapp: true, email: true } },
    });
    expect(res.status).toBe(400);
  });

  it('is strictly session-user scoped — one user cannot read or write another', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await patchSettings(bobAgent, { matrix: { 'friend.request': { inapp: false, email: false } } });

    // Alice's matrix is untouched by Bob's write.
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const aliceSettings = await getSettings(aliceAgent);
    expect(aliceSettings!.matrix['friend.request']).toEqual({ inapp: true, email: true });
    expect(await channelConfig(alice.id, 'inapp')).toBeUndefined();

    // Bob still sees his own change.
    const bobSettings = await getSettings(bobAgent);
    expect(bobSettings!.matrix['friend.request']).toEqual({ inapp: false, email: false });
  });
});

// --- Account settings: locale (§13.3 V3-P1) + default portfolio visibility ---

async function getAccount(agent: Agent) {
  const res = await agent.get('/api/v1/settings/account');
  expect(res.status).toBe(200);
  return accountSettingsResponseSchema.parse(res.body);
}

function patchAccount(agent: Agent, body: Record<string, unknown>) {
  return agent
    .patch('/api/v1/settings/account')
    .set(...XRW)
    .send(body);
}

async function getMe(agent: Agent) {
  const res = await agent.get('/api/v1/auth/me');
  expect(res.status).toBe(200);
  return meResponseSchema.parse(res.body);
}

describe('Account settings — locale (§13.3 V3-P1)', () => {
  it('defaults a fresh user to the EN locale, on both /settings/account and /auth/me', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    expect((await getAccount(agent)).locale).toBe('en');
    expect((await getMe(agent)).locale).toBe('en');
  });

  it('persists a locale change and survives logout/login (per-user)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const patched = await patchAccount(agent, { locale: 'de' });
    expect(patched.status).toBe(200);
    expect(patched.body.locale).toBe('de');
    // The stored preference immediately rides the /auth/me response the SPA seeds from.
    expect((await getMe(agent)).locale).toBe('de');

    // A brand-new session for the same account still reads 'de' — it is persisted
    // per user, not just in the session.
    const freshAgent = await loginAgent(harness.app, alice.email, alice.password);
    expect((await getAccount(freshAgent)).locale).toBe('de');
    expect((await getMe(freshAgent)).locale).toBe('de');
  });

  it('is a partial update: locale and visibility change independently', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    // Change only the locale — visibility keeps its default.
    const afterLocale = await patchAccount(agent, { locale: 'de' });
    expect(afterLocale.body).toEqual({ defaultPortfolioVisibility: 'private', locale: 'de' });

    // Change only the visibility — the locale set above is untouched.
    const afterVisibility = await patchAccount(agent, { defaultPortfolioVisibility: 'friends' });
    expect(afterVisibility.body).toEqual({ defaultPortfolioVisibility: 'friends', locale: 'de' });
  });

  it('accepts a region-tagged code and rejects malformed / empty bodies', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    expect((await patchAccount(agent, { locale: 'de-AT' })).status).toBe(200);
    expect((await patchAccount(agent, { locale: 'english' })).status).toBe(400);
    expect((await patchAccount(agent, { locale: 'DE' })).status).toBe(400);
    expect((await patchAccount(agent, {})).status).toBe(400);
  });

  it('is strictly session-user scoped — one user cannot change another’s locale', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await patchAccount(bobAgent, { locale: 'de' });

    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    expect((await getAccount(aliceAgent)).locale).toBe('en');
  });
});
