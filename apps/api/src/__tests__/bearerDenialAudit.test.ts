import { createHash, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import {
  createApiKeyResponseSchema,
  createOAuthClientResponseSchema,
  oauthTokenResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { forbidden } from '../errors';
import { createErrorHandler } from '../http/errorHandler';
import { ACCOUNT_SECURITY_SCOPE, recordBearerScopeDenied } from '../http/middleware/bearerAuth';
import { requireCookieSessionOrPasskeyManagementBearer } from '../http/routes/authRoutes';
import { requireCookieSessionOrFirstPartyOAuthGrant } from '../http/routes/settingsRoutes';
import { parseBearerScopeDeniedMeta } from '../services/audit/auditService';
import { hashToken } from '../services/crypto/tokens';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * #1951 — the adversarial half of the bearer-denial audit work.
 *
 * `bearerAdmissionParity.test.ts` next door pins that no admission DECISION
 * moved; this file pins what the refusals WRITE, and what they must never
 * write. The rows here are the ones a reviewer asked for by name: a third-party
 * grant and a personal key on the first-party-only grant routes, the #1324
 * surface a personal key must still be ADMITTED to, a secret smuggled in a query
 * string, and the failure mode of the vocabulary fence itself.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';
const THIRD_PARTY_REDIRECT = 'https://third-party.example/callback';
/** Not a credential — a TEST VECTOR shaped like one, to prove it never lands. */
const SMUGGLED_SECRET = 'btk_not-a-real-token-abcdefghijklmnop';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
type Agent = ReturnType<typeof request.agent>;
type TestUser = Awaited<ReturnType<TestHarness['seedUser']>>;

async function seedFreshUser(): Promise<TestUser> {
  const tag = randomBytes(5).toString('hex');
  return harness.seedUser({
    email: `denial-${tag}@bettertrack.test`,
    username: `denial${tag}`,
  });
}

async function login(user: TestUser): Promise<Agent> {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return agent;
}

async function mintPersonalKey(
  scopes: string[],
): Promise<{ token: string; keyId: string; user: TestUser }> {
  const user = await seedFreshUser();
  const agent = await login(user);
  const res = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'denial probe', scopes });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const parsed = createApiKeyResponseSchema.parse(res.body);
  return { token: parsed.token, keyId: parsed.key.id, user };
}

/** A grant on a client the USER registered themselves — genuinely third-party. */
async function mintThirdPartyToken(
  scopes: string[],
): Promise<{ token: string; grantId: string; user: TestUser }> {
  const user = await seedFreshUser();
  const agent = await login(user);
  const registered = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Throwaway third party',
      redirectUris: [THIRD_PARTY_REDIRECT],
      scopes,
      public: true,
    });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const client = createOAuthClientResponseSchema.parse(registered.body).client;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const approved = await agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({
      client_id: client.clientId,
      redirect_uri: THIRD_PARTY_REDIRECT,
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const code = new URL(approved.body.redirectTo as string).searchParams.get('code');

  const exchanged = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: THIRD_PARTY_REDIRECT,
    client_id: client.clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
  const token = oauthTokenResponseSchema.parse(exchanged.body).access_token;

  const grants = await harness.db
    .select()
    .from(schema.oauthGrants)
    .where(eq(schema.oauthGrants.userId, user.id));
  expect(grants).toHaveLength(1);
  return { token, grantId: grants[0]!.id, user };
}

/** ORDER BY, always — Postgres guarantees none, and `id` is a UUIDv7. */
const scopeDeniedRows = (userId: string) =>
  harness.db
    .select()
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.actorId, userId), eq(schema.auditLog.action, 'api_key.scope_denied')),
    )
    .orderBy(schema.auditLog.id);

describe('#1951 L1 — a vocabulary failure is REPORTED, never a silent 400', () => {
  /**
   * The fence added in §1 can only fire on a mis-wired writer. What it does THEN
   * is the whole question: `createErrorHandler` answers a `ZodError` with
   * `400 VALIDATION_ERROR` and returns before `reportUnexpected`, so a raw
   * `.parse()` would have turned the day this fence catches a real bug into a
   * refusal path quietly answering 400 with no Problems row and no log line.
   * These tests pin the opposite outcome end to end, through the REAL error
   * handler and the REAL problem capture.
   */
  it('answers 500 INTERNAL and captures a problem — not 400, and never an admission', async () => {
    const user = await seedFreshUser();
    let admitted = false;

    // The twins' exact wiring on a throwaway router: the audit promise resolves
    // into the refusal, and rejects into `next`.
    const app = express();
    app.get('/probe', (req, _res, next) => {
      Object.assign(req, {
        authUser: { id: user.id },
        apiKey: { id: MISSING_ID, kind: 'personal', scopes: [], securityGeneration: 0 },
      });
      recordBearerScopeDenied(
        harness.ctx,
        req,
        ACCOUNT_SECURITY_SCOPE,
        'totally-made-up' as never,
      ).then(() => {
        admitted = true;
        next(forbidden('unreachable', 'API_KEY_FORBIDDEN'));
      }, next);
    });
    app.use(
      createErrorHandler(harness.ctx.logger, (err, context) =>
        harness.ctx.problems.captureError(err, context),
      ),
    );

    const res = await request(app).get('/probe');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    // The regression this test exists for: a ZodError would have produced this.
    expect(res.status).not.toBe(400);
    expect(res.body.error.code).not.toBe('VALIDATION_ERROR');
    // The refusal path never becomes an admission, loud failure or not.
    expect(admitted).toBe(false);

    await harness.ctx.problems.flush();
    const captured = await harness.db.select().from(schema.problems);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe('error');
    // The report names the rail that refused, so the bad writer is findable.
    expect(captured[0]!.message).toContain('recordBearerScopeDenied');

    // …and nothing was persisted to the audit trail.
    expect(await scopeDeniedRows(user.id)).toHaveLength(0);
  });

  it.each([
    ['apiKeyService.recordScopeDenied', 'personal'],
    ['oauthService.recordScopeDenied', 'oauth'],
  ] as const)('rejects out of %s with a reportable non-Zod error', async (writer, kind) => {
    const user = await seedFreshUser();
    const call =
      kind === 'personal'
        ? harness.ctx.apiKeys.recordScopeDenied({
            userId: user.id,
            keyId: MISSING_ID,
            requiredScope: ACCOUNT_SECURITY_SCOPE,
            reason: 'totally-made-up' as never,
            method: 'GET',
            path: '/auth/passkeys',
          })
        : harness.ctx.oauth.recordScopeDenied({
            userId: user.id,
            grantId: MISSING_ID,
            requiredScope: ACCOUNT_SECURITY_SCOPE,
            reason: 'totally-made-up' as never,
            method: 'GET',
            path: '/settings/oauth-grants',
          });

    const error = await call.then(
      () => {
        throw new Error('expected the writer to refuse');
      },
      (err: unknown) => err,
    );
    // A `ZodError` here is the defect: the handler would answer 400 and report
    // nothing. It must be a plain Error naming the writer.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ZodError);
    expect((error as Error).message).toContain(writer);
    expect((error as Error).message).toContain('reason');
    expect(await scopeDeniedRows(user.id)).toHaveLength(0);
  });

  /**
   * What `.strict()` actually buys, stated honestly.
   *
   * It fires on the PARSE OBJECT, so it guards a future writer that spreads
   * caller input into the meta (`{ ...input, reason }`) — the shape that would
   * carry a presented credential into a 400-day store. It does NOT fire for
   * today's two writers, which destructure a fixed field list: an extra
   * property is dropped before the parse ever sees it. Both facts are pinned,
   * because the second is the one a reader would otherwise assume away.
   */
  it('refuses an unrecognized key at the contract, naming the KEY and never its value', () => {
    const smuggled = () =>
      parseBearerScopeDeniedMeta('futureWriter.recordScopeDenied', {
        requiredScope: ACCOUNT_SECURITY_SCOPE,
        reason: 'insufficient-scope',
        method: 'GET',
        path: '/auth/passkeys',
        token: SMUGGLED_SECRET,
      });

    expect(smuggled).toThrow(/unrecognized_keys/);
    expect(smuggled).toThrow(/token/);
    expect(smuggled).toThrow(/futureWriter\.recordScopeDenied/);
    // The message reaches the log and the admin Problems page: the KEY name is
    // what makes the defect fixable, the VALUE must never travel with it.
    let message = '';
    try {
      smuggled();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(SMUGGLED_SECRET);
    expect(message).not.toBeInstanceOf(ZodError);
  });

  it('drops — rather than refuses — an extra property, because the writers destructure', async () => {
    const { user, keyId } = await mintPersonalKey(['market:read']);
    await harness.ctx.apiKeys.recordScopeDenied({
      userId: user.id,
      keyId,
      requiredScope: ACCOUNT_SECURITY_SCOPE,
      reason: 'insufficient-scope',
      method: 'GET',
      path: '/auth/passkeys',
      // Never reaches the parse: `recordScopeDenied` names the fields it reads.
      token: SMUGGLED_SECRET,
    } as never);

    const rows = await scopeDeniedRows(user.id);
    expect(rows).toHaveLength(1);
    // The outcome that matters is the same either way — the row is clean — and
    // the row's key set is exactly the contract's, with nothing extra.
    expect(Object.keys(rows[0]!.meta as object).sort()).toEqual([
      'method',
      'path',
      'reason',
      'requiredScope',
    ]);
    expect(JSON.stringify(rows[0])).not.toContain(SMUGGLED_SECRET);
  });
});

describe('#1951 adversarial denial rows', () => {
  it('A1 — a third-party grant HOLDING account:security is refused and audited on both grant routes', async () => {
    const { token, grantId, user } = await mintThirdPartyToken([ACCOUNT_SECURITY_SCOPE]);

    const listed = await request(harness.app)
      .get('/api/v1/settings/oauth-grants')
      .set(bearer(token));
    const revoked = await request(harness.app)
      .delete(`/api/v1/settings/oauth-grants/${grantId}`)
      .set(bearer(token));

    for (const response of [listed, revoked]) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_FORBIDDEN');
    }

    const rows = await scopeDeniedRows(user.id);
    // Exactly one row per refusal — two refusals, two rows, never four.
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // It HELD the scope: this is the trust-boundary refusal the discriminator
      // exists to make greppable, and the credential kind must be legible.
      expect(row.meta).toMatchObject({
        requiredScope: ACCOUNT_SECURITY_SCOPE,
        reason: 'first-party-only',
        kind: 'oauth',
      });
      expect(row.targetType).toBe('oauth_grant');
      expect(row.targetId).toBe(grantId);
    }
    expect(rows.map((row) => (row.meta as { method?: string }).method)).toEqual(['GET', 'DELETE']);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(hashToken(token));
  });

  it('A2 — a personal key HOLDING account:security is refused and audited as the api_key it is', async () => {
    const { token, keyId, user } = await mintPersonalKey([ACCOUNT_SECURITY_SCOPE]);

    const listed = await request(harness.app)
      .get('/api/v1/settings/oauth-grants')
      .set(bearer(token));
    expect(listed.status, JSON.stringify(listed.body)).toBe(403);
    expect(listed.body.error.code).toBe('API_KEY_FORBIDDEN');

    const rows = await scopeDeniedRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetType).toBe('api_key');
    expect(rows[0]!.targetId).toBe(keyId);
    expect(rows[0]!.meta).toMatchObject({
      requiredScope: ACCOUNT_SECURITY_SCOPE,
      reason: 'first-party-only',
      method: 'GET',
      path: '/settings/oauth-grants',
    });
    // The `kind` discriminator belongs to the OAuth twin ALONE: a personal-key
    // row that grew one would make the two shapes indistinguishable.
    expect(rows[0]!.meta).not.toHaveProperty('kind');
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(JSON.stringify(rows[0])).not.toContain(hashToken(token));
  });

  it('A3 — a personal key with account:security is still ADMITTED to passkey management (#1324)', async () => {
    const { token, user } = await mintPersonalKey([ACCOUNT_SECURITY_SCOPE]);

    // Admitted past both the global rail and the router-local twin: the 404 is
    // the HANDLER answering about a passkey that does not exist, which is only
    // reachable once the request got through. A twin that grew a credential-kind
    // check would answer 403 here instead — the narrowing #1951 §3 forbids.
    const renamed = await request(harness.app)
      .patch(`/api/v1/auth/passkeys/${MISSING_ID}`)
      .set(bearer(token))
      .send({ name: 'Phone' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(404);
    expect(renamed.body.error.code).toBe('PASSKEY_NOT_FOUND');

    // An admission is never a denial: no row, from either writer.
    expect(await scopeDeniedRows(user.id)).toHaveLength(0);
  });

  it('A4 — a secret smuggled in the query string never reaches the row', async () => {
    const { token, user } = await mintPersonalKey(['market:read']);

    // Two refusals on two rails: the global scope rail and, for good measure,
    // the same query on an account-security route.
    const denied = await request(harness.app)
      .get(`/api/v1/auth/passkeys?access_token=${SMUGGLED_SECRET}&pin=1234`)
      .set(bearer(token));
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const rows = await scopeDeniedRows(user.id);
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.meta as { path: string };
    // `meta.path` is the ROUTE, never the request target: no query survives it.
    expect(meta.path).toBe('/auth/passkeys');
    expect(meta.path).not.toContain('?');
    expect(meta.path).not.toContain('access_token');

    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(SMUGGLED_SECRET);
    expect(serialized).not.toContain(hashToken(SMUGGLED_SECRET));
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(hashToken(token));
    expect(serialized).not.toContain('1234');
  });
});

describe('#1951 the TWIN is what writes the row when the rail is bypassed', () => {
  /**
   * The red-proof for §2, as a count.
   *
   * In production the global rail answers first and the twins never run, so an
   * end-to-end test can only ever prove "not two rows". The fact #1951 actually
   * adds is what happens when the rail is bypassed — a policy-table regression,
   * or a direct router mount — and the only way to observe it is to invoke the
   * twin with no rail in front of it, exactly as this does. On the parent commit
   * both counts below are ZERO: the twins refused silently. That is the whole
   * defect, and the count is the assertion that fixes it.
   */
  const driveTwin = async (
    guard: ReturnType<typeof requireCookieSessionOrFirstPartyOAuthGrant>,
    req: Record<string, unknown>,
  ) => {
    const next = vi.fn();
    guard(req as unknown as Request, {} as Response, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    return next;
  };

  it('the grant twin writes exactly one row for a refusal the rail never saw', async () => {
    const user = await seedFreshUser();
    const next = await driveTwin(requireCookieSessionOrFirstPartyOAuthGrant(harness.ctx), {
      authUser: { id: user.id },
      apiKey: {
        id: MISSING_ID,
        scopes: [ACCOUNT_SECURITY_SCOPE],
        kind: 'oauth',
        firstParty: false,
        securityGeneration: 0,
      },
      method: 'GET',
      path: '/oauth-grants',
    });

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 403,
      code: 'API_KEY_FORBIDDEN',
    });
    const rows = await scopeDeniedRows(user.id);
    expect(rows).toHaveLength(1); // parent: 0
    expect(rows[0]!.meta).toMatchObject({ reason: 'first-party-only' });
  });

  it('the passkey twin writes exactly one row for a refusal the rail never saw', async () => {
    const user = await seedFreshUser();
    const next = await driveTwin(requireCookieSessionOrPasskeyManagementBearer(harness.ctx), {
      authUser: { id: user.id },
      apiKey: {
        id: MISSING_ID,
        scopes: ['market:read'],
        kind: 'personal',
        securityGeneration: 0,
      },
      method: 'GET',
      path: '/passkeys',
    });

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 403,
      code: 'API_KEY_FORBIDDEN',
    });
    const rows = await scopeDeniedRows(user.id);
    expect(rows).toHaveLength(1); // parent: 0
    expect(rows[0]!.meta).toMatchObject({
      reason: 'insufficient-scope',
      path: '/auth/passkeys',
    });
  });
});
