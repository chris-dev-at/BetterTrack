import { and, count, eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FEEDBACK_OPEN_LIMIT,
  FEEDBACK_DECLINED_REASON_REQUIRED,
  FEEDBACK_SHIPPED_VERSION_REQUIRED,
  adminFeedbackListResponseSchema,
  apiErrorSchema,
  createApiKeyResponseSchema,
  feedbackThreadResponseSchema,
  myFeedbackResponseSchema,
  sendFeedbackMessageResponseSchema,
  updateFeedbackArchiveResponseSchema,
  updateFeedbackStatusResponseSchema,
} from '@bettertrack/contracts';

import { createFeedbackRepository } from '../data/repositories/feedbackRepository';
import * as schema from '../data/schema';
import { limiterKeyForUser } from '../http/middleware/rateLimit';
import { progressiveKeys } from '../services/security/progressiveLimiter';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
type Agent = ReturnType<typeof request.agent>;

describe('admin feedback inbox', () => {
  let harness: TestHarness;
  let admin: SeededUser;
  let adminAgent: Agent;
  let queueSequence = 0;

  beforeAll(async () => {
    harness = await createTestApp();
    admin = await harness.seedAdmin();
    adminAgent = await harness.loginAdmin(admin);
  }, 60_000);

  beforeEach(async () => {
    await harness.db.delete(schema.feedback);
    await harness.db.delete(schema.notifications);
  });

  async function loginAgent(app: Application, user: SeededUser): Promise<Agent> {
    const agent = request.agent(app);
    const response = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(response.status).toBe(200);
    return agent;
  }

  async function seedQueue() {
    queueSequence += 1;
    const webUser = await harness.seedUser({
      email: `web-feedback-${queueSequence}@bt.test`,
      username: `web_feedback_${queueSequence}`,
    });
    const mobileUser = await harness.seedUser({
      email: `mobile-feedback-${queueSequence}@bt.test`,
      username: `mobile_feedback_${queueSequence}`,
    });

    const rows = await harness.db
      .insert(schema.feedback)
      .values([
        {
          userId: webUser.id,
          category: 'feature',
          subject: 'Older web feature',
          message: 'Web feature request',
          context: { platform: 'web', screen: '/portfolio' },
          lastStatusChangeAt: new Date('2026-08-14T08:00:00.000Z'),
          createdAt: new Date('2026-08-14T08:00:00.000Z'),
          updatedAt: new Date('2026-08-14T08:00:00.000Z'),
        },
        {
          userId: mobileUser.id,
          category: 'feature',
          subject: 'Newer mobile feature',
          message: 'Android feature request',
          context: { platform: 'android', appVersion: '5.0.0' },
          lastStatusChangeAt: new Date('2026-08-16T08:00:00.000Z'),
          createdAt: new Date('2026-08-16T08:00:00.000Z'),
          updatedAt: new Date('2026-08-16T08:00:00.000Z'),
        },
        {
          userId: mobileUser.id,
          category: 'bug',
          subject: 'Mobile bug',
          message: 'A native issue',
          context: { platform: 'android' },
          lastStatusChangeAt: new Date('2026-08-17T08:00:00.000Z'),
          createdAt: new Date('2026-08-17T08:00:00.000Z'),
          updatedAt: new Date('2026-08-17T08:00:00.000Z'),
        },
        {
          userId: webUser.id,
          category: 'other',
          subject: null,
          message: 'Newest overall',
          context: { platform: 'web' },
          lastStatusChangeAt: new Date('2026-08-18T08:00:00.000Z'),
          createdAt: new Date('2026-08-18T08:00:00.000Z'),
          updatedAt: new Date('2026-08-18T08:00:00.000Z'),
        },
      ])
      .returning();

    return { rows, webUser, mobileUser };
  }

  function notificationRows(userId: string, type: string) {
    return harness.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.type, type)));
  }

  it('lists both clients category-first, supports newest sort, filtering and pagination', async () => {
    const { mobileUser } = await seedQueue();

    const defaultResponse = await adminAgent.get('/api/v1/admin/feedback');
    expect(defaultResponse.status).toBe(200);
    const defaultPage = adminFeedbackListResponseSchema.parse(defaultResponse.body);
    expect(defaultPage.submissions.map((row) => row.subject)).toEqual([
      'Newer mobile feature',
      'Older web feature',
      'Mobile bug',
      null,
    ]);
    expect(defaultPage.submissions.map((row) => row.context?.platform)).toContain('web');
    expect(defaultPage.submissions.map((row) => row.context?.platform)).toContain('android');
    expect(defaultPage.submissions[0]?.submitter.username).toBe(mobileUser.username);

    const newestResponse = await adminAgent.get('/api/v1/admin/feedback').query({ sort: 'newest' });
    expect(newestResponse.status).toBe(200);
    expect(adminFeedbackListResponseSchema.parse(newestResponse.body).submissions[0]?.message).toBe(
      'Newest overall',
    );

    const bugsResponse = await adminAgent.get('/api/v1/admin/feedback').query({ category: 'bug' });
    const bugs = adminFeedbackListResponseSchema.parse(bugsResponse.body);
    expect(bugs.submissions.map((row) => row.category)).toEqual(['bug']);
    expect(bugs.pagination.total).toBe(1);

    const secondResponse = await adminAgent
      .get('/api/v1/admin/feedback')
      .query({ page: 2, limit: 2 });
    const secondPage = adminFeedbackListResponseSchema.parse(secondResponse.body);
    expect(secondPage.submissions.map((row) => row.category)).toEqual(['bug', 'other']);
    expect(secondPage.pagination).toEqual({ page: 2, limit: 2, total: 4, totalPages: 2 });
  });

  it('archives the admin inbox only, with idempotent audit-visible toggles', async () => {
    const { rows, webUser } = await seedQueue();
    const target = rows[0]!;
    const submitterAgent = await loginAgent(harness.app, webUser);
    const mineBefore = await submitterAgent.get('/api/v1/feedback/mine');

    const firstArchive = await adminAgent
      .patch(`/api/v1/admin/feedback/${target.id}`)
      .set(...XRW)
      .send({ archived: true });
    expect(firstArchive.status).toBe(200);
    const archived = updateFeedbackArchiveResponseSchema.parse(firstArchive.body);
    expect(archived).toMatchObject({ id: target.id, archivedAt: expect.any(String) });

    const secondArchive = await adminAgent
      .patch(`/api/v1/admin/feedback/${target.id}`)
      .set(...XRW)
      .send({ archived: true });
    expect(secondArchive.status).toBe(200);
    expect(secondArchive.body).toEqual(firstArchive.body);

    const activeInbox = adminFeedbackListResponseSchema.parse(
      (await adminAgent.get('/api/v1/admin/feedback')).body,
    );
    expect(activeInbox.pagination.total).toBe(3);
    expect(activeInbox.submissions.map((row) => row.id)).not.toContain(target.id);

    const archivedInbox = adminFeedbackListResponseSchema.parse(
      (await adminAgent.get('/api/v1/admin/feedback').query({ archived: 'true' })).body,
    );
    expect(archivedInbox.pagination.total).toBe(1);
    expect(archivedInbox.submissions).toEqual([
      expect.objectContaining({ id: target.id, archivedAt: archived.archivedAt }),
    ]);

    // Archive is intentionally invisible on the submitter rail, including its
    // byte-level response shape and ordering.
    const mineWhileArchived = await submitterAgent.get('/api/v1/feedback/mine');
    expect(mineWhileArchived.text).toBe(mineBefore.text);

    const firstUnarchive = await adminAgent
      .patch(`/api/v1/admin/feedback/${target.id}`)
      .set(...XRW)
      .send({ archived: false });
    expect(firstUnarchive.status).toBe(200);
    expect(updateFeedbackArchiveResponseSchema.parse(firstUnarchive.body)).toMatchObject({
      id: target.id,
      archivedAt: null,
    });

    const secondUnarchive = await adminAgent
      .patch(`/api/v1/admin/feedback/${target.id}`)
      .set(...XRW)
      .send({ archived: false });
    expect(secondUnarchive.status).toBe(200);
    expect(secondUnarchive.body).toEqual(firstUnarchive.body);

    const restoredInbox = adminFeedbackListResponseSchema.parse(
      (await adminAgent.get('/api/v1/admin/feedback')).body,
    );
    expect(restoredInbox.pagination.total).toBe(4);
    expect(
      adminFeedbackListResponseSchema.parse(
        (await adminAgent.get('/api/v1/admin/feedback').query({ archived: 'true' })).body,
      ).submissions,
    ).toEqual([]);

    const [notificationCount] = await harness.db
      .select({ value: count() })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, target.userId));
    expect(notificationCount?.value).toBe(0);

    const auditRows = await harness.db
      .select({
        action: schema.auditLog.action,
        actorId: schema.auditLog.actorId,
        targetType: schema.auditLog.targetType,
        targetId: schema.auditLog.targetId,
      })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.targetType, 'feedback'), eq(schema.auditLog.targetId, target.id)),
      );
    expect(auditRows).toHaveLength(2);
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'feedback.archived',
          actorId: admin.id,
          targetType: 'feedback',
          targetId: target.id,
        }),
        expect.objectContaining({
          action: 'feedback.unarchived',
          actorId: admin.id,
          targetType: 'feedback',
          targetId: target.id,
        }),
      ]),
    );
  });

  it('archives tombstones and terminal rows without changing lifecycle state', async () => {
    const { rows } = await seedQueue();
    const declinedTarget = rows[0]!;
    const shippedTarget = rows[1]!;

    await adminAgent
      .patch(`/api/v1/admin/feedback/${declinedTarget.id}`)
      .set(...XRW)
      .send({
        status: 'declined',
        declinedReason: 'This does not fit the current product direction.',
      })
      .expect(200);
    await adminAgent
      .patch(`/api/v1/admin/feedback/${shippedTarget.id}`)
      .set(...XRW)
      .send({ status: 'shipped', shippedVersion: '5.5.0' })
      .expect(200);

    const archivedDeclined = updateFeedbackArchiveResponseSchema.parse(
      (
        await adminAgent
          .patch(`/api/v1/admin/feedback/${declinedTarget.id}`)
          .set(...XRW)
          .send({ archived: true })
      ).body,
    );
    const archivedShipped = updateFeedbackArchiveResponseSchema.parse(
      (
        await adminAgent
          .patch(`/api/v1/admin/feedback/${shippedTarget.id}`)
          .set(...XRW)
          .send({ archived: true })
      ).body,
    );

    queueSequence += 1;
    const tombstoneUser = await harness.seedUser({
      email: `feedback-archive-tombstone-${queueSequence}@bt.test`,
      username: `feedback_archive_tombstone_${queueSequence}`,
    });
    const tombstoneAgent = await loginAgent(harness.app, tombstoneUser);
    const created = await tombstoneAgent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'help', message: 'Please archive this deleted request.' })
      .expect(201);
    const tombstoneId = created.body.id as string;
    await tombstoneAgent
      .delete(`/api/v1/feedback/${tombstoneId}`)
      .set(...XRW)
      .expect(204);
    await adminAgent
      .patch(`/api/v1/admin/feedback/${tombstoneId}`)
      .set(...XRW)
      .send({ archived: true })
      .expect(200);

    // A status change remains available on an archived row and does not
    // silently return that row to the active inbox.
    await adminAgent
      .patch(`/api/v1/admin/feedback/${shippedTarget.id}`)
      .set(...XRW)
      .send({ status: 'working_on_it' })
      .expect(200);

    const archivedInbox = adminFeedbackListResponseSchema.parse(
      (await adminAgent.get('/api/v1/admin/feedback').query({ archived: 'true' })).body,
    );
    expect(archivedInbox.submissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: declinedTarget.id,
          status: 'declined',
          archivedAt: archivedDeclined.archivedAt,
        }),
        expect.objectContaining({
          id: shippedTarget.id,
          status: 'working_on_it',
          archivedAt: archivedShipped.archivedAt,
        }),
        expect.objectContaining({ id: tombstoneId, deletedByUser: true }),
      ]),
    );
    expect(archivedInbox.submissions).toHaveLength(3);
  });

  it('does not let archiving make room under the 20-open submission cap', async () => {
    queueSequence += 1;
    const user = await harness.seedUser({
      email: `feedback-archive-cap-${queueSequence}@bt.test`,
      username: `feedback_archive_cap_${queueSequence}`,
    });
    const agent = await loginAgent(harness.app, user);
    const rows = await harness.db
      .insert(schema.feedback)
      .values(
        Array.from({ length: 20 }, (_, index) => ({
          userId: user.id,
          category: 'other' as const,
          message: `Open request ${index}.`,
        })),
      )
      .returning();

    for (const row of rows.slice(0, 5)) {
      await adminAgent
        .patch(`/api/v1/admin/feedback/${row.id}`)
        .set(...XRW)
        .send({ archived: true })
        .expect(200);
    }

    const refused = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'other', message: 'The 21st request remains refused.' });
    expect(refused.status).toBe(409);
    expect(apiErrorSchema.parse(refused.body).error.code).toBe(FEEDBACK_OPEN_LIMIT);
  });

  it('round-trips help and improvement from create through mine and the admin inbox', async () => {
    queueSequence += 1;
    const user = await harness.seedUser({
      email: `helpdesk-categories-${queueSequence}@bt.test`,
      username: `helpdesk_categories_${queueSequence}`,
    });
    const agent = await loginAgent(harness.app, user);

    for (const category of ['help', 'improvement'] as const) {
      await agent
        .post('/api/v1/feedback')
        .set(...XRW)
        .send({ category, message: `${category} request` })
        .expect(201);
    }

    const mine = myFeedbackResponseSchema.parse((await agent.get('/api/v1/feedback/mine')).body);
    expect(mine.submissions.map((row) => row.category).sort()).toEqual(['help', 'improvement']);

    const admin = adminFeedbackListResponseSchema.parse(
      (await adminAgent.get('/api/v1/admin/feedback').query({ sort: 'newest' })).body,
    );
    expect(admin.submissions.map((row) => row.category).sort()).toEqual(['help', 'improvement']);
    expect(admin.submissions.every((row) => row.deletedByUser === false)).toBe(true);
  });

  it('keeps a user-deleted tombstone mutable for admins without notifying the user', async () => {
    queueSequence += 1;
    const user = await harness.seedUser({
      email: `helpdesk-delete-${queueSequence}@bt.test`,
      username: `helpdesk_delete_${queueSequence}`,
    });
    const agent = await loginAgent(harness.app, user);
    const created = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'help', message: 'I no longer need help.' });
    expect(created.status).toBe(201);

    await agent
      .delete(`/api/v1/feedback/${created.body.id as string}`)
      .set(...XRW)
      .expect(204);
    expect(
      myFeedbackResponseSchema.parse((await agent.get('/api/v1/feedback/mine')).body).submissions,
    ).toEqual([]);

    const listed = adminFeedbackListResponseSchema.parse(
      (await adminAgent.get('/api/v1/admin/feedback')).body,
    );
    expect(listed.submissions).toHaveLength(1);
    expect(listed.submissions[0]).toMatchObject({
      id: created.body.id,
      deletedByUser: true,
    });

    // A live control submission from the same user, transitioned identically.
    // Since #1340 landed, transitions DO notify — so this row proves the
    // tombstone assertion below is a real suppression rather than a vacuous
    // count of a notification path that never fires for anybody.
    const live = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'help', message: 'This one I still need.' });
    expect(live.status).toBe(201);

    for (const id of [created.body.id as string, live.body.id as string]) {
      const transitioned = await adminAgent
        .patch(`/api/v1/admin/feedback/${id}`)
        .set(...XRW)
        .send({ status: 'shipped', shippedVersion: '5.5.0' });
      expect(transitioned.status).toBe(200);
    }

    const notices = await notificationRows(user.id, 'feedback.status_changed');
    expect(notices.map((notice) => (notice.payload as { feedbackId: string }).feedbackId)).toEqual([
      live.body.id,
    ]);
    const [notifications] = await harness.db
      .select({ value: count() })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, user.id));
    expect(notifications?.value).toBe(1);
  });

  it('lets an admin persist declined reasons and shipped versions with status timestamps', async () => {
    const { rows } = await seedQueue();
    const declinedTarget = rows[0]!;
    const shippedTarget = rows[1]!;
    const declinedReason = 'This request conflicts with the compact workspace direction.';

    const declinedResponse = await adminAgent
      .patch(`/api/v1/admin/feedback/${declinedTarget.id}`)
      .set(...XRW)
      .send({ status: 'declined', declinedReason });
    expect(declinedResponse.status).toBe(200);
    const declined = updateFeedbackStatusResponseSchema.parse(declinedResponse.body);
    expect(declined).toMatchObject({
      id: declinedTarget.id,
      status: 'declined',
      declinedReason,
      shippedVersion: null,
    });
    expect(new Date(declined.lastStatusChangeAt).getTime()).toBeGreaterThan(
      declinedTarget.lastStatusChangeAt.getTime(),
    );

    const shippedResponse = await adminAgent
      .patch(`/api/v1/admin/feedback/${shippedTarget.id}`)
      .set(...XRW)
      .send({ status: 'shipped', shippedVersion: '5.4.0' });
    expect(shippedResponse.status).toBe(200);
    expect(updateFeedbackStatusResponseSchema.parse(shippedResponse.body)).toMatchObject({
      id: shippedTarget.id,
      status: 'shipped',
      declinedReason: null,
      shippedVersion: '5.4.0',
    });

    const reloadedResponse = await adminAgent.get('/api/v1/admin/feedback');
    const reloaded = adminFeedbackListResponseSchema.parse(reloadedResponse.body);
    expect(reloaded.submissions.find((row) => row.id === declinedTarget.id)).toMatchObject({
      status: 'declined',
      declinedReason,
      shippedVersion: null,
    });
    expect(reloaded.submissions.find((row) => row.id === shippedTarget.id)).toMatchObject({
      status: 'shipped',
      declinedReason: null,
      shippedVersion: '5.4.0',
    });
  });

  it('notifies a submitter once for an idempotent status transition', async () => {
    const { rows, webUser } = await seedQueue();
    const target = rows[0]!;

    const firstResponse = await adminAgent
      .patch(`/api/v1/admin/feedback/${target.id}`)
      .set(...XRW)
      .send({ status: 'triaged' });
    expect(firstResponse.status).toBe(200);
    const first = updateFeedbackStatusResponseSchema.parse(firstResponse.body);

    // Same lifecycle payload is an HTTP retry, not a fresh transition. The
    // repository preserves lastStatusChangeAt, so the natural dispatcher key is
    // stable even before its unique (user, eventKey) marker backs it up.
    const retryResponse = await adminAgent
      .patch(`/api/v1/admin/feedback/${target.id}`)
      .set(...XRW)
      .send({ status: 'triaged' });
    expect(retryResponse.status).toBe(200);
    const retry = updateFeedbackStatusResponseSchema.parse(retryResponse.body);
    expect(retry.lastStatusChangeAt).toBe(first.lastStatusChangeAt);

    // The HTTP retry alone would be satisfied by the repository's `changed:false`
    // short-circuit, which never reaches the dispatcher. Redelivering the SAME
    // transition event directly — what BullMQ does on a retry — is what actually
    // pins the documented key `…:{feedbackId}:{lastStatusChangeAt}`, mirroring
    // the reply case's message-id redelivery.
    await harness.ctx.notificationDispatcher.dispatch({
      type: 'feedback.status_changed',
      userId: webUser.id,
      feedbackId: target.id,
      status: 'triaged',
      lastStatusChangeAt: first.lastStatusChangeAt,
      occurredAt: first.lastStatusChangeAt,
    });

    const notices = await notificationRows(webUser.id, 'feedback.status_changed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({
      eventKey: `feedback.status_changed:${target.id}:${first.lastStatusChangeAt}`,
      feedbackId: target.id,
      status: 'triaged',
      lastStatusChangeAt: first.lastStatusChangeAt,
    });
    expect(await notificationRows(admin.id, 'feedback.status_changed')).toHaveLength(0);
  });

  it('does not notify an admin-submitter about their own status transition', async () => {
    const repo = createFeedbackRepository(harness.db);
    const submission = await repo.create(admin.id, {
      category: 'help',
      message: 'Admin-owned status request.',
    });
    expect(submission).not.toBeNull();

    const response = await adminAgent
      .patch(`/api/v1/admin/feedback/${submission!.id}`)
      .set(...XRW)
      .send({ status: 'triaged' });
    expect(response.status).toBe(200);
    expect(updateFeedbackStatusResponseSchema.parse(response.body)).toMatchObject({
      id: submission!.id,
      status: 'triaged',
    });

    const [persisted] = await harness.db
      .select({ status: schema.feedback.status })
      .from(schema.feedback)
      .where(eq(schema.feedback.id, submission!.id));
    expect(persisted?.status).toBe('triaged');
    expect(await notificationRows(admin.id, 'feedback.status_changed')).toHaveLength(0);
  });

  it('keeps distinct same-clock status transitions as distinct notification events', async () => {
    const { rows, webUser } = await seedQueue();
    const target = rows[0]!;
    const sharedClock = new Date('2026-08-20T12:00:00.000Z');
    const repo = createFeedbackRepository(harness.db, () => sharedClock);

    // The row lock serializes concurrent writers into this same sequence. Even
    // though both observe one wall-clock instant, each committed transition must
    // receive a distinct monotonic identity.
    const triaged = await repo.setStatus(target.id, { status: 'triaged' });
    const working = await repo.setStatus(target.id, { status: 'working_on_it' });
    expect(triaged?.changed).toBe(true);
    expect(working?.changed).toBe(true);
    expect(working!.row.lastStatusChangeAt.getTime()).toBeGreaterThan(
      triaged!.row.lastStatusChangeAt.getTime(),
    );

    const events = [triaged!, working!].map(({ row }) => {
      const occurredAt = row.lastStatusChangeAt.toISOString();
      return {
        type: 'feedback.status_changed' as const,
        userId: row.userId,
        feedbackId: row.id,
        status: row.status,
        lastStatusChangeAt: occurredAt,
        occurredAt,
      };
    });
    await harness.ctx.notificationDispatcher.dispatch(events[0]!);
    await harness.ctx.notificationDispatcher.dispatch(events[1]!);
    // Redelivery of one transition still dedupes without swallowing the other.
    await harness.ctx.notificationDispatcher.dispatch(events[0]!);

    const notices = await notificationRows(webUser.id, 'feedback.status_changed');
    expect(notices).toHaveLength(2);
    expect(
      notices.map((notice) => (notice.payload as { eventKey: string }).eventKey).sort(),
    ).toEqual(
      events
        .map((event) => `feedback.status_changed:${event.feedbackId}:${event.lastStatusChangeAt}`)
        .sort(),
    );
  });

  it('lets an admin read and reply to any submission through the shared thread wire shape', async () => {
    const { rows, webUser } = await seedQueue();
    const submission = rows[0]!;
    const submitterAgent = await loginAgent(harness.app, webUser);

    const submitterPost = await submitterAgent
      .post(`/api/v1/feedback/${submission.id}/messages`)
      .set(...XRW)
      .send({ body: 'Here are extra details.' });
    expect(submitterPost.status).toBe(201);
    // The submitter's own insert is visible to staff through the thread, but it
    // must never bounce a feedback notification back to its author.
    expect(await notificationRows(webUser.id, 'feedback.reply_created')).toHaveLength(0);

    const adminRead = await adminAgent.get(`/api/v1/admin/feedback/${submission.id}/messages`);
    expect(adminRead.status).toBe(200);
    const adminThread = feedbackThreadResponseSchema.parse(adminRead.body);
    expect(adminThread.thread).toEqual({ id: submission.id, unreadCount: 1 });
    expect(adminThread.messages[0]).toMatchObject({
      senderId: webUser.id,
      authorSide: 'submitter',
      body: 'Here are extra details.',
    });

    const adminPost = await adminAgent
      .post(`/api/v1/admin/feedback/${submission.id}/messages`)
      .set(...XRW)
      .send({ body: 'Thank you — we can reproduce it.' });
    expect(adminPost.status).toBe(201);
    const adminMessage = sendFeedbackMessageResponseSchema.parse(adminPost.body).message;
    expect(adminMessage).toMatchObject({
      feedbackId: submission.id,
      senderId: admin.id,
      authorSide: 'admin',
    });

    const firstNotices = await notificationRows(webUser.id, 'feedback.reply_created');
    expect(firstNotices).toHaveLength(1);
    expect(firstNotices[0]?.payload).toMatchObject({
      eventKey: `feedback.reply_created:${adminMessage.id}`,
      feedbackId: submission.id,
      messageId: adminMessage.id,
    });
    expect(await notificationRows(admin.id, 'feedback.reply_created')).toHaveLength(0);

    // BullMQ may redeliver an already-inserted message event. Its durable message
    // id is the idempotency key, so the dispatcher must retain exactly one row.
    await harness.ctx.notificationDispatcher.dispatch({
      type: 'feedback.reply_created',
      userId: webUser.id,
      feedbackId: submission.id,
      messageId: adminMessage.id,
      occurredAt: adminMessage.createdAt,
    });
    expect(await notificationRows(webUser.id, 'feedback.reply_created')).toHaveLength(1);

    const submitterRead = await submitterAgent.get(`/api/v1/feedback/${submission.id}/messages`);
    const submitterThread = feedbackThreadResponseSchema.parse(submitterRead.body);
    expect(submitterThread.thread.unreadCount).toBe(1);
    expect(submitterThread.messages.map((message) => message.authorSide)).toEqual([
      'admin',
      'submitter',
    ]);

    // The submitter gets the answer, never the answerer: a staff account id is
    // identity we surface to a user nowhere else, and the account export scrubs
    // this very field — the live endpoint must not hand back what the export
    // removes. Their own row keeps their own id.
    expect(submitterThread.messages.map((message) => message.senderId)).toEqual([null, webUser.id]);
    expect(JSON.stringify(submitterThread)).not.toContain(admin.id);

    // The same rows on the admin rail keep the id — that is the queue's record
    // of who answered.
    const adminReread = feedbackThreadResponseSchema.parse(
      (await adminAgent.get(`/api/v1/admin/feedback/${submission.id}/messages`)).body,
    );
    expect(adminReread.messages.map((message) => message.senderId)).toEqual([admin.id, webUser.id]);
  });

  it('does not notify an admin-submitter about their own persisted reply', async () => {
    const repo = createFeedbackRepository(harness.db);
    const submission = await repo.create(admin.id, {
      category: 'help',
      message: 'Admin-owned reply request.',
    });
    expect(submission).not.toBeNull();

    const response = await adminAgent
      .post(`/api/v1/admin/feedback/${submission!.id}/messages`)
      .set(...XRW)
      .send({ body: 'Handle this without notifying me.' });
    expect(response.status).toBe(201);
    const message = sendFeedbackMessageResponseSchema.parse(response.body).message;

    const threadResponse = await adminAgent.get(
      `/api/v1/admin/feedback/${submission!.id}/messages`,
    );
    expect(threadResponse.status).toBe(200);
    const thread = feedbackThreadResponseSchema.parse(threadResponse.body);
    expect(thread.messages).toContainEqual(
      expect.objectContaining({
        id: message.id,
        feedbackId: submission!.id,
        senderId: admin.id,
        authorSide: 'admin',
        body: 'Handle this without notifying me.',
      }),
    );
    expect(await notificationRows(admin.id, 'feedback.reply_created')).toHaveLength(0);
  });

  it('derives unread messages after each side marker and marks only that side read', async () => {
    const submitter = await harness.seedUser({
      email: 'feedback-unread@bt.test',
      username: 'feedbackunread',
    });
    const marker = new Date('2026-08-18T12:00:00.000Z');
    const before = new Date('2026-08-18T11:00:00.000Z');
    const after = new Date('2026-08-19T09:00:00.000Z');
    const [submission] = await harness.db
      .insert(schema.feedback)
      .values({
        userId: submitter.id,
        category: 'bug',
        message: 'Unread derivation.',
        submitterLastReadAt: marker,
        adminLastReadAt: marker,
      })
      .returning();
    await harness.db.insert(schema.feedbackMessages).values([
      {
        feedbackId: submission!.id,
        authorSide: 'admin',
        authorUserId: admin.id,
        body: 'Old admin reply.',
        createdAt: before,
      },
      {
        feedbackId: submission!.id,
        authorSide: 'submitter',
        authorUserId: submitter.id,
        body: 'Old submitter reply.',
        createdAt: before,
      },
      {
        feedbackId: submission!.id,
        authorSide: 'admin',
        authorUserId: admin.id,
        body: 'New admin reply one.',
        createdAt: after,
      },
      {
        feedbackId: submission!.id,
        authorSide: 'admin',
        authorUserId: admin.id,
        body: 'New admin reply two.',
        createdAt: after,
      },
      {
        feedbackId: submission!.id,
        authorSide: 'submitter',
        authorUserId: submitter.id,
        body: 'New submitter reply.',
        createdAt: after,
      },
    ]);
    const submitterAgent = await loginAgent(harness.app, submitter);

    const mineBefore = myFeedbackResponseSchema.parse(
      (await submitterAgent.get('/api/v1/feedback/mine')).body,
    );
    expect(mineBefore.submissions[0]?.unreadReplyCount).toBe(2);
    expect(
      feedbackThreadResponseSchema.parse(
        (await submitterAgent.get(`/api/v1/feedback/${submission!.id}/messages`)).body,
      ).thread.unreadCount,
    ).toBe(2);
    expect(
      feedbackThreadResponseSchema.parse(
        (await adminAgent.get(`/api/v1/admin/feedback/${submission!.id}/messages`)).body,
      ).thread.unreadCount,
    ).toBe(1);

    await submitterAgent
      .post(`/api/v1/feedback/${submission!.id}/read`)
      .set(...XRW)
      .expect(200);
    const mineAfter = myFeedbackResponseSchema.parse(
      (await submitterAgent.get('/api/v1/feedback/mine')).body,
    );
    expect(mineAfter.submissions[0]?.unreadReplyCount).toBe(0);
    expect(
      feedbackThreadResponseSchema.parse(
        (await adminAgent.get(`/api/v1/admin/feedback/${submission!.id}/messages`)).body,
      ).thread.unreadCount,
    ).toBe(1);

    await adminAgent
      .post(`/api/v1/admin/feedback/${submission!.id}/read`)
      .set(...XRW)
      .expect(200);
    expect(
      feedbackThreadResponseSchema.parse(
        (await adminAgent.get(`/api/v1/admin/feedback/${submission!.id}/messages`)).body,
      ).thread.unreadCount,
    ).toBe(0);
  });

  it('deletes a replying admin cleanly, anonymizing their staff rows instead of recalling them', async () => {
    const submitter = await harness.seedUser({
      email: 'feedback-staff-delete@bt.test',
      username: 'feedbackstaffdelete',
    });
    const [submission] = await harness.db
      .insert(schema.feedback)
      .values({ userId: submitter.id, category: 'bug', message: 'A second admin answers this.' })
      .returning();
    const staff = await harness.seedAdmin({
      email: 'second-admin-feedback@bt.test',
      username: 'secondadminfeedback',
      password: 'second-admin-strong-password-1',
    });
    const staffAgent = await harness.loginAdmin(staff);
    const reply = await staffAgent
      .post(`/api/v1/admin/feedback/${submission!.id}/messages`)
      .set(...XRW)
      .send({ body: 'Staff answer that outlives its author.' });
    expect(reply.status).toBe(201);

    // The owner later deletes that admin. Their replies sit on ANOTHER user's
    // submission, so nothing else clears them: under a NO ACTION FK the bare
    // `DELETE FROM users` raised 23503 and left the target disabled, sessions
    // destroyed — half-deleted.
    const deleted = await adminAgent
      .delete(`/api/v1/admin/users/${staff.id}`)
      .set(...XRW)
      .send({ confirmUsername: staff.username });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(
      await harness.db.select().from(schema.users).where(eq(schema.users.id, staff.id)),
    ).toEqual([]);

    // Anonymization is proven at the storage layer, not by the submitter rail's
    // projection (which nulls staff ids either way): the row itself lost its FK.
    const [storedReply] = await harness.db
      .select()
      .from(schema.feedbackMessages)
      .where(eq(schema.feedbackMessages.feedbackId, submission!.id));
    expect(storedReply).toMatchObject({ authorSide: 'admin', authorUserId: null });

    // The submitter keeps the answer they were given; only the internal id goes,
    // and `authorSide` still carries the staff attribution.
    const submitterAgent = await loginAgent(harness.app, submitter);
    const thread = feedbackThreadResponseSchema.parse(
      (await submitterAgent.get(`/api/v1/feedback/${submission!.id}/messages`)).body,
    );
    expect(thread.thread.unreadCount).toBe(1);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({
      senderId: null,
      authorSide: 'admin',
      body: 'Staff answer that outlives its author.',
    });
  });

  it('returns specific contract errors for missing or null declined/shipped details', async () => {
    const { rows } = await seedQueue();

    const declined = await adminAgent
      .patch(`/api/v1/admin/feedback/${rows[0]!.id}`)
      .set(...XRW)
      .send({ status: 'declined' });
    expect(declined.status).toBe(400);
    expect(apiErrorSchema.parse(declined.body).error.code).toBe(FEEDBACK_DECLINED_REASON_REQUIRED);

    const shipped = await adminAgent
      .patch(`/api/v1/admin/feedback/${rows[1]!.id}`)
      .set(...XRW)
      .send({ status: 'shipped' });
    expect(shipped.status).toBe(400);
    expect(apiErrorSchema.parse(shipped.body).error.code).toBe(FEEDBACK_SHIPPED_VERSION_REQUIRED);

    const declinedNull = await adminAgent
      .patch(`/api/v1/admin/feedback/${rows[2]!.id}`)
      .set(...XRW)
      .send({ status: 'declined', declinedReason: null });
    expect(declinedNull.status).toBe(400);
    expect(apiErrorSchema.parse(declinedNull.body).error.code).toBe(
      FEEDBACK_DECLINED_REASON_REQUIRED,
    );

    const shippedNull = await adminAgent
      .patch(`/api/v1/admin/feedback/${rows[3]!.id}`)
      .set(...XRW)
      .send({ status: 'shipped', shippedVersion: null });
    expect(shippedNull.status).toBe(400);
    expect(apiErrorSchema.parse(shippedNull.body).error.code).toBe(
      FEEDBACK_SHIPPED_VERSION_REQUIRED,
    );
  });

  it('keeps list and status routes unreachable to a signed-in non-admin', async () => {
    const { rows, webUser } = await seedQueue();
    const agent = await loginAgent(harness.app, webUser);

    const list = await agent.get('/api/v1/admin/feedback');
    expect(list.status).toBe(404);

    const update = await agent
      .patch(`/api/v1/admin/feedback/${rows[0]!.id}`)
      .set(...XRW)
      .send({ status: 'triaged' });
    expect(update.status).toBe(404);

    const thread = await agent.get(`/api/v1/admin/feedback/${rows[0]!.id}/messages`);
    expect(thread.status).toBe(404);

    const reply = await agent
      .post(`/api/v1/admin/feedback/${rows[0]!.id}/messages`)
      .set(...XRW)
      .send({ body: 'Not an admin.' });
    expect(reply.status).toBe(404);
  });

  it('meters admin replies on the conversation budget, not the capture budget', async () => {
    const limitedHarness = await createTestApp({ rateLimitsEnabled: true });
    try {
      const limitedAdmin = await limitedHarness.seedAdmin();
      const limitedAdminAgent = await limitedHarness.loginAdmin(limitedAdmin);
      const submitter = await limitedHarness.seedUser({
        email: 'limited-admin-feedback@bt.test',
        username: 'limitedadminfeedback',
      });
      const captureLimit = limitedHarness.ctx.config.rateLimits.feedback.limit;
      const threadLimit = limitedHarness.ctx.config.rateLimits.feedbackThread.limit;
      expect(threadLimit).toBeGreaterThan(captureLimit);
      const submissions = await limitedHarness.db
        .insert(schema.feedback)
        .values(
          Array.from({ length: captureLimit + 1 }, (_, index) => ({
            userId: submitter.id,
            category: 'other' as const,
            message: `Rate-limit replies ${index}.`,
          })),
        )
        .returning();

      // Answering a queue of submissions in one sitting is the workflow this
      // rail exists for: the owner must not be throttled against their own
      // inbox by the submitter-facing anti-spam allowance.
      for (const [index, submission] of submissions.entries()) {
        const accepted = await limitedAdminAgent
          .post(`/api/v1/admin/feedback/${submission.id}/messages`)
          .set(...XRW)
          .send({ body: `Admin reply ${index}` });
        expect(accepted.status).toBe(201);
      }
      // Replies never consume the capture budget, which stays whole for the
      // owner's own `POST /feedback`.
      expect(
        await limitedHarness.ctx.redis.get(
          progressiveKeys('feedback', limiterKeyForUser(limitedAdmin.id)).count,
        ),
      ).toBeNull();

      // The conversation budget is still a budget: exhaust it and the rail closes.
      const threadKeys = progressiveKeys('feedback_thread', limiterKeyForUser(limitedAdmin.id));
      expect(await limitedHarness.ctx.redis.get(threadKeys.count)).toBe(String(submissions.length));
      await limitedHarness.ctx.redis.set(threadKeys.count, String(threadLimit), 'EX', 3600);
      const limited = await limitedAdminAgent
        .post(`/api/v1/admin/feedback/${submissions[0]!.id}/messages`)
        .set(...XRW)
        .send({ body: 'One too many.' });
      expect(limited.status).toBe(429);
      expect(apiErrorSchema.parse(limited.body).error.code).toBe('RATE_LIMITED');
    } finally {
      await limitedHarness.ctx.redis.quit?.();
    }
  });

  it('keeps status transitions unreachable to personal API keys', async () => {
    const { rows, webUser } = await seedQueue();
    const agent = await loginAgent(harness.app, webUser);
    const keyResponse = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'feedback admin attempt', scopes: ['feedback:read', 'feedback:write'] });
    expect(keyResponse.status).toBe(201);
    const token = createApiKeyResponseSchema.parse(keyResponse.body).token;

    const update = await request(harness.app)
      .patch(`/api/v1/admin/feedback/${rows[0]!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'shipped', shippedVersion: '999.0.0' });
    expect(update.status).toBe(404);
    expect(apiErrorSchema.parse(update.body).error.code).toBe('NOT_FOUND');

    const [unchanged] = await harness.db
      .select({ status: schema.feedback.status })
      .from(schema.feedback)
      .where(eq(schema.feedback.id, rows[0]!.id));
    expect(unchanged?.status).toBe('new');
  });
});
