import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiError } from '../errors';
import { createLogger } from '../logger';
import { loadConfig } from '../config/env';

import { createErrorHandler } from './errorHandler';

const logger = createLogger(
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    SESSION_SECRET: 'error-handler-test-secret-0123456789',
  }),
);

function mockRes(): {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  removeHeader: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const removeHeader = vi.fn();
  const res = { status, json, removeHeader } as unknown as Response;
  return { res, status, json, removeHeader };
}

function validatorErrorApp(error: Error) {
  const app = express();
  app.disable('etag');
  app.get('/error', (_req, res) => {
    res.setHeader('ETag', 'W/"stale"');
    res.setHeader('Last-Modified', 'Tue, 14 Aug 2026 06:11:34 GMT');
    throw error;
  });
  app.use(createErrorHandler(logger));
  return app;
}

describe('createErrorHandler PII-safe reporting', () => {
  it('removes pre-set validators from an ApiError envelope', async () => {
    const res = await request(validatorErrorApp(new ApiError(409, 'CONFLICT', 'stale'))).get(
      '/error',
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'stale' } });
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('removes pre-set validators from an unexpected 500 envelope', async () => {
    const res = await request(validatorErrorApp(new Error('kaboom'))).get('/error');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error.' },
    });
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('reports an unexpected error (the 500 path) to the reporter', () => {
    const report = vi.fn();
    const handler = createErrorHandler(logger, report);
    const { res, status } = mockRes();

    const err = new Error('kaboom');
    handler(err, {} as Request, res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(err);
  });

  it('does NOT report an expected ApiError (normal control flow)', () => {
    const report = vi.fn();
    const handler = createErrorHandler(logger, report);
    const { res, status } = mockRes();

    handler(new ApiError(404, 'NOT_FOUND', 'nope'), {} as Request, res, vi.fn());

    expect(status).toHaveBeenCalledWith(404);
    expect(report).not.toHaveBeenCalled();
  });

  it('does NOT report a ZodError (validation is normal control flow)', () => {
    const report = vi.fn();
    const handler = createErrorHandler(logger, report);
    const { res, status } = mockRes();

    const zodErr = z.object({ a: z.string() }).safeParse({ a: 1 });
    handler(zodErr.success ? new Error('unexpected') : zodErr.error, {} as Request, res, vi.fn());

    expect(status).toHaveBeenCalledWith(400);
    expect(report).not.toHaveBeenCalled();
  });

  it('works with no reporter supplied (Sentry disabled)', () => {
    const handler = createErrorHandler(logger);
    const { res, status } = mockRes();
    expect(() => handler(new Error('x'), {} as Request, res, vi.fn())).not.toThrow();
    expect(status).toHaveBeenCalledWith(500);
  });
});
