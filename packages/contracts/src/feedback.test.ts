import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_CONTEXT_MAX_BYTES,
  FEEDBACK_CONTEXT_MAX_KEYS,
  FEEDBACK_DECLINED_REASON_REQUIRED,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_SHIPPED_VERSION_REQUIRED,
  FEEDBACK_STATUS_DETAILS_INVALID,
  FEEDBACK_SUBJECT_MAX_LENGTH,
  adminFeedbackListQuerySchema,
  adminFeedbackListResponseSchema,
  createFeedbackRequestSchema,
  myFeedbackResponseSchema,
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
          lastStatusChangeAt: '2026-08-18T08:00:00.000Z',
          declinedReason: null,
          shippedVersion: null,
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
    expect(updateFeedbackStatusRequestSchema.safeParse({ status: 'working_on_it' }).success).toBe(
      true,
    );
    expect(
      updateFeedbackStatusRequestSchema.safeParse({
        status: 'declined',
        declinedReason: 'This would make the compact workflow harder to use.',
      }).success,
    ).toBe(true);
    expect(
      updateFeedbackStatusRequestSchema.safeParse({
        status: 'shipped',
        shippedVersion: '5.4.0',
      }).success,
    ).toBe(true);
    expect(updateFeedbackStatusRequestSchema.safeParse({ status: 'closed' }).success).toBe(false);
  });

  it('requires the owner explanation/version in the shared transition contract', () => {
    const declined = updateFeedbackStatusRequestSchema.safeParse({ status: 'declined' });
    expect(declined.success).toBe(false);
    if (!declined.success) {
      expect(declined.error.issues[0]).toMatchObject({
        path: ['declinedReason'],
        params: { apiErrorCode: FEEDBACK_DECLINED_REASON_REQUIRED },
      });
    }

    const shipped = updateFeedbackStatusRequestSchema.safeParse({ status: 'shipped' });
    expect(shipped.success).toBe(false);
    if (!shipped.success) {
      expect(shipped.error.issues[0]).toMatchObject({
        path: ['shippedVersion'],
        params: { apiErrorCode: FEEDBACK_SHIPPED_VERSION_REQUIRED },
      });
    }
  });

  it('rejects outcome details attached to a different status', () => {
    const declinedReason = updateFeedbackStatusRequestSchema.safeParse({
      status: 'triaged',
      declinedReason: 'This detail cannot belong to a triaged submission.',
    });
    expect(declinedReason.success).toBe(false);
    if (!declinedReason.success) {
      expect(declinedReason.error.issues[0]).toMatchObject({
        path: ['declinedReason'],
        params: { apiErrorCode: FEEDBACK_STATUS_DETAILS_INVALID },
      });
    }

    const shippedVersion = updateFeedbackStatusRequestSchema.safeParse({
      status: 'working_on_it',
      shippedVersion: '5.4.0',
    });
    expect(shippedVersion.success).toBe(false);
    if (!shippedVersion.success) {
      expect(shippedVersion.error.issues[0]).toMatchObject({
        path: ['shippedVersion'],
        params: { apiErrorCode: FEEDBACK_STATUS_DETAILS_INVALID },
      });
    }
  });

  it('reserves unread reply counts in caller-owned status rows', () => {
    expect(
      myFeedbackResponseSchema.safeParse({
        submissions: [
          {
            id: '00000000-0000-7000-8000-000000000001',
            category: 'bug',
            subject: null,
            message: 'The status read-back closes the loop.',
            status: 'shipped',
            lastStatusChangeAt: '2026-08-18T09:00:00.000Z',
            declinedReason: null,
            shippedVersion: '5.4.0',
            unreadReplyCount: 0,
            createdAt: '2026-08-18T08:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);
  });
});
