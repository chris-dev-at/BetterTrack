import {
  Agent as HttpAgent,
  createServer as createHttpServer,
  request,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WEBHOOK_DELIVERY_ERRORS,
  WEBHOOK_DELIVERY_NETWORK_ERROR,
  WEBHOOK_DELIVERY_TIMEOUT_ERROR,
} from '@bettertrack/contracts';

import type { ResolvedOutboundUrl } from '../../security/outboundUrlGuard';
import { createPinnedWebhookTransport } from '../webhookDispatcher';

/**
 * The production webhook transport (§13.5 V5-P10, §8 outbound safety).
 *
 * The dispatcher re-runs the SSRF guard before every attempt, but that check is
 * only worth something if the socket goes to the address the guard vetted. A
 * bare `fetch` resolves the hostname a second time at connect, which is exactly
 * the DNS-rebinding window: guard time answers a public address, connect time
 * answers loopback or link-local, and the signed POST lands inside the
 * deployment. These tests run real sockets — `127.0.0.1` stands in for the
 * vetted address and `127.0.0.2` for the one a rebind would substitute, both on
 * the same port so only the address distinguishes them.
 */
const VETTED = '127.0.0.1';
const REBOUND = '127.0.0.2';

const HEADERS = { 'content-type': 'application/json', 'x-bettertrack-event': 'alert.triggered' };
const BODY = '{"id":"delivery-1","type":"alert.triggered"}';

/**
 * A transport failure may only ever be one of the canonical constants: no errno,
 * no address, no port, no hostname, no certificate names. Those are what turn a
 * delivery log the subscriber can read into a scanner for whatever the outbound
 * guard still allows.
 */
function expectNoDestinationDetail(error: string | undefined, port: number): void {
  expect(WEBHOOK_DELIVERY_ERRORS).toContain(error);
  expect(error).not.toMatch(/\d/);
  expect(error).not.toContain(String(port));
  expect(error).not.toContain(VETTED);
  expect(error).not.toContain('receiver.rebind.test');
}

interface Receivers {
  port: number;
  hits: Record<string, number>;
  received: { headers: IncomingMessage['headers']; body: string }[];
}

describe('pinned webhook transport', () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  function track(server: HttpServer | TcpServer): void {
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }

  function listenOn(server: HttpServer | TcpServer, host: string, port = 0): Promise<number> {
    return new Promise<number>((resolve) => {
      server.listen(port, host, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  /** One HTTP receiver per address on a shared port; both record what they saw. */
  async function httpReceivers(
    respond: (host: string, res: ServerResponse) => void = (_host, res) =>
      void res.writeHead(204).end(),
  ): Promise<Receivers> {
    const hits: Record<string, number> = { [VETTED]: 0, [REBOUND]: 0 };
    const received: Receivers['received'] = [];
    const build = (host: string) => {
      const server = createHttpServer((req, res) => {
        hits[host] = (hits[host] ?? 0) + 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
          respond(host, res);
        });
      });
      track(server);
      return server;
    };
    const port = await listenOn(build(VETTED), VETTED);
    await listenOn(build(REBOUND), REBOUND, port);
    return { port, hits, received };
  }

  function target(url: string, address = VETTED): ResolvedOutboundUrl {
    return { url: new URL(url), addresses: [{ address, family: 4 }] };
  }

  it('POSTs to the vetted address even when a second lookup would answer a private one', async () => {
    const { port, hits, received } = await httpReceivers();
    const url = `http://receiver.rebind.test:${port}/hook`;

    // Control — what a transport that resolves at connect time (a bare `fetch`)
    // does with a rebound record: the POST lands on the private address.
    const rebinding = new HttpAgent({
      keepAlive: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: REBOUND, family: 4 }]);
        else callback(null, REBOUND, 4);
      },
    });
    await new Promise<void>((resolve) => {
      const req = request(url, { method: 'POST', agent: rebinding }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
      req.end(BODY);
    });
    rebinding.destroy();
    expect(hits).toEqual({ [VETTED]: 0, [REBOUND]: 1 });

    // The transport, given the same URL and the guard's vetted address.
    const result = await createPinnedWebhookTransport().send({
      url,
      headers: HEADERS,
      body: BODY,
      target: target(url),
    });

    expect(result).toEqual({ ok: true, status: 204 });
    expect(hits).toEqual({ [VETTED]: 1, [REBOUND]: 1 });
    const delivered = received.at(-1)!;
    expect(delivered.body).toBe(BODY);
    expect(delivered.headers['content-type']).toBe('application/json');
    expect(delivered.headers['x-bettertrack-event']).toBe('alert.triggered');
    // The hostname travels unchanged, so a receiver behind vhosts still matches.
    expect(delivered.headers.host).toBe(`receiver.rebind.test:${port}`);
    expect(delivered.headers['content-length']).toBe(String(Buffer.byteLength(BODY)));
  });

  it('dials only the vetted address for an https receiver', async () => {
    const hits: Record<string, number> = { [VETTED]: 0, [REBOUND]: 0 };
    const build = (host: string) => {
      const server = createTcpServer((socket) => {
        hits[host] = (hits[host] ?? 0) + 1;
        socket.destroy();
      });
      track(server);
      return server;
    };
    const port = await listenOn(build(VETTED), VETTED);
    await listenOn(build(REBOUND), REBOUND, port);
    const url = `https://receiver.rebind.test:${port}/hook`;

    // A bare TCP listener never completes the TLS handshake, so the delivery
    // fails — which listener saw the connection is what this asserts.
    const result = await createPinnedWebhookTransport().send({
      url,
      headers: HEADERS,
      body: BODY,
      target: target(url),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(hits).toEqual({ [VETTED]: 1, [REBOUND]: 0 });
  });

  it('reports a non-2xx response as a failure carrying the status', async () => {
    const { port } = await httpReceivers((_host, res) => res.writeHead(500).end('boom'));
    const url = `http://receiver.rebind.test:${port}/hook`;

    const result = await createPinnedWebhookTransport().send({
      url,
      headers: HEADERS,
      body: BODY,
      target: target(url),
    });

    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('never follows a redirect to an unvetted destination', async () => {
    const { port, hits } = await httpReceivers((host, res) => {
      if (host === VETTED)
        res.writeHead(302, { location: `http://${REBOUND}:${port}/moved` }).end();
      else res.writeHead(204).end();
    });
    const url = `http://receiver.rebind.test:${port}/hook`;

    const result = await createPinnedWebhookTransport().send({
      url,
      headers: HEADERS,
      body: BODY,
      target: target(url),
    });

    expect(result).toEqual({ ok: false, status: 302 });
    expect(hits).toEqual({ [VETTED]: 1, [REBOUND]: 0 });
  });

  it('reports a refused connection as a status-less failure, with no socket text', async () => {
    // Bind, read the port, then close: nothing is listening on it any more.
    const idle = createHttpServer();
    const port = await listenOn(idle, VETTED);
    await new Promise<void>((resolve) => idle.close(() => resolve()));
    const url = `http://receiver.rebind.test:${port}/hook`;

    const result = await createPinnedWebhookTransport().send({
      url,
      headers: HEADERS,
      body: BODY,
      target: target(url),
    });

    // Node's own message here is `connect ECONNREFUSED 127.0.0.1:<port>` — the
    // address and port a subscriber may not learn anything about.
    expect(result).toEqual({ ok: false, status: null, error: WEBHOOK_DELIVERY_NETWORK_ERROR });
    expectNoDestinationDetail(result.error, port);
  });

  it('reports a failed TLS handshake structurally, never the certificate’s hosts', async () => {
    // A plain-http listener answering an https request: the handshake fails, and
    // the raw error (wrong version number / certificate altnames on a real TLS
    // mismatch) is exactly what must not reach the log.
    const { port } = await httpReceivers();
    const url = `https://receiver.rebind.test:${port}/hook`;

    const result = await createPinnedWebhookTransport().send({
      url,
      headers: HEADERS,
      body: BODY,
      target: target(url),
    });

    expect(result).toEqual({ ok: false, status: null, error: WEBHOOK_DELIVERY_NETWORK_ERROR });
    expectNoDestinationDetail(result.error, port);
  });

  it('gives up on a receiver that never answers', async () => {
    const server = createHttpServer(() => {
      /* accept the request and never respond */
    });
    track(server);
    const port = await listenOn(server, VETTED);
    const url = `http://receiver.rebind.test:${port}/hook`;

    const result = await createPinnedWebhookTransport(25).send({
      url,
      headers: HEADERS,
      body: BODY,
      target: target(url),
    });

    // The transport's own deadline marker — the dispatcher collapses it into
    // WEBHOOK_DELIVERY_NETWORK_ERROR before it is logged, so a filtered port and
    // a closed one read the same in the delivery log.
    expect(result).toEqual({ ok: false, status: null, error: WEBHOOK_DELIVERY_TIMEOUT_ERROR });
    expectNoDestinationDetail(result.error, port);
  });

  it('refuses to send when the guard vetted no address at all', async () => {
    const { port, hits } = await httpReceivers();
    const url = `http://receiver.rebind.test:${port}/hook`;

    const result = await createPinnedWebhookTransport().send({
      url,
      headers: HEADERS,
      body: BODY,
      target: { url: new URL(url), addresses: [] },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(hits).toEqual({ [VETTED]: 0, [REBOUND]: 0 });
  });
});
