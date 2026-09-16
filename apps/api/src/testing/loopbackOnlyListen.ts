import net from 'node:net';

/**
 * Loopback-only ephemeral binds for the API test process (#1998).
 *
 * ## The flake this removes
 *
 * Supertest opens a brand-new server for every single request: `request(app)`
 * wraps the express app in `http.createServer(app)`, calls `app.listen(0)` with
 * **no host**, reads the port back synchronously and builds the URL
 * `http://127.0.0.1:<port><path>` (see `supertest/lib/test.js`). A full API run
 * therefore performs tens of thousands of ephemeral binds.
 *
 * A host-less `listen(0)` binds the IPv6 **wildcard** `::` (`net.js`'s
 * `createServerHandle` calls `bind6('::', port)` when no address is given). Two
 * facts about that address then combine into a transport flake:
 *
 * 1. macOS hands out ephemeral ports from ONE sequential cursor over
 *    `net.inet.ip.portrange` (49152-65535 here), shared across address
 *    families. Each cursor sweep therefore visits every port in the range
 *    exactly once, and a suite that binds ~40k times sweeps it several times.
 * 2. The kernel does not treat a foreign socket bound to the IPv4-mapped
 *    loopback `::ffff:127.0.0.1:P` as conflicting with the wildcard `:::P`, so
 *    the sweep happily hands out `P` and the bind succeeds. But a connection to
 *    `127.0.0.1:P` — the address supertest put in the URL — is delivered to the
 *    **more specific** bind, i.e. to the foreign process.
 *
 * A JetBrains IDE is the archetype: Android Studio holds `127.0.0.1:63342`
 * (its built-in web server) and `127.0.0.1:56113` on exactly such AF_INET6
 * sockets, both inside the ephemeral range. When the cursor reaches one of
 * them, the request under test is answered by the IDE instead of the app:
 *
 * - the built-in web server answers `404` — which is why the failures landed on
 *   routes that have no 404 path at all (`GET /social/requests`,
 *   `POST /workboard`): the request never reached our router;
 * - a squatter that does not speak HTTP produces
 *   `Parse Error: Expected HTTP/, RTSP/ or ICE/` (`HPE_INVALID_CONSTANT`) —
 *   the second face of the same flake (`admin.test.ts`, `tax.test.ts`).
 *
 * It is volume-correlated, not concurrency-correlated (each sweep costs a
 * couple of stolen requests wherever the runner happens to be), which is
 * exactly the observed "rotating single-test 404s that pass in isolation".
 *
 * ## The fix
 *
 * Bind host-less listens to `127.0.0.1` instead of the wildcard. Then the
 * kernel's own conflict check applies: `bind(127.0.0.1, 63342)` while the IDE
 * holds that address returns `EADDRINUSE`, so the ephemeral allocator can never
 * hand a squatted port to a test server, and a connection to `127.0.0.1:<port>`
 * can only ever reach the server that owns it. Loopback is also the only
 * address the suite ever connects to, so nothing loses reachability.
 *
 * ## Why it is patched here rather than at the supertest call sites
 *
 * `listen(port, host)` is **asynchronous** in Node: a named host routes through
 * `lookupAndListen()` -> `dns.lookup()`, which defers to a tick even for an IP
 * literal, so `server.address()` is still `null` when supertest reads it on the
 * next line. The bind has to stay synchronous. `net._createServerHandle()` is
 * the primitive Node's own `listen` uses: it binds and returns the TCP handle
 * synchronously, and `listen({ _handle })` adopts it (`net.js` returns early
 * for a handle before it ever looks at a host). Patching the one seam every
 * ephemeral bind in the test process goes through — `net.Server.prototype.listen`
 * — fixes supertest, the realtime gateway tests' own `harness.app.listen(0)`,
 * and anything added later, without touching a single test file or changing
 * what `createTestApp()` hands out.
 *
 * Installed from `setupHarnessReaper.ts`, the setup file both vitest configs
 * share, so it is in place before any test module is imported.
 */

/** The only address a host-less `listen()` may bind while tests run. */
export const TEST_LISTEN_HOST = '127.0.0.1';

/** libuv address type for IPv4, as `net._createServerHandle` expects it. */
const ADDRESS_TYPE_IPV4 = 4;

/**
 * Where the un-patched `listen` is parked.
 *
 * On the prototype rather than in module scope on purpose: Vitest resets this
 * module's registry for every test file while `node:net` stays cached for the
 * life of the worker, so a module-level flag would re-wrap the same prototype
 * once per file and stack N wrappers deep.
 */
const ORIGINAL_LISTEN: unique symbol = Symbol.for('bettertrack.testing.loopbackOnlyListen');

type ListenFn = (this: net.Server, ...args: unknown[]) => net.Server;

type ServerHandle = { getsockname(out: Record<string, unknown>): number; close(): void };

type PatchedPrototype = {
  listen: ListenFn;
  [ORIGINAL_LISTEN]?: ListenFn;
};

/**
 * `net._createServerHandle(address, port, addressType)` — Node's own
 * synchronous bind primitive. Undocumented but long-standing (it is what
 * `listen()` and `cluster` bind through). Returns the bound TCP handle, or a
 * negative libuv errno when the bind failed.
 */
type ServerHandleFactory = (
  address: string,
  port: number,
  addressType: number,
) => ServerHandle | number;

function serverHandleFactory(): ServerHandleFactory | undefined {
  return (net as unknown as { _createServerHandle?: ServerHandleFactory })._createServerHandle;
}

function prototype(): PatchedPrototype {
  return net.Server.prototype as unknown as PatchedPrototype;
}

/** Options keys this patch understands; anything else is left to Node. */
const REWRITABLE_OPTION_KEYS = new Set(['port', 'backlog']);

interface LoopbackListenPlan {
  port: number;
  /** Positional args Node still needs after the handle: `[backlog?, cb?]`. */
  trailing: unknown[];
}

function isNumericPort(value: unknown): value is number | string {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 65535;
  return typeof value === 'string' && /^\d{1,5}$/.test(value) && Number(value) <= 65535;
}

/**
 * Decides whether a `listen()` call is a host-less TCP bind this patch should
 * redirect to loopback, and normalises its arguments if so. Returns `null` for
 * every other shape — a named host, a pipe/unix path, an inherited fd or
 * handle, or an options object carrying anything this patch does not model
 * (`signal`, `ipv6Only`, `reusePort`, `exclusive`, `readableAll`, …). Those are
 * handed to Node untouched: none of them occurs in the API suite, and guessing
 * at their semantics would be a worse trade than leaving them on the wildcard.
 */
function planLoopbackListen(args: readonly unknown[]): LoopbackListenPlan | null {
  const first = args[0];

  // listen(), listen(cb), listen(null[, cb]) — Node normalises these to port 0.
  if (args.length === 0) return { port: 0, trailing: [] };
  if (typeof first === 'function') return { port: 0, trailing: [...args] };
  if (first === null || first === undefined) return { port: 0, trailing: args.slice(1) };

  // listen(port[, host][, backlog][, cb])
  if (typeof first === 'number' || typeof first === 'string') {
    if (!isNumericPort(first)) return null; // a pipe name / unix socket path
    if (typeof args[1] === 'string') return null; // a host was named
    const trailing = args.slice(1);
    if (trailing.length > 0 && trailing[0] === undefined) trailing.shift(); // explicit `undefined` host
    return { port: Number(first), trailing };
  }

  // listen(options[, cb])
  if (typeof first !== 'object') return null;
  const options = first as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (!REWRITABLE_OPTION_KEYS.has(key)) return null;
  }
  const port = options.port;
  if (port !== undefined && port !== null && !isNumericPort(port)) return null;
  const trailing = args.slice(1);
  // The handle branch of `net.Server.prototype.listen` reads the backlog
  // positionally, so an options backlog has to move out of the object.
  if (options.backlog !== undefined) trailing.unshift(options.backlog);
  return { port: port === undefined || port === null ? 0 : Number(port), trailing };
}

function patchedListen(this: net.Server, ...args: unknown[]): net.Server {
  const original = prototype()[ORIGINAL_LISTEN];
  // Unreachable: the marker and the patched function are installed together.
  if (!original) {
    throw new Error('loopbackOnlyListen: the original net.Server#listen is missing');
  }

  // A second listen on a live server must keep throwing ERR_SERVER_ALREADY_LISTEN
  // rather than leaking a freshly bound handle here.
  const alreadyListening = (this as unknown as { _handle?: unknown })._handle != null;
  const plan = alreadyListening ? null : planLoopbackListen(args);
  if (!plan) return original.apply(this, args);

  const createHandle = serverHandleFactory();
  // Unreachable: install() refuses to patch without the primitive.
  if (!createHandle) {
    throw new Error('loopbackOnlyListen: net._createServerHandle is unavailable');
  }

  const handle = createHandle(TEST_LISTEN_HOST, plan.port, ADDRESS_TYPE_IPV4);
  if (typeof handle !== 'object' || handle === null) {
    // A negative libuv errno — the bind failed (EADDRINUSE, EACCES, …). Hand
    // the call back to Node with the host spelled out so it reports the failure
    // on the server's 'error' event with the fields callers already expect.
    return original.call(this, plan.port, TEST_LISTEN_HOST, ...plan.trailing);
  }
  try {
    return original.call(this, { _handle: handle }, ...plan.trailing);
  } catch (err) {
    // Never leak a bound ephemeral port if Node rejects the call after all.
    handle.close();
    throw err;
  }
}

/**
 * Proves the synchronous bind primitive is really there before anything depends
 * on it. A Node upgrade that drops or renames `net._createServerHandle` fails
 * loudly here — one clear error at setup — instead of silently letting the
 * #1998 flake back in.
 */
function assertSynchronousLoopbackBind(): void {
  const createHandle = serverHandleFactory();
  if (typeof createHandle !== 'function') {
    throw new Error(
      'loopbackOnlyListen (#1998): net._createServerHandle is gone from this Node build, so a ' +
        'host-less listen() can no longer be bound to loopback synchronously. Supertest reads ' +
        'server.address() on the line after listen(0), so the async listen(0, host) form cannot ' +
        'replace it — the harness needs a new seam before this Node version is adopted.',
    );
  }
  const probe = createHandle(TEST_LISTEN_HOST, 0, ADDRESS_TYPE_IPV4);
  if (typeof probe !== 'object' || probe === null || typeof probe.getsockname !== 'function') {
    throw new Error(
      `loopbackOnlyListen (#1998): net._createServerHandle('${TEST_LISTEN_HOST}', 0, ${ADDRESS_TYPE_IPV4}) ` +
        `did not return a bound TCP handle (got ${String(probe)}).`,
    );
  }
  probe.close();
}

/** Whether host-less listens in this process are currently loopback-only. */
export function isLoopbackOnlyListenInstalled(): boolean {
  return prototype()[ORIGINAL_LISTEN] !== undefined;
}

/**
 * Redirects every host-less TCP `listen()` in this process to `127.0.0.1`.
 * Idempotent, and safe to call from a setup file that is evaluated once per
 * test file.
 */
export function installLoopbackOnlyListen(): void {
  if (isLoopbackOnlyListenInstalled()) return;
  assertSynchronousLoopbackBind();
  const proto = prototype();
  proto[ORIGINAL_LISTEN] = proto.listen;
  proto.listen = patchedListen;
}

/**
 * Restores Node's own `listen`. Exists for the #1998 reproducer, which has to
 * bind the wildcard the way the unfixed harness did in order to prove the steal
 * is real; production code and ordinary tests have no reason to call it.
 */
export function uninstallLoopbackOnlyListen(): void {
  const proto = prototype();
  const original = proto[ORIGINAL_LISTEN];
  if (!original) return;
  proto.listen = original;
  delete proto[ORIGINAL_LISTEN];
}
