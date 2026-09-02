import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTEXT_MAX_BYTES,
  FEEDBACK_CONTEXT_MAX_KEYS,
  FEEDBACK_DECLINED_REASON_REQUIRED,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_OPEN_STATUSES,
  FEEDBACK_SHIPPED_VERSION_REQUIRED,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_DETAILS_INVALID,
  FEEDBACK_SUBJECT_MAX_LENGTH,
  FEEDBACK_TERMINAL_STATUSES,
  FEEDBACK_THREAD_MESSAGE_MAX_LENGTH,
  adminFeedbackListQuerySchema,
  adminFeedbackListResponseSchema,
  createFeedbackRequestSchema,
  feedbackStatusSchema,
  feedbackThreadMessageSchema,
  feedbackThreadResponseSchema,
  myFeedbackResponseSchema,
  sendFeedbackMessageRequestSchema,
  updateFeedbackArchiveRequestSchema,
  updateFeedbackArchiveResponseSchema,
  updateFeedbackRequestSchema,
  updateFeedbackStatusRequestSchema,
  type FeedbackStatus,
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
    expect(FEEDBACK_CATEGORIES).toEqual(['feature', 'bug', 'other', 'help', 'improvement']);
    for (const category of ['help', 'improvement'] as const) {
      expect(
        createFeedbackRequestSchema.safeParse({ category, message: 'Helpdesk request' }).success,
      ).toBe(true);
    }
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
      archived: false,
      sort: 'category',
      page: 1,
      limit: 20,
    });
    expect(
      adminFeedbackListQuerySchema.parse({
        category: 'bug',
        archived: 'true',
        sort: 'newest',
        page: '2',
      }),
    ).toMatchObject({ category: 'bug', archived: true, sort: 'newest', page: 2 });
    expect(adminFeedbackListQuerySchema.parse({ archived: 'false' }).archived).toBe(false);
  });

  it('reads the W3 inbox filters, keeping unread tri-state', () => {
    const parsed = adminFeedbackListQuerySchema.parse({
      status: 'shipped',
      version: '5.2.0',
      q: '  dividends  ',
      unread: 'true',
    });
    expect(parsed).toMatchObject({ status: 'shipped', version: '5.2.0', q: 'dividends' });
    expect(parsed.unread).toBe(true);

    // Absent is "do not filter on unread"; an explicit false is the narrower
    // "only what I have already read". Collapsing the two would make the
    // default inbox silently hide every unread thread.
    expect(adminFeedbackListQuerySchema.parse({}).unread).toBeUndefined();
    expect(adminFeedbackListQuerySchema.parse({ unread: 'false' }).unread).toBe(false);

    // Filters are validated, never forwarded blindly to SQL.
    expect(adminFeedbackListQuerySchema.safeParse({ status: 'not_a_status' }).success).toBe(false);
    expect(adminFeedbackListQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(adminFeedbackListQuerySchema.safeParse({ tag: 'dividends' }).success).toBe(false);
    expect(adminFeedbackListQuerySchema.safeParse({ sort: 'aging' }).success).toBe(true);
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
          deletedByUser: false,
          archivedAt: null,
          submitter: {
            id: '00000000-0000-7000-8000-000000000002',
            username: 'mobile-user',
            email: 'mobile@example.test',
          },
          // Thread state (#1406 W3). Required, not optional: the inbox ranks on
          // these, and an optional counter would let a row that simply forgot
          // to project them read as "nothing is waiting".
          unreadCount: 0,
          messageCount: 0,
          lastMessageAt: null,
          lastAuthorSide: null,
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

  it('partitions every lifecycle status into exactly one of terminal and open', () => {
    // The open-submission cap counts "not terminal" rows. Both halves are
    // declared, so a seventh status added by a later phase fails here instead of
    // silently occupying (or silently escaping) an open slot in the repository.
    expect([...FEEDBACK_TERMINAL_STATUSES, ...FEEDBACK_OPEN_STATUSES].sort()).toEqual(
      [...FEEDBACK_STATUSES].sort(),
    );
    expect(
      FEEDBACK_TERMINAL_STATUSES.filter((status) =>
        (FEEDBACK_OPEN_STATUSES as readonly FeedbackStatus[]).includes(status),
      ),
    ).toEqual([]);
    for (const status of [...FEEDBACK_TERMINAL_STATUSES, ...FEEDBACK_OPEN_STATUSES]) {
      expect(feedbackStatusSchema.safeParse(status).success, status).toBe(true);
    }
  });

  it('separates archive state from lifecycle transitions on the generic admin PATCH', () => {
    expect(updateFeedbackArchiveRequestSchema.parse({ archived: true })).toEqual({
      archived: true,
    });
    expect(updateFeedbackRequestSchema.safeParse({ archived: false }).success).toBe(true);
    expect(updateFeedbackRequestSchema.safeParse({ status: 'triaged' }).success).toBe(true);
    expect(
      updateFeedbackRequestSchema.safeParse({ status: 'triaged', archived: true }).success,
    ).toBe(false);
    expect(
      updateFeedbackArchiveResponseSchema.safeParse({
        id: '00000000-0000-7000-8000-000000000001',
        archivedAt: '2026-08-20T12:00:00.000Z',
        updatedAt: '2026-08-20T12:00:00.000Z',
      }).success,
    ).toBe(true);
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

  it('reports the specific required-detail codes when outcome details are null', () => {
    const declined = updateFeedbackStatusRequestSchema.safeParse({
      status: 'declined',
      declinedReason: null,
    });
    expect(declined.success).toBe(false);
    if (!declined.success) {
      expect(declined.error.issues[0]).toMatchObject({
        path: ['declinedReason'],
        params: { apiErrorCode: FEEDBACK_DECLINED_REASON_REQUIRED },
      });
    }

    const shipped = updateFeedbackStatusRequestSchema.safeParse({
      status: 'shipped',
      shippedVersion: null,
    });
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

  it('keeps support-thread messages parallel to chat while making the author side explicit', () => {
    expect(sendFeedbackMessageRequestSchema.parse({ body: '  A concise reply.  ' })).toEqual({
      body: 'A concise reply.',
    });
    expect(sendFeedbackMessageRequestSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(
      sendFeedbackMessageRequestSchema.safeParse({
        body: 'x'.repeat(FEEDBACK_THREAD_MESSAGE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);

    expect(
      feedbackThreadResponseSchema.safeParse({
        thread: {
          id: '00000000-0000-7000-8000-000000000001',
          unreadCount: 1,
        },
        messages: [
          {
            id: '00000000-0000-7000-8000-000000000002',
            feedbackId: '00000000-0000-7000-8000-000000000001',
            senderId: '00000000-0000-7000-8000-000000000003',
            authorSide: 'admin',
            body: 'We are looking into this.',
            createdAt: '2026-08-20T08:00:00.000Z',
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it('accepts an anonymized author but never a malformed one', () => {
    const message = {
      id: '00000000-0000-7000-8000-000000000002',
      feedbackId: '00000000-0000-7000-8000-000000000001',
      authorSide: 'admin' as const,
      body: 'The account that wrote this is gone; the answer is not.',
      createdAt: '2026-08-20T08:00:00.000Z',
    };

    // A deleted author anonymizes their messages (#362) rather than recalling
    // them, so the wire must carry the null the SET NULL column produces.
    expect(feedbackThreadMessageSchema.safeParse({ ...message, senderId: null }).success).toBe(
      true,
    );
    expect(feedbackThreadMessageSchema.safeParse({ ...message, senderId: '' }).success).toBe(false);
    expect(feedbackThreadMessageSchema.safeParse(message).success).toBe(false);
  });
});
