import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { Application, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeVaultEnvelope,
  oauthAuthorizationDetailsResponseSchema,
  oauthTokenResponseSchema,
  VAULT_CONTENT_CIPHER,
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import { auditLog, paranoidEnableTransitions, paranoidVaults, users } from '../data/schema';
import {
  PORTFOLIO_VAULT_ACCOUNT_SECURITY_BEARER_ROUTE_ALLOWLIST,
  VAULT_ACCOUNT_SECURITY_BEARER_ROUTE_ALLOWLIST,
  VAULT_SESSION_ONLY_ROUTES,
  VAULT_SYNC_BEARER_ROUTE_ALLOWLIST,
  enforceApiKeyScope,
  openApiPathTemplateAcceptsBearer,
  pathAcceptsBearer,
  portfolioVaultAccountSecurityRouteAcceptsBearer,
  vaultAccountSecurityRouteAcceptsBearer,
  vaultSyncRouteAcceptsBearer,
} from '../http/middleware/bearerAuth';
import { buildRouteTable, type MountedSurface } from '../scripts/checkOpenapiCoverage';
import {
  requireCookieSessionOrPerVaultAccess,
  requireCookieSessionOrVaultSync,
} from '../http/routes/vaultRoutes';
import {
  isLegacyParanoidRefusedScope,
  PARANOID_MODE_ERROR_CODE,
} from '../services/account/paranoidEnforcement';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

import {
  BEARER_ALL_METHODS_ROUTE_METHOD,
  BEARER_OPAQUE_MOUNT_METHOD,
  mountedBearerRouteInventory,
} from './bearerRouteInventory';

/**
 * #1043 — the deliberate bearer exception for paranoid-vault synchronization.
 * Sync sees only an opaque BTVAULT1 envelope; every account/media transition
 * remains an owning-browser-session operation.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const OCTET = ['Content-Type', 'application/octet-stream'] as const;
// Deterministic TEST VECTOR identifiers only; none is a credential or secret.
const MOBILE_CLIENT_ID = 'btc_IbT1mzw_7kBiPHPkGfaE0Q';
const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';
const UUID_C = '018f0000-0000-7000-8000-00000000000c';
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let harness: TestHarness;
let sequence = 0;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function loginAgent(
  app: Application,
  user: Pick<SeededUser, 'email' | 'password'>,
): Promise<Agent> {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return agent;
}

async function seedUser(prefix: string): Promise<SeededUser> {
  sequence += 1;
  return harness.seedUser({
    email: `${prefix}-${sequence}@bettertrack.test`,
    username: `${prefix}${sequence}`,
  });
}

async function setParanoidServer(userId: string): Promise<void> {
  await harness.db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['server'],
      paranoidDriveAttestedVersion: null,
      profilePublic: false,
    })
    .where(eq(users.id, userId));
}

async function mintPersonalToken(
  scopes: ApiKeyScope[],
  prefix = 'vaultbearer',
): Promise<{ user: SeededUser; token: string; id: string }> {
  const user = await seedUser(prefix);
  const key = await harness.ctx.apiKeys.create({
    userId: user.id,
    name: `${prefix} key`,
    scopes,
  });
  return { user, token: key.token, id: key.key.id };
}

async function createRealPerVault(userId: string, name: string): Promise<string> {
  const result = await harness.ctx.vaults.create(userId, {
    name,
    headerDocId: UUID_A,
    commonDocId: UUID_B,
    media: ['server'],
    driveConnectionId: null,
    // Deterministic TEST VECTOR (E0's public fingerprint fixture), not a secret.
    keyFingerprint: 'Abcdef0123456789',
    retirementProofPublicKey: ed25519PublicKey(),
  });
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(`vault creation failed: ${result.status}`);
  return result.vault.id;
}

/** A real Ed25519 SPKI verifier — the route parses it in Node before storing it. */
function ed25519PublicKey(): string {
  return generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64url');
}

async function storedProofKey(userId: string): Promise<string | null> {
  const [row] = await harness.db
    .select({ key: paranoidVaults.retirementProofPublicKey })
    .from(paranoidVaults)
    .where(eq(paranoidVaults.userId, userId));
  return row?.key ?? null;
}

/** Build a valid envelope whose ciphertext deliberately is not application data. */
function envelope(vaultVersion: number, ciphertext: Uint8Array): Buffer {
  return Buffer.from(
    encodeVaultEnvelope(
      {
        formatVersion: 1,
        cipher: VAULT_CONTENT_CIPHER,
        iv: 'aXYtOTZiaXQ=',
        keyId: UUID_A,
        wrappedKeys: [
          {
            keyId: UUID_A,
            kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'c2FsdA==' },
            wrappedVk: 'd3JhcHBlZA==',
          },
        ],
        vaultVersion,
        schemaVersion: 1,
        deviceId: UUID_B,
        writeId: UUID_C,
        writtenAt: '2026-08-04T00:00:00.000Z',
      },
      ciphertext,
    ),
  );
}

async function mintFirstPartyVaultToken(): Promise<{ user: SeededUser; token: string }> {
  const mobile = FIRST_PARTY_CLIENTS.find((client) => client.clientId === MOBILE_CLIENT_ID)!;
  expect(mobile.scopeCeiling).toContain('vault:sync');
  await seedFirstPartyClients(createOAuthRepository(harness.db));

  const user = await seedUser('mobilevault');
  const agent = await loginAgent(harness.app, user);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = {
    client_id: mobile.clientId,
    redirect_uri: mobile.redirectUris[0],
    scope: 'vault:sync',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };

  const detailsResponse = await agent.get('/api/v1/oauth/authorization-details').query(authorize);
  expect(detailsResponse.status, JSON.stringify(detailsResponse.body)).toBe(200);
  const details = oauthAuthorizationDetailsResponseSchema.parse(detailsResponse.body);
  expect(details.client.firstParty).toBe(true);
  expect(details.scopes).toEqual([
    {
      scope: 'vault:sync',
      label: 'Synchronize your client-encrypted vault across your devices',
    },
  ]);

  const approval = await agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send(authorize);
  expect(approval.status, JSON.stringify(approval.body)).toBe(200);
  const code = new URL(approval.body.redirectTo as string).searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenResponse = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: mobile.redirectUris[0],
    client_id: mobile.clientId,
    code_verifier: verifier,
  });
  expect(tokenResponse.status, JSON.stringify(tokenResponse.body)).toBe(200);
  return { user, token: oauthTokenResponseSchema.parse(tokenResponse.body).access_token };
}

describe('#1043 vault bearer policy', () => {
  const EXPECTED_ALLOWLIST = [
    { method: 'GET', path: '/vault' },
    { method: 'PUT', path: '/vault' },
    { method: 'GET', path: '/vault/media' },
    { method: 'GET', path: '/vault/history' },
    // The segment matcher is declared by the entry, not inferred from how the
    // placeholder is spelled, so renaming `{version}` cannot widen matching.
    {
      method: 'GET',
      path: '/vault/history/{version}',
      params: { version: 'positive-integer' },
    },
    // #1497: the two config reads share the per-doc scope family so a phone
    // holding only a §13 phrase can discover the vault and its singleton doc ids.
    { method: 'GET', path: '/vaults' },
    { method: 'GET', path: '/vaults/{vaultId}' },
    { method: 'GET', path: '/vaults/{vaultId}/docs/{docId}' },
    { method: 'PUT', path: '/vaults/{vaultId}/docs/{docId}' },
    { method: 'GET', path: '/vaults/{vaultId}/docs/{docId}/history' },
    {
      method: 'GET',
      path: '/vaults/{vaultId}/docs/{docId}/history/{version}',
      params: { version: 'positive-integer' },
    },
    { method: 'GET', path: '/vaults/{vaultId}/media' },
  ] as const;

  const PORTFOLIO_ACCOUNT_SECURITY_ALLOWLIST = [
    { method: 'GET', path: '/portfolios/{portfolioId}/vault/revision' },
    // The §10 exit's CAS input (E6 residual, #1525): the lifecycle read shares
    // the control-plane scope for the same reason the revision read does.
    { method: 'GET', path: '/portfolios/{portfolioId}/vault/lifecycle' },
    { method: 'POST', path: '/portfolios/{portfolioId}/vault/move-in' },
    { method: 'POST', path: '/portfolios/{portfolioId}/vault/move-out/challenge' },
    { method: 'POST', path: '/portfolios/{portfolioId}/vault/move-out' },
  ] as const;

  const ACCOUNT_SECURITY_ALLOWLIST = [
    { method: 'DELETE', path: '/vaults/{vaultId}' },
    ...PORTFOLIO_ACCOUNT_SECURITY_ALLOWLIST,
  ] as const;

  const EXPECTED_SESSION_ONLY = [
    { method: 'PATCH', path: '/vault/media' },
    { method: 'PUT', path: '/vault/media/server-candidate' },
    { method: 'GET', path: '/vault/media/server-candidate/{candidateId}' },
    { method: 'POST', path: '/vault/media/retired/purge/challenge' },
    { method: 'POST', path: '/vault/media/retired/purge' },
    { method: 'POST', path: '/vaults' },
    { method: 'PATCH', path: '/vaults/{vaultId}' },
    { method: 'PATCH', path: '/vaults/{vaultId}/media' },
    {
      method: 'PUT',
      path: '/vaults/{vaultId}/media/server-candidate/{transitionId}/docs/{docId}',
    },
    { method: 'GET', path: '/vaults/{vaultId}/media/server-candidate/{candidateId}' },
    { method: 'POST', path: '/vaults/{vaultId}/media/retired/purge/challenge' },
    { method: 'POST', path: '/vaults/{vaultId}/media/retired/purge' },
  ] as const;

  const SESSION_ONLY = [
    ...EXPECTED_SESSION_ONLY,
    { method: 'POST', path: '/account/paranoid/enable' },
    { method: 'POST', path: '/account/paranoid/disable' },
    { method: 'GET', path: '/account/paranoid/fork-provenance' },
    { method: 'GET', path: '/account/paranoid/normal-revision' },
  ] as const;

  const EXPECTED_ROUTER_GUARDS = [
    {
      method: `${BEARER_OPAQUE_MOUNT_METHOD}:requireUser[1]`,
      path: '/vault',
    },
    {
      method: `${BEARER_OPAQUE_MOUNT_METHOD}:requireCookieSessionOrVaultSync[1]`,
      path: '/vault',
    },
    {
      method: `${BEARER_OPAQUE_MOUNT_METHOD}:requireParanoidHistory[1]`,
      path: '/vault/history',
    },
  ] as const;

  const EXPECTED_PER_VAULT_ROUTER_GUARDS = [
    {
      method: `${BEARER_OPAQUE_MOUNT_METHOD}:requireUser[1]`,
      path: '/vaults',
    },
    {
      method: `${BEARER_OPAQUE_MOUNT_METHOD}:requireCookieSessionOrPerVaultAccess[1]`,
      path: '/vaults',
    },
    {
      method: `${BEARER_OPAQUE_MOUNT_METHOD}:<anonymous>[1]`,
      path: '/vaults',
    },
  ] as const;

  const livePath = (path: string): string =>
    path
      .replaceAll('{vaultId}', UUID_A)
      .replaceAll('{portfolioId}', UUID_A)
      .replaceAll('{docId}', UUID_B)
      .replaceAll('{transitionId}', UUID_C)
      .replaceAll('{candidateId}', MISSING_ID)
      .replaceAll('{version}', '12');

  it('pins the exact sync and account-security routes and defaults every sibling closed', () => {
    expect(VAULT_SYNC_BEARER_ROUTE_ALLOWLIST).toEqual(EXPECTED_ALLOWLIST);
    expect(VAULT_SESSION_ONLY_ROUTES).toEqual(EXPECTED_SESSION_ONLY);
    for (const route of EXPECTED_ALLOWLIST) {
      const path = livePath(route.path);
      expect(vaultSyncRouteAcceptsBearer(route.method, path)).toBe(true);
      expect(pathAcceptsBearer(path, route.method)).toBe(true);
      expect(openApiPathTemplateAcceptsBearer(route.path, route.method)).toBe(true);
    }
    expect(vaultSyncRouteAcceptsBearer('GET', '/vault/history/12')).toBe(true);

    expect(VAULT_ACCOUNT_SECURITY_BEARER_ROUTE_ALLOWLIST).toEqual(ACCOUNT_SECURITY_ALLOWLIST);
    expect(PORTFOLIO_VAULT_ACCOUNT_SECURITY_BEARER_ROUTE_ALLOWLIST).toEqual(
      PORTFOLIO_ACCOUNT_SECURITY_ALLOWLIST,
    );
    for (const route of ACCOUNT_SECURITY_ALLOWLIST) {
      const path = livePath(route.path);
      expect(vaultAccountSecurityRouteAcceptsBearer(route.method, path)).toBe(true);
      expect(pathAcceptsBearer(path, route.method)).toBe(true);
      expect(openApiPathTemplateAcceptsBearer(route.path, route.method)).toBe(true);
    }
    for (const route of PORTFOLIO_ACCOUNT_SECURITY_ALLOWLIST) {
      const path = livePath(route.path);
      expect(portfolioVaultAccountSecurityRouteAcceptsBearer(route.method, path)).toBe(true);
    }

    for (const route of SESSION_ONLY) {
      const path = livePath(route.path);
      expect(pathAcceptsBearer(path, route.method)).toBe(false);
      expect(openApiPathTemplateAcceptsBearer(route.path, route.method)).toBe(false);
    }
    expect(pathAcceptsBearer('/vault/future-transition', 'GET')).toBe(false);
    expect(pathAcceptsBearer('/vault/history/admin', 'GET')).toBe(false);
    expect(pathAcceptsBearer('/vaults/future-transition', 'GET')).toBe(false);
    expect(pathAcceptsBearer(`/vaults/${UUID_A}`, 'POST')).toBe(false);
    expect(pathAcceptsBearer(`/portfolios/${UUID_A}/vault/future-transition`, 'POST')).toBe(false);
    expect(
      openApiPathTemplateAcceptsBearer('/portfolios/{portfolioId}/vault/future-transition', 'POST'),
    ).toBe(false);
    expect(pathAcceptsBearer(`/portfolios/${UUID_A}/vault/revision`, 'POST')).toBe(false);
    expect(pathAcceptsBearer(`/portfolios/${UUID_A}/vault/move-in`, 'GET')).toBe(false);
    expect(pathAcceptsBearer(`/portfolios/${UUID_A}/vault/move-out`, 'GET')).toBe(false);
    // The fence is only for the nested vault control plane; ordinary portfolio
    // reads retain the module's portfolio:read bearer policy.
    expect(pathAcceptsBearer(`/portfolios/${UUID_A}`, 'GET')).toBe(true);
  });

  it('matches each placeholder by its own declared kind on per-doc history routes', () => {
    const history = `/vaults/${UUID_A}/docs/${UUID_B}/history/12`;
    expect(vaultSyncRouteAcceptsBearer('GET', history)).toBe(true);
    expect(pathAcceptsBearer(history, 'GET')).toBe(true);
    expect(
      openApiPathTemplateAcceptsBearer('/vaults/{vaultId}/docs/{docId}/history/{version}', 'GET'),
    ).toBe(true);

    expect(vaultSyncRouteAcceptsBearer('GET', `/vaults/12/docs/${UUID_B}/history/12`)).toBe(false);
    expect(vaultSyncRouteAcceptsBearer('GET', `/vaults/${UUID_A}/docs/12/history/12`)).toBe(false);
    expect(vaultSyncRouteAcceptsBearer('GET', `/vaults/${UUID_A}/docs/${UUID_B}/history/0`)).toBe(
      false,
    );
    expect(
      vaultSyncRouteAcceptsBearer('GET', '/vaults/{vaultId}/docs/{docId}/history/{version}'),
    ).toBe(false);
  });

  it('classifies every real mounted vault route as sync or session-only', () => {
    const mounted = mountedBearerRouteInventory(buildRouteTable(), '/vault');
    const classified = [
      ...VAULT_SYNC_BEARER_ROUTE_ALLOWLIST,
      ...VAULT_SESSION_ONLY_ROUTES,
      ...EXPECTED_ROUTER_GUARDS,
    ]
      .filter(({ path }) => path === '/vault' || path.startsWith('/vault/'))
      .map(({ method, path }) => ({ method, path }));
    const sortRoutes = (routes: Array<{ method: string; path: string }>) =>
      routes.sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
      );

    expect(new Set(classified.map((route) => `${route.method} ${route.path}`)).size).toBe(
      classified.length,
    );
    expect(sortRoutes(mounted)).toEqual(sortRoutes(classified));
  });

  it('classifies every mounted per-vault operation without inheriting a module-wide scope', () => {
    const mounted = mountedBearerRouteInventory(buildRouteTable(), '/vaults');
    const classified = [
      ...VAULT_SYNC_BEARER_ROUTE_ALLOWLIST,
      ...VAULT_ACCOUNT_SECURITY_BEARER_ROUTE_ALLOWLIST,
      ...VAULT_SESSION_ONLY_ROUTES,
      ...EXPECTED_PER_VAULT_ROUTER_GUARDS,
    ]
      .filter(({ path }) => path === '/vaults' || path.startsWith('/vaults/'))
      .map(({ method, path }) => ({ method, path }));
    const sortRoutes = (routes: Array<{ method: string; path: string }>) =>
      routes.sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
      );

    expect(new Set(classified.map((route) => `${route.method} ${route.path}`)).size).toBe(
      classified.length,
    );
    expect(sortRoutes(mounted)).toEqual(sortRoutes(classified));
  });

  it('keeps router.all and opaque router.use leaves in the completeness inventory', () => {
    const futureSurfaces: MountedSurface[] = [
      {
        kind: 'all-methods-route',
        path: '/api/v1/vault/future-all',
      },
      {
        kind: 'opaque-mount',
        path: '/api/v1/vault/future-leaf',
        handler: 'futureVaultLeaf',
        occurrence: 1,
      },
    ];

    expect(mountedBearerRouteInventory(futureSurfaces, '/vault')).toEqual([
      {
        method: BEARER_ALL_METHODS_ROUTE_METHOD,
        path: '/vault/future-all',
      },
      {
        method: `${BEARER_OPAQUE_MOUNT_METHOD}:futureVaultLeaf[1]`,
        path: '/vault/future-leaf',
      },
    ]);
  });

  it('maps HEAD to allowlisted GET routes but keeps session-only vault routes closed', () => {
    for (const route of EXPECTED_ALLOWLIST.filter((candidate) => candidate.method === 'GET')) {
      const path = livePath(route.path);
      expect(vaultSyncRouteAcceptsBearer('HEAD', path)).toBe(true);
      expect(pathAcceptsBearer(path, 'HEAD')).toBe(true);
    }

    expect(vaultSyncRouteAcceptsBearer('GET', '/vault/history/{version}')).toBe(false);
    expect(pathAcceptsBearer('/vault/history/{version}', 'GET')).toBe(false);
    expect(pathAcceptsBearer('/vault/media/server-candidate/12', 'HEAD')).toBe(false);
    expect(pathAcceptsBearer(`/vaults/${UUID_A}/docs/${UUID_B}`, 'HEAD')).toBe(true);
    // #1497 widened the config READ only: HEAD follows its GET, PATCH does not.
    expect(pathAcceptsBearer(`/vaults/${UUID_A}`, 'HEAD')).toBe(true);
    expect(pathAcceptsBearer(`/vaults/${UUID_A}`, 'PATCH')).toBe(false);
    expect(
      portfolioVaultAccountSecurityRouteAcceptsBearer(
        'HEAD',
        `/portfolios/${UUID_A}/vault/revision`,
      ),
    ).toBe(true);
    expect(pathAcceptsBearer(`/portfolios/${UUID_A}/vault/revision`, 'HEAD')).toBe(true);
  });

  it('requires account:security for every portfolio transition and closes future siblings', async () => {
    const { user, id } = await mintPersonalToken(['portfolio:write'], 'portfolio-vault-policy');
    const guard = enforceApiKeyScope(harness.ctx);
    const invoke = (method: string, path: string, scopes: string[]) =>
      new Promise<unknown>((resolve) => {
        guard(
          {
            apiKey: {
              id,
              scopes,
              kind: 'personal',
              firstParty: false,
              securityGeneration: 0,
            },
            authUser: { id: user.id, role: 'user', privacyMode: 'normal' },
            method,
            path,
            ip: '127.0.0.1',
          } as unknown as Request,
          {} as Response,
          (error?: unknown) => resolve(error),
        );
      });

    for (const route of PORTFOLIO_ACCOUNT_SECURITY_ALLOWLIST) {
      const denied = await invoke(route.method, livePath(route.path), ['portfolio:write']);
      expect(denied).toMatchObject({
        statusCode: 403,
        code: 'INSUFFICIENT_SCOPE',
        message: expect.stringContaining('account:security'),
      });
      await expect(
        invoke(route.method, livePath(route.path), ['account:security']),
      ).resolves.toBeUndefined();
    }

    await expect(
      invoke('POST', `/portfolios/${UUID_A}/vault/future-transition`, ['account:security']),
    ).resolves.toMatchObject({ statusCode: 403, code: 'API_KEY_FORBIDDEN' });
  });

  it('keeps the router-local guard default-closed independently of global scope policy', () => {
    const guard = (apiKey: { id: string; scopes: string[] }, method: string, path: string) => {
      const next = vi.fn();
      requireCookieSessionOrVaultSync(
        { apiKey, method, path } as unknown as Request,
        {} as Response,
        next,
      );
      return next;
    };
    const syncKey = { id: 'key', scopes: ['vault:sync'] };

    // Unlisted route: refused even though the token holds the right scope.
    const rejected = guard(syncKey, 'PATCH', '/media');
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0]![0]).toMatchObject({
      statusCode: 403,
      code: 'API_KEY_FORBIDDEN',
    });

    // Allowlisted route, wrong scope: the guard is scope-aware too, so a global
    // policy-table regression alone cannot hand the vault to an unrelated token.
    const wrongScope = guard({ id: 'key', scopes: ['market:read'] }, 'PUT', '/');
    expect(wrongScope.mock.calls[0]![0]).toMatchObject({
      statusCode: 403,
      code: 'API_KEY_FORBIDDEN',
    });

    expect(guard(syncKey, 'PUT', '/')).toHaveBeenCalledWith();
  });

  it('makes the per-vault local guard hide admin principals and audit INSUFFICIENT_SCOPE', async () => {
    const { user, id } = await mintPersonalToken(['market:read'], 'local-vault-guard');
    const guard = requireCookieSessionOrPerVaultAccess(harness.ctx);
    const invoke = (role: 'user' | 'admin') =>
      new Promise<unknown>((resolve) => {
        guard(
          {
            apiKey: {
              id,
              scopes: ['market:read'],
              kind: 'personal',
              firstParty: false,
              securityGeneration: 0,
            },
            authUser: { id: user.id, role, privacyMode: 'normal' },
            method: 'GET',
            path: `/${UUID_A}/docs/${UUID_B}`,
            ip: '127.0.0.1',
          } as unknown as Request,
          {} as Response,
          (error?: unknown) => resolve(error),
        );
      });

    await expect(invoke('admin')).resolves.toMatchObject({ statusCode: 404 });
    await expect(invoke('user')).resolves.toMatchObject({
      statusCode: 403,
      code: 'INSUFFICIENT_SCOPE',
    });

    const [denial] = await harness.db
      .select({ meta: auditLog.meta })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, id), eq(auditLog.action, 'api_key.scope_denied')));
    expect(denial?.meta).toMatchObject({
      requiredScope: 'vault:sync',
      method: 'GET',
      path: `/vaults/${UUID_A}/docs/${UUID_B}`,
    });
  });
});

describe('#1043 bearer vault synchronization', () => {
  it('reaches every per-vault sync read plus the opaque document write handler', async () => {
    const { user, token } = await mintPersonalToken(['vault:sync'], 'pervault-sync');
    // Deterministic TEST VECTOR bytes: deliberately not JSON or an envelope.
    // Service spies isolate this as an auth/router test and prove the HTTP layer
    // forwards opaque bytes without attempting to parse them itself.
    const currentBytes = Buffer.from([0, 255, 16, 42, 200, 7]);
    const writeBytes = Buffer.from([222, 173, 0, 190, 239]);
    // Deterministic TEST VECTOR, deliberately not a verifier: the per-vault
    // bearer write must ignore this legacy enrollment header completely.
    const ignoredRetirementVerifier = 'ignored-per-vault-retirement-verifier';
    const createdAt = new Date('2026-08-20T12:00:00.000Z');
    const row = {
      vaultId: UUID_A,
      docId: UUID_B,
      docKind: 'header' as const,
      portfolioId: null,
      version: 1,
      formatVersion: 2,
      sizeBytes: currentBytes.length,
      blob: currentBytes,
      createdAt,
      updatedAt: createdAt,
    };
    const putDoc = vi
      .spyOn(harness.ctx.vaults, 'putDoc')
      .mockResolvedValue({ status: 'ok', row, idempotent: false });
    const readDoc = vi
      .spyOn(harness.ctx.vaults, 'readDoc')
      .mockResolvedValue({ status: 'ok', row });
    const listHistory = vi.spyOn(harness.ctx.vaults, 'listHistory').mockResolvedValue({
      status: 'ok',
      page: {
        items: [
          {
            version: 1,
            createdAt: createdAt.toISOString(),
            sizeBytes: currentBytes.length,
            medium: 'server',
          },
        ],
        nextCursor: null,
      },
    });
    const getHistory = vi.spyOn(harness.ctx.vaults, 'getHistory').mockResolvedValue({
      status: 'ok',
      value: {
        id: UUID_C,
        vaultId: UUID_A,
        docId: UUID_B,
        version: 1,
        formatVersion: 2,
        sizeBytes: currentBytes.length,
        blob: currentBytes,
        createdAt,
      },
    });
    const getMediaState = vi.spyOn(harness.ctx.vaults, 'getMediaState').mockResolvedValue({
      vaultId: UUID_A,
      media: ['server'],
      driveConnectionId: null,
      mediaAttestedAt: createdAt.toISOString(),
      mediaAttestedDriveConnectionId: null,
      server: { disposition: 'active', candidates: [], retirement: null },
    });

    const put = await request(harness.app)
      .put(`/api/v1/vaults/${UUID_A}/docs/${UUID_B}`)
      .set(bearer(token))
      .set(...OCTET)
      .set('If-None-Match', '*')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, ignoredRetirementVerifier)
      .send(writeBytes);
    expect(put.status, JSON.stringify(put.body)).toBe(204);
    expect(put.headers.etag).toBe('"1"');
    expect(putDoc).toHaveBeenCalledWith({
      userId: user.id,
      vaultId: UUID_A,
      docId: UUID_B,
      expectedVersion: null,
      blob: writeBytes,
    });
    expect(putDoc.mock.calls[0]![0]).not.toHaveProperty('retirementProofPublicKey');

    const current = await request(harness.app)
      .get(`/api/v1/vaults/${UUID_A}/docs/${UUID_B}`)
      .set(bearer(token))
      .responseType('blob');
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.headers.etag).toBe('"1"');
    expect((current.body as Buffer).equals(currentBytes)).toBe(true);
    expect(readDoc).toHaveBeenCalledWith(user.id, UUID_A, UUID_B);

    const history = await request(harness.app)
      .get(`/api/v1/vaults/${UUID_A}/docs/${UUID_B}/history`)
      .set(bearer(token));
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.items).toHaveLength(1);
    expect(listHistory).toHaveBeenCalledWith(user.id, UUID_A, UUID_B, {});

    const historical = await request(harness.app)
      .get(`/api/v1/vaults/${UUID_A}/docs/${UUID_B}/history/1`)
      .set(bearer(token))
      .responseType('blob');
    expect(historical.status, JSON.stringify(historical.body)).toBe(200);
    expect((historical.body as Buffer).equals(currentBytes)).toBe(true);
    expect(getHistory).toHaveBeenCalledWith(user.id, UUID_A, UUID_B, 1);

    const media = await request(harness.app)
      .get(`/api/v1/vaults/${UUID_A}/media`)
      .set(bearer(token));
    expect(media.status, JSON.stringify(media.body)).toBe(200);
    expect(media.body).toMatchObject({
      vaultId: UUID_A,
      media: ['server'],
      server: { disposition: 'active' },
    });
    expect(getMediaState).toHaveBeenCalledWith(user.id, UUID_A);
  });

  it('runs bearer vault deletion through real §15 step-up and preserves the row on a wrong password', async () => {
    const { user, token } = await mintPersonalToken(['account:security'], 'pervault-delete-wrong');
    const vaultId = await createRealPerVault(user.id, 'Bearer wrong-password vault');

    const denied = await request(harness.app)
      .delete(`/api/v1/vaults/${vaultId}`)
      .set(bearer(token))
      .send({ stepUp: { password: 'deterministic-wrong-password' } });
    expect(denied.status, JSON.stringify(denied.body)).toBe(401);
    expect(denied.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await harness.ctx.vaults.get(user.id, vaultId)).not.toBeNull();
  });

  it('runs bearer vault deletion through real §15 step-up and deletes on the correct password', async () => {
    const { user, token } = await mintPersonalToken(
      ['account:security'],
      'pervault-delete-correct',
    );
    const vaultId = await createRealPerVault(user.id, 'Bearer correct-password vault');

    const deleted = await request(harness.app)
      .delete(`/api/v1/vaults/${vaultId}`)
      .set(bearer(token))
      .send({ stepUp: { password: user.password } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect(await harness.ctx.vaults.get(user.id, vaultId)).toBeNull();
  });

  it('refuses normal-mode bearer writes without disturbing the session enable window', async () => {
    const { user, token } = await mintPersonalToken(['vault:sync'], 'writestate');
    const v1 = envelope(1, new Uint8Array([1, 6, 4]));
    const v2 = envelope(2, new Uint8Array([2, 6, 4]));

    const refusedCreate = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(v1);
    expect(refusedCreate.status, JSON.stringify(refusedCreate.body)).toBe(409);
    expect(refusedCreate.body.error).toMatchObject({
      code: 'VAULT_SERVER_MEDIUM_INACTIVE',
      message: expect.stringContaining('paranoid mode'),
    });
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);

    // The browser wizard reads its normal-data CAS token, stages the encrypted
    // server copy through its cookie session, then commits the mode transition.
    const agent = await loginAgent(harness.app, user);
    const refusedCookieRead = await agent.get('/api/v1/vault');
    expect(refusedCookieRead.status, JSON.stringify(refusedCookieRead.body)).toBe(409);
    expect(refusedCookieRead.body.error.code).toBe('VAULT_SERVER_MEDIUM_INACTIVE');
    const refusedBearerRead = await request(harness.app).get('/api/v1/vault').set(bearer(token));
    expect(refusedBearerRead.status, JSON.stringify(refusedBearerRead.body)).toBe(409);
    expect(refusedBearerRead.body.error.code).toBe('VAULT_SERVER_MEDIUM_INACTIVE');

    const revision = await agent.get('/api/v1/account/paranoid/normal-revision');
    expect(revision.status, JSON.stringify(revision.body)).toBe(200);
    const staged = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(v1);
    expect(staged.status, JSON.stringify(staged.body)).toBe(204);

    const ownerReadback = await agent.get('/api/v1/vault').responseType('blob');
    expect(ownerReadback.status).toBe(200);
    expect((ownerReadback.body as Buffer).equals(v1)).toBe(true);
    const bearerStillRefused = await request(harness.app).get('/api/v1/vault').set(bearer(token));
    expect(bearerStillRefused.status, JSON.stringify(bearerStillRefused.body)).toBe(409);
    expect(bearerStillRefused.body.error.code).toBe('VAULT_SERVER_MEDIUM_INACTIVE');

    // A bearer cannot replace those staged bytes during the read/verify window.
    const refusedReplace = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(v2);
    expect(refusedReplace.status, JSON.stringify(refusedReplace.body)).toBe(409);
    expect(refusedReplace.body.error.code).toBe('VAULT_SERVER_MEDIUM_INACTIVE');

    const enabled = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({
        mediaSet: ['server'],
        vaultVersion: 1,
        driveAttestation: null,
        normalDataRevision: revision.body.revision,
      });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body).toMatchObject({ mode: 'paranoid', mediaSet: ['server'], vaultVersion: 1 });
    expect(
      await harness.db
        .select()
        .from(paranoidEnableTransitions)
        .where(eq(paranoidEnableTransitions.userId, user.id)),
    ).toEqual([]);

    // The same bearer becomes a valid sync writer only after that transition.
    const synced = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(v2);
    expect(synced.status, JSON.stringify(synced.body)).toBe(204);
    expect(synced.headers.etag).toBe('"2"');
  });

  it('expires an abandoned owner staging window and deletes its ciphertext', async () => {
    const { user, token } = await mintPersonalToken(['vault:sync'], 'expiredstage');
    const agent = await loginAgent(harness.app, user);
    await agent.get('/api/v1/account/paranoid/normal-revision').expect(200);
    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([8, 8, 8])))
      .expect(204);

    await harness.db
      .update(paranoidEnableTransitions)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(paranoidEnableTransitions.userId, user.id));

    const expiredOwnerRead = await agent.get('/api/v1/vault');
    expect(expiredOwnerRead.status, JSON.stringify(expiredOwnerRead.body)).toBe(409);
    expect(expiredOwnerRead.body.error.code).toBe('VAULT_SERVER_MEDIUM_INACTIVE');
    const expiredBearerRead = await request(harness.app).get('/api/v1/vault').set(bearer(token));
    expect(expiredBearerRead.status, JSON.stringify(expiredBearerRead.body)).toBe(409);
    expect(expiredBearerRead.body.error.code).toBe('VAULT_SERVER_MEDIUM_INACTIVE');
    expect(
      await harness.db.select().from(paranoidVaults).where(eq(paranoidVaults.userId, user.id)),
    ).toEqual([]);
    expect(
      await harness.db
        .select()
        .from(paranoidEnableTransitions)
        .where(eq(paranoidEnableTransitions.userId, user.id)),
    ).toEqual([]);
  });

  it('runs a byte-opaque CAS round trip through the first-party mobile OAuth grant', async () => {
    const { user, token } = await mintFirstPartyVaultToken();
    await setParanoidServer(user.id);

    // These bytes are deliberately neither JSON nor a valid decrypted vault.
    // Success + byte-identical reads prove the server still parses only BTVAULT1's header.
    const v1 = envelope(1, new Uint8Array([0, 255, 16, 42, 200, 7]));
    const created = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(v1);
    expect(created.status, JSON.stringify(created.body)).toBe(204);
    expect(created.headers.etag).toBe('"1"');

    const v2 = envelope(2, new Uint8Array([2, 254, 3]));
    const replaced = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(v2);
    expect(replaced.status).toBe(204);
    expect(replaced.headers.etag).toBe('"2"');

    const v3 = envelope(3, new Uint8Array([99, 0, 128]));
    const stale = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(v3);
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe('VAULT_PRECONDITION_FAILED');
    expect(stale.headers.etag).toBeUndefined();
    expect(stale.headers['last-modified']).toBeUndefined();
    // r3: the winner's version rides the body, so a mobile CAS loser on a
    // dropped link never needs a second GET just to learn the current version.
    expect(stale.body.currentVersion).toBe(2);

    const fresh = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"2"')
      .send(v3);
    expect(fresh.status).toBe(204);
    expect(fresh.headers.etag).toBe('"3"');

    const read = await request(harness.app)
      .get('/api/v1/vault')
      .set(bearer(token))
      .responseType('blob');
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe('"3"');
    expect(read.headers['content-type']).toContain('application/octet-stream');
    expect((read.body as Buffer).equals(v3)).toBe(true);

    const head = await request(harness.app).head('/api/v1/vault').set(bearer(token));
    expect(head.status, JSON.stringify(head.body)).toBe(200);
    expect(head.headers.etag).toBe('"3"');

    const media = await request(harness.app).get('/api/v1/vault/media').set(bearer(token));
    expect(media.status, JSON.stringify(media.body)).toBe(200);
    expect(media.body.mediaState.mediaSet).toEqual(['server']);
    expect(JSON.stringify(media.body)).not.toContain('blob');

    const history = await request(harness.app).get('/api/v1/vault/history').set(bearer(token));
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.items.map((item: { version: number }) => item.version)).toEqual([2, 1]);

    const historical = await request(harness.app)
      .get('/api/v1/vault/history/2')
      .set(bearer(token))
      .responseType('blob');
    expect(historical.status).toBe(200);
    expect(historical.headers.etag).toBe('"2"');
    expect(historical.headers[VAULT_HISTORY_CREATED_AT_HEADER.toLowerCase()]).toBeDefined();
    expect(historical.headers[VAULT_HISTORY_SIZE_BYTES_HEADER.toLowerCase()]).toBe(
      String(v2.length),
    );
    expect(historical.headers[VAULT_HISTORY_MEDIUM_HEADER.toLowerCase()]).toBe('server');
    expect((historical.body as Buffer).equals(v2)).toBe(true);
  });

  it('keeps config, transitions, provenance and future vault routes session-only', async () => {
    const { token } = await mintPersonalToken(['vault:sync', 'account:security'], 'transition');
    const cases = [
      { method: 'post', path: '/account/paranoid/enable' },
      { method: 'post', path: '/account/paranoid/disable' },
      { method: 'get', path: '/account/paranoid/fork-provenance' },
      { method: 'get', path: '/account/paranoid/normal-revision' },
      { method: 'patch', path: '/vault/media' },
      { method: 'put', path: '/vault/media/server-candidate' },
      { method: 'get', path: `/vault/media/server-candidate/${MISSING_ID}` },
      { method: 'post', path: '/vault/media/retired/purge/challenge' },
      { method: 'post', path: '/vault/media/retired/purge' },
      { method: 'post', path: '/vaults' },
      { method: 'patch', path: `/vaults/${UUID_A}` },
      { method: 'patch', path: `/vaults/${UUID_A}/media` },
      {
        method: 'put',
        path: `/vaults/${UUID_A}/media/server-candidate/${UUID_C}/docs/${UUID_B}`,
      },
      {
        method: 'get',
        path: `/vaults/${UUID_A}/media/server-candidate/${MISSING_ID}`,
      },
      { method: 'post', path: `/vaults/${UUID_A}/media/retired/purge/challenge` },
      { method: 'post', path: `/vaults/${UUID_A}/media/retired/purge` },
      // A future sibling must not inherit either scope from the module prefix.
      { method: 'get', path: '/vaults/future-transition' },
    ] as const;

    for (const row of cases) {
      const api = request(harness.app);
      const url = `/api/v1${row.path}`;
      const started =
        row.method === 'get'
          ? api.get(url)
          : row.method === 'post'
            ? api.post(url)
            : row.method === 'put'
              ? api.put(url)
              : api.patch(url);
      const response = await started.set(bearer(token)).send({});
      expect(response.status, `${row.method.toUpperCase()} ${row.path}`).toBe(403);
      expect(response.body.error.code, row.path).toBe('API_KEY_FORBIDDEN');
    }
  });

  it('requires account:security rather than vault:sync for per-vault deletion', async () => {
    const { token } = await mintPersonalToken(['vault:sync'], 'delete-scope');
    const denied = await request(harness.app)
      .delete(`/api/v1/vaults/${UUID_A}`)
      .set(bearer(token))
      .send({ password: 'not examined before scope authorization' });

    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(denied.body.error.message).toContain('account:security');
  });

  it('keeps vault:sync open while the legacy-v1 bridge refuses old portfolio scopes', async () => {
    const { user, token } = await mintPersonalToken(['vault:sync', 'portfolio:read'], 'interplay');
    await setParanoidServer(user.id);

    expect(isLegacyParanoidRefusedScope('vault:sync')).toBe(false);
    expect(isLegacyParanoidRefusedScope('portfolio:read')).toBe(true);

    const stored = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(envelope(1, new Uint8Array([7, 0, 7])));
    expect(stored.status, JSON.stringify(stored.body)).toBe(204);
    await request(harness.app).get('/api/v1/vault').set(bearer(token)).expect(200);

    const portfolios = await request(harness.app).get('/api/v1/portfolios').set(bearer(token));
    expect(portfolios.status).toBe(403);
    expect(portfolios.body.error.code).toBe(PARANOID_MODE_ERROR_CODE);

    const missing = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'no vault scope',
      scopes: ['market:read'],
    });
    const denied = await request(harness.app).get('/api/v1/vault').set(bearer(missing.token));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(denied.body.error.message).toContain('vault:sync');

    const deniedPerDoc = await request(harness.app)
      .get(`/api/v1/vaults/${UUID_A}/docs/${UUID_B}`)
      .set(bearer(missing.token));
    expect(deniedPerDoc.status).toBe(403);
    expect(deniedPerDoc.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(deniedPerDoc.body.error.message).toContain('vault:sync');
  });

  it('never lets a bearer pin the immutable retirement verifier, on a fresh or a keyless vault', async () => {
    const { user, token } = await mintPersonalToken(['vault:sync'], 'proofkey');
    await setParanoidServer(user.id);
    const attackerKey = ed25519PublicKey();
    const browserKey = ed25519PublicKey();
    expect(attackerKey).not.toBe(browserKey);

    const created = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-None-Match', '*')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, attackerKey)
      .send(envelope(1, new Uint8Array([1])));
    expect(created.status, JSON.stringify(created.body)).toBe(204);
    expect(await storedProofKey(user.id)).toBeNull();

    // A bearer CAS write over the now-keyless vault must not enrol one either.
    const replaced = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, attackerKey)
      .send(envelope(2, new Uint8Array([2])));
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(204);
    expect(await storedProofKey(user.id)).toBeNull();

    // The owning browser session still enrols its own verifier afterwards.
    const agent = await loginAgent(harness.app, user);
    const enrolled = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"2"')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, browserKey)
      .send(envelope(3, new Uint8Array([3])));
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(204);
    expect(await storedProofKey(user.id)).toBe(browserKey);

    // And a later bearer write neither conflicts with nor overwrites it.
    const afterEnrolment = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"3"')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, attackerKey)
      .send(envelope(4, new Uint8Array([4])));
    expect(afterEnrolment.status, JSON.stringify(afterEnrolment.body)).toBe(204);
    expect(await storedProofKey(user.id)).toBe(browserKey);
  });

  it('uses the same exact byte cap for bearer PUTs as the session path', async () => {
    const cap = 1024;
    harness = await createTestApp({ env: { BT_VAULT_MAX_BYTES: String(cap) } });
    const { user, token } = await mintPersonalToken(['vault:sync'], 'sizecap');
    await setParanoidServer(user.id);

    const overhead = envelope(1, new Uint8Array()).length;
    const atLimit = envelope(1, new Uint8Array(cap - overhead));
    expect(atLimit.length).toBe(cap);
    const accepted = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(atLimit);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(204);

    const overLimit = Buffer.concat([atLimit, Buffer.from([1])]);
    expect(overLimit.length).toBe(cap + 1);
    const rejected = await request(harness.app)
      .put('/api/v1/vault')
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(overLimit);
    expect(rejected.status).toBe(413);
    expect(rejected.body.error.code).toBe('VAULT_TOO_LARGE');
  });

  it('applies the same dedicated per-user vault write rate limit to bearer PUTs', async () => {
    harness = await createTestApp({
      rateLimitsEnabled: true,
      env: { BT_VAULT_RATE_LIMIT: '2' },
    });
    const { user, token } = await mintPersonalToken(['vault:sync'], 'ratelimit');
    await setParanoidServer(user.id);

    const write = (version: number, expected: '*' | number) => {
      const started = request(harness.app)
        .put('/api/v1/vault')
        .set(bearer(token))
        .set(...OCTET);
      if (expected === '*') started.set('If-None-Match', '*');
      else started.set('If-Match', `"${expected}"`);
      return started.send(envelope(version, new Uint8Array([version])));
    };

    expect((await write(1, '*')).status).toBe(204);
    expect((await write(2, 1)).status).toBe(204);
    const over = await write(3, 2);
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
  });
});

/**
 * #1497 — a phone that arrives with nothing but a §13 QR phrase must be able to
 * discover the vault it was handed and its two singleton doc ids. The two
 * config READS therefore join the same scope family as the per-doc store; the
 * destructive verb keeps its separate account:security + step-up rail, and
 * every write / transition stays owning-browser-session work.
 */
describe('#1497 bearer vault config reads', () => {
  it('serves a vault:sync bearer exactly the list and config body the owning session gets', async () => {
    const { user, token } = await mintPersonalToken(['vault:sync'], 'pervault-config-read');
    const vaultId = await createRealPerVault(user.id, 'QR handoff vault');
    const agent = await loginAgent(harness.app, user);

    const [bearerList, sessionList] = await Promise.all([
      request(harness.app).get('/api/v1/vaults').set(bearer(token)),
      agent.get('/api/v1/vaults'),
    ]);
    expect(bearerList.status, JSON.stringify(bearerList.body)).toBe(200);
    expect(sessionList.status, JSON.stringify(sessionList.body)).toBe(200);
    expect(bearerList.body).toEqual(sessionList.body);
    // The bootstrap payload the §13 phrase alone cannot carry.
    expect(bearerList.body.vaults).toMatchObject([
      { id: vaultId, name: 'QR handoff vault', headerDocId: UUID_A, commonDocId: UUID_B },
    ]);

    const [bearerVault, sessionVault] = await Promise.all([
      request(harness.app).get(`/api/v1/vaults/${vaultId}`).set(bearer(token)),
      agent.get(`/api/v1/vaults/${vaultId}`),
    ]);
    expect(bearerVault.status, JSON.stringify(bearerVault.body)).toBe(200);
    expect(sessionVault.status, JSON.stringify(sessionVault.body)).toBe(200);
    expect(bearerVault.body).toEqual(sessionVault.body);
    expect(bearerVault.body.vault).toMatchObject({ id: vaultId, headerDocId: UUID_A });
    expect(bearerVault.headers['cache-control']).toBe('private, no-store');

    // Reading config buys no write: the same token still cannot create, rename
    // or delete, and each refusal keeps its own established vocabulary.
    const created = await request(harness.app)
      .post('/api/v1/vaults')
      .set(bearer(token))
      .send({ name: 'refused' });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('API_KEY_FORBIDDEN');
    const renamed = await request(harness.app)
      .patch(`/api/v1/vaults/${vaultId}`)
      .set(bearer(token))
      .send({ name: 'refused' });
    expect(renamed.status).toBe(403);
    expect(renamed.body.error.code).toBe('API_KEY_FORBIDDEN');
    const deleted = await request(harness.app)
      .delete(`/api/v1/vaults/${vaultId}`)
      .set(bearer(token))
      .send({ stepUp: { password: user.password } });
    expect(deleted.status).toBe(403);
    expect(deleted.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(deleted.body.error.message).toContain('account:security');
  });

  it('denies a bearer without the doc scope with an audited INSUFFICIENT_SCOPE naming it', async () => {
    const { user, token, id } = await mintPersonalToken(['market:read'], 'pervault-config-scope');
    const vaultId = await createRealPerVault(user.id, 'Scope-denied vault');

    for (const path of ['/api/v1/vaults', `/api/v1/vaults/${vaultId}`]) {
      const denied = await request(harness.app).get(path).set(bearer(token));
      expect(denied.status, `${path}: ${JSON.stringify(denied.body)}`).toBe(403);
      expect(denied.body.error.code, path).toBe('INSUFFICIENT_SCOPE');
      expect(denied.body.error.message, path).toContain('vault:sync');
    }

    const denials = await harness.db
      .select({ meta: auditLog.meta })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, id), eq(auditLog.action, 'api_key.scope_denied')));
    expect(denials.map((row) => row.meta)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requiredScope: 'vault:sync', method: 'GET', path: '/vaults' }),
        expect.objectContaining({
          requiredScope: 'vault:sync',
          method: 'GET',
          path: `/vaults/${vaultId}`,
        }),
      ]),
    );
  });

  it('answers another account’s vault id with 404, never 403, and keeps future siblings closed', async () => {
    const { token } = await mintPersonalToken(['vault:sync'], 'pervault-config-foreign');
    const stranger = await seedUser('pervault-config-owner');
    const foreignVaultId = await createRealPerVault(stranger.id, 'Stranger vault');

    const foreign = await request(harness.app)
      .get(`/api/v1/vaults/${foreignVaultId}`)
      .set(bearer(token));
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect(foreign.body.error.code).toBe('VAULT_NOT_FOUND');

    // Ownership scoping stays in the repository: the list is the caller's own.
    const list = await request(harness.app).get('/api/v1/vaults').set(bearer(token));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.vaults).toEqual([]);

    // Canary: an unknown future `/vaults/*` read is still default-closed, both
    // as a word-shaped sibling and as a deeper path under a real vault id.
    for (const path of ['/api/v1/vaults/future-config-read', `/api/v1/vaults/${UUID_A}/future`]) {
      const refused = await request(harness.app).get(path).set(bearer(token));
      expect(refused.status, `${path}: ${JSON.stringify(refused.body)}`).toBe(403);
      expect(refused.body.error.code, path).toBe('API_KEY_FORBIDDEN');
    }
    expect(pathAcceptsBearer(`/vaults/${UUID_A}/future`, 'GET')).toBe(false);
    expect(openApiPathTemplateAcceptsBearer('/vaults/{vaultId}/future', 'GET')).toBe(false);
  });
});
