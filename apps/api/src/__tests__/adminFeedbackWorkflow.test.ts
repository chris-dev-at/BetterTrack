import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  adminFeedbackBulkResponseSchema,
  adminFeedbackCountsResponseSchema,
  adminFeedbackListResponseSchema,
  apiErrorSchema,
  auditLogListResponseSchema,
  createApiKeyResponseSchema,
  feedbackThreadResponseSchema,
  updateFeedbackStatusResponseSchema,
  type FeedbackCategory,
  type FeedbackStatus,
} from '@bettertrack/contracts';

import { createFeedbackRepository } from '../data/repositories/feedbackRepository';
import * as schema from '../data/schema';
import { limiterKeyForUser } from '../http/middleware/rateLimit';
import { progressiveKeys } from '../services/security/progressiveLimiter';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

/**
 * Owner directive 2026-10-29 — the admin half of the finished feedback API:
 * `GET /admin/feedback/counts`, the `from`/`to` filing-date filter, `POST
 * /admin/feedback/bulk`, a status change carrying a reply, and the audit rows
 * every real status change and admin reply now writes.
 *
 * Listed in vitest.config.integration.ts: the date filter is hand-written
 * `AT TIME ZONE` SQL with bound casts and the reply rides inside the status
 * write's transaction — both exactly the PGlite-vs-postgres-js divergence class
 * (#1443) that list exists for.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-7000-8000-000000000099';
type Agent = ReturnType<typeof request.agent>;

describe('admin feedback workflow (2026-10-29)', () => {
  let harness: TestHarness;
  let admin: SeededUser;
  let adminAgent: Agent;
  let sequence = 0;

  beforeAll(async () => {
    harness = await createTestApp();
    admin = await harness.seedAdmin();
    adminAgent = await harness.loginAdmin(admin);
  }, 60_000);

  beforeEach(async () => {
    await harness.db.delete(schema.feedback);
    await harness.db.delete(schema.notifications);
    await harness.db.delete(schema.auditLog).where(eq(schema.auditLog.targetType, 'feedback'));
  });

  async function seedSubmitter(label: string): Promise<SeededUser> {
    sequence += 1;
    return harness.seedUser({
      email: `fb-workflow-${label}-${sequence}@bt.test`,
      username: `fbworkflow_${label}_${sequence}`,
    });
  }

  async function loginAgent(app: Application, user: SeededUser): Promise<Agent> {
    const agent = request.agent(app);
    const response = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(response.status).toBe(200);
    return agent;
  }

  function details(status: FeedbackStatus) {
    return {
      status,
      declinedReason: status === 'declined' ? 'Outside the product scope.' : null,
      shippedVersion: status === 'shipped' ? '5.6.0' : null,
    };
  }

  async function seedRows(
    rows: Array<{
      userId: string;
      category?: FeedbackCategory;
      status?: FeedbackStatus;
      message?: string;
      createdAt?: Date;
      archivedAt?: Date | null;
    }>,
  ) {
    return harness.db
      .insert(schema.feedback)
      .values(
        rows.map((row, index) => {
          const createdAt = row.createdAt ?? new Date(Date.UTC(2026, 9, 1, 10, index));
          return {
            userId: row.userId,
            category: row.category ?? 'bug',
            message: row.message ?? `Workflow row ${index}`,
            ...details(row.status ?? 'new'),
            archivedAt: row.archivedAt ?? null,
            createdAt,
            updatedAt: createdAt,
            lastStatusChangeAt: createdAt,
          };
        }),
      )
      .returning();
  }

  function notificationsFor(userId: string) {
    return harness.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId))
      .orderBy(asc(schema.notifications.createdAt), asc(schema.notifications.id));
  }

  function feedbackAudit(ids: string[]) {
    return harness.db
      .select({
        action: schema.auditLog.action,
        actorId: schema.auditLog.actorId,
        targetId: schema.auditLog.targetId,
        meta: schema.auditLog.meta,
      })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.targetType, 'feedback'), inArray(schema.auditLog.targetId, ids)),
      )
      .orderBy(asc(schema.auditLog.createdAt), asc(schema.auditLog.id));
  }

  async function counts(query: Record<string, string> = {}) {
    const response = await adminAgent.get('/api/v1/admin/feedback/counts').query(query);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return adminFeedbackCountsResponseSchema.parse(response.body);
  }

  async function list(query: Record<string, string> = {}) {
    const response = await adminAgent.get('/api/v1/admin/feedback').query(query);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return adminFeedbackListResponseSchema.parse(response.body);
  }

  const sum = (values: Record<string, number>) =>
    Object.values(values).reduce((total, value) => total + value, 0);

  describe('GET /admin/feedback/counts', () => {
    it('zero-fills all six statuses and five categories on an empty inbox', async () => {
      const empty = await counts();
      expect(empty).toEqual({
        total: 0,
        byStatus: Object.fromEntries(FEEDBACK_STATUSES.map((status) => [status, 0])),
        byCategory: Object.fromEntries(FEEDBACK_CATEGORIES.map((category) => [category, 0])),
      });
      // Enum order on the wire, so a client can render the tabs as delivered.
      expect(Object.keys(empty.byStatus)).toEqual([...FEEDBACK_STATUSES]);
      expect(Object.keys(empty.byCategory)).toEqual([...FEEDBACK_CATEGORIES]);
    });

    it('counts exactly what the list pages over, for every filter', async () => {
      const alice = await seedSubmitter('alice');
      const bob = await seedSubmitter('bob');
      await seedRows([
        { userId: alice.id, category: 'bug', status: 'new', message: 'dividend sync broken' },
        { userId: alice.id, category: 'bug', status: 'triaged' },
        { userId: alice.id, category: 'feature', status: 'working_on_it' },
        { userId: bob.id, category: 'feature', status: 'shipped', message: 'dividend calendar' },
        { userId: bob.id, category: 'help', status: 'declined' },
        { userId: bob.id, category: 'improvement', status: 'saved_as_future_idea' },
        // Archived rows leave the default inbox and its counts alike.
        { userId: bob.id, category: 'other', status: 'new', archivedAt: new Date() },
        {
          userId: alice.id,
          category: 'bug',
          status: 'new',
          createdAt: new Date('2026-10-15T12:00:00.000Z'),
        },
      ]);

      const everything = await counts();
      expect(everything).toEqual({
        total: 7,
        byStatus: {
          new: 2,
          triaged: 1,
          working_on_it: 1,
          saved_as_future_idea: 1,
          declined: 1,
          shipped: 1,
        },
        byCategory: { feature: 2, bug: 3, other: 0, help: 1, improvement: 1 },
      });

      for (const query of [
        {},
        { category: 'bug' },
        { status: 'new' },
        { archived: 'true' },
        { q: 'dividend' },
        { q: alice.username },
        { version: '5.6.0' },
        { unread: 'false' },
        { from: '2026-10-10' },
        { to: '2026-10-10' },
        { category: 'feature', status: 'shipped' },
      ] as Array<Record<string, string>>) {
        const scoped = await counts(query);
        const page = await list({ ...query, limit: '100' });
        expect(scoped.total, JSON.stringify(query)).toBe(page.pagination.total);
        expect(sum(scoped.byStatus), JSON.stringify(query)).toBe(scoped.total);
        expect(sum(scoped.byCategory), JSON.stringify(query)).toBe(scoped.total);
        for (const status of FEEDBACK_STATUSES) {
          expect(scoped.byStatus[status], `${JSON.stringify(query)} ${status}`).toBe(
            page.submissions.filter((row) => row.status === status).length,
          );
        }
      }
      expect((await counts({ archived: 'true' })).byCategory.other).toBe(1);
    });

    it('is routed ahead of /feedback/:id and stays admin-only', async () => {
      // A route order slip would answer `counts` as a malformed :id (400).
      expect((await adminAgent.get('/api/v1/admin/feedback/counts')).status).toBe(200);

      const submitter = await seedSubmitter('nonadmin');
      const agent = await loginAgent(harness.app, submitter);
      expect((await agent.get('/api/v1/admin/feedback/counts')).status).toBe(404);

      const key = await agent
        .post('/api/v1/settings/api-keys')
        .set(...XRW)
        .send({ name: 'counts attempt', scopes: ['feedback:read', 'feedback:write'] });
      const token = createApiKeyResponseSchema.parse(key.body).token;
      const bearer = await request(harness.app)
        .get('/api/v1/admin/feedback/counts')
        .set('Authorization', `Bearer ${token}`);
      expect(bearer.status).toBe(404);
    });
  });

  describe('from/to filing-date filter', () => {
    it('reads inclusive Europe/Vienna days on createdAt, on the list and the counts', async () => {
      const submitter = await seedSubmitter('dates');
      // 2026-10-29 is CET (UTC+1): the Vienna day runs 10-28T23:00Z → 10-29T23:00Z.
      const [lateOn28, startOf29, endOf29, startOf30] = await seedRows([
        { userId: submitter.id, createdAt: new Date('2026-10-28T22:59:59.999Z') },
        { userId: submitter.id, createdAt: new Date('2026-10-28T23:00:00.000Z') },
        { userId: submitter.id, createdAt: new Date('2026-10-29T22:59:59.999Z') },
        { userId: submitter.id, createdAt: new Date('2026-10-29T23:00:00.000Z') },
      ]);

      const oneDay = await list({ from: '2026-10-29', to: '2026-10-29', sort: 'newest' });
      expect(oneDay.submissions.map((row) => row.id)).toEqual([endOf29!.id, startOf29!.id]);
      expect(oneDay.pagination.total).toBe(2);
      expect((await counts({ from: '2026-10-29', to: '2026-10-29' })).total).toBe(2);

      // `total` is the filtered total, not the page length.
      const paged = await list({ from: '2026-10-29', to: '2026-10-29', limit: '1' });
      expect(paged.submissions).toHaveLength(1);
      expect(paged.pagination).toMatchObject({ total: 2, totalPages: 2 });

      // Either end alone is open on the other side.
      expect(
        (await list({ from: '2026-10-29', sort: 'newest' })).submissions.map((row) => row.id),
      ).toEqual([startOf30!.id, endOf29!.id, startOf29!.id]);
      expect((await list({ to: '2026-10-28' })).submissions.map((row) => row.id)).toEqual([
        lateOn28!.id,
      ]);
    });

    it('measures a DST day by the wall clock: 2026-10-25 is 25 hours long in Vienna', async () => {
      const submitter = await seedSubmitter('dst');
      // CEST → CET at 03:00 local: the day runs 10-24T22:00Z → 10-25T23:00Z.
      const [before, first, last, after] = await seedRows([
        { userId: submitter.id, createdAt: new Date('2026-10-24T21:59:59.999Z') },
        { userId: submitter.id, createdAt: new Date('2026-10-24T22:00:00.000Z') },
        { userId: submitter.id, createdAt: new Date('2026-10-25T22:59:59.999Z') },
        { userId: submitter.id, createdAt: new Date('2026-10-25T23:00:00.000Z') },
      ]);

      const day = await list({ from: '2026-10-25', to: '2026-10-25', sort: 'newest' });
      expect(day.submissions.map((row) => row.id)).toEqual([last!.id, first!.id]);
      const ids = day.submissions.map((row) => row.id);
      expect(ids).not.toContain(before!.id);
      expect(ids).not.toContain(after!.id);
    });

    it('refuses an inverted range or an unreal day with 400 on both routes', async () => {
      for (const path of ['/api/v1/admin/feedback', '/api/v1/admin/feedback/counts']) {
        for (const query of [
          { from: '2026-10-31', to: '2026-10-01' },
          { from: '2026-02-30' },
          { to: '2026-10-1' },
        ]) {
          const response = await adminAgent.get(path).query(query);
          expect(response.status, `${path} ${JSON.stringify(query)}`).toBe(400);
          expect(apiErrorSchema.parse(response.body).error.code).toBe('VALIDATION_ERROR');
        }
      }
    });
  });

  describe('POST /admin/feedback/bulk', () => {
    it('applies a status per row, answers in input order, and fires one event + one audit row per real change', async () => {
      const alice = await seedSubmitter('bulka');
      const bob = await seedSubmitter('bulkb');
      const [first, second, already] = await seedRows([
        { userId: alice.id },
        { userId: bob.id },
        { userId: bob.id, status: 'triaged' },
      ]);
      const ids = [
        first!.id,
        second!.id,
        already!.id,
        MISSING_ID,
        'not-a-uuid',
        first!.id,
        first!.id.toUpperCase(),
      ];

      const response = await adminAgent
        .post('/api/v1/admin/feedback/bulk')
        .set(...XRW)
        .send({ action: 'status', ids, status: 'triaged' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const bulk = adminFeedbackBulkResponseSchema.parse(response.body);
      expect(bulk).toEqual({
        action: 'status',
        results: [
          { id: first!.id, result: 'ok' },
          { id: second!.id, result: 'ok' },
          { id: already!.id, result: 'unchanged' },
          { id: MISSING_ID, result: 'not_found' },
          { id: 'not-a-uuid', result: 'invalid' },
          // A repeat — in any letter case — is refused, never re-applied.
          { id: first!.id, result: 'invalid' },
          { id: first!.id.toUpperCase(), result: 'invalid' },
        ],
        summary: { ok: 2, unchanged: 1, not_found: 1, invalid: 3 },
      });

      const stored = await harness.db
        .select({ id: schema.feedback.id, status: schema.feedback.status })
        .from(schema.feedback);
      expect(stored.every((row) => row.status === 'triaged')).toBe(true);

      const aliceNotices = await notificationsFor(alice.id);
      const bobNotices = await notificationsFor(bob.id);
      expect(aliceNotices.map((notice) => notice.type)).toEqual(['feedback.status_changed']);
      // Bob owns two rows, only one of which really changed.
      expect(
        bobNotices.map((notice) => (notice.payload as { feedbackId: string }).feedbackId),
      ).toEqual([second!.id]);

      const audit = await feedbackAudit([first!.id, second!.id, already!.id]);
      expect(audit).toHaveLength(2);
      expect(audit).toEqual(
        expect.arrayContaining(
          [first!, second!].map((row) => ({
            action: 'feedback.status_changed',
            actorId: admin.id,
            targetId: row.id,
            meta: { from: 'new', to: 'triaged', source: 'bulk' },
          })),
        ),
      );

      // The same body again is a retry: every applied row answers `unchanged`
      // and nothing is emitted or audited a second time.
      const retry = adminFeedbackBulkResponseSchema.parse(
        (
          await adminAgent
            .post('/api/v1/admin/feedback/bulk')
            .set(...XRW)
            .send({ action: 'status', ids, status: 'triaged' })
            .expect(200)
        ).body,
      );
      expect(retry.summary).toEqual({ ok: 0, unchanged: 3, not_found: 1, invalid: 3 });
      expect(await notificationsFor(alice.id)).toHaveLength(1);
      expect(await notificationsFor(bob.id)).toHaveLength(1);
      expect(await feedbackAudit([first!.id, second!.id, already!.id])).toHaveLength(2);
    });

    it('writes a bulk reply only on rows that really changed, after their status event', async () => {
      const submitter = await seedSubmitter('bulkreply');
      const [open, alreadyDeclined] = await seedRows([
        { userId: submitter.id },
        { userId: submitter.id, status: 'declined' },
      ]);

      const bulk = adminFeedbackBulkResponseSchema.parse(
        (
          await adminAgent
            .post('/api/v1/admin/feedback/bulk')
            .set(...XRW)
            .send({
              action: 'status',
              ids: [open!.id, alreadyDeclined!.id],
              status: 'declined',
              declinedReason: 'Outside the product scope.',
              reply: 'Thank you — this is outside what BetterTrack will cover.',
            })
            .expect(200)
        ).body,
      );
      expect(bulk.results.map((row) => row.result)).toEqual(['ok', 'unchanged']);

      const messages = await harness.db.select().from(schema.feedbackMessages);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        feedbackId: open!.id,
        authorSide: 'admin',
        authorUserId: admin.id,
        body: 'Thank you — this is outside what BetterTrack will cover.',
      });

      const notices = await notificationsFor(submitter.id);
      expect(notices.map((notice) => notice.type)).toEqual([
        'feedback.status_changed',
        'feedback.reply_created',
      ]);
      expect(await feedbackAudit([open!.id, alreadyDeclined!.id])).toEqual([
        {
          action: 'feedback.status_changed',
          actorId: admin.id,
          targetId: open!.id,
          meta: { from: 'new', to: 'declined', source: 'bulk' },
        },
        {
          action: 'feedback.replied',
          actorId: admin.id,
          targetId: open!.id,
          meta: { messageId: messages[0]!.id, source: 'bulk' },
        },
      ]);
    });

    it('archives and unarchives per row with idempotent results and audit', async () => {
      const submitter = await seedSubmitter('bulkarchive');
      const [first, second] = await seedRows([{ userId: submitter.id }, { userId: submitter.id }]);
      const ids = [first!.id, second!.id];
      const run = async (action: 'archive' | 'unarchive') =>
        adminFeedbackBulkResponseSchema.parse(
          (
            await adminAgent
              .post('/api/v1/admin/feedback/bulk')
              .set(...XRW)
              .send({ action, ids })
              .expect(200)
          ).body,
        );

      expect((await run('archive')).summary).toMatchObject({ ok: 2, unchanged: 0 });
      expect((await list()).pagination.total).toBe(0);
      expect((await run('archive')).summary).toMatchObject({ ok: 0, unchanged: 2 });
      expect((await run('unarchive')).summary).toMatchObject({ ok: 2, unchanged: 0 });
      expect((await list()).pagination.total).toBe(2);

      const audit = await feedbackAudit(ids);
      expect(audit.map((row) => row.action).sort()).toEqual([
        'feedback.archived',
        'feedback.archived',
        'feedback.unarchived',
        'feedback.unarchived',
      ]);
      // Workspace hygiene is invisible to the submitter.
      expect(await notificationsFor(submitter.id)).toHaveLength(0);
    });

    it('bounds the batch at 100 ids and validates the action body', async () => {
      const submitter = await seedSubmitter('bulkbounds');
      const [row] = await seedRows([{ userId: submitter.id }]);
      const hundredAndOne = Array.from(
        { length: 101 },
        (_, index) => `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      );

      for (const body of [
        { action: 'archive', ids: hundredAndOne },
        { action: 'archive', ids: [] },
        { action: 'status', ids: [row!.id], status: 'shipped' },
        { action: 'status', ids: [row!.id], status: 'closed' },
        { action: 'purge', ids: [row!.id] },
      ]) {
        const response = await adminAgent
          .post('/api/v1/admin/feedback/bulk')
          .set(...XRW)
          .send(body);
        expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      }
      // 100 is admitted: every id answers, the unknown ones as not_found.
      const atLimit = adminFeedbackBulkResponseSchema.parse(
        (
          await adminAgent
            .post('/api/v1/admin/feedback/bulk')
            .set(...XRW)
            .send({ action: 'archive', ids: [row!.id, ...hundredAndOne.slice(0, 99)] })
            .expect(200)
        ).body,
      );
      expect(atLimit.results).toHaveLength(100);
      expect(atLimit.summary).toEqual({ ok: 1, unchanged: 0, not_found: 99, invalid: 0 });
    });

    it('stays admin-only for sessions and personal API keys', async () => {
      const submitter = await seedSubmitter('bulkguard');
      const [row] = await seedRows([{ userId: submitter.id }]);
      const agent = await loginAgent(harness.app, submitter);
      const body = { action: 'status', ids: [row!.id], status: 'shipped', shippedVersion: '9.9.9' };

      expect(
        (
          await agent
            .post('/api/v1/admin/feedback/bulk')
            .set(...XRW)
            .send(body)
        ).status,
      ).toBe(404);
      const key = await agent
        .post('/api/v1/settings/api-keys')
        .set(...XRW)
        .send({ name: 'bulk attempt', scopes: ['feedback:read', 'feedback:write'] });
      const token = createApiKeyResponseSchema.parse(key.body).token;
      expect(
        (
          await request(harness.app)
            .post('/api/v1/admin/feedback/bulk')
            .set('Authorization', `Bearer ${token}`)
            .send(body)
        ).status,
      ).toBe(404);

      const [stored] = await harness.db
        .select({ status: schema.feedback.status })
        .from(schema.feedback)
        .where(eq(schema.feedback.id, row!.id));
      expect(stored?.status).toBe('new');
    });
  });

  describe('status change with a reply', () => {
    it('writes the reply with the transition and emits status_changed then reply_created, once each', async () => {
      const submitter = await seedSubmitter('reply');
      const [row] = await seedRows([{ userId: submitter.id }]);
      const body = {
        status: 'declined',
        declinedReason: 'Outside the product scope.',
        reply: '  We will not build this, and here is why.  ',
      };

      const response = await adminAgent
        .patch(`/api/v1/admin/feedback/${row!.id}`)
        .set(...XRW)
        .send(body);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const changed = updateFeedbackStatusResponseSchema.parse(response.body);
      expect(changed).toMatchObject({ id: row!.id, status: 'declined' });
      expect(changed.message).toMatchObject({
        feedbackId: row!.id,
        senderId: admin.id,
        authorSide: 'admin',
        body: 'We will not build this, and here is why.',
      });

      const thread = feedbackThreadResponseSchema.parse(
        (await adminAgent.get(`/api/v1/admin/feedback/${row!.id}/messages`)).body,
      );
      expect(thread.messages.map((message) => message.id)).toEqual([changed.message!.id]);

      const notices = await notificationsFor(submitter.id);
      expect(notices.map((notice) => notice.type)).toEqual([
        'feedback.status_changed',
        'feedback.reply_created',
      ]);
      expect(notices[1]?.payload).toMatchObject({
        eventKey: `feedback.reply_created:${changed.message!.id}`,
      });

      // The retry changes nothing, writes no second reply, emits nothing, and
      // says so with `message: null`.
      const retry = await adminAgent
        .patch(`/api/v1/admin/feedback/${row!.id}`)
        .set(...XRW)
        .send(body);
      expect(retry.status).toBe(200);
      const retried = updateFeedbackStatusResponseSchema.parse(retry.body);
      expect(retried.message).toBeNull();
      expect(retried.lastStatusChangeAt).toBe(changed.lastStatusChangeAt);
      expect(await harness.db.select().from(schema.feedbackMessages)).toHaveLength(1);
      expect(await notificationsFor(submitter.id)).toHaveLength(2);

      // Audit: the transition and the reply — never the prose of either.
      expect(await feedbackAudit([row!.id])).toEqual([
        {
          action: 'feedback.status_changed',
          actorId: admin.id,
          targetId: row!.id,
          meta: { from: 'new', to: 'declined', source: 'single' },
        },
        {
          action: 'feedback.replied',
          actorId: admin.id,
          targetId: row!.id,
          meta: { messageId: changed.message!.id, source: 'single' },
        },
      ]);
    });

    it('answers a status body without a reply exactly as before — no message key', async () => {
      const submitter = await seedSubmitter('noreply');
      const [row] = await seedRows([{ userId: submitter.id }]);
      const response = await adminAgent
        .patch(`/api/v1/admin/feedback/${row!.id}`)
        .set(...XRW)
        .send({ status: 'triaged' });
      expect(response.status).toBe(200);
      expect(Object.keys(response.body as object)).toEqual([
        'id',
        'status',
        'lastStatusChangeAt',
        'declinedReason',
        'shippedVersion',
        'updatedAt',
      ]);
      expect(await harness.db.select().from(schema.feedbackMessages)).toHaveLength(0);
    });

    it('rolls the transition back when the reply cannot be written', async () => {
      const submitter = await seedSubmitter('rollback');
      const [row] = await seedRows([{ userId: submitter.id }]);
      const repo = createFeedbackRepository(harness.db);

      // A reply whose author does not exist violates the message FK inside the
      // status transaction — the transition must not survive without it.
      await expect(
        repo.setStatus(
          row!.id,
          { status: 'triaged' },
          { authorUserId: MISSING_ID, body: 'Orphaned reply.' },
        ),
      ).rejects.toThrow();

      const [stored] = await harness.db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.id, row!.id));
      expect(stored?.status).toBe('new');
      expect(stored?.lastStatusChangeAt.toISOString()).toBe(row!.lastStatusChangeAt.toISOString());
      expect(await harness.db.select().from(schema.feedbackMessages)).toHaveLength(0);
    });

    it('audits a reply sent through the thread route as source=thread', async () => {
      const submitter = await seedSubmitter('threadaudit');
      const [row] = await seedRows([{ userId: submitter.id }]);
      const response = await adminAgent
        .post(`/api/v1/admin/feedback/${row!.id}/messages`)
        .set(...XRW)
        .send({ body: 'A standalone answer.' });
      expect(response.status).toBe(201);
      const messageId = (response.body as { message: { id: string } }).message.id;
      expect(await feedbackAudit([row!.id])).toEqual([
        {
          action: 'feedback.replied',
          actorId: admin.id,
          targetId: row!.id,
          meta: { messageId, source: 'thread' },
        },
      ]);
    });

    it('surfaces both new audit actions under the admin_actions preset', async () => {
      const submitter = await seedSubmitter('preset');
      const [row] = await seedRows([{ userId: submitter.id }]);
      await adminAgent
        .patch(`/api/v1/admin/feedback/${row!.id}`)
        .set(...XRW)
        .send({ status: 'working_on_it', reply: 'On it.' })
        .expect(200);

      const response = await adminAgent
        .get('/api/v1/admin/audit')
        .query({ preset: 'admin_actions', action: 'feedback.' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const actions = auditLogListResponseSchema
        .parse(response.body)
        .entries.map((entry) => entry.action);
      expect(actions).toEqual(
        expect.arrayContaining(['feedback.status_changed', 'feedback.replied']),
      );
    });
  });

  it('meters a reply-carrying status PATCH and every bulk request once on the conversation budget', async () => {
    const limited = await createTestApp({ rateLimitsEnabled: true });
    try {
      const limitedAdmin = await limited.seedAdmin();
      const agent = await limited.loginAdmin(limitedAdmin);
      const submitter = await limited.seedUser({
        email: 'fb-workflow-limited@bt.test',
        username: 'fbworkflowlimited',
      });
      const rows = await limited.db
        .insert(schema.feedback)
        .values(
          Array.from({ length: 3 }, (_, index) => ({
            userId: submitter.id,
            category: 'other' as const,
            message: `Metered ${index}.`,
          })),
        )
        .returning();
      const threadKeys = progressiveKeys('feedback_thread', limiterKeyForUser(limitedAdmin.id));

      // A plain status change stays on the router-level admin budget alone.
      await agent
        .patch(`/api/v1/admin/feedback/${rows[0]!.id}`)
        .set(...XRW)
        .send({ status: 'triaged' })
        .expect(200);
      expect(await limited.ctx.redis.get(threadKeys.count)).toBeNull();

      // A status change that writes a reply spends what a standalone reply does.
      await agent
        .patch(`/api/v1/admin/feedback/${rows[1]!.id}`)
        .set(...XRW)
        .send({ status: 'triaged', reply: 'Seen.' })
        .expect(200);
      expect(await limited.ctx.redis.get(threadKeys.count)).toBe('1');

      // A bulk request is ONE hit, however many rows it addresses.
      await agent
        .post('/api/v1/admin/feedback/bulk')
        .set(...XRW)
        .send({ action: 'archive', ids: rows.map((row) => row.id) })
        .expect(200);
      expect(await limited.ctx.redis.get(threadKeys.count)).toBe('2');

      const threadLimit = limited.ctx.config.rateLimits.feedbackThread.limit;
      await limited.ctx.redis.set(threadKeys.count, String(threadLimit), 'EX', 3600);
      const refused = await agent
        .post('/api/v1/admin/feedback/bulk')
        .set(...XRW)
        .send({ action: 'unarchive', ids: rows.map((row) => row.id) });
      expect(refused.status).toBe(429);
      expect(apiErrorSchema.parse(refused.body).error.code).toBe('RATE_LIMITED');
      const stillArchived = await limited.db
        .select({ archivedAt: schema.feedback.archivedAt })
        .from(schema.feedback);
      expect(stillArchived.every((row) => row.archivedAt !== null)).toBe(true);
    } finally {
      // #1456: release only what this harness owns.
      await limited.dispose();
    }
  });
});
