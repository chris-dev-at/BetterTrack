import { createHash } from 'node:crypto';

import type { RequestHandler, Response } from 'express';

import {
  IDEMPOTENCY_ERROR_CODES,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
} from '@bettertrack/contracts';

import { badRequest, conflict } from '../../errors';
import type {
  IdempotencyKeyRepository,
  IdempotencyRecord,
} from '../../data/repositories/idempotencyKeyRepository';
import type { Logger } from '../../logger';
import type { AppContext } from '../context';

/**
 * Idempotency keys on portfolio mutation endpoints (PROJECTPLAN.md §13.4 V4-P2a,
 * #417) — a reusable, opt-in HTTP middleware, applied to the mutation routes
 * rather than copy-pasted per handler. The backbone for the mobile app's offline
 * FIFO queue: a client MAY send an `Idempotency-Key` (a UUID); the first request
 * under `(user, key)` runs the mutation and its response is memoized, and any
 * duplicate replays that stored response verbatim instead of repeating the side
 * effect. A request WITHOUT the header behaves exactly as before, so the web SPA
 * is unaffected.
 *
 * Both auth paths resolve to the same per-user key space: it keys on
 * `req.authUser.id`, which the cookie-session and bearer middlewares both set,
 * so a personal API key and a cookie session share one user's keys.
 */

/** Keys are replayable for ≥ 48 h, then lazily purged on the next write (§13.4). */
export const IDEMPOTENCY_RETENTION_MS = 48 * 60 * 60 * 1000;
/** How long a duplicate waits for an in-flight peer to settle before giving up (409). */
const CLAIM_WAIT_MS = 10_000;
/** Poll cadence while waiting for an in-flight peer. */
const CLAIM_POLL_MS = 25;

/** 2xx responses are memoized + replayed; anything else releases the claim. */
const isSuccess = (status: number): boolean => status >= 200 && status < 300;

export interface IdempotencyOptions {
  /** Retention window in ms (default 48 h). Below it a key replays; past it it is reusable. */
  retentionMs?: number;
  /** Max wait for an in-flight peer before a 409 (default 10 s). */
  waitMs?: number;
  /** Poll cadence while waiting (default 25 ms). */
  pollMs?: number;
  /** Injectable clock (ms) for retention tests. */
  now?: () => number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stable, order-independent JSON of a value — the request-body hash input, so a
 * retry that re-serializes the same body with reordered keys still matches
 * (a genuinely different body changes the hash → 409).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function hashBody(body: unknown): string {
  return createHash('sha256')
    .update(stableStringify(body ?? null))
    .digest('base64url');
}

/** Replay a memoized response byte-for-byte onto a fresh duplicate request. */
function replay(res: Response, record: IdempotencyRecord): void {
  res.status(record.statusCode ?? 200);
  if (record.contentType) res.setHeader('Content-Type', record.contentType);
  if (record.responseBody && record.responseBody.length > 0) {
    res.send(record.responseBody);
  } else {
    res.end();
  }
}

/**
 * Wrap the winning request's response so the exact bytes + status it sends are
 * captured and, once the response finishes, memoized (2xx) or released (non-2xx).
 * Express funnels `res.json` through `res.send`, so wrapping `res.send` captures
 * both the JSON handlers and the empty 204 `send()`.
 */
function captureAndPersist(
  res: Response,
  repo: IdempotencyKeyRepository,
  logger: Logger,
  id: string,
): void {
  const originalSend = res.send.bind(res);
  let captured = '';
  let sawSend = false;
  res.send = ((body?: unknown) => {
    if (!sawSend) {
      sawSend = true;
      captured =
        typeof body === 'string'
          ? body
          : body === undefined || body === null
            ? ''
            : Buffer.isBuffer(body)
              ? body.toString('utf8')
              : JSON.stringify(body);
    }
    return originalSend(body);
  }) as typeof res.send;

  res.on('finish', () => {
    const statusCode = res.statusCode;
    const ct = res.getHeader('content-type');
    const contentType = typeof ct === 'string' ? ct : null;
    const persist = isSuccess(statusCode)
      ? repo.complete(id, { statusCode, responseBody: captured, contentType })
      : repo.release(id);
    void persist.catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown', id },
        'idempotency response persist failed',
      ),
    );
  });
}

/**
 * Build the idempotency middleware bound to the app context. Mount it on a
 * mutation route AFTER the auth guard (so `req.authUser` is set) — e.g.
 * `router.post(path, validateParams(...), idempotency, validateBody(...), handler)`.
 */
export function createIdempotency(
  ctx: AppContext,
  options: IdempotencyOptions = {},
): RequestHandler {
  const repo = ctx.idempotency;
  const { logger } = ctx;
  const retentionMs = options.retentionMs ?? IDEMPOTENCY_RETENTION_MS;
  const waitMs = options.waitMs ?? CLAIM_WAIT_MS;
  const pollMs = options.pollMs ?? CLAIM_POLL_MS;
  const now = options.now ?? ((): number => Date.now());

  return (req, res, next) => {
    const raw = req.get(IDEMPOTENCY_KEY_HEADER);
    // Opt-in: no header → behave exactly as before.
    if (raw === undefined) {
      next();
      return;
    }
    const parsed = idempotencyKeySchema.safeParse(raw);
    if (!parsed.success) {
      next(
        badRequest(
          'The Idempotency-Key header must be a UUID.',
          IDEMPOTENCY_ERROR_CODES.invalidKey,
        ),
      );
      return;
    }
    // Mounted after the user guard, so authUser is present; skip defensively otherwise.
    const userId = req.authUser?.id;
    if (!userId) {
      next();
      return;
    }

    const input = {
      userId,
      key: parsed.data,
      method: req.method,
      // The concrete path (with ids) is the endpoint fingerprint, so the same key
      // on a different endpoint/resource is a mismatch, not a replay.
      path: req.baseUrl + req.path,
      requestHash: hashBody(req.body),
    };

    void (async (): Promise<void> => {
      const deadline = now() + waitMs;
      // Claim; if a peer holds an in-flight row, wait for it to settle. The unique
      // (user, key) index guarantees exactly one winner across concurrent racers.
      for (;;) {
        const cutoff = new Date(now() - retentionMs);
        const outcome = await repo.claim(input, cutoff);
        if (outcome.won) {
          captureAndPersist(res, repo, logger, outcome.id);
          next();
          return;
        }
        const { record } = outcome;
        if (!record) continue; // vanished between conflict + read → re-claim
        if (
          record.method !== input.method ||
          record.path !== input.path ||
          record.requestHash !== input.requestHash
        ) {
          next(
            conflict(
              'This Idempotency-Key was already used for a different request.',
              IDEMPOTENCY_ERROR_CODES.mismatch,
            ),
          );
          return;
        }
        if (record.statusCode !== null) {
          replay(res, record);
          return;
        }
        // Peer still in flight: wait, then re-check (it may complete or release).
        if (now() >= deadline) {
          next(
            conflict(
              'A request with this Idempotency-Key is still being processed.',
              IDEMPOTENCY_ERROR_CODES.inProgress,
            ),
          );
          return;
        }
        await sleep(pollMs);
      }
    })().catch(next);
  };
}
