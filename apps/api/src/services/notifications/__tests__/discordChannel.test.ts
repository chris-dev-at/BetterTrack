import { createHash } from 'node:crypto';

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../config/env';
import type { DiscordWebhookRepository } from '../../../data/repositories/discordWebhookRepository';
import type { Logger } from '../../../logger';
import { createSecretBoxKeyring, encryptSecret } from '../../crypto/secretBox';
import { createDiscordChannel } from '../discordChannel';
import type { PushMessage } from '../fcm';
import { createDiscordSetupService } from '../discordSetupService';

const logger = pino({ level: 'silent' }) as unknown as Logger;
const ENCRYPTION_KEY = createHash('sha256').update('discord-channel-test-key').digest();
const ENCRYPTION = createSecretBoxKeyring({
  active: { id: 'discord_current', key: ENCRYPTION_KEY },
});

function webhookRepo(initial?: {
  encryptedUrl: string;
  webhookIdMasked: string;
}): DiscordWebhookRepository & { deleted: string[]; upserted: unknown[] } {
  let row = initial
    ? {
        userId: 'user-1',
        encryptedUrl: initial.encryptedUrl,
        webhookIdMasked: initial.webhookIdMasked,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    : null;
  const deleted: string[] = [];
  const upserted: unknown[] = [];
  return {
    deleted,
    upserted,
    async findForUser() {
      return row;
    },
    async listSecretEnvelopes() {
      return row ? [{ userId: row.userId, envelope: row.encryptedUrl }] : [];
    },
    async replaceSecretEnvelope(userId, expectedEnvelope, replacementEnvelope) {
      if (!row || row.userId !== userId || row.encryptedUrl !== expectedEnvelope) return false;
      row = { ...row, encryptedUrl: replacementEnvelope, updatedAt: new Date() };
      return true;
    },
    async upsert(userId, params) {
      upserted.push({ userId, ...params });
      row = { userId, ...params, createdAt: new Date(), updatedAt: new Date() };
    },
    async deleteForUser(userId) {
      deleted.push(userId);
      row = null;
    },
  };
}

const WEBHOOK_URL = 'https://discord.com/api/webhooks/12345/tok-abc';
const MESSAGE: PushMessage = {
  type: 'alert.triggered',
  title: 'Price alert: AAPL',
  body: 'AAPL is above 100.',
  data: { alertId: 'a1', assetId: 'x1' },
};

interface StubbedFetch {
  fn: ReturnType<typeof vi.fn>;
  calls: { url: string; init?: RequestInit }[];
}

function fetchStub(
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
): StubbedFetch {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const fn = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    const noBodyStatus = next.status === 204 || next.status === 205 || next.status === 304;
    const body = noBodyStatus ? null : (next.body ?? '');
    return new Response(body, { status: next.status, headers: next.headers });
  });
  return { fn, calls };
}

describe('Discord channel (V4-P10)', () => {
  it('delivers to the caller’s saved webhook with a bold-titled message', async () => {
    const envelope = encryptSecret(WEBHOOK_URL, ENCRYPTION_KEY);
    const repo = webhookRepo({ encryptedUrl: envelope, webhookIdMasked: '…abcd' });
    const { fn, calls } = fetchStub([{ status: 204 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });
    await channel.deliver('user-1', MESSAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK_URL);
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.content).toBe('**Price alert: AAPL**\nAAPL is above 100.');
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it.each([
    ['everyone', '@everyone'],
    ['here', '@here'],
    ['user', '<@123456789012345678>'],
    ['role', '<@&123456789012345678>'],
  ])('keeps %s mention syntax inert in outbound payloads', async (_kind, text) => {
    const repo = webhookRepo();
    const { fn, calls } = fetchStub([{ status: 204 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });

    expect(await channel.probe(WEBHOOK_URL, text)).toBe('ok');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toEqual({
      content: text,
      allowed_mentions: { parse: [] },
    });
  });

  it('prunes the webhook when Discord answers 404 (webhook gone) or 401 (revoked)', async () => {
    const envelope = encryptSecret(WEBHOOK_URL, ENCRYPTION_KEY);
    const repo = webhookRepo({ encryptedUrl: envelope, webhookIdMasked: '…abcd' });
    const { fn } = fetchStub([{ status: 404 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });
    await channel.deliver('user-1', MESSAGE);
    expect(repo.deleted).toEqual(['user-1']);
  });

  it('honours a 429 Retry-After and retries once', async () => {
    const envelope = encryptSecret(WEBHOOK_URL, ENCRYPTION_KEY);
    const repo = webhookRepo({ encryptedUrl: envelope, webhookIdMasked: '…abcd' });
    const { fn, calls } = fetchStub([
      { status: 429, headers: { 'retry-after': '0.5' } },
      { status: 204 },
    ]);
    const sleep = vi.fn(async () => undefined);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      sleep,
      minSpacingMs: 0,
      maxRetryAfterMs: 5_000,
    });
    await channel.deliver('user-1', MESSAGE);
    // First-time 429 + Retry-After → sleep of ~500ms and one retry.
    expect(sleep).toHaveBeenCalledWith(500);
    expect(calls).toHaveLength(2);
    expect(calls.map(({ init }) => JSON.parse(String(init!.body)).allowed_mentions)).toEqual([
      { parse: [] },
      { parse: [] },
    ]);
  });

  it('probe returns “ok” without touching the repository', async () => {
    const repo = webhookRepo();
    const { fn } = fetchStub([{ status: 204 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });
    expect(await channel.probe(WEBHOOK_URL, 'hello')).toBe('ok');
    expect(repo.upserted).toEqual([]);
    expect(repo.deleted).toEqual([]);
  });

  it('never logs the webhook URL on send failure', async () => {
    const warn = vi.fn();
    const envelope = encryptSecret(WEBHOOK_URL, ENCRYPTION_KEY);
    const repo = webhookRepo({ encryptedUrl: envelope, webhookIdMasked: '…abcd' });
    const { fn } = fetchStub([{ status: 500 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION,
      logger: { ...logger, warn } as unknown as Logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });
    await channel.deliver('user-1', MESSAGE);
    for (const call of warn.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('tok-abc');
      expect(serialized).not.toContain('discord.com/api/webhooks');
    }
  });

  it('no-ops for a user with no saved webhook (no HTTP call)', async () => {
    const repo = webhookRepo();
    const { fn, calls } = fetchStub([{ status: 204 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });
    await channel.deliver('u', MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it('delivers records written by a previous data key during rotation', async () => {
    const previousKey = createHash('sha256').update('previous-discord-data-key').digest();
    const previousWriter = createSecretBoxKeyring({
      active: { id: 'discord_previous', key: previousKey },
    });
    const rotated = createSecretBoxKeyring({
      active: { id: 'discord_current', key: ENCRYPTION_KEY },
      previous: [{ id: 'discord_previous', key: previousKey }],
    });
    const repo = webhookRepo({
      encryptedUrl: encryptSecret(WEBHOOK_URL, previousWriter),
      webhookIdMasked: '…abcd',
    });
    const { fn, calls } = fetchStub([{ status: 204 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: rotated,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });

    await channel.deliver('user-1', MESSAGE);
    expect(calls[0]!.url).toBe(WEBHOOK_URL);
  });

  it('delivers a legacy webhook after SESSION_SECRET rotates to new,old', async () => {
    const oldCookieSecret = 'old-cookie-secret-value';
    const historicalKey = createHash('sha256').update(`bt-2fa:${oldCookieSecret}`).digest();
    const rotated = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      REDIS_URL: 'redis://test',
      SESSION_SECRET: `new-cookie-secret-value,${oldCookieSecret}`,
    }).recordEncryption;
    const repo = webhookRepo({
      encryptedUrl: encryptSecret(WEBHOOK_URL, historicalKey),
      webhookIdMasked: '…abcd',
    });
    const { fn, calls } = fetchStub([{ status: 204 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: rotated,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });

    await channel.deliver('user-1', MESSAGE);
    expect(calls[0]!.url).toBe(WEBHOOK_URL);
  });

  it('delivers a legacy webhook after SESSION_SECRET rotates to newer,new,old', async () => {
    const historicalSessionSecret = 'new-cookie-secret-value,old-cookie-secret-value';
    const historicalKey = createHash('sha256').update(`bt-2fa:${historicalSessionSecret}`).digest();
    const rotated = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      REDIS_URL: 'redis://test',
      SESSION_SECRET: `newest-cookie-secret-value,${historicalSessionSecret}`,
    }).recordEncryption;
    const repo = webhookRepo({
      encryptedUrl: encryptSecret(WEBHOOK_URL, historicalKey),
      webhookIdMasked: '…abcd',
    });
    const { fn, calls } = fetchStub([{ status: 204 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: rotated,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });

    await channel.deliver('user-1', MESSAGE);
    expect(calls[0]!.url).toBe(WEBHOOK_URL);
  });

  it('fails closed without making a request for unknown or tampered envelopes', async () => {
    const unknownWriter = createSecretBoxKeyring({
      active: { id: 'unknown', key: Buffer.alloc(32, 0x77) },
    });
    const validUnknown = encryptSecret(WEBHOOK_URL, unknownWriter);
    const parts = encryptSecret(WEBHOOK_URL, ENCRYPTION).split('.');
    parts[4] = `${parts[4]![0] === 'A' ? 'B' : 'A'}${parts[4]!.slice(1)}`;

    for (const envelope of [validUnknown, parts.join('.')]) {
      const repo = webhookRepo({ encryptedUrl: envelope, webhookIdMasked: '…abcd' });
      const { fn, calls } = fetchStub([{ status: 204 }]);
      const channel = createDiscordChannel({
        webhooks: repo,
        encryptionKey: ENCRYPTION,
        logger,
        fetchFn: fn as unknown as typeof fetch,
        minSpacingMs: 0,
      });
      await channel.deliver('user-1', MESSAGE);
      expect(calls).toHaveLength(0);
    }
  });

  it('setup writes only a v2 envelope under the active data-key id', async () => {
    const repo = webhookRepo();
    const setup = createDiscordSetupService({
      enabled: true,
      webhooks: repo,
      encryptionKey: ENCRYPTION,
      logger,
      channel: {
        async deliver() {},
        async sendTest() {
          return 'ok';
        },
        async probe() {
          return 'ok';
        },
      },
    });

    await setup.save('user-1', WEBHOOK_URL);
    const stored = await repo.findForUser('user-1');
    expect(stored!.encryptedUrl).toMatch(/^v2\.discord_current\./);
  });
});
