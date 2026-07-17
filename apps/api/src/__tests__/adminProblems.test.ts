import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { problemListResponseSchema, problemSchema } from '@bettertrack/contracts';

import { auditLog } from '../data/schema';
import { eq } from 'drizzle-orm';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/**
 * Admin Problems endpoints (PROJECTPLAN.md §13.5 V5-P2 arc (d), the Sentry
 * replacement). Lists/filters captured problems and drives the resolve/reopen
 * flow (audit-logged); non-admins get a no-leak 404.
 */
describe('admin problems', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedProblems(): Promise<void> {
    harness.ctx.problems.captureError(new Error('request blew up'));
    harness.ctx.problems.captureJobFailure(new Error('job died'), { queue: 'market.refresh' });
    harness.ctx.problems.captureProviderFailure(new Error('provider down'), {
      providerId: 'yahoo',
    });
    await harness.ctx.problems.flush();
  }

  it('lists and filters captured problems for an admin', async () => {
    await seedProblems();
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const all = await agent.get('/api/v1/admin/problems');
    expect(all.status).toBe(200);
    const body = problemListResponseSchema.parse(all.body);
    expect(body.problems).toHaveLength(3);
    expect(body.openCount).toBe(3);

    const onlyJobs = await agent.get('/api/v1/admin/problems').query({ kind: 'job' });
    expect(onlyJobs.status).toBe(200);
    const jobs = problemListResponseSchema.parse(onlyJobs.body);
    expect(jobs.problems).toHaveLength(1);
    expect(jobs.problems[0]!.kind).toBe('job');
  });

  it('resolves and reopens a problem, audit-logged, and filters by status', async () => {
    await seedProblems();
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const list = await agent.get('/api/v1/admin/problems');
    const target = problemListResponseSchema.parse(list.body).problems[0]!;

    const resolved = await agent.post(`/api/v1/admin/problems/${target.id}/resolve`).set(...XRW);
    expect(resolved.status).toBe(200);
    const resolvedProblem = problemSchema.parse(resolved.body);
    expect(resolvedProblem.status).toBe('resolved');
    expect(resolvedProblem.resolvedBy).toBe(admin.id);
    expect(resolvedProblem.resolvedAt).not.toBeNull();

    // Default filter (status=open) now excludes the resolved one.
    const openOnly = await agent.get('/api/v1/admin/problems').query({ status: 'open' });
    const openBody = problemListResponseSchema.parse(openOnly.body);
    expect(openBody.problems.map((p) => p.id)).not.toContain(target.id);
    expect(openBody.openCount).toBe(2);

    // The resolve wrote an audit entry.
    const auditRows = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'problem.resolved'));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.targetId).toBe(target.id);

    const reopened = await agent.post(`/api/v1/admin/problems/${target.id}/reopen`).set(...XRW);
    expect(reopened.status).toBe(200);
    expect(problemSchema.parse(reopened.body).status).toBe('open');
  });

  it('404s an unknown problem id', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent
      .post('/api/v1/admin/problems/00000000-0000-7000-8000-000000000000/resolve')
      .set(...XRW);
    expect(res.status).toBe(404);
  });

  it('404s the problems surface for anonymous and user-kind callers (no leak)', async () => {
    await seedProblems();

    const anon = await request(harness.app).get('/api/v1/admin/problems');
    expect(anon.status).toBe(404);

    const user = await harness.seedUser({ email: 'plain@test.dev', username: 'plain_user' });
    const userAgent = request.agent(harness.app);
    const login = await userAgent
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);
    const userRes = await userAgent.get('/api/v1/admin/problems');
    expect(userRes.status).toBe(404);
  });
});
