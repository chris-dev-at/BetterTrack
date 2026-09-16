import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_SUBNETS_ENV,
  OUTBOUND_URL_BLOCKED,
  WEBHOOK_RECEIVER_URL_POLICY,
  assertSafeOutboundUrl,
  type OutboundUrlResolver,
} from '../../security/outboundUrlGuard';
import {
  AI_DETAIL_INVALID_RESPONSE,
  AI_DETAIL_NOT_LOCAL,
  AI_DETAIL_UNREACHABLE,
  AiInvalidResponseError,
  AiResponseStatusError,
  assertWritableLocalAiEndpoint,
  providerErrorDetail,
  redactEndpoint,
  resolveLocalAiEndpoint,
} from '../endpointPolicy';
import { AiEndpointNotLocalError } from '../errors';

/**
 * The local-AI egress policy (§16 2026-07-22 — "every AI feature runs on the
 * local Ollama (internal network only, never publicly exposed)", #1656).
 *
 * The guard is an ALLOWLIST here, which is the inverse of every other caller, so
 * both directions are pinned: the shapes a real LAN Ollama is addressed as must
 * keep working, and everything else — a public collector, the cloud-metadata
 * address, the deployment's own services, a rebinding hostname — must not.
 */

/**
 * Without this, every assertion below would depend on the machine it runs on:
 * with the variable unset the deployment carve-out is DERIVED from the host's
 * own private interfaces, so a laptop on `10.0.0.0/24` would refuse the `10/8`
 * endpoint the accepted list insists on. (The author's does; that is how this
 * comment came to exist.) Declaring it makes the split explicit.
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

/** A resolver that answers every name with one fixed address. */
const resolving =
  (address: string, family: 4 | 6 = 4): OutboundUrlResolver =>
  async () => [{ address, family }];

/** Nothing in this file may touch real DNS; an unstubbed lookup is a bug. */
const forbiddenResolver: OutboundUrlResolver = async (hostname) => {
  throw new Error(`unexpected DNS lookup for ${hostname}`);
};

describe('local-AI endpoint policy — what a real LAN Ollama looks like (negative space)', () => {
  it.each([
    ['an RFC1918 literal', 'http://10.0.0.5:11434/api/tags', forbiddenResolver],
    ['a 192.168 literal', 'http://192.168.1.50:11434/api/chat', forbiddenResolver],
    [
      'a 172.16/12 literal outside the deployment /16',
      'http://172.31.9.9:11434/',
      forbiddenResolver,
    ],
    ['loopback by literal', 'http://127.0.0.1:11434/api/tags', forbiddenResolver],
    ['a unique-local IPv6 literal', 'http://[fd12:3456::1]:11434/api/tags', forbiddenResolver],
    ['loopback by name', 'http://localhost:11434/api/tags', resolving('127.0.0.1')],
    ['IPv6 loopback by name', 'http://localhost:11434/api/tags', resolving('::1', 6)],
    ['a LAN hostname', 'http://ollama.internal:11434/api/tags', resolving('192.168.1.50')],
    ['an mDNS .local name', 'http://ollama.local:11434/api/tags', resolving('10.1.2.3')],
    ['https to a LAN reverse proxy', 'https://ollama.internal/api/tags', resolving('10.1.2.3')],
  ])('accepts %s', async (_label, url, resolver) => {
    await expect(resolveLocalAiEndpoint(url, { resolver })).resolves.toMatchObject({
      url: expect.any(URL),
    });
  });
});

describe('local-AI endpoint policy — refuses everything off the internal network', () => {
  it.each([
    ['a public IPv4 literal', 'http://93.184.216.34:11434/api/chat', forbiddenResolver],
    ['a public IPv6 literal', 'https://[2606:4700:4700::1111]/api/chat', forbiddenResolver],
    ['the cloud-metadata address', 'http://169.254.169.254/latest/meta-data/', forbiddenResolver],
    ['IPv6 link-local', 'http://[fe80::1]:11434/api/tags', forbiddenResolver],
    ['CGNAT', 'http://100.64.0.1:11434/api/tags', forbiddenResolver],
    ['the unspecified address', 'http://0.0.0.0:11434/api/tags', forbiddenResolver],
    ['multicast', 'http://239.1.2.3:11434/api/tags', forbiddenResolver],
    [
      'an IPv4-mapped loopback spelling',
      'http://[::ffff:127.0.0.1]:11434/api/tags',
      forbiddenResolver,
    ],
    [
      'a NAT64-encoded private address',
      'http://[64:ff9b::a00:1]:11434/api/tags',
      forbiddenResolver,
    ],
    ["the deployment's own bridge", 'http://172.18.0.4:6379/api/tags', forbiddenResolver],
    ['a public hostname', 'https://collector.attacker.tld/api/chat', resolving('93.184.216.34')],
    ['a compose service name on our bridge', 'http://redis:6379/api/tags', resolving('172.18.0.7')],
  ])('refuses %s with the typed 400', async (_label, url, resolver) => {
    const error = await resolveLocalAiEndpoint(url, { resolver }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiEndpointNotLocalError);
    expect((error as AiEndpointNotLocalError).statusCode).toBe(400);
    expect((error as AiEndpointNotLocalError).code).toBe('AI_ENDPOINT_NOT_LOCAL');
  });

  it.each([
    ['ftp', 'ftp://10.0.0.5:11434/'],
    ['gopher', 'gopher://10.0.0.5:11434/'],
    ['file', 'file:///etc/passwd'],
  ])('refuses the %s scheme before any lookup', async (_label, url) => {
    await expect(
      resolveLocalAiEndpoint(url, { resolver: forbiddenResolver }),
    ).rejects.toBeInstanceOf(AiEndpointNotLocalError);
  });

  /**
   * The defect the fetch-time guard exists for: write-time validation cannot
   * bind a HOSTNAME, so the same name may answer privately once and publicly
   * next time. Both calls go through the same guard, and only the second is
   * refused — which is also what proves the first assertion is not vacuous.
   */
  it('refuses a hostname that rebinds to a public address after passing once', async () => {
    const answers = ['10.0.0.5', '93.184.216.34'];
    let call = 0;
    const rebinding: OutboundUrlResolver = async () => [
      { address: answers[Math.min(call++, answers.length - 1)]!, family: 4 },
    ];

    await expect(
      resolveLocalAiEndpoint('http://ollama.internal:11434/api/chat', { resolver: rebinding }),
    ).resolves.toBeTruthy();
    await expect(
      resolveLocalAiEndpoint('http://ollama.internal:11434/api/chat', { resolver: rebinding }),
    ).rejects.toBeInstanceOf(AiEndpointNotLocalError);
  });

  it('refuses a name whose answer set MIXES a private and a public address', async () => {
    const mixed: OutboundUrlResolver = async () => [
      { address: '10.0.0.5', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ];
    await expect(
      resolveLocalAiEndpoint('http://ollama.internal:11434/api/chat', { resolver: mixed }),
    ).rejects.toBeInstanceOf(AiEndpointNotLocalError);
  });
});

describe('local-AI endpoint policy — the write gate', () => {
  it('blocks a write to a public endpoint', async () => {
    await expect(
      assertWritableLocalAiEndpoint('https://collector.attacker.tld/', {
        resolver: resolving('93.184.216.34'),
      }),
    ).rejects.toBeInstanceOf(AiEndpointNotLocalError);
  });

  it('allows a write to a LAN endpoint', async () => {
    await expect(
      assertWritableLocalAiEndpoint('http://ollama.internal:11434', {
        resolver: resolving('10.1.2.3'),
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * A host that does not resolve RIGHT NOW is a transient condition, not a
   * policy refusal — configuring the endpoint before powering the box on is a
   * real flow. Nothing is widened by allowing it: the fetch-time guard re-vets
   * the name on every single call, so a value saved this way is unreachable
   * until it resolves to something local.
   */
  it('allows a write whose host does not resolve yet, but never fetches it', async () => {
    const unresolvable: OutboundUrlResolver = async () => [];
    await expect(
      assertWritableLocalAiEndpoint('http://ollama.notyet:11434', { resolver: unresolvable }),
    ).resolves.toBeUndefined();
    await expect(
      resolveLocalAiEndpoint('http://ollama.notyet:11434/api/chat', { resolver: unresolvable }),
    ).rejects.toMatchObject({ code: OUTBOUND_URL_BLOCKED });
  });
});

/**
 * The local-AI policy is a NEW axis on the shared guard, so the two policies
 * that were already there must answer exactly as they did before.
 */
describe('local-AI endpoint policy — existing guard callers are unchanged', () => {
  it('still refuses loopback and LAN for a strict (public-only) caller', async () => {
    for (const url of [
      'https://127.0.0.1/push',
      'https://10.0.0.5/push',
      'https://localhost/push',
    ]) {
      await expect(assertSafeOutboundUrl(url, { resolveDns: false })).rejects.toMatchObject({
        code: OUTBOUND_URL_BLOCKED,
      });
    }
  });

  it('still allows a public destination for a strict caller', async () => {
    await expect(
      assertSafeOutboundUrl('https://93.184.216.34/push', { resolveDns: false }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('still allows a LAN webhook receiver and still refuses loopback for one', async () => {
    const policy = { ...WEBHOOK_RECEIVER_URL_POLICY, resolveDns: false } as const;
    await expect(
      assertSafeOutboundUrl('http://192.168.1.50:9000/hook', policy),
    ).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://127.0.0.1:9000/hook', policy)).rejects.toMatchObject(
      {
        code: OUTBOUND_URL_BLOCKED,
        reason: 'blocked_address',
      },
    );
    await expect(assertSafeOutboundUrl('http://localhost:9000/hook', policy)).rejects.toMatchObject(
      {
        reason: 'localhost',
      },
    );
  });

  it('still allows a PUBLIC webhook receiver — the LAN policy is a relaxation, not an inversion', async () => {
    await expect(
      assertSafeOutboundUrl('https://hooks.example.com/x', {
        ...WEBHOOK_RECEIVER_URL_POLICY,
        resolveDns: false,
      }),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe('redactEndpoint — the credential rule on every way out', () => {
  it.each([
    ['a password', 'https://svc:s3cr3t@ollama.internal/', 'https://ollama.internal/'],
    ['a username only', 'http://svc@ollama.internal:11434/', 'http://ollama.internal:11434/'],
    ['an empty password', 'http://svc:@ollama.internal:11434/', 'http://ollama.internal:11434/'],
  ])('strips %s while keeping the host', (_label, raw, expected) => {
    const redacted = redactEndpoint(raw);
    expect(redacted).toBe(expected);
    expect(redacted).not.toContain('s3cr3t');
    expect(redacted).not.toContain('svc');
  });

  it('leaves a credential-free endpoint byte-identical, so the audit diff stays truthful', () => {
    expect(redactEndpoint('http://ollama.internal:11434')).toBe('http://ollama.internal:11434');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['not a URL at all', 'svc:s3cr3t@ollama.internal'],
  ])('answers null for %s rather than echoing it', (_label, raw) => {
    expect(redactEndpoint(raw)).toBeNull();
  });
});

describe('providerErrorDetail — a closed set, never the target’s own words', () => {
  it('never leaks the excerpt a JSON parse failure carries', () => {
    // This is the real shape: `res.json()` rejects with a SyntaxError whose
    // message quotes the start of the body.
    let parseError: unknown;
    try {
      JSON.parse('<html><body>admin password is hunter2</body></html>');
    } catch (err) {
      parseError = err;
    }
    expect(String((parseError as Error).message)).toContain('<');
    expect(providerErrorDetail(new AiInvalidResponseError())).toBe(AI_DETAIL_INVALID_RESPONSE);
    expect(providerErrorDetail(new AiInvalidResponseError())).not.toContain('hunter2');
  });

  it('never leaks a URL a fetch failure carries in its message', () => {
    const leaky = new TypeError(
      'Failed to parse URL from http://svc:s3cr3t@ollama.internal/api/chat',
    );
    expect(providerErrorDetail(leaky)).toBe(AI_DETAIL_UNREACHABLE);
    expect(providerErrorDetail(leaky)).not.toContain('s3cr3t');
  });

  it.each([
    ['a timeout', Object.assign(new Error('x'), { name: 'TimeoutError' }), 'timeout'],
    ['an abort', Object.assign(new Error('x'), { name: 'AbortError' }), 'timeout'],
    ['a status', new AiResponseStatusError(404), 'http 404'],
    [
      'a refused connection',
      Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      'ECONNREFUSED',
    ],
    ['an unknown host', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'ENOTFOUND'],
    ['a non-Error throw', 'boom', AI_DETAIL_UNREACHABLE],
  ])('names %s', (_label, err, expected) => {
    expect(providerErrorDetail(err)).toBe(expected);
  });

  it('reads the code out of undici’s wrapper cause', () => {
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      }),
    });
    expect(providerErrorDetail(wrapped)).toBe('ECONNREFUSED');
  });

  it('names an endpoint the egress policy refused', () => {
    expect(providerErrorDetail(new AiEndpointNotLocalError())).toBe(AI_DETAIL_NOT_LOCAL);
  });

  it('refuses a code-shaped value that is really free text', () => {
    // Only `[A-Z][A-Z0-9_]*` shapes pass, so a "code" carrying a sentence or a
    // host cannot ride out through this channel.
    const chatty = Object.assign(new Error('x'), { code: 'connect to ollama.internal failed' });
    expect(providerErrorDetail(chatty)).toBe(AI_DETAIL_UNREACHABLE);
  });
});
