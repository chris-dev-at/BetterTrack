import type { DiscordSettingsResponse } from '@bettertrack/contracts';

import type { DiscordWebhookRepository } from '../../data/repositories/discordWebhookRepository';
import type { Logger } from '../../logger';
import { encryptSecret } from '../crypto/secretBox';

import type { DiscordChannel, DiscordSendOutcome } from './discordChannel';

/**
 * User-facing Discord setup surface (§13.4 V4-P10). The webhook URL is the
 * secret this whole surface protects: it is validated (URL shape + live probe
 * with a test message) before saving; on save it is encrypted via `secretBox`
 * and only stored in encrypted form; on read the API returns a masked id and
 * a `configuredAt` timestamp, never the URL.
 */

export interface DiscordSetupService {
  get(userId: string): Promise<DiscordSettingsResponse>;
  save(userId: string, url: string): Promise<DiscordSettingsResponse>;
  test(userId: string): Promise<DiscordSendOutcome>;
  remove(userId: string): Promise<DiscordSettingsResponse>;
  /** Whether the caller has a saved webhook — settings availability lookup. */
  linkedFor(userId: string): Promise<boolean>;
}

export interface DiscordSetupServiceDeps {
  webhooks: DiscordWebhookRepository;
  channel: DiscordChannel;
  /** Same key as `services/crypto/secretBox` uses everywhere else. */
  encryptionKey: Buffer;
  logger: Logger;
}

export function createDiscordSetupService(deps: DiscordSetupServiceDeps): DiscordSetupService {
  const { webhooks, channel, encryptionKey, logger } = deps;

  async function toResponse(userId: string): Promise<DiscordSettingsResponse> {
    const row = await webhooks.findForUser(userId);
    return {
      // Always available (no server env needed) — but "linked" is per-user.
      available: true,
      linked: Boolean(row),
      webhookIdMasked: row?.webhookIdMasked ?? null,
      configuredAt: row?.createdAt.toISOString() ?? null,
    };
  }

  return {
    async get(userId): Promise<DiscordSettingsResponse> {
      return toResponse(userId);
    },

    async linkedFor(userId): Promise<boolean> {
      const row = await webhooks.findForUser(userId);
      return Boolean(row);
    },

    async save(userId, url): Promise<DiscordSettingsResponse> {
      // Live test send against the candidate URL, so a copy-paste typo or a
      // stale webhook is rejected at save (never persisted).
      const outcome = await channel.probe(
        url,
        'BetterTrack — Discord webhook configured. This channel is now armed.',
      );
      if (outcome !== 'ok') {
        // Never log the URL — a probe failure is enough context for the user.
        logger.warn({ outcome }, 'discord webhook save probe rejected');
        throw new DiscordSetupError(outcome === 'gone' ? 'invalid_webhook' : 'send_failed');
      }
      const envelope = encryptSecret(url, encryptionKey);
      const masked = maskWebhookUrl(url);
      await webhooks.upsert(userId, { encryptedUrl: envelope, webhookIdMasked: masked });
      return toResponse(userId);
    },

    async test(userId): Promise<DiscordSendOutcome> {
      return channel.sendTest(userId);
    },

    async remove(userId): Promise<DiscordSettingsResponse> {
      await webhooks.deleteForUser(userId);
      return toResponse(userId);
    },
  };
}

/**
 * Build a short "…abcd" masked slug from a Discord webhook URL — the id
 * portion of the URL path is a snowflake we can safely show back to the user
 * so they can distinguish two webhooks in the settings surface.
 */
function maskWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    // .../api/webhooks/<id>/<token> — id is the third segment.
    const id = segments[2] ?? '';
    if (!id) return 'webhook';
    return `…${id.slice(-4)}`;
  } catch {
    return 'webhook';
  }
}

/** Save-flow errors surfaced as 4xx with an i18n key. */
export class DiscordSetupError extends Error {
  readonly code: 'invalid_webhook' | 'send_failed';
  constructor(code: 'invalid_webhook' | 'send_failed') {
    super(code);
    this.name = 'DiscordSetupError';
    this.code = code;
  }
}
