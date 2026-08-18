import { z } from 'zod';

/** Feedback categories in the owner's category-first triage order. */
export const FEEDBACK_CATEGORIES = ['feature', 'bug', 'other'] as const;
export const feedbackCategorySchema = z.enum(FEEDBACK_CATEGORIES);
export type FeedbackCategory = z.infer<typeof feedbackCategorySchema>;

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

/** Feedback lifecycle states in the owner triage queue. Mirrors the DB enum. */
export const FEEDBACK_STATUSES = ['new', 'triaged', 'done'] as const;
export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

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
  .strict();
export type AdminFeedbackSubmission = z.infer<typeof adminFeedbackSubmissionSchema>;

/** Filter, order and page controls for `GET /admin/feedback`. */
export const adminFeedbackListQuerySchema = z
  .object({
    category: feedbackCategorySchema.optional(),
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
  .object({ status: feedbackStatusSchema })
  .strict();
export type UpdateFeedbackStatusRequest = z.infer<typeof updateFeedbackStatusRequestSchema>;

export const updateFeedbackStatusResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: feedbackStatusSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type UpdateFeedbackStatusResponse = z.infer<typeof updateFeedbackStatusResponseSchema>;
