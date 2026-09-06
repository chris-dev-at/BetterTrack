import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

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

export interface ResolvedOutboundUrl {
  url: URL;
  /** Public addresses vetted by the guard; family is derived from the address. */
  addresses: readonly OutboundUrlAddress[];
}

export interface OutboundUrlGuardOptions {
  /**
   * Resolve hostnames immediately before egress and validate every returned
   * address. Keep this enabled for outbound requests; registration-only checks
   * may disable it and rely on a second send-time guard.
   */
  resolveDns?: boolean;
  /** Test seam, and a future seam for callers with a pinned DNS resolver. */
  resolver?: OutboundUrlResolver;
  /**
   * Accept a plain `http:` destination. OFF by default — only a caller whose
   * product contract explicitly allows cleartext (outbound webhooks, §13.5
   * V5-P10) may turn it on.
   */
  allowHttp?: boolean;
  /**
   * Accept private LAN destinations — RFC1918 (`10/8`, `172.16/12`,
   * `192.168/16`) and its IPv6 equivalent, unique-local `fc00::/7`. OFF by
   * default. Loopback, link-local/cloud-metadata (`169.254/16`, `fe80::/10`),
   * unspecified, broadcast, CGNAT, multicast, reserved and the v4-in-v6
   * transition ranges stay blocked either way.
   *
   * What this DOES open is the private network the deployment itself sits on —
   * in the shipped compose topology RFC1918 *is* the internal service bridge
   * (`db`, `redis`, `prometheus`, `grafana`, the exporters), which publishes no
   * host ports precisely so it is unreachable. That is why the deployment's own
   * service network is carved back out and refused under EVERY policy; see
   * {@link deploymentNetworkSubnets}. The guarantee is therefore: an allowed LAN
   * destination is a host on the operator's network that is NOT part of this
   * deployment.
   */
  allowPrivateLan?: boolean;
}

/**
 * The egress policy for user-supplied **webhook receivers** (§13.5 V5-P10).
 *
 * A self-hosted LAN receiver over plain `http` is a first-class use case the
 * owner recorded in the contract (`packages/contracts/src/webhooks.ts`), so the
 * blanket "public HTTPS only" policy would revert a real decision. This relaxes
 * exactly those two axes and nothing else: loopback, link-local/metadata,
 * unspecified/broadcast, every other non-routable range AND the deployment's own
 * service network ({@link deploymentNetworkSubnets}) stay refused, which is what
 * closes the blind-SSRF/port-scan surface.
 */
export const WEBHOOK_RECEIVER_URL_POLICY: Readonly<
  Pick<OutboundUrlGuardOptions, 'allowHttp' | 'allowPrivateLan'>
> = Object.freeze({ allowHttp: true, allowPrivateLan: true });

export class UnsafeOutboundUrlError extends Error {
  readonly code = OUTBOUND_URL_BLOCKED;

  constructor(readonly reason: OutboundUrlBlockReason) {
    super('Outbound URL must target an allowed public destination.');
    this.name = 'UnsafeOutboundUrlError';
  }
}

/**
 * True when the URL was refused **by policy** (bad scheme, localhost, a blocked
 * address) rather than merely being unresolvable right now. Callers that persist
 * a URL use this to separate a permanent refusal — never retry, never send —
 * from a transient DNS condition they may treat like any network failure.
 */
export function isOutboundPolicyRefusal(err: unknown): err is UnsafeOutboundUrlError {
  return err instanceof UnsafeOutboundUrlError && err.reason !== 'invalid_resolved_address';
}

/**
 * The subnets the LAN policy ({@link OutboundUrlGuardOptions.allowPrivateLan})
 * drops from the block lists — and ONLY these. Everything else stays blocked,
 * including the v4-in-v6 spellings (`::ffff:0:0/96`, `64:ff9b::/96`,
 * `2002::/16`): a LAN receiver is addressed as `http://192.168.1.50:9000`, so
 * refusing the exotic encodings costs nothing and keeps `::ffff:127.0.0.1` out.
 */
const LAN_ALLOWED_IPV4_SUBNETS: ReadonlySet<string> = new Set([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
]);
const LAN_ALLOWED_IPV6_SUBNETS: ReadonlySet<string> = new Set(['fc00::/7']);

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
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
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
  ['64:ff9b::', 96], // NAT64 can encode private IPv4 destinations
  ['2001:db8::', 32], // documentation-only
  ['2002::', 16], // 6to4 can encode private IPv4 destinations
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const;

// Keep the families in separate lists: Node intentionally treats IPv4 input as
// IPv4-mapped IPv6 when a list contains mapped-v6 rules. A combined list would
// therefore make the explicit `::ffff:0:0/96` rule block every public IPv4
// address too. Each family gets a strict list and a LAN-policy list, the latter
// built from the same subnets minus `LAN_ALLOWED_*`.
function buildBlockList(
  subnets: readonly (readonly [string, number])[],
  family: 'ipv4' | 'ipv6',
  allowed: ReadonlySet<string>,
): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) {
    if (allowed.has(`${network}/${prefix}`)) continue;
    list.addSubnet(network, prefix, family);
  }
  return list;
}

const NOTHING_ALLOWED: ReadonlySet<string> = new Set();

/**
 * The env var that names the deployment's own service network(s): a
 * comma-separated CIDR list (`172.18.0.0/16,fd00:beef::/64`), or the literal
 * `none` to declare that this deployment has none.
 *
 * UNSET is the normal case — the ranges are then DERIVED from the container's
 * own non-loopback private interfaces
 * ({@link deploymentSubnetsFromInterfaces}), which is exactly the bridge the
 * compose stack puts `api`/`worker` and every internal service on. Set it only
 * when the derivation is wrong for a topology (host networking, an overlay the
 * API is not attached to, a bare-metal box whose LAN really is the operator's
 * home network and must stay reachable).
 *
 * It is a first-class deployment variable (#982): declared in the env schema,
 * forwarded to BOTH processes by the one Compose API/worker anchor, and
 * documented in `infra/.env.production.example` — so setting it in `.env` really
 * does reach the guard. The schema also rejects a malformed value at boot; the
 * in-process fallback below stays as the last resort for any path that reaches
 * the guard without going through `loadConfig`.
 */
export const DEPLOYMENT_SUBNETS_ENV = 'BT_OUTBOUND_DEPLOYMENT_SUBNETS';

/** One CIDR rule: any address inside the range plus the prefix that defines it. */
export interface OutboundSubnetRule {
  /** An address inside the range — the prefix decides the range, so a host address is fine. */
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

function subnetRule(address: string, prefixText: string | undefined): OutboundSubnetRule | null {
  const family = isIP(address);
  if (family === 0 || prefixText === undefined || !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}

/** The non-empty entries of a {@link DEPLOYMENT_SUBNETS_ENV} value. */
function deploymentSubnetTokens(raw: string): string[] {
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

/**
 * Parse a {@link DEPLOYMENT_SUBNETS_ENV} value, or `null` when ANY entry is
 * unparseable.
 *
 * All-or-nothing on purpose: dropping the entry a typo produced would silently
 * widen the allowance, which is the failure mode this whole carve-out exists to
 * prevent. The caller falls back to the derived answer instead, and
 * `BT_OUTBOUND_DEPLOYMENT_SUBNETS` is refused by the env schema at boot so the
 * typo is loud rather than merely survivable.
 *
 * `none` is only meaningful as the WHOLE value: `172.18.0.0/16, none` cannot be
 * both a carve-out and no carve-out, so it reads as a mistake and is refused
 * with everything else. An empty list (`,`) is refused for the same reason —
 * "this deployment has no internal network" has exactly one spelling.
 */
export function parseDeploymentSubnets(raw: string): OutboundSubnetRule[] | null {
  const tokens = deploymentSubnetTokens(raw);
  if (tokens.length === 0) return null;
  if (tokens.some((token) => token.toLowerCase() === 'none')) {
    return tokens.length === 1 ? [] : null;
  }
  const rules: OutboundSubnetRule[] = [];
  for (const token of tokens) {
    const slash = token.lastIndexOf('/');
    const rule = slash < 0 ? null : subnetRule(token.slice(0, slash), token.slice(slash + 1));
    if (!rule) return null;
    rules.push(rule);
  }
  return rules;
}

const lanAllowedIpv4Addresses = buildAllowedList(LAN_ALLOWED_IPV4_SUBNETS, 'ipv4');
const lanAllowedIpv6Addresses = buildAllowedList(LAN_ALLOWED_IPV6_SUBNETS, 'ipv6');

function buildAllowedList(subnets: ReadonlySet<string>, family: 'ipv4' | 'ipv6'): BlockList {
  const list = new BlockList();
  for (const entry of subnets) {
    const [network = '', prefix] = entry.split('/');
    list.addSubnet(network, Number(prefix), family);
  }
  return list;
}

function isPrivateLanAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return lanAllowedIpv4Addresses.check(address, 'ipv4');
  if (family === 6) return lanAllowedIpv6Addresses.check(address, 'ipv6');
  return false;
}

/**
 * Derive the deployment's own service network from the process's own
 * interfaces: every non-internal interface whose address is itself a private
 * LAN address contributes its own subnet.
 *
 * That is the carve-out's whole point — the api/worker container is ON the
 * bridge it must never dial, so its own interface describes that bridge exactly,
 * whatever pool Docker picked. Public interface addresses are deliberately NOT
 * derived: a hosted box's public /24 is the internet, not this deployment.
 *
 * The derived prefix is the INTERFACE's prefix, so it is only as tight as the
 * topology: an api address of `10.1.2.3/8` (host networking on a flat corporate
 * or home LAN) derives `10.0.0.0/8` and refuses every 10/8 receiver, and
 * `172.x/12` likewise. That fails closed, which is the right direction, and the
 * remedy is naming the real service network in {@link DEPLOYMENT_SUBNETS_ENV}.
 */
export function deploymentSubnetsFromInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): OutboundSubnetRule[] {
  const rules: OutboundSubnetRule[] = [];
  const seen = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || !entry.cidr || !isPrivateLanAddress(entry.address)) continue;
      const rule = subnetRule(entry.address, entry.cidr.split('/')[1]);
      if (!rule || seen.has(entry.cidr)) continue;
      seen.add(entry.cidr);
      rules.push(rule);
    }
  }
  return rules;
}

interface DeploymentNetwork {
  rules: readonly OutboundSubnetRule[];
  ipv4: BlockList;
  ipv6: BlockList;
}

/** Sentinel cache key for "no env override — the derived answer". */
const DERIVED_KEY = null;
/**
 * Memoised carve-out, keyed on the env value so a changed override rebuilds it.
 *
 * Under {@link DERIVED_KEY} the memo also freezes `networkInterfaces()` at the
 * first call: an interface attached AFTER boot (`docker network connect`) is not
 * part of the carve-out until the process restarts. Deliberate — the guard runs
 * on every delivery attempt and re-reading the interface table there is the
 * wrong cost — but it does mean a topology change needs a restart, like every
 * other value in the deployment contract.
 */
let deploymentCache: { key: string | null; network: DeploymentNetwork } | null = null;

function deploymentNetwork(): DeploymentNetwork {
  // An EMPTY value counts as unset, not as "no deployment network": compose
  // materializes an unset `${VAR:-}` into an empty string, and that must not
  // silently drop the carve-out. Opting out is the explicit literal `none`.
  const raw = process.env[DEPLOYMENT_SUBNETS_ENV]?.trim();
  const key = raw === undefined || raw === '' ? DERIVED_KEY : raw;
  if (deploymentCache?.key === key) return deploymentCache.network;
  // A malformed value falls back to the derived answer, never to "no carve-out".
  const rules =
    (key === DERIVED_KEY ? null : parseDeploymentSubnets(key)) ?? deploymentSubnetsFromInterfaces();
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const rule of rules) {
    (rule.family === 'ipv4' ? ipv4 : ipv6).addSubnet(rule.address, rule.prefix, rule.family);
  }
  const network: DeploymentNetwork = { rules, ipv4, ipv6 };
  deploymentCache = { key, network };
  return network;
}

/**
 * The deployment's own service network as the guard currently sees it — the env
 * override if set, the derived interface subnets otherwise. Exposed so the
 * carve-out can be pinned by a test (and read by diagnostics) instead of living
 * only inside a doc comment that can drift away from the code.
 */
export function deploymentNetworkSubnets(): readonly OutboundSubnetRule[] {
  return deploymentNetwork().rules;
}

function isDeploymentAddress(address: string, family: number): boolean {
  const network = deploymentNetwork();
  return family === 4 ? network.ipv4.check(address, 'ipv4') : network.ipv6.check(address, 'ipv6');
}

const blockedIpv4Addresses = buildBlockList(BLOCKED_IPV4_SUBNETS, 'ipv4', NOTHING_ALLOWED);
const blockedIpv6Addresses = buildBlockList(BLOCKED_IPV6_SUBNETS, 'ipv6', NOTHING_ALLOWED);
const lanBlockedIpv4Addresses = buildBlockList(
  BLOCKED_IPV4_SUBNETS,
  'ipv4',
  LAN_ALLOWED_IPV4_SUBNETS,
);
const lanBlockedIpv6Addresses = buildBlockList(
  BLOCKED_IPV6_SUBNETS,
  'ipv6',
  LAN_ALLOWED_IPV6_SUBNETS,
);

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

function assertPublicAddress(
  address: string,
  invalidReason: OutboundUrlBlockReason,
  allowPrivateLan: boolean,
): OutboundUrlAddress {
  const family = isIP(address);
  if (family === 0) throw new UnsafeOutboundUrlError(invalidReason);
  const [ipv4List, ipv6List] = allowPrivateLan
    ? [lanBlockedIpv4Addresses, lanBlockedIpv6Addresses]
    : [blockedIpv4Addresses, blockedIpv6Addresses];
  const blocked = family === 4 ? ipv4List.check(address, 'ipv4') : ipv6List.check(address, 'ipv6');
  // The deployment's own service network is refused under EVERY policy, not only
  // the strict one: it is the range `allowPrivateLan` would otherwise un-block,
  // and it is the one range where "the user picked the destination" means
  // "a registered user picked one of our internal services".
  if (blocked || isDeploymentAddress(address, family)) {
    throw new UnsafeOutboundUrlError('blocked_address');
  }
  return { address, family };
}

async function inspectOutboundUrl(
  input: string,
  options: OutboundUrlGuardOptions = {},
): Promise<ResolvedOutboundUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeOutboundUrlError('invalid_url');
  }

  const allowPrivateLan = options.allowPrivateLan === true;
  const protocolAllowed =
    url.protocol === 'https:' || (options.allowHttp === true && url.protocol === 'http:');
  if (!protocolAllowed) {
    throw new UnsafeOutboundUrlError('invalid_protocol');
  }

  const hostname = normalizedHostname(url.hostname);
  if (!hostname) throw new UnsafeOutboundUrlError('invalid_url');
  if (isLocalhostName(hostname)) throw new UnsafeOutboundUrlError('localhost');

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    return {
      url,
      addresses: [assertPublicAddress(hostname, 'blocked_address', allowPrivateLan)],
    };
  }

  if (options.resolveDns === false) return { url, addresses: [] };

  const addresses = await (options.resolver ?? defaultResolver)(hostname);
  if (addresses.length === 0) {
    throw new UnsafeOutboundUrlError('invalid_resolved_address');
  }
  return {
    url,
    addresses: addresses.map(({ address }) =>
      assertPublicAddress(address, 'invalid_resolved_address', allowPrivateLan),
    ),
  };
}

/**
 * Resolve and validate a destination immediately before egress. HTTPS-only and
 * public-only unless the caller's policy relaxes those axes (see
 * {@link WEBHOOK_RECEIVER_URL_POLICY}); DNS always runs, so the result always
 * carries the vetted address set for a literal or a hostname alike.
 *
 * Callers must pin `addresses` into the actual connection — with
 * {@link createPinnedAgent} — so a second DNS lookup cannot replace the vetted
 * result.
 */
export function resolveSafeOutboundUrl(
  input: string,
  options: Pick<OutboundUrlGuardOptions, 'resolver' | 'allowHttp' | 'allowPrivateLan'> = {},
): Promise<ResolvedOutboundUrl> {
  return inspectOutboundUrl(input, options);
}

/**
 * The socket lookup that can only ever answer with the already-vetted address
 * set, and only for the hostname that was vetted. This is what closes the
 * DNS-rebinding window between the guard's resolution and the connect: the
 * system resolver is never consulted a second time.
 */
function createPinnedLookup(target: ResolvedOutboundUrl): LookupFunction {
  const expectedHostname = normalizedHostname(target.url.hostname);
  const pinnedAddresses = [...target.addresses];

  return (hostname, options, callback) => {
    if (normalizedHostname(hostname) !== expectedHostname) {
      callback(new UnsafeOutboundUrlError('invalid_resolved_address'), '', 0);
      return;
    }

    const requestedFamily =
      options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? pinnedAddresses.filter(({ family }) => family === requestedFamily)
        : pinnedAddresses;
    if (candidates.length === 0) {
      callback(new UnsafeOutboundUrlError('invalid_resolved_address'), '', 0);
      return;
    }

    if (options.all) {
      callback(null, candidates);
      return;
    }
    callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}

/**
 * Build a one-destination HTTPS agent whose socket lookup can return only the
 * already-vetted address set. The request keeps its original hostname, so Node
 * still verifies the certificate and sends SNI for that hostname.
 */
export function createPinnedHttpsAgent(target: ResolvedOutboundUrl): HttpsAgent {
  return new HttpsAgent({ keepAlive: false, lookup: createPinnedLookup(target) });
}

/**
 * Scheme-aware sibling of {@link createPinnedHttpsAgent}: the same pin, but for
 * callers whose policy also permits plain `http:` (webhook receivers, see
 * {@link WEBHOOK_RECEIVER_URL_POLICY}). The returned agent belongs to the
 * target's own protocol, so it must be handed to a request of that protocol —
 * Node refuses an `http.Agent` on an HTTPS request and vice versa.
 *
 * The caller owns the agent's lifetime and should `destroy()` it once the
 * request settles; it is deliberately single-use (`keepAlive: false`) so a
 * pooled socket can never outlive the resolution that vetted it.
 */
export function createPinnedAgent(target: ResolvedOutboundUrl): HttpAgent | HttpsAgent {
  if (target.url.protocol === 'http:') {
    return new HttpAgent({ keepAlive: false, lookup: createPinnedLookup(target) });
  }
  return createPinnedHttpsAgent(target);
}

/**
 * Validate a destination before server-side egress. HTTPS-only and
 * public-only by default; {@link OutboundUrlGuardOptions.allowHttp} and
 * {@link OutboundUrlGuardOptions.allowPrivateLan} relax exactly those two axes
 * for callers whose product contract requires it (see
 * {@link WEBHOOK_RECEIVER_URL_POLICY}).
 *
 * The literal/localhost check is always performed. DNS resolution defaults on,
 * and every returned A/AAAA address must pass the policy; callers that persist a
 * URL may disable DNS only when they repeat the full guard immediately before
 * use.
 */
export async function assertSafeOutboundUrl(
  input: string,
  options: OutboundUrlGuardOptions = {},
): Promise<URL> {
  return (await inspectOutboundUrl(input, options)).url;
}
