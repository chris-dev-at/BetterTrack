import { DrizzleQueryError } from 'drizzle-orm/errors';
import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { MAX_ERROR_MESSAGE_CHARS } from '../data/driverError';
import { ApiError } from '../errors';
import { createLogger, type Logger } from '../logger';
import { loadConfig } from '../config/env';

import { createErrorHandler, requestRouteTemplate } from './errorHandler';

const logger = createLogger(
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    SESSION_SECRET: 'error-handler-test-secret-0123456789',
  }),
);

function mockRes(headersSent = false): {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  removeHeader: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const removeHeader = vi.fn();
  // `statusCode` is what an already-sent response really ended with — the
  // capture records that rather than the 500 it can no longer write.
  const res = { headersSent, statusCode: 200, status, json, removeHeader } as unknown as Response;
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

/**
 * The route template that identifies a captured 500 (§13.5 V5-P2 arc (d)). It
 * enters the problem's fold key, so a concrete id in it would split one broken
 * endpoint into a row per id — and the mount prefix has to survive the router
 * rewinding `req.baseUrl` on its way to this handler.
 */
describe('requestRouteTemplate', () => {
  it('rebuilds the mounted pattern even though req.baseUrl was restored', () => {
    const req = {
      originalUrl: '/api/v1/portfolios/018f4b7e-8d3a-7c19-9d0b-1a2b3c4d5e6f?range=1m',
      baseUrl: '',
      route: { path: '/:id' },
    } as unknown as Request;

    expect(requestRouteTemplate(req)).toBe('/api/v1/portfolios/:id');
  });

  it('masks id-shaped segments when nothing matched (no route to read)', () => {
    const req = {
      originalUrl: '/api/v1/assets/018f4b7e-8d3a-7c19-9d0b-1a2b3c4d5e6f/history',
    } as unknown as Request;

    expect(requestRouteTemplate(req)).toBe('/api/v1/assets/:id/history');
  });

  it('falls back to "/" for a request that carries no url at all', () => {
    expect(requestRouteTemplate({} as Request)).toBe('/');
  });
});

describe('createErrorHandler validator stripping', () => {
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
});

/**
 * Body-parser failures are CLIENT faults (§13.5 V5-P2). Before this they
 * arrived as plain `Error`s, were classified as unexpected, and left as a 500
 * that was also captured onto the admin Problems page — with the parser's own
 * message, which quotes the first bytes of the body.
 */
describe('createErrorHandler body-parser failures', () => {
  function bodyParserApp(report: ReturnType<typeof vi.fn>, limit = '100kb') {
    const app = express();
    app.disable('etag');
    app.use(express.json({ limit }));
    app.post('/thing', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(createErrorHandler(logger, report));
    return app;
  }

  it('answers truncated JSON with 400 and never reports it', async () => {
    const report = vi.fn();
    const res = await request(bodyParserApp(report))
      .post('/thing')
      .set('Content-Type', 'application/json')
      .send('{"password": "hunter2-correct-horse');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'MALFORMED_BODY', message: 'The request body is not valid JSON.' },
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('never echoes a fragment of the body it refused', async () => {
    const report = vi.fn();
    const res = await request(bodyParserApp(report))
      .post('/thing')
      .set('Content-Type', 'application/json')
      .send('{"password": "hunter2-correct-horse');

    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('answers an over-bound body with 413 and never reports it', async () => {
    const report = vi.fn();
    const res = await request(bodyParserApp(report, '1kb'))
      .post('/thing')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(4096) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body exceeds the size limit.' },
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('answers an unsupported content encoding with 415 and never reports it', async () => {
    const report = vi.fn();
    const res = await request(bodyParserApp(report))
      .post('/thing')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'brotlipop')
      .send('{"a":1}');

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(report).not.toHaveBeenCalled();
  });

  it('does not report a body-parser failure after headers are already sent', () => {
    const report = vi.fn();
    const handler = createErrorHandler(logger, report);
    const { res, status } = mockRes(true);
    const next = vi.fn();
    const parseFailure = Object.assign(new SyntaxError('Unexpected token in "{"pw": secret'), {
      type: 'entity.parse.failed',
      status: 400,
      expose: true,
    });

    handler(parseFailure, {} as Request, res, next);

    expect(report).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(parseFailure);
  });

  it('answers an unlisted exposable body-parser type with a code matching its status', () => {
    // A future body-parser type ships its real status; the code follows that
    // status rather than labelling every fallback BAD_REQUEST.
    for (const [status, code] of [
      [413, 'PAYLOAD_TOO_LARGE'],
      [415, 'UNSUPPORTED_MEDIA_TYPE'],
      [400, 'BAD_REQUEST'],
      [422, 'BAD_REQUEST'],
    ] as const) {
      const report = vi.fn();
      const handler = createErrorHandler(logger, report);
      const { res, status: statusFn, json } = mockRes();
      const err = Object.assign(new Error('body said "hunter2"'), {
        type: 'entity.future.unknown',
        status,
        expose: true,
      });

      handler(err, {} as Request, res, vi.fn());

      expect(statusFn).toHaveBeenCalledWith(status);
      expect(json).toHaveBeenCalledWith({
        error: { code, message: 'The request body could not be read.' },
      });
      expect(report).not.toHaveBeenCalled();
    }
  });

  it('still treats a 5xx-shaped error carrying a type as unexpected', () => {
    const report = vi.fn();
    const handler = createErrorHandler(logger, report);
    const { res, status } = mockRes();
    const err = Object.assign(new Error('upstream exploded'), {
      type: 'stream.encoding.set',
      status: 500,
      expose: false,
    });

    handler(err, {} as Request, res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe('createErrorHandler PII-safe reporting', () => {
  it('reports an unexpected error (the 500 path) to the reporter', () => {
    const report = vi.fn();
    const handler = createErrorHandler(logger, report);
    const { res, status } = mockRes();

    const err = new Error('kaboom');
    handler(err, { method: 'POST', originalUrl: '/api/v1/things?x=1' } as Request, res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
    expect(report).toHaveBeenCalledTimes(1);
    // The request facts ride along with the report: the DB capture stores them,
    // and without them a 500 identifies nothing but its own message.
    expect(report).toHaveBeenCalledWith(err, {
      method: 'POST',
      route: '/api/v1/things',
      status: 500,
      requestId: expect.any(String),
    });
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

  it('reports and delegates an unexpected error after headers are sent', () => {
    const errorLogger = { error: vi.fn() } as unknown as Logger;
    const report = vi.fn();
    const handler = createErrorHandler(errorLogger, report);
    const { res, status, json, removeHeader } = mockRes(true);
    const next = vi.fn();
    const err = new Error('kaboom');

    expect(() => handler(err, {} as Request, res, next)).not.toThrow();

    expect(errorLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'kaboom', status: 200 }),
      'Unhandled request error',
    );
    expect(report).toHaveBeenCalledWith(err, expect.objectContaining({ status: 200 }));
    expect(removeHeader).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });

  it('logs the driver failure, not drizzle’s SQL-and-parameters wrapper', () => {
    // A `DrizzleQueryError` message is the failing statement plus every bound
    // parameter (drizzle-orm ≥0.44). Logged verbatim it writes the row's
    // contents into the log as ONE string, which pino's key-based `redact`
    // cannot reach. The reporter still receives the error exactly as thrown.
    const errorLogger = { error: vi.fn() } as unknown as Logger;
    const report = vi.fn();
    const handler = createErrorHandler(errorLogger, report);
    const { res } = mockRes();
    const wrapped = new DrizzleQueryError(
      'insert into "portfolio_cash_movements" ("note") values ($1)',
      ['rent for the Berlin flat'],
      new Error('duplicate key value violates unique constraint "cash_movements_pkey"'),
    );

    handler(wrapped, {} as Request, res, vi.fn());

    expect(errorLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'duplicate key value violates unique constraint "cash_movements_pkey"',
      }),
      'Unhandled request error',
    );
    expect(report).toHaveBeenCalledWith(wrapped, expect.objectContaining({ status: 500 }));
  });

  it('caps a pathological error message before it reaches the log', () => {
    const errorLogger = { error: vi.fn() } as unknown as Logger;
    const handler = createErrorHandler(errorLogger);
    const { res } = mockRes();

    handler(new Error('A'.repeat(50_000)), {} as Request, res, vi.fn());

    const logged = (errorLogger.error as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      err: string;
    };
    expect(logged.err.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS + 16);
    expect(logged.err).toContain('[truncated]');
  });
});
