import express from 'express';

import { healthResponseSchema } from '@bettertrack/contracts';

import { API_SERVICE_NAME, API_VERSION } from '../version';

/**
 * Thin HTTP layer (PROJECTPLAN.md §4.3): parse → respond. The payload is run
 * through the shared contract schema before it leaves the process, so the API
 * can never drift from what clients expect.
 */
export const healthRouter = express.Router();

healthRouter.get('/health', (_req, res) => {
  const body = healthResponseSchema.parse({
    status: 'ok',
    service: API_SERVICE_NAME,
    version: API_VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });

  res.json(body);
});
