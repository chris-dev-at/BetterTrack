import { count, eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKeyScope, VaultStrictDocumentV1 } from '@bettertrack/contracts';

import { portfolioVaultTransitionStates, portfolios } from '../data/schema';
import { paranoidRestoreJsonLimitBytes } from '../http/bodyLimits';
import { getOpenApiDocument } from '../http/openapi';
import { buildRouteTable, checkCoverage } from '../scripts/checkOpenapiCoverage';
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
    .mockResolvedValue({ portfolioDataRevision: REVISION });
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
  return { revision, moveIn, moveOutChallenge, moveOut };
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
  it('mounts all four cookie-session routes and marks every successful response no-store', async () => {
    const harness = await createTestApp();
    const { user, portfolioId, agent } = await seedPrincipal(harness, 'cookie');
    const spies = stubTransitions(harness, portfolioId);

    const revision = await agent.get(`/api/v1/portfolios/${portfolioId}/vault/revision`);
    expect(revision.status, JSON.stringify(revision.body)).toBe(200);
    expect(revision.headers['cache-control']).toContain('no-store');
    expect(revision.body).toEqual({ portfolioDataRevision: REVISION });

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
    expect(movedOut.body).toMatchObject({ portfolioId, vaultId: VAULT_ID, moveOutId: MOVE_OUT_ID });

    expect(spies.revision).toHaveBeenCalledWith(user.id, portfolioId);
    expect(spies.moveIn).toHaveBeenCalledOnce();
    expect(spies.moveOutChallenge).toHaveBeenCalledOnce();
    expect(spies.moveOut).toHaveBeenCalledOnce();
  });

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
