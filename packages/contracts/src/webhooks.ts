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
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

/** Signature transport headers on every delivery POST. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-BetterTrack-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-BetterTrack-Timestamp';
export const WEBHOOK_EVENT_HEADER = 'X-BetterTrack-Event';
export const WEBHOOK_DELIVERY_HEADER = 'X-BetterTrack-Delivery';

/**
 * Signature scheme: the header value is `sha256=<hex>` where the hex is the
 * HMAC-SHA256 of `` `${timestamp}.${body}` `` under the subscription secret
 * (the GitHub/Stripe convention — the timestamp is bound in, so a captured body
 * cannot be replayed with a new timestamp).
 */
export const WEBHOOK_SIGNATURE_SCHEME = 'sha256';

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
 * A target URL: a valid absolute http(s) URL. Plain http is accepted (a
 * self-hosted LAN receiver is a first-class use case); the payload is signed
 * either way so the receiver can still authenticate it.
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
