import express from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { healthResponseSchema, readinessResponseSchema } from '@bettertrack/contracts';

import type { Database } from '../data/db';
import { createReadinessService } from '../services/health/readinessService';
import { createHealthRouter } from './healthRouter';

function createProbeApp(
  options: {
    database?: () => Promise<unknown>;
    redis?: () => Promise<string>;
    timeoutMs?: number;
  } = {},
) {
  const execute = vi.fn(options.database ?? (async () => []));
  const ping = vi.fn(options.redis ?? (async () => 'PONG'));
  const readiness = createReadinessService({
    db: { execute } as unknown as Database,
    redis: { ping } as unknown as Redis,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const app = express();
  app.use('/api/v1', createHealthRouter(readiness));
  return { app, execute, ping };
}

describe('health router', () => {
  it('keeps liveness dependency-free', async () => {
    const probe = createProbeApp({
      database: async () => {
        throw new Error('database unavailable');
      },
      redis: async () => {
        throw new Error('redis unavailable');
      },
    });

    const res = await request(probe.app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(healthResponseSchema.safeParse(res.body).success).toBe(true);
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.ping).not.toHaveBeenCalled();
  });

  it('returns 200 only when Postgres and Redis are ready', async () => {
    const probe = createProbeApp();

    const res = await request(probe.app).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    const body = readinessResponseSchema.parse(res.body);
    expect(body.status).toBe('ready');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
  });

  it('returns a contract-valid 503 when Postgres is down', async () => {
    const probe = createProbeApp({
      database: async () => {
        throw new Error('database unavailable');
      },
    });

    const res = await request(probe.app).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    const body = readinessResponseSchema.parse(res.body);
    expect(body.status).toBe('not_ready');
    expect(body.checks.database.status).toBe('down');
    expect(body.checks.redis.status).toBe('ok');
  });

  it('returns a contract-valid 503 when Redis is down', async () => {
    const probe = createProbeApp({
      redis: async () => {
        throw new Error('redis unavailable');
      },
    });

    const res = await request(probe.app).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    const body = readinessResponseSchema.parse(res.body);
    expect(body.status).toBe('not_ready');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('down');
  });
});
