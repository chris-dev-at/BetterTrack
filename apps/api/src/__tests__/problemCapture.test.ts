import { readFileSync } from 'node:fs';

import { DrizzleQueryError } from 'drizzle-orm/errors';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROBLEM_CONTEXT_MAX_BYTES,
  PROBLEM_CONTEXT_VALUE_MAX_BYTES,
  PROBLEM_MESSAGE_MAX_BYTES,
  PROBLEM_TITLE_MAX_BYTES,
} from '@bettertrack/contracts';

import { createErrorHandler } from '../http/errorHandler';
import { MAX_ERROR_MESSAGE_CHARS } from '../data/driverError';
import { problems } from '../data/schema';
import {
  createProblemService,
  MAX_TRACKED_FINGERPRINTS,
  type ProblemService,
} from '../services/observability/problemService';
import { registerProcessErrorCapture } from '../services/observability/processErrorCapture';
import { scrubOpsError } from '../services/ops/opsText';
import { REDACTED_TOKEN } from '../services/observability/scrubber';
import {
  createProblemRepository,
  type ProblemRepository,
  type UpsertProblemInput,
} from '../data/repositories/problemRepository';
import { handleWorkerError } from '../jobs/worker';
import { flushTelemetryBuffers } from '../shutdown';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * DB-backed problem capture — the Sentry replacement (PROJECTPLAN.md §13.5
 * V5-P2 arc (d)). Proves the capture works with ZERO configuration (no DSN, no
 * env): errors, failed jobs and provider failures are persisted, PII-scrubbed,
 * deduped by fingerprint with an incremented occurrence count, and rate-capped
 * so an identical-error storm cannot unbounded-write.
 */
/**
 * Wall-clock ceiling for one capture's scrubbing work (#1853), the same number
 * the scrubber's own linearity guard uses. A 1 MB capture measures ~13 ms of it
 * (the message is bounded first; the stack that repeats the message is scanned
 * in full and linearly), while the pre-fix path spent SECONDS on one message —
 * so a regression misses this by orders of magnitude rather than flaking.
 */
const SCRUB_TIME_BUDGET_MS = 100;

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

  it('captures a worker-scoped error as a job-kind problem naming the worker, not a job', async () => {
    // A failure of the job SYSTEM: no `failed` event ever names a job for it, so
    // `captureJobFailure` would invent one. Same kind, so the admin's job filter
    // still shows it (§13.5 V5-P2).
    harness.ctx.problems.captureWorkerError(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      queue: 'market.refresh',
    });
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('job');
    expect(rows[0]!.title).toBe('market.refresh worker error');
    const context = rows[0]!.context as Record<string, unknown>;
    expect(context.queue).toBe('market.refresh');
    expect(context.scope).toBe('worker');
  });

  it('redacts an object id from a captured problem, exactly as the ops cockpit does', async () => {
    // The dead-letter panel and the Problems page render the SAME failure text.
    // The id pass lived only in `scrubOpsError`, so one surface showed
    // `[redacted-id]` and the other the user's raw id (#1847).
    const failure = 'no recipient for user 550e8400-e29b-41d4-a716-446655440000';
    harness.ctx.problems.captureJobFailure(new Error(failure), {
      queue: 'notifications.dispatch',
      jobId: 'notify-42',
    });
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    expect(row!.message).toBe('no recipient for user [redacted-id]');
    // The two surfaces agree on one fixture string.
    expect(row!.message).toBe(scrubOpsError(failure));
    // Including the stack, whose first line repeats the message verbatim.
    expect(JSON.stringify(row)).not.toContain('550e8400');
    // Our own scheduling handle is NOT an object id and survives — it is what
    // tells two identical failures apart.
    expect((row!.context as Record<string, unknown>).jobId).toBe('notify-42');
  });

  it('stores a bounded stack for a failed job, like the request path', async () => {
    // A permanently-failed job is the capture an operator can least often
    // reproduce, and its row used to carry no call path at all (#1847).
    harness.ctx.problems.captureJobFailure(new Error('handler threw'), {
      queue: 'market.refresh',
    });
    harness.ctx.problems.captureProviderFailure(new Error('breaker open'), { providerId: 'yahoo' });
    harness.ctx.problems.captureWorkerError(new Error('lock extension failed'), {
      queue: 'alerts.evaluate',
    });
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const stack = (row.context as Record<string, unknown>).stack as string;
      expect(stack).toContain('Error: ');
      // The same bound the request path uses: 20 frames plus the elision mark.
      expect(stack.split('\n').length).toBeLessThanOrEqual(21);
      expect(Buffer.byteLength(stack, 'utf8')).toBeLessThanOrEqual(PROBLEM_CONTEXT_VALUE_MAX_BYTES);
    }
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

  it('captures the failed request’s method, route template, status and request id', async () => {
    // The app.ts wiring verbatim, on a SUB-ROUTER: the router restores
    // `req.baseUrl` before the app-level handler sees the error, so a template
    // read off it alone would lose the mount prefix.
    const app = express();
    const router = express.Router();
    router.get('/:id', () => {
      throw new TypeError("Cannot read properties of undefined (reading 'id')");
    });
    app.use('/api/v1/portfolios', router);
    app.use(
      createErrorHandler(harness.ctx.logger, (err, requestContext) =>
        harness.ctx.problems.captureError(err, requestContext),
      ),
    );

    const res = await request(app).get('/api/v1/portfolios/018f4b7e-8d3a-7c19-9d0b-1a2b3c4d5e6f');
    expect(res.status).toBe(500);
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    const context = row!.context as Record<string, unknown>;
    expect(context.method).toBe('GET');
    expect(context.route).toBe('/api/v1/portfolios/:id');
    expect(context.status).toBe(500);
    expect(typeof context.requestId).toBe('string');
    // The concrete id never enters the stored context.
    expect(JSON.stringify(row)).not.toContain('018f4b7e');
  });

  it('stores a bounded stack for a captured error', async () => {
    harness.ctx.problems.captureError(new Error('deep failure'), {
      method: 'GET',
      route: '/api/v1/things',
      status: 500,
    });
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    const stack = (row!.context as Record<string, unknown>).stack as string;
    expect(stack).toContain('Error: deep failure');
    expect(stack.split('\n').length).toBeLessThanOrEqual(21);
    expect(Buffer.byteLength(stack, 'utf8')).toBeLessThanOrEqual(PROBLEM_CONTEXT_VALUE_MAX_BYTES);
  });

  it('scrubs the stack and the request context like every other captured value', async () => {
    harness.ctx.problems.captureError(new Error('lookup failed for alice@example.com'), {
      method: 'GET',
      route: '/api/v1/things',
      status: 500,
      cookie: 'bt_session=abc',
      note: 'key btk_supersecretvalue',
    });
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('btk_supersecretvalue');
    const context = row!.context as Record<string, unknown>;
    expect(context.cookie).toBe('[redacted]');
    // The stack repeats the message, so it must be scrubbed too.
    expect(context.stack as string).toContain('[redacted-email]');
  });

  it('keeps two endpoints throwing the identical error apart, and still folds one endpoint', async () => {
    const identical = () => new TypeError("Cannot read properties of undefined (reading 'id')");
    const at = (route: string) => ({ method: 'GET', route, status: 500 });

    harness.ctx.problems.captureError(identical(), at('/api/v1/portfolios/:id'));
    harness.ctx.problems.captureError(identical(), at('/api/v1/workboard/:id'));
    // The SAME endpoint twice still folds — the #1547 behaviour is preserved.
    harness.ctx.problems.captureError(identical(), at('/api/v1/portfolios/:id'));
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2);
    const portfolios = rows.find(
      (r) => (r.context as Record<string, unknown>).route === '/api/v1/portfolios/:id',
    )!;
    expect(portfolios.occurrenceCount).toBe(2);
  });

  it('folds two ids on the same endpoint into one row — the route never carries an id', async () => {
    const app = express();
    const router = express.Router();
    router.get('/:id', () => {
      throw new TypeError('same failure');
    });
    app.use('/api/v1/portfolios', router);
    app.use(
      createErrorHandler(harness.ctx.logger, (err, requestContext) =>
        harness.ctx.problems.captureError(err, requestContext),
      ),
    );

    await request(app).get('/api/v1/portfolios/018f4b7e-8d3a-7c19-9d0b-1a2b3c4d5e6f');
    await request(app).get('/api/v1/portfolios/0190aa11-2b3c-7d4e-8f90-a1b2c3d4e5f6');
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(2);
    expect((rows[0]!.context as Record<string, unknown>).route).toBe('/api/v1/portfolios/:id');
  });

  it('bounds a multi-hundred-KB provider error to the documented byte ceilings', async () => {
    // An upstream 5xx HTML page inside a fetch error: one legal capture under a
    // budget that counts ROWS, several hundred KB on disk.
    const htmlBody = `<html><body>${'error page '.repeat(30_000)}</body></html>`;
    harness.ctx.problems.captureProviderFailure(new Error(`502 from upstream: ${htmlBody}`), {
      providerId: 'yahoo',
    });
    await harness.ctx.problems.flush();

    const [row] = await harness.db.select().from(problems);
    expect(Buffer.byteLength(row!.title, 'utf8')).toBeLessThanOrEqual(PROBLEM_TITLE_MAX_BYTES);
    expect(Buffer.byteLength(row!.message, 'utf8')).toBeLessThanOrEqual(PROBLEM_MESSAGE_MAX_BYTES);
    expect(row!.message).toContain('[truncated]');
    expect(Buffer.byteLength(JSON.stringify(row!.context), 'utf8')).toBeLessThanOrEqual(
      PROBLEM_CONTEXT_MAX_BYTES,
    );
  });

  it('bounds an oversized context tree at the repository write boundary too', async () => {
    // Straight at the repo, bypassing the service: the write boundary must hold
    // the same ceiling on its own (no DB CHECK — that would drop the capture).
    const repo = createProblemRepository(harness.db);
    await repo.upsert({
      fingerprint: 'f'.repeat(40),
      kind: 'error',
      title: 'T'.repeat(5_000),
      message: 'M'.repeat(500_000),
      context: { blob: 'B'.repeat(500_000), nested: { deeper: 'D'.repeat(200_000) } },
      seenAt: new Date(),
      occurrences: 1,
    });

    const [row] = await harness.db.select().from(problems);
    expect(Buffer.byteLength(row!.title, 'utf8')).toBeLessThanOrEqual(PROBLEM_TITLE_MAX_BYTES);
    expect(Buffer.byteLength(row!.message, 'utf8')).toBeLessThanOrEqual(PROBLEM_MESSAGE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(row!.context), 'utf8')).toBeLessThanOrEqual(
      PROBLEM_CONTEXT_MAX_BYTES,
    );
    expect((row!.context as Record<string, unknown>).truncated).toBe(true);
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

  it('bounds a 1 MB message BEFORE the scrubber reads it, and still redacts it', async () => {
    // #1853: capture scrubbed the RAW string and capped afterwards, so every
    // byte past the cap was scanned for nothing — and the query rule's own
    // keyword made that scan quadratic (296 KB cost ~2.9 s on the API's single
    // event loop). This is a megabyte of exactly that shape.
    const hostile =
      'GET https://api.provider.com/v8?apikey=SUPERSECRET failed: ' +
      `?${'{"apikey":"a","signature":"b"},'.repeat(34_000)}`;
    expect(hostile.length).toBeGreaterThan(1_000_000);

    const started = performance.now();
    harness.ctx.problems.captureError(new Error(hostile));
    const elapsed = performance.now() - started;
    await harness.ctx.problems.flush();

    expect(elapsed).toBeLessThan(SCRUB_TIME_BUDGET_MS);

    const [row] = await harness.db.select().from(problems);
    // Bounding the INPUT costs no redaction on the part that is kept…
    expect(row!.message).toContain(`?apikey=${REDACTED_TOKEN}`);
    expect(row!.message).not.toContain('SUPERSECRET');
    // …and the row is still held to the documented caps.
    expect(row!.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS + 16);
    expect(row!.message).toContain('[truncated]');
  });
});

/** In-memory {@link ProblemRepository} that counts writes, for the rate-cap unit test. */
function fakeRepo(): {
  repo: ProblemRepository;
  writes: () => number;
  occurrences: (fingerprint?: string) => number;
  fingerprints: () => number;
  /** Every upsert, in order — the write's own `seenAt` included. */
  upserts: () => UpsertProblemInput[];
} {
  let writes = 0;
  const seen: UpsertProblemInput[] = [];
  const rows = new Map<string, { occurrences: number }>();
  const repo: ProblemRepository = {
    async upsert(input: UpsertProblemInput) {
      writes += 1;
      seen.push(input);
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
    upserts: () => [...seen],
  };
}

/** A distinct, digit-free label per index (`a`, `b`, …, `aa`) — see below. */
function letterLabel(index: number): string {
  let out = '';
  let n = index;
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  } while (n > 0);
  return out;
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

    // 200 identical errors in one window → the insert, one folded bump, and the
    // drain that flush() performs for what was throttled after those two.
    for (let i = 0; i < 200; i += 1) service.captureError(new Error('flood'));
    await service.flush();
    expect(writes()).toBe(3);
    expect(occurrences()).toBe(200);

    // Throttled repeats are DEFERRED, not lost — and the deferral is bounded:
    // whether or not the error ever recurs, its occurrences are written.
    clock = 1000;
    service.captureError(new Error('flood'));
    await service.flush();
    expect(writes()).toBe(4);
    expect(occurrences()).toBe(201);
  });

  it('writes the deferred occurrences of a burst that never recurs', async () => {
    // The deferral contract says `occurrence_count` converges on the truth "a
    // window late at worst". For an error that stops — a one-off storm, a
    // provider that was then fixed — that used to mean never: the pending count
    // sat in memory waiting for a repeat that no longer came.
    const { repo, occurrences, fingerprints } = fakeRepo();
    let clock = 0;
    const service = createProblemService({
      repo,
      now: () => clock,
      maxWritesPerWindow: 5,
      windowMs: 1000,
    });

    for (let i = 0; i < 50; i += 1) service.captureError(new Error('one-off storm'));
    await service.flush();

    expect(fingerprints()).toBe(1);
    expect(occurrences()).toBe(50);

    // A later window with nothing new adds nothing — the drain is not a leak of
    // its own, and the count does not drift upward on every roll.
    clock = 10_000;
    await service.list({ limit: 25 });
    await service.flush();
    expect(occurrences()).toBe(50);
  });

  it('stamps a drained occurrence with when it happened, not when it drained', async () => {
    // A drain runs at the window roll — up to a whole window after the
    // occurrences it writes. Stamping the drain's own clock made every deferred
    // occurrence look like a fresh sighting, which is what reopened problems an
    // admin had resolved in the meantime and pushed `last_seen_at` past the
    // last real one (#1847).
    const { repo, upserts } = fakeRepo();
    let clock = 1_000_000;
    const service = createProblemService({
      repo,
      now: () => clock,
      windowMs: 60_000,
      maxRepeatWritesPerFingerprint: 1,
    });

    service.captureError(new Error('flood')); // the insert
    service.captureError(new Error('flood')); // the one folded bump
    clock = 1_005_000;
    service.captureError(new Error('flood')); // throttled → deferred
    clock = 1_009_000;
    service.captureError(new Error('flood')); // throttled → deferred
    clock = 1_070_000; // a window later: the roll drains
    await service.list({ limit: 25 });
    await service.flush();

    const writes = upserts();
    expect(writes).toHaveLength(3);
    expect(writes[0]!.seenAt.getTime()).toBe(1_000_000);
    expect(writes[1]!.seenAt.getTime()).toBe(1_000_000);
    // Both deferred occurrences ride the drain, dated by the NEWEST of them —
    // never by the drain's own clock (1_070_000).
    expect(writes[2]!.occurrences).toBe(2);
    expect(writes[2]!.seenAt.getTime()).toBe(1_009_000);
  });

  it('releases its tracking map every window, so new fingerprints stay welcome', async () => {
    // Entries carrying deferred occurrences used to survive every roll, so one
    // burst per fingerprint permanently retained an entry: at capacity the cap
    // began refusing EVERY new fingerprint with `tracking-capacity`, and the
    // Problems page went quiet for genuinely new errors until a restart.
    const { repo, occurrences } = fakeRepo();
    let clock = 0;
    const service = createProblemService({
      repo,
      now: () => clock,
      maxWritesPerWindow: MAX_TRACKED_FINGERPRINTS + 10,
      windowMs: 1000,
    });

    // Fill the map: each fingerprint bursts (write, folded bump, then throttled
    // occurrences it never comes back for) and is never seen again. Labelled in
    // LETTERS — the fold key normalizes digits away, so numbered messages would
    // all be one fingerprint.
    for (let i = 0; i < MAX_TRACKED_FINGERPRINTS; i += 1) {
      const label = letterLabel(i);
      for (let burst = 0; burst < 3; burst += 1) service.captureError(new Error(`burst ${label}`));
    }
    await service.flush();
    expect(service.droppedCaptures()).toBe(0);
    expect(occurrences()).toBe(MAX_TRACKED_FINGERPRINTS * 3);

    // Next window: the map has been drained and released, so something new is
    // still accepted rather than refused for capacity.
    clock = 1000;
    service.captureError(new Error('a genuinely new 500 after the storm'));
    await service.flush();
    expect(service.droppedCaptures()).toBe(0);
    expect(occurrences()).toBe(MAX_TRACKED_FINGERPRINTS * 3 + 1);
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

  it('folds a sustained worker-error storm so a dead Redis cannot flood the table', async () => {
    const { repo, writes, occurrences, fingerprints } = fakeRepo();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const service = createProblemService({ repo, now: () => 0, windowMs: 60_000 });

    // One outage, hundreds of emitted `error` events — through the real worker
    // listener body, so the wiring is what is under test, not just the cap.
    for (let i = 0; i < 500; i += 1) {
      handleWorkerError({
        queue: 'market.refresh',
        err: new Error('connect ECONNREFUSED 127.0.0.1:6379'),
        logger: logger as never,
        onWorkerError: (err, meta) => service.captureWorkerError(err, meta),
      });
    }
    await service.flush();

    expect(fingerprints()).toBe(1);
    // Two in-window writes plus the flush drain that carries what they deferred.
    expect(writes()).toBeLessThanOrEqual(3);
    // Folded, not refused, and not under-counted: every event is on the row.
    expect(occurrences()).toBe(500);
    expect(service.droppedCaptures()).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(500);
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

  it('publishes the current window’s drops on the list result, and rolls them', async () => {
    // The counted half of "never silent" needs a consumer: the log is not a
    // channel the operator reads (§16 — admin is the only management surface).
    const { repo } = fakeRepo();
    let clock = 0;
    const service = createProblemService({
      repo,
      now: () => clock,
      maxWritesPerWindow: 1,
      windowMs: 1000,
    });

    service.captureError(new Error('first distinct'));
    service.captureError(new Error('second distinct'));
    service.captureError(new Error('third distinct'));
    await service.flush();

    const during = await service.list({ limit: 25 });
    expect(during.droppedCaptures).toBe(2);
    expect(during.droppedCapturesTotal).toBe(2);

    // A later, quiet window reports zero rather than the last storm forever —
    // the window rolls on read, not only on the next capture.
    clock = 5000;
    const after = await service.list({ limit: 25 });
    expect(after.droppedCaptures).toBe(0);
    expect(after.droppedCapturesTotal).toBe(2);
    expect(service.droppedCapturesInWindow()).toBe(0);
  });
});

/**
 * The shutdown drain (§13.5 V5-P2). `captureError` issues a fire-and-forget DB
 * write, so closing the pool underneath it threw away exactly the errors that
 * PRECEDE a restart — a deploy, an OOM kill — which are the ones worth having.
 */
describe('shutdown telemetry flush', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists a problem captured immediately before SIGTERM', async () => {
    harness.ctx.problems.captureError(new Error('500 on the way down'));
    // No explicit flush: the shutdown path is the ONLY thing that drains it.
    await flushTelemetryBuffers({
      problems: harness.ctx.problems,
      usageAnalytics: harness.ctx.usageAnalytics,
    });

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe('500 on the way down');
  });

  it('runs before the API closes its DB pool', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const flushAt = source.indexOf('flushTelemetryBuffers({');
    const poolCloseAt = source.indexOf('await client.end()');
    expect(flushAt).toBeGreaterThan(-1);
    expect(poolCloseAt).toBeGreaterThan(-1);
    expect(flushAt).toBeLessThan(poolCloseAt);
  });

  it('is bounded — a wedged capture write cannot hold termination open', async () => {
    const { repo } = fakeRepo();
    const wedged: ProblemRepository = {
      ...repo,
      upsert: () => new Promise<void>(() => {}),
    };
    const warn = vi.fn();
    const service = createProblemService({ repo: wedged });
    service.captureError(new Error('never lands'));

    const started = Date.now();
    await flushTelemetryBuffers({
      problems: service,
      logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      timeoutMs: 25,
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 25 }),
      expect.stringContaining('timed out'),
    );
  });
});

/**
 * Malformed request bodies must not reach the capture at all (§13.5 V5-P2).
 * `express.json()` is mounted at the top of the chain, so a parse or limit
 * failure used to `next(err)` straight past the rate limiter to the terminal
 * handler, become a 500, and be captured — with the parser's own message, which
 * quotes the first bytes of the body. An anonymous caller could therefore mint
 * unlimited distinct rows, spend the whole per-kind budget, and blind the
 * Sentry replacement for every genuine 500 behind it.
 */
describe('malformed request bodies are client faults, never captured problems', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers truncated JSON with 400 and writes no problem row', async () => {
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .set('Content-Type', 'application/json')
      .send('{"identifier": "victim@example.com", "password": "hunter2-correct-horse');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'MALFORMED_BODY', message: 'The request body is not valid JSON.' },
    });

    await harness.ctx.problems.flush();
    expect(await harness.db.select().from(problems)).toHaveLength(0);
  });

  it('leaks no fragment of the refused body into a persisted problem', async () => {
    // Even when something else is captured in the same window, the malformed
    // body must contribute nothing: no password, no note, no username.
    await request(harness.app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .set('Content-Type', 'application/json')
      .send('{"password": "hunter2-correct-horse-battery');
    harness.ctx.problems.captureError(new Error('something genuinely broke'));
    await harness.ctx.problems.flush();

    const rows = await harness.db.select().from(problems);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('hunter2');
    expect(JSON.stringify(rows)).not.toContain('password');
  });

  it('answers a body over the global bound with 413 and writes no problem row', async () => {
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ identifier: 'a@b.test', password: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body exceeds the size limit.' },
    });

    await harness.ctx.problems.flush();
    expect(await harness.db.select().from(problems)).toHaveLength(0);
  });

  it('cannot exhaust the per-kind capture budget — a genuine 500 still lands', async () => {
    // The app.ts wiring on a throwaway router, against a deliberately tiny
    // budget: the burst that used to spend it now costs nothing at all.
    const { repo, fingerprints } = fakeRepo();
    const service = createProblemService({ repo, now: () => 0, maxWritesPerWindow: 3 });
    const app = express();
    app.use(express.json({ limit: '100kb' }));
    app.post('/thing', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/boom', () => {
      throw new Error('the genuinely new 500');
    });
    app.use(createErrorHandler(harness.ctx.logger, (err, ctx) => service.captureError(err, ctx)));

    for (let i = 0; i < 20; i += 1) {
      const res = await request(app)
        .post('/thing')
        .set('Content-Type', 'application/json')
        // A distinct attacker-chosen prefix per request: letters are not folded
        // by the fingerprint normaliser, so each used to mint its own row.
        .send(`{"a": ${'Q'.repeat(i + 1)}`);
      expect(res.status).toBe(400);
    }
    await service.flush();
    expect(fingerprints()).toBe(0);

    expect((await request(app).get('/boom')).status).toBe(500);
    await service.flush();
    expect(fingerprints()).toBe(1);
  });

  it('is metered by the general limiter like any other request', async () => {
    // The failure is deferred past `limiters.general`, so a malformed body is no
    // longer an unauthenticated, unmetered path into the process.
    const limited = await createTestApp({
      rateLimitsEnabled: true,
      env: { RATE_LIMIT_BURST_LIMIT: '4', RATE_LIMIT_BURST_WINDOW_SEC: '60' },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await request(limited.app)
        .post('/api/v1/auth/login')
        .set('X-Requested-With', 'BetterTrack')
        .set('Content-Type', 'application/json')
        .send(`{"a": ${'Q'.repeat(i + 1)}`);
      statuses.push(res.status);
    }

    expect(statuses[0]).toBe(400);
    expect(statuses).toContain(429);
    await limited.dispose();
  });
});

/**
 * Fatal process errors (§13.5 V5-P2 arc (d)). Capture was wired only where an
 * error is HANDED to us — the express error handler, the BullMQ hooks, the
 * provider breaker. An error thrown outside all of them (a rejected promise in
 * a `res.on('finish')` listener, a socket handler, an unref'd timer) took the
 * process down with NO problem row: the largest class the retired Sentry SDK
 * used to own. The registered handler is driven directly here — crashing the
 * test runner to prove it is not an option.
 */
describe('fatal process errors are captured before the process exits', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  const silentLogger = () =>
    ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) as never;

  /** A `process`-shaped fake, so nothing binds to the real runner's signals. */
  function fakeTarget() {
    const listeners = new Map<string, (err: unknown) => void>();
    return {
      target: {
        on(event: string, listener: (err: unknown) => void) {
          listeners.set(event, listener);
        },
        off(event: string) {
          listeners.delete(event);
        },
      } as never,
      bound: () => [...listeners.keys()],
    };
  }

  for (const which of ['api', 'worker'] as const) {
    for (const source of ['unhandledRejection', 'uncaughtException'] as const) {
      it(`captures an ${source} in the ${which} process, scrubbed, then exits`, async () => {
        // The worker builds its own service against the same table; the API's is
        // the one the context already wired.
        const capturing =
          which === 'api'
            ? harness.ctx.problems
            : createProblemService({ repo: createProblemRepository(harness.db) });
        const fake = fakeTarget();
        const exits: number[] = [];
        const capture = registerProcessErrorCapture({
          problems: capturing,
          logger: silentLogger(),
          process: which,
          target: fake.target,
          exit: (code) => exits.push(code),
        });

        // Both signals are bound — an unhandled rejection is fatal in node ≥ 15
        // exactly like an uncaught exception, so both must leave a row.
        expect(fake.bound()).toEqual(['unhandledRejection', 'uncaughtException']);

        await capture.handle(source, new Error(`fatal ${source} for alice@example.com`));
        await capturing.flush();
        capture.unregister();

        const rows = await harness.db.select().from(problems);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.kind).toBe('error');
        // PII-scrubbed like every other capture, and the row says WHERE it came
        // from — a crash row that names neither process nor signal is a riddle.
        expect(row.message).toBe(`fatal ${source} for [redacted-email]`);
        expect(row.context).toMatchObject({ process: which, source });
        // Still fatal: the process dies the way it did before, one row richer.
        expect(exits).toEqual([1]);
      });
    }
  }

  it('is registered by both long-running entrypoints', () => {
    const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../scripts/worker.ts', import.meta.url), 'utf8');
    expect(server).toContain('registerProcessErrorCapture({');
    expect(worker).toContain('registerProcessErrorCapture({');
  });
});
