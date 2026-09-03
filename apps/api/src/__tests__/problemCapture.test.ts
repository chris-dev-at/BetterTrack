import { DrizzleQueryError } from 'drizzle-orm/errors';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createErrorHandler } from '../http/errorHandler';
import { MAX_ERROR_MESSAGE_CHARS } from '../data/driverError';
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

  it('folds two errors that differ only in a redacted email into one row', async () => {
    harness.ctx.problems.captureError(new Error('no user for alice@example.com'));
    harness.ctx.problems.captureError(new Error('no user for bob@example.com'));
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(2);
    expect(rows[0]!.message).toBe('no user for [redacted-email]');
  });

  it('folds two errors that differ only in a redacted token body into one row', async () => {
    harness.ctx.problems.captureError(new Error('rejected key btk_supersecretvalue'));
    harness.ctx.problems.captureError(new Error('rejected key btk_othersecretvalue'));
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(2);
    expect(rows[0]!.message).toBe('rejected key [redacted-token]');
  });

  it('keeps genuinely different errors apart — folding is not over-broad', async () => {
    harness.ctx.problems.captureError(new Error('no user for alice@example.com'));
    harness.ctx.problems.captureError(new Error('no portfolio for alice@example.com'));
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.occurrenceCount)).toEqual([1, 1]);
    expect(rows.map((r) => r.message).sort()).toEqual([
      'no portfolio for [redacted-email]',
      'no user for [redacted-email]',
    ]);
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

  it('stores a provider failure URL with its api key and encoded email redacted', async () => {
    harness.ctx.problems.captureProviderFailure(
      new Error(
        'Request failed: https://api.provider.com/v8/finance?apikey=AB12CD34EF&user=alice%40example.com',
      ),
      { providerId: 'yahoo' },
    );
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    expect(row!.message).not.toContain('AB12CD34EF');
    expect(row!.message).not.toContain('alice%40example.com');
    expect(row!.message).toContain('apikey=[redacted-token]');
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

  it('captures the driver failure, not drizzle’s SQL-and-parameters wrapper', async () => {
    // drizzle-orm ≥0.44 rethrows every driver failure as a `DrizzleQueryError`
    // whose message is the statement plus its bound parameters. Captured
    // verbatim that puts the row's contents — here a note body — into a
    // `problems` row the admin page renders, past a scrubber that only knows
    // emails and `bt*_` tokens.
    const driverFailure = Object.assign(
      new Error('duplicate key value violates unique constraint "vault_blobs_pkey"'),
      { code: '23505', constraint: 'vault_blobs_pkey' },
    );
    harness.ctx.problems.captureError(
      new DrizzleQueryError(
        'insert into "portfolio_cash_movements" ("note") values ($1)',
        ['rent for the Berlin flat'],
        driverFailure,
      ),
    );
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe(
      'duplicate key value violates unique constraint "vault_blobs_pkey"',
    );
    expect(rows[0]!.message).not.toContain('rent for the Berlin flat');
    expect(rows[0]!.message).not.toContain('insert into');
    expect(JSON.stringify(rows[0])).not.toContain('rent for the Berlin flat');
  });

  it('caps a pathological message so one capture cannot become a megabyte row', async () => {
    harness.ctx.problems.captureError(new Error(`blob rejected: ${'A'.repeat(50_000)}`));
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    expect(row!.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS + 16);
    expect(row!.message.startsWith('blob rejected: AAA')).toBe(true);
    expect(row!.message).toContain('[truncated]');
  });

  it('still scrubs a message that is then truncated — the cut cannot expose PII', async () => {
    // Scrub-then-cap ordering: an email sitting past the cap is redacted first,
    // so no half of it survives at the boundary either.
    const long = 'x'.repeat(MAX_ERROR_MESSAGE_CHARS - 20);
    harness.ctx.problems.captureError(new Error(`${long} alice@example.com ${long}`));
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    expect(row!.message).toContain('[redacted-email]');
    expect(row!.message).not.toContain('alice@');
    expect(row!.message).not.toContain('example.com');
  });
});

/** In-memory {@link ProblemRepository} that counts writes, for the rate-cap unit test. */
function fakeRepo(): {
  repo: ProblemRepository;
  writes: () => number;
  occurrences: (fingerprint?: string) => number;
  fingerprints: () => number;
} {
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
    async countMatching() {
      return 0;
    },
    async deleteOlderThan() {
      return 0;
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
  return {
    repo,
    writes: () => writes,
    occurrences: (fingerprint) =>
      fingerprint === undefined
        ? [...rows.values()].reduce((sum, row) => sum + row.occurrences, 0)
        : (rows.get(fingerprint)?.occurrences ?? 0),
    fingerprints: () => rows.size,
  };
}

/**
 * The storm guard. The cap exists so N identical errors cost a bounded number of
 * DB writes — but it must not turn into a global mute: charging it before the
 * fingerprint was even computed meant one flapping source spent the whole budget
 * and a genuinely new error vanished with no trace at all.
 */
describe('problem capture rate cap', () => {
  it('caps DB writes per window so an identical-error storm cannot unbounded-write', async () => {
    const { repo, writes, occurrences } = fakeRepo();
    let clock = 0;
    const service: ProblemService = createProblemService({
      repo,
      now: () => clock,
      maxWritesPerWindow: 5,
      windowMs: 1000,
    });

    // 200 identical errors in one window → the insert plus one folded bump.
    for (let i = 0; i < 200; i += 1) service.captureError(new Error('flood'));
    await service.flush();
    expect(writes()).toBe(2);

    // Throttled repeats are DEFERRED, not lost: the next window's first write
    // for that fingerprint carries every occurrence observed in between.
    clock = 1000;
    service.captureError(new Error('flood'));
    await service.flush();
    expect(writes()).toBe(3);
    expect(occurrences()).toBe(201);
  });

  it('lets a distinct new problem through while one fingerprint floods the window', async () => {
    const { repo, fingerprints } = fakeRepo();
    const service = createProblemService({
      repo,
      now: () => 0,
      maxWritesPerWindow: 5,
      windowMs: 60_000,
    });

    // Far more repeats than the whole window budget, then something new.
    for (let i = 0; i < 500; i += 1) service.captureProviderFailure(new Error('breaker open'), {});
    service.captureError(new Error('a genuinely new 500'));
    await service.flush();

    expect(fingerprints()).toBe(2);
    expect(service.droppedCaptures()).toBe(0);
  });

  it('keeps one noisy kind from spending another kind budget', async () => {
    const { repo, fingerprints } = fakeRepo();
    const service = createProblemService({
      repo,
      now: () => 0,
      maxWritesPerWindow: 2,
      windowMs: 60_000,
    });

    // Three DISTINCT provider failures against a per-kind budget of two: the
    // third is dropped, and the error kind still has its own full budget.
    for (const id of ['yahoo', 'stooq', 'ecb']) {
      service.captureProviderFailure(new Error(`${id} unreachable`), { providerId: id });
    }
    service.captureError(new Error('unrelated request failure'));
    await service.flush();

    expect(fingerprints()).toBe(3);
    expect(service.droppedCaptures()).toBe(1);
  });

  it('never drops silently — a refused capture is logged and counted', async () => {
    const { repo } = fakeRepo();
    const warn = vi.fn();
    const logger = { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    let clock = 0;
    const service = createProblemService({
      repo,
      logger: logger as never,
      now: () => clock,
      maxWritesPerWindow: 1,
      windowMs: 1000,
    });

    service.captureError(new Error('first distinct'));
    service.captureError(new Error('second distinct'));
    service.captureError(new Error('third distinct'));
    await service.flush();

    expect(service.droppedCaptures()).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', reason: 'kind-budget' }),
      'problem capture dropped by the rate cap',
    );

    // The closed window reports its full tally, so a storm stays legible.
    clock = 1000;
    service.captureError(new Error('after the roll'));
    await service.flush();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: 2 }),
      'problem captures dropped by the rate cap in the closed window',
    );
  });
});
