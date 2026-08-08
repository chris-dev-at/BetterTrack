import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createApiKeyResponseSchema,
  PORTFOLIO_KINDS,
  portfolioListResponseSchema,
  portfolioMutationResponseSchema,
  updatePortfolioResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Portfolio kind (board #69) — the "Icon" the web client used to keep in
 * `localStorage` now lives on the portfolio row, so it follows the account to
 * every device. What this pins:
 *
 *  • the enum is EXACTLY the five tokens both shipped clients already ported
 *    (renaming or reordering repaints icons on a client we cannot redeploy);
 *  • create/read/update round-trip over a session AND over a bearer token,
 *    through the existing `portfolio:read` / `portfolio:write` scopes — no new
 *    scope, so the mobile client reaches it with the grant it already holds;
 *  • ownership scoping at the repository (§8): a foreign id is a 404, never a
 *    403 and never a write;
 *  • the bare-text column narrows anything outside the contract's token set
 *    back to `null` on read, instead of escaping as an unparseable DTO.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

const uniq = () => randomBytes(5).toString('hex');

async function seedFreshUser() {
  const tag = uniq();
  return harness.seedUser({ email: `u-${tag}@bettertrack.test`, username: `user${tag}` });
}

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** A logged-in session for a brand-new user. */
async function session(): Promise<{ agent: Agent; userId: string }> {
  const user = await seedFreshUser();
  return { agent: await loginAgent(harness.app, user.email, user.password), userId: user.id };
}

/** Seed a fresh user and mint a personal key with the given scopes. */
async function mintKey(scopes: string[]): Promise<{ token: string; userId: string }> {
  const user = await seedFreshUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const res = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'mobile', scopes });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { token: createApiKeyResponseSchema.parse(res.body).token, userId: user.id };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The caller's default ("Main") portfolio id via the scoped list endpoint. */
async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const list = portfolioListResponseSchema.parse(res.body);
  const def = list.portfolios.find((p) => p.isDefault);
  expect(def).toBeTruthy();
  return def!.id;
}

describe('portfolio kind — the enum is the wire contract', () => {
  it('is exactly the five tokens both clients ported, in their shipped order', () => {
    // The web stopgap defined them; the mobile app ported these hues off it.
    // A rename/reorder here silently repaints or blanks icons on a shipped
    // client, so the list is pinned literally rather than derived.
    expect(PORTFOLIO_KINDS).toEqual(['private', 'family', 'business', 'savings', 'property']);
  });
});

describe('portfolio kind — session round-trip', () => {
  it('creates with a kind, reads it back on the create response and the list', async () => {
    const { agent } = await session();

    const created = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Family book', kind: 'family' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const portfolio = portfolioMutationResponseSchema.parse(created.body).portfolio;
    expect(portfolio.kind).toBe('family');

    const list = await agent.get('/api/v1/portfolios');
    const parsed = portfolioListResponseSchema.parse(list.body);
    expect(parsed.portfolios.find((p) => p.id === portfolio.id)?.kind).toBe('family');
  });

  it('creates unclassified when the body omits it — never a claimed default', async () => {
    const { agent } = await session();

    const created = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Unstated' });
    expect(created.status).toBe(201);
    // NULL, not 'private': "the user never chose" has to stay distinguishable
    // from "the user chose private", or a client with locally stored kinds
    // could never tell whether its fallback still applies.
    expect(portfolioMutationResponseSchema.parse(created.body).portfolio.kind).toBeNull();

    // …and the auto-created "Main" is unclassified for the same reason.
    const list = portfolioListResponseSchema.parse((await agent.get('/api/v1/portfolios')).body);
    expect(list.portfolios.find((p) => p.isDefault)?.kind).toBeNull();
  });

  it('PATCHes a kind onto an existing portfolio and back to another', async () => {
    const { agent } = await session();
    const id = await defaultPortfolioId(agent);

    const first = await agent
      .patch(`/api/v1/portfolios/${id}`)
      .set(...XRW)
      .send({ kind: 'business' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(updatePortfolioResponseSchema.parse(first.body).portfolio.kind).toBe('business');

    const second = await agent
      .patch(`/api/v1/portfolios/${id}`)
      .set(...XRW)
      .send({ kind: 'property' });
    expect(second.status).toBe(200);
    expect(updatePortfolioResponseSchema.parse(second.body).portfolio.kind).toBe('property');

    const list = portfolioListResponseSchema.parse((await agent.get('/api/v1/portfolios')).body);
    expect(list.portfolios.find((p) => p.id === id)?.kind).toBe('property');
  });

  it('a kind-only PATCH leaves every other field alone', async () => {
    const { agent } = await session();
    const id = await defaultPortfolioId(agent);
    await agent
      .patch(`/api/v1/portfolios/${id}`)
      .set(...XRW)
      .send({ name: 'Renamed', defaultPayFromCash: true });

    const res = await agent
      .patch(`/api/v1/portfolios/${id}`)
      .set(...XRW)
      .send({ kind: 'savings' });
    const portfolio = updatePortfolioResponseSchema.parse(res.body).portfolio;
    expect(portfolio).toMatchObject({
      name: 'Renamed',
      defaultPayFromCash: true,
      visibility: 'private',
      kind: 'savings',
    });
  });

  it('every contract token is accepted', async () => {
    const { agent } = await session();
    const id = await defaultPortfolioId(agent);
    for (const kind of PORTFOLIO_KINDS) {
      const res = await agent
        .patch(`/api/v1/portfolios/${id}`)
        .set(...XRW)
        .send({ kind });
      expect(res.status, `${kind}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(updatePortfolioResponseSchema.parse(res.body).portfolio.kind).toBe(kind);
    }
  });

  it('rejects a token outside the enum instead of storing it', async () => {
    const { agent } = await session();
    const id = await defaultPortfolioId(agent);

    for (const body of [{ kind: 'yacht' }, { kind: 'PRIVATE' }, { kind: null }, { kind: 7 }]) {
      const res = await agent
        .patch(`/api/v1/portfolios/${id}`)
        .set(...XRW)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const create = await agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Bad', kind: 'yacht' });
    expect(create.status).toBe(400);
  });

  it('narrows a column value outside the enum back to null on read', async () => {
    // The column is bare text (like `users.profile_icon`) so a sixth kind stays
    // a code-only change. That means a hand-run fix, a restored dump or a
    // retired token can put anything in it — the read path must degrade to
    // "unclassified" rather than 500 the whole portfolio list on the way out.
    const { agent, userId } = await session();
    const id = await defaultPortfolioId(agent);
    await harness.db
      .update(schema.portfolios)
      .set({ kind: 'yacht' })
      .where(eq(schema.portfolios.id, id));

    const res = await agent.get('/api/v1/portfolios');
    expect(res.status).toBe(200);
    const list = portfolioListResponseSchema.parse(res.body);
    expect(list.portfolios.find((p) => p.id === id)?.kind).toBeNull();
    expect(userId).toBeTruthy();
  });
});

describe('portfolio kind — ownership scoping (§8)', () => {
  it('a foreign portfolio 404s on a kind PATCH and is not written', async () => {
    const victim = await session();
    const victimId = await defaultPortfolioId(victim.agent);
    await victim.agent
      .patch(`/api/v1/portfolios/${victimId}`)
      .set(...XRW)
      .send({ kind: 'family' });

    const attacker = await session();
    const res = await attacker.agent
      .patch(`/api/v1/portfolios/${victimId}`)
      .set(...XRW)
      .send({ kind: 'business' });
    // 404, not 403: the repository scopes on (id, user_id), so a foreign id is
    // indistinguishable from an unknown one and leaks no existence.
    expect(res.status).toBe(404);

    const [row] = await harness.db
      .select({ kind: schema.portfolios.kind })
      .from(schema.portfolios)
      .where(eq(schema.portfolios.id, victimId));
    expect(row?.kind).toBe('family');
  });

  it("another user's kind never appears in the caller's list", async () => {
    const other = await session();
    const otherId = await defaultPortfolioId(other.agent);
    await other.agent
      .patch(`/api/v1/portfolios/${otherId}`)
      .set(...XRW)
      .send({ kind: 'property' });

    const mine = await session();
    const list = portfolioListResponseSchema.parse(
      (await mine.agent.get('/api/v1/portfolios')).body,
    );
    expect(list.portfolios.map((p) => p.id)).not.toContain(otherId);
  });
});

describe('portfolio kind — bearer reachability (no new scope)', () => {
  it('reads the kind over a bearer token holding only portfolio:read', async () => {
    const { token } = await mintKey(['portfolio:read', 'portfolio:write']);
    const created = await request(harness.app)
      .post('/api/v1/portfolios')
      .set(bearer(token))
      .send({ name: 'From mobile', kind: 'savings' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const readOnly = await mintKey(['portfolio:read']);
    const list = await request(harness.app).get('/api/v1/portfolios').set(bearer(readOnly.token));
    expect(list.status).toBe(200);
    // The field parses under the shared contract on the read scope alone.
    expect(portfolioListResponseSchema.parse(list.body).portfolios.length).toBeGreaterThan(0);
  });

  it('creates and PATCHes the kind over portfolio:write, with no kind-specific scope', async () => {
    const { token } = await mintKey(['portfolio:write']);

    const created = await request(harness.app)
      .post('/api/v1/portfolios')
      .set(bearer(token))
      .send({ name: 'Bearer book', kind: 'business' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const portfolio = portfolioMutationResponseSchema.parse(created.body).portfolio;
    expect(portfolio.kind).toBe('business');

    const patched = await request(harness.app)
      .patch(`/api/v1/portfolios/${portfolio.id}`)
      .set(bearer(token))
      .send({ kind: 'family' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(updatePortfolioResponseSchema.parse(patched.body).portfolio.kind).toBe('family');

    // Write implies read (#371), so the same token sees it in the list.
    const list = await request(harness.app).get('/api/v1/portfolios').set(bearer(token));
    expect(list.status).toBe(200);
    expect(
      portfolioListResponseSchema.parse(list.body).portfolios.find((p) => p.id === portfolio.id)
        ?.kind,
    ).toBe('family');
  });

  it('a read-only bearer token cannot write a kind (implication is one-way)', async () => {
    const { token, userId } = await mintKey(['portfolio:read']);
    const list = await request(harness.app).get('/api/v1/portfolios').set(bearer(token));
    const id = portfolioListResponseSchema.parse(list.body).portfolios[0]!.id;

    const res = await request(harness.app)
      .patch(`/api/v1/portfolios/${id}`)
      .set(bearer(token))
      .send({ kind: 'family' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const [row] = await harness.db
      .select({ kind: schema.portfolios.kind })
      .from(schema.portfolios)
      .where(eq(schema.portfolios.userId, userId));
    expect(row?.kind).toBeNull();
  });
});
