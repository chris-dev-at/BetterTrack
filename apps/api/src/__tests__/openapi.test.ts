import request from 'supertest';
import { describe, expect, it } from 'vitest';

import * as contracts from '@bettertrack/contracts';

import { buildOpenApiDocument, OPENAPI_ENDPOINT_COUNT } from '../http/openapi';
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

    const grantList = schemas.OAuthGrantListResponse as JsonObject;
    const grantArray = (grantList.properties as JsonObject).grants as JsonObject;
    const grantRow = grantArray.items as JsonObject;
    const grantProperties = grantRow.properties as JsonObject;
    expect(grantProperties.firstParty).toEqual({ type: 'boolean' });
    expect(grantProperties.current).toEqual({ type: 'boolean' });
    expect(grantRow.required).toEqual(expect.arrayContaining(['firstParty', 'current']));

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
      '/feedback',
      '/feedback/mine',
      '/feedback/{id}',
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

    // Bearer-callable identity (#361): accepts the session cookie OR a bearer
    // token; error envelope wired.
    const me = (paths['/auth/me'] as JsonObject).get as JsonObject;
    expect(me.security).toEqual([{ sessionCookie: [] }, { apiKeyBearer: [] }]);
    const meDefault = ((me.responses as JsonObject).default as JsonObject).content as JsonObject;
    expect((meDefault['application/json'] as JsonObject).schema).toEqual({
      $ref: '#/components/schemas/ApiError',
    });

    // Public route: explicitly no security requirement.
    const login = (paths['/auth/login'] as JsonObject).post as JsonObject;
    expect(login.security).toEqual([]);

    // Cookie-only route (#361): key management is never bearer-callable, so its
    // security stays the session cookie alone — the derived metadata is precise,
    // not a blanket bearer marker.
    const apiKeys = (paths['/settings/api-keys'] as JsonObject).get as JsonObject;
    expect(apiKeys.security).toEqual([{ sessionCookie: [] }]);

    // #1324/#1399: existing-passkey management, first-run completion and the
    // tax-year documentation list share account:security across the cookie and
    // bearer front ends. The markers are derived from the same exact method/path
    // policy as live requests; no endpoint-local security override may drift.
    const nativeAccountSecurityOperations = [
      ['get', '/auth/passkeys'],
      ['patch', '/auth/passkeys/{id}'],
      ['delete', '/auth/passkeys/{id}'],
      ['post', '/auth/first-run/complete'],
      ['get', '/settings/taxes/years'],
    ] as const;
    for (const [method, path] of nativeAccountSecurityOperations) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([
        { sessionCookie: [] },
        { apiKeyBearer: [] },
      ]);
    }
    expect(paths['/settings/taxes/years/{year}/unlock']).toBeUndefined();
    expect(paths['/settings/taxes/years/{year}/relock']).toBeUndefined();

    // #1328: only the JSON start leg is authenticated + bearer-callable. Both
    // Google browser callbacks are genuinely public, while the legacy anonymous
    // sign-in start remains public but never advertises bearer authentication.
    const mobileGoogleLinkStart = (paths['/auth/google/link/start'] as JsonObject)
      .post as JsonObject;
    expect(mobileGoogleLinkStart.security).toEqual([{ sessionCookie: [] }, { apiKeyBearer: [] }]);
    expect(
      ((mobileGoogleLinkStart.responses as JsonObject)['200'] as JsonObject).content,
    ).toMatchObject({
      'application/json': {
        schema: { $ref: '#/components/schemas/GoogleMobileLinkStartResponse' },
      },
    });
    expect(
      ((paths['/auth/google/link/callback'] as JsonObject).get as JsonObject).security,
    ).toEqual([]);
    expect(((paths['/auth/google/start'] as JsonObject).get as JsonObject).security).toEqual([]);
    expect(((paths['/auth/google/callback'] as JsonObject).get as JsonObject).security).toEqual([]);

    // Registration remains an owning-browser ceremony. Public passkey sign-in
    // remains public, but neither class advertises bearer-token authentication.
    for (const [method, path] of [
      ['post', '/auth/passkeys/register/options'],
      ['post', '/auth/passkeys/register/verify'],
    ] as const) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([
        { sessionCookie: [] },
      ]);
    }
    for (const [method, path] of [
      ['post', '/auth/passkeys/login/options'],
      ['post', '/auth/passkeys/login/verify'],
    ] as const) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([]);
    }

    // #1325: the policy table marks both exact grant-management operations as
    // bearer-capable, so the generator derives both schemes without an endpoint
    // security override. The prose documents the narrower first-party condition
    // that an OpenAPI security-scheme union cannot express on its own.
    for (const [method, path] of [
      ['get', '/settings/oauth-grants'],
      ['delete', '/settings/oauth-grants/{id}'],
    ] as const) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `${method.toUpperCase()} ${path}`).toEqual([
        { sessionCookie: [] },
        { apiKeyBearer: [] },
      ]);
      expect(operation.description).toContain('first-party OAuth client');
      expect(operation.description).toContain('account:security');
    }

    // A scope-gated module route accepts both the cookie and a bearer token.
    const notifications = (paths['/notifications'] as JsonObject).get as JsonObject;
    expect(notifications.security).toEqual([{ sessionCookie: [] }, { apiKeyBearer: [] }]);

    // #1315: feedback is explicitly scope-gated, so SDKs advertise both the
    // cookie and bearer paths instead of a bearer discovering API_KEY_FORBIDDEN.
    const feedback = (paths['/feedback'] as JsonObject).post as JsonObject;
    expect(feedback.security).toEqual([{ sessionCookie: [] }, { apiKeyBearer: [] }]);
    const feedbackCreated = ((feedback.responses as JsonObject)['201'] as JsonObject)
      .content as JsonObject;
    expect((feedbackCreated['application/json'] as JsonObject).schema).toEqual({
      $ref: '#/components/schemas/CreateFeedbackResponse',
    });
    const myFeedback = (paths['/feedback/mine'] as JsonObject).get as JsonObject;
    expect(myFeedback.security).toEqual([{ sessionCookie: [] }, { apiKeyBearer: [] }]);
    const myFeedbackOk = ((myFeedback.responses as JsonObject)['200'] as JsonObject)
      .content as JsonObject;
    expect((myFeedbackOk['application/json'] as JsonObject).schema).toEqual({
      $ref: '#/components/schemas/MyFeedbackResponse',
    });
    const deleteFeedback = (paths['/feedback/{id}'] as JsonObject).delete as JsonObject;
    expect(deleteFeedback.security).toEqual([{ sessionCookie: [] }, { apiKeyBearer: [] }]);
    expect(deleteFeedback.responses as JsonObject).toHaveProperty('204');
    expect(paths).toHaveProperty('/admin/feedback/{id}');
    expect(paths).not.toHaveProperty('/admin/feedback/{id}/status');

    // #1327: plural remembered-device management is the bearer-capable sibling
    // of the browser-cookie mint/forget pair. Security is derived from the same
    // method/path policy as middleware — no endpoint-local OpenAPI override.
    for (const [method, path] of [
      ['get', '/auth/remembered-devices'],
      ['delete', '/auth/remembered-devices/{handle}'],
      ['delete', '/auth/remembered-devices'],
    ] as const) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([
        { sessionCookie: [] },
        { apiKeyBearer: [] },
      ]);
    }
    const rememberInBrowser = (paths['/auth/remembered-device'] as JsonObject).post as JsonObject;
    expect(rememberInBrowser.security).toEqual([{ sessionCookie: [] }]);

    // The cash endpoint changed from an unbounded chronological ledger to a
    // bounded newest-first page. External clients must see both semantics in
    // the generated reference instead of discovering truncation implicitly.
    const cashMovements = (paths['/portfolios/{portfolioId}/cash'] as JsonObject).get as JsonObject;
    expect(cashMovements.description).toContain('newest first');
    expect(cashMovements.description).toContain(
      `at most ${contracts.CASH_MOVEMENTS_DEFAULT_LIMIT} rows`,
    );

    // #1041: every documented cash-classification operation derives bearer
    // admission from the /cash module policy. No endpoint-specific OpenAPI
    // override is allowed to drift from the middleware table.
    const cashPaths = Object.entries(paths).filter(([path]) => path.startsWith('/cash/'));
    const cashMethods = ['get', 'post', 'put', 'patch', 'delete'];
    expect(cashPaths.length).toBeGreaterThan(0);
    for (const [path, itemRaw] of cashPaths) {
      const item = itemRaw as JsonObject;
      for (const method of cashMethods.filter((candidate) => item[candidate])) {
        const operation = item[method] as JsonObject;
        expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([
          { sessionCookie: [] },
          { apiKeyBearer: [] },
        ]);
      }
    }

    // #1042 + board #67 (owner-approved 2026-08-07): mirrorchain is split by
    // exact method + route. Participation always advertised bearer; chain
    // administration was widened from session-only to bearer under the owner's
    // fully-capable phone-management mandate, so all sixteen operations now
    // advertise bearer access (reads gated by mirrorchain:read, every write by
    // mirrorchain:write via the module policy). The GET-vs-POST /chains split
    // still matters — both are bearer now, but the method-aware allowlist is
    // what makes that safe.
    const mirrorchainBearerOperations = [
      ['get', '/mirrorchain/chains'],
      ['get', '/mirrorchain/chains/{chainId}/members'],
      ['get', '/mirrorchain/chains/{chainId}/activity'],
      ['get', '/mirrorchain/invites'],
      ['post', '/mirrorchain/invites/{inviteId}/accept'],
      ['post', '/mirrorchain/invites/{inviteId}/decline'],
      ['post', '/mirrorchain/chains/{chainId}/leave'],
      ['post', '/mirrorchain/chains'],
      ['post', '/mirrorchain/chains/convert'],
      ['post', '/mirrorchain/invites/{inviteId}/revoke'],
      ['post', '/mirrorchain/chains/{chainId}/invites'],
      ['patch', '/mirrorchain/chains/{chainId}'],
      ['post', '/mirrorchain/chains/{chainId}/transfer'],
      ['delete', '/mirrorchain/chains/{chainId}'],
      ['patch', '/mirrorchain/chains/{chainId}/members/{userId}/role'],
      ['delete', '/mirrorchain/chains/{chainId}/members/{userId}'],
    ] as const;
    for (const [method, path] of mirrorchainBearerOperations) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([
        { sessionCookie: [] },
        { apiKeyBearer: [] },
      ]);
    }

    // #1043: only opaque vault sync operations advertise bearer auth. Media
    // transitions, candidate/retirement lifecycle and account transitions stay
    // owning-browser-session operations in the generated contract too.
    const vaultBearerOperations = [
      ['get', '/vault'],
      ['put', '/vault'],
      ['get', '/vault/media'],
      ['get', '/vault/history'],
      ['get', '/vault/history/{version}'],
    ] as const;
    for (const [method, path] of vaultBearerOperations) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([
        { sessionCookie: [] },
        { apiKeyBearer: [] },
      ]);
    }

    const vaultSessionOperations = [
      ['patch', '/vault/media'],
      ['put', '/vault/media/server-candidate'],
      ['get', '/vault/media/server-candidate/{candidateId}'],
      ['post', '/vault/media/retired/purge/challenge'],
      ['post', '/vault/media/retired/purge'],
    ] as const;
    for (const [method, path] of vaultSessionOperations) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([
        { sessionCookie: [] },
      ]);
    }

    // Paranoid transitions (§13.5 V5-P13) are session-only in the middleware, so
    // the derived spec must NOT advertise a bearer for either direction — a
    // client-generated SDK that offered it would only ever get 403s, and the
    // sibling `/account/*` routes stay bearer-callable, so this cannot be assumed.
    for (const [method, path] of [
      ['post', '/account/paranoid/enable'],
      ['post', '/account/paranoid/disable'],
      ['get', '/account/paranoid/fork-provenance'],
      ['get', '/account/paranoid/normal-revision'],
    ] as const) {
      const operation = (paths[path] as JsonObject)[method] as JsonObject;
      expect(operation.security, `security for ${method.toUpperCase()} ${path}`).toEqual([
        { sessionCookie: [] },
      ]);
    }
    expect(
      ((paths['/account'] as JsonObject).delete as JsonObject).security,
      'the coarse account-security surface is unchanged',
    ).toEqual([{ sessionCookie: [] }, { apiKeyBearer: [] }]);

    // The bearer security scheme itself is documented.
    const schemesForBearer = (doc.components as JsonObject).securitySchemes as JsonObject;
    expect((schemesForBearer.apiKeyBearer as JsonObject).scheme).toBe('bearer');

    // The security scheme itself is the session cookie.
    const securitySchemes = (doc.components as JsonObject).securitySchemes as JsonObject;
    expect((securitySchemes.sessionCookie as JsonObject).in).toBe('cookie');
  });

  it('documents the recursive vault JSON columns without mutating the contracts module', () => {
    // The hint that lets the generator past ZodLazy is installed for the duration
    // of one generateDocument() call and removed again, so importing the OpenAPI
    // router can never change how `@bettertrack/contracts` documents itself for
    // any other consumer (and a second build is still correct, not a one-shot).
    const shared = contracts.vaultJsonSchema as unknown as { _def: { openapi?: unknown } };
    const before = shared._def.openapi;

    const first = buildOpenApiDocument() as unknown as JsonObject;
    expect(shared._def.openapi).toBe(before);
    const second = buildOpenApiDocument() as unknown as JsonObject;
    expect(shared._def.openapi).toBe(before);

    // Both builds carry the same documented JSON column, and its description says
    // the column is not really object-only (OpenAPI 3.0 has no recursive union).
    const disable = ((first.components as JsonObject).schemas as JsonObject)
      .ParanoidDisableRequest as JsonObject;
    expect(JSON.stringify(disable)).toContain('any JSON value');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
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
