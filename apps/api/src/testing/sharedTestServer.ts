import type http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One long-lived HTTP server per harness (#2020).
 *
 * ## The flake this removes
 *
 * `request.agent(app)` builds **one** `http.createServer(app)` in the agent's
 * constructor and hands that same server object to every request the agent
 * makes (`supertest/lib/agent.js`). `supertest/lib/test.js` then does two
 * things with it:
 *
 * ```js
 * serverAddress(app, path) {           // Test constructor
 *   const addr = app.address();
 *   if (!addr) this._server = app.listen(0);   // only when NOT already bound
 *   return 'http://127.0.0.1:' + app.address().port + path;
 * }
 * end(fn) {                            // when the response arrives
 *   const server = this._server;
 *   …
 *   if (server && server._handle) return server.close(…);
 * }
 * ```
 *
 * So in `Promise.all([agent.get(a), agent.get(b), …])` — where every `Test` is
 * constructed synchronously, before any of them runs — the **first** one finds
 * no address, binds the shared server and keeps `_server`; the rest find the
 * port already bound and keep nothing. The moment that first request's response
 * lands, its `end()` closes the listening handle *out from under its siblings*.
 * Connections the kernel has queued but libuv has not accepted yet die with the
 * listening socket, and the client sees `ECONNRESET`.
 *
 * The damage is therefore a function of how many of the fan-out's connections
 * are still unaccepted when the first response completes. Measured on
 * `GET /api/v1/health`, 50 rounds per width, one fresh agent per round:
 *
 * | fan-out on one agent   |     2 |     3 |      4 |       6 |       8 |
 * |------------------------|-------|-------|--------|---------|---------|
 * | `request.agent(app)`   | 0/100 | 0/150 | 50/200 | 138/300 | 230/400 |
 * |                        |   0 % |   0 % |   25 % |    46 % |    58 % |
 * | `harness.agent()`      | 0/100 | 0/150 |  0/200 |   0/300 |   0/400 |
 *
 * The survivor count barely moves with the width — about three requests per
 * round get accepted and answered before the shared server goes away, and
 * everything behind them is reset.
 *
 * It fails as a transport error — `ECONNRESET`, no status, no body — so it
 * reads like a broken socket rather than a harness bug, which is why #2020
 * calls it latent: fan-out 2 (the only shape the repo had) is clean, and the
 * next test that fans out wider inherits a 20-60 % flake.
 *
 * ## The fix
 *
 * Bind the harness's express app **once** and hand supertest a server that is
 * already listening. `serverAddress` then takes its early exit — `addr` is
 * truthy, `_server` is never assigned — so `end()` has nothing to close and no
 * request can pull the transport out from under another. The fan-out shape
 * stops mattering entirely — the bottom row of the table above.
 *
 * Use it through the harness:
 *
 * ```ts
 * const agent = harness.agent();          // cookie jar, safe to fan out
 * const res   = await harness.request().get('/api/v1/health');
 * ```
 *
 * `request(harness.app)` (no agent) was never affected — supertest builds a
 * *fresh* server per `Test` there, so nothing is shared — but it pays a bind
 * and an unbind per request. Going through the harness is ~1 ms/request
 * cheaper: 300 serial `GET /api/v1/health` cost 539 ms via `request(app)` and
 * 234 ms via `harness.request()`.
 *
 * ## Lifecycle
 *
 * - **Lazy.** The bind happens on the first `server()`/`agent()`/`request()`
 *   call, so a harness whose tests never make an HTTP request never binds a
 *   port — and, more importantly, its disposer keeps holding nothing (below).
 * - **Host-less on purpose.** `listen(0)` with no host is what
 *   `loopbackOnlyListen.ts` (#1998) rewrites into a *synchronous* `127.0.0.1`
 *   bind. Synchronous is non-negotiable: supertest reads `server.address()` on
 *   the line after, and the explicit `listen(0, host)` form defers through
 *   `dns.lookup()` and would hand it `null`. That patch is installed by the
 *   setup file both vitest configs share, before any test module loads, so
 *   every harness server lands on the IPv4 loopback, which
 *   `__tests__/sharedTestServer.test.ts` asserts outright.
 * - **`unref()`d.** The server never keeps a vitest worker alive on its own; an
 *   in-flight request always has its own ref'd client socket.
 * - **Closed by the harness's `dispose()`**, i.e. by the explicit call or by
 *   whichever reaper (#1936 suite/file) gets there first.
 *
 * ## Why a slot rather than a closure
 *
 * `harnessRegistry.ts` holds a harness's disposer until file teardown, so
 * whatever that disposer closes over stays alive for the whole file.
 * `createTestApp` therefore builds its disposer from a module-level factory
 * that captures nothing but the resources — and this module's server is one of
 * them. Handing the disposer a `close()` defined next to the express app would
 * put the app, its router tree and every service back into the retained scope,
 * which is the exact leak #1936 removed.
 *
 * So the harness allocates a {@link SharedServerSlot} — a two-field box that
 * knows nothing about the app — before `createApp()` runs, and the disposer
 * closes over the box alone. Until something calls `sharedTestServer()` the box
 * holds `null` and pins nothing at all; once it holds a listening server, that
 * server pins the app, which is correct and is precisely what has to be closed.
 */

/**
 * A harness's HTTP server, or `null` until one is needed. Deliberately inert:
 * it carries no reference to the app, so a disposer can hold it for the life of
 * a test file without retaining the harness it belongs to.
 */
export interface SharedServerSlot {
  server: http.Server | null;
  /**
   * Set by {@link closeSharedServer}. Without it a request made through a
   * harness the reaper has already released would quietly bind a *second*
   * ephemeral port that nothing is left to close — a leak that only shows up as
   * a file-descriptor ceiling hours later. It throws instead.
   */
  closed: boolean;
}

/** An express app, narrowed to the one method this module calls. */
export interface ListenableApp {
  listen(port: number): http.Server;
}

export function createSharedServerSlot(): SharedServerSlot {
  return { server: null, closed: false };
}

/**
 * The harness's long-lived server, bound on first use. Synchronous by
 * construction — see the host-less-listen note above.
 */
export function sharedTestServer(slot: SharedServerSlot, app: ListenableApp): http.Server {
  if (slot.server) return slot.server;
  if (slot.closed) {
    throw new Error(
      'sharedTestServer (#2020): this harness has been disposed — by an explicit dispose() or by ' +
        'the suite/file reaper (#1936, #1940) — so its server is gone and binding another would ' +
        'leak a port nothing closes. Build a fresh harness with createTestApp().',
    );
  }

  const server = app.listen(0);
  // `loopbackOnlyListen` binds through a TCP handle, so the address is readable
  // immediately. Anything else means the patch is not installed and supertest
  // would read `null` off this server one line later — fail here, where the
  // reason is legible, rather than there.
  const address = server.address() as AddressInfo | string | null;
  // Stock Node ALSO binds a host-less `listen(0)` synchronously — on the IPv6
  // wildcard `::`, which is exactly the #1998 squatting class. So a readable
  // address is not proof the patch ran; the loopback ADDRESS is. Check both.
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    // Best-effort unbind of a server we are about to throw away. Unreachable in
    // the suite: `installLoopbackOnlyListen()` proves the synchronous bind
    // primitive exists before any test module loads.
    server.close();
    throw new Error(
      'sharedTestServer (#2020): app.listen(0) did not bind synchronously on 127.0.0.1 ' +
        `(got ${address === null ? 'null' : typeof address === 'string' ? address : address.address}), ` +
        'so supertest would either read no port or dial a wildcard bind an IDE can squat. The ' +
        'loopback-only listen patch (#1998, installed by setupHarnessReaper.ts) is what makes a ' +
        'host-less listen a synchronous loopback bind — is the shared vitest setup file loaded?',
    );
  }
  // A forgotten harness must never hold a vitest worker open; an in-flight
  // request keeps the loop alive through its own client socket regardless.
  server.unref();
  slot.server = server;
  return server;
}

/**
 * Releases the slot's server, if it ever bound one. Idempotent, and terminal
 * for the harness: a later `sharedTestServer()` throws rather than binding a
 * port nothing is left to close.
 *
 * Module-level and taking the slot as its only argument on purpose: this is
 * what the harness disposer closes over (see "Why a slot" above).
 */
export async function closeSharedServer(slot: SharedServerSlot): Promise<void> {
  const server = slot.server;
  // Marked first: `close()` must not be retried by a second dispose, and the
  // registry's reaper calls disposers it has already handed out.
  slot.closed = true;
  if (!server) return;
  slot.server = null;
  // `close()` resolves only once the last connection is gone. Supertest's
  // client closes each connection with its response (superagent passes
  // `agent: false`, so nothing is pooled — a 300-request server holds 0 sockets
  // afterwards), but a request abandoned mid-flight — a rejected expectation, a
  // test that returned early — would otherwise hang teardown until its socket
  // timed out.
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      // Already closed is the outcome we wanted, not a failure.
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
      else resolve();
    });
  });
}
