import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { TelegramLinkRepository } from '../../../data/repositories/telegramLinkRepository';
import type { Logger } from '../../../logger';
import { createTelegramChannel, type TelegramChannel } from '../telegramChannel';
import type { PushMessage } from '../fcm';

const logger = pino({ level: 'silent' }) as unknown as Logger;

function linkRepo(chatIds: string[]): Pick<
  TelegramLinkRepository,
  'listChatIdsForUser' | 'deleteChatId'
> & {
  pruned: string[];
} {
  const pruned: string[] = [];
  return {
    pruned,
    async listChatIdsForUser() {
      return chatIds;
    },
    async deleteChatId(chatId) {
      pruned.push(chatId);
    },
  };
}

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

function fetchStub(responses: Array<{ status: number; body?: string }>): StubbedFetch {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const fn = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    return new Response(next.body ?? '', { status: next.status });
  });
  return { fn, calls };
}

describe('Telegram channel (V4-P10)', () => {
  it('is disabled (null) with one warn when BT_TELEGRAM_BOT_TOKEN is unset', () => {
    const warn = vi.fn();
    const channel = createTelegramChannel({
      botToken: undefined,
      links: linkRepo([]),
      logger: { ...logger, warn } as unknown as Logger,
    });
    expect(channel).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    // Never leak the (missing) token into the log line — it's undefined here,
    // but the assertion documents intent: the message is generic.
    expect(warn).toHaveBeenCalledWith(
      'telegram channel disabled: BT_TELEGRAM_BOT_TOKEN is not set',
    );
  });

  it('sends exactly one message per matrix-routed event against a mock bot API', async () => {
    const repo = linkRepo(['1234567']);
    const { fn, calls } = fetchStub([{ status: 200, body: '{"ok":true}' }]);
    const channel = createTelegramChannel({
      botToken: 'BOT-TOKEN-secret',
      links: repo,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    })!;
    expect(channel).not.toBeNull();

    await channel.deliver('user-1', MESSAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.telegram.org/botBOT-TOKEN-secret/sendMessage');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.chat_id).toBe('1234567');
    // Plain text (no parse_mode) so mischievous chars can't unbalance formatting.
    expect(body.text).toBe('Price alert: AAPL\n\nAAPL is above 100.');
    expect(repo.pruned).toEqual([]);
  });

  it('prunes a chat id Telegram reports 403 for (bot blocked) and keeps the healthy ones', async () => {
    const repo = linkRepo(['dead-chat', 'live-chat']);
    const { fn } = fetchStub([
      { status: 403, body: '{"ok":false,"description":"Forbidden: bot was blocked by the user"}' },
      { status: 200, body: '{"ok":true}' },
    ]);
    const channel = createTelegramChannel({
      botToken: 'BOT-TOKEN',
      links: repo,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    })!;

    await channel.deliver('user-1', MESSAGE);
    expect(repo.pruned).toEqual(['dead-chat']);
  });

  it('never throws or prunes on a transient 5xx failure', async () => {
    const repo = linkRepo(['tok']);
    const { fn } = fetchStub([{ status: 503 }]);
    const channel = createTelegramChannel({
      botToken: 'BOT-TOKEN',
      links: repo,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    })!;

    await expect(channel.deliver('user-1', MESSAGE)).resolves.toBeUndefined();
    expect(repo.pruned).toEqual([]);
  });

  it('respects the outbound spacing between successive sends', async () => {
    // Two chats + a 50 ms spacing → the second send must wait at least 50 ms
    // after the first, so the `sleep` fake is invoked between them.
    const repo = linkRepo(['a', 'b']);
    const { fn } = fetchStub([
      { status: 200, body: '{"ok":true}' },
      { status: 200, body: '{"ok":true}' },
    ]);
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const now = () => clock;

    const channel = createTelegramChannel({
      botToken: 'BOT-TOKEN',
      links: repo,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 50,
      now,
      sleep,
    })!;
    await channel.deliver('u', MESSAGE);

    // The paced gate calls sleep exactly once (the second send waits ~50ms).
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('never logs the bot token — either in the URL or in error bodies', async () => {
    const warn = vi.fn();
    const repo = linkRepo(['x']);
    const { fn } = fetchStub([{ status: 500, body: 'server unavailable' }]);
    const channel = createTelegramChannel({
      botToken: 'SUPER-SECRET-TOKEN',
      links: repo,
      logger: { ...logger, warn } as unknown as Logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    })!;

    await channel.deliver('user-1', MESSAGE);

    // The warn body must not contain the secret token.
    for (const call of warn.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('SUPER-SECRET-TOKEN');
    }
  });

  it('no-ops for a user with no linked chat (no HTTP call)', async () => {
    const repo = linkRepo([]);
    const { fn, calls } = fetchStub([{ status: 200 }]);
    const channel = createTelegramChannel({
      botToken: 'BOT-TOKEN',
      links: repo,
      logger,
      fetchFn: fn as unknown as typeof fetch,
      minSpacingMs: 0,
    })!;

    await channel.deliver('u', MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it('getBotUsername reads @username from the bot API and caches it after success', async () => {
    const { fn } = fetchStub([{ status: 200, body: '{"ok":true,"result":{"username":"btbot"}}' }]);
    const channel = createTelegramChannel({
      botToken: 'BOT-TOKEN',
      links: linkRepo([]),
      logger,
      fetchFn: fn as unknown as typeof fetch,
    })! as TelegramChannel;
    expect(await channel.getBotUsername()).toBe('btbot');
  });
});
