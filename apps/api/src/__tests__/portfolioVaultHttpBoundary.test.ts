import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { count, eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import {
  VALIDATION_ERROR_ISSUES_MAX,
  portfolioVaultMoveOutRequestSchema,
  validationErrorDetailsSchema,
  vaultStrictEntitySchema,
  type ApiKeyScope,
  type VaultStrictDocumentV1,
} from '@bettertrack/contracts';

import { portfolioVaultTransitionStates, portfolios, vaults } from '../data/schema';
import { GLOBAL_JSON_BODY_LIMIT, paranoidRestoreJsonLimitBytes } from '../http/bodyLimits';
import { getOpenApiDocument } from '../http/openapi';
import { buildRouteTable, checkCoverage } from '../scripts/checkOpenapiCoverage';
import { PortfolioVaultTransitionError } from '../services/account/portfolioVaultTransitionService';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
// Deterministic TEST VECTOR identifiers only; none is a credential or secret.
const VAULT_ID = '018f0000-0000-7000-8000-00000000e401';
const MOVE_OUT_ID = '018f0000-0000-7000-8000-00000000e402';
const DEVICE_ID = '018f0000-0000-7000-8000-00000000e403';
const REVISION = 'portfolio_revision_test_vector';
const DOCUMENT_DIGEST = 'A'.repeat(43);
const DOCUMENT_SET_HASH = 'B'.repeat(43);
const VAULT_PROOF = {
  challenge: 'TEST VECTOR move-out challenge'.padEnd(32, '.'),
  signature: 's'.repeat(86),
} as const;
const EDITED_AT = '2026-08-20T12:00:00.000Z';

type Agent = ReturnType<typeof request.agent>;

interface Principal {
  user: SeededUser;
  portfolioId: string;
  agent: Agent;
}

async function seedPrincipal(harness: TestHarness, tag: string): Promise<Principal> {
  const user = await harness.seedUser({
    email: `e4-http-${tag}@bettertrack.test`,
    username: `e4_http_${tag.replaceAll('-', '_')}`,
  });
  const [portfolio] = await harness.db
    .insert(portfolios)
    .values({ userId: user.id, name: `E4 HTTP ${tag}` })
    .returning();
  if (!portfolio) throw new Error('portfolio insert failed');
  const agent = request.agent(harness.app);
  const login = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { user, portfolioId: portfolio.id, agent };
}

function strictDocument(userId: string, portfolioId: string): VaultStrictDocumentV1 {
  return {
    schemaVersion: 1,
    entities: [
      {
        id: portfolioId,
        kind: 'portfolio',
        rev: 3,
        editedAt: EDITED_AT,
        editedBy: DEVICE_ID,
        deletedAt: null,
        data: {
          userId,
          name: 'TEST VECTOR restored portfolio',
          visibility: 'private',
          sortOrder: 2,
          defaultPayFromCash: true,
          archivedAt: null,
          kind: null,
          vaultId: null,
          alias: null,
          vaultAlias: null,
        },
      },
    ],
    mergeLog: [],
    mirrorProvenance: [],
  };
}

function moveInBody(password: string) {
  return {
    vaultId: VAULT_ID,
    docVersion: 7,
    portfolioDataRevision: REVISION,
    stepUp: { password },
  };
}

function moveOutBody(userId: string, portfolioId: string, password: string) {
  return {
    vaultId: VAULT_ID,
    moveOutId: MOVE_OUT_ID,
    lifecycleGeneration: 1,
    documentSetHash: DOCUMENT_SET_HASH,
    document: strictDocument(userId, portfolioId),
    vaultProof: VAULT_PROOF,
    stepUp: { password },
  };
}

const moveOutChallengeBody = () => ({
  vaultId: VAULT_ID,
  lifecycleGeneration: 1,
  documentDigest: DOCUMENT_DIGEST,
  documentSetHash: DOCUMENT_SET_HASH,
});

function stubTransitions(harness: TestHarness, portfolioId: string) {
  const revision = vi
    .spyOn(harness.ctx.portfolioVaultTransitions, 'revision')
    .mockResolvedValue({ portfolioDataRevision: REVISION, importBatchCount: 0 });
  const moveIn = vi.spyOn(harness.ctx.portfolioVaultTransitions, 'moveIn').mockResolvedValue({
    portfolioId,
    vaultId: VAULT_ID,
    docVersion: 7,
    lifecycleGeneration: 1,
    idempotent: false,
  });
  const moveOutChallenge = vi
    .spyOn(harness.ctx.portfolioVaultTransitions, 'moveOutChallenge')
    .mockResolvedValue({
      portfolioId,
      ...moveOutChallengeBody(),
      challenge: VAULT_PROOF.challenge,
      expiresAt: '2026-08-21T10:05:00.000Z',
    });
  const moveOut = vi.spyOn(harness.ctx.portfolioVaultTransitions, 'moveOut').mockResolvedValue({
    portfolioId,
    vaultId: VAULT_ID,
    moveOutId: MOVE_OUT_ID,
    lifecycleGeneration: 1,
    idempotent: false,
  });
  const lifecycle = vi
    .spyOn(harness.ctx.portfolioVaultTransitions, 'lifecycle')
    .mockResolvedValue({ portfolioId, vaultId: VAULT_ID, lifecycleGeneration: 1 });
  const captureImportBatches = vi
    .spyOn(harness.ctx.portfolioVaultTransitions, 'captureImportBatches')
    .mockResolvedValue({ batches: [], rows: [], nextCursor: null });
  return { revision, lifecycle, moveIn, moveOutChallenge, moveOut, captureImportBatches };
}

async function mintKey(
  harness: TestHarness,
  userId: string,
  name: string,
  scopes: ApiKeyScope[],
): Promise<string> {
  return (
    await harness.ctx.apiKeys.create({
      userId,
      name,
      scopes,
    })
  ).token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('E4 portfolio-vault HTTP boundary', () => {
  // The seeded principal costs an argon2 hash and this arc now carries the
  // #1529 read's happy/400/409 probes as well: its own budget, not the suite's.
  it(
    'mounts all five cookie-session routes and marks every successful response no-store',
    { timeout: 60_000 },
    async () => {
      const harness = await createTestApp();
      const { user, portfolioId, agent } = await seedPrincipal(harness, 'cookie');
      const spies = stubTransitions(harness, portfolioId);

      const revision = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/revision`);
      expect(revision.status, JSON.stringify(revision.body)).toBe(200);
      expect(revision.headers['cache-control']).toContain('no-store');
      expect(revision.body).toEqual({ portfolioDataRevision: REVISION, importBatchCount: 0 });

      const lifecycle = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/lifecycle`);
      expect(lifecycle.status, JSON.stringify(lifecycle.body)).toBe(200);
      expect(lifecycle.headers['cache-control']).toContain('no-store');
      expect(lifecycle.body).toEqual({ portfolioId, vaultId: VAULT_ID, lifecycleGeneration: 1 });

      // #1529: the lossless import-capture read — paged, no-store, query-validated.
      const captured = await agent
        .get(`/api/v1/portfolios/${portfolioId}/vault/import-batches`)
        .query({ limit: 2 });
      expect(captured.status, JSON.stringify(captured.body)).toBe(200);
      expect(captured.headers['cache-control']).toContain('no-store');
      expect(captured.body).toEqual({ batches: [], rows: [], nextCursor: null });
      expect(spies.captureImportBatches).toHaveBeenCalledWith(user.id, portfolioId, { limit: 2 });
      const badLimit = await agent
        .get(`/api/v1/portfolios/${portfolioId}/vault/import-batches`)
        .query({ limit: 0 });
      expect(badLimit.status).toBe(400);
      // Review F2: an unservable STORED row is a typed 409, never the request
      // validator's 400 — the request was fine, the data is not exactly servable.
      spies.captureImportBatches.mockRejectedValueOnce(
        new PortfolioVaultTransitionError('CAPTURE_UNSERVABLE', 'TEST VECTOR unservable row'),
      );
      const unservable = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/import-batches`);
      expect(unservable.status).toBe(409);
      expect(unservable.body.error.code).toBe('PORTFOLIO_VAULT_CAPTURE_UNSERVABLE');
      expect(unservable.headers['cache-control']).toContain('no-store');

      const movedIn = await agent
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-in`)
        .set(...XRW)
        .send(moveInBody(user.password));
      expect(movedIn.status, JSON.stringify(movedIn.body)).toBe(200);
      expect(movedIn.headers['cache-control']).toContain('no-store');
      expect(movedIn.body).toMatchObject({ portfolioId, vaultId: VAULT_ID, docVersion: 7 });

      const challenge = await agent
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-out/challenge`)
        .set(...XRW)
        .send(moveOutChallengeBody());
      expect(challenge.status, JSON.stringify(challenge.body)).toBe(200);
      expect(challenge.headers['cache-control']).toContain('no-store');
      expect(challenge.body).toMatchObject({
        portfolioId,
        vaultId: VAULT_ID,
        documentDigest: DOCUMENT_DIGEST,
        documentSetHash: DOCUMENT_SET_HASH,
      });

      const movedOut = await agent
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-out`)
        .set(...XRW)
        .send(moveOutBody(user.id, portfolioId, user.password));
      expect(movedOut.status, JSON.stringify(movedOut.body)).toBe(200);
      expect(movedOut.headers['cache-control']).toContain('no-store');
      expect(movedOut.body).toMatchObject({
        portfolioId,
        vaultId: VAULT_ID,
        moveOutId: MOVE_OUT_ID,
      });

      expect(spies.revision).toHaveBeenCalledWith(user.id, portfolioId);
      expect(spies.lifecycle).toHaveBeenCalledWith(user.id, portfolioId);
      expect(spies.moveIn).toHaveBeenCalledOnce();
      expect(spies.moveOutChallenge).toHaveBeenCalledOnce();
      expect(spies.moveOut).toHaveBeenCalledOnce();
    },
  );

  it('strictly rejects a missing stepUp on both commits before any service or database mutation', async () => {
    const harness = await createTestApp();
    const { user, portfolioId, agent } = await seedPrincipal(harness, 'missing-step-up');
    const spies = stubTransitions(harness, portfolioId);
    const [beforePortfolio] = await harness.db
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId));
    const [beforeStateCount] = await harness.db
      .select({ value: count() })
      .from(portfolioVaultTransitionStates);

    const { stepUp: _moveInStepUp, ...withoutMoveInStepUp } = moveInBody(user.password);
    const moveIn = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault/move-in`)
      .set(...XRW)
      .send(withoutMoveInStepUp);
    expect(moveIn.status).toBe(400);
    expect(moveIn.body.error.code).toBe('VALIDATION_ERROR');
    expect(moveIn.headers['cache-control']).toContain('no-store');

    const { stepUp: _moveOutStepUp, ...withoutMoveOutStepUp } = moveOutBody(
      user.id,
      portfolioId,
      user.password,
    );
    const moveOut = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault/move-out`)
      .set(...XRW)
      .send(withoutMoveOutStepUp);
    expect(moveOut.status).toBe(400);
    expect(moveOut.body.error.code).toBe('VALIDATION_ERROR');
    expect(moveOut.headers['cache-control']).toContain('no-store');

    expect(spies.moveIn).not.toHaveBeenCalled();
    expect(spies.moveOut).not.toHaveBeenCalled();
    expect(
      (await harness.db.select().from(portfolios).where(eq(portfolios.id, portfolioId)))[0],
    ).toEqual(beforePortfolio);
    const [afterStateCount] = await harness.db
      .select({ value: count() })
      .from(portfolioVaultTransitionStates);
    expect(Number(afterStateCount?.value ?? 0)).toBe(Number(beforeStateCount?.value ?? 0));
  });

  it('admits account:security bearers, reports the missing scope, and default-closes a future sibling', async () => {
    const harness = await createTestApp();
    const { user, portfolioId } = await seedPrincipal(harness, 'bearer');
    const spies = stubTransitions(harness, portfolioId);
    const allowedToken = await mintKey(harness, user.id, 'E4 allowed TEST VECTOR', [
      'account:security',
    ]);
    const deniedToken = await mintKey(harness, user.id, 'E4 denied TEST VECTOR', ['market:read']);

    const allowedRevision = await request(harness.app)
      .get(`/api/v1/portfolios/${portfolioId}/vault/revision`)
      .set(bearer(allowedToken));
    const allowedMoveIn = await request(harness.app)
      .post(`/api/v1/portfolios/${portfolioId}/vault/move-in`)
      .set(bearer(allowedToken))
      .send(moveInBody(user.password));
    const allowedChallenge = await request(harness.app)
      .post(`/api/v1/portfolios/${portfolioId}/vault/move-out/challenge`)
      .set(bearer(allowedToken))
      .send(moveOutChallengeBody());
    const allowedMoveOut = await request(harness.app)
      .post(`/api/v1/portfolios/${portfolioId}/vault/move-out`)
      .set(bearer(allowedToken))
      .send(moveOutBody(user.id, portfolioId, user.password));
    for (const response of [allowedRevision, allowedMoveIn, allowedChallenge, allowedMoveOut]) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
    }

    const deniedCalls = [
      request(harness.app)
        .get(`/api/v1/portfolios/${portfolioId}/vault/revision`)
        .set(bearer(deniedToken)),
      request(harness.app)
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-in`)
        .set(bearer(deniedToken))
        .send(moveInBody(user.password)),
      request(harness.app)
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-out/challenge`)
        .set(bearer(deniedToken))
        .send(moveOutChallengeBody()),
      request(harness.app)
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-out`)
        .set(bearer(deniedToken))
        .send(moveOutBody(user.id, portfolioId, user.password)),
    ];
    for (const response of await Promise.all(deniedCalls)) {
      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
        message: expect.stringContaining('account:security'),
      });
    }

    const future = await request(harness.app)
      .post(`/api/v1/portfolios/${portfolioId}/vault/future-transition`)
      .set(bearer(allowedToken))
      .send({});
    expect(future.status).toBe(403);
    expect(future.body.error.code).toBe('API_KEY_FORBIDDEN');

    // #1529 (review F1, Chief ruling): the import-capture read is SESSION-ONLY —
    // closed to the account:security key that the transition routes admit AND
    // to an ordinary portfolio:read key. Raw staging rows never reach a bearer.
    const readerToken = await mintKey(harness, user.id, 'E4 reader TEST VECTOR', [
      'portfolio:read',
    ]);
    for (const token of [allowedToken, readerToken, deniedToken]) {
      const closed = await request(harness.app)
        .get(`/api/v1/portfolios/${portfolioId}/vault/import-batches`)
        .set(bearer(token));
      expect(closed.status).toBe(403);
      expect(closed.body.error.code).toBe('API_KEY_FORBIDDEN');
    }
    expect(spies.captureImportBatches).not.toHaveBeenCalled();
    expect(spies.revision).toHaveBeenCalledOnce();
    expect(spies.moveIn).toHaveBeenCalledOnce();
    expect(spies.moveOutChallenge).toHaveBeenCalledOnce();
    expect(spies.moveOut).toHaveBeenCalledOnce();
  });

  it('puts revision and both commits in the same dedicated vault limiter budget', async () => {
    const harness = await createTestApp({
      rateLimitsEnabled: true,
      env: { BT_VAULT_RATE_LIMIT: '4', BT_VAULT_RATE_WINDOW_SEC: '60' },
    });
    const { user, portfolioId, agent } = await seedPrincipal(harness, 'limiter');
    stubTransitions(harness, portfolioId);

    const accepted = [
      await agent.get(`/api/v1/portfolios/${portfolioId}/vault/revision`),
      await agent
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-in`)
        .set(...XRW)
        .send(moveInBody(user.password)),
      await agent
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-out/challenge`)
        .set(...XRW)
        .send(moveOutChallengeBody()),
      await agent
        .post(`/api/v1/portfolios/${portfolioId}/vault/move-out`)
        .set(...XRW)
        .send(moveOutBody(user.id, portfolioId, user.password)),
    ];
    expect(accepted.map(({ status }) => status)).toEqual([200, 200, 200, 200]);

    const limited = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/revision`);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['cache-control']).toContain('no-store');
  });

  it('accepts move-out JSON at the route-specific byte ceiling and returns typed 413 one byte over', async () => {
    const encryptedPortfolioCap = 1024;
    const harness = await createTestApp({
      env: { BT_VAULT_MAX_BYTES_PORTFOLIO: String(encryptedPortfolioCap) },
    });
    const { user, portfolioId, agent } = await seedPrincipal(harness, 'body-limit');
    const spies = stubTransitions(harness, portfolioId);
    const limit = paranoidRestoreJsonLimitBytes(encryptedPortfolioCap);
    const base = JSON.stringify(moveOutBody(user.id, portfolioId, user.password));
    const baseBytes = Buffer.byteLength(base);
    expect(baseBytes).toBeLessThan(limit);
    const atLimit = Buffer.from(`${base}${' '.repeat(limit - baseBytes)}`);
    expect(atLimit.byteLength).toBe(limit);

    const accepted = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault/move-out`)
      .set(...XRW)
      .set('Content-Type', 'application/json')
      .send(atLimit.toString('utf8'));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.headers['cache-control']).toContain('no-store');
    expect(spies.moveOut).toHaveBeenCalledOnce();

    const rejected = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault/move-out`)
      .set(...XRW)
      .set('Content-Type', 'application/json')
      .send(`${atLimit.toString('utf8')} `);
    expect(rejected.status).toBe(413);
    expect(rejected.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(rejected.headers['cache-control']).toContain('no-store');
    expect(spies.moveOut).toHaveBeenCalledOnce();
  });

  it('keeps the mounted-route and generated-OpenAPI censuses converged', () => {
    const expectedMounted = [
      'GET /api/v1/portfolios/{portfolioId}/vault/import-batches',
      'GET /api/v1/portfolios/{portfolioId}/vault/lifecycle',
      'GET /api/v1/portfolios/{portfolioId}/vault/revision',
      'POST /api/v1/portfolios/{portfolioId}/vault/move-in',
      'POST /api/v1/portfolios/{portfolioId}/vault/move-out',
      'POST /api/v1/portfolios/{portfolioId}/vault/move-out/challenge',
    ];
    const mounted = buildRouteTable()
      .flatMap((surface) =>
        surface.kind === 'route' &&
        surface.path.startsWith('/api/v1/portfolios/{portfolioId}/vault/')
          ? [`${surface.method} ${surface.path}`]
          : [],
      )
      .sort();
    expect(mounted).toEqual(expectedMounted);

    const coverage = checkCoverage();
    expect(coverage).toMatchObject({
      ok: true,
      missing: [],
      phantom: [],
      bearerModules: { ok: true },
    });

    const paths = getOpenApiDocument().paths;
    const moveOut = paths['/portfolios/{portfolioId}/vault/move-out']?.post;
    expect(moveOut?.responses).toHaveProperty('413');
  });
});

// ── GHSA-mrhx-c7xc-m3w5: authorize before parse, bounded restore validation ──
//
// zod 3 accumulates one issue per failing element (per missing field) and this
// route reads up to 8× the encrypted cap, so before the mitigation ANY logged-in
// account could make the API build a heap-sized issue list from one request.

const HEAVY_ENTITY_COUNT = 100_000;

/** A move-out body of ≥ 1 MiB whose document carries 100k garbage entities. */
function garbageMoveOutJson(userId: string, portfolioId: string, password: string): string {
  const base = moveOutBody(userId, portfolioId, password);
  const entities = `[${new Array(HEAVY_ENTITY_COUNT).fill('{"g":"xx"}').join(',')}]`;
  const json = JSON.stringify({
    ...base,
    document: { ...base.document, entities: '__ENTITIES__' },
  }).replace('"__ENTITIES__"', entities);
  expect(Buffer.byteLength(json)).toBeGreaterThanOrEqual(1024 * 1024);
  return json;
}

/**
 * ≈1 MiB of entities each padded past the byte floor, so the LENGTH pre-check
 * admits them and only the element-at-a-time pass can stop the flood. Each is
 * 26 issues on its own (25 missing importRow fields + the unknown `pad`).
 */
function paddedInvalidMoveOutJson(userId: string, portfolioId: string, password: string): string {
  const base = moveOutBody(userId, portfolioId, password);
  const entity = JSON.stringify({ kind: 'importRow', data: {}, pad: 'p'.repeat(170) });
  const entities = `[${new Array(5_000).fill(entity).join(',')}]`;
  return JSON.stringify({
    ...base,
    document: { ...base.document, entities: '__ENTITIES__' },
  }).replace('"__ENTITIES__"', entities);
}

/** Puts the principal's portfolio into a (test-vector) vault, so move-out is legitimate. */
async function vaultPortfolio(harness: TestHarness, principal: Principal): Promise<void> {
  await harness.db.insert(vaults).values({
    id: VAULT_ID,
    userId: principal.user.id,
    name: 'TEST VECTOR vault',
    headerDocId: '018f0000-0000-7000-8000-00000000e404',
    commonDocId: '018f0000-0000-7000-8000-00000000e405',
    media: ['server'],
    driveConnectionId: null,
    retirementProofPublicKey: 'deterministic-test-vector-public-proof',
    keyFingerprint: 'deterministic-test-vector-fingerprint',
  });
  await harness.db
    .update(portfolios)
    .set({ vaultId: VAULT_ID })
    .where(eq(portfolios.id, principal.portfolioId));
}

/** Spies that prove what the server did NOT do with the body. */
function parseProbes() {
  const jsonParse = vi.spyOn(JSON, 'parse');
  const requestParse = vi.spyOn(portfolioVaultMoveOutRequestSchema, 'safeParse');
  const elementParse = vi.spyOn(vaultStrictEntitySchema, '_parse');
  return {
    parsedBody: () =>
      jsonParse.mock.calls.some(([text]) => typeof text === 'string' && text.length > 500_000),
    requestParse,
    elementParse,
    restore: () => {
      jsonParse.mockRestore();
      requestParse.mockRestore();
      elementParse.mockRestore();
    },
  };
}

async function timedPost(send: () => Promise<request.Response>) {
  const started = performance.now();
  const response = await send();
  return { response, elapsedMs: performance.now() - started };
}

interface RawResponse {
  status: number;
  body: { error?: { code?: string } };
  headers: IncomingHttpHeaders;
  elapsedMs: number;
}

/**
 * POST over a raw socket. A refusal BEFORE the body is read answers while the
 * upload is still in flight, and Node may then reset the connection under the
 * remaining bytes — supertest surfaces that as `write ECONNRESET` instead of the
 * response. That reset is the behaviour under test (the server never buffers
 * the body), so a write error after the response arrived is not a failure.
 */
async function rawPost(
  harness: TestHarness,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<RawResponse> {
  const server = createServer(harness.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const started = performance.now();
    return await new Promise<RawResponse>((resolve, reject) => {
      let responded = false;
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            [XRW[0]]: XRW[1],
            ...headers,
          },
        },
        (res) => {
          responded = true;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
              headers: res.headers,
              elapsedMs: performance.now() - started,
            }),
          );
        },
      );
      req.on('error', (error) => {
        if (!responded) reject(error);
      });
      req.end(body);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The session cookie a fresh login mints for `user`, as a `Cookie` header value. */
async function sessionCookie(harness: TestHarness, user: SeededUser): Promise<string> {
  const login = await request(harness.app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(login.status).toBe(200);
  const cookies = ([] as string[]).concat(login.headers['set-cookie'] ?? []);
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

describe('E4 move-out: authorize before parse, bounded restore validation (GHSA-mrhx-c7xc-m3w5)', () => {
  it(
    'refuses anonymous and unrelated callers before the body is read',
    { timeout: 60_000 },
    async () => {
      const harness = await createTestApp();
      const owner = await seedPrincipal(harness, 'heavy-owner');
      const stranger = await seedPrincipal(harness, 'heavy-stranger');
      await vaultPortfolio(harness, owner);
      const spies = stubTransitions(harness, owner.portfolioId);
      const body = garbageMoveOutJson(owner.user.id, owner.portfolioId, owner.user.password);
      const path = `/api/v1/portfolios/${owner.portfolioId}/vault/move-out`;
      const strangerCookie = await sessionCookie(harness, stranger.user);
      // Warm both paths once so first-request lazy init is not what gets timed.
      await rawPost(harness, path, {}, '{}');
      await rawPost(harness, path, { Cookie: strangerCookie }, '{}');

      const probes = parseProbes();
      try {
        const anonymous = await rawPost(harness, path, {}, body);
        expect(anonymous.status).toBe(401);
        expect(anonymous.elapsedMs).toBeLessThan(100);

        const unrelated = await rawPost(harness, path, { Cookie: strangerCookie }, body);
        expect(unrelated.status, JSON.stringify(unrelated.body).slice(0, 300)).toBe(404);
        expect(unrelated.body.error?.code).toBe('PORTFOLIO_VAULT_NOT_FOUND');
        expect(unrelated.headers['cache-control']).toContain('no-store');
        expect(unrelated.elapsedMs).toBeLessThan(100);

        // Neither request was JSON-parsed, schema-parsed, or produced an issue.
        expect(probes.parsedBody()).toBe(false);
        expect(probes.requestParse).not.toHaveBeenCalled();
        expect(probes.elementParse).not.toHaveBeenCalled();
      } finally {
        probes.restore();
      }
      expect(spies.moveOut).not.toHaveBeenCalled();
    },
  );

  it(
    'answers the vault owner’s garbage flood from the length pre-check, with no element validation',
    { timeout: 60_000 },
    async () => {
      const harness = await createTestApp();
      const owner = await seedPrincipal(harness, 'heavy-flood');
      await vaultPortfolio(harness, owner);
      const spies = stubTransitions(harness, owner.portfolioId);
      const body = garbageMoveOutJson(owner.user.id, owner.portfolioId, owner.user.password);

      const probes = parseProbes();
      try {
        const { response, elapsedMs } = await timedPost(() =>
          owner.agent
            .post(`/api/v1/portfolios/${owner.portfolioId}/vault/move-out`)
            .set(...XRW)
            .set('Content-Type', 'application/json')
            .send(body),
        );
        expect(response.status, JSON.stringify(response.body).slice(0, 300)).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.headers['cache-control']).toContain('no-store');
        const details = validationErrorDetailsSchema.parse(response.body.error.details);
        expect(details.issueCount).toBe(1);
        expect(details.fieldErrors.document).toHaveLength(1);
        // The owner IS admitted to the wide parser — the body was read…
        expect(probes.parsedBody()).toBe(true);
        // …but no element was validated and the full schema never ran.
        expect(probes.elementParse).not.toHaveBeenCalled();
        expect(probes.requestParse).not.toHaveBeenCalled();
        expect(elapsedMs).toBeLessThan(1_000);
      } finally {
        probes.restore();
      }
      expect(spies.moveOut).not.toHaveBeenCalled();
    },
  );

  it(
    'stops a padded flood at its first invalid entity and returns 20 issues plus the count',
    { timeout: 60_000 },
    async () => {
      const harness = await createTestApp();
      const owner = await seedPrincipal(harness, 'heavy-padded');
      await vaultPortfolio(harness, owner);
      const spies = stubTransitions(harness, owner.portfolioId);
      const body = paddedInvalidMoveOutJson(owner.user.id, owner.portfolioId, owner.user.password);

      const probes = parseProbes();
      try {
        const { response, elapsedMs } = await timedPost(() =>
          owner.agent
            .post(`/api/v1/portfolios/${owner.portfolioId}/vault/move-out`)
            .set(...XRW)
            .set('Content-Type', 'application/json')
            .send(body),
        );
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        const details = validationErrorDetailsSchema.parse(response.body.error.details);
        // ONE entity's issues (26), not 5,000 × 26 — and only 20 of them shipped.
        expect(details.issueCount).toBe(26);
        expect(details.fieldErrors.document).toHaveLength(VALIDATION_ERROR_ISSUES_MAX);
        expect(probes.elementParse).toHaveBeenCalledTimes(1);
        expect(probes.requestParse).not.toHaveBeenCalled();
        expect(elapsedMs).toBeLessThan(1_000);
      } finally {
        probes.restore();
      }
      expect(spies.moveOut).not.toHaveBeenCalled();
    },
  );

  it(
    'spends the wide bound on a move-out receipt retry, the narrow one on a plain portfolio',
    { timeout: 60_000 },
    async () => {
      const harness = await createTestApp();
      const owner = await seedPrincipal(harness, 'heavy-bounds');
      const spies = stubTransitions(harness, owner.portfolioId);
      // A valid body just over the 100 KiB global bound (the padding is
      // insignificant whitespace, so the document itself stays valid).
      const base = JSON.stringify(
        moveOutBody(owner.user.id, owner.portfolioId, owner.user.password),
      );
      const overGlobal = `${base}${' '.repeat(GLOBAL_JSON_BODY_LIMIT + 1 - Buffer.byteLength(base))}`;
      const path = `/api/v1/portfolios/${owner.portfolioId}/vault/move-out`;
      const post = () =>
        owner.agent
          .post(path)
          .set(...XRW)
          .set('Content-Type', 'application/json')
          .send(overGlobal);

      // Plain, never-vaulted portfolio: the owner gets the global bound only.
      const plain = await post();
      expect(plain.status).toBe(413);
      expect(plain.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(spies.moveOut).not.toHaveBeenCalled();

      // The same portfolio after a committed move-out (no longer vaulted, receipt
      // kept): an outcome-ambiguous retry re-sends the full document and must
      // reach the commit's idempotent replay, not a 413.
      await harness.db.insert(portfolioVaultTransitionStates).values({
        portfolioId: owner.portfolioId,
        userId: owner.user.id,
        lifecycleGeneration: 1,
        moveInVaultId: VAULT_ID,
        moveInDocVersion: 7,
        moveInCompletedAt: new Date(EDITED_AT),
        moveOutVaultId: VAULT_ID,
        moveOutId: MOVE_OUT_ID,
        moveOutDocumentDigest: DOCUMENT_DIGEST,
        moveOutDocumentSetHash: DOCUMENT_SET_HASH,
        moveOutProofPublicKey: 'deterministic-test-vector-public-proof',
        moveOutCompletedAt: new Date(EDITED_AT),
      });
      const retry = await post();
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(spies.moveOut).toHaveBeenCalledOnce();
    },
  );
});
