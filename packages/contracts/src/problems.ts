import { z } from 'zod';

/**
 * Admin "Problems" surface (PROJECTPLAN.md §13.5 V5-P2, arc (d) — the Sentry
 * replacement). Unhandled request errors, permanently-failed jobs and provider
 * failures are captured into the DB (rate-capped, PII-scrubbed) and surfaced on
 * an admin page with a status/resolve flow, next to Health.
 *
 * Shapes defined once here so the API validates against them and the admin SPA
 * derives its types from the same source (§4.2). No raw error bodies, tokens or
 * emails ever reach these fields — the server scrubs before persisting.
 */

/** What produced the problem. Mirrors the DB `problem_kind` enum. */
export const PROBLEM_KINDS = ['error', 'job', 'provider'] as const;
export const problemKindSchema = z.enum(PROBLEM_KINDS);
export type ProblemKind = z.infer<typeof problemKindSchema>;

/** Lifecycle status. Mirrors the DB `problem_status` enum. */
export const PROBLEM_STATUSES = ['open', 'resolved'] as const;
export const problemStatusSchema = z.enum(PROBLEM_STATUSES);
export type ProblemStatus = z.infer<typeof problemStatusSchema>;

/** One captured problem, deduped by fingerprint with an occurrence count. */
export const problemSchema = z.object({
  id: z.string().uuid(),
  kind: problemKindSchema,
  /** Stable dedupe key (a hash); shown for support, never a secret. */
  fingerprint: z.string(),
  /** Short scrubbed headline (error name / `<queue> job` / `<provider>`). */
  title: z.string(),
  /** Scrubbed message; may be empty. */
  message: z.string(),
  /** Scrubbed structured context (queue/provider/meta), or null. */
  context: z.unknown().nullable(),
  status: problemStatusSchema,
  occurrenceCount: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  resolvedBy: z.string().uuid().nullable(),
});
export type Problem = z.infer<typeof problemSchema>;

/** List/filter query for `GET /admin/problems`. */
export const problemListQuerySchema = z
  .object({
    kind: problemKindSchema.optional(),
    status: problemStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ProblemListQuery = z.infer<typeof problemListQuerySchema>;

export const problemListResponseSchema = z.object({
  problems: z.array(problemSchema),
  /** Open-problem count regardless of the current filter — the badge source. */
  openCount: z.number().int().nonnegative(),
});
export type ProblemListResponse = z.infer<typeof problemListResponseSchema>;
