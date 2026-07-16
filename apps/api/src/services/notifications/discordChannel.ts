import type { DiscordWebhookRepository } from '../../data/repositories/discordWebhookRepository';
import type { Logger } from '../../logger';
import { decryptSecret } from '../crypto/secretBox';

import type { PushMessage } from './fcm';

/**
 * Discord notification channel (§13.4 V4-P10). Delivers a rendered
 * notification through a per-user Discord webhook URL — no bot, no OAuth,
 * scope explicitly out of scope. The URL is stored ENCRYPTED at rest via
 * `secretBox` and decrypted at delivery time; it never leaves the API process
 * and never touches a log line.
 *
 * Delivery rules:
 *  - **Rate limit**: Discord webhooks share a 30 req/60 s bucket per webhook
 *    and enforce it with 429 + `Retry-After`. The channel spaces sends and
 *    honors `Retry-After` (bounded) so a fan-out burst never trips it.
 *  - **Dead-webhook pruning**: a 404 or a 401 from Discord means the webhook
 *    is gone (channel deleted, or the webhook was rotated) — the row is
 *    dropped and the user has to re-configure.
 *  - **Test send**: the settings surface calls {@link sendTest} to exercise
 *    the saved webhook and surface success/failure to the user.
 *  - **Best-effort dispatch**: never throws back into the dispatcher.
 */

/** Fallback spacing between two Discord sends (ms) — spaces the bucket. */
export const DEFAULT_MIN_SPACING_MS = 100;
/** Upper bound on how long we honor a `Retry-After` before giving up. */
export const MAX_RETRY_AFTER_MS = 2_000;

export type DiscordSendOutcome = 'ok' | 'gone' | 'error';

export interface DiscordChannel {
  /**
   * Send `message` to the user's configured webhook; prunes it on a permanent
   * failure. No-ops for a user without a saved webhook. Best-effort.
   */
  deliver(userId: string, message: PushMessage): Promise<void>;

  /**
   * Send a diagnostic "This is BetterTrack" message to the user's saved
   * webhook. Returns `ok`/`gone`/`error` so the settings UI can surface it
   * cleanly. No prune on `error` (the URL might be fine; Discord flaked).
   */
  sendTest(userId: string): Promise<DiscordSendOutcome>;

  /**
   * Send `message` to a candidate webhook URL WITHOUT persisting anything — the
   * save flow's "does this URL work?" probe. Returns `ok` on 2xx, `error`
   * otherwise. Never logs the URL.
   */
  probe(url: string, text: string): Promise<DiscordSendOutcome>;
}

export interface CreateDiscordChannelDeps {
  webhooks: DiscordWebhookRepository;
  /** Same envelope key as `services/crypto/secretBox` (`config.twoFactor.encryptionKey`). */
  encryptionKey: Buffer;
  logger: Logger;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minSpacingMs?: number;
  maxRetryAfterMs?: number;
}

export function createDiscordChannel(deps: CreateDiscordChannelDeps): DiscordChannel {
  const { webhooks, encryptionKey, logger } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minSpacingMs = deps.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;
  const maxRetryAfterMs = deps.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;

  // Same paced-outbound pattern as the Telegram channel — mirrors the
  // `providers/requestQueue.ts` spirit without dragging its full budget model
  // into what is a per-webhook trickle.
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

  async function post(url: string, text: string): Promise<DiscordSendOutcome> {
    // The URL is the secret — never log it, or `err` values that carry it.
    return paced(async () => {
      try {
        let res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        if (res.status === 429) {
          // Bucket-tripped — Discord tells us how long to wait. Bounded so we
          // never idle past a reasonable window (§13.4 V4-P10 "rate limits
          // respected", not "unbounded retry").
          const retryMs = parseRetryAfter(res.headers.get('retry-after'), maxRetryAfterMs);
          if (retryMs > 0) await sleep(retryMs);
          res = await fetchFn(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: text }),
          });
        }
        if (res.ok) return 'ok';
        if (res.status === 404 || res.status === 401) return 'gone';
        logger.warn({ status: res.status }, 'discord send failed');
        return 'error';
      } catch (err) {
        logger.warn({ err: sanitizeErr(err) }, 'discord send failed');
        return 'error';
      }
    });
  }

  async function resolveUrl(userId: string): Promise<string | null> {
    const row = await webhooks.findForUser(userId);
    if (!row) return null;
    try {
      return decryptSecret(row.encryptedUrl, encryptionKey);
    } catch (err) {
      // The stored envelope is unusable — treat as if the webhook is gone so
      // the row is dropped and the user re-configures. Never log the ciphertext.
      logger.warn({ err: sanitizeErr(err) }, 'discord webhook envelope unreadable');
      return null;
    }
  }

  return {
    async deliver(userId, message): Promise<void> {
      const url = await resolveUrl(userId);
      if (!url) return;
      const outcome = await post(url, renderMessage(message));
      if (outcome === 'gone') {
        await webhooks.deleteForUser(userId);
        logger.info('pruned dead discord webhook');
      }
    },

    async sendTest(userId): Promise<DiscordSendOutcome> {
      const url = await resolveUrl(userId);
      if (!url) return 'gone';
      // Deliberately does NOT prune on the test path: the user is exercising
      // it interactively and expects to see the failure, not a silent removal.
      return post(url, 'BetterTrack test message — your notifications are wired up.');
    },

    async probe(url, text): Promise<DiscordSendOutcome> {
      // No persistence and no pruning — pure probe for the save flow.
      return post(url, text);
    },
  };
}

/**
 * The rendered Discord message. Discord's `content` accepts up to 2000 chars
 * and Markdown formatting; we bold the title to make it scannable. No mention
 * roles / user references so a mischievous body can't ping @everyone.
 */
function renderMessage(message: PushMessage): string {
  const title = message.title.slice(0, 200);
  const body = message.body.slice(0, 1700);
  return `**${title}**\n${body}`;
}

/** Parse Discord's `retry-after` (seconds — string) into a bounded ms wait. */
function parseRetryAfter(header: string | null, maxMs: number): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(Math.round(seconds * 1000), maxMs);
}

function sanitizeErr(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Unknown', message: String(err) };
}
