import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SIGNATURE_SCHEME,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  type WebhookEventDataOf,
  type WebhookEventPayload,
  type WebhookEventType,
} from '@bettertrack/contracts';

import type { DomainEvent } from '../../events';

/**
 * Webhook payload composition + signing (§13.5 V5-P10). Pure functions, no I/O —
 * the delivery dispatcher builds the body here, signs it with the subscription's
 * decrypted secret, and the same `verify*` a receiver would run backs the
 * integration test. What each event type may put in that body is the per-type
 * allowlist in {@link webhookEventData}, declared by the contract schemas.
 *
 * Signature = `sha256=<hex>` where hex is HMAC-SHA256 of `` `${timestamp}.${body}` ``
 * under the secret (the GitHub/Stripe convention). Binding the timestamp in
 * means the timestamp cannot be changed without invalidating the MAC — but the
 * captured triple (timestamp, body, signature) stays valid forever on its own,
 * so {@link verifyWebhookSignature} additionally requires the timestamp to be
 * fresh within {@link WEBHOOK_SIGNATURE_TOLERANCE_SECONDS}. That freshness
 * window is what bounds replay; receivers should apply the same bound.
 */

/** A domain event that is in the subscribable catalog, so it can be delivered. */
export type WebhookDeliverableEvent = Extract<DomainEvent, { type: WebhookEventType }>;

/**
 * Same admission rule the bridge applies before it enqueues anything — repeated
 * here (rather than imported) so the signer keeps its no-I/O dependency set.
 */
const DELIVERABLE_TYPES: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

function isDeliverable(event: DomainEvent): event is WebhookDeliverableEvent {
  return DELIVERABLE_TYPES.has(event.type);
}

/** Compute the `X-BetterTrack-Signature` header value. */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `${WEBHOOK_SIGNATURE_SCHEME}=${mac}`;
}

export interface VerifyWebhookSignatureOptions {
  /** Receiver-side "now" in epoch milliseconds. Defaults to the system clock. */
  now?: number;
  /**
   * Half-width of the accepted timestamp window, in seconds. Defaults to
   * {@link WEBHOOK_SIGNATURE_TOLERANCE_SECONDS}; `Infinity` disables the
   * freshness check for a receiver that dedupes on the delivery id instead.
   */
  toleranceSeconds?: number;
}

/**
 * Constant-time signature check plus the freshness window (receiver-side; used
 * by the integration test).
 *
 * Returns false — never throws — when the timestamp is not a plain epoch-second
 * integer, when it sits further than `toleranceSeconds` from `now` in either
 * direction (an old capture replayed, or a clock too far ahead), or when the MAC
 * does not match.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  options: VerifyWebhookSignatureOptions = {},
): boolean {
  const { now = Date.now(), toleranceSeconds = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } = options;

  if (!/^\d{1,15}$/.test(timestamp)) return false;
  const skewSeconds = Math.abs(now / 1000 - Number(timestamp));
  if (!(skewSeconds <= toleranceSeconds)) return false;

  const expected = signWebhookPayload(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Type-anchor helper: pins one case's object literal to the contract schema of
 * exactly the event type the case narrowed to, so a field that is not on that
 * type's allowlist ({@link WEBHOOK_EVENT_PAYLOAD_SCHEMAS}) fails to compile.
 */
function disclose<T extends WebhookEventType>(
  _type: T,
  data: WebhookEventDataOf<T>,
): WebhookEventDataOf<T> {
  return data;
}

/**
 * The per-type disclosure allowlist: what one event puts on the wire.
 *
 * A webhook body is NOT the runtime event — the event carries fields a
 * subscriber's URL must never receive (private chat text, third-party account
 * uuids) and would otherwise serialize verbatim. Each case hand-picks its
 * fields, the contract schema is the declaration of that choice, and the switch
 * is exhaustive: a new catalog type does not compile until it decides what it
 * discloses. The reference is the inbox payload the notification dispatcher
 * builds for the same event; where an integration surface needs more, the
 * contract entry says why.
 */
function webhookEventData(event: WebhookDeliverableEvent): WebhookEventDataOf<WebhookEventType> {
  switch (event.type) {
    case 'alert.triggered':
      return disclose(event.type, {
        userId: event.userId,
        alertId: event.alertId,
        assetId: event.assetId,
      });
    case 'friend.request':
    case 'friend.accepted':
      return disclose(event.type, {
        userId: event.userId,
        actorId: event.actorId,
        actorUsername: event.actorUsername,
        requestId: event.requestId,
      });
    case 'portfolio.shared':
      return disclose(event.type, {
        userId: event.userId,
        actorId: event.actorId,
        actorUsername: event.actorUsername,
        portfolioId: event.portfolioId,
      });
    case 'watchlist.shared':
      return disclose(event.type, {
        userId: event.userId,
        actorId: event.actorId,
        actorUsername: event.actorUsername,
        watchlistId: event.watchlistId,
      });
    case 'conglomerate.shared':
      return disclose(event.type, {
        userId: event.userId,
        actorId: event.actorId,
        actorUsername: event.actorUsername,
        conglomerateId: event.conglomerateId,
      });
    case 'friend.activity':
      // `refId` (the underlying transaction/watchlist-row id) stays internal —
      // it is the dedupe discriminator, not something a viewer may address.
      return disclose(event.type, {
        userId: event.userId,
        actorId: event.actorId,
        actorUsername: event.actorUsername,
        itemKind: event.itemKind,
        itemId: event.itemId,
        activity: event.activity,
        assetSymbol: event.assetSymbol,
      });
    case 'follow.published':
      return disclose(event.type, {
        userId: event.userId,
        actorId: event.actorId,
        actorUsername: event.actorUsername,
        itemKind: event.itemKind,
        itemId: event.itemId,
        itemName: event.itemName,
      });
    case 'follow.alert.created':
    case 'follow.alert.fired':
      return disclose(event.type, {
        userId: event.userId,
        actorId: event.actorId,
        actorUsername: event.actorUsername,
        alertId: event.alertId,
        assetId: event.assetId,
      });
    case 'account.temp_password':
    case 'account.data_export':
      return disclose(event.type, { userId: event.userId });
    case 'earnings.reminder':
      // The free-text company `name` is dropped; `symbol` identifies the asset.
      return disclose(event.type, {
        userId: event.userId,
        assetId: event.assetId,
        symbol: event.symbol,
        earningsDate: event.earningsDate,
        estimated: event.estimated,
      });
    case 'chat.message':
      // `bodyPreview` (the first 140 chars of the sender's private message) and
      // `hasChip` are deliberately absent — see the contract entry.
      return disclose(event.type, {
        userId: event.userId,
        conversationId: event.conversationId,
        messageId: event.messageId,
        senderId: event.senderId,
        senderUsername: event.senderUsername,
      });
    case 'dividend.event':
      return disclose(event.type, {
        userId: event.userId,
        assetId: event.assetId,
        symbol: event.symbol,
        exDate: event.exDate,
        payDate: event.payDate,
        amount: event.amount,
        currency: event.currency,
      });
    case 'budget.exceeded':
      // The user's free-text `categoryName` stays off the wire; `categoryId`
      // addresses the same tag.
      return disclose(event.type, {
        userId: event.userId,
        budgetId: event.budgetId,
        categoryId: event.categoryId,
        period: event.period,
        amount: event.amount,
        spent: event.spent,
        currency: event.currency,
      });
    case 'standing_order.skipped':
      // The user's free-text `orderLabel` stays off the wire.
      return disclose(event.type, {
        userId: event.userId,
        standingOrderId: event.standingOrderId,
        periodKey: event.periodKey,
        outcome: event.outcome,
        ...(event.droppedCount === undefined ? {} : { droppedCount: event.droppedCount }),
      });
    case 'feedback.status_changed':
      return disclose(event.type, {
        userId: event.userId,
        feedbackId: event.feedbackId,
        status: event.status,
        lastStatusChangeAt: event.lastStatusChangeAt,
      });
    case 'feedback.reply_created':
      return disclose(event.type, {
        userId: event.userId,
        feedbackId: event.feedbackId,
        messageId: event.messageId,
      });
    case 'comment.created':
      // `actorId` — the commenter's internal id — is dropped; the inbox row
      // names the commenter by username only.
      return disclose(event.type, {
        userId: event.userId,
        commentId: event.commentId,
        itemKind: event.itemKind,
        itemId: event.itemId,
        itemName: event.itemName,
        actorUsername: event.actorUsername,
      });
    case 'mirror.invite':
    case 'mirror.member_joined':
    case 'mirror.member_left':
    case 'mirror.member_removed':
    case 'mirror.removed':
    case 'mirror.ownership_transferred':
    case 'mirror.chain_dissolved':
    case 'mirror.sync_stalled':
      // `actorId`, `ownerId` and `subjectUserIds` are internal privacy
      // principals (other people's account ids) — never delivered.
      return disclose(event.type, {
        userId: event.userId,
        chainId: event.chainId,
        chainName: event.chainName,
        actorUsername: event.actorUsername,
        refId: event.refId,
      });
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/**
 * Build the wire payload (envelope) for a delivery: a stable delivery `id`, the
 * event `type`, the event's `createdAt`, and the type's allowlisted projection
 * of the event as `data`. The body the signature covers is exactly
 * `JSON.stringify(payload)`.
 *
 * Returns null — fail-closed — for an event outside the subscribable catalog:
 * such an event has no declared disclosure, so it is never serialized. The
 * bridge only ever enqueues catalog types, so this is unreachable in practice.
 */
export function buildWebhookPayload(
  deliveryId: string,
  event: DomainEvent,
): { payload: WebhookEventPayload; body: string } | null {
  if (!isDeliverable(event)) return null;
  const payload = {
    id: deliveryId,
    type: event.type,
    createdAt: event.occurredAt,
    data: webhookEventData(event),
    // `type` and `data` are correlated by construction — the switch returns
    // exactly the schema of the case it narrowed to — but the payload union
    // cannot express that pairing through a widened `data`.
  } as WebhookEventPayload;
  return { payload, body: JSON.stringify(payload) };
}
