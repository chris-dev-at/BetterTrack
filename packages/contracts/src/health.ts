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

/**
 * Response body of `GET /api/v1/version` — the public deploy-verification marker
 * (PROJECTPLAN.md §5 Meta). Reports which commit the running build was made from
 * and when, so anyone (human or script, no auth) can confirm a merged change
 * actually reached the live deployment.
 *
 * All three fields are plain strings and default to `"unknown"` when the build
 * did not stamp them, so the shape is always stable and the endpoint never fails.
 */
export const versionResponseSchema = z.object({
  /** Full git commit SHA the build was made from, or `"unknown"`. */
  commit: z.string(),
  /** Short (7-char) commit SHA, or `"unknown"`. */
  shortCommit: z.string(),
  /** UTC ISO-8601 build timestamp, or `"unknown"`. */
  builtAt: z.string(),
});

export type VersionResponse = z.infer<typeof versionResponseSchema>;
