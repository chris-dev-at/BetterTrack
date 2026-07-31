import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  HOME_LAYOUT_MAX_BYTES,
  HOME_LAYOUT_MAX_ID_CHARS,
  HOME_LAYOUT_MAX_SETTING_ARRAY_ITEMS,
  HOME_LAYOUT_MAX_SETTING_KEYS,
  HOME_LAYOUT_MAX_SETTING_KEY_CHARS,
  HOME_LAYOUT_MAX_SETTING_STRING_CHARS,
  HOME_LAYOUT_MAX_SIZE_CHARS,
  HOME_LAYOUT_MAX_TYPE_CHARS,
  HOME_LAYOUT_MAX_WIDGETS,
  homeLayoutResponseSchema,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * `GET/PUT /settings/home` — the Home widget board, stored per ACCOUNT (R2
 * home-widgets) so the layout follows the user to every browser they sign in
 * from rather than living in one device's `localStorage`.
 *
 * The load-bearing property under test is that the API is a **verbatim store**:
 * it validates the document's shape and size and nothing about its widget
 * vocabulary, because the client that writes the board is routinely a deploy
 * ahead of the server that stores it. The caps are the abuse boundary and are
 * each proven to reject rather than truncate.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

type Agent = ReturnType<typeof request.agent>;

async function getHome(agent: Agent) {
  const res = await agent.get('/api/v1/settings/home');
  expect(res.status).toBe(200);
  return homeLayoutResponseSchema.parse(res.body);
}

function putHome(agent: Agent, body: unknown) {
  return agent
    .put('/api/v1/settings/home')
    .set(...XRW)
    .send(body as object);
}

/** A minimal valid board — one widget this build happens to know about. */
function board(widgets: unknown[] = [{ id: 'w-1', type: 'net-worth', size: 'l', settings: {} }]) {
  return { version: 1, widgets };
}

describe('GET /api/v1/settings/home', () => {
  it('requires a session', async () => {
    const res = await request.agent(harness.app).get('/api/v1/settings/home');
    expect(res.status).toBe(401);
  });

  it('reports nulls for an account that never saved a board', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    expect(await getHome(agent)).toEqual({ layout: null, updatedAt: null });
  });
});

describe('PUT /api/v1/settings/home', () => {
  it('requires a session', async () => {
    const res = await request
      .agent(harness.app)
      .put('/api/v1/settings/home')
      .set(...XRW)
      .send({ layout: board() });
    expect(res.status).toBe(401);
  });

  it('stores the board and hands it back on a brand-new session', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const saved = board([
      { id: 'w-1', type: 'net-worth', size: 'l', settings: { scope: 'all' } },
      {
        id: 'w-2',
        type: 'allocation',
        size: 'm',
        settings: { scope: 'selected', scopeIds: ['p1'] },
      },
    ]);
    const put = await putHome(agent, { layout: saved });
    expect(put.status).toBe(200);
    expect(put.body.layout).toEqual(saved);
    expect(typeof put.body.updatedAt).toBe('string');

    // The whole point of the feature: a different sign-in gets the same board.
    const elsewhere = await loginAgent(harness.app, alice.email, alice.password);
    const fetched = await getHome(elsewhere);
    expect(fetched.layout).toEqual(saved);
    expect(fetched.updatedAt).toBe(put.body.updatedAt);
  });

  it('round-trips widget types and settings keys this build has never heard of', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    // Everything here is from a hypothetical newer web deploy. The server must
    // not recognise ANY of it and must still return it byte-for-byte, or a user
    // who arranges their board on an updated device loses widgets on an older one.
    const future = {
      version: 7,
      widgets: [
        {
          id: 'w-future',
          type: 'quantum-sentiment-radar',
          size: 'xxl',
          settings: {
            horizon: 'lunar-cycle',
            depth: 42,
            live: true,
            cleared: null,
            cohorts: ['a', 'b', 'c'],
          },
        },
      ],
    };

    const put = await putHome(agent, { layout: future });
    expect(put.status).toBe(200);
    expect(put.body.layout).toEqual(future);
    expect((await getHome(agent)).layout).toEqual(future);
  });

  it('bumps updatedAt on every write, including a clear', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const first = await putHome(agent, { layout: board() });
    expect(first.status).toBe(200);
    const firstAt = first.body.updatedAt as string;

    const second = await putHome(agent, {
      layout: board([{ id: 'w-2', type: 'news', size: 'm', settings: {} }]),
    });
    expect(second.status).toBe(200);
    expect(Date.parse(second.body.updatedAt as string)).toBeGreaterThanOrEqual(Date.parse(firstAt));
    expect(second.body.updatedAt).not.toBe(firstAt);

    // A clear keeps a revision: `layout: null` + a stamp is "the user emptied
    // this", which is what stops the next device pushing the old board back up.
    const cleared = await putHome(agent, { layout: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.layout).toBeNull();
    expect(cleared.body.updatedAt).not.toBe(second.body.updatedAt);
    expect(await getHome(agent)).toEqual({
      layout: null,
      updatedAt: cleared.body.updatedAt,
    });
  });

  it('accepts an empty board — "I removed every widget" is a real choice', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const put = await putHome(agent, { layout: { version: 1, widgets: [] } });
    expect(put.status).toBe(200);
    expect((await getHome(agent)).layout).toEqual({ version: 1, widgets: [] });
  });

  it('is strictly session-user scoped — one account never sees another’s board', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await putHome(bobAgent, {
      layout: board([{ id: 'bob-1', type: 'watchlist', size: 'm', settings: {} }]),
    });

    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    expect(await getHome(aliceAgent)).toEqual({ layout: null, updatedAt: null });

    await putHome(aliceAgent, {
      layout: board([{ id: 'alice-1', type: 'news', size: 's', settings: {} }]),
    });
    // Alice's write did not touch Bob's row.
    expect((await getHome(bobAgent)).layout?.widgets[0]?.id).toBe('bob-1');
  });
});

describe('PUT /api/v1/settings/home — the size caps', () => {
  let agent: Agent;

  beforeEach(async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    agent = await loginAgent(harness.app, alice.email, alice.password);
  });

  /** `count` widgets with distinct ids, each carrying `settings`. */
  function widgets(count: number, settings: Record<string, unknown> = {}) {
    return Array.from({ length: count }, (_, index) => ({
      id: `w-${index}`,
      type: 'net-worth',
      size: 'l',
      settings,
    }));
  }

  it('takes exactly the widget cap and rejects one past it', async () => {
    expect((await putHome(agent, { layout: board(widgets(HOME_LAYOUT_MAX_WIDGETS)) })).status).toBe(
      200,
    );
    expect(
      (await putHome(agent, { layout: board(widgets(HOME_LAYOUT_MAX_WIDGETS + 1)) })).status,
    ).toBe(400);
    // The rejection did not truncate: the stored board is still the accepted one.
    expect((await getHome(agent)).layout?.widgets).toHaveLength(HOME_LAYOUT_MAX_WIDGETS);
  });

  it('caps the id, type and size token lengths', async () => {
    const ok = (widget: Record<string, unknown>) => putHome(agent, { layout: board([widget]) });
    const base = { id: 'w', type: 't', size: 's', settings: {} };

    expect((await ok({ ...base, id: 'x'.repeat(HOME_LAYOUT_MAX_ID_CHARS) })).status).toBe(200);
    expect((await ok({ ...base, id: 'x'.repeat(HOME_LAYOUT_MAX_ID_CHARS + 1) })).status).toBe(400);
    expect((await ok({ ...base, type: 'x'.repeat(HOME_LAYOUT_MAX_TYPE_CHARS) })).status).toBe(200);
    expect((await ok({ ...base, type: 'x'.repeat(HOME_LAYOUT_MAX_TYPE_CHARS + 1) })).status).toBe(
      400,
    );
    expect((await ok({ ...base, size: 'x'.repeat(HOME_LAYOUT_MAX_SIZE_CHARS) })).status).toBe(200);
    expect((await ok({ ...base, size: 'x'.repeat(HOME_LAYOUT_MAX_SIZE_CHARS + 1) })).status).toBe(
      400,
    );
    // Empty tokens are not a board a client could have produced.
    expect((await ok({ ...base, id: '' })).status).toBe(400);
    expect((await ok({ ...base, type: '' })).status).toBe(400);
  });

  it('caps the settings key count, key length, string length and array length', async () => {
    const put = (settings: Record<string, unknown>) =>
      putHome(agent, { layout: board([{ id: 'w', type: 't', size: 's', settings }]) });
    const keys = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 'v']));

    expect((await put(keys(HOME_LAYOUT_MAX_SETTING_KEYS))).status).toBe(200);
    expect((await put(keys(HOME_LAYOUT_MAX_SETTING_KEYS + 1))).status).toBe(400);

    expect((await put({ ['k'.repeat(HOME_LAYOUT_MAX_SETTING_KEY_CHARS)]: 'v' })).status).toBe(200);
    expect((await put({ ['k'.repeat(HOME_LAYOUT_MAX_SETTING_KEY_CHARS + 1)]: 'v' })).status).toBe(
      400,
    );

    expect((await put({ k: 'v'.repeat(HOME_LAYOUT_MAX_SETTING_STRING_CHARS) })).status).toBe(200);
    expect((await put({ k: 'v'.repeat(HOME_LAYOUT_MAX_SETTING_STRING_CHARS + 1) })).status).toBe(
      400,
    );

    const items = (count: number) => Array.from({ length: count }, (_, i) => `p${i}`);
    expect((await put({ k: items(HOME_LAYOUT_MAX_SETTING_ARRAY_ITEMS) })).status).toBe(200);
    expect((await put({ k: items(HOME_LAYOUT_MAX_SETTING_ARRAY_ITEMS + 1) })).status).toBe(400);
  });

  it('rejects a document past the serialised byte cap even when every field fits', async () => {
    const settings = (keys: number, chars: number) =>
      Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, 'v'.repeat(chars)]));

    // Every field is inside its own cap; only the total is not. This is why the
    // whole-document cap exists at all — the per-field caps multiply out to
    // hundreds of KB. Kept under the 100 KB express body limit so the 400 comes
    // from the contract rather than from the body parser.
    const over = board(widgets(HOME_LAYOUT_MAX_WIDGETS, settings(10, 100)));
    const overBytes = new TextEncoder().encode(JSON.stringify(over)).length;
    expect(overBytes).toBeGreaterThan(HOME_LAYOUT_MAX_BYTES);
    expect(overBytes).toBeLessThan(100 * 1024);
    expect((await putHome(agent, { layout: over })).status).toBe(400);

    // And a board just under the cap is accepted, so the boundary is real.
    const under = board(widgets(HOME_LAYOUT_MAX_WIDGETS, settings(4, 40)));
    expect(new TextEncoder().encode(JSON.stringify(under)).length).toBeLessThan(
      HOME_LAYOUT_MAX_BYTES,
    );
    expect((await putHome(agent, { layout: under })).status).toBe(200);
  });

  it('rejects a malformed document rather than storing part of it', async () => {
    const bad: unknown[] = [
      {},
      { layout: {} },
      { layout: { version: 1 } },
      { layout: { version: 'one', widgets: [] } },
      { layout: { version: -1, widgets: [] } },
      { layout: { version: 1, widgets: {} } },
      // A widget missing its frame, or carrying a field outside it: new
      // per-widget attributes belong in `settings`, which is open.
      { layout: { version: 1, widgets: [{ id: 'a', type: 't', size: 's' }] } },
      { layout: { version: 1, widgets: [{ id: 'a', type: 't', size: 's', settings: [] }] } },
      { layout: { version: 1, widgets: [{ id: 'a', type: 't', size: 's', settings: {}, x: 1 }] } },
      // A nested-object setting needs the contract widened first — it must fail
      // loudly here rather than land in the column unbounded.
      { layout: { version: 1, widgets: [{ id: 'a', type: 't', size: 's', settings: { k: {} } }] } },
      { layout: { version: 1, widgets: [] }, extra: true },
      { layout: [] },
    ];
    for (const body of bad) {
      expect((await putHome(agent, body)).status, JSON.stringify(body)).toBe(400);
    }
    // Nothing landed.
    expect(await getHome(agent)).toEqual({ layout: null, updatedAt: null });
  });
});
