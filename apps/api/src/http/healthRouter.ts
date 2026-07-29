import express from 'express';

import { healthResponseSchema, readinessResponseSchema } from '@bettertrack/contracts';

import type { ReadinessService } from '../services/health/readinessService';
import { API_SERVICE_NAME, API_VERSION } from '../version';

/**
 * Public process probes. `/health` is dependency-free liveness; `/health/ready`
 * delegates the DB + Redis checks to the health service. Both payloads run
 * through shared contracts before leaving the process.
 */
export function createHealthRouter(readiness: ReadinessService) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    const body = healthResponseSchema.parse({
      status: 'ok',
      service: API_SERVICE_NAME,
      version: API_VERSION,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });

    res.json(body);
  });

  router.get('/health/ready', async (_req, res) => {
    const body = readinessResponseSchema.parse(await readiness.check());
    res.status(body.status === 'ready' ? 200 : 503).json(body);
  });

  return router;
}
