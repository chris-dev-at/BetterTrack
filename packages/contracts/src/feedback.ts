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
