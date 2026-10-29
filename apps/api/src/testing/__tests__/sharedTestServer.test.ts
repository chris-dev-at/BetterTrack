import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestHarness } from '../createTestApp';

/**
 * #2020 — `Promise.all` of several requests on ONE supertest agent
 * mass-ECONNRESETs, because the agent's requests share a single server and the
 * first-constructed one closes it the moment its own response lands.
 *
 * `sharedTestServer.ts` carries the mechanism. ECONNRESET counts, from running
 * the fan-out test below against each path in turn while the fix was built
 * (50 rounds per width, a fresh agent per round):
 *
 * | fan-out on one agent | 2     | 3     | 4      | 6       | 8       |
 * |----------------------|-------|-------|--------|---------|---------|
 * | `request.agent(app)` | 0/100 | 0/150 | 50/200 | 138/300 | 230/400 |
 * | `harness.agent()`    | 0/100 | 0/150 |  0/200 |   0/300 |   0/400 |
 *
 * The first two tests below are the deterministic form of that: two requests
 * constructed together — exactly what `Promise.all([a, b])` does — where the
 * second is left with no server to connect to. No timing, no sleeps, no
 * retries; the raw path fails it every time and the harness path passes it
 * every time.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createTestApp();
});

afterAll(async () => {
  await harness.dispose();
});

/** The one server a supertest agent shares across every request it makes. */
function sharedServerOf(agent: ReturnType<typeof request.agent>): http.Server {
  return (agent as unknown as { app: http.Server }).app;
}

describe('#2020 reproducer — one agent, one server, closed by the first finisher', () => {
  it('leaves a sibling request of request.agent(app) with nothing to connect to', async () => {
    const agent = request.agent(harness.app);
    const shared = sharedServerOf(agent);
    expect(shared.listening).toBe(false);

    // Both `Test`s are constructed here, before either runs — the shape
    // `Promise.all([agent.get(a), agent.get(b)])` produces. The first binds the
    // shared server and keeps `_server`; the second finds the port already
    // bound, keeps nothing, and bakes that port into its URL.
    const first = agent.get('/api/v1/health?fanout=1');
    const sibling = agent.get('/api/v1/health?fanout=2');
    expect(shared.listening).toBe(true);
    const boundPort = (shared.address() as AddressInfo).port;
    expect(sibling.url).toBe(`http://127.0.0.1:${boundPort}/api/v1/health?fanout=2`);

    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);

    // One request, and the transport the agent shares is already gone.
    expect(shared.listening).toBe(false);
    await expect(sibling).rejects.toThrow(/ECONN(REFUSED|RESET)/);
    // The port did not move — the sibling is still aimed at it. The server that
    // owned it went away.
    expect(shared.address()).toBeNull();
  });

  it('serves the same two requests from harness.agent(), whose server outlives them', async () => {
    const agent = harness.agent();
    const server = harness.server();
    // Already listening when the agent is handed out, so supertest's
    // `serverAddress` takes its early exit and `end()` has nothing to close.
    expect(server.listening).toBe(true);
    expect(sharedServerOf(agent)).toBe(server);

    const first = agent.get('/api/v1/health?fanout=1');
    const sibling = agent.get('/api/v1/health?fanout=2');

    const [a, b] = await Promise.all([first, sibling]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toMatchObject({ status: 'ok' });
    expect(b.body).toMatchObject({ status: 'ok' });
    expect(server.listening).toBe(true);
  });
});

describe('harness.agent() fan-out', () => {
  // 700 requests; generous so a loaded machine cannot turn the bound itself
  // into the flake this test exists to remove.
  it(
    'takes 0 ECONNRESETs at fan-out 6 and 8, over 50 rounds each',
    { timeout: 60_000 },
    async () => {
      const server = harness.server();
      const port = (server.address() as AddressInfo).port;

      for (const fanOut of [6, 8]) {
        const failures: string[] = [];
        let served = 0;

        for (let round = 0; round < 50; round += 1) {
          // A fresh agent per round: the unfixed path's damage is per agent, so
          // reusing one would under-count it.
          const agent = harness.agent();
          const results = await Promise.allSettled(
            Array.from({ length: fanOut }, (_, i) =>
              agent.get(`/api/v1/health?round=${round}&i=${i}`),
            ),
          );
          results.forEach((result, i) => {
            if (result.status === 'rejected') {
              const err = result.reason as { code?: string; message?: string };
              failures.push(err?.code ?? err?.message ?? String(err));
              return;
            }
            // Precision, not just "it did not throw": a 200 that came from the app
            // under test, not from whatever else might answer on that port.
            expect(result.value.status).toBe(200);
            expect(result.value.body).toMatchObject({ status: 'ok', service: 'bettertrack-api' });
            expect(result.value.request.url).toContain(`round=${round}&i=${i}`);
            served += 1;
          });
        }

        expect(failures).toEqual([]);
        expect(served).toBe(50 * fanOut);
      }

      // One bind for the whole thing — the fan-out never opened or closed a port.
      expect(server.listening).toBe(true);
      expect((server.address() as AddressInfo).port).toBe(port);
    },
  );
});

describe('the harness server’s lifecycle', () => {
  it('binds loopback only, the way #1998 requires, and binds exactly once', async () => {
    const server = harness.server();
    const address = server.address() as AddressInfo;
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(address.port).toBeGreaterThan(0);
    // Memoised: every accessor rides the same bind.
    expect(harness.server()).toBe(server);
    expect(sharedServerOf(harness.agent())).toBe(server);

    // `request()` hands out supertest's bare handle, which has no server of its
    // own to inspect — so prove it the way it matters: the request it builds
    // points at this server, and carries no `_server` for `end()` to close.
    // (`_server` is what supertest assigns only when IT had to bind.)
    const pending = harness.request().get('/api/v1/health');
    expect(pending.url).toBe(`http://127.0.0.1:${address.port}/api/v1/health`);
    expect((pending as unknown as { _server?: http.Server })._server).toBeUndefined();
    expect((await pending).status).toBe(200);
    expect(server.listening).toBe(true);
  });

  it('is closed by dispose(), which stays idempotent', async () => {
    const own = await createTestApp();
    const server = own.server();
    expect(server.listening).toBe(true);

    await own.dispose();
    expect(server.listening).toBe(false);
    // Terminal and idempotent — the reaper calls disposers it has handed out.
    await expect(own.dispose()).resolves.toBeUndefined();

    // And terminal loudly: binding a second port here would leak one nothing is
    // left to close, so asking for a server after dispose() is an error, not a
    // quiet re-listen.
    expect(() => own.server()).toThrow(/has been disposed/);
    expect(() => own.agent()).toThrow(/has been disposed/);
  });

  it('binds nothing at all for a harness whose tests never make a request', async () => {
    const own = await createTestApp();
    // Nothing asked for a server, so `dispose()` has none to close — and the
    // disposer the registry is holding retains no express app (#1936).
    await expect(own.dispose()).resolves.toBeUndefined();
  });
});
