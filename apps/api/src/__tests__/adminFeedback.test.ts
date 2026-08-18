import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  adminFeedbackListResponseSchema,
  updateFeedbackStatusResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
type Agent = ReturnType<typeof request.agent>;

describe('admin feedback inbox', () => {
  let harness: TestHarness;
  let adminAgent: Agent;
  let queueSequence = 0;

  beforeAll(async () => {
    harness = await createTestApp();
    const admin = await harness.seedAdmin();
    adminAgent = await harness.loginAdmin(admin);
  }, 60_000);

  beforeEach(async () => {
    await harness.db.delete(schema.feedback);
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
          createdAt: new Date('2026-08-14T08:00:00.000Z'),
          updatedAt: new Date('2026-08-14T08:00:00.000Z'),
        },
        {
          userId: mobileUser.id,
          category: 'feature',
          subject: 'Newer mobile feature',
          message: 'Android feature request',
          context: { platform: 'android', appVersion: '5.0.0' },
          createdAt: new Date('2026-08-16T08:00:00.000Z'),
          updatedAt: new Date('2026-08-16T08:00:00.000Z'),
        },
        {
          userId: mobileUser.id,
          category: 'bug',
          subject: 'Mobile bug',
          message: 'A native issue',
          context: { platform: 'android' },
          createdAt: new Date('2026-08-17T08:00:00.000Z'),
          updatedAt: new Date('2026-08-17T08:00:00.000Z'),
        },
        {
          userId: webUser.id,
          category: 'other',
          subject: null,
          message: 'Newest overall',
          context: { platform: 'web' },
          createdAt: new Date('2026-08-18T08:00:00.000Z'),
          updatedAt: new Date('2026-08-18T08:00:00.000Z'),
        },
      ])
      .returning();

    return { rows, webUser, mobileUser };
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

  it('persists a status change and returns it on a fresh list read', async () => {
    const { rows } = await seedQueue();
    const target = rows[0]!;

    const changedResponse = await adminAgent
      .patch(`/api/v1/admin/feedback/${target.id}/status`)
      .set(...XRW)
      .send({ status: 'done' });
    expect(changedResponse.status).toBe(200);
    const changed = updateFeedbackStatusResponseSchema.parse(changedResponse.body);
    expect(changed).toMatchObject({ id: target.id, status: 'done' });

    const reloadedResponse = await adminAgent.get('/api/v1/admin/feedback');
    const reloaded = adminFeedbackListResponseSchema.parse(reloadedResponse.body);
    expect(reloaded.submissions.find((row) => row.id === target.id)?.status).toBe('done');
  });

  it('keeps list and status routes unreachable to a signed-in non-admin', async () => {
    const { rows, webUser } = await seedQueue();
    const agent = await loginAgent(harness.app, webUser);

    const list = await agent.get('/api/v1/admin/feedback');
    expect(list.status).toBe(404);

    const update = await agent
      .patch(`/api/v1/admin/feedback/${rows[0]!.id}/status`)
      .set(...XRW)
      .send({ status: 'triaged' });
    expect(update.status).toBe(404);
  });
});
