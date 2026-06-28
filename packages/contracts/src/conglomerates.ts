import { z } from 'zod';

import { assetSummarySchema } from './assets';

export const conglomerateStatusSchema = z.enum(['draft', 'active']);
export type ConglomerateStatus = z.infer<typeof conglomerateStatusSchema>;

export const backtestPreviewRangeSchema = z.enum(['1Y', '3Y', '5Y', 'Max']);
export type BacktestPreviewRange = z.infer<typeof backtestPreviewRangeSchema>;

export const conglomeratePositionSchema = z
  .object({
    id: z.string().uuid(),
    assetId: z.string().uuid(),
    weightPct: z.number().min(0).max(100),
    sortOrder: z.number().int().nonnegative(),
    asset: assetSummarySchema,
  })
  .strict();
export type ConglomeratePosition = z.infer<typeof conglomeratePositionSchema>;

export const conglomerateDetailSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    status: conglomerateStatusSchema,
    updatedAt: z.string().datetime(),
    positions: z.array(conglomeratePositionSchema),
  })
  .strict();
export type ConglomerateDetail = z.infer<typeof conglomerateDetailSchema>;

export const createConglomerateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();
export type CreateConglomerateRequest = z.infer<typeof createConglomerateRequestSchema>;

export const updateConglomerateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();
export type UpdateConglomerateRequest = z.infer<typeof updateConglomerateRequestSchema>;

export const replaceConglomeratePositionsRequestSchema = z
  .object({
    positions: z
      .array(
        z
          .object({
            assetId: z.string().uuid(),
            weightPct: z.number().min(0).max(100),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type ReplaceConglomeratePositionsRequest = z.infer<
  typeof replaceConglomeratePositionsRequestSchema
>;

export const conglomerateIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const previewPositionSchema = z
  .object({
    assetId: z.string().uuid(),
    weightPct: z.number().min(0).max(100),
  })
  .strict();

export const backtestPreviewRequestSchema = z
  .object({
    range: backtestPreviewRangeSchema,
    positions: z.array(previewPositionSchema).min(1).max(50),
  })
  .strict();
export type BacktestPreviewRequest = z.infer<typeof backtestPreviewRequestSchema>;

export const backtestSeriesPointSchema = z
  .object({
    date: z.string(),
    value: z.number(),
  })
  .strict();

export const backtestStatsSchema = z
  .object({
    totalReturnPct: z.number(),
    cagrPct: z.number().nullable(),
    maxDrawdownPct: z.number(),
    volatilityPct: z.number().nullable(),
    bestDay: z.object({ date: z.string(), returnPct: z.number() }).strict().nullable(),
    worstDay: z.object({ date: z.string(), returnPct: z.number() }).strict().nullable(),
  })
  .strict();
export type BacktestStats = z.infer<typeof backtestStatsSchema>;

export const backtestPreviewResponseSchema = z
  .object({
    range: backtestPreviewRangeSchema,
    series: z.array(backtestSeriesPointSchema),
    stats: backtestStatsSchema.nullable(),
    notice: z.string().nullable(),
  })
  .strict();
export type BacktestPreviewResponse = z.infer<typeof backtestPreviewResponseSchema>;
