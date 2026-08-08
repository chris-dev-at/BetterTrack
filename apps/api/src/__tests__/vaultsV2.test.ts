import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  VAULT2_CANONICAL_ERROR_CODES,
  VAULT2_ERROR_CODES,
  VAULT2_TRANSLATED_ERROR_CODES,
  VAULT_ALIAS_MAX_LENGTH,
  portfolioVaultStateSchema,
  VAULT_COMMON_DOC_MAX_BYTES,
  VAULT_HEADER_MAX_BYTES,
  VAULT_MIGRATION_CLAIM_TTL_MS,
  vaultMigrationStateSchema,
  vaultVersionConflictResponseSchema,
  vaultCreateResponseSchema,
  vaultDocMetadataSchema,
  vaultJoinResponseSchema,
  vaultLeaveResponseSchema,
  vaultListResponseSchema,
  vaultSyncListResponseSchema,
  encodeVaultEnvelope,
  VAULT_CONTENT_CIPHER,
  type ApiKeyScope,
  type VaultPortfolioRestoreDocument,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createVaultRepository } from '../data/repositories/vaultRepository';
import {
  VAULT_PORTFOLIO_ACCOUNT_SCOPED_TABLES,
  VAULT_PORTFOLIO_PURGE_ORDER,
  assertVaultPortfolioPurgeCompleteness,
} from '../data/repositories/vaultPortfolioPurge';
import {
  PORTFOLIO_VAULT_SESSION_ONLY_ROUTES,
  VAULTS_SESSION_ONLY_ROUTES,
  VAULTS_SYNC_BEARER_ROUTE_ALLOWLIST,
  openApiPathTemplateAcceptsBearer,
  pathAcceptsBearer,
  vaultsSyncRouteAcceptsBearer,
} from '../http/middleware/bearerAuth';
import { buildRouteTable } from '../scripts/checkOpenapiCoverage';
import {
  VAULTED_PORTFOLIO_KEPT_ROUTES,
  vaultedPortfolioIdInPath,
} from '../services/vault/vaultedPortfolioGuard';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

import { BEARER_OPAQUE_MOUNT_METHOD, mountedBearerRouteInventory } from './bearerRouteInventory';

/**
 * Vaults v2 server surface (`docs/VAULTS_V2_DESIGN.md` §3).
 *
 * The invariants under test, in the order the design states them: blind storage,
 * both-or-neither join, purge completeness, per-document CAS, portfolio-scoped
 * kill rails, cross-user isolation, and the bearer/session split.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const OCTET = ['Content-Type', 'application/octet-stream'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let harness: TestHarness;
let sequence = 0;

beforeEach(async () => {
  harness = await createTestApp();
  sequence = 0;
});

type Agent = ReturnType<typeof request.agent>;

async function seedUser(prefix: string): Promise<SeededUser> {
  sequence += 1;
  return harness.seedUser({
    email: `${prefix}-${sequence}@bettertrack.test`,
    username: `${prefix}${sequence}`,
  });
}

async function loginAgent(app: Application, user: SeededUser): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  expect(def).toBeTruthy();
  return def.id as string;
}

async function seedAsset(): Promise<{ id: string }> {
  sequence += 1;
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: `BAYN${sequence}.DE`,
      type: 'stock',
      symbol: `BAYN${sequence}.DE`,
      name: 'Bayer AG',
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!row) throw new Error('failed to seed asset');
  return row;
}

/** An opaque ciphertext blob — deliberately NOT a parseable document. */
function blob(tag: string, size = 64): Buffer {
  const bytes = Buffer.alloc(size, 0x2a);
  bytes.write(tag, 0, 'utf8');
  return bytes;
}

const b64 = (buffer: Buffer): string => buffer.toString('base64');

async function createVault(
  agent: Agent,
  overrides: { name?: string; backends?: 'server' | 'drive' | 'both'; header?: string } = {},
): Promise<{ vaultId: string; headerVersion: number | null }> {
  sequence += 1;
  const body = {
    name: overrides.name ?? `Vault ${sequence}`,
    backends: overrides.backends ?? ('server' as const),
    ...(overrides.backends === 'drive' ? {} : { header: overrides.header ?? b64(blob('header')) }),
  };
  const res = await agent
    .post('/api/v1/vaults')
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const parsed = vaultCreateResponseSchema.parse(res.body);
  return { vaultId: parsed.vault.id, headerVersion: parsed.header?.version ?? null };
}

/** Give a portfolio a real ledger: an asset buy plus the cash legs it books. */
async function seedPortfolioContent(agent: Agent, portfolioId: string): Promise<void> {
  const asset = await seedAsset();
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/deposit`)
    .set(...XRW)
    // Backdated ahead of the buy below: the solvency guard reads the balance AT
    // the trade date, so a deposit stamped "now" would not fund a January buy.
    .send({ amountEur: 5000, executedAt: '2026-01-01T00:00:00.000Z' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  const tx = await agent
    .post(`/api/v1/portfolios/${portfolioId}/transactions`)
    .set(...XRW)
    .send({
      transactions: [
        {
          assetId: asset.id,
          side: 'buy',
          quantity: 3,
          price: 100,
          executedAt: '2026-01-05T10:00:00.000Z',
          payFromCash: true,
        },
      ],
    });
  expect(tx.status, JSON.stringify(tx.body)).toBe(201);
}

async function countRows(portfolioId: string): Promise<Record<string, number>> {
  const rows = await Promise.all([
    harness.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.portfolioId, portfolioId)),
    harness.db
      .select()
      .from(schema.portfolioCashMovements)
      .where(eq(schema.portfolioCashMovements.portfolioId, portfolioId)),
    harness.db
      .select()
      .from(schema.portfolioCashSources)
      .where(eq(schema.portfolioCashSources.portfolioId, portfolioId)),
    harness.db.select().from(schema.dividends).where(eq(schema.dividends.portfolioId, portfolioId)),
  ]);
  return {
    transactions: rows[0].length,
    cashMovements: rows[1].length,
    cashSources: rows[2].length,
    dividends: rows[3].length,
  };
}

async function mintToken(user: SeededUser, scopes: ApiKeyScope[], name = 'sync'): Promise<string> {
  const key = await harness.ctx.apiKeys.create({ userId: user.id, name, scopes });
  return key.token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * A well-formed LEGACY (BTVAULT1) envelope. The v2 documents are opaque bytes,
 * but the account-singleton route parses its header for CAS, so a tombstone test
 * has to send something it will actually accept far enough to reach the store.
 */
function legacyEnvelope(vaultVersion: number): Buffer {
  const uuid = '018f0000-0000-7000-8000-00000000000a';
  return Buffer.from(
    encodeVaultEnvelope(
      {
        formatVersion: 1,
        cipher: VAULT_CONTENT_CIPHER,
        iv: 'aXYtOTZiaXQ=',
        keyId: uuid,
        wrappedKeys: [
          {
            keyId: uuid,
            kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'c2FsdA==' },
            wrappedVk: 'd3JhcHBlZA==',
          },
        ],
        vaultVersion,
        schemaVersion: 1,
        deviceId: uuid,
        writeId: uuid,
        writtenAt: '2026-08-08T00:00:00.000Z',
      },
      new Uint8Array([1, 2, 3, 4]),
    ),
  );
}

// ── Vault CRUD ──────────────────────────────────────────────────────────────

describe('vaults v2 — CRUD', () => {
  it('creates a vault, stores the client-built header blindly and lists it', async () => {
    const user = await seedUser('owner');
    const agent = await loginAgent(harness.app, user);
    const header = blob('BTVAULT2-header-bytes', 128);

    const created = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ name: 'Drive vault', backends: 'both', header: b64(header) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const parsed = vaultCreateResponseSchema.parse(created.body);
    expect(parsed.vault).toMatchObject({
      name: 'Drive vault',
      backends: 'both',
      portfolioCount: 0,
    });
    expect(parsed.header).toMatchObject({
      version: 1,
      sizeBytes: header.length,
      docKind: 'header',
    });

    // Stored verbatim: the server never re-encodes, pads or parses.
    const [stored] = await harness.db
      .select()
      .from(schema.vaultDocs)
      .where(eq(schema.vaultDocs.vaultId, parsed.vault.id));
    expect(Buffer.from(stored!.ciphertext).equals(header)).toBe(true);

    const list = await agent.get('/api/v1/vaults');
    expect(list.status).toBe(200);
    expect(vaultListResponseSchema.parse(list.body).vaults).toHaveLength(1);
  });

  it('refuses a duplicate name and a header/backends mismatch', async () => {
    const user = await seedUser('owner');
    const agent = await loginAgent(harness.app, user);
    await createVault(agent, { name: 'Mine' });

    const duplicate = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ name: 'Mine', backends: 'server', header: b64(blob('h')) });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe(VAULT2_ERROR_CODES.nameTaken);

    // A drive-only vault keeps no server ciphertext, so a header is a contract error.
    const mismatched = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ name: 'Drive', backends: 'drive', header: b64(blob('h')) });
    expect(mismatched.status).toBe(400);
  });

  it('caps the header at 1 MiB', async () => {
    const user = await seedUser('owner');
    const agent = await loginAgent(harness.app, user);
    const res = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      // The server rejects on the size cap without draining the request, so
      // this socket must not go back into the agent's keep-alive pool — a later
      // test picking it up fails as "Parse Error: Expected HTTP/".
      .set('Connection', 'close')
      .send({
        name: 'Too big',
        backends: 'server',
        header: b64(Buffer.alloc(VAULT_HEADER_MAX_BYTES + 1, 1)),
      });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.docTooLarge);
  });

  it('updates name and backends, and refuses a rename onto an existing name', async () => {
    const user = await seedUser('owner');
    const agent = await loginAgent(harness.app, user);
    const first = await createVault(agent, { name: 'One' });
    await createVault(agent, { name: 'Two' });

    const renamed = await agent
      .patch(`/api/v1/vaults/${first.vaultId}`)
      .set(...XRW)
      .send({ name: 'Renamed', backends: 'both' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed', backends: 'both' });

    const clash = await agent
      .patch(`/api/v1/vaults/${first.vaultId}`)
      .set(...XRW)
      .send({ name: 'Two' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe(VAULT2_ERROR_CODES.nameTaken);
  });

  it('deletes an empty vault and refuses one that still holds a portfolio', async () => {
    const user = await seedUser('owner');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);

    const join = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('portfolio')) });
    expect(join.status, JSON.stringify(join.body)).toBe(200);

    const refused = await agent.delete(`/api/v1/vaults/${vaultId}`).set(...XRW);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe(VAULT2_ERROR_CODES.notEmpty);

    const empty = await createVault(agent, { name: 'Empty' });
    const deleted = await agent.delete(`/api/v1/vaults/${empty.vaultId}`).set(...XRW);
    expect(deleted.status).toBe(204);
    const remaining = await harness.db
      .select()
      .from(schema.vaults)
      .where(eq(schema.vaults.id, empty.vaultId));
    expect(remaining).toHaveLength(0);
  });
});

// ── Client-minted vault ids (r2 §11 derives them) ───────────────────────────

describe('vaults v2 — client-supplied vault id', () => {
  it('honours a client-minted id so the header’s AAD and a derived migration id hold', async () => {
    const user = await seedUser('mintedid');
    const agent = await loginAgent(harness.app, user);
    const id = randomUUID();

    const created = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ id, name: 'Derived', backends: 'server', header: b64(blob('h')) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(vaultCreateResponseSchema.parse(created.body).vault.id).toBe(id);

    // The header the wizard built before create is reachable under that exact id.
    const header = await agent.get(`/api/v1/vaults/${id}/header`);
    expect(header.status).toBe(200);
    expect(header.headers.etag).toBe('"1"');
  });

  it('refuses a colliding id with VAULT_ID_TAKEN, distinctly from a name clash', async () => {
    const user = await seedUser('collide');
    const agent = await loginAgent(harness.app, user);
    const id = randomUUID();
    await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ id, name: 'First', backends: 'server', header: b64(blob('h')) });

    const sameId = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ id, name: 'Different name', backends: 'server', header: b64(blob('h2')) });
    expect(sameId.status).toBe(409);
    expect(sameId.body.error.code).toBe(VAULT2_ERROR_CODES.idTaken);

    const sameName = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ id: randomUUID(), name: 'First', backends: 'server', header: b64(blob('h3')) });
    expect(sameName.status).toBe(409);
    expect(sameName.body.error.code).toBe(VAULT2_ERROR_CODES.nameTaken);

    // The first vault is untouched by either refusal.
    const list = await agent.get('/api/v1/vaults');
    expect(vaultListResponseSchema.parse(list.body).vaults).toHaveLength(1);
  });

  it('never lets a client-minted id collide across accounts into an overwrite', async () => {
    const owner = await seedUser('idowner');
    const ownerAgent = await loginAgent(harness.app, owner);
    const id = randomUUID();
    await ownerAgent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ id, name: 'Mine', backends: 'server', header: b64(blob('mine')) });

    const other = await seedUser('idother');
    const otherAgent = await loginAgent(harness.app, other);
    const res = await otherAgent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ id, name: 'Theirs', backends: 'server', header: b64(blob('theirs')) });
    expect(res.status).toBe(409);
    // The same code an own-account collision gets: create must not become an
    // existence oracle for ids a caller can derive.
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.idTaken);

    // The owner's ciphertext is exactly what they wrote.
    const header = await ownerAgent.get(`/api/v1/vaults/${id}/header`);
    expect(Buffer.from(header.body as Buffer).equals(blob('mine'))).toBe(true);
    // …and the other account still owns nothing.
    const theirs = await otherAgent.get('/api/v1/vaults');
    expect(vaultListResponseSchema.parse(theirs.body).vaults).toHaveLength(0);
  });

  it('rejects a malformed id rather than minting one silently', async () => {
    const user = await seedUser('badid');
    const agent = await loginAgent(harness.app, user);
    const res = await agent
      .post('/api/v1/vaults')
      .set(...XRW)
      .send({ id: 'not-a-uuid', name: 'Bad', backends: 'server', header: b64(blob('h')) });
    expect(res.status).toBe(400);
  });
});

// ── POST /auth/reauth — the generic session step-up ─────────────────────────

describe('auth — generic session step-up (POST /auth/reauth)', () => {
  it('verifies the current session user’s password and mints nothing', async () => {
    const user = await seedUser('reauth');
    const agent = await loginAgent(harness.app, user);

    const ok = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: user.password, purpose: 'vault.qr_reveal' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    expect(ok.body).toEqual({});
    // No cookie is set or rotated: a 204 is an assertion about this instant,
    // never a credential the caller can carry.
    expect(ok.headers['set-cookie']).toBeUndefined();

    const audited = await harness.db
      .select({ action: schema.auditLog.action, meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorId, user.id), eq(schema.auditLog.action, 'auth.reauth')));
    expect(audited).toHaveLength(1);
    expect(audited[0]!.meta).toMatchObject({ purpose: 'vault.qr_reveal' });
  });

  it('401s a wrong password with the generic credential error and audits the failure', async () => {
    const user = await seedUser('reauthbad');
    const agent = await loginAgent(harness.app, user);

    const res = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: 'definitely-not-the-password', purpose: 'vault.qr_reveal' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const failures = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.actorId, user.id), eq(schema.auditLog.action, 'auth.reauth_fail')),
      );
    expect(failures).toHaveLength(1);
    expect(failures[0]!.meta).toMatchObject({ purpose: 'vault.qr_reveal' });

    // The session survives a failed step-up — this is a verifier, not a logout.
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
  });

  it('requires a session and is unreachable with a bearer token', async () => {
    const user = await seedUser('reauthbearer');

    const anonymous = await request(harness.app)
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: user.password });
    expect(anonymous.status).toBe(401);

    // Every scope a token can hold, including the account-security scope that
    // gates the rest of the security surface: the route is session-only, so the
    // bearer policy refuses it before routing.
    for (const scopes of [['account:security'], ['vault:sync'], ['portfolio:write']] as const) {
      const token = await mintToken(user, [...scopes] as ApiKeyScope[], `reauth-${scopes[0]}`);
      const res = await request(harness.app)
        .post('/api/v1/auth/reauth')
        .set(bearer(token))
        .send({ password: user.password });
      expect(res.status, `scope ${scopes[0]}`).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
    }

    // Pinned at the policy layer too, so a future carve-out has to be deliberate.
    expect(pathAcceptsBearer('/auth/reauth', 'POST')).toBe(false);
    expect(openApiPathTemplateAcceptsBearer('/auth/reauth', 'POST')).toBe(false);
  });

  it('throttles repeated failures per account and keeps a correct password out while cooling', async () => {
    const user = await seedUser('reauththrottle');
    const agent = await loginAgent(harness.app, user);

    let sawThrottle = false;
    for (let attempt = 0; attempt < 12 && !sawThrottle; attempt += 1) {
      const res = await agent
        .post('/api/v1/auth/reauth')
        .set(...XRW)
        .send({ password: `wrong-${attempt}` });
      if (res.status === 429) sawThrottle = true;
      else expect(res.status).toBe(401);
    }
    expect(sawThrottle, 'the per-account throttle never engaged').toBe(true);

    // The CORRECT password is refused while cooling: a blocked retry must not
    // ride through, or the throttle would be decorative.
    const correct = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: user.password });
    expect(correct.status).toBe(429);
  });

  it('validates the purpose without letting it change what is verified', async () => {
    const user = await seedUser('reauthpurpose');
    const agent = await loginAgent(harness.app, user);

    const tooLong = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: user.password, purpose: 'p'.repeat(65) });
    expect(tooLong.status).toBe(400);

    // A wrong password is still 401 no matter what purpose is claimed.
    const spoofed = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: 'nope', purpose: 'admin.override' });
    expect(spoofed.status).toBe(401);
  });
});

// ── Cross-user isolation ────────────────────────────────────────────────────

describe('vaults v2 — cross-user isolation', () => {
  it('answers 404 VAULT_NOT_FOUND for every foreign vault operation', async () => {
    const owner = await seedUser('owner');
    const ownerAgent = await loginAgent(harness.app, owner);
    const { vaultId } = await createVault(ownerAgent);

    const intruder = await seedUser('intruder');
    const intruderAgent = await loginAgent(harness.app, intruder);

    const read = await intruderAgent.get(`/api/v1/vaults/${vaultId}/header`);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe(VAULT2_ERROR_CODES.notFound);

    const write = await intruderAgent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(blob('evil'));
    expect(write.status).toBe(404);

    const rename = await intruderAgent
      .patch(`/api/v1/vaults/${vaultId}`)
      .set(...XRW)
      .send({ name: 'Stolen' });
    expect(rename.status).toBe(404);

    const remove = await intruderAgent.delete(`/api/v1/vaults/${vaultId}`).set(...XRW);
    expect(remove.status).toBe(404);

    // The intruder's own list is unaffected and empty.
    const list = await intruderAgent.get('/api/v1/vaults');
    expect(vaultListResponseSchema.parse(list.body).vaults).toHaveLength(0);
  });

  it('cannot join a foreign portfolio into an own vault, or an own portfolio into a foreign vault', async () => {
    const owner = await seedUser('owner');
    const ownerAgent = await loginAgent(harness.app, owner);
    const ownerPortfolio = await defaultPortfolioId(ownerAgent);
    const ownerVault = await createVault(ownerAgent);

    const intruder = await seedUser('intruder');
    const intruderAgent = await loginAgent(harness.app, intruder);
    const intruderVault = await createVault(intruderAgent);

    const foreignPortfolio = await intruderAgent
      .post(`/api/v1/portfolios/${ownerPortfolio}/vault`)
      .set(...XRW)
      .send({ vaultId: intruderVault.vaultId, blob: b64(blob('x')) });
    expect(foreignPortfolio.status).toBe(404);

    const foreignVault = await ownerAgent
      .post(`/api/v1/portfolios/${ownerPortfolio}/vault`)
      .set(...XRW)
      .send({ vaultId: intruderVault.vaultId, blob: b64(blob('x')) });
    expect(foreignVault.status).toBe(404);
    expect(foreignVault.body.error.code).toBe(VAULT2_ERROR_CODES.notFound);

    // Nothing was purged by either refusal.
    const [portfolio] = await harness.db
      .select()
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, ownerPortfolio));
    expect(portfolio!.vaultId).toBeNull();
    expect(ownerVault.vaultId).toBeTruthy();
  });
});

// ── Join / leave ────────────────────────────────────────────────────────────

describe('vaults v2 — join and leave', () => {
  it('joins in one transaction: blob stored, cleartext purged, vault_id set', async () => {
    const user = await seedUser('joiner');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    await seedPortfolioContent(agent, portfolioId);

    const before = await countRows(portfolioId);
    expect(before.transactions).toBeGreaterThan(0);
    expect(before.cashMovements).toBeGreaterThan(0);
    expect(before.cashSources).toBeGreaterThan(0);

    const { vaultId } = await createVault(agent);
    const ciphertext = blob('encrypted-portfolio', 256);
    const res = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(ciphertext) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = vaultJoinResponseSchema.parse(res.body);
    expect(parsed.state).toMatchObject({ portfolioId, vaultId });
    expect(parsed.blob).toMatchObject({ version: 1, docKind: 'portfolio', portfolioId });

    const after = await countRows(portfolioId);
    expect(after).toEqual({
      transactions: 0,
      cashMovements: 0,
      cashSources: 0,
      dividends: 0,
    });

    const [stored] = await harness.db
      .select()
      .from(schema.vaultDocs)
      .where(eq(schema.vaultDocs.portfolioId, portfolioId));
    expect(Buffer.from(stored!.ciphertext).equals(ciphertext)).toBe(true);

    const [portfolio] = await harness.db
      .select()
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, portfolioId));
    expect(portfolio!.vaultId).toBe(vaultId);
  });

  it('purges EVERY portfolio-scoped table and leaves the account’s other portfolio intact', async () => {
    const user = await seedUser('multi');
    const agent = await loginAgent(harness.app, user);
    const vaultedId = await defaultPortfolioId(agent);
    await seedPortfolioContent(agent, vaultedId);

    const second = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Normal' });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const normalId = second.body.portfolio.id as string;
    await seedPortfolioContent(agent, normalId);

    // Extra portfolio-scoped rows the ledger endpoints do not create on their own.
    await harness.db.insert(schema.portfolioSettings).values({
      portfolioId: vaultedId,
      key: 'taxCountry',
      value: 'AT',
    });
    await harness.db.insert(schema.importBatches).values({
      ownerId: user.id,
      portfolioId: vaultedId,
      brokerId: 'flatex',
      filename: 'statement.csv',
    });
    const [movement] = await harness.db
      .select()
      .from(schema.portfolioCashMovements)
      .where(eq(schema.portfolioCashMovements.portfolioId, vaultedId))
      .limit(1);
    const [tag] = await harness.db
      .insert(schema.cashTags)
      .values({ userId: user.id, name: 'Salary', color: '#fff' })
      .returning();
    await harness.db
      .insert(schema.cashMovementTags)
      .values({ movementId: movement!.id, tagId: tag!.id });

    const { vaultId } = await createVault(agent);
    const res = await agent
      .post(`/api/v1/portfolios/${vaultedId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Nothing survives for the vaulted portfolio…
    expect(await countRows(vaultedId)).toEqual({
      transactions: 0,
      cashMovements: 0,
      cashSources: 0,
      dividends: 0,
    });
    const settings = await harness.db
      .select()
      .from(schema.portfolioSettings)
      .where(eq(schema.portfolioSettings.portfolioId, vaultedId));
    expect(settings).toHaveLength(0);
    const batches = await harness.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.portfolioId, vaultedId));
    expect(batches).toHaveLength(0);
    const movementTags = await harness.db
      .select()
      .from(schema.cashMovementTags)
      .where(eq(schema.cashMovementTags.movementId, movement!.id));
    expect(movementTags).toHaveLength(0);

    // …and the account's other, NORMAL portfolio is untouched.
    const normalAfter = await countRows(normalId);
    expect(normalAfter.transactions).toBeGreaterThan(0);
    expect(normalAfter.cashMovements).toBeGreaterThan(0);
    expect(normalAfter.cashSources).toBeGreaterThan(0);

    // User-scoped rows survive by design (the ticker-visibility caveat).
    const tags = await harness.db
      .select()
      .from(schema.cashTags)
      .where(eq(schema.cashTags.userId, user.id));
    expect(tags.length).toBeGreaterThan(0);
  });

  it('is both-or-neither: an injected failure after the purge rolls the whole join back', async () => {
    const user = await seedUser('atomic');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    await seedPortfolioContent(agent, portfolioId);
    const before = await countRows(portfolioId);

    const { vaultId } = await createVault(agent);
    const repo = createVaultRepository(harness.db);
    await expect(
      repo.joinPortfolio({
        userId: user.id,
        portfolioId,
        vaultId,
        ciphertext: blob('p'),
        afterPurge: () => Promise.reject(new Error('injected mid-join failure')),
      }),
    ).rejects.toThrow('injected mid-join failure');

    // Every one of the three effects is undone together.
    expect(await countRows(portfolioId)).toEqual(before);
    const docs = await harness.db
      .select()
      .from(schema.vaultDocs)
      .where(eq(schema.vaultDocs.portfolioId, portfolioId));
    expect(docs).toHaveLength(0);
    const [portfolio] = await harness.db
      .select()
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, portfolioId));
    expect(portfolio!.vaultId).toBeNull();
  });

  it('refuses a second join and reports the vault membership on the portfolio', async () => {
    const user = await seedUser('twice');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);

    const first = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });
    expect(first.status).toBe(200);

    const second = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p2')) });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(VAULT2_ERROR_CODES.alreadyVaulted);
  });

  it('leaves by repopulating the posted rows, clearing vault_id and retiring the blob', async () => {
    const user = await seedUser('leaver');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);

    const joined = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });
    expect(joined.status).toBe(200);

    const sourceId = randomUUID();
    const document: VaultPortfolioRestoreDocument = {
      schemaVersion: 1,
      entities: [
        {
          kind: 'cashSource',
          id: sourceId,
          rev: 1,
          editedAt: '2026-02-01T00:00:00.000Z',
          editedBy: randomUUID(),
          deletedAt: null,
          data: {
            portfolioId,
            name: 'Main',
            type: 'cash',
            isMain: true,
            archivedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
        {
          kind: 'cashMovement',
          id: randomUUID(),
          rev: 1,
          editedAt: '2026-02-01T00:00:00.000Z',
          editedBy: randomUUID(),
          deletedAt: null,
          data: {
            portfolioId,
            sourceId,
            kind: 'deposit',
            amountEur: '1000.000000',
            transactionId: null,
            transferId: null,
            counterpartSourceId: null,
            dividendId: null,
            taxYear: null,
            executedAt: '2026-01-02T00:00:00.000Z',
            note: null,
            source: 'manual',
            dedupHash: null,
            originalCurrency: null,
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        },
      ],
    };

    const restoreId = randomUUID();
    const left = await agent
      .delete(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ restoreId, document });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    const parsed = vaultLeaveResponseSchema.parse(left.body);
    expect(parsed).toMatchObject({ restoreId, idempotent: false });
    expect(parsed.state.vaultId).toBeNull();

    const after = await countRows(portfolioId);
    expect(after.cashSources).toBe(1);
    expect(after.cashMovements).toBe(1);

    const docs = await harness.db
      .select()
      .from(schema.vaultDocs)
      .where(eq(schema.vaultDocs.portfolioId, portfolioId));
    expect(docs).toHaveLength(0);

    // The vault itself survives and is now empty, hence deletable.
    const deleted = await agent.delete(`/api/v1/vaults/${vaultId}`).set(...XRW);
    expect(deleted.status).toBe(204);
  });

  it('acknowledges a replayed leave idempotently instead of inserting twice', async () => {
    const user = await seedUser('replay');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    const document: VaultPortfolioRestoreDocument = {
      schemaVersion: 1,
      entities: [
        {
          kind: 'cashSource',
          id: randomUUID(),
          rev: 1,
          editedAt: '2026-02-01T00:00:00.000Z',
          editedBy: randomUUID(),
          deletedAt: null,
          data: {
            portfolioId,
            name: 'Main',
            type: 'cash',
            isMain: true,
            archivedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    };
    const restoreId = randomUUID();
    const send = () =>
      agent
        .delete(`/api/v1/portfolios/${portfolioId}/vault`)
        .set(...XRW)
        .send({ restoreId, document });

    expect((await send()).body.idempotent).toBe(false);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
    expect((await countRows(portfolioId)).cashSources).toBe(1);
  });

  it('tells a replayed leave apart from one against a never-vaulted portfolio', async () => {
    const user = await seedUser('notvaulted');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);

    const emptyDocument = { schemaVersion: 1, entities: [] } as const;

    // Never vaulted: a precise 409, NOT a silent idempotent success. Answering
    // this one with `ok` would confirm a transition that never happened.
    const never = await agent
      .delete(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ restoreId: randomUUID(), document: emptyDocument });
    expect(never.status).toBe(409);
    expect(never.body.error.code).toBe(VAULT2_ERROR_CODES.notVaulted);

    // Now actually vault it and leave, then replay the SAME restoreId.
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    const restoreId = randomUUID();
    const first = await agent
      .delete(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ restoreId, document: emptyDocument });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.idempotent).toBe(false);

    const replay = await agent
      .delete(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ restoreId, document: emptyDocument });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);

    // A DIFFERENT restoreId against the same, now-unvaulted portfolio is the
    // never-vaulted case again — the receipt is what separates the two.
    const other = await agent
      .delete(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ restoreId: randomUUID(), document: emptyDocument });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe(VAULT2_ERROR_CODES.notVaulted);
  });

  it('does not let one account’s restore id acknowledge another’s leave', async () => {
    const owner = await seedUser('receiptowner');
    const ownerAgent = await loginAgent(harness.app, owner);
    const ownerPortfolio = await defaultPortfolioId(ownerAgent);
    const { vaultId } = await createVault(ownerAgent);
    await ownerAgent
      .post(`/api/v1/portfolios/${ownerPortfolio}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    const restoreId = randomUUID();
    await ownerAgent
      .delete(`/api/v1/portfolios/${ownerPortfolio}/vault`)
      .set(...XRW)
      .send({ restoreId, document: { schemaVersion: 1, entities: [] } });

    // Another account replaying that receipt's id gets the honest refusal for
    // ITS portfolio, never a borrowed acknowledgement.
    const other = await seedUser('receiptother');
    const otherAgent = await loginAgent(harness.app, other);
    const otherPortfolio = await defaultPortfolioId(otherAgent);
    const res = await otherAgent
      .delete(`/api/v1/portfolios/${otherPortfolio}/vault`)
      .set(...XRW)
      .send({ restoreId, document: { schemaVersion: 1, entities: [] } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.notVaulted);
  });

  it('refuses to restore on top of surviving cleartext rows', async () => {
    const user = await seedUser('dirty');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    // Simulate drift: a row reappears for a vaulted portfolio.
    await harness.db.insert(schema.portfolioCashSources).values({
      portfolioId,
      name: 'Ghost',
      type: 'cash',
      isMain: true,
    });

    const res = await agent
      .delete(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ restoreId: randomUUID(), document: { schemaVersion: 1, entities: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.restoreInvalid);
  });
});

// ── The vaulted-portfolio alias (§4) ────────────────────────────────────────

describe('vaults v2 — the vaulted-portfolio alias', () => {
  it('round-trips an alias on a vaulted portfolio and clears it with null', async () => {
    const user = await seedUser('alias');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    const set = await agent
      .patch(`/api/v1/portfolios/${portfolioId}/alias`)
      .set(...XRW)
      .send({ alias: 'Locked wallet' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(portfolioVaultStateSchema.parse(set.body)).toMatchObject({
      portfolioId,
      vaultId,
      alias: 'Locked wallet',
    });

    // Persisted on the portfolio row, readable without any key.
    const [row] = await harness.db
      .select({ alias: schema.portfolios.alias, name: schema.portfolios.name })
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, portfolioId));
    expect(row!.alias).toBe('Locked wallet');
    // It writes ONLY the alias — the portfolio's name is untouched.
    expect(row!.name).toBe('Main');

    const cleared = await agent
      .patch(`/api/v1/portfolios/${portfolioId}/alias`)
      .set(...XRW)
      .send({ alias: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.alias).toBeNull();
  });

  it('refuses a normal portfolio with 409 — its rename stays on the normal route', async () => {
    const user = await seedUser('aliasnormal');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);

    const res = await agent
      .patch(`/api/v1/portfolios/${portfolioId}/alias`)
      .set(...XRW)
      .send({ alias: 'Nope' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.notVaulted);
    const [row] = await harness.db
      .select({ alias: schema.portfolios.alias })
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, portfolioId));
    expect(row!.alias).toBeNull();

    // The ordinary rename still works for it, unchanged.
    const renamed = await agent
      .patch(`/api/v1/portfolios/${portfolioId}`)
      .set(...XRW)
      .send({ name: 'Renamed normally' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  });

  it('is session-only: a vault:sync bearer is refused', async () => {
    const user = await seedUser('aliasbearer');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    const token = await mintToken(user, ['vault:sync']);
    const bearerCall = await request(harness.app)
      .patch(`/api/v1/portfolios/${portfolioId}/alias`)
      .set(bearer(token))
      .send({ alias: 'From a token' });
    expect(bearerCall.status).toBe(403);
    expect(bearerCall.body.error.code).toBe('API_KEY_FORBIDDEN');

    // A portfolio-scoped token fares no better — the route is session-only,
    // not merely scope-gated.
    const portfolioToken = await mintToken(user, ['portfolio:write'], 'aliaspf');
    const scoped = await request(harness.app)
      .patch(`/api/v1/portfolios/${portfolioId}/alias`)
      .set(bearer(portfolioToken))
      .send({ alias: 'From a token' });
    expect(scoped.status).toBe(403);
  });

  it('rejects an over-long alias and never lets it reach the column', async () => {
    const user = await seedUser('aliaslong');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    const res = await agent
      .patch(`/api/v1/portfolios/${portfolioId}/alias`)
      .set(...XRW)
      .send({ alias: 'x'.repeat(VAULT_ALIAS_MAX_LENGTH + 1) });
    expect(res.status).toBe(400);
    const [row] = await harness.db
      .select({ alias: schema.portfolios.alias })
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, portfolioId));
    expect(row!.alias).toBeNull();
  });

  it('cannot set an alias on another account’s vaulted portfolio', async () => {
    const owner = await seedUser('aliasowner');
    const ownerAgent = await loginAgent(harness.app, owner);
    const portfolioId = await defaultPortfolioId(ownerAgent);
    const { vaultId } = await createVault(ownerAgent);
    await ownerAgent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    const intruder = await seedUser('aliasintruder');
    const intruderAgent = await loginAgent(harness.app, intruder);
    const res = await intruderAgent
      .patch(`/api/v1/portfolios/${portfolioId}/alias`)
      .set(...XRW)
      .send({ alias: 'Stolen' });
    expect(res.status).toBe(404);

    const [row] = await harness.db
      .select({ alias: schema.portfolios.alias })
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, portfolioId));
    expect(row!.alias).toBeNull();
  });
});

// ── Document CAS ────────────────────────────────────────────────────────────

describe('vaults v2 — per-document compare-and-swap', () => {
  it('requires a precondition, then versions each document independently', async () => {
    const user = await seedUser('cas');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p1')) });

    const naked = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .send(blob('h2'));
    expect(naked.status).toBe(428);
    expect(naked.body.error.code).toBe(VAULT2_ERROR_CODES.preconditionRequired);

    const stale = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"7"')
      .send(blob('h2'));
    expect(stale.status).toBe(412);
    // r2 §15: every CAS 412 carries the server's version at the top level.
    expect(vaultVersionConflictResponseSchema.parse(stale.body)).toMatchObject({
      error: { code: VAULT2_ERROR_CODES.versionConflict },
      currentVersion: 1,
    });

    const ok = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(blob('h2'));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(vaultDocMetadataSchema.parse(ok.body).version).toBe(2);
    expect(ok.headers.etag).toBe('"2"');

    // The portfolio blob is untouched by the header write: independent CAS.
    const portfolioDoc = await agent.get(`/api/v1/vaults/${vaultId}/portfolios/${portfolioId}`);
    expect(portfolioDoc.status).toBe(200);
    expect(portfolioDoc.headers.etag).toBe('"1"');

    const conditional = await agent
      .get(`/api/v1/vaults/${vaultId}/portfolios/${portfolioId}`)
      .set('If-None-Match', '"1"');
    expect(conditional.status).toBe(304);
  });

  it('creates with If-None-Match: * and refuses a second create', async () => {
    const user = await seedUser('create');
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent, { backends: 'drive' });
    // Drive-only keeps no server bytes; flip it so the sync surface is live.
    await agent
      .patch(`/api/v1/vaults/${vaultId}`)
      .set(...XRW)
      .send({ backends: 'both' });

    const created = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(blob('h1'));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.version).toBe(1);

    const again = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(blob('h1b'));
    expect(again.status).toBe(412);
  });

  it('refuses a portfolio blob for a portfolio that is not in the vault', async () => {
    const user = await seedUser('mint');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);

    const res = await agent
      .put(`/api/v1/vaults/${vaultId}/portfolios/${portfolioId}`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(blob('unrelated'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.notFound);
  });

  it('refuses server document writes for a drive-only vault', async () => {
    const user = await seedUser('driveonly');
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent, { backends: 'drive' });

    const res = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(blob('h'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.backendUnavailable);
  });
});

// ── Bearer policy ───────────────────────────────────────────────────────────

describe('vaults v2 — bearer policy', () => {
  const EXPECTED_ALLOWLIST = [
    { method: 'GET', path: '/vaults' },
    { method: 'GET', path: '/vaults/{vaultId}/header' },
    { method: 'PUT', path: '/vaults/{vaultId}/header' },
    { method: 'GET', path: '/vaults/{vaultId}/common' },
    { method: 'PUT', path: '/vaults/{vaultId}/common' },
    { method: 'GET', path: '/vaults/{vaultId}/portfolios/{portfolioId}' },
    { method: 'PUT', path: '/vaults/{vaultId}/portfolios/{portfolioId}' },
  ] as const;

  const EXPECTED_ROUTER_GUARDS = [
    { method: `${BEARER_OPAQUE_MOUNT_METHOD}:requireUser[1]`, path: '/vaults' },
    {
      method: `${BEARER_OPAQUE_MOUNT_METHOD}:requireCookieSessionOrVaultsSync[1]`,
      path: '/vaults',
    },
  ] as const;

  const live = (path: string): string =>
    path
      .replace('{vaultId}', '018f0000-0000-7000-8000-00000000000a')
      .replace('{portfolioId}', '018f0000-0000-7000-8000-00000000000b');

  it('pins the exact sync routes and defaults every transition and future route closed', () => {
    expect(VAULTS_SYNC_BEARER_ROUTE_ALLOWLIST).toEqual(EXPECTED_ALLOWLIST);
    for (const route of EXPECTED_ALLOWLIST) {
      expect(vaultsSyncRouteAcceptsBearer(route.method, live(route.path))).toBe(true);
      expect(pathAcceptsBearer(live(route.path), route.method)).toBe(true);
      expect(openApiPathTemplateAcceptsBearer(route.path, route.method)).toBe(true);
    }
    for (const route of [...VAULTS_SESSION_ONLY_ROUTES, ...PORTFOLIO_VAULT_SESSION_ONLY_ROUTES]) {
      expect(pathAcceptsBearer(live(route.path), route.method)).toBe(false);
      expect(openApiPathTemplateAcceptsBearer(route.path, route.method)).toBe(false);
    }
    expect(pathAcceptsBearer('/vaults/future-transition', 'POST')).toBe(false);
    expect(pathAcceptsBearer('/vaults/018f0000-0000-7000-8000-00000000000a/wipe', 'POST')).toBe(
      false,
    );
  });

  it('classifies every real mounted /vaults route as sync or session-only', () => {
    const mounted = mountedBearerRouteInventory(buildRouteTable(), '/vaults');
    const classified = [
      ...VAULTS_SYNC_BEARER_ROUTE_ALLOWLIST,
      ...VAULTS_SESSION_ONLY_ROUTES,
      ...EXPECTED_ROUTER_GUARDS,
    ].map(({ method, path }) => ({ method, path }));
    const sort = (routes: Array<{ method: string; path: string }>) =>
      routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    expect(new Set(classified.map((r) => `${r.method} ${r.path}`)).size).toBe(classified.length);
    expect(sort(mounted)).toEqual(sort(classified));
  });

  it('runs an opaque CAS round trip on a bearer and refuses every transition', async () => {
    const user = await seedUser('sync');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent, { name: 'Synced' });
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p1')) });

    const token = await mintToken(user, ['vault:sync']);

    // The list is the NARROW projection: no portfolio count, no timestamps.
    const list = await request(harness.app).get('/api/v1/vaults').set(bearer(token));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const parsed = vaultSyncListResponseSchema.parse(list.body);
    expect(parsed.vaults).toEqual([
      { id: vaultId, name: 'Synced', backends: 'server', portfolioIds: [portfolioId] },
    ]);

    const read = await request(harness.app)
      .get(`/api/v1/vaults/${vaultId}/portfolios/${portfolioId}`)
      .set(bearer(token));
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe('"1"');
    expect(Buffer.from(read.body as Buffer).equals(blob('p1'))).toBe(true);

    const write = await request(harness.app)
      .put(`/api/v1/vaults/${vaultId}/portfolios/${portfolioId}`)
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(blob('p2'));
    expect(write.status, JSON.stringify(write.body)).toBe(200);
    expect(write.body.version).toBe(2);

    // Every transition stays session-only, whatever the token holds.
    for (const call of [
      request(harness.app)
        .post('/api/v1/vaults')
        .set(bearer(token))
        .send({
          name: 'Bearer vault',
          backends: 'server',
          header: b64(blob('h')),
        }),
      request(harness.app)
        .patch(`/api/v1/vaults/${vaultId}`)
        .set(bearer(token))
        .send({ name: 'Renamed' }),
      request(harness.app).delete(`/api/v1/vaults/${vaultId}`).set(bearer(token)),
      request(harness.app)
        .post(`/api/v1/portfolios/${portfolioId}/vault`)
        .set(bearer(token))
        .send({ vaultId, blob: b64(blob('x')) }),
      request(harness.app)
        .delete(`/api/v1/portfolios/${portfolioId}/vault`)
        .set(bearer(token))
        .send({ restoreId: randomUUID(), document: { schemaVersion: 1, entities: [] } }),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
    }
  });

  it('refuses a token that holds portfolio scopes but not vault:sync', async () => {
    const user = await seedUser('wrongscope');
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent);
    const token = await mintToken(user, ['portfolio:read', 'portfolio:write']);

    const list = await request(harness.app).get('/api/v1/vaults').set(bearer(token));
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const read = await request(harness.app)
      .get(`/api/v1/vaults/${vaultId}/header`)
      .set(bearer(token));
    expect(read.status).toBe(403);
  });

  it('never lets a vault:sync bearer read another account’s vault', async () => {
    const owner = await seedUser('owner');
    const ownerAgent = await loginAgent(harness.app, owner);
    const { vaultId } = await createVault(ownerAgent);

    const other = await seedUser('other');
    const token = await mintToken(other, ['vault:sync']);
    const res = await request(harness.app)
      .get(`/api/v1/vaults/${vaultId}/header`)
      .set(bearer(token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.notFound);
  });
});

// ── Kill rails ──────────────────────────────────────────────────────────────

describe('vaults v2 — portfolio-scoped kill rails', () => {
  it('kills server portfolio reads for a vaulted portfolio while the account stays normal', async () => {
    const user = await seedUser('killrail');
    const agent = await loginAgent(harness.app, user);
    const vaultedId = await defaultPortfolioId(agent);
    await seedPortfolioContent(agent, vaultedId);

    const second = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Normal' });
    const normalId = second.body.portfolio.id as string;
    await seedPortfolioContent(agent, normalId);

    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${vaultedId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    // The vaulted portfolio is refused by the snapshot service with the SAME
    // PARANOID_MODE error a paranoid account gets — the account-level binding is
    // `action: throw`, and the vault rail deliberately behaves identically.
    await expect(harness.ctx.snapshots.invalidate(vaultedId, '2026-01-01')).rejects.toMatchObject({
      statusCode: 403,
      code: 'PARANOID_MODE',
    });
    await expect(harness.ctx.snapshots.getSeries(vaultedId)).rejects.toMatchObject({
      code: 'PARANOID_MODE',
    });
    const snapshotState = await harness.db
      .select()
      .from(schema.portfolioSnapshotState)
      .where(eq(schema.portfolioSnapshotState.portfolioId, vaultedId));
    expect(snapshotState).toHaveLength(0);

    // The HTTP rail answers the same code, and only for the vaulted portfolio.
    const vaultedRead = await agent.get(`/api/v1/portfolios/${vaultedId}`);
    expect(vaultedRead.status).toBe(403);
    expect(vaultedRead.body.error.code).toBe('PARANOID_MODE');
    const vaultedWrite = await agent
      .post(`/api/v1/portfolios/${vaultedId}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 10 });
    expect(vaultedWrite.status).toBe(403);
    // Leave stays reachable — it is the only way out of a vault.
    const leave = await agent
      .delete(`/api/v1/portfolios/${vaultedId}/vault`)
      .set(...XRW)
      .send({ restoreId: randomUUID(), document: { schemaVersion: 1, entities: [] } });
    expect(leave.status, JSON.stringify(leave.body)).toBe(200);

    // …while the normal portfolio of the SAME account keeps working end to end.
    const normalRead = await agent.get(`/api/v1/portfolios/${normalId}`);
    expect(normalRead.status, JSON.stringify(normalRead.body)).toBe(200);

    // The account itself is still normal — the account-level rails did not fire.
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.privacyMode).toBe('normal');
  });

  it('exposes the vault membership through the enforcement resolver', async () => {
    const user = await seedUser('resolver');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);

    const { createParanoidEnforcementRepository } =
      await import('../data/repositories/paranoidEnforcementRepository');
    const subjects = createParanoidEnforcementRepository(harness.db);
    expect(await subjects.portfolioOwner(portfolioId)).toEqual({
      exists: true,
      userId: user.id,
      vaultId: null,
    });

    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    expect(await subjects.portfolioOwner(portfolioId)).toEqual({
      exists: true,
      userId: user.id,
      vaultId,
    });
    expect(await subjects.portfolioOwner(MISSING_ID)).toEqual({
      exists: false,
      userId: null,
      vaultId: null,
    });
  });

  it('refuses to join a portfolio that still has an active mirrorchain membership', async () => {
    const user = await seedUser('chained');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);

    const [chain] = await harness.db
      .insert(schema.mirrorChains)
      .values({ name: 'Household', createdBy: user.id, createdByUsername: user.username })
      .returning();
    await harness.db.insert(schema.mirrorChainMembers).values({
      chainId: chain!.id,
      userId: user.id,
      username: user.username,
      portfolioId,
      role: 'owner',
      status: 'active',
    });

    const res = await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.joinBlocked);
  });
});

// ── Kill-rail route census ──────────────────────────────────────────────────

describe('vaults v2 — the portfolio-scoped rail covers every mounted surface', () => {
  it('resolves a portfolio id for EVERY mounted route that names one', () => {
    const PORTFOLIO_ID = '018f0000-0000-7000-8000-00000000000b';
    const VAULT_ID = '018f0000-0000-7000-8000-00000000000a';

    const mounted = buildRouteTable()
      .map((surface) => ('path' in surface ? (surface.path as string) : ''))
      .filter((path) => path.includes('{portfolioId}'));
    expect(mounted.length).toBeGreaterThan(20);

    for (const template of mounted) {
      const live = template
        .replace('/api/v1', '')
        .replace('{portfolioId}', PORTFOLIO_ID)
        .replace('{vaultId}', VAULT_ID)
        // Every other id segment gets a distinct uuid so a rule that reads the
        // WRONG segment index shows up as a mismatch rather than a pass.
        .replace(/\{[A-Za-z]+\}/g, '018f0000-0000-7000-8000-0000000000ff');
      expect(vaultedPortfolioIdInPath(live), `no rule covers ${template}`).toBe(PORTFOLIO_ID);
    }
  });

  it('leaves unrelated paths alone', () => {
    expect(vaultedPortfolioIdInPath('/assets/018f0000-0000-7000-8000-00000000000b')).toBeNull();
    expect(vaultedPortfolioIdInPath('/vaults')).toBeNull();
    expect(
      vaultedPortfolioIdInPath('/vaults/018f0000-0000-7000-8000-00000000000a/header'),
    ).toBeNull();
    expect(vaultedPortfolioIdInPath('/portfolios')).toBeNull();
  });

  it('states a reason for every route kept reachable while vaulted', () => {
    for (const route of VAULTED_PORTFOLIO_KEPT_ROUTES) {
      expect(route.reason.length, `${route.method} ${route.path}`).toBeGreaterThan(30);
    }
    // The two that must never be killed, or a vaulted portfolio is unreachable.
    const paths = VAULTED_PORTFOLIO_KEPT_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('DELETE /portfolios/{portfolioId}/vault');
    expect(paths).toContain('GET /vaults/{vaultId}/portfolios/{portfolioId}');
  });
});

// ── Purge census ────────────────────────────────────────────────────────────

describe('vaults v2 — purge completeness census', () => {
  it('classifies every vault-axis table as portfolio-scoped or account-scoped', () => {
    expect(() => assertVaultPortfolioPurgeCompleteness()).not.toThrow();
  });

  it('pins the purged table list so a silent removal fails here', () => {
    expect([...VAULT_PORTFOLIO_PURGE_ORDER].sort()).toEqual([
      'cash_budget_fires',
      'cash_budgets',
      'cash_movement_tags',
      'dividends',
      'import_batches',
      'import_rows',
      'portfolio_cash_movements',
      'portfolio_cash_sources',
      'portfolio_daily_snapshots',
      'portfolio_settings',
      'portfolio_snapshot_state',
      'standing_order_runs',
      'standing_orders',
      'transactions',
    ]);
    // Every account-scoped exemption carries a stated reason.
    for (const reason of Object.values(VAULT_PORTFOLIO_ACCOUNT_SCOPED_TABLES)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

// ── r2 §8: the `common` document ────────────────────────────────────────────

describe('vaults v2 — the common document (r2 §8)', () => {
  it('versions common independently of header and portfolio, and caps it at 4 MiB', async () => {
    const user = await seedUser('common');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p1')) });

    // Absent until written, and the create path never invents one.
    const missing = await agent.get(`/api/v1/vaults/${vaultId}/common`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe(VAULT2_ERROR_CODES.notFound);

    const created = await agent
      .put(`/api/v1/vaults/${vaultId}/common`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(blob('common-doc'));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(vaultDocMetadataSchema.parse(created.body)).toMatchObject({
      docKind: 'common',
      portfolioId: null,
      version: 1,
    });

    const updated = await agent
      .put(`/api/v1/vaults/${vaultId}/common`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(blob('common-doc-2'));
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);

    // Header and portfolio blobs are untouched: three independent CAS tokens.
    const header = await agent.get(`/api/v1/vaults/${vaultId}/header`);
    expect(header.headers.etag).toBe('"1"');
    const portfolioDoc = await agent.get(`/api/v1/vaults/${vaultId}/portfolios/${portfolioId}`);
    expect(portfolioDoc.headers.etag).toBe('"1"');

    // Exactly one `common` row can exist per vault.
    const rows = await harness.db
      .select()
      .from(schema.vaultDocs)
      .where(and(eq(schema.vaultDocs.vaultId, vaultId), eq(schema.vaultDocs.docKind, 'common')));
    expect(rows).toHaveLength(1);
  });

  it('applies the per-kind cap, not one shared cap', async () => {
    const user = await seedUser('caps');
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent);

    // 2 MiB is over the 1 MiB header cap but well under the 4 MiB common cap.
    const twoMiB = Buffer.alloc(2 * 1024 * 1024, 7);
    const headerTooBig = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      // The server rejects on the size cap without draining the request, so
      // this socket must not go back into the agent's keep-alive pool — a later
      // test picking it up fails as "Parse Error: Expected HTTP/".
      .set('Connection', 'close')
      .send(twoMiB);
    expect(headerTooBig.status).toBe(413);
    expect(headerTooBig.body.error.code).toBe(VAULT2_ERROR_CODES.docTooLarge);

    const commonOk = await agent
      .put(`/api/v1/vaults/${vaultId}/common`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-None-Match', '*')
      .send(twoMiB);
    expect(commonOk.status, JSON.stringify(commonOk.body)).toBe(200);
    expect(commonOk.body.sizeBytes).toBe(twoMiB.length);

    const commonTooBig = await agent
      .put(`/api/v1/vaults/${vaultId}/common`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      // The server rejects on the size cap without draining the request, so
      // this socket must not go back into the agent's keep-alive pool — a later
      // test picking it up fails as "Parse Error: Expected HTTP/".
      .set('Connection', 'close')
      .send(Buffer.alloc(VAULT_COMMON_DOC_MAX_BYTES + 1, 7));
    expect(commonTooBig.status).toBe(413);
  });
});

// ── r2 §11: the server-coordinated v1 → v2 migration ────────────────────────

describe('vaults v2 — v1 to v2 migration protocol (r2 §11)', () => {
  /** Give the account a legacy vault row to migrate. */
  async function seedLegacyVault(userId: string): Promise<void> {
    await harness.db.insert(schema.paranoidVaults).values({
      userId,
      version: 1,
      formatVersion: 1,
      sizeBytes: 8,
      blob: Buffer.alloc(8, 1),
    });
  }

  const NONCE_A = 'client-nonce-aaaaaaaaaaaaaaaa';
  const NONCE_B = 'client-nonce-bbbbbbbbbbbbbbbb';

  it('reports no legacy vault when there is nothing to migrate', async () => {
    const user = await seedUser('nolegacy');
    const agent = await loginAgent(harness.app, user);
    const res = await agent.get('/api/v1/vaults/migration');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(vaultMigrationStateSchema.parse(res.body)).toEqual({
      legacyPresent: false,
      migratingBy: null,
      claimExpiresAt: null,
      migratedTo: null,
    });

    const claim = await agent
      .post('/api/v1/vaults/migration/claim')
      .set(...XRW)
      .send({ clientNonce: NONCE_A });
    expect(claim.status).toBe(404);
  });

  it('lets exactly one client hold the claim, and refuses the loser with the live claim', async () => {
    const user = await seedUser('claimrace');
    await seedLegacyVault(user.id);
    const agent = await loginAgent(harness.app, user);

    const first = await agent
      .post('/api/v1/vaults/migration/claim')
      .set(...XRW)
      .send({ clientNonce: NONCE_A });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const state = vaultMigrationStateSchema.parse(first.body);
    expect(state.migratingBy).toBe(NONCE_A);
    expect(new Date(state.claimExpiresAt!).getTime() - Date.now()).toBeGreaterThan(
      VAULT_MIGRATION_CLAIM_TTL_MS - 60_000,
    );

    const loser = await agent
      .post('/api/v1/vaults/migration/claim')
      .set(...XRW)
      .send({ clientNonce: NONCE_B });
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe(VAULT2_ERROR_CODES.migrationClaimed);
    expect(loser.body.state.migratingBy).toBe(NONCE_A);

    // Re-claiming with the SAME nonce resumes a crashed migration.
    const resumed = await agent
      .post('/api/v1/vaults/migration/claim')
      .set(...XRW)
      .send({ clientNonce: NONCE_A });
    expect(resumed.status).toBe(200);

    // Renew extends only the live holder's claim.
    const renewed = await agent
      .post('/api/v1/vaults/migration/renew')
      .set(...XRW)
      .send({ clientNonce: NONCE_A });
    expect(renewed.status).toBe(200);
    const foreignRenew = await agent
      .post('/api/v1/vaults/migration/renew')
      .set(...XRW)
      .send({ clientNonce: NONCE_B });
    expect(foreignRenew.status).toBe(409);
  });

  it('flips only with a live claim and a real v2 vault, then makes legacy a read-only tombstone', async () => {
    const user = await seedUser('flip');
    await seedLegacyVault(user.id);
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent);

    // No claim yet: the flip is refused and nothing commits.
    const premature = await agent
      .post('/api/v1/vaults/migration/flip')
      .set(...XRW)
      .send({ clientNonce: NONCE_A, vaultId });
    expect(premature.status).toBe(409);
    expect(premature.body.error.code).toBe(VAULT2_ERROR_CODES.migrationIncomplete);

    await agent
      .post('/api/v1/vaults/migration/claim')
      .set(...XRW)
      .send({ clientNonce: NONCE_A });

    // A successor that is not this account's vault can never be pinned.
    const foreignTarget = await agent
      .post('/api/v1/vaults/migration/flip')
      .set(...XRW)
      .send({ clientNonce: NONCE_A, vaultId: MISSING_ID });
    expect(foreignTarget.status).toBe(404);
    expect(foreignTarget.body.error.code).toBe(VAULT2_ERROR_CODES.notFound);

    const flipped = await agent
      .post('/api/v1/vaults/migration/flip')
      .set(...XRW)
      .send({ clientNonce: NONCE_A, vaultId });
    expect(flipped.status, JSON.stringify(flipped.body)).toBe(200);
    expect(vaultMigrationStateSchema.parse(flipped.body)).toMatchObject({
      migratedTo: vaultId,
      migratingBy: null,
      claimExpiresAt: null,
    });

    // Re-sending the same flip is acknowledged, not refused.
    const replay = await agent
      .post('/api/v1/vaults/migration/flip')
      .set(...XRW)
      .send({ clientNonce: NONCE_A, vaultId });
    expect(replay.status).toBe(200);
    expect(replay.body.migratedTo).toBe(vaultId);

    // The legacy vault still READS…
    const legacyRead = await agent.get('/api/v1/vault');
    expect([200, 409]).toContain(legacyRead.status);

    // …and is refused for WRITES: it is a tombstone now.
    const legacyWrite = await agent
      .put('/api/v1/vault')
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(legacyEnvelope(2));
    expect(legacyWrite.status, JSON.stringify(legacyWrite.body)).toBe(409);
    expect(legacyWrite.body.error.code).toBe(VAULT2_ERROR_CODES.migrationIncomplete);
    // The stored legacy ciphertext is untouched by the refused write.
    const [legacyRow] = await harness.db
      .select({ version: schema.paranoidVaults.version })
      .from(schema.paranoidVaults)
      .where(eq(schema.paranoidVaults.userId, user.id));
    expect(legacyRow!.version).toBe(1);

    // A new claim after the flip is refused too — the commit is terminal.
    const afterFlip = await agent
      .post('/api/v1/vaults/migration/claim')
      .set(...XRW)
      .send({ clientNonce: NONCE_B });
    expect(afterFlip.status).toBe(409);
    expect(afterFlip.body.error.code).toBe(VAULT2_ERROR_CODES.migrationClaimed);
  });

  it('keeps every migration step out of reach of a vault:sync bearer', async () => {
    const user = await seedUser('migbearer');
    await seedLegacyVault(user.id);
    const token = await mintToken(user, ['vault:sync']);

    for (const call of [
      request(harness.app).get('/api/v1/vaults/migration').set(bearer(token)),
      request(harness.app)
        .post('/api/v1/vaults/migration/claim')
        .set(bearer(token))
        .send({ clientNonce: NONCE_A }),
      request(harness.app)
        .post('/api/v1/vaults/migration/renew')
        .set(bearer(token))
        .send({ clientNonce: NONCE_A }),
      request(harness.app)
        .post('/api/v1/vaults/migration/flip')
        .set(bearer(token))
        .send({ clientNonce: NONCE_A, vaultId: MISSING_ID }),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
    }
  });
});

// ── r3: the If-Claim gate on vault document writes ─────────────────────────

describe('vaults v2 — migration-claim enforcement on doc writes (r3, mobile A2.2)', () => {
  async function seedLegacyVault(userId: string): Promise<void> {
    await harness.db.insert(schema.paranoidVaults).values({
      userId,
      version: 1,
      formatVersion: 1,
      sizeBytes: 8,
      blob: Buffer.alloc(8, 1),
    });
  }

  const NONCE_A = 'client-nonce-aaaaaaaaaaaaaaaa';
  const NONCE_B = 'client-nonce-bbbbbbbbbbbbbbbb';

  async function claim(agent: Agent, nonce: string): Promise<void> {
    const res = await agent
      .post('/api/v1/vaults/migration/claim')
      .set(...XRW)
      .send({ clientNonce: nonce });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  it('refuses every unclaimed doc write while a claim is live — "losers wait" is enforced, not honour-system', async () => {
    const user = await seedUser('ifclaim');
    await seedLegacyVault(user.id);
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p1')) });

    await claim(agent, NONCE_A);

    // No If-Claim at all → 428, on every doc surface.
    for (const path of [
      `/api/v1/vaults/${vaultId}/header`,
      `/api/v1/vaults/${vaultId}/common`,
      `/api/v1/vaults/${vaultId}/portfolios/${portfolioId}`,
    ]) {
      const naked = await agent
        .put(path)
        .set(...XRW)
        .set(...OCTET)
        .set('If-Match', '"1"')
        .send(blob('unclaimed'));
      expect(naked.status, `${path}: ${JSON.stringify(naked.body)}`).toBe(428);
      expect(naked.body.error.code).toBe(VAULT2_ERROR_CODES.preconditionRequired);
      // The refusal names the live claim, so the loser knows to wait.
      expect(naked.body.state.migratingBy).toBe(NONCE_A);
    }

    // A wrong nonce → 409: this caller believes it holds a claim it does not.
    const foreign = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set('If-Claim', NONCE_B)
      .send(blob('wrong-nonce'));
    expect(foreign.status).toBe(409);
    expect(foreign.body.error.code).toBe(VAULT2_ERROR_CODES.migrationClaimed);
    expect(foreign.body.state.migratingBy).toBe(NONCE_A);

    // The live claim holder writes normally.
    const held = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set('If-Claim', NONCE_A)
      .send(blob('h2'));
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body.version).toBe(2);

    // None of the refused writes advanced any CAS version.
    const header = await agent.get(`/api/v1/vaults/${vaultId}/header`);
    expect(header.headers.etag).toBe('"2"');
    const portfolioDoc = await agent.get(`/api/v1/vaults/${vaultId}/portfolios/${portfolioId}`);
    expect(portfolioDoc.headers.etag).toBe('"1"');
  });

  it('gates the vault:sync bearer surface identically', async () => {
    const user = await seedUser('ifclaimbearer');
    await seedLegacyVault(user.id);
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent);
    await claim(agent, NONCE_A);
    const token = await mintToken(user, ['vault:sync']);

    const naked = await request(harness.app)
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(blob('bearer-unclaimed'));
    expect(naked.status, JSON.stringify(naked.body)).toBe(428);
    expect(naked.body.error.code).toBe(VAULT2_ERROR_CODES.preconditionRequired);

    const held = await request(harness.app)
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(bearer(token))
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set('If-Claim', NONCE_A)
      .send(blob('bearer-held'));
    expect(held.status, JSON.stringify(held.body)).toBe(200);
  });

  it('refuses the returning stale claim holder after the flip — the A2.2 data-loss path', async () => {
    const user = await seedUser('staleclaim');
    await seedLegacyVault(user.id);
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent);

    await claim(agent, NONCE_A);
    const flipped = await agent
      .post('/api/v1/vaults/migration/flip')
      .set(...XRW)
      .send({ clientNonce: NONCE_A, vaultId });
    expect(flipped.status, JSON.stringify(flipped.body)).toBe(200);

    // The old claim holder comes back from a stall and tries to keep writing
    // "its" migration docs. Its nonce no longer names a live claim: refused,
    // and the committed vault's documents stay exactly as the flip left them.
    const stale = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set('If-Claim', NONCE_A)
      .send(blob('stale-overwrite'));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe(VAULT2_ERROR_CODES.migrationClaimed);
    expect(stale.body.state.migratedTo).toBe(vaultId);

    // Ordinary writes without the header work again — the window is closed.
    const normal = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .send(blob('post-flip'));
    expect(normal.status, JSON.stringify(normal.body)).toBe(200);
  });

  it('refuses an expired nonce and admits the takeover claim', async () => {
    const user = await seedUser('expiredclaim');
    await seedLegacyVault(user.id);
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent);

    await claim(agent, NONCE_A);
    // The holder stalls past its TTL.
    await harness.db
      .update(schema.paranoidVaults)
      .set({ migrationExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.paranoidVaults.userId, user.id));

    const lapsed = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set('If-Claim', NONCE_A)
      .send(blob('lapsed'));
    expect(lapsed.status).toBe(409);
    expect(lapsed.body.error.code).toBe(VAULT2_ERROR_CODES.migrationClaimed);

    // Another client takes over; its nonce is now the one that writes.
    await claim(agent, NONCE_B);
    const takeover = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set('If-Claim', NONCE_B)
      .send(blob('takeover'));
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(200);
  });

  it('refuses an asserted claim when no migration is running at all', async () => {
    const user = await seedUser('noclaim');
    const agent = await loginAgent(harness.app, user);
    const { vaultId } = await createVault(agent);

    // Fail closed: a client asserting a claim that cannot exist is confused
    // about the world and must re-read the migration state, not write.
    const res = await agent
      .put(`/api/v1/vaults/${vaultId}/header`)
      .set(...XRW)
      .set(...OCTET)
      .set('If-Match', '"1"')
      .set('If-Claim', NONCE_A)
      .send(blob('phantom-claim'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(VAULT2_ERROR_CODES.migrationClaimed);
    expect(res.body.state.legacyPresent).toBe(false);
  });
});

// ── r2 §15: the wire error-code catalog ─────────────────────────────────────

describe('vaults v2 — error-code catalog (r2 §15)', () => {
  it('ships EN and DE strings for all ten canonical codes', async () => {
    const en = (await import('../../../web/src/i18n/messages/en.json', { with: { type: 'json' } }))
      .default as { vault: { errors: Record<string, string> } };
    const de = (await import('../../../web/src/i18n/messages/de.json', { with: { type: 'json' } }))
      .default as { vault: { errors: Record<string, string> } };

    // Fifteen, not ten: the five codes beyond r2 §15's canonical set render from
    // the same catalog, because mobile never surfaces a raw code.
    expect(VAULT2_TRANSLATED_ERROR_CODES).toHaveLength(17);
    for (const code of VAULT2_TRANSLATED_ERROR_CODES) {
      expect(en.vault.errors[code], `missing EN string for ${code}`).toBeTruthy();
      expect(de.vault.errors[code], `missing DE string for ${code}`).toBeTruthy();
      expect(en.vault.errors[code]).not.toBe(de.vault.errors[code]);
    }
    expect(Object.keys(en.vault.errors).sort()).toEqual([...VAULT2_TRANSLATED_ERROR_CODES].sort());
    expect(Object.keys(de.vault.errors).sort()).toEqual([...VAULT2_TRANSLATED_ERROR_CODES].sort());
  });

  it('exposes every translated code through the contract table', () => {
    const values = new Set(Object.values(VAULT2_ERROR_CODES));
    for (const code of VAULT2_TRANSLATED_ERROR_CODES) expect(values.has(code)).toBe(true);
    // Every code the table defines is translated: no code can ship stringless.
    expect([...values].sort()).toEqual([...VAULT2_TRANSLATED_ERROR_CODES].sort());
    for (const code of VAULT2_CANONICAL_ERROR_CODES) expect(values.has(code)).toBe(true);
  });
});

// ── Legacy surface ──────────────────────────────────────────────────────────

describe('vaults v2 — the legacy account vault is untouched', () => {
  it('keeps the account-singleton /vault routes serving beside the new mount', async () => {
    const user = await seedUser('legacy');
    const agent = await loginAgent(harness.app, user);

    // No v2 vault has been created, and the legacy surface answers exactly as before.
    const legacy = await agent.get('/api/v1/vault');
    expect([404, 409]).toContain(legacy.status);

    const v2 = await agent.get('/api/v1/vaults');
    expect(v2.status).toBe(200);
    expect(vaultListResponseSchema.parse(v2.body).vaults).toEqual([]);

    // The two stores are separate tables: a v2 vault creates no legacy row.
    await createVault(agent);
    const legacyRows = await harness.db
      .select()
      .from(schema.paranoidVaults)
      .where(eq(schema.paranoidVaults.userId, user.id));
    expect(legacyRows).toHaveLength(0);
  });

  it('does not change privacy_mode when a portfolio joins a vault', async () => {
    const user = await seedUser('mode');
    const agent = await loginAgent(harness.app, user);
    const portfolioId = await defaultPortfolioId(agent);
    const { vaultId } = await createVault(agent);
    await agent
      .post(`/api/v1/portfolios/${portfolioId}/vault`)
      .set(...XRW)
      .send({ vaultId, blob: b64(blob('p')) });

    const [row] = await harness.db
      .select({ privacyMode: schema.users.privacyMode })
      .from(schema.users)
      .where(and(eq(schema.users.id, user.id)));
    expect(row!.privacyMode).toBe('normal');
  });
});
