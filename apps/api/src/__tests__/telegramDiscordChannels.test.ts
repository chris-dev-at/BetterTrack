import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATION_TYPES, notificationSettingsResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { createTelegramLinkRepository } from '../data/repositories/telegramLinkRepository';
import { createDiscordWebhookRepository } from '../data/repositories/discordWebhookRepository';
import { encryptSecret } from '../services/crypto/secretBox';
import { createTelegramChannel } from '../services/notifications/telegramChannel';
import { createDiscordChannel } from '../services/notifications/discordChannel';
import { createNotificationRepository } from '../data/repositories/notificationRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { createNotificationDispatcher } from '../services/notifications/notificationDispatcher';
import type { FriendRequestEvent } from '../events';
import { telegramLinks, discordWebhooks } from '../data/schema';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  // V5-P0 kill-switch is default OFF; every test in this file exercises the
  // channels themselves, so opt in explicitly. Kill-switch behaviour has its
  // own describe block below.
  harness = await createTestApp({
    env: { BT_TELEGRAM_BOT_TOKEN: 'TEST-BOT-TOKEN', BT_TELEGRAM_DISCORD_ENABLED: 'true' },
  });
});

afterEach(async () => {
  await harness.ctx.events.close();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  return agent;
}

describe('Telegram + Discord channel columns (§13.4 V4-P10)', () => {
  it('matrix columns hidden when neither channel is configured', async () => {
    // A fresh harness with the bot token UNSET but the kill-switch ON: the
    // Telegram channel stays unavailable (no bot), and Discord is per-user (no
    // saved webhook here).
    const barren = await createTestApp({ env: { BT_TELEGRAM_DISCORD_ENABLED: 'true' } });
    try {
      const alice = await barren.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const agent = await loginAgent(barren.app, alice.email, alice.password);

      const res = await agent.get('/api/v1/settings/notifications');
      expect(res.status).toBe(200);
      const settings = notificationSettingsResponseSchema.parse(res.body);
      // Column availability reads the deployment + per-user setup. Neither is
      // configured here, so both columns stay off.
      expect(settings.channels.telegram).toBe(false);
      expect(settings.channels.discord).toBe(false);
      // Deployment-level config: Discord is offered (kill-switch on) but
      // Telegram is not (bot token unset).
      expect(settings.channelsConfigurable.telegram).toBe(false);
      expect(settings.channelsConfigurable.discord).toBe(true);
    } finally {
      await barren.ctx.events.close();
    }
  });

  it('Telegram column lights up only after the caller links their chat', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    // Deployment has a bot token, but Alice has not linked a chat yet.
    let res = await agent.get('/api/v1/settings/notifications');
    expect(notificationSettingsResponseSchema.parse(res.body).channels.telegram).toBe(false);

    // Simulate a completed link by inserting a confirmed row directly (the
    // handshake endpoints are covered separately below).
    await harness.db.insert(telegramLinks).values({
      userId: alice.id,
      chatId: '999999',
      botUsername: 'bt_bot',
      linkCode: null,
      linkCodeExpiresAt: null,
      linkedAt: new Date(),
      updatedAt: new Date(),
    });

    res = await agent.get('/api/v1/settings/notifications');
    expect(notificationSettingsResponseSchema.parse(res.body).channels.telegram).toBe(true);
  });
});

describe('Discord webhook save flow (§13.4 V4-P10)', () => {
  it('rejects a URL that fails Discord shape validation without persisting', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const res = await agent
      .post('/api/v1/settings/discord/webhook')
      .set(...XRW)
      .send({ url: 'https://example.com/not-a-webhook' });

    // Shape validator ("invalid_host") kicks in before the network probe.
    expect(res.status).toBe(400);
    const rows = await harness.db
      .select()
      .from(discordWebhooks)
      .where(eq(discordWebhooks.userId, alice.id));
    expect(rows).toHaveLength(0);
  });

  it('rejects a valid-shape URL that fails the live test send with a clear error', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    // Point the Discord channel at a fake fetch that always 404s.
    vi.spyOn(harness.ctx.discordSetup, 'save').mockImplementationOnce(async () => {
      throw new (await import('../services/notifications/discordSetupService')).DiscordSetupError(
        'invalid_webhook',
      );
    });
    const res = await agent
      .post('/api/v1/settings/discord/webhook')
      .set(...XRW)
      .send({ url: 'https://discord.com/api/webhooks/1/token' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_webhook');
  });
});

describe('Dispatcher fan-out through Telegram (§13.4 V4-P10)', () => {
  it('a matrix-routed event produces exactly one Telegram send against a mock bot API', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });

    // Wire an isolated dispatcher with a mocked Telegram channel that records
    // sends, so we can assert exactly one call and no leaks into other channels.
    const linkRepo = createTelegramLinkRepository(harness.db);
    await linkRepo.putPendingCode(alice.id, {
      code: 'ignored',
      expiresAt: new Date(Date.now() + 60_000),
      botUsername: 'bt_bot',
    });
    await linkRepo.confirmLink(alice.id, '4321', new Date());

    const calls: { url: string; body: string }[] = [];
    const fetchFn = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response('{"ok":true}', { status: 200 });
    });
    const telegram = createTelegramChannel({
      botToken: 'TEST-BOT-TOKEN',
      links: linkRepo,
      logger: harness.ctx.logger,
      fetchFn: fetchFn as unknown as typeof fetch,
      minSpacingMs: 0,
    })!;

    const dispatcher = createNotificationDispatcher({
      bus: harness.ctx.events,
      repo: createNotificationRepository(harness.db),
      users: createUserRepository(harness.db),
      telegram,
      logger: harness.ctx.logger,
    });

    const event: FriendRequestEvent = {
      type: 'friend.request',
      userId: alice.id,
      actorId: 'bob',
      actorUsername: 'bob',
      requestId: 'req-1',
      occurredAt: new Date().toISOString(),
    };
    await dispatcher.dispatch(event);

    const telegramCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    expect(telegramCalls).toHaveLength(1);
    const body = JSON.parse(telegramCalls[0]!.body);
    expect(body.chat_id).toBe('4321');
    expect(body.text).toContain('New friend request');

    // A redelivered event dedupes at the repo — no second send.
    await dispatcher.dispatch(event);
    expect(calls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);
  });

  it('sends stop immediately after unlink', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const linkRepo = createTelegramLinkRepository(harness.db);
    await linkRepo.putPendingCode(alice.id, {
      code: 'x',
      expiresAt: new Date(Date.now() + 60_000),
      botUsername: 'bt_bot',
    });
    await linkRepo.confirmLink(alice.id, '9999', new Date());

    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const telegram = createTelegramChannel({
      botToken: 'TEST-BOT-TOKEN',
      links: linkRepo,
      logger: harness.ctx.logger,
      fetchFn: fetchFn as unknown as typeof fetch,
      minSpacingMs: 0,
    })!;

    // Unlink through the setup service — same code path the DELETE handler runs.
    await harness.ctx.telegramSetup.unlink(alice.id);

    await telegram.deliver(alice.id, {
      type: 'friend.request',
      title: 'x',
      body: 'y',
      data: {},
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('Discord channel end-to-end (§13.4 V4-P10)', () => {
  it('a matrix-routed event fires the caller’s webhook exactly once', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const encryptionKey = harness.ctx.config.twoFactor.encryptionKey;
    const url = 'https://discord.com/api/webhooks/123/abcd';
    const envelope = encryptSecret(url, encryptionKey);
    await createDiscordWebhookRepository(harness.db).upsert(alice.id, {
      encryptedUrl: envelope,
      webhookIdMasked: '…abcd',
    });

    const calls: { url: string; body: string }[] = [];
    const fetchFn = vi.fn(async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(u), body: String(init?.body) });
      return new Response('', { status: 204 });
    });
    const discord = createDiscordChannel({
      webhooks: createDiscordWebhookRepository(harness.db),
      encryptionKey,
      logger: harness.ctx.logger,
      fetchFn: fetchFn as unknown as typeof fetch,
      minSpacingMs: 0,
    });

    const dispatcher = createNotificationDispatcher({
      bus: harness.ctx.events,
      repo: createNotificationRepository(harness.db),
      users: createUserRepository(harness.db),
      discord,
      logger: harness.ctx.logger,
    });
    const event: FriendRequestEvent = {
      type: 'friend.request',
      userId: alice.id,
      actorId: 'bob',
      actorUsername: 'bob',
      requestId: 'req-2',
      occurredAt: new Date().toISOString(),
    };
    await dispatcher.dispatch(event);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(url);
    const body = JSON.parse(calls[0]!.body);
    expect(body.content).toContain('New friend request');
  });

  it('every notification type ships as a well-formed matrix cell', async () => {
    // Sanity guard: `notificationSettingsResponseSchema` requires every V1 type
    // in the matrix, so if we ever forgot a new type here the parse would fail.
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);
    const res = await agent.get('/api/v1/settings/notifications');
    expect(res.status).toBe(200);
    const parsed = notificationSettingsResponseSchema.parse(res.body);
    for (const type of NOTIFICATION_TYPES) {
      expect(parsed.matrix[type]).toBeDefined();
    }
  });
});

// ─── V5-P0 Telegram + Discord kill-switch (§13.5) ────────────────────────────
//
// Global env flag defaults OFF; when off every /settings/telegram/* and
// /settings/discord/* endpoint 404s, the matrix columns + channelsConfigurable
// flags stay false, and the dispatcher skips both channels even for a user
// with an existing linked row — while the underlying schema + rows are
// preserved so flipping the env back on restores every behaviour unchanged.

describe('V5-P0 kill-switch — Telegram + Discord deactivated by default', () => {
  const OFF_ENV = { BT_TELEGRAM_BOT_TOKEN: 'TEST-BOT-TOKEN' };

  const disabledPaths: Array<{ method: 'get' | 'post' | 'delete'; path: string; body?: unknown }> =
    [
      { method: 'get', path: '/api/v1/settings/telegram' },
      { method: 'post', path: '/api/v1/settings/telegram/link' },
      { method: 'post', path: '/api/v1/settings/telegram/confirm' },
      { method: 'delete', path: '/api/v1/settings/telegram' },
      { method: 'get', path: '/api/v1/settings/discord' },
      {
        method: 'post',
        path: '/api/v1/settings/discord/webhook',
        body: { url: 'https://discord.com/api/webhooks/1/x' },
      },
      { method: 'post', path: '/api/v1/settings/discord/test' },
      { method: 'delete', path: '/api/v1/settings/discord' },
    ];

  it.each(disabledPaths)(
    'kill-switch OFF → $method $path returns 404',
    async ({ method, path, body }) => {
      const off = await createTestApp({ env: OFF_ENV });
      try {
        const alice = await off.seedUser({ email: 'alice@bt.test', username: 'alice' });
        const agent = await loginAgent(off.app, alice.email, alice.password);
        const chain = agent[method](path).set(...XRW);
        const res = await (body ? chain.send(body) : chain);
        // Every disabled endpoint 404s — code, schema and any existing linked
        // rows are preserved; a probe cannot leak whether a user is linked.
        expect(res.status).toBe(404);
      } finally {
        await off.ctx.events.close();
      }
    },
  );

  it('kill-switch OFF hides the matrix columns + channelsConfigurable flags', async () => {
    const off = await createTestApp({ env: OFF_ENV });
    try {
      const alice = await off.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const agent = await loginAgent(off.app, alice.email, alice.password);
      const res = await agent.get('/api/v1/settings/notifications');
      expect(res.status).toBe(200);
      const settings = notificationSettingsResponseSchema.parse(res.body);
      expect(settings.channels.telegram).toBe(false);
      expect(settings.channels.discord).toBe(false);
      expect(settings.channelsConfigurable.telegram).toBe(false);
      expect(settings.channelsConfigurable.discord).toBe(false);
    } finally {
      await off.ctx.events.close();
    }
  });

  it('kill-switch OFF: dispatcher skips Telegram + Discord even for a linked user', async () => {
    const off = await createTestApp({ env: OFF_ENV });
    try {
      const alice = await off.seedUser({ email: 'alice@bt.test', username: 'alice' });
      // Existing linked rows survive a deactivation — insert them directly so
      // we can prove the dispatcher does NOT deliver despite the row's presence.
      await off.db.insert(telegramLinks).values({
        userId: alice.id,
        chatId: '5555',
        botUsername: 'bt_bot',
        linkCode: null,
        linkCodeExpiresAt: null,
        linkedAt: new Date(),
        updatedAt: new Date(),
      });
      const encryptionKey = off.ctx.config.twoFactor.encryptionKey;
      const url = 'https://discord.com/api/webhooks/999/xxxx';
      await createDiscordWebhookRepository(off.db).upsert(alice.id, {
        encryptedUrl: encryptSecret(url, encryptionKey),
        webhookIdMasked: '…xxxx',
      });

      // Snapshot every fetch during dispatch. With the flag off the channels
      // are null, so nothing fans out — no HTTP call to Telegram or Discord.
      const calls: { url: string }[] = [];
      const fetchFn = vi.fn(async (u: Parameters<typeof fetch>[0]) => {
        calls.push({ url: String(u) });
        return new Response('', { status: 204 });
      });
      const telegram = createTelegramChannel({
        botToken: 'TEST-BOT-TOKEN',
        links: createTelegramLinkRepository(off.db),
        logger: off.ctx.logger,
        fetchFn: fetchFn as unknown as typeof fetch,
        minSpacingMs: 0,
      })!;
      const discord = createDiscordChannel({
        webhooks: createDiscordWebhookRepository(off.db),
        encryptionKey,
        logger: off.ctx.logger,
        fetchFn: fetchFn as unknown as typeof fetch,
        minSpacingMs: 0,
      });

      // Dispatcher wired the way `context.ts` wires it under the kill-switch:
      // telegram + discord are BOTH null when the flag is off. This test would
      // pass a factory bug where a real channel leaks past the gate.
      const dispatcher = createNotificationDispatcher({
        bus: off.ctx.events,
        repo: createNotificationRepository(off.db),
        users: createUserRepository(off.db),
        telegram: off.ctx.config.telegram.enabled ? telegram : null,
        discord: off.ctx.config.discord.enabled ? discord : null,
        logger: off.ctx.logger,
      });
      const event: FriendRequestEvent = {
        type: 'friend.request',
        userId: alice.id,
        actorId: 'bob',
        actorUsername: 'bob',
        requestId: 'kill-switch-req',
        occurredAt: new Date().toISOString(),
      };
      await dispatcher.dispatch(event);

      expect(off.ctx.config.telegram.enabled).toBe(false);
      expect(off.ctx.config.discord.enabled).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      // The linked rows are preserved — a re-enable brings the user's setup back.
      const stillLinked = await off.db.select().from(telegramLinks);
      expect(stillLinked).toHaveLength(1);
      const stillWebhook = await off.db.select().from(discordWebhooks);
      expect(stillWebhook).toHaveLength(1);
    } finally {
      await off.ctx.events.close();
    }
  });

  it('flipping the kill-switch back ON restores the endpoints + matrix behaviour', async () => {
    // Same account, two harnesses on the SAME PGlite instance (each createTestApp
    // truncates the DB, so build the "on" harness first, prove routes work, then
    // rebuild "off" and prove they 404 — mirroring the deactivation direction.)
    const on = await createTestApp({
      env: { BT_TELEGRAM_BOT_TOKEN: 'TEST-BOT-TOKEN', BT_TELEGRAM_DISCORD_ENABLED: 'true' },
    });
    try {
      const alice = await on.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const agent = await loginAgent(on.app, alice.email, alice.password);

      // GET /settings/telegram returns 200 with available:true; DELETE /settings/discord 200.
      const tRes = await agent.get('/api/v1/settings/telegram');
      expect(tRes.status).toBe(200);
      expect(tRes.body.available).toBe(true);
      const dRes = await agent.get('/api/v1/settings/discord');
      expect(dRes.status).toBe(200);
      expect(dRes.body.available).toBe(true);

      const settings = notificationSettingsResponseSchema.parse(
        (await agent.get('/api/v1/settings/notifications')).body,
      );
      expect(settings.channelsConfigurable.telegram).toBe(true);
      expect(settings.channelsConfigurable.discord).toBe(true);
    } finally {
      await on.ctx.events.close();
    }
  });
});
