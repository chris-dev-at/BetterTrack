import { z } from 'zod';

import { assetTypeSchema, currencyCodeSchema } from './market';

/**
 * Price alerts (PROJECTPLAN.md §14, V3-P10 arc b). A user attaches a rule to an
 * asset; a minute evaluator fires it against the cached quote and fans the
 * `alert.triggered` notification out through the matrix. This contract is the
 * single source of truth for the CRUD surface (`/api/v1/alerts`) — the API
 * validates against it and the SPA derives its types from it, so they cannot
 * drift.
 */

/** The six §14 rule kinds. */
export const ALERT_KINDS = [
  'price_above',
  'price_below',
  'pct_up_from_ref',
  'pct_down_from_ref',
  'pct_day_up',
  'pct_day_down',
] as const;
export const alertKindSchema = z.enum(ALERT_KINDS);
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * Kinds whose threshold is measured against a **reference price captured at
 * creation** (§14). For these the service snapshots the current quote into
 * `refPrice`; every other kind leaves it null.
 */
export const REF_PRICE_ALERT_KINDS = ['pct_up_from_ref', 'pct_down_from_ref'] as const;
export type RefPriceAlertKind = (typeof REF_PRICE_ALERT_KINDS)[number];

/** Whether a kind captures a reference price at creation. */
export function isRefPriceKind(kind: AlertKind): kind is RefPriceAlertKind {
  return (REF_PRICE_ALERT_KINDS as readonly AlertKind[]).includes(kind);
}

/**
 * Lifecycle status. `active` alerts are evaluated; a one-shot flips to
 * `triggered` after firing (manual re-arm returns it to `active`); `disabled`
 * is parked and never evaluated.
 */
export const ALERT_STATUSES = ['active', 'triggered', 'disabled'] as const;
export const alertStatusSchema = z.enum(ALERT_STATUSES);
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** Asset identity embedded in an alert row, so the UI needs no follow-up lookup. */
export const alertAssetSchema = z
  .object({
    id: z.string().uuid(),
    symbol: z.string(),
    name: z.string(),
    currency: currencyCodeSchema,
    type: assetTypeSchema,
  })
  .strict();
export type AlertAsset = z.infer<typeof alertAssetSchema>;

/** One alert as read back on the CRUD surface (§8). */
export const alertSchema = z
  .object({
    id: z.string().uuid(),
    kind: alertKindSchema,
    /** Price (for `price_*`) or percent magnitude (for the `pct_*` kinds). */
    threshold: z.number(),
    /** Reference price captured at creation for the `*_from_ref` kinds; else null. */
    refPrice: z.number().nullable(),
    /** Repeat with a 24 h cooldown, vs. one-shot (`false`). */
    repeat: z.boolean(),
    status: alertStatusSchema,
    /** ISO-8601 of the last fire, or null if it has never fired. */
    lastTriggeredAt: z.string().datetime().nullable(),
    asset: alertAssetSchema,
  })
  .strict();
export type Alert = z.infer<typeof alertSchema>;

/** `GET /alerts` response. */
export const alertListResponseSchema = z.object({ items: z.array(alertSchema) }).strict();
export type AlertListResponse = z.infer<typeof alertListResponseSchema>;

/**
 * `POST /alerts` body. `refPrice` is never client-supplied — the service
 * snapshots the current quote for the `*_from_ref` kinds. `repeat` defaults to
 * one-shot.
 */
export const createAlertRequestSchema = z
  .object({
    assetId: z.string().uuid(),
    kind: alertKindSchema,
    threshold: z.number().positive(),
    repeat: z.boolean().optional(),
  })
  .strict();
export type CreateAlertRequest = z.infer<typeof createAlertRequestSchema>;

/**
 * `PATCH /alerts/{id}` body — tweak the threshold and/or repeat behaviour. At
 * least one field must be present. The kind and asset are immutable (create a
 * new alert instead), which keeps a captured `refPrice` meaningful.
 */
export const updateAlertRequestSchema = z
  .object({
    threshold: z.number().positive().optional(),
    repeat: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.threshold !== undefined || body.repeat !== undefined, {
    message: 'At least one field is required.',
  });
export type UpdateAlertRequest = z.infer<typeof updateAlertRequestSchema>;

/** Route param for a single alert. */
export const alertIdParamSchema = z.object({ id: z.string().uuid() }).strict();

// --- Alert sharing (visibility to followers, #455) ---------------------------

/**
 * The owner's alert-visibility setting (#455): whether the caller's price
 * alerts are exposed to their followers. Alerts reveal which assets a person
 * watches plus their price targets, so this is OFF by default — while OFF a
 * follower's alert-follow triggers deliver nothing. One per-user flag over the
 * whole alert list (§16 2026-07-14: followers are not friends, so the V3-P5
 * friend-scoped audience rungs don't map onto the follower relation).
 */
export const alertSharingResponseSchema = z.object({ visibleToFollowers: z.boolean() }).strict();
export type AlertSharingResponse = z.infer<typeof alertSharingResponseSchema>;

/**
 * `PUT /alerts/sharing` body. Enabling exposes every current and future alert
 * to ALL followers (anyone may follow), so the privacy friction ladder applies:
 * the server rejects `visibleToFollowers: true` without the explicit
 * acknowledgment — defense-in-depth behind the UI warning. Disabling needs no
 * ack and stops follower delivery immediately.
 */
export const updateAlertSharingRequestSchema = z
  .object({
    visibleToFollowers: z.boolean(),
    acknowledgeFollowers: z.boolean().optional(),
  })
  .strict();
export type UpdateAlertSharingRequest = z.infer<typeof updateAlertSharingRequestSchema>;
