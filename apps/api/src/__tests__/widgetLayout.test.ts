import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  oauthAuthorizationDetailsResponseSchema,
  oauthTokenResponseSchema,
  widgetLayoutResponseSchema,
  WIDGET_LAYOUT_MAX_BYTES,
  WIDGET_LAYOUT_NAMESPACES,
  WIDGET_LAYOUT_NOT_FOUND_CODE,
  WIDGET_LAYOUT_TOO_LARGE_CODE,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import { users, widgetLayouts } from '../data/schema';
import { pathAcceptsBearer } from '../http/middleware/bearerAuth';
import { PARANOID_MODE_ERROR_CODE } from '../services/account/paranoidEnforcement';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

/**
 * `GET/PUT /settings/widget-layout/{namespace}` — per-account widget
 * compositions, synced across devices, with mobile and web kept as TWO SEPARATE
 * saved compositions (mobile board #68 item 3).
 *
 * The load-bearing properties under test:
 *
 *  - the store is **verbatim and opaque** — only "is a JSON object" and the
 *    32 KB cap are enforced, so a client running ahead of this build reads back
 *    exactly what it wrote, nested structures and unknown keys included;
 *  - the namespaces are **genuinely independent**, because one shared row would
 *    make each client's save clobber the other's;
 *  - the endpoints ride the EXISTING `/settings` module scope policy, so the
 *    first-party mobile client reaches them with the scopes it already holds —
 *    zero activation friction, no new grant. The resolved scope is pinned below
 *    so a later re-map of `/settings` cannot silently change who can call this.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MOBILE_CLIENT_ID = 'btc_IbT1mzw_7kBiPHPkGfaE0Q';

/**
 * The scopes these endpoints resolve to. They are NOT widget-specific: the
 * `/settings` module policy row in `bearerAuth.ts` maps the whole module to the
 * social pair (the same row `/settings/account` rides), and this surface
 * deliberately inherits it rather than inventing a scope the mobile client would
 * have to be re-granted.
 */
const READ_SCOPE: ApiKeyScope = 'social:read';
const WRITE_SCOPE: ApiKeyScope = 'social:write';

let harness: TestHarness;
let sequence = 0;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function path(namespace: string): string {
  return `/api/v1/settings/widget-layout/${namespace}`;
}

async function seedUser(prefix: string): Promise<SeededUser> {
  sequence += 1;
  return harness.seedUser({
    email: `${prefix}-${sequence}@bettertrack.test`,
    username: `${prefix}${sequence}`,
  });
}

async function loginAgent(app: Application, user: Pick<SeededUser, 'email' | 'password'>) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return agent;
}

function putLayout(agent: Agent, namespace: string, body: unknown) {
  return agent
    .put(path(namespace))
    .set(...XRW)
    .send(body as object);
}

async function mintPersonalToken(
  scopes: ApiKeyScope[],
  prefix = 'widgetkey',
): Promise<{ user: SeededUser; token: string }> {
  const user = await seedUser(prefix);
  const key = await harness.ctx.apiKeys.create({ userId: user.id, name: `${prefix} key`, scopes });
  return { user, token: key.token };
}

/**
 * A real delegated OAuth access token for the shipped BetterTrackMobile client,
 * minted through the genuine PKCE authorization-code flow — the same path the
 * app takes. Deliberately requests ONLY the scopes the client already declares,
 * so the test proves the endpoints are reachable with no new grant.
 */
async function mintMobileToken(
  scopes: readonly ApiKeyScope[],
): Promise<{ user: SeededUser; token: string }> {
  const mobile = FIRST_PARTY_CLIENTS.find((client) => client.clientId === MOBILE_CLIENT_ID)!;
  for (const scope of scopes) expect(mobile.scopeCeiling).toContain(scope);
  await seedFirstPartyClients(createOAuthRepository(harness.db));

  const user = await seedUser('mobilewidget');
  const agent = await loginAgent(harness.app, user);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = {
    client_id: mobile.clientId,
    redirect_uri: mobile.redirectUris[0],
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };

  const details = await agent.get('/api/v1/oauth/authorization-details').query(authorize);
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  expect(oauthAuthorizationDetailsResponseSchema.parse(details.body).client.firstParty).toBe(true);

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

/** A document whose serialised size lands just past `bytes`. */
function docOfAtLeast(bytes: number): Record<string, unknown> {
  return { version: 1, blob: 'x'.repeat(bytes) };
}

describe('widget layout — session roundtrip', () => {
  it('returns 404 WIDGET_LAYOUT_NOT_FOUND before anything was ever saved', async () => {
    const agent = await loginAgent(harness.app, await seedUser('widget'));
    for (const namespace of WIDGET_LAYOUT_NAMESPACES) {
      const res = await agent.get(path(namespace));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(WIDGET_LAYOUT_NOT_FOUND_CODE);
    }
  });

  it.each(WIDGET_LAYOUT_NAMESPACES)(
    'round-trips the %s composition verbatim',
    async (namespace) => {
      const agent = await loginAgent(harness.app, await seedUser('widget'));
      // Deliberately exotic: nesting, an array, a null, an unknown widget type and
      // a key this build has never heard of. An opaque store must return all of it.
      const doc = {
        schemaVersion: 7,
        widgets: [
          { id: 'a', type: 'not-a-type-this-build-knows', span: { cols: 2, rows: 1 } },
          { id: 'b', type: 'net-worth', hidden: null, tags: ['x', 'y'] },
        ],
        futureField: { deeply: { nested: true } },
      };

      const written = await putLayout(agent, namespace, { doc });
      expect(written.status, JSON.stringify(written.body)).toBe(200);
      expect(widgetLayoutResponseSchema.parse(written.body).doc).toEqual(doc);

      const read = await agent.get(path(namespace));
      expect(read.status).toBe(200);
      const parsed = widgetLayoutResponseSchema.parse(read.body);
      expect(parsed.doc).toEqual(doc);
      expect(parsed.updatedAt).toBe(widgetLayoutResponseSchema.parse(written.body).updatedAt);
    },
  );

  it('last write wins and keeps exactly one row per (user, namespace)', async () => {
    const user = await seedUser('widget');
    const agent = await loginAgent(harness.app, user);

    const first = await putLayout(agent, 'web', { doc: { v: 1 } });
    expect(first.status).toBe(200);
    const second = await putLayout(agent, 'web', { doc: { v: 2 } });
    expect(second.status).toBe(200);

    const read = await agent.get(path('web'));
    expect(read.body.doc).toEqual({ v: 2 });

    // The upsert converges on one row — the (user, namespace) primary key is the
    // idempotency key, so a replayed PUT cannot accumulate versions.
    const rows = await harness.db
      .select()
      .from(widgetLayouts)
      .where(eq(widgetLayouts.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(
      new Date(second.body.updatedAt).getTime(),
      'the stamp advances (or holds) across writes',
    ).toBeGreaterThanOrEqual(new Date(first.body.updatedAt).getTime());
  });

  it('keeps mobile and web as two independent compositions', async () => {
    const user = await seedUser('widget');
    const agent = await loginAgent(harness.app, user);

    expect((await putLayout(agent, 'mobile', { doc: { board: 'phone' } })).status).toBe(200);
    // Saving web must not disturb mobile — the regression a single shared row
    // would cause, where each client's save clobbers the other's board.
    expect((await putLayout(agent, 'web', { doc: { board: 'desktop' } })).status).toBe(200);

    expect((await agent.get(path('mobile'))).body.doc).toEqual({ board: 'phone' });
    expect((await agent.get(path('web'))).body.doc).toEqual({ board: 'desktop' });

    const rows = await harness.db
      .select()
      .from(widgetLayouts)
      .where(eq(widgetLayouts.userId, user.id));
    expect(rows.map((r) => r.namespace).sort()).toEqual(['mobile', 'web']);
  });

  it('clearing one namespace leaves the other untouched', async () => {
    const agent = await loginAgent(harness.app, await seedUser('widget'));
    await putLayout(agent, 'mobile', { doc: { board: 'phone' } });
    await putLayout(agent, 'web', { doc: { board: 'desktop' } });

    expect((await putLayout(agent, 'web', { doc: {} })).status).toBe(200);
    expect((await agent.get(path('web'))).body.doc).toEqual({});
    expect((await agent.get(path('mobile'))).body.doc).toEqual({ board: 'phone' });
  });
});

describe('widget layout — validation', () => {
  it('rejects a namespace outside the enum with a 400, without creating a row', async () => {
    const user = await seedUser('widget');
    const agent = await loginAgent(harness.app, user);

    for (const namespace of ['ios', 'Mobile', 'desktop', 'mobile2']) {
      const read = await agent.get(path(namespace));
      expect(read.status, `GET ${namespace}`).toBe(400);
      expect(read.body.error.code).toBe('VALIDATION_ERROR');

      const write = await putLayout(agent, namespace, { doc: { v: 1 } });
      expect(write.status, `PUT ${namespace}`).toBe(400);
      expect(write.body.error.code).toBe('VALIDATION_ERROR');
    }

    const rows = await harness.db
      .select()
      .from(widgetLayouts)
      .where(eq(widgetLayouts.userId, user.id));
    expect(rows).toEqual([]);
  });

  it('rejects a document that is not a JSON object', async () => {
    const agent = await loginAgent(harness.app, await seedUser('widget'));
    for (const doc of [[], 'a string', 42, null, true]) {
      const res = await putLayout(agent, 'web', { doc });
      expect(res.status, `doc=${JSON.stringify(doc)}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    // A missing `doc` and an unknown sibling field are equally rejected.
    expect((await putLayout(agent, 'web', {})).status).toBe(400);
    expect((await putLayout(agent, 'web', { doc: {}, extra: 1 })).status).toBe(400);
  });

  it('rejects an oversize document with 413 WIDGET_LAYOUT_TOO_LARGE and stores nothing', async () => {
    const user = await seedUser('widget');
    const agent = await loginAgent(harness.app, user);

    const res = await putLayout(agent, 'mobile', { doc: docOfAtLeast(WIDGET_LAYOUT_MAX_BYTES) });
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body.error.code).toBe(WIDGET_LAYOUT_TOO_LARGE_CODE);

    expect((await agent.get(path('mobile'))).status).toBe(404);
    const rows = await harness.db
      .select()
      .from(widgetLayouts)
      .where(eq(widgetLayouts.userId, user.id));
    expect(rows).toEqual([]);
  });

  it('accepts a document just under the cap', async () => {
    const agent = await loginAgent(harness.app, await seedUser('widget'));
    // Leave room for the surrounding JSON punctuation the cap is measured on.
    const doc = docOfAtLeast(WIDGET_LAYOUT_MAX_BYTES - 256);
    const res = await putLayout(agent, 'mobile', { doc });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await agent.get(path('mobile'))).body.doc).toEqual(doc);
  });

  it('requires authentication', async () => {
    expect((await request(harness.app).get(path('web'))).status).toBe(401);
    const write = await request(harness.app)
      .put(path('web'))
      .set(...XRW)
      .send({ doc: { v: 1 } });
    expect(write.status).toBe(401);
  });
});

describe('widget layout — ownership scoping (§10)', () => {
  it('never returns another account’s composition, in either namespace', async () => {
    const owner = await seedUser('owner');
    const other = await seedUser('other');
    const ownerAgent = await loginAgent(harness.app, owner);
    const otherAgent = await loginAgent(harness.app, other);

    await putLayout(ownerAgent, 'mobile', { doc: { secret: 'owner-mobile' } });
    await putLayout(ownerAgent, 'web', { doc: { secret: 'owner-web' } });

    // The other account sees "never saved", not the owner's board: the lookup is
    // keyed on (user_id, namespace), so a namespace someone else populated is
    // simply absent here.
    for (const namespace of WIDGET_LAYOUT_NAMESPACES) {
      const res = await otherAgent.get(path(namespace));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(WIDGET_LAYOUT_NOT_FOUND_CODE);
    }

    // And a write by the other account creates its OWN row rather than
    // overwriting the owner's same-named namespace.
    await putLayout(otherAgent, 'mobile', { doc: { secret: 'other-mobile' } });
    expect((await ownerAgent.get(path('mobile'))).body.doc).toEqual({ secret: 'owner-mobile' });
    expect((await otherAgent.get(path('mobile'))).body.doc).toEqual({ secret: 'other-mobile' });
  });

  it('cascades the rows away with the account', async () => {
    const user = await seedUser('widget');
    const agent = await loginAgent(harness.app, user);
    await putLayout(agent, 'mobile', { doc: { v: 1 } });
    await putLayout(agent, 'web', { doc: { v: 1 } });

    await harness.db.delete(users).where(eq(users.id, user.id));
    const rows = await harness.db
      .select()
      .from(widgetLayouts)
      .where(eq(widgetLayouts.userId, user.id));
    expect(rows).toEqual([]);
  });
});

describe('widget layout — bearer access', () => {
  it('resolves to the existing /settings module scope policy', () => {
    // Pinned deliberately: this surface adds NO scope of its own. If a later
    // change re-maps `/settings`, this test is the tripwire.
    expect(pathAcceptsBearer('/settings/widget-layout/mobile', 'GET')).toBe(true);
    expect(pathAcceptsBearer('/settings/widget-layout/mobile', 'PUT')).toBe(true);
    expect(pathAcceptsBearer('/settings/widget-layout/web', 'GET')).toBe(true);
    expect(pathAcceptsBearer('/settings/widget-layout/web', 'PUT')).toBe(true);
  });

  it('the shipped mobile OAuth client reaches both verbs with the scopes it already holds', async () => {
    // No new scope grant: the client's declared ceiling already carries the
    // social pair, so the app activates this feature with zero re-consent.
    const { token } = await mintMobileToken([READ_SCOPE, WRITE_SCOPE]);

    const empty = await request(harness.app).get(path('mobile')).set(bearer(token));
    expect(empty.status).toBe(404);
    expect(empty.body.error.code).toBe(WIDGET_LAYOUT_NOT_FOUND_CODE);

    const written = await request(harness.app)
      .put(path('mobile'))
      .set(bearer(token))
      .send({ doc: { board: 'phone', widgets: [] } });
    expect(written.status, JSON.stringify(written.body)).toBe(200);

    const read = await request(harness.app).get(path('mobile')).set(bearer(token));
    expect(read.status).toBe(200);
    expect(widgetLayoutResponseSchema.parse(read.body).doc).toEqual({
      board: 'phone',
      widgets: [],
    });

    // Same token, other namespace — still independent under bearer auth.
    expect((await request(harness.app).get(path('web')).set(bearer(token))).status).toBe(404);
  });

  it('a token missing the write scope may read but not write', async () => {
    const { token } = await mintPersonalToken([READ_SCOPE], 'widgetread');

    // Reads are satisfied by the read scope alone.
    expect((await request(harness.app).get(path('web')).set(bearer(token))).status).toBe(404);

    const write = await request(harness.app)
      .put(path('web'))
      .set(bearer(token))
      .send({ doc: { v: 1 } });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(write.body.error.message).toContain(WRITE_SCOPE);
  });

  it('a token holding neither scope is refused on both verbs', async () => {
    const { token } = await mintPersonalToken(['portfolio:read'], 'widgetnoscope');

    const read = await request(harness.app).get(path('mobile')).set(bearer(token));
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(read.body.error.message).toContain(READ_SCOPE);

    const write = await request(harness.app)
      .put(path('mobile'))
      .set(bearer(token))
      .send({ doc: { v: 1 } });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('write-implies-read: a write-scoped token can also read', async () => {
    const { token } = await mintPersonalToken([WRITE_SCOPE], 'widgetwrite');
    const written = await request(harness.app)
      .put(path('web'))
      .set(bearer(token))
      .send({ doc: { v: 9 } });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect((await request(harness.app).get(path('web')).set(bearer(token))).body.doc).toEqual({
      v: 9,
    });
  });

  it('scopes a bearer read to its own token owner', async () => {
    const owner = await mintPersonalToken([READ_SCOPE, WRITE_SCOPE], 'widgetowner');
    const other = await mintPersonalToken([READ_SCOPE, WRITE_SCOPE], 'widgetother');

    await request(harness.app)
      .put(path('mobile'))
      .set(bearer(owner.token))
      .send({ doc: { secret: 'owner' } });

    expect((await request(harness.app).get(path('mobile')).set(bearer(other.token))).status).toBe(
      404,
    );
    expect(
      (await request(harness.app).get(path('mobile')).set(bearer(owner.token))).body.doc,
    ).toEqual({ secret: 'owner' });
  });
});

describe('widget layout — paranoid mode', () => {
  it('is killed for a paranoid account, like the Home board it mirrors', async () => {
    const user = await seedUser('widgetparanoid');
    const agent = await loginAgent(harness.app, user);
    await putLayout(agent, 'mobile', { doc: { v: 1 } });

    await harness.db
      .update(users)
      .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'], profilePublic: false })
      .where(eq(users.id, user.id));

    // A composition names the portfolios and assets it renders, and the server
    // cannot inspect this document to prove otherwise — so the whole surface
    // goes where `/settings/home` already goes for a paranoid account.
    const read = await agent.get(path('mobile'));
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe(PARANOID_MODE_ERROR_CODE);

    const write = await putLayout(agent, 'mobile', { doc: { v: 2 } });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe(PARANOID_MODE_ERROR_CODE);
  });
});
