import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { problemListResponseSchema, problemSchema } from '@bettertrack/contracts';

import { auditLog } from '../data/schema';
import { eq } from 'drizzle-orm';
import { createProblemRepository } from '../data/repositories/problemRepository';
import { createProblemService } from '../services/observability/problemService';
import { createProblemDropTally } from '../services/observability/problemDropTally';
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
   * The other direction (#1847). A storm's throttled occurrences are DEFERRED
   * and written when the window rolls — which is up to a whole window after
   * they happened, and routinely after an admin has resolved the row in the
   * meantime. Stamping the drain's own clock on them made the reopen rule read
   * them as a recurrence: the resolve was silently undone, the row was flagged
   * as a regression, and `last_seen_at` jumped a minute past the last real
   * sighting — all with nothing having happened after the resolution.
   */
  it('drains a storm’s deferred occurrences at the time they happened, so a resolve stands', async () => {
    // The occurrences happen 10 s before the resolve, on a pinned clock; the
    // window then rolls a minute later, which is when the drain writes.
    const base = createProblemRepository(harness.db);
    const settling: Promise<unknown>[] = [];
    const repo = {
      ...base,
      upsert: (input: Parameters<typeof base.upsert>[0]) => {
        const write = base.upsert(input);
        settling.push(write);
        return write;
      },
    };
    const settle = async (): Promise<void> => {
      await Promise.allSettled(settling.splice(0));
    };

    const occurredAt = Date.now() - 10_000;
    let clock = occurredAt;
    const capture = createProblemService({
      repo,
      now: () => clock,
      windowMs: 60_000,
      maxRepeatWritesPerFingerprint: 1,
    });
    // Three identical 500s: the insert, one folded bump, one occurrence left
    // throttled and waiting for the window to close.
    for (let i = 0; i < 3; i += 1) capture.captureError(new Error('db pool exhausted'));
    await settle();

    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const open = await agent.get('/api/v1/admin/problems').query({ status: 'open' });
    const target = problemListResponseSchema.parse(open.body).problems[0]!;
    expect(target.occurrenceCount).toBe(2);
    const resolved = await agent.post(`/api/v1/admin/problems/${target.id}/resolve`).set(...XRW);
    expect(problemSchema.parse(resolved.body).status).toBe('resolved');

    // The window rolls on the admin's own next read — that is what drains.
    clock = occurredAt + 70_000;
    await capture.list({ limit: 25 });
    await settle();

    const after = await agent.get('/api/v1/admin/problems').query({ status: 'resolved' });
    const drained = problemListResponseSchema
      .parse(after.body)
      .problems.find((p) => p.id === target.id)!;
    // The count converges on the truth …
    expect(drained.occurrenceCount).toBe(3);
    // … without resurrecting a problem nothing has done since the resolve.
    expect(drained.status).toBe('resolved');
    expect(drained.regressed).toBe(false);
    expect(new Date(drained.lastSeenAt).getTime()).toBe(occurredAt);

    // And a genuine recurrence — one that happens AFTER the resolution — still
    // reopens the row and is still flagged as a regression. The fix is an
    // honest timestamp, not a blanket "never reopen".
    clock = occurredAt + 130_000;
    capture.captureError(new Error('db pool exhausted'));
    await settle();
    const reopened = await agent.get('/api/v1/admin/problems').query({ status: 'open' });
    const row = problemListResponseSchema
      .parse(reopened.body)
      .problems.find((p) => p.id === target.id)!;
    expect(row.status).toBe('open');
    expect(row.regressed).toBe(true);
    expect(row.occurrenceCount).toBe(4);
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

  it('publishes the capture budget’s drops so a truncated incident reads as one', async () => {
    // A multi-fault minute produces more distinct fingerprints than the budget
    // allows; the refused ones are only visible if the list says so.
    const capped = createProblemService({
      repo: createProblemRepository(harness.db),
      maxWritesPerWindow: 2,
    });
    // Distinguished by WORDS, not digits: the fold key normalizes numbers away,
    // so numbered messages would be one fingerprint and nothing would be dropped.
    for (const fault of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      capped.captureError(new Error(`${fault} subsystem failed`));
    }
    await capped.flush();
    harness.ctx.problems = capped;

    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent.get('/api/v1/admin/problems');
    const body = problemListResponseSchema.parse(res.body);
    expect(body.problems).toHaveLength(2);
    expect(body.droppedCaptures).toBe(3);
    expect(body.droppedCapturesTotal).toBe(3);
  });

  it('includes the worker process’s refused captures, never reporting them as zero', async () => {
    // Every `kind: 'job'` capture happens in the WORKER, against ITS budget and
    // ITS in-memory counters — which the API process cannot see. Publishing only
    // the local tally reported a worker drop storm as `droppedCaptures: 0`,
    // i.e. exactly the silent drop the capture contract rules out.
    const redis = harness.ctx.redis;
    // Start from a known tally: the shared keys outlive a single harness (and,
    // on real Redis, a single test run). The window counter is bucketed per
    // window (#1847), so the whole role prefix goes.
    const stale = await redis.keys('problems:drops:worker:*');
    if (stale.length > 0) await redis.del(...stale);

    const workerTally = createProblemDropTally(redis, 'worker');
    const workerProblems = createProblemService({
      repo: createProblemRepository(harness.db),
      maxWritesPerWindow: 1,
      onDrop: (kind, reason) => workerTally.record(kind, reason),
    });
    workerProblems.captureJobFailure(new Error('handler threw'), { queue: 'market.refresh' });
    workerProblems.captureJobFailure(new Error('handler threw'), { queue: 'alerts.evaluate' });
    await workerProblems.flush();
    await workerTally.settled();
    expect(workerProblems.droppedCaptures()).toBe(1);

    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent.get('/api/v1/admin/problems');
    const body = problemListResponseSchema.parse(res.body);

    // The API itself refused nothing — every drop in this number is the worker's.
    expect(harness.ctx.problems.droppedCaptures()).toBe(0);
    expect(body.droppedCaptures).toBe(1);
    expect(body.droppedCapturesTotal).toBe(1);
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
