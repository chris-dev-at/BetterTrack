import { describe, expect, it, vi } from 'vitest';

import {
  OUTBOUND_URL_BLOCKED,
  UnsafeOutboundUrlError,
  assertSafeOutboundUrl,
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
