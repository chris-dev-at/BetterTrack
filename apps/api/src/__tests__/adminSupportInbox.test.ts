import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import {
  adminFeedbackListResponseSchema,
  adminFeedbackSubmissionSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
type Agent = ReturnType<typeof request.agent>;

/**
 * `GET /admin/feedback` filter, ordering and thread-state extensions (#1406 W3).
 *
 * The helpdesk inbox has to answer "what is waiting on me" without opening every
 * row, which is a read problem: the status/version/search/unread filters narrow
 * the queue, and the per-row thread counters rank what survives. Every assertion
 * here was proven red against the pre-W3 route before being trusted.
 */
describe('admin support inbox — W3 filters and thread state', () => {
  let harness: TestHarness;
  let admin: SeededUser;
  let adminAgent: Agent;
  let alice: SeededUser;
  let bob: SeededUser;

  beforeAll(async () => {
    harness = await createTestApp();
    admin = await harness.seedAdmin();
    adminAgent = await harness.loginAdmin(admin);
    alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice_k' });
    bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob_m' });
  }, 60_000);

  beforeEach(async () => {
    await harness.db.delete(schema.feedbackMessages);
    await harness.db.delete(schema.feedback);
    await harness.db.delete(schema.notifications);
  });

  function at(iso: string): Date {
    return new Date(iso);
  }

  /**
   * Five submissions spanning every axis the new filters cut on. Timestamps are
   * explicit so ordering assertions are about the ORDER BY, not about how fast
   * the fixture inserted.
   */
  async function seedInbox() {
    return harness.db
      .insert(schema.feedback)
      .values([
        {
          userId: alice.id,
          category: 'bug',
          subject: 'Dividend total is off by one payout',
          message: 'The August payout is missing from the yearly total.',
          status: 'triaged',
          lastStatusChangeAt: at('2026-08-20T08:00:00.000Z'),
          createdAt: at('2026-08-20T08:00:00.000Z'),
          updatedAt: at('2026-08-20T08:00:00.000Z'),
        },
        {
          userId: bob.id,
          category: 'help',
          subject: 'Can I merge two custom assets?',
          message: 'Looking for a merge button.',
          status: 'new',
          lastStatusChangeAt: at('2026-08-25T08:00:00.000Z'),
          createdAt: at('2026-08-25T08:00:00.000Z'),
          updatedAt: at('2026-08-25T08:00:00.000Z'),
        },
        {
          userId: alice.id,
          category: 'feature',
          subject: 'Watchlist sort order',
          message: 'Please remember my sort.',
          status: 'shipped',
          shippedVersion: '5.2.0',
          lastStatusChangeAt: at('2026-08-10T08:00:00.000Z'),
          createdAt: at('2026-08-01T08:00:00.000Z'),
          updatedAt: at('2026-08-10T08:00:00.000Z'),
        },
        {
          userId: bob.id,
          category: 'improvement',
          subject: 'Forecast should honour paused orders',
          message: 'Paused standing orders still count.',
          status: 'shipped',
          shippedVersion: '5.2.10',
          lastStatusChangeAt: at('2026-08-12T08:00:00.000Z'),
          createdAt: at('2026-08-02T08:00:00.000Z'),
          updatedAt: at('2026-08-12T08:00:00.000Z'),
        },
        {
          userId: alice.id,
          category: 'other',
          // A literal percent sign, to pin the LIKE-metacharacter escape.
          subject: 'Allocation shows 100% twice',
          message: 'The donut label repeats.',
          status: 'declined',
          declinedReason: 'Working as designed.',
          lastStatusChangeAt: at('2026-08-05T08:00:00.000Z'),
          createdAt: at('2026-08-03T08:00:00.000Z'),
          updatedAt: at('2026-08-05T08:00:00.000Z'),
        },
      ])
      .returning();
  }

  async function list(query: Record<string, string | number>) {
    const response = await adminAgent.get('/api/v1/admin/feedback').query(query);
    expect(response.status).toBe(200);
    return adminFeedbackListResponseSchema.parse(response.body);
  }

  it('filters by lifecycle status and scopes the total to the filter', async () => {
    await seedInbox();

    const shipped = await list({ status: 'shipped' });
    expect(shipped.submissions.map((row) => row.subject).sort()).toEqual([
      'Forecast should honour paused orders',
      'Watchlist sort order',
    ]);
    expect(shipped.pagination.total).toBe(2);

    const declined = await list({ status: 'declined' });
    expect(declined.submissions).toHaveLength(1);
    expect(declined.submissions[0]?.declinedReason).toBe('Working as designed.');
  });

  it('rejects an unknown status instead of silently ignoring the filter', async () => {
    const response = await adminAgent
      .get('/api/v1/admin/feedback')
      .query({ status: 'not_a_status' });
    expect(response.status).toBe(400);
  });

  it('matches a shipped version exactly, so 5.2.0 never folds in 5.2.10', async () => {
    await seedInbox();

    const exact = await list({ version: '5.2.0' });
    expect(exact.submissions.map((row) => row.shippedVersion)).toEqual(['5.2.0']);
    expect(exact.pagination.total).toBe(1);

    const longer = await list({ version: '5.2.10' });
    expect(longer.submissions.map((row) => row.shippedVersion)).toEqual(['5.2.10']);
  });

  it('searches subject, message and submitter identity', async () => {
    await seedInbox();

    const bySubject = await list({ q: 'dividend' });
    expect(bySubject.submissions.map((row) => row.subject)).toEqual([
      'Dividend total is off by one payout',
    ]);

    const byMessage = await list({ q: 'donut' });
    expect(byMessage.submissions.map((row) => row.subject)).toEqual([
      'Allocation shows 100% twice',
    ]);

    const byUsername = await list({ q: 'bob_m' });
    expect(byUsername.submissions.map((row) => row.submitter.username)).toEqual(['bob_m', 'bob_m']);
    expect(byUsername.pagination.total).toBe(2);

    const byEmail = await list({ q: 'alice@bt.test' });
    expect(byEmail.pagination.total).toBe(3);
  });

  it('escapes LIKE metacharacters so a literal % is not a wildcard', async () => {
    await seedInbox();
    // DECOYS. Without these the `%` assertion is vacuous: "Allocation shows
    // 100% twice" is the only row containing "100" at all, so the unescaped
    // pattern `%100%%` — which means "contains 100" — returns exactly the same
    // single row as the escaped one, and the test passes against broken code.
    // The first decoy contains "100" WITHOUT a following percent sign, so only
    // a correctly escaped pattern can tell the two apart.
    await harness.db.insert(schema.feedback).values([
      {
        userId: bob.id,
        category: 'other',
        subject: 'Chart tops out at 1000 rows',
        message: 'The table stops rendering past a thousand entries.',
        status: 'new',
        lastStatusChangeAt: at('2026-08-22T08:00:00.000Z'),
        createdAt: at('2026-08-22T08:00:00.000Z'),
        updatedAt: at('2026-08-22T08:00:00.000Z'),
      },
      {
        userId: bob.id,
        category: 'bug',
        subject: 'Import from C:\\broker\\export fails',
        message: 'The Windows path is rejected by the importer.',
        status: 'new',
        lastStatusChangeAt: at('2026-08-23T08:00:00.000Z'),
        createdAt: at('2026-08-23T08:00:00.000Z'),
        updatedAt: at('2026-08-23T08:00:00.000Z'),
      },
    ]);

    // Unescaped, `%100%%` means "contains 100" and would drag in the decoy.
    const percent = await list({ q: '100%' });
    expect(percent.submissions.map((row) => row.subject)).toEqual(['Allocation shows 100% twice']);
    expect(percent.pagination.total).toBe(1);

    // Control: the decoy IS reachable, so the assertion above is about the
    // escape and not about a fixture that failed to insert.
    const hundred = await list({ q: '100' });
    expect(hundred.submissions.map((row) => row.subject).sort()).toEqual([
      'Allocation shows 100% twice',
      'Chart tops out at 1000 rows',
    ]);

    // `_` is the single-character wildcard; there is no row with that literal.
    const underscore = await list({ q: 'sort_order' });
    expect(underscore.submissions).toEqual([]);
    expect(underscore.pagination.total).toBe(0);

    // A literal backslash. This is the ordering the escape function must get
    // right: escaping `%` and `_` BEFORE `\` would double-escape the backslash
    // it just introduced and the pattern would stop matching.
    const backslash = await list({ q: 'C:\\broker' });
    expect(backslash.submissions.map((row) => row.subject)).toEqual([
      'Import from C:\\broker\\export fails',
    ]);
    expect(backslash.pagination.total).toBe(1);
  });

  it('treats unread as tri-state: absent, only-unread, only-read', async () => {
    const rows = await seedInbox();
    const unreadTarget = rows[0]!;
    const readTarget = rows[1]!;

    await harness.db.insert(schema.feedbackMessages).values([
      {
        feedbackId: unreadTarget.id,
        authorSide: 'submitter',
        authorUserId: alice.id,
        body: 'Any update on this?',
        createdAt: at('2026-08-26T08:00:00.000Z'),
      },
      {
        feedbackId: readTarget.id,
        authorSide: 'submitter',
        authorUserId: bob.id,
        body: 'Bumping this.',
        createdAt: at('2026-08-26T08:00:00.000Z'),
      },
    ]);
    // Only the second thread has been opened by the admin side.
    await harness.db
      .update(schema.feedback)
      .set({ adminLastReadAt: at('2026-08-27T08:00:00.000Z') })
      .where(eq(schema.feedback.id, readTarget.id));

    const all = await list({});
    expect(all.pagination.total).toBe(5);

    const unread = await list({ unread: 'true' });
    expect(unread.submissions.map((row) => row.id)).toEqual([unreadTarget.id]);
    expect(unread.pagination.total).toBe(1);

    const read = await list({ unread: 'false' });
    expect(read.submissions.map((row) => row.id)).toContain(readTarget.id);
    expect(read.submissions.map((row) => row.id)).not.toContain(unreadTarget.id);
    expect(read.pagination.total).toBe(4);
  });

  it('projects thread state per row without projecting a message body', async () => {
    const rows = await seedInbox();
    const target = rows[0]!;

    await harness.db.insert(schema.feedbackMessages).values([
      {
        feedbackId: target.id,
        authorSide: 'submitter',
        authorUserId: alice.id,
        body: 'First from the submitter',
        createdAt: at('2026-08-21T08:00:00.000Z'),
      },
      {
        feedbackId: target.id,
        authorSide: 'admin',
        authorUserId: admin.id,
        body: 'Staff answer',
        createdAt: at('2026-08-22T08:00:00.000Z'),
      },
      {
        feedbackId: target.id,
        authorSide: 'submitter',
        authorUserId: alice.id,
        body: 'Submitter had the last word',
        createdAt: at('2026-08-23T08:00:00.000Z'),
      },
    ]);
    await harness.db
      .update(schema.feedback)
      .set({ adminLastReadAt: at('2026-08-22T12:00:00.000Z') })
      .where(eq(schema.feedback.id, target.id));

    const page = await list({});
    const row = page.submissions.find((entry) => entry.id === target.id)!;

    expect(row.messageCount).toBe(3);
    // One submitter message is newer than the admin read marker.
    expect(row.unreadCount).toBe(1);
    expect(row.lastAuthorSide).toBe('submitter');
    expect(row.lastMessageAt).toBe('2026-08-23T08:00:00.000Z');

    // A thread-less submission reads as "the submission is the last word".
    const quiet = page.submissions.find((entry) => entry.id === rows[2]!.id)!;
    expect(quiet.messageCount).toBe(0);
    expect(quiet.unreadCount).toBe(0);
    expect(quiet.lastAuthorSide).toBeNull();
    expect(quiet.lastMessageAt).toBeNull();

    // The list is a projection, not a thread: no reply body may appear in it.
    expect(JSON.stringify(page)).not.toContain('Staff answer');
    expect(JSON.stringify(page)).not.toContain('Submitter had the last word');
  });

  it('orders by the aging clock, longest untouched first', async () => {
    await seedInbox();

    const aging = await list({ sort: 'aging' });
    expect(aging.submissions.map((row) => row.subject)).toEqual([
      'Allocation shows 100% twice',
      'Watchlist sort order',
      'Forecast should honour paused orders',
      'Dividend total is off by one payout',
      'Can I merge two custom assets?',
    ]);

    // Aging is the LAST lifecycle move, not the filing date: the two oldest
    // rows by `createdAt` are not the two oldest by aging.
    const newest = await list({ sort: 'newest' });
    expect(newest.submissions[0]?.subject).toBe('Can I merge two custom assets?');
    expect(newest.submissions.at(-1)?.subject).toBe('Watchlist sort order');
  });

  it('composes filters and keeps the total consistent with the page', async () => {
    await seedInbox();

    const composed = await list({ status: 'shipped', q: 'alice@bt.test' });
    expect(composed.submissions.map((row) => row.subject)).toEqual(['Watchlist sort order']);
    expect(composed.pagination.total).toBe(1);
    expect(composed.pagination.totalPages).toBe(1);

    // A filter that matches nothing must report zero, not the unfiltered total.
    const none = await list({ status: 'working_on_it' });
    expect(none.submissions).toEqual([]);
    expect(none.pagination.total).toBe(0);
  });

  it('keeps the new filters inside the archived partition', async () => {
    const rows = await seedInbox();
    const target = rows[0]!;

    await adminAgent
      .patch(`/api/v1/admin/feedback/${target.id}`)
      .set(...XRW)
      .send({ archived: true });

    const activeBug = await list({ status: 'triaged' });
    expect(activeBug.submissions).toEqual([]);

    const archivedBug = await list({ status: 'triaged', archived: 'true' });
    expect(archivedBug.submissions.map((row) => row.id)).toEqual([target.id]);
  });

  describe('GET /admin/feedback/:id — the shareable-thread read', () => {
    it('resolves a submission the current filters would hide', async () => {
      const rows = await seedInbox();
      const target = rows[0]!;

      await adminAgent
        .patch(`/api/v1/admin/feedback/${target.id}`)
        .set(...XRW)
        .send({ archived: true });

      // The default inbox hides archived rows entirely…
      const inbox = await list({});
      expect(inbox.submissions.map((row) => row.id)).not.toContain(target.id);

      // …but the link still opens, which is the whole point of the route.
      const response = await adminAgent.get(`/api/v1/admin/feedback/${target.id}`);
      expect(response.status).toBe(200);
      const submission = adminFeedbackSubmissionSchema.parse(response.body);
      expect(submission.id).toBe(target.id);
      expect(submission.archivedAt).not.toBeNull();
      expect(submission.submitter.username).toBe('alice_k');
    });

    it('carries the same thread state the list projects', async () => {
      const rows = await seedInbox();
      const target = rows[0]!;
      await harness.db.insert(schema.feedbackMessages).values({
        feedbackId: target.id,
        authorSide: 'submitter',
        authorUserId: alice.id,
        body: 'Still broken.',
        createdAt: at('2026-08-26T08:00:00.000Z'),
      });

      const fromList = (await list({})).submissions.find((row) => row.id === target.id)!;
      const fromGet = adminFeedbackSubmissionSchema.parse(
        (await adminAgent.get(`/api/v1/admin/feedback/${target.id}`)).body,
      );
      expect(fromGet).toEqual(fromList);
      expect(fromGet.unreadCount).toBe(1);
      expect(fromGet.lastAuthorSide).toBe('submitter');
    });

    it('answers a missing submission with 404, not an empty body', async () => {
      const response = await adminAgent.get(
        '/api/v1/admin/feedback/00000000-0000-4000-8000-000000000000',
      );
      expect(response.status).toBe(404);
    });

    it('rejects a non-uuid id before it reaches the repository', async () => {
      const response = await adminAgent.get('/api/v1/admin/feedback/not-a-uuid');
      expect(response.status).toBe(400);
    });

    it('is admin-only: an ordinary session gets the no-disclosure 404', async () => {
      const rows = await seedInbox();
      const userAgent = request.agent(harness.app);
      const login = await userAgent
        .post('/api/v1/auth/login')
        .set(...XRW)
        .send({ identifier: alice.email, password: alice.password });
      expect(login.status).toBe(200);

      const response = await userAgent.get(`/api/v1/admin/feedback/${rows[0]!.id}`);
      expect(response.status).toBe(404);
    });
  });

  it('refuses an unknown query key rather than ignoring it', async () => {
    const response = await adminAgent.get('/api/v1/admin/feedback').query({ tag: 'dividends' });
    expect(response.status).toBe(400);
  });
});
