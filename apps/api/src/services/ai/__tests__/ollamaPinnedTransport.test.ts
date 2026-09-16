import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { OutboundUrlResolver } from '../../security/outboundUrlGuard';
import { createOllamaProvider } from '../ollamaProvider';

/**
 * The adapter's PRODUCTION transport — the one with no injected `fetch` — over a
 * real socket (#1992 review, blocker 2).
 *
 * Vetting an address and then handing the HOSTNAME to `fetch` is not a pin: it
 * is two independent `getaddrinfo` calls per request, and a zone answering with
 * TTL 0 can return a different address to each, deterministically. The guard
 * says so itself ("callers must pin `addresses` into the actual connection"),
 * and `webhookDispatcher.ts` already does it the right way; this adapter was the
 * one caller that did not.
 *
 * ## How this proves the pin on a single loopback address
 *
 * Every endpoint below is named `*.invalid` — RFC 2606 reserves that TLD and
 * guarantees it never resolves. The system resolver therefore CANNOT complete
 * any of these connections. The only address the socket can reach is the one the
 * guard's resolver vetted and the pinned agent carried into the connection, so a
 * server that receives the request is itself the proof.
 *
 * That shape also works where a second loopback address does not: macOS refuses
 * to bind `127.0.0.2`, which is why the guard's own pinned-agent suite is
 * host-only red on this machine.
 */

/** A receiver that records what actually arrived on the wire. */
function startReceiver(body: string, status = 200) {
  const seen: Array<{ url: string; host: string | undefined; body: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        host: req.headers.host,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  return { server, seen };
}

let open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.map((s) => new Promise<void>((done) => s.close(() => done()))));
  open = [];
});

async function listen(server: Server): Promise<number> {
  open.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return (server.address() as AddressInfo).port;
}

/** The guard's answer — the address the socket must end up on. */
const vetting =
  (address: string): OutboundUrlResolver =>
  async () => [{ address, family: 4 }];

describe('Ollama adapter — the vetted address is pinned into the socket', () => {
  it('connects to the address the guard vetted for a name the system cannot resolve', async () => {
    const { server, seen } = startReceiver(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }));
    const port = await listen(server);

    const provider = createOllamaProvider({
      // `ollama.invalid` resolves NOWHERE. If this request completes, it went to
      // the vetted address and nothing else could have carried it there.
      endpoint: `http://ollama.invalid:${port}`,
      model: 'llama3.1:8b',
      resolver: vetting('127.0.0.1'),
    });

    await expect(provider.listModels()).resolves.toEqual(['llama3.1:8b']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/api/tags');
  });

  /**
   * The reason the URL is not simply rewritten to the vetted literal: undici's
   * `fetch` overwrites a caller-set `Host`, so a rewrite would silently break
   * any endpoint behind a name-based reverse proxy. Pinning the AGENT keeps the
   * request's own hostname, so `Host` is still the name the admin configured.
   */
  it('keeps the configured hostname in the Host header, so a vhosted proxy still works', async () => {
    const { server, seen } = startReceiver(JSON.stringify({ models: [] }));
    const port = await listen(server);

    const provider = createOllamaProvider({
      endpoint: `http://ollama.invalid:${port}`,
      model: 'm',
      resolver: vetting('127.0.0.1'),
    });

    await provider.listModels();
    expect(seen[0]?.host).toBe(`ollama.invalid:${port}`);
  });

  it('carries the completion body and returns the model’s reply', async () => {
    const { server, seen } = startReceiver(
      JSON.stringify({ message: { role: 'assistant', content: '  ready  ' } }),
    );
    const port = await listen(server);

    const provider = createOllamaProvider({
      endpoint: `http://ollama.invalid:${port}`,
      model: 'qwen2.5:14b',
      resolver: vetting('127.0.0.1'),
    });

    await expect(provider.complete({ prompt: 'hi', system: 'be brief' })).resolves.toEqual({
      text: 'ready',
      model: 'qwen2.5:14b',
      provider: 'ollama',
    });
    expect(seen[0]?.url).toBe('/api/chat');
    const sent = JSON.parse(seen[0]?.body ?? '{}') as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string }>;
    };
    expect(sent.model).toBe('qwen2.5:14b');
    expect(sent.stream).toBe(false);
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('maps a non-2xx to the status token and never the body', async () => {
    const { server } = startReceiver('the upstream is very sorry, token hunter2', 503);
    const port = await listen(server);

    const provider = createOllamaProvider({
      endpoint: `http://ollama.invalid:${port}`,
      model: 'm',
      resolver: vetting('127.0.0.1'),
    });

    const health = await provider.health();
    expect(health).toEqual({ ok: false, models: [], error: 'http 503' });
  });

  it('maps a 200 with a non-JSON body to the generic token, never an excerpt', async () => {
    const { server } = startReceiver('<html><body>token hunter2</body></html>');
    const port = await listen(server);

    const provider = createOllamaProvider({
      endpoint: `http://ollama.invalid:${port}`,
      model: 'm',
      resolver: vetting('127.0.0.1'),
    });

    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.error).toBe('invalid response');
    expect(JSON.stringify(health)).not.toContain('hunter2');
  });

  /**
   * The refusal has to happen before the socket, not after: a receiver that is
   * never contacted is the only proof the guard ran first.
   */
  it('never opens a socket when the guard refuses the resolved address', async () => {
    const { server, seen } = startReceiver(JSON.stringify({ models: [] }));
    const port = await listen(server);

    const provider = createOllamaProvider({
      endpoint: `http://ollama.invalid:${port}`,
      model: 'm',
      // The name now answers with a public address — the rebinding case.
      resolver: vetting('93.184.216.34'),
    });

    const health = await provider.health();
    expect(health).toEqual({ ok: false, models: [], error: 'endpoint not local' });
    expect(seen).toHaveLength(0);
  });

  it('refuses rather than following a redirect off the vetted host', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://93.184.216.34/api/tags' });
      res.end();
    });
    const port = await listen(server);

    const provider = createOllamaProvider({
      endpoint: `http://ollama.invalid:${port}`,
      model: 'm',
      resolver: vetting('127.0.0.1'),
    });

    // `node:http` does not follow redirects at all, so a 3xx is simply a
    // non-2xx — the pivot is closed by construction rather than by a flag.
    expect(await provider.health()).toEqual({ ok: false, models: [], error: 'http 302' });
  });

  it('gives up on a silent endpoint rather than hanging', async () => {
    const server = createServer(() => {
      /* accept the socket and never answer */
    });
    const port = await listen(server);

    const provider = createOllamaProvider({
      endpoint: `http://ollama.invalid:${port}`,
      model: 'm',
      resolver: vetting('127.0.0.1'),
    });

    expect(await provider.health({ timeoutMs: 150 })).toEqual({
      ok: false,
      models: [],
      error: 'timeout',
    });
  });
});
