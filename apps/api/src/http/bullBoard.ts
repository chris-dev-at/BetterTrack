import { Router } from 'express';

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/dist/queueAdapters/bullMQ.js';
import { ExpressAdapter } from '@bull-board/express';

import { ALL_QUEUE_NAMES, type QueueRegistry } from '../jobs';

/**
 * bull-board queue inspector (PROJECTPLAN.md §13.4 V4-P5a), mounted admin-only.
 *
 * The router is mounted at the app root behind the admin limiter, `requireAdmin`,
 * and the current-session MFA gate: a non-admin or anonymous request 404s before
 * ever reaching here (§6.12's no-information-leak rule). This module serves the
 * read-only inspector UI/API for the durable BullMQ queues (§9).
 *
 * When this process holds no live queue registry (tests run on ioredis-mock,
 * which BullMQ cannot drive), there are no queues to inspect: the guard still
 * applies, so a reachable admin gets a clear 503 while everyone else keeps
 * getting the guard's 404.
 */

/** Full base path the inspector is mounted at (the admin router adds `/queues`). */
export const BULL_BOARD_BASE_PATH = '/api/v1/admin/queues';
export const BULL_BOARD_REDACTED_VALUE = '[redacted]';

/**
 * Queue adapters are diagnostics-only. Bull Board enforces read-only mode on
 * every mutation endpoint, while formatters ensure its list/detail APIs never
 * serialize the job payload or return value (both may contain user data or
 * delivery secrets).
 */
export function createBullBoardQueueAdapter(
  queue: ConstructorParameters<typeof BullMQAdapter>[0],
): BullMQAdapter {
  const adapter = new BullMQAdapter(queue, {
    readOnlyMode: true,
    allowRetries: false,
  });
  adapter.setFormatter('data', () => BULL_BOARD_REDACTED_VALUE);
  adapter.setFormatter('returnValue', () => BULL_BOARD_REDACTED_VALUE);
  return adapter;
}

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
    queues: ALL_QUEUE_NAMES.map((name) => createBullBoardQueueAdapter(queues.get(name))),
    serverAdapter,
  });
  // getRouter() is typed `any` by the adapter; it is a plain Express 5 router.
  router.use(serverAdapter.getRouter());
  return router;
}
