import { z } from 'zod';

/**
 * Response body of `GET /api/v1/health`.
 *
 * Defined once here so the API validates against it and the web (and any
 * future) client derives its types from the same source — the keystone of
 * the layer separation described in PROJECTPLAN.md §4.2.
 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('bettertrack-api'),
  version: z.string().min(1),
  timestamp: z.string().datetime(),
  uptime: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
