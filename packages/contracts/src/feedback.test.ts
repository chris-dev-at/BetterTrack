import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_CONTEXT_MAX_BYTES,
  FEEDBACK_CONTEXT_MAX_KEYS,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_SUBJECT_MAX_LENGTH,
  adminFeedbackListQuerySchema,
  adminFeedbackListResponseSchema,
  createFeedbackRequestSchema,
  updateFeedbackStatusRequestSchema,
} from './feedback';

describe('feedback contracts', () => {
  it('accepts the locked categories, a 5000-character message, and extensible diagnostics', () => {
    const result = createFeedbackRequestSchema.safeParse({
      category: 'feature',
      message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH),
      subject: 's'.repeat(FEEDBACK_SUBJECT_MAX_LENGTH),
      context: {
        platform: 'android',
        appVersion: '5.0.0',
        screen: '/portfolio',
        futureDiagnostic: { nested: true },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty/over-length message, unknown category, and over-length subject', () => {
    expect(createFeedbackRequestSchema.safeParse({ category: 'bug', message: '' }).success).toBe(
      false,
    );
    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'bug',
        message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      createFeedbackRequestSchema.safeParse({ category: 'question', message: 'Hello' }).success,
    ).toBe(false);
    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'other',
        message: 'Hello',
        subject: 'x'.repeat(FEEDBACK_SUBJECT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts an empty optional subject and preserves supplied text verbatim', () => {
    for (const subject of ['', '   ', '  Better import preview  ']) {
      const parsed = createFeedbackRequestSchema.parse({
        category: 'feature',
        message: 'A useful request',
        subject,
      });

      expect(parsed.subject).toBe(subject);
    }
  });

  it('bounds diagnostics by key count and serialized UTF-8 size without locking their names', () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: FEEDBACK_CONTEXT_MAX_KEYS + 1 }, (_, index) => [`key${index}`, index]),
    );
    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'other',
        message: 'Context keys',
        context: tooManyKeys,
      }).success,
    ).toBe(false);

    expect(
      createFeedbackRequestSchema.safeParse({
        category: 'other',
        message: 'Context bytes',
        context: { diagnostic: 'x'.repeat(FEEDBACK_CONTEXT_MAX_BYTES) },
      }).success,
    ).toBe(false);
  });

  it('defaults the admin inbox to category priority and the first page', () => {
    expect(adminFeedbackListQuerySchema.parse({})).toEqual({
      sort: 'category',
      page: 1,
      limit: 20,
    });
    expect(
      adminFeedbackListQuerySchema.parse({ category: 'bug', sort: 'newest', page: '2' }),
    ).toMatchObject({ category: 'bug', sort: 'newest', page: 2 });
  });

  it('validates admin rows and locks status transitions to the shipped lifecycle', () => {
    const response = adminFeedbackListResponseSchema.safeParse({
      submissions: [
        {
          id: '00000000-0000-7000-8000-000000000001',
          category: 'feature',
          subject: null,
          message: 'Add a compact scenario switcher.',
          context: { platform: 'android' },
          status: 'new',
          submitter: {
            id: '00000000-0000-7000-8000-000000000002',
            username: 'mobile-user',
            email: 'mobile@example.test',
          },
          createdAt: '2026-08-18T08:00:00.000Z',
          updatedAt: '2026-08-18T08:00:00.000Z',
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    expect(response.success).toBe(true);
    expect(updateFeedbackStatusRequestSchema.safeParse({ status: 'done' }).success).toBe(true);
    expect(updateFeedbackStatusRequestSchema.safeParse({ status: 'closed' }).success).toBe(false);
  });
});
