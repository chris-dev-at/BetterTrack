import { z } from 'zod';

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
 * A target URL: a valid absolute http(s) URL. Plain http is accepted (a
 * self-hosted LAN receiver is a first-class use case); the payload is signed
 * either way so the receiver can still authenticate it.
 *
 * Shape only — the network policy lives server-side (§8 "Outbound safety"): the
 * API additionally refuses any destination that resolves to loopback,
 * link-local/cloud metadata (`169.254.0.0/16`, `fe80::/10`), unspecified,
 * broadcast or another non-routable range, with
 * {@link WEBHOOK_URL_BLOCKED_CODE}. Private LAN ranges (RFC1918, `fc00::/7`)
 * stay allowed — that is the self-hosted-receiver case above.
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
    /** Short scrubbed failure reason; null on success. */
    error: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const webhookDeliveryListResponseSchema = z
  .object({ deliveries: z.array(webhookDeliverySchema) })
  .strict();
export type WebhookDeliveryListResponse = z.infer<typeof webhookDeliveryListResponseSchema>;

/**
 * The wire shape of a delivered payload (the POST body). `data` is the raw
 * user-scoped domain event; `id` is the unique delivery id (also the
 * `X-BetterTrack-Delivery` header) a receiver dedupes retries on. Documented for
 * receivers — the signature covers the serialized form of exactly this object.
 */
export const webhookEventPayloadSchema = z
  .object({
    id: z.string(),
    type: webhookEventTypeSchema,
    createdAt: z.string(),
    data: z.record(z.unknown()),
  })
  .strict();
export type WebhookEventPayload = z.infer<typeof webhookEventPayloadSchema>;
