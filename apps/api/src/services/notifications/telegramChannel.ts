import type { TelegramLinkRepository } from '../../data/repositories/telegramLinkRepository';
import type { Logger } from '../../logger';

import type { PushMessage } from './fcm';

/**
 * Telegram notification channel (§13.4 V4-P10). Delivers a rendered
 * notification through the Bot API's `sendMessage` endpoint to the user's
 * confirmed chat id. The bot token comes from env (`BT_TELEGRAM_BOT_TOKEN`);
 * unset ⇒ {@link createTelegramChannel} returns null after one warn log and
 * the settings surface reports `telegram: false` — matching the FCM pattern.
 *
 * Delivery rules:
 *  - **Rate limit**: Telegram's per-bot cap is ~30 msg/s across every chat and
 *    ~1 msg/s per chat. The channel enforces a minimum outbound spacing
 *    ({@link DEFAULT_MIN_SPACING_MS}) between calls so a fan-out burst never
 *    over-runs the bucket. Configurable via the deps for tests.
 *  - **Dead-chat pruning**: a 403 from Telegram (bot blocked / kicked) removes
 *    the row, exactly like FCM's UNREGISTERED. Any other non-2xx logs and
 *    keeps the row (transient errors self-heal on the next fan-out).
 *  - **Secret handling**: the bot token is redacted from every log; chat ids
 *    are never printed either.
 *  - **Best-effort dispatch**: never throws back into the dispatcher — the
 *    `notifications.dispatch` job stays isolated per §6.10.
 */

/** Fallback outbound spacing between two Telegram sends (ms). */
export const DEFAULT_MIN_SPACING_MS = 50;

/** One Telegram send's outcome — mirrors {@link PushSendOutcome} in `fcm.ts`. */
export type TelegramSendOutcome = 'ok' | 'gone' | 'error';

export interface TelegramChannel {
  /**
   * Send `message` to every chat linked to `userId`; prunes any chat id
   * Telegram reports gone (403 bot-blocked). No-ops for a user with no linked
   * chat. Best-effort — never throws.
   */
  deliver(userId: string, message: PushMessage): Promise<void>;

  /**
   * Send a one-off message to `chatId` — used by the link handshake's confirm
   * path (the "you're linked!" welcome) and by any diagnostic surface. Returns
   * the raw outcome so callers can surface success/failure to the user.
   */
  send(chatId: string, text: string): Promise<TelegramSendOutcome>;

  /**
   * Look up the bot's `@username` via `getMe` (used at link start so the SPA
   * can build the `https://t.me/<bot>?start=<code>` deep link without wiring
   * the raw name through env). Returns null on any transport failure — the
   * caller falls back to a cached value or the generic "open Telegram" hint.
   */
  getBotUsername(): Promise<string | null>;
}

export interface CreateTelegramChannelDeps {
  /** From `config.telegram.botToken`; unset ⇒ channel off. */
  botToken: string | undefined;
  /** Persistence — used to prune dead chat ids on 403 (bot-blocked). */
  links: Pick<TelegramLinkRepository, 'listChatIdsForUser' | 'deleteChatId'>;
  logger: Logger;
  /** Injectable transport (tests). Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep (tests). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Minimum spacing between two sends (ms); defaults to {@link DEFAULT_MIN_SPACING_MS}. */
  minSpacingMs?: number;
}

/**
 * Build the Telegram channel, or null when the bot token is unset. `null`
 * transparently propagates through the dispatcher and the settings surface —
 * exactly like `fcm` and `webpush`. Exactly one warn log at boot.
 */
export function createTelegramChannel(deps: CreateTelegramChannelDeps): TelegramChannel | null {
  const { botToken, links, logger } = deps;
  if (!botToken || botToken.trim() === '') {
    logger.warn('telegram channel disabled: BT_TELEGRAM_BOT_TOKEN is not set');
    return null;
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minSpacingMs = deps.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;
  logger.info('telegram channel enabled');

  // Bot token is a secret — it lives inside the URL and NEVER touches a log
  // line. All log objects below are stripped to non-secret fields.
  const base = `https://api.telegram.org/bot${botToken}`;

  // Serialized outbound gate: every send observes at least `minSpacingMs`
  // between START times, so a fan-out burst (many chats) or a very active
  // notification stream honors Telegram's 30 msg/s bot budget without needing
  // an external limiter. Not a global rate token bucket — the spacing is a
  // fixed cadence, sufficient for the "respect provider rate limits" bar.
  let nextAvailableAt = 0;
  let queue: Promise<void> = Promise.resolve();
  async function paced<T>(fn: () => Promise<T>): Promise<T> {
    let result!: T;
    queue = queue.then(async () => {
      const wait = Math.max(0, nextAvailableAt - now());
      if (wait > 0) await sleep(wait);
      const start = now();
      nextAvailableAt = start + minSpacingMs;
      result = await fn();
    });
    await queue;
    return result;
  }

  async function sendMessage(chatId: string, text: string): Promise<TelegramSendOutcome> {
    return paced(async () => {
      try {
        const res = await fetchFn(`${base}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
        if (res.ok) return 'ok';
        // 403 = user blocked bot / kicked from chat — permanent, prune the row.
        // Never log the chat id (secret PII); the status alone is enough.
        if (res.status === 403) return 'gone';
        // Extra safety: parse the body's `ok/description` for the specific
        // "bot was blocked by the user" and "chat not found" reasons — these
        // arrive as 4xx and never come back on retry.
        const bodyText = await res.text().catch(() => '');
        if (isPermanentTelegramFailure(bodyText)) return 'gone';
        logger.warn({ status: res.status }, 'telegram send failed');
        return 'error';
      } catch (err) {
        // Redact any error string: axios/fetch errors can carry the URL and
        // hence the bot token — trim to a bare message.
        logger.warn({ err: sanitizeErr(err) }, 'telegram send failed');
        return 'error';
      }
    });
  }

  return {
    async deliver(userId, message): Promise<void> {
      const chatIds = await links.listChatIdsForUser(userId);
      if (chatIds.length === 0) return;
      const text = renderMessage(message);
      for (const chatId of chatIds) {
        const outcome = await sendMessage(chatId, text);
        if (outcome === 'gone') {
          await links.deleteChatId(chatId);
          logger.info('pruned dead telegram chat link (bot blocked)');
        }
      }
    },

    send: sendMessage,

    async getBotUsername(): Promise<string | null> {
      try {
        const res = await fetchFn(`${base}/getMe`, { method: 'GET' });
        if (!res.ok) return null;
        const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
        return typeof body.result?.username === 'string' ? body.result.username : null;
      } catch (err) {
        logger.warn({ err: sanitizeErr(err) }, 'telegram getMe failed');
        return null;
      }
    },
  };
}

/**
 * The rendered Telegram body: title + blank line + body. Plain text (no
 * Markdown/HTML parse mode) so a mischievous username with `*` or `<b>` never
 * turns into formatting — and no escape logic can leak an underscore that
 * unbalances the parser. Simplest thing that works.
 */
function renderMessage(message: PushMessage): string {
  return `${message.title}\n\n${message.body}`;
}

/**
 * Discord-style "gone" detection for Telegram: 4xx bodies that describe a
 * permanently-dead chat (bot blocked, chat not found, user is deactivated).
 * The channel prunes on these too; anything else stays transient.
 */
function isPermanentTelegramFailure(bodyText: string): boolean {
  const t = bodyText.toLowerCase();
  return (
    t.includes('bot was blocked by the user') ||
    t.includes('chat not found') ||
    t.includes('user is deactivated') ||
    t.includes('bot was kicked')
  );
}

/**
 * Sanitize an error before logging: keep only the class + message, so a URL
 * (potentially carrying the bot token) or a fetched body doesn't ride into
 * pino. Explicitly avoids logging the underlying `Error.cause`, which some
 * fetch implementations populate with a stack including the request URL.
 */
function sanitizeErr(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Unknown', message: String(err) };
}
