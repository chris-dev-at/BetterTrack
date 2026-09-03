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

/**
 * Byte ceilings every captured field is cut to before it is written, and the
 * marker a cut leaves behind. Declared HERE, not only in the API, because they
 * are part of the shape both sides read: the admin page renders these values
 * verbatim, so it must know a value ending in {@link PROBLEM_TRUNCATION_MARKER}
 * is a bounded copy rather than the whole error.
 *
 * The bounds exist because the capture budget counts ROWS PER MINUTE and never
 * bytes: an upstream 5xx HTML body inside a provider error is one legal capture
 * of several hundred KB, and sixty of those a minute grow the table (and wedge
 * the page that renders them) while every rate guard reads healthy.
 */
export const PROBLEM_TITLE_MAX_BYTES = 300;
export const PROBLEM_MESSAGE_MAX_BYTES = 8_000;
/** Ceiling on one context value (the stack is the largest of them). */
export const PROBLEM_CONTEXT_VALUE_MAX_BYTES = 4_000;
/** Ceiling on the whole serialized context tree. */
export const PROBLEM_CONTEXT_MAX_BYTES = 8_000;
/** Appended to any value the bounds cut, so a truncated value reads as one. */
export const PROBLEM_TRUNCATION_MARKER = '… [truncated]';
/** Context key set to `true` when the bounds dropped or cut anything below it. */
export const PROBLEM_CONTEXT_TRUNCATED_KEY = 'truncated';

/**
 * The context keys an unhandled request 500 carries (`kind: 'error'`). Every
 * capture kind stores its own scrubbed shape under `problem.context` — the job
 * kind stores `{queue, jobId}`, the provider kind `{providerId}` — so the schema
 * is a partial with passthrough: the admin page reads the request facts it knows
 * how to render and shows everything else as JSON.
 *
 * `route` is the PARAMETERISED template (`/api/v1/portfolios/:id`), never the
 * concrete path: it enters the fold key, so a raw path would split one broken
 * endpoint into a row per id.
 */
export const problemContextSchema = z
  .object({
    /** HTTP method of the failed request. */
    method: z.string().optional(),
    /** Parameterised, lowercased route template — never a raw path with ids. */
    route: z.string().optional(),
    /** Response status the request ended with (500 for an unhandled throw). */
    status: z.number().int().optional(),
    /** Correlates the captured row with the `Unhandled request error` log line. */
    requestId: z.string().optional(),
    /** Scrubbed, frame- and byte-bounded stack of the thrown error. */
    stack: z.string().optional(),
  })
  .passthrough();
export type ProblemContext = z.infer<typeof problemContextSchema>;

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
  /**
   * A REGRESSION: this problem was resolved and then happened again, so the
   * capture reopened it. Derived server-side from `resolved_at` vs
   * `last_seen_at` (no column of its own), and true only while that earlier
   * resolution still stands — resolving or manually reopening clears it.
   */
  regressed: z.boolean(),
});
export type Problem = z.infer<typeof problemSchema>;

/** List/filter query for `GET /admin/problems`. */
export const problemListQuerySchema = z
  .object({
    kind: problemKindSchema.optional(),
    status: problemStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Rows to skip — the paging cursor, in `lastSeenAt desc` order. */
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ProblemListQuery = z.infer<typeof problemListQuerySchema>;

export const problemListResponseSchema = z.object({
  problems: z.array(problemSchema),
  /** Open-problem count regardless of the current filter — the badge source. */
  openCount: z.number().int().nonnegative(),
  /** How many rows match the CURRENT filter, ignoring limit/offset. */
  total: z.number().int().nonnegative(),
  /** Whether another page exists past this one (`offset + rows < total`). */
  hasMore: z.boolean(),
  /**
   * Captures the rate cap refused in the CURRENT window. Non-zero means the
   * list is an incomplete picture of the incident — the admin surface is the
   * only management surface (§16 2026-07-17), so a drop that is visible solely
   * in the container log is a drop the operator never learns about.
   */
  droppedCaptures: z.number().int().nonnegative(),
  /** Captures refused since the process booted (the same counter, cumulative). */
  droppedCapturesTotal: z.number().int().nonnegative(),
});
export type ProblemListResponse = z.infer<typeof problemListResponseSchema>;
