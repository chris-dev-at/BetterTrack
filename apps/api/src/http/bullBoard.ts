import { Router, type RequestHandler } from 'express';

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/dist/queueAdapters/bullMQ.js';
import { ExpressAdapter } from '@bull-board/express';

import { ALL_QUEUE_NAMES, type QueueRegistry } from '../jobs';

/**
 * bull-board queue inspector (PROJECTPLAN.md §13.4 V4-P5a), mounted admin-only.
 *
 * The app mounts this router at `/api/v1/admin/queues` behind the dedicated admin
 * limiter, `requireAdmin`, and the current-session MFA gate: a non-admin or
 * anonymous request 404s before reaching it (§6.12's no-information-leak rule).
 * This module serves a READ-ONLY inspector UI/API for the durable BullMQ queues
 * (§9). Job payloads, return values, progress objects and failure traces are
 * redacted before leaving the process; logs and flow detail endpoints are not
 * served at all because they can carry the same data outside the formatter rail.
 *
 * When this process holds no live queue registry (tests run on ioredis-mock,
 * which BullMQ cannot drive), there are no queues to inspect: the guard still
 * applies, so a reachable admin gets a clear 503 while everyone else keeps
 * getting the guard's 404.
 */

/** Full base path the inspector is mounted at (the admin router adds `/queues`). */
export const BULL_BOARD_BASE_PATH = '/api/v1/admin/queues';

const REDACTED_JOB_DETAIL = '[redacted]';

/** Strip the remaining job-detail fields Bull Board does not expose as formatters. */
const redactBullBoardResponse = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactBullBoardResponse);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (
        key === 'data' ||
        key === 'returnValue' ||
        key === 'progress' ||
        key === 'failedReason' ||
        key === 'stacktrace'
      ) {
        return [key, REDACTED_JOB_DETAIL];
      }
      return [key, redactBullBoardResponse(item)];
    }),
  );
};

const redactBullBoardJson: RequestHandler = (_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(redactBullBoardResponse(body))) as typeof res.json;
  next();
};

export function createBullBoardRouter(queues: QueueRegistry | null): Router {
  const router = Router();

  if (!queues) {
    router.use((_req, res) => {
      res.status(503).json({
        error: {
          code: 'QUEUE_INSPECTOR_UNAVAILABLE',
          message: 'The queue inspector is not available in this environment.',
        },
      });
    });
    return router;
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);
  createBullBoard({
    queues: ALL_QUEUE_NAMES.map((name) => {
      const adapter = new BullMQAdapter(queues.get(name), { readOnlyMode: true });
      // The UI formats list/detail responses through these fields. Treat all
      // values as sensitive: queue payloads routinely contain account IDs,
      // recipient details, tokens, and provider responses.
      adapter.setFormatter('data', () => REDACTED_JOB_DETAIL);
      adapter.setFormatter('returnValue', () => REDACTED_JOB_DETAIL);
      adapter.setFormatter('progress', () => REDACTED_JOB_DETAIL);
      return adapter;
    }),
    serverAdapter,
  });
  router.use(redactBullBoardJson);
  // Bull Board's formatter hooks do not cover these raw detail endpoints.
  router.all('/api/queues/:queueName/:jobId/logs', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  router.all('/api/queues/:queueName/:jobId/flow', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  // getRouter() is typed `any` by the adapter; it is a plain Express 5 router.
  router.use(serverAdapter.getRouter());
  return router;
}
