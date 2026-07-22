import { randomBytes } from 'node:crypto';

import {
  WEBHOOK_MAX_SUBSCRIPTIONS,
  WEBHOOK_SECRET_PREFIX,
  type CreateWebhookSubscriptionResponse,
  type WebhookDelivery,
  type WebhookDisabledReason,
  type WebhookEventType,
  type WebhookSubscription,
} from '@bettertrack/contracts';

import type {
  UpdateWebhookSubscriptionPatch,
  WebhookDeliveryRepository,
  WebhookSubscriptionRepository,
} from '../../data/repositories/webhookRepository';
import type { WebhookDeliveryRow, WebhookSubscriptionRow } from '../../data/schema';
import { badRequest, notFound } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { encryptSecret } from '../crypto/secretBox';

/**
 * Outbound-webhook management (§13.5 V5-P10, issue 1/2). Owns subscription CRUD:
 * minting the one-time signing secret (only its AES-256-GCM envelope is stored,
 * never logged), listing/updating (incl. manual pause + re-enable) and deleting,
 * plus reading the bounded delivery log. Delivery itself lives in the dispatcher.
 */

/** How many delivery-log rows a list read returns (bounded). */
export const WEBHOOK_DELIVERY_LIST_LIMIT = 100;

export interface WebhookServiceDeps {
  subscriptions: WebhookSubscriptionRepository;
  deliveries: WebhookDeliveryRepository;
  audit: AuditService;
  /** 32-byte secretBox key (shared with TOTP/Discord — `config.twoFactor.encryptionKey`). */
  encryptionKey: Buffer;
}

export interface CreateWebhookInput {
  userId: string;
  url: string;
  description?: string;
  eventTypes: WebhookEventType[];
  ip?: string | null;
}

export interface UpdateWebhookInput {
  userId: string;
  id: string;
  url?: string;
  description?: string | null;
  eventTypes?: WebhookEventType[];
  enabled?: boolean;
  ip?: string | null;
}

export interface WebhookService {
  list(userId: string): Promise<WebhookSubscription[]>;
  create(input: CreateWebhookInput): Promise<CreateWebhookSubscriptionResponse>;
  update(input: UpdateWebhookInput): Promise<WebhookSubscription>;
  delete(input: { userId: string; id: string; ip?: string | null }): Promise<void>;
  listDeliveries(userId: string, id: string): Promise<WebhookDelivery[]>;
}

const toSummary = (row: WebhookSubscriptionRow): WebhookSubscription => ({
  id: row.id,
  url: row.url,
  description: row.description,
  eventTypes: row.eventTypes as WebhookEventType[],
  enabled: row.enabled,
  disabledReason: row.disabledReason as WebhookDisabledReason | null,
  disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
  consecutiveFailures: row.consecutiveFailures,
  lastDeliveryAt: row.lastDeliveryAt ? row.lastDeliveryAt.toISOString() : null,
  lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
});

const toDelivery = (row: WebhookDeliveryRow): WebhookDelivery => ({
  id: row.id,
  eventType: row.eventType,
  status: row.status,
  responseStatus: row.responseStatus,
  attempts: row.attempts,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
});

/** Mint a signing secret: recognizable prefix + 256 bits of CSPRNG entropy. */
function mintSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function createWebhookService(deps: WebhookServiceDeps): WebhookService {
  const { subscriptions, deliveries, audit, encryptionKey } = deps;

  async function requireOwned(userId: string, id: string): Promise<WebhookSubscriptionRow> {
    const row = await subscriptions.findByIdForUser(userId, id);
    if (!row) {
      // Unknown id or another user's subscription — a uniform 404 so ids can't
      // be probed across accounts.
      throw notFound('Webhook subscription not found.', 'WEBHOOK_NOT_FOUND');
    }
    return row;
  }

  return {
    async list(userId) {
      const rows = await subscriptions.listForUser(userId);
      return rows.map(toSummary);
    },

    async create({ userId, url, description, eventTypes, ip }) {
      const existing = await subscriptions.countForUser(userId);
      if (existing >= WEBHOOK_MAX_SUBSCRIPTIONS) {
        throw badRequest(
          `You can have at most ${WEBHOOK_MAX_SUBSCRIPTIONS} webhook subscriptions.`,
          'WEBHOOK_LIMIT_REACHED',
        );
      }
      const secret = mintSecret();
      const row = await subscriptions.create({
        userId,
        url,
        description: description ?? null,
        eventTypes,
        secretEncrypted: encryptSecret(secret, encryptionKey),
      });
      await audit.record({
        actorId: userId,
        action: AuditAction.WebhookCreated,
        targetType: 'webhook_subscription',
        targetId: row.id,
        ip: ip ?? null,
        // Never the secret or URL — only the non-sensitive shape.
        meta: { eventTypes },
      });
      return { subscription: toSummary(row), secret };
    },

    async update({ userId, id, url, description, eventTypes, enabled, ip }) {
      const current = await requireOwned(userId, id);

      const patch: UpdateWebhookSubscriptionPatch = {};
      if (url !== undefined) patch.url = url;
      if (description !== undefined) patch.description = description;
      if (eventTypes !== undefined) patch.eventTypes = eventTypes;
      if (enabled !== undefined && enabled !== current.enabled) {
        patch.enabled = enabled;
        if (enabled) {
          // Manual re-enable clears the whole failure state (§13.5 V5-P10).
          patch.consecutiveFailures = 0;
          patch.disabledReason = null;
          patch.disabledAt = null;
        } else {
          patch.disabledReason = 'manual';
          patch.disabledAt = new Date();
        }
      }

      const updated = await subscriptions.update(userId, id, patch);
      if (!updated) throw notFound('Webhook subscription not found.', 'WEBHOOK_NOT_FOUND');
      await audit.record({
        actorId: userId,
        action: AuditAction.WebhookUpdated,
        targetType: 'webhook_subscription',
        targetId: id,
        ip: ip ?? null,
        meta: { enabled: updated.enabled },
      });
      return toSummary(updated);
    },

    async delete({ userId, id, ip }) {
      const removed = await subscriptions.delete(userId, id);
      if (!removed) throw notFound('Webhook subscription not found.', 'WEBHOOK_NOT_FOUND');
      await audit.record({
        actorId: userId,
        action: AuditAction.WebhookDeleted,
        targetType: 'webhook_subscription',
        targetId: id,
        ip: ip ?? null,
      });
    },

    async listDeliveries(userId, id) {
      await requireOwned(userId, id);
      const rows = await deliveries.listForSubscription(id, WEBHOOK_DELIVERY_LIST_LIMIT);
      return rows.map(toDelivery);
    },
  };
}
