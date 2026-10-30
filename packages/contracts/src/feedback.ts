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
 * The complement of the terminal set: what still occupies an open slot. Both
 * halves are load-bearing at runtime — the per-submitter open cap is a
 * `notInArray` over the terminal half, and the `status` inbox ordering (#1341)
 * concatenates open-then-terminal to decide which lifecycle block a row lands
 * in. The partition test keeps the two lists exhaustive and disjoint, so a
 * seventh status cannot be added without being classified, and whichever half
 * it joins is where the ordering puts it.
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

/**
 * `PATCH /feedback/{id}` on a submission that has left `new` (owner directive
 * 2026-10-29). The edit window is the untriaged state only: once an admin has
 * moved the row, the text they triaged is the text of record. An admin moving
 * the row BACK to `new` reopens the window — that is accepted, not a bug.
 */
export const FEEDBACK_NOT_EDITABLE = 'FEEDBACK_NOT_EDITABLE';

/** Stable `ApiError.error.code` values emitted when a submitter edit is refused. */
export const FEEDBACK_EDIT_ERROR_CODES = [FEEDBACK_NOT_EDITABLE] as const;

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
  ...FEEDBACK_EDIT_ERROR_CODES,
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

/**
 * Available inbox orderings; category priority is the owner-defined default.
 *
 * `aging` (#1406 W3) orders by the aging clock — longest since anything last
 * happened to the submission, first. It is the ordering the helpdesk's "oldest
 * untouched" reading needs, and it is deliberately keyed on
 * `lastStatusChangeAt` rather than `createdAt`: a submission that was answered
 * yesterday is not aging just because it was filed a month ago. Appended, never
 * inserted — this enum is a wire value.
 *
 * `status` (#1341) groups the queue by lifecycle position: every
 * {@link FEEDBACK_OPEN_STATUSES} block first, then every
 * {@link FEEDBACK_TERMINAL_STATUSES} one, each half in its own declared order,
 * with the newest submission first inside a group. The rule is the open/settled
 * partition, NOT the position of a status in {@link FEEDBACK_STATUSES} — those
 * agree today only because the terminal pair happens to sit at that array's
 * tail, and an open seventh status would normally be appended there too. It is
 * the ordering that answers "what is still on me" without reading a colour off
 * every row, and it pairs with the `status` filter rather than replacing it:
 * the filter shows one state, this shows all of them in order.
 */
export const FEEDBACK_SORTS = ['category', 'newest', 'aging', 'status'] as const;
export const feedbackSortSchema = z.enum(FEEDBACK_SORTS);
export type FeedbackSort = z.infer<typeof feedbackSortSchema>;

/**
 * Free-text inbox search bound. Short on purpose: this is an operator's "find
 * the ticket about dividends" box, not a query language, and an unbounded
 * pattern is an unbounded `ILIKE` scan.
 */
export const FEEDBACK_SEARCH_MAX_LENGTH = 120;

/**
 * Support-thread authors are explicit because admins and submitters use
 * separate auth rails.
 *
 * Declared here rather than beside the thread schemas below because
 * {@link adminFeedbackSubmissionSchema} references it for `lastAuthorSide`, and
 * a `const` used above its own declaration is a temporal-dead-zone crash at
 * import time, not a type error.
 */
export const FEEDBACK_MESSAGE_AUTHOR_SIDES = ['submitter', 'admin'] as const;
export const feedbackMessageAuthorSideSchema = z.enum(FEEDBACK_MESSAGE_AUTHOR_SIDES);
export type FeedbackMessageAuthorSide = z.infer<typeof feedbackMessageAuthorSideSchema>;

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
    /**
     * When the submitter last edited the text while it was still `new` (owner
     * directive 2026-10-29); null when the submission was never edited. The
     * admin sees it so "the text changed after I read it" is answerable.
     */
    editedAt: z.string().datetime().nullable(),
    submitter: z
      .object({
        id: z.string().uuid(),
        username: z.string(),
        email: z.string().email(),
      })
      .strict(),
    /**
     * Thread state, so the inbox can rank without opening every row (#1341,
     * #1406 W3). All three are derived from `feedback_messages` and the shared
     * `adminLastReadAt` marker — no message BODY is projected into a list.
     *
     * `unreadCount` counts submitter-authored messages newer than that marker.
     * The marker is one shared admin-side stamp by schema, so "unread" is
     * per-INSTALL, not per-operator: with a second admin, A opening a thread
     * clears it for B too. That is a property of the storage model the W3 UI
     * inherits and cannot fix; it is a non-event on a single-owner install.
     */
    unreadCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    lastMessageAt: z.string().datetime().nullable(),
    /**
     * Who spoke last — the inbox's "waiting on me" tell. Null when nobody has
     * replied yet, which reads as "the submission itself is the last word".
     */
    lastAuthorSide: feedbackMessageAuthorSideSchema.nullable(),
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
    /**
     * Additive (owner directive 2026-10-29): the last submitter edit made while
     * the row was `new`, or null. Every key above is unchanged for the clients
     * that shipped against #1315/#1338.
     */
    editedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine(refineFeedbackStatusDetails);
export type MyFeedbackSubmission = z.infer<typeof myFeedbackSubmissionSchema>;

/**
 * `PATCH /feedback/{id}` — the submitter edits their own submission while it is
 * still `new`. Every key is optional but at least one must be present; the
 * bounds are exactly the capture bounds, and `subject: null` clears the subject.
 * Text is stored verbatim, as on capture. `context` is deliberately not
 * editable: it is the client's diagnostic snapshot at filing time.
 */
export const updateMyFeedbackRequestSchema = z
  .object({
    category: feedbackCategorySchema.optional(),
    subject: z.string().max(FEEDBACK_SUBJECT_MAX_LENGTH).nullable().optional(),
    message: z.string().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.category !== undefined || body.subject !== undefined || body.message !== undefined,
    { message: 'Provide at least one of category, subject or message.' },
  );
export type UpdateMyFeedbackRequest = z.infer<typeof updateMyFeedbackRequestSchema>;

export const myFeedbackResponseSchema = z
  .object({ submissions: z.array(myFeedbackSubmissionSchema) })
  .strict();
export type MyFeedbackResponse = z.infer<typeof myFeedbackResponseSchema>;

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

/**
 * The day the admin date filter speaks in. Submissions are filed from anywhere,
 * but the operator reads the queue in Vienna, so `from`/`to` name Europe/Vienna
 * calendar days — the zone every scheduled job and the tax year already use —
 * and the repository converts each boundary with Postgres's own tz database, so
 * a DST day is 23 or 25 hours long exactly as the wall clock says.
 */
export const FEEDBACK_ADMIN_DAY_TIME_ZONE = 'Europe/Vienna';

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real ISO `YYYY-MM-DD` calendar day. The round trip is the load-bearing
 * half: a regex alone admits `2026-02-30`, which JavaScript silently rolls over
 * to March and Postgres refuses at the `::date` cast — a 500, not a 400.
 */
const feedbackAdminDaySchema = z
  .string()
  .regex(ISO_DAY_PATTERN, 'Expected an ISO YYYY-MM-DD day.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Expected a real calendar day.');

/**
 * The filters shared by the inbox page and its counts (`GET /admin/feedback`
 * and `GET /admin/feedback/counts`): declared once, so the counts can never be
 * scoped by a predicate the list does not apply.
 */
const adminFeedbackFilterShape = {
  category: feedbackCategorySchema.optional(),
  // Query strings arrive as text: `z.coerce.boolean()` would treat the
  // literal "false" as true and silently show the wrong inbox.
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Lifecycle filter (#1406 W3). Absent means every status. */
  status: feedbackStatusSchema.optional(),
  /**
   * Exact `shippedVersion` match (#1406 W3) — "what did I close out in
   * 5.2.0". Exact rather than prefix: a version tag is an identifier the
   * operator typed on the way in, and a prefix match would fold 5.2.0 and
   * 5.2.10 together.
   */
  version: z.string().trim().min(1).max(FEEDBACK_SHIPPED_VERSION_MAX_LENGTH).optional(),
  /**
   * Free-text search over subject, message and the submitter's username and
   * email. Trimmed and bounded; the repository escapes `LIKE` metacharacters
   * so a literal `%` searches for a percent sign instead of matching the
   * whole queue.
   */
  q: z.string().trim().min(1).max(FEEDBACK_SEARCH_MAX_LENGTH).optional(),
  /**
   * Tri-state on purpose: absent is "don't filter on unread", which is not
   * the same request as `unread=false` ("only threads I have already read").
   * `.optional()` sits outside the transform so an omitted key stays
   * `undefined` instead of collapsing to `false`.
   */
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /**
   * Filing-date window on `createdAt` (owner directive 2026-10-29). Both ends
   * are INCLUSIVE Europe/Vienna calendar days ({@link
   * FEEDBACK_ADMIN_DAY_TIME_ZONE}): `from=2026-10-01&to=2026-10-31` is all of
   * October as the operator's wall clock saw it. Either end may be omitted.
   */
  from: feedbackAdminDaySchema.optional(),
  to: feedbackAdminDaySchema.optional(),
};

/** An inverted window is a client error, not an empty page. Equal ends are one day. */
function refineAdminFeedbackDayRange(
  query: { from?: string; to?: string },
  refinement: z.RefinementCtx,
): void {
  if (query.from === undefined || query.to === undefined) return;
  // Validated ISO days order correctly as plain strings.
  if (query.from <= query.to) return;
  refinement.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['to'],
    message: 'The end of the date range must not be before its start.',
  });
}

/** Filter, order and page controls for `GET /admin/feedback`. */
export const adminFeedbackListQuerySchema = z
  .object({
    ...adminFeedbackFilterShape,
    sort: feedbackSortSchema.default('category'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine(refineAdminFeedbackDayRange);
export type AdminFeedbackListQuery = z.infer<typeof adminFeedbackListQuerySchema>;

/**
 * `GET /admin/feedback/counts` — the inbox filters without sort/paging. Every
 * supplied filter scopes BOTH breakdowns, so `total`, the sum of `byStatus` and
 * the sum of `byCategory` all equal the list's `pagination.total` for the same
 * filters. A UI that wants per-status tab badges therefore omits `status` (and
 * likewise `category`) from the counts call; nothing is excluded implicitly
 * except what the list excludes too (archived rows, unless `archived=true`).
 */
export const adminFeedbackCountsQuerySchema = z
  .object(adminFeedbackFilterShape)
  .strict()
  .superRefine(refineAdminFeedbackDayRange);
export type AdminFeedbackCountsQuery = z.infer<typeof adminFeedbackCountsQuerySchema>;

const feedbackCountSchema = z.number().int().nonnegative();

/** A strict object carrying exactly one non-negative count per enum value. */
function zeroFilledCountsSchema<const T extends readonly [string, ...string[]]>(keys: T) {
  return z
    .object(
      Object.fromEntries(keys.map((key) => [key, feedbackCountSchema])) as {
        [K in T[number]]: typeof feedbackCountSchema;
      },
    )
    .strict();
}

export const adminFeedbackCountsResponseSchema = z
  .object({
    total: feedbackCountSchema,
    /** Zero-filled: every one of the six statuses is always present. */
    byStatus: zeroFilledCountsSchema(FEEDBACK_STATUSES),
    /** Zero-filled: every one of the five categories is always present. */
    byCategory: zeroFilledCountsSchema(FEEDBACK_CATEGORIES),
  })
  .strict();
export type AdminFeedbackCountsResponse = z.infer<typeof adminFeedbackCountsResponseSchema>;

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

/**
 * An optional staff reply that rides on a status change (owner directive
 * 2026-10-29): the same bounded text body `POST /admin/feedback/{id}/messages`
 * takes, written as a thread message in the SAME transaction as the status
 * write. It is attached to the TRANSITION, not to the request: a status body
 * that changes nothing (an HTTP retry) writes no reply either, so a retried
 * "decline + explain" can never post the explanation twice. A standalone reply
 * still goes through the messages route.
 */
const feedbackStatusReplySchema = z.string().trim().min(1).max(FEEDBACK_THREAD_MESSAGE_MAX_LENGTH);

/** The lifecycle fields shared by the single PATCH and the bulk status action. */
const feedbackStatusChangeShape = {
  status: feedbackStatusSchema,
  declinedReason: z.string().max(FEEDBACK_DECLINED_REASON_MAX_LENGTH).nullable().optional(),
  shippedVersion: z.string().max(FEEDBACK_SHIPPED_VERSION_MAX_LENGTH).nullable().optional(),
  reply: feedbackStatusReplySchema.optional(),
};

/** Admin status transition for one submission. */
export const updateFeedbackStatusRequestSchema = z
  .object(feedbackStatusChangeShape)
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
    /**
     * Present only when the request carried a `reply`, so a body without one is
     * answered byte-identically to before: the written thread message (admin
     * rail), or null when the status change was a no-op and so no reply was
     * written.
     */
    message: feedbackThreadMessageSchema.nullable().optional(),
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

/** Rows one `POST /admin/feedback/bulk` may address. */
export const FEEDBACK_BULK_MAX_IDS = 100;

/**
 * The addressed ids. Deliberately NOT `uuid()` per item: a malformed or
 * repeated id is reported as that row's `invalid` result instead of refusing
 * the other 99 — the whole point of a per-row result. Bounded so the array can
 * never be an unbounded input; each item is checked as a UUID before it can
 * reach SQL.
 */
const feedbackBulkIdsSchema = z.array(z.string().max(64)).min(1).max(FEEDBACK_BULK_MAX_IDS);

export const FEEDBACK_BULK_ACTIONS = ['status', 'archive', 'unarchive'] as const;
export const feedbackBulkActionSchema = z.enum(FEEDBACK_BULK_ACTIONS);
export type FeedbackBulkAction = z.infer<typeof feedbackBulkActionSchema>;

/**
 * `POST /admin/feedback/bulk` (owner directive 2026-10-29) — one action applied
 * to up to {@link FEEDBACK_BULK_MAX_IDS} submissions. The status action takes
 * exactly the single PATCH's fields (including the optional `reply`) and the
 * same declined/shipped pairing rule.
 */
export const adminFeedbackBulkRequestSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('status'),
        ids: feedbackBulkIdsSchema,
        ...feedbackStatusChangeShape,
      })
      .strict(),
    z.object({ action: z.literal('archive'), ids: feedbackBulkIdsSchema }).strict(),
    z.object({ action: z.literal('unarchive'), ids: feedbackBulkIdsSchema }).strict(),
  ])
  .superRefine((body, refinement) => {
    if (body.action === 'status') refineFeedbackStatusDetails(body, refinement);
  });
export type AdminFeedbackBulkRequest = z.infer<typeof adminFeedbackBulkRequestSchema>;

/**
 * One row's outcome:
 *   - `ok`        — the row changed (and its notification/audit fired once);
 *   - `unchanged` — the row already had the requested state (a retry); nothing
 *                   was written and nothing was emitted;
 *   - `not_found` — no submission has that id;
 *   - `invalid`   — the id is not a UUID, repeats an earlier id in the same
 *                   batch, or the row's own write was refused by a database
 *                   integrity constraint (that row rolled back alone).
 */
export const FEEDBACK_BULK_RESULTS = ['ok', 'unchanged', 'not_found', 'invalid'] as const;
export const feedbackBulkResultSchema = z.enum(FEEDBACK_BULK_RESULTS);
export type FeedbackBulkResult = z.infer<typeof feedbackBulkResultSchema>;

/**
 * Per-row results, one per input id in INPUT order. The batch is NOT one
 * transaction: each row commits on its own, so one bad row never rolls back the
 * rest — and a request that fails mid-batch (a 5xx) may have applied a prefix.
 * Retrying the same body is always safe: applied rows answer `unchanged` and
 * emit nothing a second time.
 */
export const adminFeedbackBulkResponseSchema = z
  .object({
    action: feedbackBulkActionSchema,
    results: z.array(
      z
        .object({
          id: z.string(),
          result: feedbackBulkResultSchema,
        })
        .strict(),
    ),
    summary: zeroFilledCountsSchema(FEEDBACK_BULK_RESULTS),
  })
  .strict();
export type AdminFeedbackBulkResponse = z.infer<typeof adminFeedbackBulkResponseSchema>;
