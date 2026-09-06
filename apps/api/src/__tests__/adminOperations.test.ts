import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ADMIN_OPS_ERROR_MAX_LENGTH,
  adminOpsJobsResponseSchema,
  adminOpsProvidersResponseSchema,
} from '@bettertrack/contracts';

import { createDeadLetter, DEAD_LETTER_KEY, QUEUE_NAMES, type QueueRegistry } from '../jobs';
import { JOB_FAILURE_PAGE_SIZE, readJobOps, summaryOf } from '../services/ops/jobOpsService';
import { readProviderOps } from '../services/ops/providerOpsService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/**
 * Admin operations cockpit (#1406 W4) — `GET /admin/ops/jobs` and
 * `GET /admin/ops/providers`.
 *
 * Both routes are READS, so most of what is worth asserting is what they must
 * NOT do: leak a job payload, hand back an unbounded error string, answer a
 * non-admin, or draw zeroes when the truth is "I cannot see the queues".
 */

/**
 * A payload marker no legitimate projection can contain. The payload-leak tests
 * seed a REAL dead-letter entry carrying it, so the assertion has something to
 * catch — a fixture with an empty payload makes that check unable to fail.
 */
const PAYLOAD_MARKER = 'DEAD-LETTER-PAYLOAD-MUST-NOT-LEAK';

/** Wall-clock ceiling for one full-page dead-letter read (#1853, see its test). */
const READ_JOB_OPS_BUDGET_MS = 500;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function adminSession() {
  const admin = await harness.seedAdmin();
  const agent = await harness.loginAdmin(admin);
  return { admin, agent };
}

async function loginUser(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/**
 * Write a RAW dead-letter row, bypassing `createDeadLetter().record()` so the
 * test can put a shape on the list that the writer would never produce — which
 * is exactly the case the projection has to survive (an older format, a
 * truncated write, a future field change). `undefined` values drop out of
 * `JSON.stringify`, which is how a key goes missing.
 */
async function seedRawDeadLetter(row: Record<string, unknown>): Promise<void> {
  const full = {
    queue: QUEUE_NAMES.notificationsDispatch,
    name: 'notifications.dispatch',
    data: { userId: PAYLOAD_MARKER },
    failedReason: 'boom',
    attemptsMade: 3,
    timestamp: Date.UTC(2026, 8, 1, 12, 0, 0),
    ...row,
  };
  await harness.ctx.redis.lpush(DEAD_LETTER_KEY, JSON.stringify(full));
}

/** Seed one permanently-failed job into the §9 dead-letter list. */
async function seedDeadLetter(
  overrides: Partial<Parameters<ReturnType<typeof createDeadLetter>['record']>[0]> = {},
) {
  const deadLetter = createDeadLetter(harness.ctx.redis);
  await deadLetter.record({
    queue: QUEUE_NAMES.notificationsDispatch,
    jobId: 'job-1',
    name: 'notifications.dispatch',
    // The payload a real dispatch failure would carry: a user id and an email.
    data: { userId: PAYLOAD_MARKER, email: `${PAYLOAD_MARKER}@test.dev` },
    failedReason: 'ECONNREFUSED smtp.example.test:587',
    attemptsMade: 3,
    timestamp: Date.UTC(2026, 8, 1, 12, 0, 0),
    ...overrides,
  });
}

/**
 * A queue registry over fake queues, so the rich path is exercised even though
 * BullMQ cannot run on the suite's ioredis-mock (`ctx.queues` is null under
 * test). Only the four methods the projection calls are implemented.
 */
function fakeQueueRegistry(input: {
  counts?: Record<string, number>;
  schedulers?: Array<Record<string, unknown>>;
  completed?: Array<Record<string, unknown>>;
  failOn?: string;
}): QueueRegistry {
  const queueFor = (name: string) => ({
    getJobCounts: async () => {
      if (input.failOn === name) throw new Error('redis blip');
      return input.counts ?? {};
    },
    getJobSchedulers: async () =>
      name === QUEUE_NAMES.dataRetentionCleanup ? (input.schedulers ?? []) : [],
    getJobs: async () => (name === QUEUE_NAMES.dataRetentionCleanup ? (input.completed ?? []) : []),
  });
  return {
    get: ((name: string) => queueFor(name)) as unknown as QueueRegistry['get'],
    enqueue: (() => {
      throw new Error('the operations cockpit must never enqueue');
    }) as unknown as QueueRegistry['enqueue'],
    close: async () => {},
  };
}

describe('GET /admin/ops/jobs — the §9 dead-letter list finally has a reader (#1406 W4)', () => {
  it('answers the contract shape, and says available:false rather than drawing zeroes', async () => {
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    expect(res.status).toBe(200);
    const body = adminOpsJobsResponseSchema.parse(res.body);
    // The test process holds no queue registry. "I cannot see the queues" and
    // "nothing is queued" are different facts and must not render identically.
    expect(body.available).toBe(false);
    expect(body.queues).toEqual([]);
    expect(body.schedules).toEqual([]);
    expect(body.heartbeatIntervalSeconds).toBeGreaterThan(0);
  });

  it('projects a dead-lettered job WITHOUT its payload', async () => {
    await seedDeadLetter();
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    expect(res.status).toBe(200);
    // Assert on the RAW body: a zod parse strips unknown keys, which would make
    // this check unable to fail.
    expect(JSON.stringify(res.body)).not.toContain(PAYLOAD_MARKER);

    const body = adminOpsJobsResponseSchema.parse(res.body);
    expect(body.failureTotal).toBe(1);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({
      queue: QUEUE_NAMES.notificationsDispatch,
      jobId: 'job-1',
      failedReason: 'ECONNREFUSED smtp.example.test:587',
      attemptsMade: 3,
    });
    // The projection has no field for the payload at all.
    expect(Object.keys(body.failures[0]!)).not.toContain('data');
  });

  // One bad row in Redis must not cost the operator the whole panel. The
  // dead-letter list is written by a worker and JSON-parsed without validation,
  // so a shape change, a truncated write or an old-format row is reachable — and
  // before the fix each of these emptied the list AND reported `failureTotal: 0`,
  // which reads as "nothing has failed": the most dangerous possible lie here.
  it.each([
    ['a row with no failedReason', { failedReason: undefined }],
    ['a row with no timestamp', { timestamp: undefined }],
    ['a row whose failedReason is not a string', { failedReason: { nested: 'object' } }],
  ])('skips %s and still lists the good entry', async (_label, corruption) => {
    // Newest-first: push the good one FIRST so the corrupt row is newer and is
    // therefore reached before it during projection.
    await seedDeadLetter({ jobId: 'good-1', failedReason: 'ECONNREFUSED good.example:1' });
    await seedRawDeadLetter({ jobId: 'bad-1', ...corruption });

    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    // A malformed row is not a 500, and not a contract violation on the way out.
    expect(res.status).toBe(200);
    const body = adminOpsJobsResponseSchema.parse(res.body);

    // The good entry survives.
    expect(body.failures.map((failure) => failure.jobId)).toEqual(['good-1']);
    // The list length is honest about the retained rows…
    expect(body.failureTotal).toBe(2);
    // …and the unreadable one is counted rather than silently dropped, so the
    // UI can say "1 entry unreadable" instead of implying a shorter list.
    expect(body.malformed).toBe(1);
  });

  it('still reports the retained total when every row is unreadable', async () => {
    await seedRawDeadLetter({ jobId: 'bad-1', failedReason: undefined });
    await seedRawDeadLetter({ jobId: 'bad-2', timestamp: undefined });

    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    expect(res.status).toBe(200);
    const body = adminOpsJobsResponseSchema.parse(res.body);
    expect(body.failures).toEqual([]);
    expect(body.malformed).toBe(2);
    // `total` comes from LLEN, independent of whether projection succeeded.
    expect(body.failureTotal).toBe(2);
  });

  it('skips a row that is not valid JSON at all', async () => {
    await seedDeadLetter({ jobId: 'good-1' });
    await harness.ctx.redis.lpush(DEAD_LETTER_KEY, 'not-json-at-all{');

    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    const body = adminOpsJobsResponseSchema.parse(res.body);
    expect(body.failures.map((failure) => failure.jobId)).toEqual(['good-1']);
    expect(body.malformed).toBe(1);
    expect(body.failureTotal).toBe(2);
  });

  it('bounds a failure reason that has swallowed a request body', async () => {
    await seedDeadLetter({ failedReason: `${PAYLOAD_MARKER} ${'x'.repeat(10_000)}` });
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    const body = adminOpsJobsResponseSchema.parse(res.body);
    expect(body.failures[0]!.failedReason.length).toBeLessThanOrEqual(ADMIN_OPS_ERROR_MAX_LENGTH);
  });

  // An error message is the string most likely to have swallowed something it
  // should not have. It gets the same scrubbing the Problems page already
  // applies to every captured message, plus a UUID pass.
  it('redacts an address, a token and a row id out of a failure reason', async () => {
    await seedDeadLetter({
      failedReason:
        'dispatch to victim@example.test failed for portfolio ' +
        '550e8400-e29b-41d4-a716-446655440000 using btk_liveSecretKeyValue123',
    });
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('victim@example.test');
    expect(raw).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(raw).not.toContain('btk_liveSecretKeyValue123');

    const body = adminOpsJobsResponseSchema.parse(res.body);
    // The diagnostic half survives — which queue, and what kind of failure.
    expect(body.failures[0]!.failedReason).toContain('dispatch to');
    expect(body.failures[0]!.failedReason).toContain('failed for portfolio');
  });

  // Redaction runs BEFORE truncation: cutting first could leave the readable
  // half of an address or a token on screen, which is worse than either alone.
  it('redacts before truncating, so a long message cannot leak a half-token', async () => {
    await seedDeadLetter({
      failedReason: `${'x'.repeat(ADMIN_OPS_ERROR_MAX_LENGTH - 20)} victim@example.test`,
    });
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    expect(JSON.stringify(res.body)).not.toContain('victim@');
    const body = adminOpsJobsResponseSchema.parse(res.body);
    expect(body.failures[0]!.failedReason.length).toBeLessThanOrEqual(ADMIN_OPS_ERROR_MAX_LENGTH);
  });

  /**
   * Nothing caps a dead-letter entry's size at write time, and this read scrubs
   * one per projected row — a full page of them, again on every live-refresh
   * tick of the page an operator stares at while an incident is live. With the
   * pre-fix rule a quarter-MB `failedReason` cost ~2.9 s EACH on the API's single
   * event loop: ~71 s of blocked loop per page load, stalling every user's
   * request and making the incident worse the more it was looked at (#1853).
   *
   * The budget is generous because the read also LLRANGEs and JSON-parses
   * ~7.5 MB before any scrubbing happens (~13 ms here, all told); it is still
   * more than two orders of magnitude below what the scan alone used to cost.
   */
  it('projects a full page of 300 KB failure reasons without blocking the loop', async () => {
    const hostile = `?${'{"apikey":"a","signature":"b"},'.repeat(10_000)}`;
    expect(hostile.length).toBeGreaterThan(300_000);
    for (let i = 0; i < JOB_FAILURE_PAGE_SIZE; i += 1) {
      await seedDeadLetter({
        jobId: `job-${i}`,
        failedReason: `dispatch failed: ?apikey=SUPERSECRET ${hostile}`,
      });
    }

    const started = performance.now();
    const body = await readJobOps({ queues: null, redis: harness.ctx.redis });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(READ_JOB_OPS_BUDGET_MS);
    expect(body.failures).toHaveLength(JOB_FAILURE_PAGE_SIZE);
    for (const failure of body.failures) {
      // Reading less costs no redaction on what is shown: the credential is
      // still gone, and the row is still held to the wire limit.
      expect(failure.failedReason).toContain('?apikey=');
      expect(failure.failedReason).not.toContain('SUPERSECRET');
      expect(failure.failedReason.length).toBeLessThanOrEqual(ADMIN_OPS_ERROR_MAX_LENGTH);
    }
  });

  it('reads depths, schedules, next run and the sweep counts when a registry exists', async () => {
    harness.ctx.queues = fakeQueueRegistry({
      counts: { waiting: 4, active: 2, delayed: 1, failed: 3, completed: 9, paused: 0 },
      schedulers: [
        {
          key: 'k',
          name: 'data.retentionCleanup',
          id: 'data.retentionCleanup',
          pattern: '50 4 * * *',
          tz: 'Europe/Vienna',
          next: Date.UTC(2026, 8, 2, 2, 50, 0),
        },
      ],
      completed: [
        {
          processedOn: Date.UTC(2026, 8, 1, 2, 50, 0),
          finishedOn: Date.UTC(2026, 8, 1, 2, 50, 4),
          returnvalue: { auditPruned: 120, emailLogPruned: 8, deferredToNextRun: 0 },
        },
      ],
    });

    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');
    const body = adminOpsJobsResponseSchema.parse(res.body);

    expect(body.available).toBe(true);
    // Every declared queue is reported, `paused` included (health omits it).
    expect(body.queues.length).toBeGreaterThan(0);
    expect(body.queues[0]).toMatchObject({ waiting: 4, active: 2, failed: 3, paused: 0 });

    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]).toMatchObject({
      id: 'data.retentionCleanup',
      queue: QUEUE_NAMES.dataRetentionCleanup,
      pattern: '50 4 * * *',
      tz: 'Europe/Vienna',
      everyMs: null,
      nextRunAt: new Date(Date.UTC(2026, 8, 2, 2, 50, 0)).toISOString(),
    });
    // The retention sweep's own counts, carried out of its BullMQ return value.
    expect(body.schedules[0]!.lastRun).toEqual({
      finishedAt: new Date(Date.UTC(2026, 8, 1, 2, 50, 4)).toISOString(),
      durationMs: 4_000,
      counts: { auditPruned: 120, emailLogPruned: 8, deferredToNextRun: 0 },
    });
  });

  it('degrades to available:false when the registry is there but unreadable', async () => {
    harness.ctx.queues = fakeQueueRegistry({ failOn: QUEUE_NAMES.systemHeartbeat });
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/jobs');

    expect(res.status).toBe(200);
    const body = adminOpsJobsResponseSchema.parse(res.body);
    expect(body.available).toBe(false);
  });

  it('has no write companion — the DECISION killed queue retry/discard', async () => {
    const { agent } = await adminSession();
    for (const path of [
      '/api/v1/admin/ops/jobs',
      '/api/v1/admin/ops/jobs/retry',
      '/api/v1/admin/ops/jobs/discard',
    ]) {
      const res = await agent
        .post(path)
        .set(...XRW)
        .send({});
      expect(res.status).toBe(404);
    }
  });
});

describe('summaryOf — the second gate on a job return value', () => {
  it('keeps a flat record of finite numbers', () => {
    expect(summaryOf({ pruned: 3, capped: 0 })).toEqual({ pruned: 3, capped: 0 });
  });

  it.each([
    ['a string value', { userId: 'u_123' }],
    ['a nested object', { rows: { id: 1 } }],
    ['an array', [1, 2, 3]],
    ['a bare string', 'u_123'],
    ['a non-finite number', { pruned: Number.POSITIVE_INFINITY }],
    ['null', null],
    ['an empty object', {}],
  ])('drops %s rather than passing an unknown shape through', (_label, value) => {
    expect(summaryOf(value)).toBeNull();
  });
});

describe('the breaker note is scrubbed and bounded at the WIRE, not just in memory', () => {
  const breakerWith = (lastError: string) =>
    readProviderOps({
      marketData: {
        breakerSnapshots: () => [
          {
            providerId: 'yahoo',
            state: 'open' as const,
            capabilities: [
              {
                capability: 'quote' as const,
                state: 'open' as const,
                consecutiveFailures: 5,
                failureThreshold: 5,
                openedAtMs: 1,
                retryAtMs: 2,
                lastError,
                lastErrorAtMs: 1,
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof readProviderOps>[0]['marketData'],
      now: () => 1_000,
      uptimeSeconds: () => 1,
    });

  // The breaker keeps its own in-memory cap, but that is a memory concern and is
  // independently reachable. Only the wire cap is the contract's promise.
  it('bounds a note longer than the contract allows', async () => {
    const body = await breakerWith('y'.repeat(5_000));
    const note = body.providers[0]!.capabilities[0]!.lastError!;
    expect(note.length).toBeLessThanOrEqual(ADMIN_OPS_ERROR_MAX_LENGTH);
    // And it parses against its own schema, which is what a wire cap is for.
    expect(() => adminOpsProvidersResponseSchema.parse(body)).not.toThrow();
  });

  it('redacts an address out of a breaker note', async () => {
    const body = await breakerWith('upstream rejected owner@example.test');
    expect(body.providers[0]!.capabilities[0]!.lastError).not.toContain('owner@example.test');
  });
});

describe('GET /admin/ops/providers — the capability dimension (#1406 W4)', () => {
  it('answers the contract shape with null rates before anything is sampled', async () => {
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/providers');

    expect(res.status).toBe(200);
    const body = adminOpsProvidersResponseSchema.parse(res.body);
    // Every non-local upstream is listed. Nothing has been called yet, so the
    // provider reads closed with NO capability rows: "never exercised" and
    // "exercised and healthy" are different facts and are drawn differently.
    expect(body.providers.length).toBeGreaterThan(0);
    for (const provider of body.providers) {
      expect(provider.state).toBe('closed');
      expect(provider.capabilities).toEqual([]);
      expect(provider.calls).toEqual({ success: 0, error: 0, circuitOpen: 0 });
    }
    // A cache that has answered nothing has no hit rate — null, never 0 %.
    if (body.cache.total === 0) {
      expect(body.cache.hitRate).toBeNull();
      expect(body.cache.staleRate).toBeNull();
    }
    expect(Date.parse(body.sampledSince)).toBeLessThanOrEqual(Date.parse(body.checkedAt));
  });

  it('publishes no quota gauge — the provider is keyless (DECISION)', async () => {
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/ops/providers');
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('quota');
  });
});

describe('operations reads are admin-only, and leak nothing to anyone else', () => {
  const paths = ['/api/v1/admin/ops/jobs', '/api/v1/admin/ops/providers'] as const;

  it.each(paths)('answers 404 to an anonymous caller: %s', async (path) => {
    const res = await request(harness.app).get(path);
    expect(res.status).toBe(404);
  });

  it.each(paths)('answers 404 to a signed-in non-admin: %s', async (path) => {
    await harness.seedUser({ email: 'ops-peeker@test.dev', username: 'ops-peeker' });
    const agent = await loginUser(harness.app, 'ops-peeker@test.dev', 'user-strong-password-1');
    const res = await agent.get(path);
    // 404, never 403: a non-admin must not learn the route exists (§6.12).
    expect(res.status).toBe(404);
  });

  it('does not expose a dead-lettered payload to a non-admin either', async () => {
    await seedDeadLetter();
    await harness.seedUser({ email: 'ops-peeker2@test.dev', username: 'ops-peeker2' });
    const agent = await loginUser(harness.app, 'ops-peeker2@test.dev', 'user-strong-password-1');
    const res = await agent.get('/api/v1/admin/ops/jobs');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(PAYLOAD_MARKER);
  });
});
