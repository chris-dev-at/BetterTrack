import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { PushSubscriptionRepository } from '../../../data/repositories/pushSubscriptionRepository';
import type { Logger } from '../../../logger';
import type { PushMessage } from '../fcm';
import { createPresenceStore, presenceKey } from '../presence';
import { createWebPushChannel, type WebPushTransport } from '../webPush';

const logger = pino({ level: 'silent' }) as unknown as Logger;

const MESSAGE: PushMessage = {
  type: 'chat.message',
  title: 'New message',
  body: 'anna: hi',
  data: { conversationId: 'c1', messageId: 'm1' },
};

function subsRepo(endpoints: string[]): PushSubscriptionRepository & { pruned: string[] } {
  const pruned: string[] = [];
  return {
    pruned,
    upsert: async () => undefined,
    deleteForUser: async () => undefined,
    async deleteByEndpoint(endpoint) {
      pruned.push(endpoint);
    },
    async listForUser(userId) {
      return endpoints.map((endpoint, i) => ({
        id: `s${i}`,
        userId,
        endpoint,
        p256dh: 'p',
        auth: 'a',
      }));
    },
  };
}

const VAPID = {
  enabled: true,
  publicKey: 'pub',
  privateKey: 'priv',
  subject: 'mailto:admin@bt.test',
};

describe('web-push channel (#368/#350)', () => {
  it('is disabled (null) with one warn when VAPID is unconfigured', () => {
    const warn = vi.fn();
    const channel = createWebPushChannel({
      vapid: { enabled: false, subject: 'mailto:x@y.z' },
      subscriptions: subsRepo([]),
      logger: { ...logger, warn } as unknown as Logger,
    });
    expect(channel).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sends the typed JSON payload to every stored subscription', async () => {
    const sent: { endpoint: string; payload: string }[] = [];
    const transport: WebPushTransport = {
      setVapidDetails: vi.fn(),
      async sendNotification(subscription, payload) {
        sent.push({ endpoint: subscription.endpoint, payload });
      },
    };
    const channel = createWebPushChannel({
      vapid: VAPID,
      subscriptions: subsRepo(['https://push.example/1', 'https://push.example/2']),
      logger,
      transport,
    });
    await channel!.deliver('user-1', MESSAGE);

    expect(sent.map((s) => s.endpoint)).toEqual([
      'https://push.example/1',
      'https://push.example/2',
    ]);
    const payload = JSON.parse(sent[0]!.payload);
    expect(payload).toEqual({
      type: 'chat.message',
      title: 'New message',
      body: 'anna: hi',
      data: { conversationId: 'c1', messageId: 'm1' },
    });
    expect(transport.setVapidDetails).toHaveBeenCalledWith('mailto:admin@bt.test', 'pub', 'priv');
  });

  it('prunes a subscription the push service reports 404/410, keeps others on errors', async () => {
    const repo = subsRepo(['https://push.example/dead', 'https://push.example/flaky']);
    const transport: WebPushTransport = {
      setVapidDetails: () => undefined,
      async sendNotification(subscription) {
        if (subscription.endpoint.endsWith('dead')) {
          throw Object.assign(new Error('gone'), { statusCode: 410 });
        }
        throw Object.assign(new Error('boom'), { statusCode: 500 });
      },
    };
    const channel = createWebPushChannel({
      vapid: VAPID,
      subscriptions: repo,
      logger,
      transport,
    });
    await expect(channel!.deliver('user-1', MESSAGE)).resolves.toBeUndefined();
    expect(repo.pruned).toEqual(['https://push.example/dead']);
  });
});

describe('presence store (#368)', () => {
  it('enter → present, leave → absent; keys carry the suppression TTL', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = createPresenceStore({ redis, ttlSeconds: 60 });

    expect(await store.isPresent('u1', 'chat', 'c1')).toBe(false);
    await store.enter('u1', 'chat', 'c1');
    expect(await store.isPresent('u1', 'chat', 'c1')).toBe(true);
    // TTL is armed, so a vanished client auto-clears — never stale suppression.
    expect(await redis.ttl(presenceKey('u1', 'chat', 'c1'))).toBeGreaterThan(0);
    expect(await redis.ttl(presenceKey('u1', 'chat', 'c1'))).toBeLessThanOrEqual(60);

    // Scoped per (user, surface, subject): other users/threads are unaffected.
    expect(await store.isPresent('u1', 'chat', 'c2')).toBe(false);
    expect(await store.isPresent('u2', 'chat', 'c1')).toBe(false);

    await store.leave('u1', 'chat', 'c1');
    expect(await store.isPresent('u1', 'chat', 'c1')).toBe(false);
  });

  it('re-entering refreshes the TTL (the heartbeat contract)', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = createPresenceStore({ redis, ttlSeconds: 60 });
    await store.enter('u1', 'chat', 'c1');
    await redis.expire(presenceKey('u1', 'chat', 'c1'), 5);
    await store.enter('u1', 'chat', 'c1');
    expect(await redis.ttl(presenceKey('u1', 'chat', 'c1'))).toBeGreaterThan(5);
  });
});
