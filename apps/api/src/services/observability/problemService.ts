import { createHash } from 'node:crypto';

import { driverError, truncateErrorMessage } from '../../data/driverError';
import {
  boundProblemContext,
  boundProblemMessage,
  boundProblemTitle,
  type ProblemRepository,
} from '../../data/repositories/problemRepository';
import type { ProblemRow } from '../../data/schema';
import type { Logger } from '../../logger';
import { problemCapturesDroppedTotal } from '../../metrics';
import { AuditAction, type AuditService } from '../audit/auditService';

import { redactString, scrubEvent, type ScrubbableValue } from './scrubber';

/**
 * DB-backed problem capture — the Sentry replacement (PROJECTPLAN.md §13.5
 * V5-P2 arc (d), §16 2026-07-17 "Sentry is OUT — permanently").
 *
 * Captures unhandled request errors, permanently-failed jobs and provider
 * failures into the `problems` table with **zero configuration** (no DSN, no
 * env): it plugs into the same error/observability seam the (env-dark) Sentry
 * SDK does. Every stored string is passed through the pure {@link scrubEvent} /
 * {@link redactString} scrubber first, so no email/token/cookie ever lands in a
 * row, and every stored value is cut to a documented BYTE ceiling (the write
 * budget counts rows per minute, never bytes). Occurrences fold by fingerprint
 * (kind + normalized title + message, both taken AFTER scrubbing so the fold key
 * matches what is stored and shown, plus the request's method/route/status when
 * there was one — without it two unrelated endpoints throwing the same
 * `TypeError` become a single row that identifies neither), and
 * writes are **rate-capped** so a storm of identical errors can never
 * unbounded-write to the DB. The cap is charged per KIND and only for a
 * fingerprint's first write in a window, so a flapping provider cannot starve a
 * genuinely new unhandled error; throttled repeats defer their occurrences into
 * the next write rather than losing them, and an actual drop is logged and
 * counted ({@link ProblemService.droppedCaptures}), never silent.
 *
 * The same object exposes the admin read/resolve side (list/get/resolve/reopen,
 * audit-logged) behind `/admin/problems`.
 */
export interface ProblemCaptureContext {
  [key: string]: ScrubbableValue;
}

export interface ProblemAdminActor {
  id: string;
  ip?: string | null;
}

export interface ListProblemsParams {
  kind?: ProblemRow['kind'];
  status?: ProblemRow['status'];
  limit: number;
  /** Rows to skip in `lastSeenAt desc` order. Defaults to 0. */
  offset?: number;
}

export interface ListProblemsResult {
  problems: ProblemRow[];
  /** Open problems regardless of the filter — the admin nav badge source. */
  openCount: number;
  /** Rows matching the filter, ignoring limit/offset. */
  total: number;
  /** Whether a further page exists past this one. */
  hasMore: boolean;
  /** Captures the rate cap refused in the CURRENT window (0 when none). */
  droppedCaptures: number;
  /** Captures the rate cap refused since boot. */
  droppedCapturesTotal: number;
}

export interface ProblemService {
  /** Capture an unhandled error (the `createErrorHandler` report seam). */
  captureError(err: unknown, context?: ProblemCaptureContext): void;
  /** Capture a permanently-failed BullMQ job. */
  captureJobFailure(err: unknown, meta: { queue: string; jobId?: string }): void;
  /**
   * Capture a WORKER-scoped BullMQ error — a failure of the job system itself
   * (Redis link down, lock extension, deserialization) that never becomes a
   * per-job `failed` event, so {@link ProblemService.captureJobFailure} would
   * name a job that does not exist. Same kind (`job`) so the admin's job filter
   * shows it; the title says worker, not job.
   */
  captureWorkerError(err: unknown, meta: { queue: string }): void;
  /** Capture a provider failure (a circuit breaker tripping open). */
  captureProviderFailure(err: unknown, meta: { providerId?: string }): void;
  /** Await any in-flight capture writes (tests / graceful shutdown). */
  flush(): Promise<void>;
  /**
   * Captures the rate cap refused to write, since boot. A drop is never silent:
   * it lands here AND in the log, so "the page shows nothing" can always be told
   * apart from "nothing happened".
   */
  droppedCaptures(): number;
  /**
   * The same counter for the CURRENT cap window — what the admin list
   * publishes, because "60 rows, 140 refused" and "60 rows" are different
   * incidents and only this tells them apart. Rolls the window lazily, so a
   * quiet period reports 0 rather than the last storm's tally forever.
   */
  droppedCapturesInWindow(): number;
  list(params: ListProblemsParams): Promise<ListProblemsResult>;
  get(id: string): Promise<ProblemRow | null>;
  /** Mark a problem resolved (audit-logged). Null when the id is unknown. */
  resolve(id: string, actor: ProblemAdminActor): Promise<ProblemRow | null>;
  /** Reopen a resolved problem (audit-logged). Null when the id is unknown. */
  reopen(id: string, actor: ProblemAdminActor): Promise<ProblemRow | null>;
}

export interface ProblemServiceDeps {
  repo: ProblemRepository;
  /** Audit sink for resolve/reopen. Optional — the worker capture omits it. */
  audit?: AuditService;
  logger?: Logger;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Max DISTINCT problems written per kind per {@link windowMs}. Defaults to 60.
   * Per kind, so a flapping provider spends the provider budget and nothing else.
   */
  maxWritesPerWindow?: number;
  /** Rate-cap window length in ms. Defaults to 60_000 (a minute). */
  windowMs?: number;
  /**
   * Extra writes one fingerprint may spend per window on occurrence bumps.
   * Defaults to 1 (so a storm of one error costs 2 writes a window, not N).
   */
  maxRepeatWritesPerFingerprint?: number;
}

const DEFAULT_MAX_WRITES_PER_WINDOW = 60;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REPEAT_WRITES = 1;

/**
 * Ceiling on fingerprints tracked at once. Only entries carrying deferred
 * occurrences survive a window roll, so this is reached solely by a
 * high-cardinality storm — and then it is a bound, not a leak.
 */
const MAX_TRACKED_FINGERPRINTS = 5_000;

/** Per-fingerprint budget state inside the current window. */
interface FingerprintState {
  /** Writes this fingerprint has issued in the current window. */
  writes: number;
  /**
   * Occurrences observed while throttled. They are NOT lost: the next allowed
   * write for this fingerprint folds them in, so `occurrence_count` still
   * converges on the truth (a window late at worst).
   */
  pending: number;
}

/**
 * Collapse a message so trivial variants (ids, whitespace) fold together. Fed
 * the REDACTED string, never the raw one — two captures that are identical once
 * scrubbed (`no user for [redacted-email]`) must land on the same fold key.
 */
function normalizeForFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '#') // uuids / hashes / long hex
    .replace(/\d+/g, '#') // any remaining numbers
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fold key. `discriminator` is an ALREADY low-cardinality, id-free string (the
 * request's `METHOD /route/template STATUS`) and is fed in RAW: unlike a message
 * it must not pass {@link normalizeForFingerprint}, which would collapse every
 * status to `#`. Empty for the capture kinds that have no request behind them,
 * so their fold keys are byte-for-byte the ones they had before.
 */
function fingerprintOf(
  kind: ProblemRow['kind'],
  title: string,
  message: string,
  discriminator: string,
): string {
  const basis = `${kind}\n${normalizeForFingerprint(title)}\n${normalizeForFingerprint(message)}${
    discriminator === '' ? '' : `\n${discriminator}`
  }`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

/** Stack frames kept — enough to name the failing call path, not a core dump. */
const MAX_STACK_FRAMES = 20;

/**
 * Trim a stack to its first frames. The byte ceiling is applied later, with
 * everything else in the context, by {@link boundProblemContext} — but a stack
 * that is bounded only by bytes is cut mid-frame, and the frames worth having
 * are the first ones.
 */
function boundStack(stack: string): string {
  const lines = stack.split('\n');
  if (lines.length <= MAX_STACK_FRAMES) return stack;
  return `${lines.slice(0, MAX_STACK_FRAMES).join('\n')}\n…`;
}

/**
 * Pull a stable `{ name, message }` out of any thrown value.
 *
 * Unwraps drizzle's `DrizzleQueryError` first: since 0.44 its message is the
 * failing SQL plus every bound parameter, so describing it verbatim would fold
 * the row's contents — note text, asset names, amounts, a password hash, a
 * megabyte vault blob — into a `problems` row the admin page renders and the
 * scrubber (emails and `bt*_` tokens only) cannot see. The wrapped driver error
 * carries the message the page actually wants ("duplicate key value violates
 * unique constraint …"), which is exactly what this captured pre-0.44.
 */
function describeError(err: unknown): { name: string; message: string; stack: string | null } {
  const cause = driverError(err);
  if (cause instanceof Error) {
    return {
      name: cause.name || 'Error',
      message: cause.message || '',
      // The stack of the DRIVER error for the same reason its message is used:
      // drizzle's wrapper carries the SQL and its bound parameters.
      stack: typeof cause.stack === 'string' && cause.stack !== '' ? cause.stack : null,
    };
  }
  if (typeof cause === 'string') return { name: 'Error', message: cause, stack: null };
  return { name: 'Error', message: '', stack: null };
}

export function createProblemService(deps: ProblemServiceDeps): ProblemService {
  const { repo, audit, logger } = deps;
  const now = deps.now ?? Date.now;
  const maxWrites = deps.maxWritesPerWindow ?? DEFAULT_MAX_WRITES_PER_WINDOW;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRepeatWrites = deps.maxRepeatWritesPerFingerprint ?? DEFAULT_MAX_REPEAT_WRITES;

  // Fixed-window rate cap — the storm guard, charged PER KIND and only for a
  // fingerprint's first write in the window. A repeat of something already
  // known is not a new problem competing for the budget, and one flapping
  // source must never spend the headroom a genuinely new error needs.
  let windowStart = now();
  const writesByKind = new Map<ProblemRow['kind'], number>();
  const tracked = new Map<string, FingerprintState>();
  let droppedTotal = 0;
  let droppedInWindow = 0;
  let loggedDropInWindow = false;
  const inflight = new Set<Promise<unknown>>();

  const rollWindow = (t: number): void => {
    if (t - windowStart < windowMs) return;
    windowStart = t;
    writesByKind.clear();
    for (const [fingerprint, state] of tracked) {
      // Keep only what still owes occurrences; everything else is re-learnt on
      // its next sighting, which is what bounds the map over a long uptime.
      if (state.pending === 0) tracked.delete(fingerprint);
      else state.writes = 0;
    }
    if (droppedInWindow > 0) {
      logger?.warn(
        { dropped: droppedInWindow, droppedTotal },
        'problem captures dropped by the rate cap in the closed window',
      );
      droppedInWindow = 0;
    }
    loggedDropInWindow = false;
  };

  const drop = (kind: ProblemRow['kind'], reason: 'kind-budget' | 'tracking-capacity'): void => {
    droppedTotal += 1;
    droppedInWindow += 1;
    problemCapturesDroppedTotal.inc({ kind, reason });
    // One line per window, not one per drop: a storm must stay visible without
    // becoming the next flood. The rest is carried by the window summary above
    // and by `droppedCaptures()`.
    if (loggedDropInWindow) return;
    loggedDropInWindow = true;
    logger?.warn({ kind, reason, droppedTotal }, 'problem capture dropped by the rate cap');
  };

  const capture = (
    kind: ProblemRow['kind'],
    rawTitle: string,
    rawMessage: string,
    context: ProblemCaptureContext | null,
    discriminator = '',
  ): void => {
    // Scrub, THEN cap: the scrubber must see the whole string (a token cut in
    // half matches nothing), and `problems.title`/`.message` are unbounded
    // `text` that the admin page renders, so nothing else keeps a pathological
    // message from becoming the row. The byte ceiling behind the char cap is
    // what a multi-byte payload (an upstream HTML error page) is actually held
    // to — the write budget counts rows per minute and never bytes.
    const title = boundProblemTitle(truncateErrorMessage(redactString(rawTitle)));
    const message = boundProblemMessage(truncateErrorMessage(redactString(rawMessage)));
    // Fold on the SCRUBBED pair: the raw strings carry per-user PII (emails,
    // token bodies) that the stored row does not, so fingerprinting them would
    // split one visible problem into a row per user.
    const fingerprint = fingerprintOf(kind, title, message, discriminator);

    rollWindow(now());
    const state = tracked.get(fingerprint);
    let occurrences = 1;
    if (state === undefined) {
      const spent = writesByKind.get(kind) ?? 0;
      if (spent >= maxWrites) {
        drop(kind, 'kind-budget');
        return;
      }
      if (tracked.size >= MAX_TRACKED_FINGERPRINTS) {
        drop(kind, 'tracking-capacity');
        return;
      }
      writesByKind.set(kind, spent + 1);
      tracked.set(fingerprint, { writes: 1, pending: 0 });
    } else if (state.writes <= maxRepeatWrites) {
      state.writes += 1;
      occurrences = 1 + state.pending;
      state.pending = 0;
    } else {
      // Throttled, not dropped: the occurrence rides along with this
      // fingerprint's next write, so no count is lost.
      state.pending += 1;
      return;
    }

    // Scrub first (the whole tree, so no half-token survives), bound second.
    const scrubbedContext = context ? boundProblemContext(scrubEvent(context) as unknown) : null;

    const write = repo
      .upsert({
        fingerprint,
        kind,
        title,
        message,
        context: scrubbedContext,
        seenAt: new Date(now()),
        occurrences,
      })
      .catch((writeErr: unknown) => {
        logger?.error({ err: writeErr, kind }, 'failed to persist captured problem');
      });
    // Track so `flush()` can await; self-remove on settle to bound the set.
    inflight.add(write);
    void write.finally(() => inflight.delete(write));
  };

  const record = async (
    id: string,
    status: ProblemRow['status'],
    actor: ProblemAdminActor,
    action: string,
  ): Promise<ProblemRow | null> => {
    const resolvedBy = status === 'resolved' ? actor.id : null;
    const row = await repo.setStatus(id, status, resolvedBy, new Date(now()));
    if (!row) return null;
    await audit?.record({
      actorId: actor.id,
      action,
      targetType: 'problem',
      targetId: id,
      ip: actor.ip ?? null,
    });
    return row;
  };

  return {
    captureError(err, context) {
      const { name, message, stack } = describeError(err);
      // The request facts, when the caller had any, are what tells two endpoints
      // throwing the same `TypeError` apart — without them they fold into one
      // row that names neither. Read back off the context so the fold key and
      // the stored row can never disagree about which request this was.
      const method = typeof context?.method === 'string' ? context.method : null;
      const route = typeof context?.route === 'string' ? context.route : null;
      const status = typeof context?.status === 'number' ? context.status : null;
      const discriminator =
        route === null ? '' : `${method ?? ''} ${redactString(route)} ${status ?? ''}`.trim();
      const withStack: ProblemCaptureContext | null =
        stack === null ? (context ?? null) : { ...context, stack: boundStack(stack) };
      capture('error', name, message, withStack, discriminator);
    },

    captureJobFailure(err, meta) {
      const { message } = describeError(err);
      capture('job', `${meta.queue} job failed`, message, {
        queue: meta.queue,
        ...(meta.jobId ? { jobId: meta.jobId } : {}),
      });
    },

    captureWorkerError(err, meta) {
      const { message } = describeError(err);
      capture('job', `${meta.queue} worker error`, message, {
        queue: meta.queue,
        scope: 'worker',
      });
    },

    captureProviderFailure(err, meta) {
      const { message } = describeError(err);
      const providerId = meta.providerId ?? 'provider';
      capture('provider', `${providerId} provider failure`, message, { providerId });
    },

    async flush() {
      await Promise.allSettled([...inflight]);
    },

    droppedCaptures() {
      return droppedTotal;
    },

    droppedCapturesInWindow() {
      rollWindow(now());
      return droppedInWindow;
    },

    async list(params) {
      const offset = params.offset ?? 0;
      const filter = { kind: params.kind, status: params.status };
      rollWindow(now());
      const [problems, total, openCount] = await Promise.all([
        repo.list({ ...filter, limit: params.limit, offset }),
        repo.countMatching(filter),
        repo.countByStatus('open'),
      ]);
      return {
        problems,
        openCount,
        total,
        hasMore: offset + problems.length < total,
        droppedCaptures: droppedInWindow,
        droppedCapturesTotal: droppedTotal,
      };
    },

    get(id) {
      return repo.get(id);
    },

    resolve(id, actor) {
      return record(id, 'resolved', actor, AuditAction.ProblemResolved);
    },

    reopen(id, actor) {
      return record(id, 'open', actor, AuditAction.ProblemReopened);
    },
  };
}
