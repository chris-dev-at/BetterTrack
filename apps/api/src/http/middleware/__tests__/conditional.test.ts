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

  it('refuses a wildcard If-None-Match on a live-today resource (#1762)', async () => {
    // RFC 7232 §3.2 makes `*` match any existing representation, which on a
    // liveToday route would 304 across every fresh intraday quote, forever —
    // the one thing the module guarantees cannot happen. The guard wins.
    const app = buildApp({ liveToday: true });
    const res = await request(app)
      .get('/r')
      .set('If-None-Match', '*' as string);
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('world');
    // The real (body-derived) validator still gates a 304 on the same route.
    const byEtag = await request(app)
      .get('/r')
      .set('If-None-Match', res.headers.etag as string);
    expect(byEtag.status).toBe(304);
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

  it('answers 200 when the validator is newer than If-Modified-Since by less than a second (#1762)', async () => {
    // The client holds 12:00:03; the resource changed at 12:00:03.400. Flooring
    // the validator before the compare (what shipped) makes those equal and
    // answers 304 with the pre-change body — the exact staleness the flooring
    // was commented as preventing. An exact compare answers 200.
    const app = buildApp({ liveToday: false });
    const res = await request(app)
      .get('/r')
      .set('x-last-modified', '2026-07-10T12:00:03.400Z')
      .set('If-Modified-Since', new Date('2026-07-10T12:00:03.000Z').toUTCString());
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('world');
  });

  it('never turns its own advertised Last-Modified into a stale 304 (#1762)', async () => {
    // What goes out is an HTTP-date (whole seconds). Echoing exactly that back
    // may only produce a 304 while the validator is unchanged: a sub-second
    // advance inside the advertised second still answers 200.
    const app = buildApp({ liveToday: false });
    const first = await request(app).get('/r').set('x-last-modified', '2026-07-10T12:00:03.400Z');
    const advertised = first.headers['last-modified'] as string;
    expect(advertised).toBe(new Date('2026-07-10T12:00:03.000Z').toUTCString());

    const moved = await request(app)
      .get('/r')
      .set('x-last-modified', '2026-07-10T12:00:03.900Z')
      .set('If-Modified-Since', advertised);
    expect(moved.status).toBe(200);

    // A whole-second watermark — what the catalog write triggers guarantee — is
    // advertised losslessly, so an unchanged one still revalidates to a 304.
    const whole = await request(app).get('/r').set('x-last-modified', '2026-07-10T12:00:04.000Z');
    const unchanged = await request(app)
      .get('/r')
      .set('x-last-modified', '2026-07-10T12:00:04.000Z')
      .set('If-Modified-Since', whole.headers['last-modified'] as string);
    expect(unchanged.status).toBe(304);
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
