import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { eq } from 'drizzle-orm';
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
  VAULT_SERVER_CANDIDATE_READBACK_HEADER,
  serializeRetiredServerPurgeTranscript,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import {
  paranoidEnableTransitions,
  paranoidVaultRetirements,
  paranoidVaultServerCandidates,
  paranoidVaults,
  users,
} from '../data/schema';
import {
  VAULT_SESSION_ONLY_ROUTES,
  VAULT_SYNC_BEARER_ROUTE_ALLOWLIST,
  openApiPathTemplateAcceptsBearer,
  pathAcceptsBearer,
  vaultSyncRouteAcceptsBearer,
} from '../http/middleware/bearerAuth';
import { buildRouteTable, type MountedSurface } from '../scripts/checkOpenapiCoverage';
import { requireCookieSessionOrVaultSync } from '../http/routes/vaultRoutes';
import {
  isParanoidKilledScope,
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
 * #1043/#1326 — bearer synchronization plus the verified media lifecycle.
 * Sync sees only opaque BTVAULT1 envelopes; lifecycle writes keep their
 * readback/proof ceremonies and account-mode transitions require fresh re-auth.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const OCTET = ['Content-Type', 'application/octet-stream'] as const;
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
): Promise<{ user: SeededUser; token: string }> {
  const user = await seedUser(prefix);
  const key = await harness.ctx.apiKeys.create({
    userId: user.id,
    name: `${prefix} key`,
    scopes,
  });
  return { user, token: key.token };
}

/** A real Ed25519 SPKI verifier — the route parses it in Node before storing it. */
function ed25519PublicKey(): string {
  return generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64url');
}

function retirementProofKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  };
}

function purgeSignature(
  privateKey: ReturnType<typeof retirementProofKey>['privateKey'],
  retiredVersion: number,
  observedVersion: number,
  challenge: string,
): string {
  return sign(
    null,
    Buffer.from(
      serializeRetiredServerPurgeTranscript({ retiredVersion, observedVersion, challenge }),
    ),
    privateKey,
  ).toString('base64url');
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
    { method: 'PATCH', path: '/vault/media' },
    { method: 'PUT', path: '/vault/media/server-candidate' },
    { method: 'GET', path: '/vault/media/server-candidate/{candidateId}' },
    { method: 'POST', path: '/vault/media/retired/purge/challenge' },
    { method: 'POST', path: '/vault/media/retired/purge' },
    { method: 'GET', path: '/vault/history' },
    // The segment matcher is declared by the entry, not inferred from how the
    // placeholder is spelled, so renaming `{version}` cannot widen matching.
    { method: 'GET', path: '/vault/history/{version}', param: 'positive-integer' },
  ] as const;

  const SESSION_ONLY = [
    ...VAULT_SESSION_ONLY_ROUTES,
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

  const livePath = (path: string): string =>
    path.replace('{version}', '12').replace('{candidateId}', MISSING_ID);

  it('pins the exact sync routes and defaults transitions and future routes closed', () => {
    expect(VAULT_SYNC_BEARER_ROUTE_ALLOWLIST).toEqual(EXPECTED_ALLOWLIST);
    for (const route of EXPECTED_ALLOWLIST) {
      const path = livePath(route.path);
      expect(vaultSyncRouteAcceptsBearer(route.method, path)).toBe(true);
      expect(pathAcceptsBearer(path, route.method)).toBe(true);
      expect(openApiPathTemplateAcceptsBearer(route.path, route.method)).toBe(true);
    }
    expect(vaultSyncRouteAcceptsBearer('GET', '/vault/history/12')).toBe(true);

    for (const route of SESSION_ONLY) {
      const path = livePath(route.path);
      expect(pathAcceptsBearer(path, route.method)).toBe(false);
      expect(openApiPathTemplateAcceptsBearer(route.path, route.method)).toBe(false);
    }
    expect(pathAcceptsBearer('/vault/future-transition', 'GET')).toBe(false);
    expect(pathAcceptsBearer('/vault/history/admin', 'GET')).toBe(false);
  });

  it('classifies every real mounted vault route as sync or session-only', () => {
    const mounted = mountedBearerRouteInventory(buildRouteTable(), '/vault');
    const classified = [
      ...VAULT_SYNC_BEARER_ROUTE_ALLOWLIST,
      ...VAULT_SESSION_ONLY_ROUTES,
      ...EXPECTED_ROUTER_GUARDS,
    ].map(({ method, path }) => ({ method, path }));
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
    const rejected = guard(syncKey, 'PATCH', '/future-media');
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
    expect(
      guard({ id: 'key', scopes: ['market:read'] }, 'PATCH', '/media').mock.calls[0]![0],
    ).toMatchObject({ statusCode: 403, code: 'API_KEY_FORBIDDEN' });

    expect(guard(syncKey, 'PUT', '/')).toHaveBeenCalledWith();
    expect(guard(syncKey, 'PATCH', '/media')).toHaveBeenCalledWith();
  });
});

describe('#1043 bearer vault synchronization', () => {
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
        password: user.password,
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

  it('keeps account-transition siblings closed while #1326 exact routes reach their handlers', async () => {
    const { token } = await mintPersonalToken(['vault:sync', 'account:security'], 'transition');
    const closed = [
      { method: 'get', path: '/account/paranoid/fork-provenance' },
      { method: 'get', path: '/account/paranoid/normal-revision' },
    ] as const;

    for (const row of closed) {
      const api = request(harness.app);
      const url = `/api/v1${row.path}`;
      const started = api.get(url);
      const response = await started.set(bearer(token)).send({});
      expect(response.status, `${row.method.toUpperCase()} ${row.path}`).toBe(403);
      expect(response.body.error.code, row.path).toBe('API_KEY_FORBIDDEN');
    }

    for (const path of [
      '/account/paranoid/enable',
      '/account/paranoid/disable',
      '/vault/media/retired/purge/challenge',
    ]) {
      const response = await request(harness.app)
        .post(`/api/v1${path}`)
        .set(bearer(token))
        .send({});
      expect(response.body.error?.code, `${path}: ${JSON.stringify(response.body)}`).not.toBe(
        'API_KEY_FORBIDDEN',
      );
    }
  });

  it('runs candidate, media-transition, and signed-purge ceremonies through vault:sync', async () => {
    const user = await seedUser('bearerlifecycle');
    await setParanoidServer(user.id);
    const agent = await loginAgent(harness.app, user);
    const key = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'vault lifecycle',
      scopes: ['vault:sync'],
    });
    const authorization = bearer(key.token);
    const { privateKey, publicKey } = retirementProofKey();
    const { privateKey: forgedPrivateKey } = retirementProofKey();
    const v1 = envelope(1, new Uint8Array([1, 3, 2, 6]));
    const serverOnly = { mediaSet: ['server'], driveAttestedVersion: null };
    const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 1 };
    const driveOnly = { mediaSet: ['drive'], driveAttestedVersion: 1 };
    const patchMedia = (body: Record<string, unknown>) =>
      request(harness.app).patch('/api/v1/vault/media').set(authorization).send(body);

    await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
      .send(v1)
      .expect(204);

    await patchMedia({
      expected: serverOnly,
      nextMediaSet: both.mediaSet,
      verification: { kind: 'drive', version: 1 },
    }).expect(200);
    const stale = await patchMedia({
      expected: { mediaSet: both.mediaSet, driveAttestedVersion: 2 },
      nextMediaSet: driveOnly.mediaSet,
      verification: { kind: 'drive', version: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VAULT_MEDIA_STATE_CONFLICT');

    const retired = await patchMedia({
      expected: both,
      nextMediaSet: driveOnly.mediaSet,
      verification: { kind: 'drive', version: 1 },
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.server.disposition).toBe('retired');
    await patchMedia({
      expected: both,
      nextMediaSet: driveOnly.mediaSet,
      verification: { kind: 'drive', version: 1 },
    }).expect(200);

    const stageCandidate = () =>
      request(harness.app)
        .put('/api/v1/vault/media/server-candidate')
        .set(authorization)
        .set(...OCTET)
        .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, publicKey)
        .send(v1);
    const staged = await stageCandidate();
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    const candidateId = staged.body.candidateId as string;
    expect((await stageCandidate()).body.candidateId).toBe(candidateId);
    const readback = await request(harness.app)
      .get(`/api/v1/vault/media/server-candidate/${candidateId}`)
      .set(authorization)
      .responseType('blob');
    expect(readback.status).toBe(200);
    expect((readback.body as Buffer).equals(v1)).toBe(true);
    const receipt = readback.headers[
      VAULT_SERVER_CANDIDATE_READBACK_HEADER.toLowerCase()
    ] as string;

    const other = await seedUser('otherreceipt');
    await harness.db
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(users.id, other.id));
    const otherKey = await harness.ctx.apiKeys.create({
      userId: other.id,
      name: 'other vault',
      scopes: ['vault:sync'],
    });
    const otherAuth = bearer(otherKey.token);
    const otherProof = retirementProofKey();
    const otherStaged = await request(harness.app)
      .put('/api/v1/vault/media/server-candidate')
      .set(otherAuth)
      .set(...OCTET)
      .set(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER, otherProof.publicKey)
      .send(v1);
    expect(otherStaged.status, JSON.stringify(otherStaged.body)).toBe(200);
    const otherReadback = await request(harness.app)
      .get(`/api/v1/vault/media/server-candidate/${otherStaged.body.candidateId as string}`)
      .set(otherAuth);
    const noPinnedVerifier = await request(harness.app)
      .patch('/api/v1/vault/media')
      .set(otherAuth)
      .send({
        expected: driveOnly,
        nextMediaSet: both.mediaSet,
        verification: {
          kind: 'server-candidate',
          candidateId: otherStaged.body.candidateId,
          readback: otherReadback.headers[
            VAULT_SERVER_CANDIDATE_READBACK_HEADER.toLowerCase()
          ] as string,
        },
      });
    expect(noPinnedVerifier.status).toBe(409);
    expect(noPinnedVerifier.body.error.code).toBe('VAULT_RETIRED_SERVER_PROOF_REQUIRED');
    const accountBoundFailure = await patchMedia({
      expected: driveOnly,
      nextMediaSet: both.mediaSet,
      verification: {
        kind: 'server-candidate',
        candidateId,
        readback: otherReadback.headers[
          VAULT_SERVER_CANDIDATE_READBACK_HEADER.toLowerCase()
        ] as string,
      },
    });
    expect(accountBoundFailure.status).toBe(412);
    expect(accountBoundFailure.body.error.code).toBe('VAULT_MEDIA_VERIFICATION_FAILED');
    expect(
      await harness.db
        .select({ id: paranoidVaultServerCandidates.id })
        .from(paranoidVaultServerCandidates)
        .where(eq(paranoidVaultServerCandidates.userId, user.id)),
    ).toHaveLength(1);

    await patchMedia({
      expected: driveOnly,
      nextMediaSet: both.mediaSet,
      verification: { kind: 'server-candidate', candidateId, readback: receipt },
    }).expect(200);
    await patchMedia({
      expected: both,
      nextMediaSet: serverOnly.mediaSet,
      verification: { kind: 'server', version: 1 },
    }).expect(200);
    await patchMedia({
      expected: serverOnly,
      nextMediaSet: both.mediaSet,
      verification: { kind: 'drive', version: 1 },
    }).expect(200);
    await patchMedia({
      expected: both,
      nextMediaSet: driveOnly.mediaSet,
      verification: { kind: 'drive', version: 1 },
    }).expect(200);

    const wrongRetirement = await request(harness.app)
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(authorization)
      .send({ retiredVersion: 2 });
    expect(wrongRetirement.status).toBe(409);
    expect(wrongRetirement.body.error.code).toBe('VAULT_MEDIA_STATE_CONFLICT');

    const prepared = await request(harness.app)
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(authorization)
      .send({ retiredVersion: 1 });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const challenge = prepared.body.challenge as string;
    const unsigned = await request(harness.app)
      .post('/api/v1/vault/media/retired/purge')
      .set(authorization)
      .send({ retiredVersion: 1, observedVersion: 2, challenge });
    expect(unsigned.status).toBe(400);
    const forged = await request(harness.app)
      .post('/api/v1/vault/media/retired/purge')
      .set(authorization)
      .send({
        retiredVersion: 1,
        observedVersion: 2,
        challenge,
        signature: purgeSignature(forgedPrivateKey, 1, 2, challenge),
      });
    expect(forged.status).toBe(412);
    expect(forged.body.error.code).toBe('VAULT_RETIRED_SERVER_PROOF_INVALID');

    const expiring = await request(harness.app)
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(authorization)
      .send({ retiredVersion: 1 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(expiring.body.expiresAt as string) + 1));
    try {
      const expired = await request(harness.app)
        .post('/api/v1/vault/media/retired/purge')
        .set(authorization)
        .send({
          retiredVersion: 1,
          observedVersion: 2,
          challenge: expiring.body.challenge,
          signature: purgeSignature(privateKey, 1, 2, expiring.body.challenge as string),
        });
      expect(expired.status).toBe(412);
      expect(expired.body.error.code).toBe('VAULT_RETIRED_SERVER_PROOF_INVALID');
    } finally {
      vi.useRealTimers();
    }
    expect(
      (await request(harness.app).get('/api/v1/vault/history/1').set(authorization)).status,
    ).toBe(200);

    await harness.db
      .update(paranoidVaultRetirements)
      .set({ retiredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(paranoidVaultRetirements.userId, user.id));
    const fresh = await request(harness.app)
      .post('/api/v1/vault/media/retired/purge/challenge')
      .set(authorization)
      .send({ retiredVersion: 1 });
    const purged = await request(harness.app)
      .post('/api/v1/vault/media/retired/purge')
      .set(authorization)
      .send({
        retiredVersion: 1,
        observedVersion: 2,
        challenge: fresh.body.challenge,
        signature: purgeSignature(privateKey, 1, 2, fresh.body.challenge as string),
      });
    expect(purged.status, JSON.stringify(purged.body)).toBe(200);
    expect(purged.body).toEqual({ purged: true });
    await request(harness.app).get('/api/v1/vault/history/1').set(authorization).expect(404);
  });

  it('exempts vault:sync while paranoid portfolio scopes still fail closed', async () => {
    const { user, token } = await mintPersonalToken(['vault:sync', 'portfolio:read'], 'interplay');
    await setParanoidServer(user.id);

    expect(isParanoidKilledScope('vault:sync')).toBe(false);
    expect(isParanoidKilledScope('portfolio:read')).toBe(true);

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
