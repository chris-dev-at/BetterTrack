import { readFileSync } from 'node:fs';
import { Agent as HttpAgent, createServer as createHttpServer, request } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEPLOYMENT_SUBNETS_ENV,
  OUTBOUND_URL_BLOCKED,
  UnsafeOutboundUrlError,
  WEBHOOK_RECEIVER_URL_POLICY,
  assertSafeOutboundUrl,
  createPinnedAgent,
  deploymentNetworkSubnets,
  deploymentSubnetsFromInterfaces,
  parseDeploymentSubnets,
  isOutboundPolicyRefusal,
  resolveSafeOutboundUrl,
  type OutboundUrlResolver,
  type ResolvedOutboundUrl,
} from '../outboundUrlGuard';

/**
 * Every LAN assertion in this file would otherwise depend on the machine it runs
 * on: with the variable unset the deployment carve-out is DERIVED from the
 * host's own private interfaces, so a laptop on `192.168.1.0/24` would refuse
 * the LAN receiver the next describe insists on. Declaring the deployment
 * network makes the split explicit — `172.18/16` is ours, everything else is the
 * operator's.
 */
const DEPLOYMENT_SUBNET = '172.18.0.0/16';
const previousDeploymentSubnets = process.env[DEPLOYMENT_SUBNETS_ENV];

beforeAll(() => {
  process.env[DEPLOYMENT_SUBNETS_ENV] = DEPLOYMENT_SUBNET;
});

afterAll(() => {
  if (previousDeploymentSubnets === undefined) delete process.env[DEPLOYMENT_SUBNETS_ENV];
  else process.env[DEPLOYMENT_SUBNETS_ENV] = previousDeploymentSubnets;
});

const BLOCKED_LITERALS = [
  ['IPv4 loopback', 'https://127.0.0.1/push'],
  ['IPv4 private 10/8', 'https://10.20.30.40/push'],
  ['IPv4 private 172.16/12', 'https://172.31.255.254/push'],
  ['IPv4 private 192.168/16', 'https://192.168.1.2/push'],
  ['IPv4 link-local', 'https://169.254.169.254/push'],
  ['IPv4 6to4 relay anycast', 'https://192.88.99.1/push'],
  ['IPv4 multicast', 'https://239.1.2.3/push'],
  ['IPv6 loopback', 'https://[::1]/push'],
  ['IPv6 NAT64 transition range', 'https://[64:ff9b::a00:1]/push'],
  ['IPv6 6to4 transition range', 'https://[2002:a00:1::]/push'],
  ['IPv6 unique-local fc00::/7', 'https://[fc00::1]/push'],
  ['IPv6 unique-local fd00::/8', 'https://[fd12:3456::1]/push'],
  ['IPv6 link-local', 'https://[fe80::1]/push'],
  ['IPv6 multicast', 'https://[ff02::1]/push'],
  ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/push'],
] as const;

describe('outbound URL guard', () => {
  it.each(BLOCKED_LITERALS)('blocks a %s literal', async (_label, endpoint) => {
    const error = await assertSafeOutboundUrl(endpoint, { resolveDns: false }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UnsafeOutboundUrlError);
    expect(error).toMatchObject({ code: OUTBOUND_URL_BLOCKED });
  });

  it.each([
    ['plain HTTP', 'http://push.example.com/subscription'],
    ['non-HTTP scheme', 'ftp://push.example.com/subscription'],
    ['localhost', 'https://localhost/subscription'],
    ['localhost subdomain', 'https://push.localhost/subscription'],
    ['localhost with trailing dot', 'https://localhost./subscription'],
    ['localhost.localdomain', 'https://localhost.localdomain/subscription'],
  ])('blocks %s destinations', async (_label, endpoint) => {
    await expect(assertSafeOutboundUrl(endpoint, { resolveDns: false })).rejects.toMatchObject({
      code: OUTBOUND_URL_BLOCKED,
    });
  });

  it('checks every resolved address and blocks a hostname resolving to private space', async () => {
    const resolver: OutboundUrlResolver = vi.fn(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]);

    await expect(
      assertSafeOutboundUrl('https://push.example.com/subscription', { resolver }),
    ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED, reason: 'blocked_address' });
    expect(resolver).toHaveBeenCalledWith('push.example.com');
  });

  it('blocks a hostname resolving to IPv4-mapped IPv6 space', async () => {
    const resolver: OutboundUrlResolver = async () => [
      { address: '::ffff:192.168.1.20', family: 6 },
    ];

    await expect(
      assertSafeOutboundUrl('https://push.example.com/subscription', { resolver }),
    ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED });
  });

  it('classifies an empty DNS answer as a permanent unsafe destination', async () => {
    const resolver: OutboundUrlResolver = async () => [];

    await expect(
      assertSafeOutboundUrl('https://push.example.com/subscription', { resolver }),
    ).rejects.toMatchObject({
      code: OUTBOUND_URL_BLOCKED,
      reason: 'invalid_resolved_address',
    });
  });

  it('allows legitimate public HTTPS literals and fully-public DNS answers', async () => {
    await expect(
      assertSafeOutboundUrl('https://8.8.8.8/subscription', { resolveDns: false }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeOutboundUrl('https://[2606:4700:4700::1111]/subscription', {
        resolveDns: false,
      }),
    ).resolves.toBeInstanceOf(URL);

    const resolver: OutboundUrlResolver = async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    await expect(
      assertSafeOutboundUrl('https://push.example.com/subscription', { resolver }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('can defer DNS only for persistence-time validation', async () => {
    const resolver: OutboundUrlResolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);

    await expect(
      assertSafeOutboundUrl('https://push.example.com/subscription', {
        resolveDns: false,
        resolver,
      }),
    ).resolves.toBeInstanceOf(URL);
    expect(resolver).not.toHaveBeenCalled();
  });
});

/**
 * The relaxed policy for user-supplied webhook receivers (§13.5 V5-P10): plain
 * http and private LAN destinations are a first-class product case, everything
 * that could reach the deployment's own services is not.
 */
describe('outbound URL guard — webhook receiver policy', () => {
  const webhookPolicy = { ...WEBHOOK_RECEIVER_URL_POLICY, resolveDns: false } as const;

  it.each([
    ['plain-http LAN receiver', 'http://192.168.1.50:9000/hook'],
    ['https LAN receiver', 'https://10.20.30.40/hook'],
    ['RFC1918 172.16/12 receiver', 'http://172.31.255.254:8080/hook'],
    ['IPv6 unique-local receiver', 'http://[fd12:3456::1]/hook'],
    ['public host over plain http', 'http://receiver.example.com/hook'],
  ])('allows a %s', async (_label, url) => {
    await expect(assertSafeOutboundUrl(url, webhookPolicy)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ['IPv4 loopback', 'http://127.0.0.1:3000/api/health'],
    ['IPv4 loopback (alternate spelling)', 'http://127.1.2.3/api/health'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv4 unspecified', 'http://0.0.0.0:8080/hook'],
    ['IPv4 broadcast', 'http://255.255.255.255/hook'],
    ['CGNAT', 'http://100.64.0.1/hook'],
    ['IPv4 multicast', 'http://239.1.2.3/hook'],
    ['IPv6 loopback', 'http://[::1]:3000/hook'],
    ['IPv6 unspecified', 'http://[::]/hook'],
    ['IPv6 link-local', 'http://[fe80::1]/hook'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/hook'],
    ['IPv4-mapped LAN spelling', 'http://[::ffff:192.168.1.20]/hook'],
    ['NAT64-encoded loopback', 'http://[64:ff9b::7f00:1]/hook'],
    ['localhost', 'http://localhost:3000/hook'],
    ['localhost subdomain', 'http://receiver.localhost/hook'],
    ['non-http scheme', 'ftp://receiver.example.com/hook'],
  ])('still refuses %s', async (_label, url) => {
    await expect(assertSafeOutboundUrl(url, webhookPolicy)).rejects.toMatchObject({
      code: OUTBOUND_URL_BLOCKED,
    });
  });

  it('refuses a hostname that resolves to loopback, even under the LAN policy', async () => {
    const resolver: OutboundUrlResolver = async () => [{ address: '127.0.0.1', family: 4 }];

    const error = await assertSafeOutboundUrl('https://rebind.example.com/hook', {
      ...WEBHOOK_RECEIVER_URL_POLICY,
      resolver,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsafeOutboundUrlError);
    expect(isOutboundPolicyRefusal(error)).toBe(true);
  });

  it('accepts a hostname resolving to a LAN address under the LAN policy only', async () => {
    const resolver: OutboundUrlResolver = async () => [{ address: '192.168.1.50', family: 4 }];

    await expect(
      assertSafeOutboundUrl('http://nas.home.example/hook', {
        ...WEBHOOK_RECEIVER_URL_POLICY,
        resolver,
      }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeOutboundUrl('https://nas.home.example/hook', { resolver }),
    ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED, reason: 'blocked_address' });
  });

  it('separates a policy refusal from a merely unresolvable destination', async () => {
    const empty: OutboundUrlResolver = async () => [];
    const unresolvable = await assertSafeOutboundUrl('https://nowhere.example/hook', {
      ...WEBHOOK_RECEIVER_URL_POLICY,
      resolver: empty,
    }).catch((caught: unknown) => caught);

    expect(unresolvable).toBeInstanceOf(UnsafeOutboundUrlError);
    expect(isOutboundPolicyRefusal(unresolvable)).toBe(false);
    expect(isOutboundPolicyRefusal(new Error('ENOTFOUND'))).toBe(false);
  });
});

/**
 * The carve-out inside the LAN allowance: the private network THIS deployment's
 * own services sit on. In the shipped compose topology RFC1918 is not "the
 * user's home network" at all — it is the bridge `db`, `redis`, `prometheus`,
 * `grafana` and the exporters share, and they publish no host ports precisely so
 * nothing outside can reach them.
 *
 * These tests are also the pin that keeps the guard's doc comment honest: the
 * guarantee it now states ("an allowed LAN destination is a host that is NOT part
 * of this deployment") is asserted here, so comment and code cannot drift apart.
 */
describe('outbound URL guard — the deployment’s own service network', () => {
  const webhookPolicy = { ...WEBHOOK_RECEIVER_URL_POLICY, resolveDns: false } as const;

  it('exposes exactly the declared subnets', () => {
    expect(deploymentNetworkSubnets()).toEqual([
      { address: '172.18.0.0', prefix: 16, family: 'ipv4' },
    ]);
  });

  it.each([
    ['a service port on the deployment bridge', 'http://172.18.0.4:5432/hook'],
    ['the monitoring stack', 'http://172.18.9.9:9090/-/reload'],
    ['an https spelling of the same host', 'https://172.18.0.4/hook'],
  ])('refuses %s', async (_label, url) => {
    await expect(assertSafeOutboundUrl(url, webhookPolicy)).rejects.toMatchObject({
      code: OUTBOUND_URL_BLOCKED,
      reason: 'blocked_address',
    });
  });

  it('refuses a compose service NAME, which is how a receiver would really be written', async () => {
    // `http://prometheus:9090/-/reload` is a valid URL whose hostname Docker's
    // embedded DNS answers with a bridge address.
    const composeDns: OutboundUrlResolver = async () => [{ address: '172.18.0.7', family: 4 }];

    const error = await assertSafeOutboundUrl('http://prometheus:9090/-/reload', {
      ...WEBHOOK_RECEIVER_URL_POLICY,
      resolver: composeDns,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsafeOutboundUrlError);
    expect(isOutboundPolicyRefusal(error)).toBe(true);
  });

  it('refuses it for strict callers too, not only under the LAN policy', async () => {
    await expect(
      assertSafeOutboundUrl('https://172.18.0.4/hook', { resolveDns: false }),
    ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED });
  });

  it.each([
    ['192.168/16 receiver', 'http://192.168.1.50:9000/hook'],
    ['10/8 receiver', 'http://10.20.30.40/hook'],
    // Same /12 as the deployment bridge, different /16: the carve-out is the
    // deployment's subnet, NOT the RFC1918 block it happens to sit in.
    ['172.16/12 receiver outside the deployment /16', 'http://172.31.255.254:8080/hook'],
    ['IPv6 unique-local receiver', 'http://[fd12:3456::1]/hook'],
  ])('still allows a genuine LAN %s', async (_label, url) => {
    await expect(assertSafeOutboundUrl(url, webhookPolicy)).resolves.toBeInstanceOf(URL);
  });

  it('carves out an IPv6 deployment network the same way', async () => {
    process.env[DEPLOYMENT_SUBNETS_ENV] = `${DEPLOYMENT_SUBNET}, fd00:beef::/64`;
    try {
      await expect(
        assertSafeOutboundUrl('http://[fd00:beef::5]:9090/hook', webhookPolicy),
      ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED });
      await expect(
        assertSafeOutboundUrl('http://[fd12:3456::1]/hook', webhookPolicy),
      ).resolves.toBeInstanceOf(URL);
    } finally {
      process.env[DEPLOYMENT_SUBNETS_ENV] = DEPLOYMENT_SUBNET;
    }
  });

  it('lets a deployment with no internal network say so explicitly', async () => {
    process.env[DEPLOYMENT_SUBNETS_ENV] = 'none';
    try {
      expect(deploymentNetworkSubnets()).toEqual([]);
      await expect(
        assertSafeOutboundUrl('http://172.18.0.4:5432/hook', webhookPolicy),
      ).resolves.toBeInstanceOf(URL);
    } finally {
      process.env[DEPLOYMENT_SUBNETS_ENV] = DEPLOYMENT_SUBNET;
    }
  });

  it('treats an EMPTY value as unset, not as "no internal network"', () => {
    // compose materializes an unset `${VAR:-}` into an empty string; that must
    // fall back to the derived answer instead of dropping the carve-out.
    process.env[DEPLOYMENT_SUBNETS_ENV] = '';
    try {
      expect(deploymentNetworkSubnets()).toEqual(deploymentSubnetsFromInterfaces());
    } finally {
      process.env[DEPLOYMENT_SUBNETS_ENV] = DEPLOYMENT_SUBNET;
    }
  });

  it('derives the network from the container’s own private interfaces', () => {
    // What `os.networkInterfaces()` looks like inside the api container on the
    // compose bridge: loopback, the bridge address, and (on a host-network
    // deployment) a public address that is the internet, not this deployment.
    const derived = deploymentSubnetsFromInterfaces({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
      eth0: [
        {
          address: '172.18.0.5',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '02:42:ac:12:00:05',
          internal: false,
          cidr: '172.18.0.5/16',
        },
        {
          address: '203.0.113.10',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '02:42:ac:12:00:05',
          internal: false,
          cidr: '203.0.113.10/24',
        },
      ],
    });

    expect(derived).toEqual([{ address: '172.18.0.5', prefix: 16, family: 'ipv4' }]);
  });

  it('parses a subnet list all-or-nothing', () => {
    expect(parseDeploymentSubnets('172.18.0.0/16, fd00:beef::/64')).toEqual([
      { address: '172.18.0.0', prefix: 16, family: 'ipv4' },
      { address: 'fd00:beef::', prefix: 64, family: 'ipv6' },
    ]);
    expect(parseDeploymentSubnets('none')).toEqual([]);
    // A typo must not merely drop that one entry: a dropped entry is a silently
    // widened allowance, so the whole value is refused.
    expect(parseDeploymentSubnets('172.18.0.0')).toBeNull();
    expect(parseDeploymentSubnets('172.18.0.0/16, not-a-cidr/16')).toBeNull();
    expect(parseDeploymentSubnets('172.18.0.0/64')).toBeNull();
  });

  it('falls back to the derived network when the value is malformed', () => {
    process.env[DEPLOYMENT_SUBNETS_ENV] = '172.18.0.0/16, oops';
    try {
      expect(deploymentNetworkSubnets()).toEqual(deploymentSubnetsFromInterfaces());
    } finally {
      process.env[DEPLOYMENT_SUBNETS_ENV] = DEPLOYMENT_SUBNET;
    }
  });
});

/**
 * Regression pin: the webhook policy is opt-in per call site. The three existing
 * guarded callers must keep the strict default (public HTTPS only) — a relaxed
 * flag leaking into any of them would re-open SSRF on paths that never allowed
 * user-supplied hosts.
 */
describe('outbound URL guard — strict callers stay strict', () => {
  it.each([
    ['webPush', '../../notifications/webPush.ts'],
    ['notificationService', '../../notifications/notificationService.ts'],
    ['oauthLogo', '../../oauth/oauthLogo.ts'],
  ])('%s passes no policy relaxation to the guard', (_label, relativePath) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');

    expect(source).toContain('outboundUrlGuard');
    expect(source).not.toMatch(/allowHttp|allowPrivateLan|WEBHOOK_RECEIVER_URL_POLICY/);
  });

  it('keeps the default policy blocking plain http and private LAN destinations', async () => {
    // The exact options notificationService passes for a stored push endpoint.
    await expect(
      assertSafeOutboundUrl('http://push.example.com/subscription', { resolveDns: false }),
    ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED, reason: 'invalid_protocol' });
    await expect(
      assertSafeOutboundUrl('https://192.168.1.50/subscription', { resolveDns: false }),
    ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED, reason: 'blocked_address' });
    await expect(
      assertSafeOutboundUrl('https://[fd12:3456::1]/subscription', { resolveDns: false }),
    ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED, reason: 'blocked_address' });
  });
});

/**
 * The pin (§8 outbound safety). A vetted answer is worth nothing if the socket
 * resolves the hostname again — that second lookup is exactly the DNS-rebinding
 * window. These tests run real connections: the guard-time answer points at one
 * address and a simulated connect-time resolver at another, and only the pinned
 * one may be reached. `127.0.0.1` stands in for the vetted public address and
 * `127.0.0.2` for the private one the rebind would swap in; both listeners share
 * a port so the address is the only thing that distinguishes them.
 */
describe('outbound URL guard — pinned agents close the rebinding window', () => {
  const VETTED = '127.0.0.1';
  const REBOUND = '127.0.0.2';

  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  function track(server: { close: (cb: () => void) => void }): void {
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }

  function listenOn(
    server: {
      listen: (port: number, host: string, cb: () => void) => void;
      address: () => unknown;
    },
    host: string,
    port = 0,
  ): Promise<number> {
    return new Promise<number>((resolve) => {
      server.listen(port, host, () => {
        const address = server.address();
        resolve(
          typeof address === 'object' && address !== null
            ? (address as { port: number }).port
            : port,
        );
      });
    });
  }

  /** Two HTTP listeners on the same port, one per address; each records its hits. */
  async function twoHttpReceivers(): Promise<{ port: number; hits: Record<string, number> }> {
    const hits: Record<string, number> = { [VETTED]: 0, [REBOUND]: 0 };
    const build = (host: string) => {
      const server = createHttpServer((req, res) => {
        hits[host] = (hits[host] ?? 0) + 1;
        req.resume();
        res.writeHead(204).end();
      });
      track(server);
      return server;
    };
    const port = await listenOn(build(VETTED), VETTED);
    await listenOn(build(REBOUND), REBOUND, port);
    return { port, hits };
  }

  /** Two bare TCP listeners on the same port: enough to observe where TLS dialled. */
  async function twoTcpReceivers(): Promise<{ port: number; hits: Record<string, number> }> {
    const hits: Record<string, number> = { [VETTED]: 0, [REBOUND]: 0 };
    const build = (host: string) => {
      const server: TcpServer = createTcpServer((socket) => {
        hits[host] = (hits[host] ?? 0) + 1;
        socket.destroy();
      });
      track(server);
      return server;
    };
    const port = await listenOn(build(VETTED), VETTED);
    await listenOn(build(REBOUND), REBOUND, port);
    return { port, hits };
  }

  function pinnedTarget(url: string, address = VETTED): ResolvedOutboundUrl {
    return { url: new URL(url), addresses: [{ address, family: 4 }] };
  }

  function postHttp(url: string, agent: HttpAgent): Promise<{ status: number | null }> {
    return new Promise((resolve) => {
      const req = request(url, { method: 'POST', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? null }));
      });
      req.on('error', () => resolve({ status: null }));
      req.end('{}');
    });
  }

  function postHttps(url: string, agent: HttpsAgent): Promise<{ status: number | null }> {
    return new Promise((resolve) => {
      const req = httpsRequest(url, { method: 'POST', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? null }));
      });
      req.on('error', () => resolve({ status: null }));
      req.end('{}');
    });
  }

  it('sends a plain-http request to the vetted address even though DNS now answers a private one', async () => {
    const { port, hits } = await twoHttpReceivers();
    const url = `http://receiver.rebind.test:${port}/hook`;

    // Control: an agent that resolves at connect time — what a bare `fetch`
    // does — lands on the rebound private address.
    const rebinding = new HttpAgent({
      keepAlive: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: REBOUND, family: 4 }]);
        else callback(null, REBOUND, 4);
      },
    });
    expect(await postHttp(url, rebinding)).toEqual({ status: 204 });
    expect(hits).toEqual({ [VETTED]: 0, [REBOUND]: 1 });
    rebinding.destroy();

    // Pinned: the same URL, the same hostname, but the guard's vetted address.
    const agent = createPinnedAgent(pinnedTarget(url));
    expect(agent).not.toBeInstanceOf(HttpsAgent);
    expect(await postHttp(url, agent)).toEqual({ status: 204 });
    agent.destroy();

    expect(hits).toEqual({ [VETTED]: 1, [REBOUND]: 1 });
  });

  it('dials only the vetted address for an https receiver', async () => {
    const { port, hits } = await twoTcpReceivers();
    const url = `https://receiver.rebind.test:${port}/hook`;

    const agent = createPinnedAgent(pinnedTarget(url));
    expect(agent).toBeInstanceOf(HttpsAgent);
    // A bare TCP listener never completes the handshake, so the request fails —
    // but which listener saw the connection is the whole point.
    expect(await postHttps(url, agent as HttpsAgent)).toEqual({ status: null });
    agent.destroy();

    expect(hits).toEqual({ [VETTED]: 1, [REBOUND]: 0 });
  });

  it('refuses to serve a hostname other than the one that was vetted', async () => {
    const { port, hits } = await twoHttpReceivers();
    const agent = createPinnedAgent(pinnedTarget(`http://receiver.rebind.test:${port}/hook`));

    expect(await postHttp(`http://other.rebind.test:${port}/hook`, agent)).toEqual({
      status: null,
    });
    agent.destroy();

    expect(hits).toEqual({ [VETTED]: 0, [REBOUND]: 0 });
  });

  it('has nothing to dial when the target carries no vetted address', async () => {
    const { port, hits } = await twoHttpReceivers();
    const url = `http://receiver.rebind.test:${port}/hook`;
    const agent = createPinnedAgent({ url: new URL(url), addresses: [] });

    expect(await postHttp(url, agent)).toEqual({ status: null });
    agent.destroy();

    expect(hits).toEqual({ [VETTED]: 0, [REBOUND]: 0 });
  });

  it('resolves the webhook policy once and hands back the addresses to pin', async () => {
    const resolver: OutboundUrlResolver = vi.fn(async () => [
      { address: '192.168.1.50', family: 4 },
    ]);

    const target = await resolveSafeOutboundUrl('http://nas.home.example/hook', {
      ...WEBHOOK_RECEIVER_URL_POLICY,
      resolver,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(target.url.href).toBe('http://nas.home.example/hook');
    expect(target.addresses).toEqual([{ address: '192.168.1.50', family: 4 }]);
    expect(createPinnedAgent(target)).not.toBeInstanceOf(HttpsAgent);
  });
});
