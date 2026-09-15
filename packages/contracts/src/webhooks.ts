import { z } from 'zod';

import { feedbackStatusSchema } from './feedback';

/**
 * Outbound webhooks (PROJECTPLAN.md §13.5 V5-P10, issue 1/2) — the "API as a
 * product" outbound leg. A user subscribes a URL to one or more event types;
 * when a matching event fires for THAT user, BetterTrack POSTs an HMAC-signed
 * JSON payload to the URL. A per-subscription secret is shown exactly once at
 * creation (only an encrypted form is stored, never logged); a dead receiver
 * auto-disables after N consecutive failed deliveries and can be re-enabled
 * manually. A bounded per-subscription delivery log records each outcome.
 *
 * The subscribable **catalog** ({@link WEBHOOK_EVENT_TYPES}) is the user-scoped
 * subset of the API's typed domain events (`apps/api/src/events/` —
 * `DISPATCHABLE_EVENT_TYPES`): every one carries a `userId` and only ever the
 * subscribing user's own data. Contracts cannot import the API layer, so this
 * list is the authoritative product surface here and the API carries a
 * drift-guard test asserting it stays exactly that user-scoped subset.
 */

/**
 * The event types a subscription may listen to. Mirror of the API's
 * `DISPATCHABLE_EVENT_TYPES` (user-scoped domain events only). Strictly additive
 * over time: append new types, never reorder or remove, so an existing
 * subscription keeps exactly the grants it was created with.
 */
export const WEBHOOK_EVENT_TYPES = [
  'alert.triggered',
  'friend.request',
  'friend.accepted',
  'portfolio.shared',
  'watchlist.shared',
  'conglomerate.shared',
  'friend.activity',
  'follow.published',
  'follow.alert.created',
  'follow.alert.fired',
  'account.temp_password',
  'account.data_export',
  'earnings.reminder',
  'chat.message',
  'dividend.event',
  'budget.exceeded',
  // MIRRORCHAIN group-portfolio lifecycle (§13.5 V5-P7): user-scoped like the
  // rest — each fires for the recipient only, carrying just their own data.
  'mirror.invite',
  'mirror.member_joined',
  'mirror.member_left',
  'mirror.member_removed',
  'mirror.removed',
  'mirror.ownership_transferred',
  'mirror.chain_dissolved',
  'mirror.sync_stalled',
  'standing_order.skipped',
  'feedback.status_changed',
  'feedback.reply_created',
  // V5-P8: a comment landed on an item the subscriber shares.
  'comment.created',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

export interface ParanoidWebhookEventTypeClassification {
  readonly disposition: 'killed' | 'allowed';
  readonly reason: string;
}

/**
 * Explicit paranoid-mode policy for every subscribable webhook event. This is
 * deliberately exhaustive: appending a contract event must fail typecheck
 * until its server-side fan-out receives a documented policy decision.
 */
export const PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS = {
  'alert.triggered': {
    disposition: 'allowed',
    reason: 'Paranoid-compatible server alerts remain available without portfolio payloads.',
  },
  'friend.request': {
    disposition: 'allowed',
    reason: 'Friend requests carry social relationship data rather than portfolio content.',
  },
  'friend.accepted': {
    disposition: 'allowed',
    reason: 'Friend acceptances carry social relationship data rather than portfolio content.',
  },
  'portfolio.shared': {
    disposition: 'killed',
    reason: 'Portfolio sharing is unavailable because paranoid portfolios remain client-side.',
  },
  'watchlist.shared': {
    disposition: 'killed',
    reason: 'Shared watchlists reveal account-owned investing data disabled in paranoid mode.',
  },
  'conglomerate.shared': {
    disposition: 'killed',
    reason: 'Shared conglomerates reveal account-owned investing data disabled in paranoid mode.',
  },
  'friend.activity': {
    disposition: 'killed',
    reason: 'Friend activity can reveal portfolio-derived actions disabled in paranoid mode.',
  },
  'follow.published': {
    disposition: 'killed',
    reason: 'Published follows can reveal portfolio-derived activity disabled in paranoid mode.',
  },
  'follow.alert.created': {
    disposition: 'killed',
    reason: 'Follow-alert creation can reveal account-owned investing data in paranoid mode.',
  },
  'follow.alert.fired': {
    disposition: 'killed',
    reason: 'Follow-alert delivery can reveal account-owned investing data in paranoid mode.',
  },
  'account.temp_password': {
    disposition: 'allowed',
    reason: 'Temporary-password notices contain account security data, not portfolio content.',
  },
  'account.data_export': {
    disposition: 'allowed',
    reason: 'Account-export notices report export status without exposing portfolio content.',
  },
  'earnings.reminder': {
    disposition: 'allowed',
    reason: 'Earnings reminders carry market-calendar data rather than portfolio content.',
  },
  'chat.message': {
    disposition: 'allowed',
    reason: 'Private chat remains separate from server-side portfolio content.',
  },
  'dividend.event': {
    disposition: 'killed',
    reason: 'Dividend events can reveal portfolio holdings unavailable to the paranoid server.',
  },
  'budget.exceeded': {
    disposition: 'killed',
    reason: 'Budget events reveal private cash data unavailable to the paranoid server.',
  },
  'mirror.invite': {
    disposition: 'killed',
    reason: 'Mirrorchain participation is unavailable because paranoid sharing is disabled.',
  },
  'mirror.member_joined': {
    disposition: 'killed',
    reason: 'Mirrorchain participation is unavailable because paranoid sharing is disabled.',
  },
  'mirror.member_left': {
    disposition: 'killed',
    reason: 'Mirrorchain participation is unavailable because paranoid sharing is disabled.',
  },
  'mirror.member_removed': {
    disposition: 'killed',
    reason: 'Mirrorchain participation is unavailable because paranoid sharing is disabled.',
  },
  'mirror.removed': {
    disposition: 'killed',
    reason: 'Mirrorchain participation is unavailable because paranoid sharing is disabled.',
  },
  'mirror.ownership_transferred': {
    disposition: 'killed',
    reason: 'Mirrorchain participation is unavailable because paranoid sharing is disabled.',
  },
  'mirror.chain_dissolved': {
    disposition: 'killed',
    reason: 'Mirrorchain participation is unavailable because paranoid sharing is disabled.',
  },
  'mirror.sync_stalled': {
    disposition: 'killed',
    reason: 'Mirrorchain participation is unavailable because paranoid sharing is disabled.',
  },
  'standing_order.skipped': {
    disposition: 'killed',
    reason:
      'Standing-order events reveal private schedule data unavailable to the paranoid server.',
  },
  'feedback.status_changed': {
    disposition: 'allowed',
    reason: 'Feedback lifecycle updates contain helpdesk metadata, not portfolio content.',
  },
  'feedback.reply_created': {
    disposition: 'allowed',
    reason: 'Feedback reply notices identify a helpdesk thread without exposing portfolio content.',
  },
  'comment.created': {
    disposition: 'killed',
    reason: 'Comment threads hang off shared items, and paranoid sharing is disabled.',
  },
} as const satisfies Record<WebhookEventType, ParanoidWebhookEventTypeClassification>;

/**
 * The subscribable catalog entries a **paranoid** account can never receive
 * (docs/paranoid-design.md §8 item 8). The server never fans these out for such
 * an account, so the create/edit form must not offer them either. This
 * projection preserves catalog order and is derived from the exhaustive policy
 * above; the API registry consumes the same projection and additionally kills
 * `portfolio.changed`, which is not subscribable and so is absent here.
 */
export const PARANOID_KILLED_WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] =
  WEBHOOK_EVENT_TYPES.filter(
    (type) => PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS[type].disposition === 'killed',
  );

/** True when a paranoid account can never receive this subscribable event. */
export function isParanoidKilledWebhookEventType(type: string): boolean {
  const classification = (
    PARANOID_WEBHOOK_EVENT_TYPE_CLASSIFICATIONS as Readonly<
      Record<string, ParanoidWebhookEventTypeClassification | undefined>
    >
  )[type];
  return classification?.disposition === 'killed';
}

/** Signature transport headers on every delivery POST. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-BetterTrack-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-BetterTrack-Timestamp';
export const WEBHOOK_EVENT_HEADER = 'X-BetterTrack-Event';
export const WEBHOOK_DELIVERY_HEADER = 'X-BetterTrack-Delivery';

/**
 * Signature scheme: the header value is `sha256=<hex>` where the hex is the
 * HMAC-SHA256 of `` `${timestamp}.${body}` `` under the subscription secret
 * (the GitHub/Stripe convention). Binding the timestamp in means an attacker
 * cannot re-stamp a captured body: any other timestamp invalidates the MAC. It
 * does NOT stop the captured triple (timestamp + body + signature) being
 * replayed verbatim — that is what {@link WEBHOOK_SIGNATURE_TOLERANCE_SECONDS}
 * bounds.
 */
export const WEBHOOK_SIGNATURE_SCHEME = 'sha256';

/**
 * How far a delivery's `X-BetterTrack-Timestamp` may sit from the receiver's own
 * clock before the signature is refused: ±5 minutes, symmetric so that ordinary
 * clock skew in either direction is tolerated while an old capture is not.
 *
 * Published for receivers: BetterTrack's own reference verifier
 * (`verifyWebhookSignature`) enforces exactly this window, and a receiver that
 * re-implements the check should use the same bound. Together with the
 * per-delivery `X-BetterTrack-Delivery` id — stable across retries, so it
 * doubles as a dedupe key — it bounds replay of a captured delivery to this
 * window.
 */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The one-time secret's recognizable prefix — greppable in leak scans. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * Consecutive terminally-failed deliveries after which a subscription
 * auto-disables (`disabledReason: 'auto'`). Shared so the UI can name the
 * threshold in its copy. Re-enabling resets the counter.
 */
export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 5;

/** Hard cap on active subscriptions per user (anti-abuse / anti-bloat). */
export const WEBHOOK_MAX_SUBSCRIPTIONS = 20;

/** Why a subscription is currently disabled: 'auto' (failures) or 'manual' (paused). */
export const WEBHOOK_DISABLED_REASONS = ['auto', 'manual'] as const;
export const webhookDisabledReasonSchema = z.enum(WEBHOOK_DISABLED_REASONS);
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];

/** A delivery outcome as recorded in the log. */
export const WEBHOOK_DELIVERY_STATUSES = ['success', 'failed'] as const;
export const webhookDeliveryStatusSchema = z.enum(WEBHOOK_DELIVERY_STATUSES);
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Refusal code for a destination the API's outbound (SSRF) guard blocks —
 * `400 { error: { code: 'WEBHOOK_URL_BLOCKED' } }` from create and update. A
 * subscription URL is user-supplied, so it is checked against the guard at
 * create/update AND re-resolved on every delivery attempt (a hostname that was
 * public at create time can point at loopback later).
 */
export const WEBHOOK_URL_BLOCKED_CODE = 'WEBHOOK_URL_BLOCKED';

/**
 * The delivery-log `error` recorded when an attempt is refused by that guard.
 * Deliberately destination-independent: a refused delivery never records a
 * `responseStatus`, so the log cannot distinguish an open internal port from a
 * closed one.
 */
export const WEBHOOK_DELIVERY_REFUSED_ERROR = 'destination not allowed';

/**
 * The delivery-log `error` recorded when the destination could not be resolved
 * for this attempt (DNS failure or an empty answer). A network condition, not a
 * policy refusal — it is retried like any other transport failure.
 */
export const WEBHOOK_DELIVERY_UNRESOLVED_ERROR = 'destination unresolved';

/**
 * The transport's own marker for "the receiver did not answer within the
 * deadline". It is NOT written to the delivery log any more: a filtered port
 * times out where a closed one refuses instantly, so recording the difference
 * would let the log answer questions about a network the subscriber is only
 * allowed to POST to. Both persist as {@link WEBHOOK_DELIVERY_NETWORK_ERROR}.
 *
 * It stays in the accepted set because the 30-day log still holds rows written
 * before that change, and those must keep rendering as the timeout they were.
 */
export const WEBHOOK_DELIVERY_TIMEOUT_ERROR = 'timeout';

/**
 * The delivery-log `error` recorded when the receiver answered with a status it
 * refused the delivery on. The status itself is the diagnostic and is carried by
 * `responseStatus`, so this string is deliberately constant.
 */
export const WEBHOOK_DELIVERY_HTTP_ERROR = 'receiver rejected the delivery';

/**
 * The delivery-log `error` recorded for EVERY transport-level failure: a refused
 * connection, a reset, a TLS handshake that did not complete, a receiver that
 * never answered.
 *
 * One constant for all of them, on purpose. The socket's own message names the
 * address, the port, the errno and — on a TLS mismatch — the certificate's
 * alternate names; persisting it would turn a log the subscriber may read into a
 * scanner for whatever the guard still allows. Refused, filtered and live-but-
 * not-HTTP therefore look identical in the log, exactly as a guard refusal does.
 */
export const WEBHOOK_DELIVERY_NETWORK_ERROR = 'delivery failed';

/**
 * The delivery-log `error` recorded when the subscription's signing secret would
 * not decrypt (rotated or corrupt key) — nothing was sent, and retrying cannot
 * help.
 */
export const WEBHOOK_DELIVERY_SECRET_ERROR = 'secret unavailable';

/**
 * The delivery-log `error` recorded when the subscription no longer lists the
 * queued event type at SEND time. The queue is not instantaneous, so a user who
 * removes an event type must have that revocation bind the deliveries already in
 * flight — exactly as `enabled` and the destination URL are re-checked per
 * attempt. It is the user's own change, so it never advances the auto-disable
 * streak.
 */
export const WEBHOOK_DELIVERY_UNSUBSCRIBED_ERROR = 'event no longer subscribed';

/**
 * The CLOSED set of values `webhook_deliveries.error` may hold — the whole
 * vocabulary the dispatcher is allowed to write and the API is allowed to
 * return. Receiver- and socket-provided text is not in it and cannot get in:
 * anything else a row still holds is mapped onto
 * {@link WEBHOOK_DELIVERY_NETWORK_ERROR} on the way out
 * ({@link normalizeWebhookDeliveryError}).
 *
 * {@link WEBHOOK_DELIVERY_TIMEOUT_ERROR} is accepted but no longer written; see
 * its own note.
 */
export const WEBHOOK_DELIVERY_ERRORS = [
  WEBHOOK_DELIVERY_HTTP_ERROR,
  WEBHOOK_DELIVERY_REFUSED_ERROR,
  WEBHOOK_DELIVERY_UNRESOLVED_ERROR,
  WEBHOOK_DELIVERY_TIMEOUT_ERROR,
  WEBHOOK_DELIVERY_SECRET_ERROR,
  WEBHOOK_DELIVERY_UNSUBSCRIBED_ERROR,
  WEBHOOK_DELIVERY_NETWORK_ERROR,
] as const;
export const webhookDeliveryErrorSchema = z.enum(WEBHOOK_DELIVERY_ERRORS);
export type WebhookDeliveryError = (typeof WEBHOOK_DELIVERY_ERRORS)[number];

const DELIVERY_ERRORS: ReadonlySet<string> = new Set<string>(WEBHOOK_DELIVERY_ERRORS);

/**
 * Coerce a stored `error` onto the closed set. A row written before the set
 * existed can still hold a raw socket message (`connect ECONNREFUSED
 * 172.18.0.4:5432`, a TLS altname list); it reads back as the structural
 * "delivery failed" like every other transport failure, so the documented
 * "scrubbed" contract is true for the whole 30-day window, not only for rows
 * written from now on.
 */
export function normalizeWebhookDeliveryError(stored: string | null): WebhookDeliveryError | null {
  if (stored === null) return null;
  return DELIVERY_ERRORS.has(stored)
    ? (stored as WebhookDeliveryError)
    : WEBHOOK_DELIVERY_NETWORK_ERROR;
}

/**
 * A target URL: a valid absolute http(s) URL. Plain http is accepted (a
 * self-hosted LAN receiver is a first-class use case); the payload is signed
 * either way so the receiver can still authenticate it.
 *
 * Shape only — the network policy lives server-side (§8 "Outbound safety"): the
 * API additionally refuses any destination that resolves to loopback,
 * link-local/cloud metadata (`169.254.0.0/16`, `fe80::/10`), unspecified,
 * broadcast or another non-routable range, with
 * {@link WEBHOOK_URL_BLOCKED_CODE}. Private LAN ranges (RFC1918, `fc00::/7`)
 * stay allowed — that is the self-hosted-receiver case above — EXCEPT the
 * private network the deployment's own services sit on, which is refused like
 * loopback: a receiver is a host on the operator's network, not one of ours.
 */
export const webhookUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), {
    message: 'URL must be http(s).',
  });

const descriptionSchema = z.string().trim().max(200);

/** `POST /settings/webhooks` — a URL, ≥1 event type, optional label. */
export const createWebhookSubscriptionRequestSchema = z
  .object({
    url: webhookUrlSchema,
    description: descriptionSchema.optional(),
    eventTypes: z.array(webhookEventTypeSchema).min(1).max(WEBHOOK_EVENT_TYPES.length),
  })
  .strict();
export type CreateWebhookSubscriptionRequest = z.infer<
  typeof createWebhookSubscriptionRequestSchema
>;

/**
 * `PATCH /settings/webhooks/:id` — every field optional. Flipping `enabled` from
 * `false` to `true` is the manual re-enable (resets the failure counter);
 * flipping it to `false` is a manual pause.
 */
export const updateWebhookSubscriptionRequestSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    eventTypes: z.array(webhookEventTypeSchema).min(1).max(WEBHOOK_EVENT_TYPES.length).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'No fields to update.' });
export type UpdateWebhookSubscriptionRequest = z.infer<
  typeof updateWebhookSubscriptionRequestSchema
>;

/** A subscription as listed in Settings → API Access (NEVER carries the secret). */
export const webhookSubscriptionSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string(),
    description: z.string().nullable(),
    eventTypes: z.array(webhookEventTypeSchema),
    enabled: z.boolean(),
    disabledReason: webhookDisabledReasonSchema.nullable(),
    disabledAt: z.string().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    lastDeliveryAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type WebhookSubscription = z.infer<typeof webhookSubscriptionSchema>;

export const webhookSubscriptionListResponseSchema = z
  .object({ subscriptions: z.array(webhookSubscriptionSchema) })
  .strict();
export type WebhookSubscriptionListResponse = z.infer<typeof webhookSubscriptionListResponseSchema>;

/** `PATCH /settings/webhooks/:id` response — the updated subscription (no secret). */
export const webhookSubscriptionResponseSchema = z
  .object({ subscription: webhookSubscriptionSchema })
  .strict();
export type WebhookSubscriptionResponse = z.infer<typeof webhookSubscriptionResponseSchema>;

/**
 * `POST /settings/webhooks` response — the subscription plus its plaintext
 * `secret`, returned **exactly once**. Re-fetching a subscription never
 * includes it.
 */
export const createWebhookSubscriptionResponseSchema = z
  .object({ subscription: webhookSubscriptionSchema, secret: z.string() })
  .strict();
export type CreateWebhookSubscriptionResponse = z.infer<
  typeof createWebhookSubscriptionResponseSchema
>;

/** One row of the per-subscription delivery log. */
export const webhookDeliverySchema = z
  .object({
    id: z.string().uuid(),
    eventType: z.string(),
    status: webhookDeliveryStatusSchema,
    /** HTTP status the receiver returned; null on a network/timeout error. */
    responseStatus: z.number().int().nullable(),
    /** How many attempts the delivery took (BullMQ retries counted). */
    attempts: z.number().int().positive(),
    /**
     * Why the delivery failed, as one of {@link WEBHOOK_DELIVERY_ERRORS}; null
     * on success. A closed set, never free text: nothing the receiver or the
     * socket produced reaches this field.
     */
    error: webhookDeliveryErrorSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const webhookDeliveryListResponseSchema = z
  .object({ deliveries: z.array(webhookDeliverySchema) })
  .strict();
export type WebhookDeliveryListResponse = z.infer<typeof webhookDeliveryListResponseSchema>;

/**
 * Why a logged delivery failed, as ONE discriminated value the UI can explain.
 *
 * The stored `error` is one of {@link WEBHOOK_DELIVERY_ERRORS} (never
 * receiver-provided text), so the causes that record no `responseStatus` — a
 * guard refusal, an unresolvable host, an unavailable signing secret and every
 * transport failure — would otherwise be one indistinguishable red badge.
 * Deriving the reason here rather than in the SPA keeps the writer (the
 * dispatcher) and the reader on the same constants.
 *
 * `timeout` is only ever derived from a row written before the transport
 * failures were collapsed; a new one reports `network` (see
 * {@link WEBHOOK_DELIVERY_NETWORK_ERROR}).
 */
export const WEBHOOK_DELIVERY_FAILURE_REASONS = [
  /** The receiver answered, with a status it refused the delivery on. */
  'http',
  /** The outbound (SSRF) guard refused the destination for this attempt. */
  'refused',
  /** The destination hostname did not resolve. */
  'unresolved',
  /** The receiver did not answer within the transport deadline. */
  'timeout',
  /** The signing secret would not decrypt, so nothing was signed or sent. */
  'secret',
  /** The subscription no longer listed this event type when the job ran. */
  'unsubscribed',
  /** Any other transport-level failure (connection refused, TLS, reset …). */
  'network',
] as const;
export const webhookDeliveryFailureReasonSchema = z.enum(WEBHOOK_DELIVERY_FAILURE_REASONS);
export type WebhookDeliveryFailureReason = (typeof WEBHOOK_DELIVERY_FAILURE_REASONS)[number];

/** The canonical `error` strings the dispatcher writes, mapped to their reason. */
const FAILURE_REASON_BY_ERROR: Readonly<Record<string, WebhookDeliveryFailureReason>> = {
  [WEBHOOK_DELIVERY_HTTP_ERROR]: 'http',
  [WEBHOOK_DELIVERY_NETWORK_ERROR]: 'network',
  [WEBHOOK_DELIVERY_REFUSED_ERROR]: 'refused',
  [WEBHOOK_DELIVERY_UNRESOLVED_ERROR]: 'unresolved',
  [WEBHOOK_DELIVERY_TIMEOUT_ERROR]: 'timeout',
  [WEBHOOK_DELIVERY_SECRET_ERROR]: 'secret',
  [WEBHOOK_DELIVERY_UNSUBSCRIBED_ERROR]: 'unsubscribed',
};

/** The failure reason of one logged delivery; `null` for a delivered one. */
export function webhookDeliveryFailureReason(
  delivery: Pick<WebhookDelivery, 'status' | 'responseStatus' | 'error'>,
): WebhookDeliveryFailureReason | null {
  if (delivery.status === 'success') return null;
  if (delivery.responseStatus !== null) return 'http';
  const mapped = delivery.error === null ? undefined : FAILURE_REASON_BY_ERROR[delivery.error];
  return mapped ?? 'network';
}

/**
 * The `data` allowlist: what each catalog event may disclose on the wire.
 *
 * A webhook body is a per-type HAND-PICKED projection of the domain event, never
 * the event itself — the runtime event carries fields (private message text,
 * third-party account uuids) that a subscriber's URL must never receive, and a
 * `Record<string, unknown>` cannot say which. Every schema is `.strict()`, so a
 * field that is not listed here cannot reach a receiver even if it is later
 * added to the producing event.
 *
 * The reference for each entry is the payload the API's own inbox notification
 * builds for the same event: a webhook discloses AT MOST what the bell row does.
 * Where an integration surface legitimately needs more, the entry says so.
 * `userId` rides every payload — it is always the subscription owner's own id
 * (fan-out is strictly per-subscriber), so it names nobody else while letting a
 * receiver that serves several accounts route the delivery.
 *
 * Strictly additive over time, exactly like {@link WEBHOOK_EVENT_TYPES}: a new
 * catalog type must declare its payload here, and widening an existing one is a
 * disclosure decision.
 */
const userId = z.string();
const itemKind = z.enum(['portfolio', 'watchlist', 'conglomerate', 'idea']);

/**
 * The eight MIRRORCHAIN lifecycle notices share one payload: the chain, the
 * member the notice is about, and the occurrence discriminator. `actorId`,
 * `ownerId` and `subjectUserIds` are internal privacy principals — third-party
 * account uuids the inbox row never carries — so none of them is on the wire.
 */
const mirrorPayloadSchema = z
  .object({
    userId,
    chainId: z.string(),
    chainName: z.string(),
    actorUsername: z.string(),
    refId: z.string(),
  })
  .strict();

export const WEBHOOK_EVENT_PAYLOAD_SCHEMAS = {
  /** Inbox parity; the alert's rule/threshold is resolved at render time, not here. */
  'alert.triggered': z.object({ userId, alertId: z.string(), assetId: z.string() }).strict(),
  'friend.request': z
    .object({ userId, actorId: z.string(), actorUsername: z.string(), requestId: z.string() })
    .strict(),
  'friend.accepted': z
    .object({ userId, actorId: z.string(), actorUsername: z.string(), requestId: z.string() })
    .strict(),
  'portfolio.shared': z
    .object({ userId, actorId: z.string(), actorUsername: z.string(), portfolioId: z.string() })
    .strict(),
  'watchlist.shared': z
    .object({ userId, actorId: z.string(), actorUsername: z.string(), watchlistId: z.string() })
    .strict(),
  'conglomerate.shared': z
    .object({ userId, actorId: z.string(), actorUsername: z.string(), conglomerateId: z.string() })
    .strict(),
  'friend.activity': z
    .object({
      userId,
      actorId: z.string(),
      actorUsername: z.string(),
      itemKind: z.enum(['portfolio', 'watchlist']),
      itemId: z.string(),
      activity: z.enum(['buy', 'sell', 'watchlist_add']),
      assetSymbol: z.string(),
    })
    .strict(),
  'follow.published': z
    .object({
      userId,
      actorId: z.string(),
      actorUsername: z.string(),
      itemKind,
      itemId: z.string(),
      itemName: z.string(),
    })
    .strict(),
  'follow.alert.created': z
    .object({
      userId,
      actorId: z.string(),
      actorUsername: z.string(),
      alertId: z.string(),
      assetId: z.string(),
    })
    .strict(),
  'follow.alert.fired': z
    .object({
      userId,
      actorId: z.string(),
      actorUsername: z.string(),
      alertId: z.string(),
      assetId: z.string(),
    })
    .strict(),
  /** Informational only — the credential itself never rides the event. */
  'account.temp_password': z.object({ userId }).strict(),
  /** Informational only — carries no download token. */
  'account.data_export': z.object({ userId }).strict(),
  /** Inbox parity minus the free-text company `name` (the symbol identifies it). */
  'earnings.reminder': z
    .object({
      userId,
      assetId: z.string(),
      symbol: z.string(),
      earningsDate: z.string(),
      estimated: z.boolean(),
    })
    .strict(),
  /**
   * Message ids and the sender only. `bodyPreview` — the first 140 characters of
   * the sender's private message — is deliberately ABSENT: a receiver URL may be
   * plain `http:`, and the push channel carries no preview either. A receiver
   * that wants the text refetches the thread through the enforcement layer.
   */
  'chat.message': z
    .object({
      userId,
      conversationId: z.string(),
      messageId: z.string(),
      senderId: z.string(),
      senderUsername: z.string(),
    })
    .strict(),
  /**
   * More than the inbox on purpose: the per-share payout and its currency are
   * public market data (never a holding size), and a dividend integration is
   * useless without them.
   */
  'dividend.event': z
    .object({
      userId,
      assetId: z.string(),
      symbol: z.string(),
      exDate: z.string(),
      payDate: z.string().nullable(),
      amount: z.number().nullable(),
      currency: z.string().nullable(),
    })
    .strict(),
  /** Inbox parity minus the user's free-text `categoryName`. */
  'budget.exceeded': z
    .object({
      userId,
      budgetId: z.string(),
      categoryId: z.string(),
      period: z.string(),
      amount: z.number(),
      spent: z.number(),
      currency: z.string(),
    })
    .strict(),
  'mirror.invite': mirrorPayloadSchema,
  'mirror.member_joined': mirrorPayloadSchema,
  'mirror.member_left': mirrorPayloadSchema,
  'mirror.member_removed': mirrorPayloadSchema,
  'mirror.removed': mirrorPayloadSchema,
  'mirror.ownership_transferred': mirrorPayloadSchema,
  'mirror.chain_dissolved': mirrorPayloadSchema,
  'mirror.sync_stalled': mirrorPayloadSchema,
  /** Inbox parity minus the user's free-text `orderLabel`. */
  'standing_order.skipped': z
    .object({
      userId,
      standingOrderId: z.string(),
      periodKey: z.string(),
      outcome: z.enum(['deferred', 'dropped', 'booking_failed']),
      droppedCount: z.number().int().optional(),
    })
    .strict(),
  'feedback.status_changed': z
    .object({
      userId,
      feedbackId: z.string(),
      status: feedbackStatusSchema,
      lastStatusChangeAt: z.string(),
    })
    .strict(),
  'feedback.reply_created': z
    .object({ userId, feedbackId: z.string(), messageId: z.string() })
    .strict(),
  /**
   * The commenter is named by `actorUsername` only: `actorId` is another
   * account's internal id and the inbox row omits it too.
   */
  'comment.created': z
    .object({
      userId,
      commentId: z.string(),
      itemKind,
      itemId: z.string(),
      itemName: z.string(),
      actorUsername: z.string(),
    })
    .strict(),
} as const satisfies Record<WebhookEventType, z.ZodTypeAny>;

/** The `data` a delivery of event type `T` carries. */
export type WebhookEventDataOf<T extends WebhookEventType> = z.infer<
  (typeof WEBHOOK_EVENT_PAYLOAD_SCHEMAS)[T]
>;

type WebhookEventPayloadVariant = {
  [T in WebhookEventType]: z.ZodObject<
    {
      id: z.ZodString;
      type: z.ZodLiteral<T>;
      createdAt: z.ZodString;
      data: (typeof WEBHOOK_EVENT_PAYLOAD_SCHEMAS)[T];
    },
    'strict'
  >;
}[WebhookEventType];

const webhookEventPayloadVariants = WEBHOOK_EVENT_TYPES.map((type) =>
  z
    .object({
      id: z.string(),
      type: z.literal(type),
      createdAt: z.string(),
      data: WEBHOOK_EVENT_PAYLOAD_SCHEMAS[type],
    })
    .strict(),
) as unknown as [WebhookEventPayloadVariant, ...WebhookEventPayloadVariant[]];

/**
 * The wire shape of a delivered payload (the POST body): a stable delivery `id`
 * (also the `X-BetterTrack-Delivery` header, which a receiver dedupes retries
 * on), the event `type`, the event's `createdAt`, and the type's allowlisted
 * `data` ({@link WEBHOOK_EVENT_PAYLOAD_SCHEMAS}). Documented for receivers — the
 * signature covers the serialized form of exactly this object.
 */
export const webhookEventPayloadSchema = z.discriminatedUnion('type', webhookEventPayloadVariants);
export type WebhookEventPayload = z.infer<typeof webhookEventPayloadSchema>;
