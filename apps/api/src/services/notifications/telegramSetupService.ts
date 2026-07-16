import { randomBytes } from 'node:crypto';

import type {
  TelegramConfirmResponse,
  TelegramLinkResponse,
  TelegramSettingsResponse,
} from '@bettertrack/contracts';

import type { TelegramLinkRepository } from '../../data/repositories/telegramLinkRepository';
import type { Logger } from '../../logger';

import type { TelegramChannel } from './telegramChannel';

/**
 * User-facing Telegram setup surface (§13.4 V4-P10). Wraps the link handshake
 * (start / confirm / unlink) and reads the caller's current state. The bot
 * token is env-gated at the channel level; this service falls back cleanly to
 * an "unavailable" response when the channel is null so the routes don't
 * silently 500 on an unconfigured deployment.
 *
 * Handshake protocol:
 *  1. `/settings/telegram/link` — mint a fresh single-use code (10 min TTL),
 *     save it against the user, return the code + expiry so the SPA can build
 *     `https://t.me/<botUsername>?start=<code>`.
 *  2. User taps the deep link → Telegram opens the bot → user hits Start →
 *     Telegram POSTs `/start <code>` to the bot. Two options here:
 *      - the bot has a webhook wired in and the API stamps the chat id when
 *        the update arrives (out of scope for V4-P10 — no webhook hookup
 *        landing in this bundle); or
 *      - the API polls `getUpdates` on demand from the confirm endpoint so
 *        the whole handshake works without a public webhook. **We pick the
 *        latter here** (issue §Scope explicitly prefers on-demand verification).
 *  3. `/settings/telegram/confirm` — sweep `getUpdates` for a matching
 *     `text = "/start <code>"` message, extract the chat id, save it.
 *
 * The confirm sweep never blocks: on failure it returns `{ linked: false }`
 * and the SPA polls again. Successful confirms drop the code atomically.
 */

/** Length of the raw link code (bytes → base64url ~= 16 URL-safe chars). */
export const LINK_CODE_BYTES = 12;
/** Link codes expire after this many ms (10 minutes). */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export interface TelegramSetupService {
  get(userId: string): Promise<TelegramSettingsResponse>;
  startLink(userId: string): Promise<TelegramLinkResponse>;
  confirmLink(userId: string): Promise<TelegramConfirmResponse>;
  unlink(userId: string): Promise<TelegramSettingsResponse>;
  /**
   * Whether the caller currently has a confirmed chat id — the source of
   * truth `notificationSettingsService.channelAvailability.telegramFor` reads.
   */
  linkedFor(userId: string): Promise<boolean>;
}

export interface TelegramSetupServiceDeps {
  /** From `config.telegram`; disabled ⇒ every write is a `not_available`. */
  enabled: boolean;
  /** From `config.telegram.botToken`; used to call the Bot API's getUpdates. */
  botToken: string | undefined;
  links: TelegramLinkRepository;
  /** Null when the deployment has no bot token. */
  channel: TelegramChannel | null;
  logger: Logger;
  fetchFn?: typeof fetch;
  now?: () => Date;
  /** Overridable for tests (deterministic code). */
  generateCode?: () => string;
}

export function createTelegramSetupService(deps: TelegramSetupServiceDeps): TelegramSetupService {
  const { enabled, botToken, links, channel, logger } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const nowFn = deps.now ?? (() => new Date());
  const generateCode = deps.generateCode ?? defaultGenerateCode;
  // Cached bot username so `/settings/telegram` doesn't hit getMe on every read.
  let cachedBotUsername: string | null = null;

  async function readBotUsername(): Promise<string | null> {
    if (!channel) return null;
    if (cachedBotUsername) return cachedBotUsername;
    const fetched = await channel.getBotUsername();
    if (fetched) cachedBotUsername = fetched;
    return fetched;
  }

  async function toResponse(userId: string): Promise<TelegramSettingsResponse> {
    if (!enabled) {
      return {
        available: false,
        linked: false,
        pending: false,
        chatIdMasked: null,
        botUsername: null,
        pendingCode: null,
        pendingExpiresAt: null,
      };
    }
    const row = await links.findForUser(userId);
    const botUsername = row?.botUsername ?? (await readBotUsername());
    const linked = Boolean(row?.chatId);
    const now = nowFn();
    const pendingActive =
      Boolean(row?.linkCode) &&
      Boolean(row?.linkCodeExpiresAt) &&
      row!.linkCodeExpiresAt!.getTime() > now.getTime();
    return {
      available: true,
      linked,
      pending: pendingActive,
      chatIdMasked: linked ? maskChatId(row!.chatId!) : null,
      botUsername: botUsername ?? null,
      pendingCode: null,
      pendingExpiresAt: pendingActive ? row!.linkCodeExpiresAt!.toISOString() : null,
    };
  }

  return {
    async get(userId): Promise<TelegramSettingsResponse> {
      return toResponse(userId);
    },

    async linkedFor(userId): Promise<boolean> {
      if (!enabled) return false;
      const row = await links.findForUser(userId);
      return Boolean(row?.chatId);
    },

    async startLink(userId): Promise<TelegramLinkResponse> {
      if (!enabled || !channel) {
        throw new TelegramSetupError('not_available');
      }
      const code = generateCode();
      const now = nowFn();
      const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
      const botUsername = (await readBotUsername()) ?? 'bot';
      await links.putPendingCode(userId, { code, expiresAt, botUsername });
      return {
        available: true,
        linked: false,
        pending: true,
        chatIdMasked: null,
        botUsername,
        pendingCode: code,
        pendingExpiresAt: expiresAt.toISOString(),
      };
    },

    async confirmLink(userId): Promise<TelegramConfirmResponse> {
      if (!enabled || !botToken) {
        throw new TelegramSetupError('not_available');
      }
      const row = await links.findForUser(userId);
      const now = nowFn();
      if (
        !row?.linkCode ||
        !row.linkCodeExpiresAt ||
        row.linkCodeExpiresAt.getTime() <= now.getTime()
      ) {
        return { linked: false, settings: await toResponse(userId) };
      }
      const chatId = await pollForStart(botToken, row.linkCode, fetchFn, logger);
      if (!chatId) {
        return { linked: false, settings: await toResponse(userId) };
      }
      await links.confirmLink(userId, chatId, now);
      // Fire-and-forget welcome, so the user sees confirmation in the chat.
      if (channel) {
        // Never propagates — the confirm response should still succeed even
        // if the welcome ping flakes.
        void channel
          .send(chatId, 'BetterTrack — Telegram linked. You will receive your notifications here.')
          .catch(() => undefined);
      }
      return { linked: true, settings: await toResponse(userId) };
    },

    async unlink(userId): Promise<TelegramSettingsResponse> {
      await links.deleteForUser(userId);
      return toResponse(userId);
    },
  };
}

/** Poll the bot's `getUpdates` for a `/start <code>` message; returns the chat id. */
async function pollForStart(
  botToken: string,
  code: string,
  fetchFn: typeof fetch,
  logger: Logger,
): Promise<string | null> {
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${botToken}/getUpdates`, {
      method: 'GET',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      result?: Array<{ message?: { chat?: { id?: number | string }; text?: string } }>;
    };
    if (!body.ok || !Array.isArray(body.result)) return null;
    for (const update of body.result) {
      const text = update.message?.text ?? '';
      const chatId = update.message?.chat?.id;
      if (typeof chatId === 'undefined') continue;
      if (text.trim() === `/start ${code}` || text.trim() === `/start@bot ${code}`) {
        return String(chatId);
      }
    }
    return null;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? { name: err.name, message: err.message } : { name: 'Unknown' },
      },
      'telegram getUpdates failed',
    );
    return null;
  }
}

/** URL-safe random link code (`LINK_CODE_BYTES` bytes → base64url). */
function defaultGenerateCode(): string {
  return randomBytes(LINK_CODE_BYTES).toString('base64url');
}

/** Mask a chat id down to its last 4 characters ("…1234"). */
function maskChatId(chatId: string): string {
  const tail = chatId.slice(-4);
  return `…${tail}`;
}

/** Setup errors surfaced through the HTTP layer as 4xx with an i18n key. */
export class TelegramSetupError extends Error {
  readonly code: 'not_available';
  constructor(code: 'not_available') {
    super(code);
    this.name = 'TelegramSetupError';
    this.code = code;
  }
}
