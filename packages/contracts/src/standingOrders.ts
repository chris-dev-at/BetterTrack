import { z } from 'zod';

import { currencyCodeSchema } from './market';

/**
 * Standing orders — scheduled recurring actions that auto-record on their own
 * schedule (PROJECTPLAN.md §13.5 V5-P6b arc (a), the V6-4 spec verbatim; owner
 * naming: "standing order" / *Dauerauftrag*). Three kinds:
 *
 *  - `buy-asset` — "buy X of asset Y" — books a BUY transaction of `amount`
 *    units at the current provider quote (priced in the asset's native
 *    currency);
 *  - `cash-add` — "add €N as 'salary'" — books a cash **deposit** of `amount` €;
 *  - `cash-deduct` — "deduct €20 as 'Netflix'" — books a cash **withdrawal**.
 *
 * A daily job books the single most-recent due occurrence per order exactly once
 * (idempotent per period, §16 planner note: after downtime only the newest
 * missed period is booked, never a backlog), and every auto-recorded row carries
 * the `standing-order` source tag (V5-P0c) so it can never be confused with a
 * hand entry. Cadence is `daily` (every day from `startDate`) or `monthly`
 * (once per month on `anchorDay`, clamped to month-end in shorter months).
 * `amount` means a share quantity for `buy-asset` and a EUR magnitude for the
 * cash kinds; the sign is assigned by kind, never supplied. `currency` is
 * server-derived (EUR for cash; the asset's native currency for a buy) and
 * returned for display only.
 */

export const STANDING_ORDER_KINDS = ['buy-asset', 'cash-add', 'cash-deduct'] as const;
export const standingOrderKindSchema = z.enum(STANDING_ORDER_KINDS);
export type StandingOrderKind = z.infer<typeof standingOrderKindSchema>;

export const STANDING_ORDER_CADENCES = ['daily', 'monthly'] as const;
export const standingOrderCadenceSchema = z.enum(STANDING_ORDER_CADENCES);
export type StandingOrderCadence = z.infer<typeof standingOrderCadenceSchema>;

export const STANDING_ORDER_STATUSES = ['active', 'paused'] as const;
export const standingOrderStatusSchema = z.enum(STANDING_ORDER_STATUSES);
export type StandingOrderStatus = z.infer<typeof standingOrderStatusSchema>;

/** Label cap ("salary", "Netflix") — a short note, mirrors other short names. */
export const STANDING_ORDER_LABEL_MAX = 120;
/** Amount cap — a large finite ceiling shared by share quantities and EUR amounts. */
export const STANDING_ORDER_AMOUNT_MAX = 1_000_000_000;

/** An ISO `YYYY-MM-DD` calendar day (the schedule speaks in calendar dates). */
const isoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO YYYY-MM-DD day');

/**
 * Create a standing order. `assetId` is required exactly for `buy-asset` and
 * rejected for the cash kinds; `anchorDay` (1–31) is required exactly for
 * `monthly` and rejected for `daily`. `startDate` defaults to today server-side
 * when omitted; `endDate` (optional, inclusive) must not precede it. `currency`
 * is never client-supplied — the server derives it (EUR / asset native).
 */
export const createStandingOrderRequestSchema = z
  .object({
    portfolioId: z.string().uuid(),
    kind: standingOrderKindSchema,
    assetId: z.string().uuid().optional(),
    amount: z.number().positive().finite().max(STANDING_ORDER_AMOUNT_MAX),
    label: z.string().trim().min(1).max(STANDING_ORDER_LABEL_MAX).optional(),
    cadence: standingOrderCadenceSchema,
    anchorDay: z.number().int().min(1).max(31).optional(),
    startDate: isoDaySchema.optional(),
    endDate: isoDaySchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'buy-asset' && v.assetId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetId'],
        message: 'assetId is required for a buy-asset standing order.',
      });
    }
    if (v.kind !== 'buy-asset' && v.assetId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetId'],
        message: 'assetId applies only to a buy-asset standing order.',
      });
    }
    if (v.cadence === 'monthly' && v.anchorDay === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['anchorDay'],
        message: 'anchorDay (1–31) is required for a monthly standing order.',
      });
    }
    if (v.cadence === 'daily' && v.anchorDay !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['anchorDay'],
        message: 'anchorDay applies only to a monthly standing order.',
      });
    }
    if (v.startDate !== undefined && v.endDate !== undefined && v.endDate < v.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate must be on or after startDate.',
      });
    }
  });
export type CreateStandingOrderRequest = z.infer<typeof createStandingOrderRequestSchema>;

/**
 * Edit a standing order's mutable fields. Only `amount`, `label` and `endDate`
 * are editable — the kind, asset, portfolio and schedule (cadence/anchor/start)
 * are immutable so a live order's period identity never shifts under it (change
 * those by deleting + recreating). `label`/`endDate` accept `null` to clear.
 */
export const updateStandingOrderRequestSchema = z
  .object({
    amount: z.number().positive().finite().max(STANDING_ORDER_AMOUNT_MAX).optional(),
    label: z.string().trim().min(1).max(STANDING_ORDER_LABEL_MAX).nullish(),
    endDate: isoDaySchema.nullish(),
  })
  .strict();
export type UpdateStandingOrderRequest = z.infer<typeof updateStandingOrderRequestSchema>;

/** One standing order, as returned by the API. `nextRunDate` is computed, never stored. */
export const standingOrderSchema = z
  .object({
    id: z.string().uuid(),
    portfolioId: z.string().uuid(),
    kind: standingOrderKindSchema,
    /** Set exactly for `buy-asset`; null for the cash kinds. */
    assetId: z.string().uuid().nullable(),
    assetSymbol: z.string().nullable(),
    assetName: z.string().nullable(),
    /** Share quantity (`buy-asset`) or EUR magnitude (cash kinds); always > 0. */
    amount: z.number(),
    currency: currencyCodeSchema,
    label: z.string().nullable(),
    cadence: standingOrderCadenceSchema,
    /** 1–31 for `monthly` (clamped to month-end when the month is shorter); null for `daily`. */
    anchorDay: z.number().int().nullable(),
    startDate: isoDaySchema,
    endDate: isoDaySchema.nullable(),
    status: standingOrderStatusSchema,
    /** When the job last booked a period for this order (ISO-8601), or null. */
    lastRunAt: z.string().datetime().nullable(),
    /** The occurrence day last booked (ISO `YYYY-MM-DD`), or null. */
    lastPeriodKey: isoDaySchema.nullable(),
    /** The next day this order will fire, or null when paused / past its end date. */
    nextRunDate: isoDaySchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type StandingOrder = z.infer<typeof standingOrderSchema>;

export const standingOrderListResponseSchema = z
  .object({ orders: z.array(standingOrderSchema) })
  .strict();
export type StandingOrderListResponse = z.infer<typeof standingOrderListResponseSchema>;

/** Optional `?portfolioId=` filter for the list endpoint. */
export const standingOrderListQuerySchema = z
  .object({ portfolioId: z.string().uuid().optional() })
  .strict();
export type StandingOrderListQuery = z.infer<typeof standingOrderListQuerySchema>;

export const standingOrderIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export type StandingOrderIdParam = z.infer<typeof standingOrderIdParamSchema>;
