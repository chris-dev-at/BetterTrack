import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export const OUTBOUND_URL_BLOCKED = 'OUTBOUND_URL_BLOCKED';

export type OutboundUrlBlockReason =
  | 'invalid_url'
  | 'invalid_protocol'
  | 'localhost'
  | 'blocked_address'
  | 'invalid_resolved_address';

export interface OutboundUrlAddress {
  address: string;
  /** Resolver metadata only; the guard derives the trusted family from `address`. */
  family: number;
}

export type OutboundUrlResolver = (hostname: string) => Promise<readonly OutboundUrlAddress[]>;

export interface OutboundUrlGuardOptions {
  /**
   * Resolve hostnames immediately before egress and validate every returned
   * address. Keep this enabled for outbound requests; registration-only checks
   * may disable it and rely on a second send-time guard.
   */
  resolveDns?: boolean;
  /** Test seam, and a future seam for callers with a pinned DNS resolver. */
  resolver?: OutboundUrlResolver;
}

export class UnsafeOutboundUrlError extends Error {
  readonly code = OUTBOUND_URL_BLOCKED;

  constructor(readonly reason: OutboundUrlBlockReason) {
    super('Outbound URL must target a public HTTPS destination.');
    this.name = 'UnsafeOutboundUrlError';
  }
}

// Keep the families in separate lists: Node intentionally treats IPv4 input as
// IPv4-mapped IPv6 when a list contains mapped-v6 rules. A combined list would
// therefore make the explicit `::ffff:0:0/96` rule block every public IPv4
// address too.
const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

// IPv4 addresses that are local, private, link-local, non-routable, multicast,
// or reserved. Server-side outbound traffic has no legitimate reason to target
// any of them.
const BLOCKED_IPV4_SUBNETS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

const BLOCKED_IPV6_SUBNETS = [
  ['::', 96], // unspecified + deprecated IPv4-compatible addresses
  ['::1', 128],
  ['::ffff:0:0', 96], // IPv4-mapped IPv6, including mapped private IPv4
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation-only
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const;

for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) {
  blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6');
}

const defaultResolver: OutboundUrlResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function normalizedHostname(hostname: string): string {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return unbracketed.toLowerCase().replace(/\.+$/, '');
}

function isLocalhostName(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'localhost.localdomain' ||
    hostname.endsWith('.localhost.localdomain')
  );
}

function assertPublicAddress(address: string, invalidReason: OutboundUrlBlockReason): void {
  const family = isIP(address);
  if (family === 0) throw new UnsafeOutboundUrlError(invalidReason);
  const blocked =
    family === 4
      ? blockedIpv4Addresses.check(address, 'ipv4')
      : blockedIpv6Addresses.check(address, 'ipv6');
  if (blocked) {
    throw new UnsafeOutboundUrlError('blocked_address');
  }
}

/**
 * Validate an HTTPS destination before server-side egress.
 *
 * The literal/localhost check is always performed. DNS resolution defaults on,
 * and every returned A/AAAA address must be public; callers that persist a URL
 * may disable DNS only when they repeat the full guard immediately before use.
 */
export async function assertSafeOutboundUrl(
  input: string,
  options: OutboundUrlGuardOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeOutboundUrlError('invalid_url');
  }

  if (url.protocol !== 'https:') {
    throw new UnsafeOutboundUrlError('invalid_protocol');
  }

  const hostname = normalizedHostname(url.hostname);
  if (!hostname) throw new UnsafeOutboundUrlError('invalid_url');
  if (isLocalhostName(hostname)) throw new UnsafeOutboundUrlError('localhost');

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    assertPublicAddress(hostname, 'blocked_address');
    return url;
  }

  if (options.resolveDns === false) return url;

  const addresses = await (options.resolver ?? defaultResolver)(hostname);
  if (addresses.length === 0) {
    throw new Error('Outbound URL hostname resolved to no addresses.');
  }
  for (const { address } of addresses) {
    assertPublicAddress(address, 'invalid_resolved_address');
  }
  return url;
}
