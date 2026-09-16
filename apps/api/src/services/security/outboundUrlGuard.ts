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
  | 'public_address'
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
  /**
   * Accept a loopback destination — `127.0.0.0/8` and `::1`, plus the
   * `localhost` family of names that would otherwise be refused before DNS even
   * runs. OFF by default and never combined with `allowPrivateLan` implicitly:
   * the two are different trust statements ("a host on the operator's LAN" vs
   * "a port on this very machine").
   *
   * Only a caller whose destination is by contract on the same host may set it.
   * Today that is the local-AI endpoint ({@link LOCAL_AI_ENDPOINT_URL_POLICY}),
   * because `http://localhost:11434` is the single most common way an Ollama is
   * addressed and §16 2026-07-22 puts the provider on the internal network by
   * definition. The cost is stated at that constant.
   *
   * The v4-in-v6 spellings stay blocked either way, so `::ffff:127.0.0.1` is
   * still refused — the allowance is the two canonical forms, nothing else.
   */
  allowLoopback?: boolean;
  /**
   * INVERT the default policy: refuse every destination that is not local.
   *
   * Without it the guard is a denylist — public is the norm and the private
   * ranges are carved out. With it the guard is an allowlist: an address must be
   * one of the ranges this policy's other axes opened (private LAN, loopback) or
   * it is refused as {@link OutboundUrlBlockReason.public_address}, whether it
   * arrived as a literal or out of DNS. That is the shape a destination which is
   * "internal network only, never publicly exposed" needs, and it is the axis
   * that makes {@link LOCAL_AI_ENDPOINT_URL_POLICY} an egress guard rather than
   * a relaxation.
   */
  requireLocal?: boolean;
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

/**
 * The egress policy for the admin-set **local-AI (Ollama) endpoint** (§13.5
 * V5-P12, §16 2026-07-22 — LOCAL AI ONLY: "every AI feature runs on the local
 * Ollama (internal network only, never publicly exposed)").
 *
 * This is the one policy that runs the guard as an ALLOWLIST
 * ({@link OutboundUrlGuardOptions.requireLocal}): the prompts this endpoint
 * receives carry portfolio facts, so a public destination is not a weaker
 * destination, it is an exfiltration channel. Everything the other policies
 * refuse stays refused — link-local/cloud-metadata (`169.254/16`, `fe80::/10`),
 * CGNAT, multicast, reserved, the v4-in-v6 spellings, the unspecified and
 * broadcast addresses, and the deployment's own service network
 * ({@link deploymentNetworkSubnets}) — and on top of that every PUBLIC address
 * is refused too. What remains is exactly: RFC1918 / unique-local, and loopback.
 *
 * ## Two costs, stated
 *
 * 1. `allowLoopback` lets an admin aim the endpoint (and the admin probes) at a
 *    port on the API host itself. That is not closable while
 *    `http://localhost:11434` remains the normal way to run Ollama, and the
 *    residual is bounded: the surface is admin-only, every write is audit-logged
 *    (§6.12), and the probe answers from a closed set of failure tokens rather
 *    than anything the target said.
 * 2. The deployment carve-out applies here as it does everywhere, so a
 *    deployment whose API shares the operator's flat LAN (host networking,
 *    bare metal) derives that LAN as "ours" and refuses an Ollama on it. That
 *    fails closed, which is the right direction, and the remedy is the existing
 *    deployment variable {@link DEPLOYMENT_SUBNETS_ENV} naming the real service
 *    network. The refusal is typed and surfaced to the admin, never silent.
 */
export const LOCAL_AI_ENDPOINT_URL_POLICY: Readonly<
  Pick<OutboundUrlGuardOptions, 'allowHttp' | 'allowPrivateLan' | 'allowLoopback' | 'requireLocal'>
> = Object.freeze({
  allowHttp: true,
  allowPrivateLan: true,
  allowLoopback: true,
  requireLocal: true,
});

export class UnsafeOutboundUrlError extends Error {
  readonly code = OUTBOUND_URL_BLOCKED;

  constructor(readonly reason: OutboundUrlBlockReason) {
    // Policy-neutral on purpose: the same error now covers a public destination
    // refused by a public-only policy AND a public destination refused by the
    // local-only one (`requireLocal`). The machine-readable `reason` is where a
    // caller reads which it was.
    super('Outbound URL must target a destination this policy allows.');
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

/**
 * The subnets {@link OutboundUrlGuardOptions.allowLoopback} drops from the block
 * lists — the two canonical loopback spellings and nothing else. `0.0.0.0/8`
 * (which routes to the local host on Linux) and the IPv4-mapped `::ffff:0:0/96`
 * form deliberately stay blocked: an endpoint is written `http://localhost` or
 * `http://127.0.0.1`, so refusing every other way of saying "this machine" costs
 * nothing and keeps `::ffff:127.0.0.1` out.
 */
const LOOPBACK_ALLOWED_IPV4_SUBNETS: ReadonlySet<string> = new Set(['127.0.0.0/8']);
const LOOPBACK_ALLOWED_IPV6_SUBNETS: ReadonlySet<string> = new Set(['::1/128']);

/**
 * `::1` sits INSIDE `::/96`, and a `BlockList` cannot punch a hole in a subnet.
 *
 * So a policy that allows IPv6 loopback drops that rule as a whole and re-adds
 * the two pieces that surround `::1`: the unspecified address `::` on its own,
 * and the rest of the range. Everything `::/96` refused is still refused — this
 * is a re-spelling, not a relaxation — and it matters in practice rather than on
 * paper: on a dual-stack host `localhost` resolves to `::1` FIRST, every
 * returned address must pass, so without this split `http://localhost:11434`
 * would be refused outright.
 */
const IPV6_LOOPBACK_BLOCKLIST_PATCH = {
  /** Rules replaced by {@link IPV6_LOOPBACK_BLOCKLIST_PATCH.addresses}/`ranges`. */
  skip: new Set(['::/96', '::1/128']),
  addresses: ['::'] as const,
  ranges: [['::2', '::ffff:ffff']] as const,
} as const;

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

/** Rules a policy adds back after dropping a subnet it had to replace whole. */
interface BlockListExtras {
  addresses?: readonly string[];
  ranges?: readonly (readonly [string, string])[];
}

// Keep the families in separate lists: Node intentionally treats IPv4 input as
// IPv4-mapped IPv6 when a list contains mapped-v6 rules. A combined list would
// therefore make the explicit `::ffff:0:0/96` rule block every public IPv4
// address too. Each family gets one list per (allowPrivateLan, allowLoopback)
// combination, built from the same subnets minus what that combination allows
// (see `blockListsByPolicy`).
function buildBlockList(
  subnets: readonly (readonly [string, number])[],
  family: 'ipv4' | 'ipv6',
  allowed: ReadonlySet<string>,
  extras: BlockListExtras = {},
): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) {
    if (allowed.has(`${network}/${prefix}`)) continue;
    list.addSubnet(network, prefix, family);
  }
  for (const address of extras.addresses ?? []) list.addAddress(address, family);
  for (const [start, end] of extras.ranges ?? []) list.addRange(start, end, family);
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
const loopbackAllowedIpv4Addresses = buildAllowedList(LOOPBACK_ALLOWED_IPV4_SUBNETS, 'ipv4');
const loopbackAllowedIpv6Addresses = buildAllowedList(LOOPBACK_ALLOWED_IPV6_SUBNETS, 'ipv6');

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

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return loopbackAllowedIpv4Addresses.check(address, 'ipv4');
  if (family === 6) return loopbackAllowedIpv6Addresses.check(address, 'ipv6');
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

/** Union of the CIDR strings a policy's relaxations un-block. */
function unionSubnets(...sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  const merged = new Set<string>();
  for (const set of sets) for (const entry of set) merged.add(entry);
  return merged;
}

/**
 * One block-list pair per (allowPrivateLan, allowLoopback) combination, built
 * once at module load. Two independent relaxations mean four lists, and
 * enumerating them beats rebuilding a `BlockList` per call — the guard runs on
 * every outbound request and on every AI completion.
 */
const blockListsByPolicy: ReadonlyMap<string, { ipv4: BlockList; ipv6: BlockList }> = new Map(
  [false, true].flatMap((allowPrivateLan) =>
    [false, true].map((allowLoopback) => {
      const ipv4Allowed = unionSubnets(
        allowPrivateLan ? LAN_ALLOWED_IPV4_SUBNETS : NOTHING_ALLOWED,
        allowLoopback ? LOOPBACK_ALLOWED_IPV4_SUBNETS : NOTHING_ALLOWED,
      );
      const ipv6Allowed = unionSubnets(
        allowPrivateLan ? LAN_ALLOWED_IPV6_SUBNETS : NOTHING_ALLOWED,
        allowLoopback ? IPV6_LOOPBACK_BLOCKLIST_PATCH.skip : NOTHING_ALLOWED,
      );
      const ipv6Extras: BlockListExtras = allowLoopback
        ? {
            addresses: IPV6_LOOPBACK_BLOCKLIST_PATCH.addresses,
            ranges: IPV6_LOOPBACK_BLOCKLIST_PATCH.ranges,
          }
        : {};
      return [
        policyKey(allowPrivateLan, allowLoopback),
        {
          ipv4: buildBlockList(BLOCKED_IPV4_SUBNETS, 'ipv4', ipv4Allowed),
          ipv6: buildBlockList(BLOCKED_IPV6_SUBNETS, 'ipv6', ipv6Allowed, ipv6Extras),
        },
      ] as const;
    }),
  ),
);

function policyKey(allowPrivateLan: boolean, allowLoopback: boolean): string {
  return `${allowPrivateLan ? 'lan' : 'nolan'}:${allowLoopback ? 'loop' : 'noloop'}`;
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

/** The three address axes a policy is made of, resolved once per guard pass. */
interface AddressPolicy {
  allowPrivateLan: boolean;
  allowLoopback: boolean;
  requireLocal: boolean;
}

function addressPolicy(options: OutboundUrlGuardOptions): AddressPolicy {
  return {
    allowPrivateLan: options.allowPrivateLan === true,
    allowLoopback: options.allowLoopback === true,
    requireLocal: options.requireLocal === true,
  };
}

function assertAllowedAddress(
  address: string,
  invalidReason: OutboundUrlBlockReason,
  policy: AddressPolicy,
): OutboundUrlAddress {
  const family = isIP(address);
  if (family === 0) throw new UnsafeOutboundUrlError(invalidReason);
  const lists = blockListsByPolicy.get(policyKey(policy.allowPrivateLan, policy.allowLoopback))!;
  const blocked =
    family === 4 ? lists.ipv4.check(address, 'ipv4') : lists.ipv6.check(address, 'ipv6');
  // The deployment's own service network is refused under EVERY policy, not only
  // the strict one: it is the range `allowPrivateLan` would otherwise un-block,
  // and it is the one range where "the user picked the destination" means
  // "a registered user picked one of our internal services".
  if (blocked || isDeploymentAddress(address, family)) {
    throw new UnsafeOutboundUrlError('blocked_address');
  }
  // `requireLocal` flips the guard from denylist to allowlist: having survived
  // every block above only proves the address is not one of the refused ranges,
  // which for a public address is trivially true. A local-only destination must
  // be positively inside one of the ranges this policy opened.
  if (
    policy.requireLocal &&
    !(policy.allowPrivateLan && isPrivateLanAddress(address)) &&
    !(policy.allowLoopback && isLoopbackAddress(address))
  ) {
    throw new UnsafeOutboundUrlError('public_address');
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

  const policy = addressPolicy(options);
  const protocolAllowed =
    url.protocol === 'https:' || (options.allowHttp === true && url.protocol === 'http:');
  if (!protocolAllowed) {
    throw new UnsafeOutboundUrlError('invalid_protocol');
  }

  const hostname = normalizedHostname(url.hostname);
  if (!hostname) throw new UnsafeOutboundUrlError('invalid_url');
  // A `localhost` name is refused by NAME rather than by its resolved address,
  // because the name is the whole intent. A policy that allows loopback wants
  // exactly that intent, so it skips the shortcut and lets DNS answer — the
  // address it resolves to still has to pass the block lists below, so
  // `localhost` pointed at something else by /etc/hosts gains nothing.
  if (!policy.allowLoopback && isLocalhostName(hostname)) {
    throw new UnsafeOutboundUrlError('localhost');
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    return {
      url,
      addresses: [assertAllowedAddress(hostname, 'blocked_address', policy)],
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
      assertAllowedAddress(address, 'invalid_resolved_address', policy),
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
  options: Pick<
    OutboundUrlGuardOptions,
    'resolver' | 'allowHttp' | 'allowPrivateLan' | 'allowLoopback' | 'requireLocal'
  > = {},
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
 * public-only by default; {@link OutboundUrlGuardOptions.allowHttp},
 * {@link OutboundUrlGuardOptions.allowPrivateLan} and
 * {@link OutboundUrlGuardOptions.allowLoopback} relax exactly those axes for
 * callers whose product contract requires it (see
 * {@link WEBHOOK_RECEIVER_URL_POLICY}), and
 * {@link OutboundUrlGuardOptions.requireLocal} inverts the default so only a
 * local destination passes (see {@link LOCAL_AI_ENDPOINT_URL_POLICY}).
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
