import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { conditionalGet, CONDITIONAL_LAST_MODIFIED, type ConditionalOptions } from '../conditional';
import type { AuthUser } from '../../types';

/**
 * Reusable-in-isolation coverage for the V5-P1b conditional middleware
 * (issue #555). Uses a bare Express app with Express's own ETag generation
 * disabled, so the only validators present are the ones this middleware emits.
 */

/** Build a tiny app: header-driven identity, body and Last-Modified. */
function buildApp(opts: ConditionalOptions = {}) {
  const app = express();
  // Express's built-in weak ETag would otherwise mask what WE emit — turn it off
  // so these assertions isolate the middleware under test.
  app.set('etag', false);
  app.use((req, _res, next) => {
    req.authUser = { id: req.header('x-user') ?? 'user-1' } as unknown as AuthUser;
    next();
  });

  const handler = (req: express.Request, res: express.Response) => {
    const lm = req.header('x-last-modified');
    if (lm) res.locals[CONDITIONAL_LAST_MODIFIED] = new Date(lm);
    const status = req.header('x-status');
    if (status) res.status(Number(status));
    res.json({ value: req.header('x-body') ?? 'world' });
  };

  app.get('/r', conditionalGet(opts), handler);
  app.post('/r', conditionalGet(opts), handler);
  return app;
}

describe('conditionalGet middleware', () => {
  it('emits a weak ETag, private Cache-Control and Vary on a 200', async () => {
    const res = await request(buildApp()).get('/r');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toContain('Cookie');
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('emits Last-Modified when the handler supplies one', async () => {
    const when = new Date('2026-07-10T12:00:00.000Z');
    const res = await request(buildApp()).get('/r').set('x-last-modified', when.toISOString());
    expect(res.headers['last-modified']).toBe(when.toUTCString());
  });

  it('returns 304 with an empty body when If-None-Match matches', async () => {
    const app = buildApp();
    const first = await request(app).get('/r');
    const second = await request(app)
      .get('/r')
      .set('If-None-Match', first.headers.etag as string);
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('honours a wildcard If-None-Match', async () => {
    const res = await request(buildApp())
      .get('/r')
      .set('If-None-Match', '*' as string);
    expect(res.status).toBe(304);
  });

  it('returns 200 when If-None-Match is stale', async () => {
    const res = await request(buildApp())
      .get('/r')
      .set('If-None-Match', 'W/"stale"' as string);
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('world');
  });

  it('changes the ETag when the body changes', async () => {
    const app = buildApp();
    const a = await request(app).get('/r').set('x-body', 'alpha');
    const b = await request(app).get('/r').set('x-body', 'beta');
    expect(a.headers.etag).not.toBe(b.headers.etag);
  });

  it('never reuses a validator across users (identity salt)', async () => {
    const app = buildApp();
    const a = await request(app).get('/r').set('x-user', 'user-a').set('x-body', 'same');
    const b = await request(app).get('/r').set('x-user', 'user-b').set('x-body', 'same');
    expect(a.headers.etag).not.toBe(b.headers.etag);
    // user-b presenting user-a's ETag must not 304.
    const cross = await request(app)
      .get('/r')
      .set('x-user', 'user-b')
      .set('x-body', 'same')
      .set('If-None-Match', a.headers.etag as string);
    expect(cross.status).toBe(200);
  });

  it('honours If-Modified-Since when the resource is not live-today', async () => {
    const when = new Date('2026-07-10T12:00:00.000Z');
    const app = buildApp({ liveToday: false });
    const res = await request(app)
      .get('/r')
      .set('x-last-modified', when.toISOString())
      .set('If-Modified-Since', when.toUTCString());
    expect(res.status).toBe(304);
  });

  it('never lets If-Modified-Since mask a live-today resource', async () => {
    const when = new Date('2026-07-10T12:00:00.000Z');
    const app = buildApp({ liveToday: true });
    const res = await request(app)
      .get('/r')
      .set('x-last-modified', when.toISOString())
      .set('If-Modified-Since', when.toUTCString());
    expect(res.status).toBe(200);
    // ...but its ETag still gates a 304.
    const etag = res.headers.etag;
    const conditional = await request(app)
      .get('/r')
      .set('x-last-modified', when.toISOString())
      .set('If-None-Match', etag as string);
    expect(conditional.status).toBe(304);
  });

  it('ignores If-Modified-Since when If-None-Match is also present (RFC precedence)', async () => {
    const when = new Date('2026-07-10T12:00:00.000Z');
    const app = buildApp({ liveToday: false });
    const res = await request(app)
      .get('/r')
      .set('x-last-modified', when.toISOString())
      .set('If-None-Match', 'W/"stale"' as string)
      .set('If-Modified-Since', when.toUTCString());
    // If-Modified-Since would say "fresh", but the non-matching ETag wins.
    expect(res.status).toBe(200);
  });

  it('leaves a non-200 response untouched', async () => {
    const res = await request(buildApp()).get('/r').set('x-status', '201');
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBeUndefined();
  });

  it('does not conditional-ize a non-GET method', async () => {
    const res = await request(buildApp()).post('/r');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
  });
});
