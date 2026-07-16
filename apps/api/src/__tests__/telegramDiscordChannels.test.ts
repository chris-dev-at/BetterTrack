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
  harness = await createTestApp({
    env: { BT_TELEGRAM_BOT_TOKEN: 'TEST-BOT-TOKEN' },
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
    // A fresh harness with the bot token UNSET: telegram is unavailable, and
    // Discord is per-user (no saved webhook here).
    const barren = await createTestApp();
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
