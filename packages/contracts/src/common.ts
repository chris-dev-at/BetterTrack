import { z } from 'zod';

/** Standard API error envelope (PROJECTPLAN.md §8). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/** Reusable route-parameter schemas. */
export const idParamSchema = z.object({ id: z.string().uuid() }).strict();
export const tokenParamSchema = z.object({ token: z.string().min(1).max(256) }).strict();
