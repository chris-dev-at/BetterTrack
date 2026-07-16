import { Router } from 'express';

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/dist/queueAdapters/bullMQ.js';
import { ExpressAdapter } from '@bull-board/express';

import { ALL_QUEUE_NAMES, type QueueRegistry } from '../jobs';

/**
 * bull-board queue inspector (PROJECTPLAN.md §13.4 V4-P5a), mounted admin-only.
 *
 * The router this returns is mounted INSIDE the `/api/v1/admin` router, so it
 * already sits behind `requireAdmin` (+ mandatory 2FA): a non-admin or anonymous
 * request 404s before ever reaching here (§6.12's no-information-leak rule). This
 * module just serves the inspector UI/API for the durable BullMQ queues (§9).
 *
 * When this process holds no live queue registry (tests run on ioredis-mock,
 * which BullMQ cannot drive), there are no queues to inspect: the guard still
 * applies, so a reachable admin gets a clear 503 while everyone else keeps
 * getting the guard's 404.
 */

/** Full base path the inspector is mounted at (the admin router adds `/queues`). */
export const BULL_BOARD_BASE_PATH = '/api/v1/admin/queues';

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
    queues: ALL_QUEUE_NAMES.map((name) => new BullMQAdapter(queues.get(name))),
    serverAdapter,
  });
  // getRouter() is typed `any` by the adapter; it is a plain Express 5 router.
  router.use(serverAdapter.getRouter());
  return router;
}
