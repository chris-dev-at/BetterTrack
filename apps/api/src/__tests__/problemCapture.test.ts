import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createErrorHandler } from '../http/errorHandler';
import { problems } from '../data/schema';
import {
  createProblemService,
  type ProblemService,
} from '../services/observability/problemService';
import type { ProblemRepository, UpsertProblemInput } from '../data/repositories/problemRepository';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * DB-backed problem capture — the Sentry replacement (PROJECTPLAN.md §13.5
 * V5-P2 arc (d)). Proves the capture works with ZERO configuration (no DSN, no
 * env): errors, failed jobs and provider failures are persisted, PII-scrubbed,
 * deduped by fingerprint with an incremented occurrence count, and rate-capped
 * so an identical-error storm cannot unbounded-write.
 */
describe('problem capture (Sentry replacement)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists a captured error deduped by fingerprint with an incremented count', async () => {
    const boom = new Error('widget blew up');
    harness.ctx.problems.captureError(boom);
    harness.ctx.problems.captureError(new Error('widget blew up'));
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('error');
    expect(rows[0]!.occurrenceCount).toBe(2);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.title).toBe('Error');
    expect(rows[0]!.message).toBe('widget blew up');
  });

  it('scrubs emails, tokens and credential keys before persisting (no PII)', async () => {
    harness.ctx.problems.captureError(
      new Error('failed for user alice@example.com with key btk_supersecretvalue'),
      { authorization: 'Bearer abc.def.ghi', note: 'ping bob@example.org' },
    );
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    expect(row).toBeDefined();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('bob@example.org');
    expect(serialized).not.toContain('btk_supersecretvalue');
    expect(serialized).not.toContain('abc.def.ghi');
    // The credential-bearing key is wholesale-redacted.
    expect((row!.context as Record<string, unknown>).authorization).toBe('[redacted]');
  });

  it('captures failed jobs and provider failures as their own kinds', async () => {
    harness.ctx.problems.captureJobFailure(new Error('handler threw'), {
      queue: 'market.refresh',
      jobId: 'job-1',
    });
    harness.ctx.problems.captureProviderFailure(new Error('429 too many requests'), {
      providerId: 'yahoo',
    });
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['job', 'provider']);
    const job = rows.find((r) => r.kind === 'job')!;
    expect(job.title).toContain('market.refresh');
    expect((job.context as Record<string, unknown>).jobId).toBe('job-1');
    const provider = rows.find((r) => r.kind === 'provider')!;
    expect(provider.title).toContain('yahoo');
  });

  it('persists an unhandled request error through the error-handler seam (zero config)', async () => {
    // Rebuild the exact app.ts wiring on a throwaway router: a 500 route whose
    // reporter feeds the DB capture. No DSN, no env — it just works.
    const app = express();
    app.get('/boom', () => {
      throw new Error('unhandled at secret@example.com');
    });
    app.use(
      createErrorHandler(harness.ctx.logger, (err) => harness.ctx.problems.captureError(err)),
    );

    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);

    await harness.ctx.problems.flush();
    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('error');
    expect(rows[0]!.message).not.toContain('secret@example.com');
  });
});

/** In-memory {@link ProblemRepository} that counts writes, for the rate-cap unit test. */
function fakeRepo(): { repo: ProblemRepository; writes: () => number } {
  let writes = 0;
  const rows = new Map<string, { occurrences: number }>();
  const repo: ProblemRepository = {
    async upsert(input: UpsertProblemInput) {
      writes += 1;
      const existing = rows.get(input.fingerprint);
      if (existing) existing.occurrences += input.occurrences;
      else rows.set(input.fingerprint, { occurrences: input.occurrences });
    },
    async list() {
      return [];
    },
    async get() {
      return null;
    },
    async setStatus() {
      return null;
    },
    async countByStatus() {
      return 0;
    },
  };
  return { repo, writes: () => writes };
}

describe('problem capture rate cap', () => {
  it('caps DB writes per window so an identical-error storm cannot unbounded-write', async () => {
    const { repo, writes } = fakeRepo();
    let clock = 0;
    const service: ProblemService = createProblemService({
      repo,
      now: () => clock,
      maxWritesPerWindow: 5,
      windowMs: 1000,
    });

    // 200 identical errors in the same window → at most 5 writes reach the DB.
    for (let i = 0; i < 200; i += 1) service.captureError(new Error('flood'));
    await service.flush();
    expect(writes()).toBe(5);

    // Rolling past the window frees the budget again.
    clock = 1000;
    service.captureError(new Error('flood'));
    await service.flush();
    expect(writes()).toBe(6);
  });
});
