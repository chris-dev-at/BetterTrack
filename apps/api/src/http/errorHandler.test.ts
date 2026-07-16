import type { Request, Response } from 'express';
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
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

describe('createErrorHandler PII-safe reporting', () => {
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
