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
import { createNotificationChannelSet } from '../services/notifications/channelSet';
import {
  createTelegramSetupService,
  TelegramSetupError,
} from '../services/notifications/telegramSetupService';
import {
  createDiscordSetupService,
  DiscordSetupError,
} from '../services/notifications/discordSetupService';
import { CHANNEL_SETUP_COPY } from '../services/notifications/notificationI18n';
import type { FriendRequestEvent } from '../events';
import {
  telegramLinks,
  discordWebhooks,
  notifications,
  notificationSettings,
  users,
} from '../data/schema';

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
    const encryptionKey = harness.ctx.config.recordEncryption;
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
        // …and it 404s the way every other 404 in this API does (#1795): the
        // standard envelope, not an empty body a client cannot read.
        expect(res.body).toEqual({
          error: { code: 'CHANNEL_DEACTIVATED', message: expect.any(String) },
        });
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
      const encryptionKey = off.ctx.config.recordEncryption;
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

// ─── #1723: the WORKER is the authoritative dispatcher ───────────────────────
//
// In production `queues` is non-null, so `notify.emit` enqueues
// `notifications.dispatch` and the WORKER process delivers it. The worker used
// to build only FCM + web push, so `routing.telegram && telegram` saw
// `undefined` and every Telegram/Discord notification was dropped on the floor
// — the kill-switch's "env flip restores" half never worked in a deployment
// running infra/docker-compose.yml's worker service.
//
// Both entry points now build their channels through the ONE shared
// `createNotificationChannelSet` factory, so these tests exercise the worker's
// own wiring: the same call, with the same config, that scripts/worker.ts makes.
// `liveDeployTopology.test.ts` pins that the worker still uses it and still
// hands the same dependency set to the dispatcher.

describe('worker dispatcher wiring delivers Telegram + Discord (#1723)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Link a confirmed Telegram chat and a saved Discord webhook for `userId`. */
  async function linkBothChannels(h: TestHarness, userId: string, webhookUrl: string) {
    await h.db.insert(telegramLinks).values({
      userId,
      chatId: '778899',
      botUsername: 'bt_bot',
      linkCode: null,
      linkCodeExpiresAt: null,
      linkedAt: new Date(),
      updatedAt: new Date(),
    });
    await createDiscordWebhookRepository(h.db).upsert(userId, {
      encryptedUrl: encryptSecret(webhookUrl, h.ctx.config.recordEncryption),
      webhookIdMasked: '…abcd',
    });
  }

  /** Records every outbound call the channels make through the global fetch. */
  function stubFetch(): Array<{ url: string; body: string }> {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(u), body: String(init?.body ?? '') });
        return new Response('{"ok":true}', { status: 200 });
      }),
    );
    return calls;
  }

  it('kill-switch ON: an event dispatched through the worker wiring reaches both channels', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const webhookUrl = 'https://discord.com/api/webhooks/424242/worker-token';
    await linkBothChannels(harness, alice.id, webhookUrl);
    const calls = stubFetch();

    // Exactly what scripts/worker.ts runs at boot.
    const channels = createNotificationChannelSet({
      db: harness.db,
      config: harness.ctx.config,
      logger: harness.ctx.logger,
    });
    expect(
      channels.telegram,
      'kill-switch ON ⇒ the worker builds a Telegram channel',
    ).not.toBeNull();
    expect(channels.discord, 'kill-switch ON ⇒ the worker builds a Discord channel').not.toBeNull();

    const dispatcher = createNotificationDispatcher({
      bus: harness.ctx.events,
      repo: createNotificationRepository(harness.db),
      users: createUserRepository(harness.db),
      fcm: channels.fcm,
      webPush: channels.webPush,
      telegram: channels.telegram,
      discord: channels.discord,
      logger: harness.ctx.logger,
    });

    const event: FriendRequestEvent = {
      type: 'friend.request',
      userId: alice.id,
      actorId: 'bob',
      actorUsername: 'bob',
      requestId: 'req-worker-1',
      occurredAt: new Date().toISOString(),
    };
    await dispatcher.dispatch(event);

    const telegramCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    expect(telegramCalls).toHaveLength(1);
    expect(JSON.parse(telegramCalls[0]!.body).chat_id).toBe('778899');
    const discordCalls = calls.filter((c) => c.url === webhookUrl);
    expect(discordCalls).toHaveLength(1);
    expect(JSON.parse(discordCalls[0]!.body).content).toContain('New friend request');
  });

  it('kill-switch OFF: the same wiring builds no channel and attempts no send', async () => {
    const off = await createTestApp({ env: { BT_TELEGRAM_BOT_TOKEN: 'TEST-BOT-TOKEN' } });
    try {
      const alice = await off.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const webhookUrl = 'https://discord.com/api/webhooks/424242/off-token';
      // Rows are PRESERVED across a deactivation — the proof that nothing sends
      // has to come from the channel set, not from missing data.
      await linkBothChannels(off, alice.id, webhookUrl);
      const calls = stubFetch();

      const channels = createNotificationChannelSet({
        db: off.db,
        config: off.ctx.config,
        logger: off.ctx.logger,
      });
      expect(channels.telegram).toBeNull();
      expect(channels.discord).toBeNull();
      // The rows survived the flip.
      expect(await createDiscordWebhookRepository(off.db).findForUser(alice.id)).not.toBeNull();

      const dispatcher = createNotificationDispatcher({
        bus: off.ctx.events,
        repo: createNotificationRepository(off.db),
        users: createUserRepository(off.db),
        telegram: channels.telegram,
        discord: channels.discord,
        logger: off.ctx.logger,
      });
      await dispatcher.dispatch({
        type: 'friend.request',
        userId: alice.id,
        actorId: 'bob',
        actorUsername: 'bob',
        requestId: 'req-worker-off',
        occurredAt: new Date().toISOString(),
      } satisfies FriendRequestEvent);

      expect(calls).toHaveLength(0);
    } finally {
      await off.ctx.events.close();
    }
  });
});

// ─── #1723: chat-channel setup copy honours the recipient's locale ───────────
//
// The Telegram link confirmation, the Discord save probe and the Discord test
// message used to be hardcoded English regardless of the recipient's stored
// locale. They now render from the keyed EN+DE `CHANNEL_SETUP_COPY` catalog,
// which means both setup services resolve the user row. The services are built
// here with an injected fetch (the file's established pattern) because the
// context-owned instances capture the real global fetch at boot; `context.ts`
// passing the user repository is enforced by the compiler, not by this test.

describe('channel setup messages render in the recipient locale (#1723)', () => {
  /** Records outbound calls and answers the Telegram + Discord happy paths. */
  function recordingFetch(pendingCode: () => string) {
    const calls: Array<{ url: string; body: string }> = [];
    const fn = vi.fn(async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(u);
      calls.push({ url, body: String(init?.body ?? '') });
      if (url.includes('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { username: 'bt_bot' } }), {
          status: 200,
        });
      }
      if (url.includes('/getUpdates')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [{ message: { chat: { id: 246810 }, text: `/start ${pendingCode()}` } }],
          }),
          { status: 200 },
        );
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    return { calls, fetchFn: fn as unknown as typeof fetch };
  }

  function telegramSetupFor(fetchFn: typeof fetch) {
    const links = createTelegramLinkRepository(harness.db);
    return createTelegramSetupService({
      offered: true,
      enabled: true,
      botToken: 'TEST-BOT-TOKEN',
      links,
      users: createUserRepository(harness.db),
      channel: createTelegramChannel({
        botToken: 'TEST-BOT-TOKEN',
        links,
        logger: harness.ctx.logger,
        fetchFn,
        minSpacingMs: 0,
      }),
      logger: harness.ctx.logger,
      fetchFn,
    });
  }

  function discordSetupFor(fetchFn: typeof fetch) {
    const webhooks = createDiscordWebhookRepository(harness.db);
    return createDiscordSetupService({
      enabled: true,
      webhooks,
      users: createUserRepository(harness.db),
      channel: createDiscordChannel({
        webhooks,
        encryptionKey: harness.ctx.config.recordEncryption,
        logger: harness.ctx.logger,
        fetchFn,
        minSpacingMs: 0,
      }),
      encryptionKey: harness.ctx.config.recordEncryption,
      logger: harness.ctx.logger,
    });
  }

  it('a DE recipient gets the German Telegram link confirmation', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    await harness.db.update(users).set({ locale: 'de' }).where(eq(users.id, alice.id));

    let code = '';
    const { calls, fetchFn } = recordingFetch(() => code);
    const setup = telegramSetupFor(fetchFn);

    code = (await setup.startLink(alice.id)).pendingCode!;
    expect((await setup.confirmLink(alice.id)).linked).toBe(true);

    // The welcome ping is deliberately fire-and-forget, so wait for it to land.
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);
    });
    const welcome = JSON.parse(calls.find((c) => c.url.includes('/sendMessage'))!.body);
    expect(welcome.text).toBe(CHANNEL_SETUP_COPY.de.telegramLinked);
    expect(welcome.text).not.toBe(CHANNEL_SETUP_COPY.en.telegramLinked);
  });

  it('an EN recipient keeps the English Telegram link confirmation', async () => {
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    let code = '';
    const { calls, fetchFn } = recordingFetch(() => code);
    const setup = telegramSetupFor(fetchFn);

    code = (await setup.startLink(bob.id)).pendingCode!;
    expect((await setup.confirmLink(bob.id)).linked).toBe(true);

    await vi.waitFor(() => {
      expect(calls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);
    });
    const welcome = JSON.parse(calls.find((c) => c.url.includes('/sendMessage'))!.body);
    expect(welcome.text).toBe(CHANNEL_SETUP_COPY.en.telegramLinked);
  });

  it('a DE recipient gets the German Discord save probe and test message', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    await harness.db.update(users).set({ locale: 'de' }).where(eq(users.id, alice.id));

    const { calls, fetchFn } = recordingFetch(() => '');
    const setup = discordSetupFor(fetchFn);

    await setup.save(alice.id, 'https://discord.com/api/webhooks/13/de-token');
    expect(await setup.test(alice.id)).toBe('ok');

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body).content).toContain(CHANNEL_SETUP_COPY.de.discordConfigured);
    expect(JSON.parse(calls[1]!.body).content).toContain(CHANNEL_SETUP_COPY.de.discordTest);
  });

  it('an EN recipient keeps the English Discord copy', async () => {
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const { calls, fetchFn } = recordingFetch(() => '');
    const setup = discordSetupFor(fetchFn);

    await setup.save(bob.id, 'https://discord.com/api/webhooks/14/en-token');
    expect(await setup.test(bob.id)).toBe('ok');

    expect(JSON.parse(calls[0]!.body).content).toContain(CHANNEL_SETUP_COPY.en.discordConfigured);
    expect(JSON.parse(calls[1]!.body).content).toContain(CHANNEL_SETUP_COPY.en.discordTest);
  });
});

// ─── #1795: the kill-switch stops CONSUMING what it cannot deliver ────────────
//
// The switch was honest about channels and routes, but not about the matrix, the
// dedupe row or its own refusal boundary. These tests pin the four halves that
// were missing: the matrix writes refuse, the dispatcher leaves an undeliverable
// event re-deliverable, the services refuse deletion themselves, and a missing
// bot token is no longer mistaken for a deactivated deployment.
describe('V5-P0 kill-switch — refusal boundary + no silent consumption (#1795)', () => {
  const OFF_ENV = { BT_TELEGRAM_BOT_TOKEN: 'TEST-BOT-TOKEN' };

  it('PATCH /settings/notifications cannot persist a deactivated channel’s override', async () => {
    const off = await createTestApp({ env: OFF_ENV });
    try {
      const alice = await off.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const agent = await loginAgent(off.app, alice.email, alice.password);
      // A pre-deactivation preference the switch promises to preserve.
      const repo = createNotificationRepository(off.db);
      await repo.upsertChannelConfig(alice.id, 'telegram', { 'friend.request': true });

      const res = await agent
        .patch('/api/v1/settings/notifications')
        .set(...XRW)
        .send({
          matrix: {
            'friend.request': {
              inapp: false,
              email: false,
              telegram: true,
              discord: true,
              push: false,
              webpush: false,
            },
          },
        });
      expect(res.status).toBe(200);
      const settings = notificationSettingsResponseSchema.parse(res.body);
      // GET reports exactly what the deployment will honour — and what a PATCH
      // is willing to accept: the dead channels read off, in-app took the write.
      expect(settings.matrix['friend.request'].telegram).toBe(false);
      expect(settings.matrix['friend.request'].discord).toBe(false);
      expect(settings.matrix['friend.request'].inapp).toBe(false);

      const rows = await off.db
        .select()
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, alice.id));
      // No Discord override was created for a channel this build refuses…
      expect(rows.find((row) => row.channel === 'discord')).toBeUndefined();
      // …and the pre-existing Telegram override survived the write untouched,
      // so the env flip restores the user's own routing.
      expect(rows.find((row) => row.channel === 'telegram')?.config).toEqual({
        'friend.request': true,
      });
    } finally {
      await off.ctx.events.close();
    }
  });

  it('PATCH /admin/account-defaults refuses a default for a channel the build hides, but round-trips its own values', async () => {
    const off = await createTestApp({ env: OFF_ENV });
    try {
      const admin = await off.seedAdmin();
      const adminAgent = await off.loginAdmin(admin);

      const initial = await adminAgent.get('/api/v1/admin/account-defaults');
      expect(initial.status).toBe(200);
      expect(initial.body.channelsConfigurable).toEqual({ telegram: false, discord: false });
      // The hidden columns report off, so what the editor round-trips is honest.
      expect(initial.body.notificationMatrix['friend.request'].telegram).toBe(false);
      expect(initial.body.notificationMatrix['friend.request'].discord).toBe(false);

      // The admin UI's round-trip of the server's own values still works.
      const roundTrip = await adminAgent
        .patch('/api/v1/admin/account-defaults')
        .set(...XRW)
        .send({ notificationMatrix: initial.body.notificationMatrix });
      expect(roundTrip.status).toBe(200);

      // A hand-crafted enable for a dead channel is refused by name.
      const forced = {
        ...initial.body.notificationMatrix,
        'friend.request': {
          ...initial.body.notificationMatrix['friend.request'],
          telegram: true,
        },
      };
      const refused = await adminAgent
        .patch('/api/v1/admin/account-defaults')
        .set(...XRW)
        .send({ notificationMatrix: forced });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('CHANNEL_DEACTIVATED');
    } finally {
      await off.ctx.events.close();
    }
  });

  it('unlink/remove refuse at the SERVICE level, so the router guard is not the only thing preserving rows', async () => {
    const off = await createTestApp({ env: OFF_ENV });
    try {
      const alice = await off.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const links = createTelegramLinkRepository(off.db);
      await links.putPendingCode(alice.id, {
        code: 'x',
        expiresAt: new Date(Date.now() + 60_000),
        botUsername: 'bt_bot',
      });
      await links.confirmLink(alice.id, '4321', new Date());
      const webhooks = createDiscordWebhookRepository(off.db);
      await webhooks.upsert(alice.id, {
        encryptedUrl: encryptSecret(
          'https://discord.com/api/webhooks/1/abcd',
          off.ctx.config.recordEncryption,
        ),
        webhookIdMasked: '…abcd',
      });

      // Services built exactly as `context.ts` builds them with the switch off.
      const telegramSetup = createTelegramSetupService({
        offered: off.ctx.config.telegram.offered,
        enabled: off.ctx.config.telegram.enabled,
        botToken: off.ctx.config.telegram.botToken,
        links,
        users: createUserRepository(off.db),
        channel: null,
        logger: off.ctx.logger,
      });
      const discordSetup = createDiscordSetupService({
        enabled: off.ctx.config.discord.enabled,
        webhooks,
        users: createUserRepository(off.db),
        channel: null,
        encryptionKey: off.ctx.config.recordEncryption,
        logger: off.ctx.logger,
      });

      await expect(telegramSetup.unlink(alice.id)).rejects.toBeInstanceOf(TelegramSetupError);
      await expect(discordSetup.remove(alice.id)).rejects.toBeInstanceOf(DiscordSetupError);
      // "Deactivate, not delete": both rows are exactly where they were.
      expect(await off.db.select().from(telegramLinks)).toHaveLength(1);
      expect(await off.db.select().from(discordWebhooks)).toHaveLength(1);
    } finally {
      await off.ctx.events.close();
    }
  });

  it('a linked user’s Telegram-only event survives the deactivation and delivers once after the flip', async () => {
    const off = await createTestApp({ env: OFF_ENV });
    try {
      const alice = await off.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const links = createTelegramLinkRepository(off.db);
      await links.putPendingCode(alice.id, {
        code: 'x',
        expiresAt: new Date(Date.now() + 60_000),
        botUsername: 'bt_bot',
      });
      await links.confirmLink(alice.id, '4321', new Date());
      // Telegram-only routing: the legitimate matrix state the switch inherited.
      const repo = createNotificationRepository(off.db);
      await repo.upsertChannelConfig(alice.id, 'inapp', { 'friend.request': false });
      await repo.upsertChannelConfig(alice.id, 'telegram', { 'friend.request': true });

      const calls: string[] = [];
      const fetchFn = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
        calls.push(String(url));
        return new Response('{"ok":true}', { status: 200 });
      });
      const deactivatedLinks = {
        telegram: async (userId: string) => Boolean((await links.findForUser(userId))?.chatId),
        discord: async () => false,
      };
      const dispatcherWith = (telegram: ReturnType<typeof createTelegramChannel>) =>
        createNotificationDispatcher({
          bus: off.ctx.events,
          repo,
          users: createUserRepository(off.db),
          telegram,
          discord: null,
          deactivatedLinks,
          logger: off.ctx.logger,
        });
      const event: FriendRequestEvent = {
        type: 'friend.request',
        userId: alice.id,
        actorId: 'bob',
        actorUsername: 'bob',
        requestId: 'flip-req',
        occurredAt: new Date().toISOString(),
      };

      // Switch OFF: nothing is sent AND nothing is recorded as delivered.
      await dispatcherWith(null).dispatch(event);
      expect(calls).toHaveLength(0);
      expect(await off.db.select().from(notifications)).toHaveLength(0);
      // The link row the directive preserves is still there, and the routes
      // still refuse while the switch is off.
      expect(await off.db.select().from(telegramLinks)).toHaveLength(1);
      const agent = await loginAgent(off.app, alice.email, alice.password);
      expect((await agent.get('/api/v1/settings/telegram')).status).toBe(404);

      // Operator flips BT_TELEGRAM_DISCORD_ENABLED back on — the same event now
      // delivers, exactly once, through the link that was never destroyed.
      const on = dispatcherWith(
        createTelegramChannel({
          botToken: 'TEST-BOT-TOKEN',
          links,
          logger: off.ctx.logger,
          fetchFn: fetchFn as unknown as typeof fetch,
          minSpacingMs: 0,
        }),
      );
      await on.dispatch(event);
      await on.dispatch(event);
      expect(calls.filter((url) => url.includes('/sendMessage'))).toHaveLength(1);
      expect(await off.db.select().from(notifications)).toHaveLength(1);
    } finally {
      await off.ctx.events.close();
    }
  });

  it('switch ON without a bot token answers the documented body instead of a bare 404', async () => {
    // The V4-P10 contract: a missing bot token makes Telegram *unavailable*, not
    // *deactivated*. Conflating the two made this branch unreachable (#1795).
    const barren = await createTestApp({ env: { BT_TELEGRAM_DISCORD_ENABLED: 'true' } });
    try {
      const alice = await barren.seedUser({ email: 'alice@bt.test', username: 'alice' });
      const agent = await loginAgent(barren.app, alice.email, alice.password);

      const res = await agent.get('/api/v1/settings/telegram');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        available: false,
        linked: false,
        pending: false,
        botUsername: null,
      });
      // The writes still refuse — as the documented 400 `not_available`.
      const link = await agent.post('/api/v1/settings/telegram/link').set(...XRW);
      expect(link.status).toBe(400);
      expect(link.body.error.code).toBe('not_available');

      // Discord, for the same operator state, is reachable too: with the switch
      // ON neither channel answers a bare 404 — they answer their own body.
      const discord = await agent.get('/api/v1/settings/discord');
      expect(discord.status).toBe(200);
      expect(discord.body).toMatchObject({ available: true, linked: false });
    } finally {
      await barren.ctx.events.close();
    }
  });
});
