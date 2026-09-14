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

import {
  boundScrubInput,
  redactIdentifiers,
  redactString,
  scrubEvent,
  type ScrubbableValue,
} from './scrubber';

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
 * the fingerprint's next write — or, when it never recurs, into the drain the
 * window roll and {@link ProblemService.flush} perform — rather than losing
 * them, and an actual drop is logged and counted
 * ({@link ProblemService.droppedCaptures}), never silent.
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
  /**
   * Captures the rate cap refused in the CURRENT window (0 when none) — this
   * process PLUS the peer process (the worker), when a peer tally is wired.
   */
  droppedCaptures: number;
  /** Captures the rate cap refused since boot, this process plus the peer. */
  droppedCapturesTotal: number;
}

/** A cross-process drop tally, as read by the process that publishes it. */
export interface ProblemDropCounters {
  /** Drops the peer refused in its trailing window. */
  inWindow: number;
  /** Drops the peer refused over the tally's retention. */
  total: number;
}

export interface ProblemCaptureOptions {
  /**
   * How many occurrences this ONE call folds in (≥ 1, default 1). For a caller
   * that already aggregated — the mirror consistency sweep, which finds N
   * identical residuals in one pass — reporting them as N calls would either
   * spend N of the window's write budget on distinct fingerprints or, once the
   * message is id-free, cost N pointless round trips to say the same thing.
   * This says it once, with the true count. It does NOT widen the write budget:
   * the capture still spends exactly one fingerprint's write.
   */
  occurrences?: number;
}

export interface ProblemService {
  /** Capture an unhandled error (the `createErrorHandler` report seam). */
  captureError(
    err: unknown,
    context?: ProblemCaptureContext,
    options?: ProblemCaptureOptions,
  ): void;
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
   * Captures the rate cap refused to write in THIS process, since boot. A drop
   * is never silent: it lands here AND in the log, so "the page shows nothing"
   * can always be told apart from "nothing happened". The admin list adds the
   * peer process's tally on top (see {@link ProblemServiceDeps.peerDrops}) —
   * these two accessors stay process-local because they are synchronous.
   */
  droppedCaptures(): number;
  /**
   * The same counter for the CURRENT cap window. Rolls the window lazily, so a
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
   * Defaults to 1 (so a storm of one error costs 2 writes a window, not N —
   * plus at most one drain write when the window closes).
   */
  maxRepeatWritesPerFingerprint?: number;
  /**
   * Notified for every refused capture. The WORKER passes the shared drop tally
   * here so its refusals reach the admin surface: every `kind: 'job'` capture
   * happens in the worker process, whose in-memory counters the admin API can
   * never see, and a page reporting `droppedCaptures: 0` during a worker drop
   * storm is exactly the silent drop {@link ProblemService.droppedCaptures}
   * promises cannot happen.
   */
  onDrop?: (kind: ProblemRow['kind'], reason: DropReason) => void;
  /**
   * Reads the PEER process's drop tally, merged into {@link ProblemService.list}.
   * The API passes the shared tally's reader; the worker leaves it unset (it
   * publishes nothing). Never throws through: a tally read failure degrades to
   * this process's own counters.
   */
  peerDrops?: () => Promise<ProblemDropCounters>;
}

/** Why a capture was refused — a bounded metric/label vocabulary. */
export type DropReason = 'kind-budget' | 'tracking-capacity';

const DEFAULT_MAX_WRITES_PER_WINDOW = 60;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REPEAT_WRITES = 1;

/**
 * Ceiling on fingerprints tracked at once, WITHIN one window: the roll drains
 * every deferred occurrence and then empties the map, so nothing an old window
 * learnt can occupy the next one's capacity. Without that, one burst per
 * fingerprint was enough to retain an entry forever, and a long-lived process
 * eventually refused every genuinely new error with `tracking-capacity`.
 */
export const MAX_TRACKED_FINGERPRINTS = 5_000;

/** What a drain needs to write the occurrences a fingerprint deferred. */
interface DeferredWrite {
  kind: ProblemRow['kind'];
  title: string;
  message: string;
  /** Already scrubbed AND bounded — captured once, on the first throttle. */
  context: unknown;
  /**
   * When the LAST deferred occurrence actually happened (#1847). A drain runs
   * at window roll — up to a whole window later — and the row's reopen rule
   * compares the incoming sighting against `resolved_at`. Stamping the drain's
   * own clock therefore re-opened a problem an admin had resolved DURING the
   * window out of occurrences that all predate the resolution, flagged it as a
   * regression and pushed `last_seen_at` past the last real sighting.
   */
  occurredAt: number;
}

/** Per-fingerprint budget state inside the current window. */
interface FingerprintState {
  /** Writes this fingerprint has issued in the current window. */
  writes: number;
  /**
   * Occurrences observed while throttled. They are NOT lost: the next allowed
   * write for this fingerprint folds them in, and if there is no next one they
   * are drained when the window closes (or on {@link ProblemService.flush}), so
   * `occurrence_count` converges on the truth even for an error that stops.
   */
  pending: number;
  /** The row those pending occurrences belong to; null until first throttled. */
  deferred: DeferredWrite | null;
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
 * Trim a stack to its first frames, each bounded to what the scrubber reads.
 *
 * The byte ceiling is applied later, with everything else in the context, by
 * {@link boundProblemContext} — but a stack that is bounded only by bytes is cut
 * mid-frame, and the frames worth having are the first ones.
 *
 * The per-LINE bound is the one the scrubber needs (#1853). Capping frames caps
 * nothing about their length, and a V8 `Error.stack`'s first line is the message
 * verbatim — so a megabyte thrown message arrives here in full even though
 * `capture` already bounded its own copy of it, and {@link captureStack} then
 * hands all of it to the value rules on the API's single event loop. That is the
 * one input on this path nothing bounded.
 *
 * Bounding per line rather than the joined stack costs nothing and keeps the
 * frames independent of the message: a frame is never near the ceiling, so only
 * an oversized first line is ever cut, and the frames behind it stay addressable
 * up to the byte ceiling. Nothing DIAGNOSTIC is lost that was not already going:
 * `boundProblemContext` holds the stored stack to
 * `PROBLEM_CONTEXT_VALUE_MAX_BYTES`, four times below this ceiling, so a message
 * long enough to reach the cut had already crowded the frames out by bytes.
 */
function boundStack(stack: string): string {
  const lines = stack.split('\n', MAX_STACK_FRAMES + 1).map(boundScrubInput);
  if (lines.length <= MAX_STACK_FRAMES) return lines.join('\n');
  return `${lines.slice(0, MAX_STACK_FRAMES).join('\n')}\n…`;
}

/**
 * The stack as it is stored: bounded, and with object ids dropped (#1847).
 *
 * A stack's first line repeats the message verbatim, so storing it raw put back
 * exactly the id {@link redactIdentifiers} had just taken out of the title and
 * the message. Applied HERE and not to the whole context tree, because the
 * other captured fields — `requestId`, a BullMQ `jobId` — are our own handles,
 * and redacting them costs the operator the correlation they exist for.
 */
function captureStack(stack: string): string {
  return redactIdentifiers(boundStack(stack));
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

  /**
   * Issue one upsert, tracked so {@link ProblemService.flush} can await it.
   * `seenAt` is when the occurrences HAPPENED, never when the write was issued
   * — see {@link DeferredWrite.occurredAt}.
   */
  const enqueueWrite = (
    fingerprint: string,
    kind: ProblemRow['kind'],
    title: string,
    message: string,
    context: unknown,
    occurrences: number,
    seenAt: number,
  ): void => {
    const write = repo
      .upsert({ fingerprint, kind, title, message, context, seenAt: new Date(seenAt), occurrences })
      .catch((writeErr: unknown) => {
        logger?.error({ err: writeErr, kind }, 'failed to persist captured problem');
      });
    // Track so `flush()` can await; self-remove on settle to bound the set.
    inflight.add(write);
    void write.finally(() => inflight.delete(write));
  };

  /**
   * Write out every deferred occurrence. Deferral is a promise that the count
   * arrives late, not that it arrives only if the error happens again: a burst
   * that stops (a one-off storm, a provider that was fixed) would otherwise
   * leave its occurrences in memory forever, so the stored `occurrence_count`
   * silently under-reported the incident. Costs at most one write per
   * fingerprint that was actually throttled.
   *
   * The write is stamped with the deferred occurrences' OWN time, not the
   * drain's: a late write is a late report of something that already happened,
   * and the row's reopen rule reads `seenAt` as "when this recurred" (#1847).
   */
  const drainPending = (): void => {
    for (const [fingerprint, state] of tracked) {
      const deferred = state.deferred;
      if (state.pending > 0 && deferred !== null) {
        enqueueWrite(
          fingerprint,
          deferred.kind,
          deferred.title,
          deferred.message,
          deferred.context,
          state.pending,
          deferred.occurredAt,
        );
      }
      state.pending = 0;
      state.deferred = null;
    }
  };

  const rollWindow = (t: number): void => {
    if (t - windowStart < windowMs) return;
    windowStart = t;
    writesByKind.clear();
    // Drain first, then forget everything: an entry is a WINDOW's budget state,
    // so carrying it (which is what keeping `pending > 0` entries did) let one
    // burst per fingerprint fill the tracking map for the life of the process
    // and turn the cap into a permanent mute for new errors.
    drainPending();
    tracked.clear();
    if (droppedInWindow > 0) {
      logger?.warn(
        { dropped: droppedInWindow, droppedTotal },
        'problem captures dropped by the rate cap in the closed window',
      );
      droppedInWindow = 0;
    }
    loggedDropInWindow = false;
  };

  const drop = (kind: ProblemRow['kind'], reason: DropReason): void => {
    droppedTotal += 1;
    droppedInWindow += 1;
    problemCapturesDroppedTotal.inc({ kind, reason });
    // Publish to the cross-process tally BEFORE the log line's once-a-window
    // guard: the admin surface is the only management surface, so a worker drop
    // that only reaches this process's log has still gone unreported.
    deps.onDrop?.(kind, reason);
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
    observedRaw = 1,
  ): void => {
    // A caller-supplied count is folded in, never trusted blindly.
    const observed = Number.isFinite(observedRaw) ? Math.max(1, Math.trunc(observedRaw)) : 1;
    // Scrub, THEN cap: the scrubber must see the string it will keep (a token
    // cut in half matches nothing), and `problems.title`/`.message` are
    // unbounded `text` that the admin page renders, so nothing else keeps a
    // pathological message from becoming the row. The byte ceiling behind the
    // char cap is what a multi-byte payload (an upstream HTML error page) is
    // actually held to — the write budget counts rows per minute and never
    // bytes.
    // What the scrubber READS is bounded first, though: a thrown provider
    // message carries whatever the upstream sent, capture runs on the API's
    // single event loop, and every character past `boundScrubInput`'s ceiling
    // is discarded by the caps below anyway — so reading it was pure cost
    // (#1853). That bound cuts at a separator, so it cannot hand the scrubber
    // half a credential and call the other half gone.
    // `redactIdentifiers`, not `redactString`: the ops cockpit already strips a
    // UUID out of the very same failure text, so capturing it raw made the two
    // surfaces disagree about one string and put a user's object id on the
    // Problems page (#1847). The fold key is unaffected —
    // `normalizeForFingerprint` collapses long hex either way.
    const title = boundProblemTitle(
      truncateErrorMessage(redactIdentifiers(boundScrubInput(rawTitle))),
    );
    const message = boundProblemMessage(
      truncateErrorMessage(redactIdentifiers(boundScrubInput(rawMessage))),
    );
    // Fold on the SCRUBBED pair: the raw strings carry per-user PII (emails,
    // token bodies) that the stored row does not, so fingerprinting them would
    // split one visible problem into a row per user.
    const fingerprint = fingerprintOf(kind, title, message, discriminator);

    const at = now();
    rollWindow(at);
    const state = tracked.get(fingerprint);
    let occurrences = observed;
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
      tracked.set(fingerprint, { writes: 1, pending: 0, deferred: null });
    } else if (state.writes <= maxRepeatWrites) {
      state.writes += 1;
      occurrences = observed + state.pending;
      state.pending = 0;
      state.deferred = null;
    } else {
      // Throttled, not dropped: the occurrences ride along with this
      // fingerprint's next write, or with the drain that closes the window if
      // there is no next one — so no count is lost either way. The row those
      // occurrences belong to is remembered ONCE (the storm's remaining
      // captures stay a counter bump), because the drain has to name a row and
      // `upsert` refreshes title/message/context from what it is handed.
      state.pending += observed;
      if (state.deferred === null) {
        state.deferred = {
          kind,
          title,
          message,
          context: context ? boundProblemContext(scrubEvent(context) as unknown) : null,
          occurredAt: at,
        };
      } else {
        // The row is remembered once, but WHEN it last happened is not: the
        // drain must report the newest deferred sighting, never the first.
        state.deferred.occurredAt = at;
      }
      return;
    }

    // Scrub first (the whole tree, so no half-token survives), bound second.
    const scrubbedContext = context ? boundProblemContext(scrubEvent(context) as unknown) : null;

    enqueueWrite(fingerprint, kind, title, message, scrubbedContext, occurrences, at);
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
    captureError(err, context, options) {
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
        stack === null ? (context ?? null) : { ...context, stack: captureStack(stack) };
      capture('error', name, message, withStack, discriminator, options?.occurrences);
    },

    captureJobFailure(err, meta) {
      const { message, stack } = describeError(err);
      capture('job', `${meta.queue} job failed`, message, {
        queue: meta.queue,
        ...(meta.jobId ? { jobId: meta.jobId } : {}),
        // The same bounded stack the request path stores (#1847): a
        // permanently-failed job is the capture an operator can least often
        // reproduce, and its row used to carry no call path at all.
        ...(stack === null ? {} : { stack: captureStack(stack) }),
      });
    },

    captureWorkerError(err, meta) {
      const { message, stack } = describeError(err);
      capture('job', `${meta.queue} worker error`, message, {
        queue: meta.queue,
        scope: 'worker',
        ...(stack === null ? {} : { stack: captureStack(stack) }),
      });
    },

    captureProviderFailure(err, meta) {
      const { message, stack } = describeError(err);
      const providerId = meta.providerId ?? 'provider';
      capture('provider', `${providerId} provider failure`, message, {
        providerId,
        ...(stack === null ? {} : { stack: captureStack(stack) }),
      });
    },

    async flush() {
      // Deferred occurrences are part of "everything captured so far", so the
      // shutdown drain (and a test's flush) must write them out rather than
      // await only the writes that already happened.
      drainPending();
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
      // The peer (worker) process holds its own in-memory counters, and every
      // `kind: 'job'` capture is refused THERE — so publishing only this
      // process's tally reported a worker drop storm as `droppedCaptures: 0`.
      const peer = await (deps.peerDrops?.().catch((err: unknown) => {
        logger?.warn({ err }, 'failed to read the peer problem-drop tally');
        return null;
      }) ?? Promise.resolve(null));
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
        droppedCaptures: droppedInWindow + (peer?.inWindow ?? 0),
        droppedCapturesTotal: droppedTotal + (peer?.total ?? 0),
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
