import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TEST_LISTEN_HOST,
  installLoopbackOnlyListen,
  isLoopbackOnlyListenInstalled,
  uninstallLoopbackOnlyListen,
} from '../loopbackOnlyListen';

/**
 * #1998 — the transport flake behind "404 on a route with no 404 path" and
 * "Parse Error: Expected HTTP/, RTSP/ or ICE/".
 *
 * The reproducer stands a squatter on an IPv4-loopback ephemeral port (what a
 * resident IDE/daemon does — Android Studio holds `127.0.0.1:63342` and
 * `127.0.0.1:56113` on this machine, both inside macOS's 49152-65535 ephemeral
 * range) and then binds a server the way the unfixed harness did: host-less, so
 * the IPv6 wildcard `::`. The kernel lets that overlap, the URL supertest builds
 * points at `127.0.0.1`, and the more specific bind wins — the request under
 * test is answered by the squatter.
 *
 * `loopbackOnlyListen.ts` carries the full write-up.
 */

const openServers = new Set<net.Server>();
const openSockets = new Set<net.Socket>();
const openPaths = new Set<string>();

afterEach(async () => {
  // `close()` resolves only once the last connection is gone, and a squatter
  // that hung up on a stranger can leave a half-closed one behind.
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  for (const server of openServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  openServers.clear();
  for (const socketPath of openPaths) {
    await rm(socketPath, { force: true });
  }
  openPaths.clear();
  // Every test that borrows the un-patched listen restores it in a finally, but
  // a failed assertion inside one must not leak the unfixed binding into the
  // rest of the file.
  installLoopbackOnlyListen();
});

type ListenResult = { ok: true; address: AddressInfo } | { ok: false; code: string };

/** Calls `listen(...args)` and resolves with the bound address or the error code. */
function listen(server: net.Server, args: unknown[]): Promise<ListenResult> {
  openServers.add(server);
  server.on('connection', (socket: net.Socket) => {
    socket.on('error', () => {});
    openSockets.add(socket);
  });
  return new Promise<ListenResult>((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      resolve({ ok: false, code: err.code ?? err.message });
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve({ ok: true, address: server.address() as AddressInfo });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      (server.listen as (...listenArgs: unknown[]) => unknown)(...args);
    } catch (err) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      resolve({ ok: false, code: (err as NodeJS.ErrnoException).code ?? String(err) });
    }
  });
}

/** Releases one server (and anything still connected to it) before the hook does. */
async function close(server: net.Server): Promise<void> {
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  openServers.delete(server);
}

interface Answer {
  status?: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  error?: string;
}

/** One plain HTTP GET against loopback — the request supertest would have made. */
function get(port: number, requestPath: string): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    // `agent: false` matches what superagent (and therefore supertest) does:
    // one connection per request, closed when the response ends.
    const req = http.get(
      { host: TEST_LISTEN_HOST, port, path: requestPath, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', (err) => resolve({ headers: {}, body: '', error: err.message }));
  });
}

/** A resident process holding an ephemeral port on the IPv4 loopback. */
async function squatHttp(): Promise<number> {
  const squatter = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html', 'x-squatter': 'resident-http-server' });
    res.end('<!doctype html><title>404 Not Found</title>');
  });
  const bound = await listen(squatter, [0, TEST_LISTEN_HOST]);
  expect(bound.ok).toBe(true);
  return (bound as { ok: true; address: AddressInfo }).address.port;
}

/** The same, for a resident process that does not speak HTTP at all. */
async function squatRaw(): Promise<number> {
  const squatter = net.createServer((socket) => socket.end('+PONG\r\n'));
  const bound = await listen(squatter, [0, TEST_LISTEN_HOST]);
  expect(bound.ok).toBe(true);
  return (bound as { ok: true; address: AddressInfo }).address.port;
}

/** A server that answers 200 for everything — any 404 came from somewhere else. */
function alwaysOk(marker: string): http.Server {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-served-by': marker });
    res.end(JSON.stringify({ url: req.url }));
  });
}

describe('#1998 reproducer — a squatted ephemeral port steals the request', () => {
  it('answers a host-less bind with the SQUATTER’s 404, and refuses the loopback bind outright', async () => {
    const port = await squatHttp();
    const victim = alwaysOk('app-under-test');

    uninstallLoopbackOnlyListen();
    let stolen: ListenResult;
    try {
      stolen = await listen(victim, [port]);
    } finally {
      installLoopbackOnlyListen();
    }

    if (stolen.ok) {
      // BSD/macOS: the wildcard bind is allowed to overlap an IPv4-loopback
      // listener, so the victim believes it owns the port…
      expect(stolen.address.port).toBe(port);
      expect(['::', '0.0.0.0']).toContain(stolen.address.address);
      // …and every request to the URL supertest would have built is delivered to
      // the squatter instead. This is the reported failure, verbatim: a 404 from
      // a server whose router the test never even reached.
      const answer = await get(port, '/a-route-that-always-answers-200');
      expect(answer.status).toBe(404);
      expect(answer.headers['x-squatter']).toBe('resident-http-server');
      expect(answer.headers['x-served-by']).toBeUndefined();
    } else {
      // Linux refuses the overlapping bind instead, which is why the flake is
      // macOS-only. Assert the specific reason so this branch cannot go vacuous.
      expect(stolen.code).toBe('EADDRINUSE');
    }

    // The victim has to go first. Two wildcard binds on one port DO collide, so
    // leaving it listening would satisfy the assertion below for the wrong
    // reason: what must refuse the loopback bind is the squatter, alone.
    await close(victim);

    // The fix, on every platform: a host-less listen now binds loopback, where
    // the kernel's own conflict check applies. The squatted port is unbindable,
    // so the ephemeral allocator can never hand it to a test server.
    const guarded = await listen(alwaysOk('app-under-test'), [port]);
    expect(guarded).toEqual({ ok: false, code: 'EADDRINUSE' });
  });

  it('shows the same steal as "Parse Error: Expected HTTP/" when the squatter is not an HTTP server', async () => {
    const port = await squatRaw();
    const victim = alwaysOk('app-under-test');

    uninstallLoopbackOnlyListen();
    let stolen: ListenResult;
    try {
      stolen = await listen(victim, [port]);
    } finally {
      installLoopbackOnlyListen();
    }

    if (stolen.ok) {
      const answer = await get(port, '/a-route-that-always-answers-200');
      expect(answer.status).toBeUndefined();
      expect(answer.error).toMatch(/Parse Error: Expected HTTP\//);
    } else {
      expect(stolen.code).toBe('EADDRINUSE');
    }

    await close(victim);
    const guarded = await listen(alwaysOk('app-under-test'), [port]);
    expect(guarded).toEqual({ ok: false, code: 'EADDRINUSE' });
  });
});

describe('loopback-only listen', () => {
  it('is installed by the shared vitest setup file', () => {
    expect(isLoopbackOnlyListenInstalled()).toBe(true);
  });

  it('binds a host-less listen(0) to loopback, synchronously', async () => {
    const server = alwaysOk('sync');
    openServers.add(server);
    server.listen(0);
    // Supertest reads the port on the line after listen(0), so the bind has to
    // stay synchronous — the `listen(0, host)` form does not (dns.lookup defers
    // it a tick) and is what makes this patch bind through a TCP handle.
    const address = server.address() as AddressInfo | null;
    expect(address).toMatchObject({ address: TEST_LISTEN_HOST, family: 'IPv4' });
    expect(await get(address!.port, '/ping')).toMatchObject({ status: 200 });
  });

  it('covers the argument forms the harness and its tests actually use', async () => {
    const withCallback = await listen(net.createServer(), [0, () => {}]);
    expect(withCallback).toMatchObject({ ok: true, address: { address: TEST_LISTEN_HOST } });

    const withBacklog = await listen(net.createServer(), [0, 511]);
    expect(withBacklog).toMatchObject({ ok: true, address: { address: TEST_LISTEN_HOST } });

    const withOptions = await listen(net.createServer(), [{ port: 0 }]);
    expect(withOptions).toMatchObject({ ok: true, address: { address: TEST_LISTEN_HOST } });

    const noArguments = await listen(net.createServer(), []);
    expect(noArguments).toMatchObject({ ok: true, address: { address: TEST_LISTEN_HOST } });
  });

  it('leaves every call that names its own address — or no address family at all — alone', async () => {
    const explicitWildcard = await listen(net.createServer(), [0, '0.0.0.0']);
    expect(explicitWildcard).toMatchObject({ ok: true, address: { address: '0.0.0.0' } });

    const explicitInOptions = await listen(net.createServer(), [{ port: 0, host: '0.0.0.0' }]);
    expect(explicitInOptions).toMatchObject({ ok: true, address: { address: '0.0.0.0' } });

    const socketPath = path.join(os.tmpdir(), `bt-1998-${process.pid}-${Date.now()}.sock`);
    openPaths.add(socketPath);
    const pipe = await listen(net.createServer(), [socketPath]);
    expect(pipe).toEqual({ ok: true, address: socketPath as unknown as AddressInfo });
  });

  it('keeps a second listen on a live server throwing instead of leaking a handle', async () => {
    const server = net.createServer();
    expect(await listen(server, [0])).toMatchObject({ ok: true });
    expect(await listen(server, [0])).toEqual({ ok: false, code: 'ERR_SERVER_ALREADY_LISTEN' });
  });

  it('binds supertest’s per-request server on loopback', async () => {
    const pending = request(alwaysOk('supertest')).get('/echo');
    const bound = (
      pending as unknown as { _server?: net.Server }
    )._server?.address() as AddressInfo | null;
    expect(bound).toMatchObject({ address: TEST_LISTEN_HOST, family: 'IPv4' });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: '/echo' });
  });
});
