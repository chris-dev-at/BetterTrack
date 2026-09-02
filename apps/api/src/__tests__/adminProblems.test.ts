import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { problemListResponseSchema, problemSchema } from '@bettertrack/contracts';

import { auditLog } from '../data/schema';
import { eq } from 'drizzle-orm';
import { createProblemRepository } from '../data/repositories/problemRepository';
import { createProblemService } from '../services/observability/problemService';
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

  /**
   * The regression path (§13.5 V5-P2 arc (d)). A resolved row used to stay
   * resolved no matter how often it recurred, so the default view and the open
   * badge both read "nothing" while the same failure fired thousands of times.
   */
  it('reopens a resolved problem when the same fingerprint happens again', async () => {
    harness.ctx.problems.captureError(new Error('db pool exhausted'));
    await harness.ctx.problems.flush();
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const list = await agent.get('/api/v1/admin/problems').query({ status: 'open' });
    const target = problemListResponseSchema.parse(list.body).problems[0]!;
    const resolved = await agent.post(`/api/v1/admin/problems/${target.id}/resolve`).set(...XRW);
    expect(problemSchema.parse(resolved.body).status).toBe('resolved');
    expect(
      problemListResponseSchema.parse(
        (await agent.get('/api/v1/admin/problems').query({ status: 'open' })).body,
      ).openCount,
    ).toBe(0);

    // The recurrence, a minute later. A second service over the same repository
    // pins the clock so the sighting is unambiguously after the resolution —
    // the production path is the same `capture`, only wall-clock driven.
    const recurrence = createProblemService({
      repo: createProblemRepository(harness.db),
      now: () => Date.now() + 60_000,
    });
    recurrence.captureError(new Error('db pool exhausted'));
    await recurrence.flush();

    const reopened = await agent.get('/api/v1/admin/problems').query({ status: 'open' });
    const body = problemListResponseSchema.parse(reopened.body);
    const row = body.problems.find((p) => p.id === target.id);
    expect(row?.status).toBe('open');
    // Still flagged as a regression: an admin cleared this, and it came back.
    expect(row?.regressed).toBe(true);
    expect(row?.occurrenceCount).toBe(2);
    expect(body.openCount).toBe(1);

    // A manual reopen is NOT a regression — it clears the resolution outright.
    const manual = await agent.post(`/api/v1/admin/problems/${target.id}/reopen`).set(...XRW);
    expect(problemSchema.parse(manual.body).regressed).toBe(false);
  });

  /**
   * Paging. Nothing but a resolve ever removed a row from the default view and
   * nothing ever deleted one, so before this every problem past the newest page
   * was unreachable AND unresolvable through any UI path.
   */
  it('pages through every match and can resolve a row from the last page', async () => {
    for (let i = 0; i < 5; i += 1) {
      harness.ctx.problems.captureError(new Error(`paged failure number ${'x'.repeat(i + 1)}`));
    }
    await harness.ctx.problems.flush();
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const seen: string[] = [];
    let hasMore = true;
    let pages = 0;
    while (hasMore) {
      const res = await agent
        .get('/api/v1/admin/problems')
        .query({ status: 'open', limit: 2, offset: seen.length });
      expect(res.status).toBe(200);
      const page = problemListResponseSchema.parse(res.body);
      expect(page.total).toBe(5);
      seen.push(...page.problems.map((p) => p.id));
      hasMore = page.hasMore;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
    }

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);

    // The last row — unreachable before paging — resolves like any other.
    const resolved = await agent.post(`/api/v1/admin/problems/${seen[4]}/resolve`).set(...XRW);
    expect(resolved.status).toBe(200);
    expect(problemSchema.parse(resolved.body).status).toBe('resolved');
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
