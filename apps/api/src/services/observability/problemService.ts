import { createHash } from 'node:crypto';

import type { ProblemRepository } from '../../data/repositories/problemRepository';
import type { ProblemRow } from '../../data/schema';
import type { Logger } from '../../logger';
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
 * row. Occurrences fold by fingerprint (kind + normalized title + message), and
 * writes are **rate-capped** to a fixed budget per window so a storm of
 * identical errors can never unbounded-write to the DB.
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
}

export interface ProblemService {
  /** Capture an unhandled error (the `createErrorHandler` report seam). */
  captureError(err: unknown, context?: ProblemCaptureContext): void;
  /** Capture a permanently-failed BullMQ job. */
  captureJobFailure(err: unknown, meta: { queue: string; jobId?: string }): void;
  /** Capture a provider failure (a circuit breaker tripping open). */
  captureProviderFailure(err: unknown, meta: { providerId?: string }): void;
  /** Await any in-flight capture writes (tests / graceful shutdown). */
  flush(): Promise<void>;
  list(params: ListProblemsParams): Promise<{ problems: ProblemRow[]; openCount: number }>;
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
  /** Max DB capture-writes per {@link windowMs}. Defaults to 60. */
  maxWritesPerWindow?: number;
  /** Rate-cap window length in ms. Defaults to 60_000 (a minute). */
  windowMs?: number;
}

const DEFAULT_MAX_WRITES_PER_WINDOW = 60;
const DEFAULT_WINDOW_MS = 60_000;

/** Collapse a message so trivial variants (ids, whitespace) fold together. */
function normalizeForFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '#') // uuids / hashes / long hex
    .replace(/\d+/g, '#') // any remaining numbers
    .replace(/\s+/g, ' ')
    .trim();
}

function fingerprintOf(kind: ProblemRow['kind'], title: string, message: string): string {
  const basis = `${kind}\n${normalizeForFingerprint(title)}\n${normalizeForFingerprint(message)}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

/** Pull a stable `{ name, message }` out of any thrown value. */
function describeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name || 'Error', message: err.message || '' };
  }
  if (typeof err === 'string') return { name: 'Error', message: err };
  return { name: 'Error', message: '' };
}

export function createProblemService(deps: ProblemServiceDeps): ProblemService {
  const { repo, audit, logger } = deps;
  const now = deps.now ?? Date.now;
  const maxWrites = deps.maxWritesPerWindow ?? DEFAULT_MAX_WRITES_PER_WINDOW;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;

  // Fixed-window rate cap across ALL fingerprints: the storm guard. Once the
  // budget for the current window is spent, further captures are dropped (never
  // written) until the window rolls over — so N identical errors cost at most
  // `maxWrites` DB writes, not N.
  let windowStart = now();
  let writesInWindow = 0;
  const inflight = new Set<Promise<unknown>>();

  const allowWrite = (): boolean => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      writesInWindow = 0;
    }
    if (writesInWindow >= maxWrites) return false;
    writesInWindow += 1;
    return true;
  };

  const capture = (
    kind: ProblemRow['kind'],
    rawTitle: string,
    rawMessage: string,
    context: ProblemCaptureContext | null,
  ): void => {
    if (!allowWrite()) return;
    const title = redactString(rawTitle);
    const message = redactString(rawMessage);
    const scrubbedContext = context ? (scrubEvent(context) as unknown) : null;
    const fingerprint = fingerprintOf(kind, rawTitle, rawMessage);

    const write = repo
      .upsert({
        fingerprint,
        kind,
        title,
        message,
        context: scrubbedContext,
        seenAt: new Date(now()),
        occurrences: 1,
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
      const { name, message } = describeError(err);
      capture('error', name, message, context ?? null);
    },

    captureJobFailure(err, meta) {
      const { message } = describeError(err);
      capture('job', `${meta.queue} job failed`, message, {
        queue: meta.queue,
        ...(meta.jobId ? { jobId: meta.jobId } : {}),
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

    async list(params) {
      const [problems, openCount] = await Promise.all([
        repo.list({ kind: params.kind, status: params.status, limit: params.limit }),
        repo.countByStatus('open'),
      ]);
      return { problems, openCount };
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
