import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  NOTIFICATION_TYPES,
  accountSettingsResponseSchema,
  isAccountSecurityNotificationType,
  isOptInNotificationType,
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

  it('defaults bell/push on for every type; email on only for account/security (V4-P0c)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const settings = await getSettings(agent);
    expect(Object.keys(settings!.matrix).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    for (const type of NOTIFICATION_TYPES) {
      if (isOptInNotificationType(type)) {
        // Opt-in types (V5-P5) default OFF on every channel.
        expect(settings!.matrix[type]).toEqual({
          inapp: false,
          email: false,
          telegram: false,
          discord: false,
          push: false,
          webpush: false,
        });
        continue;
      }
      expect(settings!.matrix[type]).toEqual({
        inapp: true,
        email: isAccountSecurityNotificationType(type),
        // V4-P10: telegram + discord follow the "default ON per type once
        // configured" rule; matrix cells reflect that default regardless of
        // whether the caller has actually configured either channel.
        telegram: true,
        discord: true,
        push: true,
        webpush: true,
      });
    }
  });
});

describe('PATCH /api/v1/settings/notifications', () => {
  it('persists a per-type routing override; a follow-up GET reflects it', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    // Route friend requests to email-only, leaving every other type at default.
    const patched = await patchSettings(agent, {
      matrix: {
        'friend.request': {
          inapp: false,
          email: true,
          telegram: true,
          discord: true,
          push: true,
          webpush: true,
        },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.matrix['friend.request']).toEqual({
      inapp: false,
      email: true,
      telegram: true,
      discord: true,
      push: true,
      webpush: true,
    });
    // Untouched types keep the default (email off for this non-account type, V4-P0c).
    expect(patched.body.matrix['friend.accepted']).toEqual({
      inapp: true,
      email: false,
      telegram: true,
      discord: true,
      push: true,
      webpush: true,
    });

    const settings = await getSettings(agent);
    expect(settings!.matrix['friend.request']).toEqual({
      inapp: false,
      email: true,
      telegram: true,
      discord: true,
      push: true,
      webpush: true,
    });

    // Stored in the existing config jsonb (no new columns).
    expect((await channelConfig(alice.id, 'inapp'))?.['friend.request']).toBe(false);
    expect((await channelConfig(alice.id, 'email'))?.['friend.request']).toBe(true);
  });

  it('supports muting a type (both channels off) and merges independent updates', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    await patchSettings(agent, {
      matrix: {
        'friend.request': {
          inapp: true,
          email: false,
          telegram: true,
          discord: true,
          push: true,
          webpush: true,
        },
      },
    });
    await patchSettings(agent, {
      matrix: {
        'portfolio.shared': {
          inapp: false,
          email: false,
          telegram: false,
          discord: false,
          push: false,
          webpush: false,
        },
      },
    });

    const settings = await getSettings(agent);
    // Both overrides persist independently; the first is not clobbered by the second.
    expect(settings!.matrix['friend.request']).toEqual({
      inapp: true,
      email: false,
      telegram: true,
      discord: true,
      push: true,
      webpush: true,
    });
    expect(settings!.matrix['portfolio.shared']).toEqual({
      inapp: false,
      email: false,
      telegram: false,
      discord: false,
      push: false,
      webpush: false,
    });
    expect(settings!.matrix['friend.accepted']).toEqual({
      inapp: true,
      email: false, // non-account default (V4-P0c)
      telegram: true,
      discord: true,
      push: true,
      webpush: true,
    });
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
      matrix: {
        'not.a.type': {
          inapp: true,
          email: true,
          telegram: true,
          discord: true,
          push: true,
          webpush: true,
        },
      },
    });
    expect(res.status).toBe(400);
  });

  it('is strictly session-user scoped — one user cannot read or write another', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await patchSettings(bobAgent, {
      matrix: {
        'friend.request': {
          inapp: false,
          email: false,
          telegram: false,
          discord: false,
          push: false,
          webpush: false,
        },
      },
    });

    // Alice's matrix is untouched by Bob's write.
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const aliceSettings = await getSettings(aliceAgent);
    expect(aliceSettings!.matrix['friend.request']).toEqual({
      inapp: true,
      email: false, // non-account default (V4-P0c); untouched by Bob's write
      telegram: true,
      discord: true,
      push: true,
      webpush: true,
    });
    expect(await channelConfig(alice.id, 'inapp')).toBeUndefined();

    // Bob still sees his own change.
    const bobSettings = await getSettings(bobAgent);
    expect(bobSettings!.matrix['friend.request']).toEqual({
      inapp: false,
      email: false,
      telegram: false,
      discord: false,
      push: false,
      webpush: false,
    });
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
    expect(afterLocale.body).toEqual({
      defaultPortfolioVisibility: 'private',
      locale: 'de',
      baseCurrency: 'EUR',
    });

    // Change only the visibility — the locale set above is untouched.
    const afterVisibility = await patchAccount(agent, { defaultPortfolioVisibility: 'friends' });
    expect(afterVisibility.body).toEqual({
      defaultPortfolioVisibility: 'friends',
      locale: 'de',
      baseCurrency: 'EUR',
    });
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

describe('Settings → Taxes (§13.3 V3-P4)', () => {
  it('requires authentication', async () => {
    expect((await request(harness.app).get('/api/v1/settings/taxes')).status).toBe(401);
    expect(
      (
        await request(harness.app)
          .patch('/api/v1/settings/taxes')
          .set(...XRW)
          .send({ mode: 'none' })
      ).status,
    ).toBe(401);
  });

  it('is strictly per user — one user’s mode never leaks to another', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    const patched = await aliceAgent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'AT' });
    expect(patched.status).toBe(200);

    expect((await aliceAgent.get('/api/v1/settings/taxes')).body).toEqual({
      mode: 'country_specific',
      country: 'AT',
    });
    // Bob still reads the untouched default.
    expect((await bobAgent.get('/api/v1/settings/taxes')).body).toEqual({
      mode: 'none',
      country: null,
    });

    // Persisted per user, not per session.
    const freshAlice = await loginAgent(harness.app, alice.email, alice.password);
    expect((await freshAlice.get('/api/v1/settings/taxes')).body).toEqual({
      mode: 'country_specific',
      country: 'AT',
    });
  });
});

describe('Account settings — base currency (§5.4, §13.3 V3-P10d)', () => {
  it('defaults a fresh user to EUR, on both /settings/account and /auth/me', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    expect((await getAccount(agent)).baseCurrency).toBe('EUR');
    expect((await getMe(agent)).baseCurrency).toBe('EUR');
  });

  it('persists a base-currency change and survives logout/login (per-user)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const patched = await patchAccount(agent, { baseCurrency: 'USD' });
    expect(patched.status).toBe(200);
    expect(patched.body.baseCurrency).toBe('USD');
    // The stored preference immediately rides the /auth/me response the SPA seeds from.
    expect((await getMe(agent)).baseCurrency).toBe('USD');

    // A brand-new session still reads USD — persisted per user, not per session.
    const freshAgent = await loginAgent(harness.app, alice.email, alice.password);
    expect((await getAccount(freshAgent)).baseCurrency).toBe('USD');
    expect((await getMe(freshAgent)).baseCurrency).toBe('USD');
  });

  it('is a partial update and only accepts the supported picker set', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    // Changing only the base currency leaves the other prefs at their defaults.
    const patched = await patchAccount(agent, { baseCurrency: 'CHF' });
    expect(patched.body).toEqual({
      defaultPortfolioVisibility: 'private',
      locale: 'en',
      baseCurrency: 'CHF',
    });

    expect((await patchAccount(agent, { baseCurrency: 'GBP' })).status).toBe(200);
    expect((await patchAccount(agent, { baseCurrency: 'JPY' })).status).toBe(400);
    expect((await patchAccount(agent, { baseCurrency: 'eur' })).status).toBe(400);
  });

  it('is strictly session-user scoped — one user cannot change another’s base', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await patchAccount(bobAgent, { baseCurrency: 'USD' });

    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    expect((await getAccount(aliceAgent)).baseCurrency).toBe('EUR');
  });
});
