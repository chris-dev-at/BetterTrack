import { z } from 'zod';

/**
 * Feedback categories in their wire-compatible order. The first three values
 * shipped to mobile in #1315; new categories must only ever be appended.
 */
export const FEEDBACK_CATEGORIES = ['feature', 'bug', 'other', 'help', 'improvement'] as const;
export const feedbackCategorySchema = z.enum(FEEDBACK_CATEGORIES);
export type FeedbackCategory = z.infer<typeof feedbackCategorySchema>;

/** Open, non-deleted requests allowed per submitter before triage must make room. */
export const FEEDBACK_OPEN_SUBMISSION_LIMIT = 20;
export const FEEDBACK_OPEN_LIMIT = 'FEEDBACK_OPEN_LIMIT';

/** User-authored feedback body and optional subject limits. */
export const FEEDBACK_MESSAGE_MAX_LENGTH = 5000;
export const FEEDBACK_SUBJECT_MAX_LENGTH = 120;

/**
 * Client diagnostics stay deliberately extensible: web and native clients may
 * send their platform, app/OS version, device, locale, screen, and future
 * diagnostics without a server release. The outer object is bounded so this
 * convenience cannot become an unbounded JSON storage surface.
 */
export const FEEDBACK_CONTEXT_MAX_KEYS = 32;
export const FEEDBACK_CONTEXT_MAX_BYTES = 16 * 1024;

export const feedbackContextSchema = z
  .record(z.string(), z.unknown())
  .superRefine((context, refinement) => {
    if (Object.keys(context).length > FEEDBACK_CONTEXT_MAX_KEYS) {
      refinement.addIssue({
        code: 'custom',
        message: `Context must contain at most ${FEEDBACK_CONTEXT_MAX_KEYS} keys.`,
      });
    }

    let byteLength: number;
    try {
      byteLength = new TextEncoder().encode(JSON.stringify(context)).length;
    } catch {
      refinement.addIssue({ code: 'custom', message: 'Context must be valid JSON.' });
      return;
    }
    if (byteLength > FEEDBACK_CONTEXT_MAX_BYTES) {
      refinement.addIssue({
        code: 'custom',
        message: `Context must serialise to at most ${FEEDBACK_CONTEXT_MAX_BYTES} bytes.`,
      });
    }
  });
export type FeedbackContext = z.infer<typeof feedbackContextSchema>;

/** `POST /feedback` body — authenticated, text-only feedback from any client. */
export const createFeedbackRequestSchema = z
  .object({
    category: feedbackCategorySchema,
    message: z.string().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH),
    subject: z.string().max(FEEDBACK_SUBJECT_MAX_LENGTH).optional(),
    context: feedbackContextSchema.optional(),
  })
  .strict();
export type CreateFeedbackRequest = z.infer<typeof createFeedbackRequestSchema>;

/** `POST /feedback` success — the durable row id and server creation stamp. */
export const createFeedbackResponseSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CreateFeedbackResponse = z.infer<typeof createFeedbackResponseSchema>;

/**
 * Feedback lifecycle states in the owner triage queue. `new` and `triaged`
 * retain the names shipped by #1315; the outcome states close the loop without
 * the ambiguous former `done` value.
 */
export const FEEDBACK_STATUSES = [
  'new',
  'triaged',
  'working_on_it',
  'saved_as_future_idea',
  'declined',
  'shipped',
] as const;
export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

/**
 * The lifecycle partition behind the per-submitter open cap. Every status must
 * appear in exactly one of the two lists; the contracts test asserts terminal ∪
 * open equals `FEEDBACK_STATUSES` and that the two are disjoint, so a seventh
 * status cannot be added and then silently counted as open (or silently
 * released from the cap) the way a raw SQL literal list allowed.
 */
export const FEEDBACK_TERMINAL_STATUSES = [
  'declined',
  'shipped',
] as const satisfies readonly FeedbackStatus[];
export type FeedbackTerminalStatus = (typeof FEEDBACK_TERMINAL_STATUSES)[number];

/**
 * The complement of the terminal set: what still occupies an open slot. Only
 * the terminal half is load-bearing at runtime (the cap predicate is a
 * `notInArray`), so this list has no production consumer by design — it exists
 * so the partition test can force a seventh status to be classified. Not dead
 * code; do not delete it as such.
 */
export const FEEDBACK_OPEN_STATUSES = [
  'new',
  'triaged',
  'working_on_it',
  'saved_as_future_idea',
] as const satisfies readonly FeedbackStatus[];
export type FeedbackOpenStatus = (typeof FEEDBACK_OPEN_STATUSES)[number];

export const FEEDBACK_DECLINED_REASON_MAX_LENGTH = 1000;
export const FEEDBACK_SHIPPED_VERSION_MAX_LENGTH = 64;

/** Stable API error codes for the two owner-required outcome details. */
export const FEEDBACK_DECLINED_REASON_REQUIRED = 'FEEDBACK_DECLINED_REASON_REQUIRED';
export const FEEDBACK_SHIPPED_VERSION_REQUIRED = 'FEEDBACK_SHIPPED_VERSION_REQUIRED';
export const FEEDBACK_STATUS_DETAILS_INVALID = 'FEEDBACK_STATUS_DETAILS_INVALID';

/** Stable `ApiError.error.code` values emitted when a new submission is refused. */
export const FEEDBACK_SUBMISSION_ERROR_CODES = [FEEDBACK_OPEN_LIMIT] as const;

/** Stable `ApiError.error.code` values emitted by feedback lifecycle validation. */
export const FEEDBACK_STATUS_ERROR_CODES = [
  FEEDBACK_DECLINED_REASON_REQUIRED,
  FEEDBACK_SHIPPED_VERSION_REQUIRED,
  FEEDBACK_STATUS_DETAILS_INVALID,
] as const;

/** All stable feedback error codes, composed from the route-level subsets above. */
export const FEEDBACK_ERROR_CODES = [
  ...FEEDBACK_SUBMISSION_ERROR_CODES,
  ...FEEDBACK_STATUS_ERROR_CODES,
] as const;
export type FeedbackErrorCode = (typeof FEEDBACK_ERROR_CODES)[number];

interface FeedbackStatusDetails {
  status: FeedbackStatus;
  declinedReason?: string | null;
  shippedVersion?: string | null;
}

function addStatusDetailIssue(
  refinement: z.RefinementCtx,
  path: 'declinedReason' | 'shippedVersion',
  code: string,
  message: string,
): void {
  refinement.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message,
    params: { apiErrorCode: code },
  });
}

/**
 * Pair lifecycle outcomes with their required explanation/version. Custom issue
 * metadata lets the generic HTTP validator return a stable, actionable error
 * code while the rule itself remains owned by this shared contract.
 */
function refineFeedbackStatusDetails(
  value: FeedbackStatusDetails,
  refinement: z.RefinementCtx,
): void {
  const hasDeclinedReason =
    typeof value.declinedReason === 'string' && value.declinedReason.trim().length > 0;
  const hasShippedVersion =
    typeof value.shippedVersion === 'string' && value.shippedVersion.trim().length > 0;

  if (value.status === 'declined' && !hasDeclinedReason) {
    addStatusDetailIssue(
      refinement,
      'declinedReason',
      FEEDBACK_DECLINED_REASON_REQUIRED,
      'A declined submission requires a reason.',
    );
  } else if (value.status !== 'declined' && value.declinedReason != null) {
    addStatusDetailIssue(
      refinement,
      'declinedReason',
      FEEDBACK_STATUS_DETAILS_INVALID,
      'A declined reason is only valid for declined submissions.',
    );
  }

  if (value.status === 'shipped' && !hasShippedVersion) {
    addStatusDetailIssue(
      refinement,
      'shippedVersion',
      FEEDBACK_SHIPPED_VERSION_REQUIRED,
      'A shipped submission requires a version.',
    );
  } else if (value.status !== 'shipped' && value.shippedVersion != null) {
    addStatusDetailIssue(
      refinement,
      'shippedVersion',
      FEEDBACK_STATUS_DETAILS_INVALID,
      'A shipped version is only valid for shipped submissions.',
    );
  }
}

/** Available inbox orderings; category priority is the owner-defined default. */
export const FEEDBACK_SORTS = ['category', 'newest'] as const;
export const feedbackSortSchema = z.enum(FEEDBACK_SORTS);
export type FeedbackSort = z.infer<typeof feedbackSortSchema>;

/** One owner-visible submission, including the authenticated submitter. */
export const adminFeedbackSubmissionSchema = z
  .object({
    id: z.string().uuid(),
    category: feedbackCategorySchema,
    subject: z.string().nullable(),
    message: z.string(),
    context: feedbackContextSchema.nullable(),
    status: feedbackStatusSchema,
    lastStatusChangeAt: z.string().datetime(),
    declinedReason: z.string().max(FEEDBACK_DECLINED_REASON_MAX_LENGTH).nullable(),
    shippedVersion: z.string().max(FEEDBACK_SHIPPED_VERSION_MAX_LENGTH).nullable(),
    deletedByUser: z.boolean(),
    /** Admin-only workspace state; submitter-facing responses never carry it. */
    archivedAt: z.string().datetime().nullable(),
    submitter: z
      .object({
        id: z.string().uuid(),
        username: z.string(),
        email: z.string().email(),
      })
      .strict(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(refineFeedbackStatusDetails);
export type AdminFeedbackSubmission = z.infer<typeof adminFeedbackSubmissionSchema>;

/** One caller-owned submission returned by `GET /feedback/mine`. */
export const myFeedbackSubmissionSchema = z
  .object({
    id: z.string().uuid(),
    category: feedbackCategorySchema,
    subject: z.string().nullable(),
    message: z.string(),
    status: feedbackStatusSchema,
    lastStatusChangeAt: z.string().datetime(),
    declinedReason: z.string().max(FEEDBACK_DECLINED_REASON_MAX_LENGTH).nullable(),
    shippedVersion: z.string().max(FEEDBACK_SHIPPED_VERSION_MAX_LENGTH).nullable(),
    unreadReplyCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine(refineFeedbackStatusDetails);
export type MyFeedbackSubmission = z.infer<typeof myFeedbackSubmissionSchema>;

export const myFeedbackResponseSchema = z
  .object({ submissions: z.array(myFeedbackSubmissionSchema) })
  .strict();
export type MyFeedbackResponse = z.infer<typeof myFeedbackResponseSchema>;

/** Support-thread authors are explicit because admins and submitters use separate auth rails. */
export const FEEDBACK_MESSAGE_AUTHOR_SIDES = ['submitter', 'admin'] as const;
export const feedbackMessageAuthorSideSchema = z.enum(FEEDBACK_MESSAGE_AUTHOR_SIDES);
export type FeedbackMessageAuthorSide = z.infer<typeof feedbackMessageAuthorSideSchema>;

/** Keep feedback replies aligned with chat's bounded, text-only message body. */
export const FEEDBACK_THREAD_MESSAGE_MAX_LENGTH = 4000;

/**
 * One message in a submission-owned support thread. `senderId`, `body`, and
 * `createdAt` intentionally match chat's message idiom — including its
 * nullability: a deleted author anonymizes their messages instead of recalling
 * them (#362), and `authorSide` keeps the staff boundary explicit either way,
 * without adding chat-only chip fields.
 *
 * `senderId` is additionally viewer-relative: on the submitter rail an
 * admin-side row always reads `null`, because a staff account's internal id is
 * identity the product surfaces to a user nowhere else (the account export
 * scrubs the same field). On the admin rail it is the queue's record of who
 * answered. Consumers must therefore attribute from `authorSide`, never from
 * the presence of an id.
 */
export const feedbackThreadMessageSchema = z
  .object({
    id: z.string().uuid(),
    feedbackId: z.string().uuid(),
    senderId: z.string().uuid().nullable(),
    authorSide: feedbackMessageAuthorSideSchema,
    body: z.string().min(1).max(FEEDBACK_THREAD_MESSAGE_MAX_LENGTH),
    createdAt: z.string().datetime(),
  })
  .strict();
export type FeedbackThreadMessage = z.infer<typeof feedbackThreadMessageSchema>;

/** Viewer-relative thread summary; unread is always derived from a last-read marker. */
export const feedbackThreadSummarySchema = z
  .object({
    id: z.string().uuid(),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type FeedbackThreadSummary = z.infer<typeof feedbackThreadSummarySchema>;

/**
 * A cursor that names no message in the addressed thread — stale, foreign, or
 * fabricated. Answered as a 400 rather than silently re-serving page one, which
 * would loop a client on the same page under a cursor that never advances.
 */
export const FEEDBACK_THREAD_CURSOR_UNKNOWN = 'FEEDBACK_THREAD_CURSOR_UNKNOWN';

/** Newest-first keyset pagination, structurally parallel to a chat thread query. */
export const feedbackThreadQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type FeedbackThreadQuery = z.infer<typeof feedbackThreadQuerySchema>;

/** A page of one feedback thread, using chat's messages + nextCursor response idiom. */
export const feedbackThreadResponseSchema = z
  .object({
    thread: feedbackThreadSummarySchema,
    messages: z.array(feedbackThreadMessageSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type FeedbackThreadResponse = z.infer<typeof feedbackThreadResponseSchema>;

/** Both submitters and admins post the same bounded text-only shape. */
export const sendFeedbackMessageRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(FEEDBACK_THREAD_MESSAGE_MAX_LENGTH),
  })
  .strict();
export type SendFeedbackMessageRequest = z.infer<typeof sendFeedbackMessageRequestSchema>;

export const sendFeedbackMessageResponseSchema = z
  .object({ message: feedbackThreadMessageSchema })
  .strict();
export type SendFeedbackMessageResponse = z.infer<typeof sendFeedbackMessageResponseSchema>;

/** Filter, order and page controls for `GET /admin/feedback`. */
export const adminFeedbackListQuerySchema = z
  .object({
    category: feedbackCategorySchema.optional(),
    // Query strings arrive as text: `z.coerce.boolean()` would treat the
    // literal "false" as true and silently show the wrong inbox.
    archived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    sort: feedbackSortSchema.default('category'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AdminFeedbackListQuery = z.infer<typeof adminFeedbackListQuerySchema>;

export const adminFeedbackListResponseSchema = z
  .object({
    submissions: z.array(adminFeedbackSubmissionSchema),
    pagination: z
      .object({
        page: z.number().int().min(1),
        limit: z.number().int().min(1).max(100),
        total: z.number().int().nonnegative(),
        totalPages: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type AdminFeedbackListResponse = z.infer<typeof adminFeedbackListResponseSchema>;

/** Admin status transition for one submission. */
export const updateFeedbackStatusRequestSchema = z
  .object({
    status: feedbackStatusSchema,
    declinedReason: z.string().max(FEEDBACK_DECLINED_REASON_MAX_LENGTH).nullable().optional(),
    shippedVersion: z.string().max(FEEDBACK_SHIPPED_VERSION_MAX_LENGTH).nullable().optional(),
  })
  .strict()
  .superRefine(refineFeedbackStatusDetails);
export type UpdateFeedbackStatusRequest = z.infer<typeof updateFeedbackStatusRequestSchema>;

export const updateFeedbackStatusResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: feedbackStatusSchema,
    lastStatusChangeAt: z.string().datetime(),
    declinedReason: z.string().max(FEEDBACK_DECLINED_REASON_MAX_LENGTH).nullable(),
    shippedVersion: z.string().max(FEEDBACK_SHIPPED_VERSION_MAX_LENGTH).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(refineFeedbackStatusDetails);
export type UpdateFeedbackStatusResponse = z.infer<typeof updateFeedbackStatusResponseSchema>;

/** Explicit admin workspace archive state; independent from lifecycle status. */
export const updateFeedbackArchiveRequestSchema = z.object({ archived: z.boolean() }).strict();
export type UpdateFeedbackArchiveRequest = z.infer<typeof updateFeedbackArchiveRequestSchema>;

export const updateFeedbackArchiveResponseSchema = z
  .object({
    id: z.string().uuid(),
    archivedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type UpdateFeedbackArchiveResponse = z.infer<typeof updateFeedbackArchiveResponseSchema>;

/**
 * The existing generic admin PATCH accepts exactly one independent mutation.
 *
 * The `.strict()` on BOTH members is load-bearing, not cosmetic: the route
 * discriminates on `'archived' in body` (`adminFeedbackRoutes.ts`), which is
 * only sound because a status body cannot carry an `archived` key past
 * validation. A future non-strict member would silently route a status body
 * into the archive branch. Re-check this when the zod v4 migration (#1031)
 * lands — its unknown-key defaults are the tripwire that would erase the
 * guarantee without touching this file.
 */
export const updateFeedbackRequestSchema = z.union([
  updateFeedbackStatusRequestSchema,
  updateFeedbackArchiveRequestSchema,
]);
export type UpdateFeedbackRequest = z.infer<typeof updateFeedbackRequestSchema>;

export const updateFeedbackResponseSchema = z.union([
  updateFeedbackStatusResponseSchema,
  updateFeedbackArchiveResponseSchema,
]);
export type UpdateFeedbackResponse = z.infer<typeof updateFeedbackResponseSchema>;
