import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { OPENAPI_ENDPOINT_COUNT } from '../http/openapi';
import { createTestApp } from '../testing/createTestApp';

/**
 * P9 — OpenAPI 3 generation from the zod contracts, served at the API origin.
 * These tests assert the document is structurally valid, derived from the
 * contracts (reusable components + resolvable refs), covers the mounted route
 * groups with their auth markers + shared error envelope, and that `/docs` and
 * `/openapi.json` are public while the rest of `/api/v1` stays session-guarded.
 */

type JsonObject = Record<string, unknown>;

/** Collects every `$ref` string in the document. */
function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as JsonObject)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

describe('OpenAPI document', () => {
  it('GET /openapi.json returns a structurally valid OpenAPI 3 document', async () => {
    const { app } = await createTestApp();

    const res = await request(app).get('/openapi.json');

    expect(res.status).toBe(200);
    const doc = res.body as JsonObject;

    // Top-level OpenAPI 3.x invariants.
    expect(String(doc.openapi)).toMatch(/^3\./);
    const info = doc.info as JsonObject;
    expect(info.title).toBe('BetterTrack API');
    expect(typeof info.version).toBe('string');

    // Reusable component schemas derived from the zod contracts.
    const components = doc.components as JsonObject;
    const schemas = components.schemas as JsonObject;
    expect(Object.keys(schemas).length).toBeGreaterThan(20);
    expect(schemas.ApiError).toBeDefined();
    expect(schemas.MeResponse).toBeDefined();

    // Paths exist for every documented endpoint.
    const paths = doc.paths as JsonObject;
    expect(Object.keys(paths).length).toBeGreaterThan(0);

    // Every operation carries a description on each response, and every path
    // item has at least one HTTP operation — a basic structural validation.
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    for (const [path, itemRaw] of Object.entries(paths)) {
      const item = itemRaw as JsonObject;
      const ops = methods.filter((m) => item[m]);
      expect(ops.length, `path ${path} has an operation`).toBeGreaterThan(0);
      for (const method of ops) {
        const op = item[method] as JsonObject;
        const responses = op.responses as JsonObject;
        expect(Object.keys(responses).length, `${method} ${path} responses`).toBeGreaterThan(0);
        for (const [code, respRaw] of Object.entries(responses)) {
          const resp = respRaw as JsonObject;
          expect(typeof resp.description, `${method} ${path} ${code} description`).toBe('string');
        }
      }
    }

    // Every $ref resolves to a defined component (structural integrity).
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const parts = ref.replace(/^#\//, '').split('/');
      let cursor: unknown = doc;
      for (const part of parts) {
        expect(cursor, `resolving ${ref}`).toBeTruthy();
        cursor = (cursor as JsonObject)[part];
      }
      expect(cursor, `ref ${ref} resolves`).toBeTruthy();
    }
  });

  it('covers the mounted route groups with auth markers + shared error envelope', async () => {
    const { app } = await createTestApp();
    const res = await request(app).get('/openapi.json');
    const doc = res.body as JsonObject;
    const paths = doc.paths as JsonObject;

    // A representative endpoint from each mounted /api/v1 route group.
    const expectedPaths = [
      '/auth/login',
      '/admin/users',
      '/workboard',
      '/search',
      '/assets/{id}',
      '/portfolios',
      '/custom-assets',
      '/conglomerates',
      '/backtest/preview',
      '/social/requests',
    ];
    for (const path of expectedPaths) {
      expect(Object.keys(paths), `documents ${path}`).toContain(path);
    }

    // The document count matches the registered endpoint table.
    const operationCount = Object.values(paths).reduce<number>(
      (n, item) => n + Object.keys(item as JsonObject).length,
      0,
    );
    expect(operationCount).toBe(OPENAPI_ENDPOINT_COUNT);

    // Session-guarded route: security requirement present, error envelope wired.
    const me = (paths['/auth/me'] as JsonObject).get as JsonObject;
    expect(me.security).toEqual([{ sessionCookie: [] }]);
    const meDefault = ((me.responses as JsonObject).default as JsonObject).content as JsonObject;
    expect((meDefault['application/json'] as JsonObject).schema).toEqual({
      $ref: '#/components/schemas/ApiError',
    });

    // Public route: explicitly no security requirement.
    const login = (paths['/auth/login'] as JsonObject).post as JsonObject;
    expect(login.security).toEqual([]);

    // The security scheme itself is the session cookie.
    const securitySchemes = (doc.components as JsonObject).securitySchemes as JsonObject;
    expect((securitySchemes.sessionCookie as JsonObject).in).toBe('cookie');
  });

  it('serves the interactive /docs page publicly', async () => {
    const { app } = await createTestApp();

    const res = await request(app).get('/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('/openapi.json');
  });

  it('keeps /docs and /openapi.json reachable without a session, but guards /api/v1', async () => {
    const { app } = await createTestApp();

    // Public docs endpoints: 200 with no cookie, not blocked by CSRF/password-change.
    await request(app).get('/openapi.json').expect(200);
    await request(app).get('/docs').expect(200);

    // The rest of /api/v1 still requires a session.
    await request(app).get('/api/v1/portfolios').expect(401);
  });
});
