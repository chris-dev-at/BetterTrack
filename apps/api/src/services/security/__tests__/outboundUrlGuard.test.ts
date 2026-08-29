import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  OUTBOUND_URL_BLOCKED,
  UnsafeOutboundUrlError,
  WEBHOOK_RECEIVER_URL_POLICY,
  assertSafeOutboundUrl,
  isOutboundPolicyRefusal,
  type OutboundUrlResolver,
} from '../outboundUrlGuard';

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
