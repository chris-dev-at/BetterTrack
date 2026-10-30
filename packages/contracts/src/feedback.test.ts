import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_BULK_MAX_IDS,
  FEEDBACK_BULK_RESULTS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTEXT_MAX_BYTES,
  FEEDBACK_CONTEXT_MAX_KEYS,
  FEEDBACK_DECLINED_REASON_REQUIRED,
  FEEDBACK_ERROR_CODES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_NOT_EDITABLE,
  FEEDBACK_OPEN_STATUSES,
  FEEDBACK_SHIPPED_VERSION_REQUIRED,
  FEEDBACK_SORTS,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_DETAILS_INVALID,
  FEEDBACK_SUBJECT_MAX_LENGTH,
  FEEDBACK_TERMINAL_STATUSES,
  FEEDBACK_THREAD_MESSAGE_MAX_LENGTH,
  adminFeedbackBulkRequestSchema,
  adminFeedbackBulkResponseSchema,
  adminFeedbackCountsQuerySchema,
  adminFeedbackCountsResponseSchema,
  adminFeedbackListQuerySchema,
  adminFeedbackListResponseSchema,
  createFeedbackRequestSchema,
  feedbackStatusSchema,
  feedbackThreadMessageSchema,
  feedbackThreadResponseSchema,
  myFeedbackResponseSchema,
  myFeedbackSubmissionSchema,
  sendFeedbackMessageRequestSchema,
  updateFeedbackArchiveRequestSchema,
  updateFeedbackArchiveResponseSchema,
  updateFeedbackRequestSchema,
  updateFeedbackStatusRequestSchema,
  updateFeedbackStatusResponseSchema,
  updateMyFeedbackRequestSchema,
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

  it('offers the lifecycle ordering the inbox groups by, appended to the sort enum', () => {
    expect(adminFeedbackListQuerySchema.parse({ sort: 'status' }).sort).toBe('status');
    expect(adminFeedbackListQuerySchema.safeParse({ sort: 'lifecycle' }).success).toBe(false);

    // The sorts are wire values: the shipped three keep their positions and the
    // lifecycle ordering is appended, so a stored link never changes meaning.
    expect(FEEDBACK_SORTS).toEqual(['category', 'newest', 'aging', 'status']);
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
          // Owner directive 2026-10-29: required-nullable, never optional — an
          // admin row that forgot to project it must fail here, not read as
          // "never edited".
          editedAt: null,
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
            editedAt: null,
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

/**
 * Owner directive 2026-10-29 — the finished feedback API. Everything here is
 * ADDITIVE: the mobile client consumes these shapes, so the five categories,
 * the six statuses and every key it already reads are pinned alongside.
 */
describe('feedback contracts — 2026-10-29 additions', () => {
  const SUBMISSION_ID = '00000000-0000-7000-8000-000000000001';
  const mineItem = {
    id: SUBMISSION_ID,
    category: 'bug' as const,
    subject: null,
    message: 'The status read-back closes the loop.',
    status: 'new' as const,
    lastStatusChangeAt: '2026-08-18T09:00:00.000Z',
    declinedReason: null,
    shippedVersion: null,
    unreadReplyCount: 0,
    createdAt: '2026-08-18T08:00:00.000Z',
    editedAt: null,
  };

  it('keeps the wire enums the mobile client ships against byte-identical', () => {
    expect(FEEDBACK_CATEGORIES).toEqual(['feature', 'bug', 'other', 'help', 'improvement']);
    expect(FEEDBACK_STATUSES).toEqual([
      'new',
      'triaged',
      'working_on_it',
      'saved_as_future_idea',
      'declined',
      'shipped',
    ]);
  });

  it('appends editedAt to the /mine item without moving or dropping a pre-existing key', () => {
    // Key ORDER is pinned too: it is what a byte-level diff of an un-edited
    // row shows to a client that has read this shape since #1338.
    expect(Object.keys(myFeedbackSubmissionSchema.innerType().shape)).toEqual([
      'id',
      'category',
      'subject',
      'message',
      'status',
      'lastStatusChangeAt',
      'declinedReason',
      'shippedVersion',
      'unreadReplyCount',
      'createdAt',
      'editedAt',
    ]);
    expect(myFeedbackSubmissionSchema.safeParse(mineItem).success).toBe(true);
    expect(
      myFeedbackSubmissionSchema.safeParse({ ...mineItem, editedAt: '2026-10-29T10:00:00.000Z' })
        .success,
    ).toBe(true);
    // Required-nullable: a row that forgot to project it is a contract break.
    const { editedAt: _omitted, ...withoutEditedAt } = mineItem;
    expect(myFeedbackSubmissionSchema.safeParse(withoutEditedAt).success).toBe(false);
  });

  it('accepts a partial edit with at least one key, at exactly the capture bounds', () => {
    expect(updateMyFeedbackRequestSchema.parse({ message: 'Fixed typo.' })).toEqual({
      message: 'Fixed typo.',
    });
    expect(updateMyFeedbackRequestSchema.parse({ category: 'help' })).toEqual({ category: 'help' });
    // `null` clears the subject; text is stored verbatim, exactly as on capture.
    expect(updateMyFeedbackRequestSchema.parse({ subject: null })).toEqual({ subject: null });
    expect(updateMyFeedbackRequestSchema.parse({ subject: '  spaced  ' })).toEqual({
      subject: '  spaced  ',
    });
    expect(
      updateMyFeedbackRequestSchema.safeParse({
        subject: 's'.repeat(FEEDBACK_SUBJECT_MAX_LENGTH),
        message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH),
      }).success,
    ).toBe(true);

    for (const body of [
      {},
      { message: '' },
      { message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH + 1) },
      { subject: 's'.repeat(FEEDBACK_SUBJECT_MAX_LENGTH + 1) },
      { category: 'unknown' },
      // `context` is the filing-time diagnostic snapshot — never editable —
      // and lifecycle fields belong to the admin rail.
      { message: 'ok', context: { platform: 'web' } },
      { message: 'ok', status: 'shipped' },
    ]) {
      expect(updateMyFeedbackRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('declares the edit refusal as a contract-owned feedback error code', () => {
    expect(FEEDBACK_NOT_EDITABLE).toBe('FEEDBACK_NOT_EDITABLE');
    expect(FEEDBACK_ERROR_CODES).toContain(FEEDBACK_NOT_EDITABLE);
  });

  it('reads inclusive ISO day bounds on the list and the counts, refusing inverted or unreal days', () => {
    for (const schema of [adminFeedbackListQuerySchema, adminFeedbackCountsQuerySchema]) {
      expect(schema.parse({ from: '2026-10-01', to: '2026-10-31' })).toMatchObject({
        from: '2026-10-01',
        to: '2026-10-31',
      });
      // Equal ends are one day, and either end may be omitted.
      expect(schema.safeParse({ from: '2026-10-29', to: '2026-10-29' }).success).toBe(true);
      expect(schema.safeParse({ from: '2026-10-29' }).success).toBe(true);
      expect(schema.safeParse({ to: '2026-10-29' }).success).toBe(true);

      const inverted = schema.safeParse({ from: '2026-10-31', to: '2026-10-01' });
      expect(inverted.success).toBe(false);
      if (!inverted.success) expect(inverted.error.issues[0]?.path).toEqual(['to']);

      // A regex alone would admit 2026-02-30, which Postgres refuses at the
      // `::date` cast — a 500, not a 400.
      for (const day of ['2026-02-30', '2026-13-01', '2026-1-01', '2026-10-01T00:00:00Z', '']) {
        expect(schema.safeParse({ from: day }).success, day).toBe(false);
      }
    }
    // The counts take the filters only — paging and sorting are list concerns.
    expect(adminFeedbackCountsQuerySchema.safeParse({ page: '2' }).success).toBe(false);
    expect(adminFeedbackCountsQuerySchema.safeParse({ sort: 'newest' }).success).toBe(false);
    expect(adminFeedbackCountsQuerySchema.parse({})).toEqual({ archived: false });
  });

  it('zero-fills the counts with exactly the six statuses and five categories', () => {
    const zero = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, 0]));
    const counts = {
      total: 0,
      byStatus: zero(FEEDBACK_STATUSES),
      byCategory: zero(FEEDBACK_CATEGORIES),
    };
    expect(adminFeedbackCountsResponseSchema.safeParse(counts).success).toBe(true);

    const { new: _dropped, ...missingStatus } = counts.byStatus;
    expect(
      adminFeedbackCountsResponseSchema.safeParse({ ...counts, byStatus: missingStatus }).success,
    ).toBe(false);
    expect(
      adminFeedbackCountsResponseSchema.safeParse({
        ...counts,
        byCategory: { ...counts.byCategory, closed: 0 },
      }).success,
    ).toBe(false);
    expect(adminFeedbackCountsResponseSchema.safeParse({ ...counts, total: -1 }).success).toBe(
      false,
    );
  });

  it('carries an optional bounded reply on the status PATCH and a reply-only message echo', () => {
    expect(
      updateFeedbackStatusRequestSchema.parse({ status: 'triaged', reply: '  Looking at it.  ' }),
    ).toEqual({ status: 'triaged', reply: 'Looking at it.' });
    expect(
      updateFeedbackStatusRequestSchema.safeParse({ status: 'triaged', reply: '   ' }).success,
    ).toBe(false);
    expect(
      updateFeedbackStatusRequestSchema.safeParse({
        status: 'triaged',
        reply: 'x'.repeat(FEEDBACK_THREAD_MESSAGE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    // The declined/shipped pairing rule still applies with a reply aboard.
    expect(
      updateFeedbackStatusRequestSchema.safeParse({ status: 'declined', reply: 'Sorry.' }).success,
    ).toBe(false);
    // The generic admin PATCH union admits the reply on its status arm only.
    expect(updateFeedbackRequestSchema.safeParse({ status: 'triaged', reply: 'Hi.' }).success).toBe(
      true,
    );
    expect(updateFeedbackRequestSchema.safeParse({ archived: true, reply: 'Hi.' }).success).toBe(
      false,
    );

    const base = {
      id: SUBMISSION_ID,
      status: 'triaged' as const,
      lastStatusChangeAt: '2026-10-29T10:00:00.000Z',
      declinedReason: null,
      shippedVersion: null,
      updatedAt: '2026-10-29T10:00:00.000Z',
    };
    // A body without `reply` is answered exactly as before 2026-10-29 …
    expect(updateFeedbackStatusResponseSchema.safeParse(base).success).toBe(true);
    // … a retried one (no real change, so no reply written) answers null …
    expect(updateFeedbackStatusResponseSchema.safeParse({ ...base, message: null }).success).toBe(
      true,
    );
    // … and a real one echoes the admin-rail thread message.
    expect(
      updateFeedbackStatusResponseSchema.safeParse({
        ...base,
        message: {
          id: '00000000-0000-7000-8000-000000000002',
          feedbackId: SUBMISSION_ID,
          senderId: '00000000-0000-7000-8000-000000000003',
          authorSide: 'admin',
          body: 'Looking at it.',
          createdAt: '2026-10-29T10:00:00.000Z',
        },
      }).success,
    ).toBe(true);
  });

  it('bounds a bulk action to 100 ids, keeping malformed ids for the per-row result', () => {
    const ids = Array.from(
      { length: FEEDBACK_BULK_MAX_IDS },
      (_, index) => `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(FEEDBACK_BULK_MAX_IDS).toBe(100);
    expect(adminFeedbackBulkRequestSchema.safeParse({ action: 'archive', ids }).success).toBe(true);
    expect(
      adminFeedbackBulkRequestSchema.safeParse({
        action: 'archive',
        ids: [...ids, '00000000-0000-7000-8000-000000000999'],
      }).success,
    ).toBe(false);
    expect(adminFeedbackBulkRequestSchema.safeParse({ action: 'archive', ids: [] }).success).toBe(
      false,
    );
    // A malformed id is that ROW's `invalid` result, not a refused batch …
    expect(
      adminFeedbackBulkRequestSchema.safeParse({ action: 'unarchive', ids: ['not-a-uuid'] })
        .success,
    ).toBe(true);
    // … but an id is still bounded text, never an unbounded input.
    expect(
      adminFeedbackBulkRequestSchema.safeParse({ action: 'unarchive', ids: ['x'.repeat(65)] })
        .success,
    ).toBe(false);

    expect(
      adminFeedbackBulkRequestSchema.parse({
        action: 'status',
        ids: [SUBMISSION_ID],
        status: 'declined',
        declinedReason: 'Out of scope.',
        reply: ' Thanks for the idea. ',
      }),
    ).toEqual({
      action: 'status',
      ids: [SUBMISSION_ID],
      status: 'declined',
      declinedReason: 'Out of scope.',
      reply: 'Thanks for the idea.',
    });
    // The single PATCH's pairing rule applies to the bulk status action too.
    expect(
      adminFeedbackBulkRequestSchema.safeParse({
        action: 'status',
        ids: [SUBMISSION_ID],
        status: 'shipped',
      }).success,
    ).toBe(false);
    // Archive actions take ids only; unknown actions are refused.
    expect(
      adminFeedbackBulkRequestSchema.safeParse({
        action: 'archive',
        ids: [SUBMISSION_ID],
        status: 'triaged',
      }).success,
    ).toBe(false);
    expect(
      adminFeedbackBulkRequestSchema.safeParse({ action: 'remove', ids: [SUBMISSION_ID] }).success,
    ).toBe(false);
  });

  it('answers a bulk action with one result per id and a zero-filled summary', () => {
    expect(FEEDBACK_BULK_RESULTS).toEqual(['ok', 'unchanged', 'not_found', 'invalid']);
    const response = {
      action: 'status',
      results: [
        { id: SUBMISSION_ID, result: 'ok' },
        { id: 'not-a-uuid', result: 'invalid' },
      ],
      summary: { ok: 1, unchanged: 0, not_found: 0, invalid: 1 },
    };
    expect(adminFeedbackBulkResponseSchema.safeParse(response).success).toBe(true);
    expect(
      adminFeedbackBulkResponseSchema.safeParse({ ...response, summary: { ok: 1, invalid: 1 } })
        .success,
    ).toBe(false);
    expect(
      adminFeedbackBulkResponseSchema.safeParse({
        ...response,
        results: [{ id: SUBMISSION_ID, result: 'skipped' }],
      }).success,
    ).toBe(false);
  });
});
