import { createHash } from 'node:crypto';

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { DiscordWebhookRepository } from '../../../data/repositories/discordWebhookRepository';
import type { Logger } from '../../../logger';
import { encryptSecret } from '../../crypto/secretBox';
import { createDiscordChannel } from '../discordChannel';
import type { PushMessage } from '../fcm';

const logger = pino({ level: 'silent' }) as unknown as Logger;
const ENCRYPTION_KEY = createHash('sha256').update('discord-channel-test-key').digest();

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
      encryptionKey: ENCRYPTION_KEY,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });
    await channel.deliver('user-1', MESSAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK_URL);
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.content).toBe('**Price alert: AAPL**\nAAPL is above 100.');
  });

  it('prunes the webhook when Discord answers 404 (webhook gone) or 401 (revoked)', async () => {
    const envelope = encryptSecret(WEBHOOK_URL, ENCRYPTION_KEY);
    const repo = webhookRepo({ encryptedUrl: envelope, webhookIdMasked: '…abcd' });
    const { fn } = fetchStub([{ status: 404 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION_KEY,
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
      encryptionKey: ENCRYPTION_KEY,
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
  });

  it('probe returns “ok” without touching the repository', async () => {
    const repo = webhookRepo();
    const { fn } = fetchStub([{ status: 204 }]);
    const channel = createDiscordChannel({
      webhooks: repo,
      encryptionKey: ENCRYPTION_KEY,
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
      encryptionKey: ENCRYPTION_KEY,
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
      encryptionKey: ENCRYPTION_KEY,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    });
    await channel.deliver('u', MESSAGE);
    expect(calls).toHaveLength(0);
  });
});
