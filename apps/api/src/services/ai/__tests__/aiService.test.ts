import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettingRow } from '../../../data/schema';
import type { AppSettingsRepository } from '../../../data/repositories/appSettingsRepository';
import type { Logger } from '../../../logger';
import type { AuditService } from '../../audit/auditService';
import type { FeatureFlagConfig } from '@bettertrack/contracts';
import { createAppSettingsService } from '../../appSettings/appSettingsService';
import { resolveFeatureFlag } from '../../featureFlags/featureFlagResolution';
import { DEPLOYMENT_SUBNETS_ENV, type OutboundUrlResolver } from '../../security/outboundUrlGuard';
import {
  AI_DETAIL_INVALID_RESPONSE,
  AiCapExceededError,
  AiEndpointNotLocalError,
  AiProviderError,
  AiUnavailableError,
  aiCapKey,
  createAiDailyCap,
  createAiRegistry,
  createAiService,
  createOllamaProvider,
  utcDayKey,
} from '..';

/**
 * Local-AI provider layer (§13.5 V5-P12, §16 2026-07-22 — LOCAL AI ONLY). These
 * tests exercise the full guarded path against a mocked provider and, crucially,
 * assert the layer only ever reaches the ONE configured (local) endpoint — never
 * an external host — and that no request is made at all when unconfigured.
 */

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => noopLogger,
} as unknown as Logger;

const ENDPOINT = 'http://ollama.test:11434';
/** Where the stub resolver puts every hostname: a plain LAN address. */
const ENDPOINT_ADDRESS = '192.168.44.10';
/** A public endpoint — the exfiltration destination §16 2026-07-22 forbids. */
const PUBLIC_ENDPOINT = 'https://collector.attacker.tld';
const PUBLIC_ADDRESS = '93.184.216.34';
/** An endpoint stored before the write path refused credentials (#1656). */
const LEGACY_CREDENTIALED_ENDPOINT = 'http://svc:s3cr3t@10.9.8.7:11434';

/**
 * Pin the deployment carve-out. Unset, it is DERIVED from this machine's own
 * private interfaces, so the LAN addresses below would be refused on any dev box
 * whose LAN happens to overlap them. `172.18/16` is "ours"; nothing else is.
 */
const previousDeploymentSubnets = process.env[DEPLOYMENT_SUBNETS_ENV];
beforeAll(() => {
  process.env[DEPLOYMENT_SUBNETS_ENV] = '172.18.0.0/16';
});
afterAll(() => {
  if (previousDeploymentSubnets === undefined) delete process.env[DEPLOYMENT_SUBNETS_ENV];
  else process.env[DEPLOYMENT_SUBNETS_ENV] = previousDeploymentSubnets;
});

/**
 * The suite's DNS. Every hostname answers with one LAN address unless a test
 * overrides it, so the fetch-time egress guard has something deterministic to
 * vet and NOTHING here ever touches a real resolver.
 */
const lanResolver: OutboundUrlResolver = async (hostname) => [
  { address: hostname === 'collector.attacker.tld' ? PUBLIC_ADDRESS : ENDPOINT_ADDRESS, family: 4 },
];

/** In-memory `app_settings` store. */
function makeRepo(initial: Record<string, unknown> = {}): AppSettingsRepository {
  const store = new Map<string, AppSettingRow>();
  let clock = 0;
  for (const [key, value] of Object.entries(initial)) {
    store.set(key, { key, value, updatedAt: new Date(++clock), updatedBy: null });
  }
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async getAll() {
      return [...store.values()];
    },
    async upsert(key, value, updatedBy) {
      const row: AppSettingRow = { key, value, updatedAt: new Date(++clock + 1_000), updatedBy };
      store.set(key, row);
      return row;
    },
  };
}

function makeAudit(): {
  service: AuditService;
  records: Array<{ action: string; meta?: unknown }>;
} {
  const records: Array<{ action: string; meta?: unknown }> = [];
  return {
    records,
    service: {
      record: async (input) => {
        records.push({ action: input.action, meta: input.meta });
      },
    } as AuditService,
  };
}

/** A recording fetch that answers Ollama's endpoints from canned data. */
function makeFetch(opts: { chatStatus?: number; models?: string[]; chatBody?: string } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/api/tags')) {
      return new Response(
        JSON.stringify({ models: (opts.models ?? ['llama3.1:8b']).map((name) => ({ name })) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/api/chat')) {
      const status = opts.chatStatus ?? 200;
      if (status !== 200) return new Response('', { status });
      if (opts.chatBody !== undefined) {
        // A 200 whose body is NOT JSON — the shape whose parse error used to
        // carry a slice of the body into the admin UI (#1656 defect 3).
        return new Response(opts.chatBody, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: '  Hello there.  ' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

let redis: Redis;
beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

interface BuildOpts {
  initial?: Record<string, unknown>;
  aiDefaults?: { endpoint?: string; model?: string; dailyCap: number };
  featureEnabled?: boolean;
  /**
   * Rollout targeting for the `ai` flag (#1910). Given, the stub resolves it
   * through the REAL `resolveFeatureFlag`, so a test can put a user on the deny
   * list and the service's own principal plumbing is what decides the answer.
   */
  aiFlag?: Partial<FeatureFlagConfig>;
  now?: () => Date;
  chatStatus?: number;
  models?: string[];
  /** Body served for `/api/chat` instead of the canned JSON (defect 3). */
  chatBody?: string;
  /** Override the suite resolver (rebinding, public answers, outages). */
  resolver?: OutboundUrlResolver;
  /** Swap in a Redis whose cap operations fail (defect 5). */
  redisOverride?: Redis;
}

function makeService(opts: BuildOpts = {}) {
  const repo = makeRepo(opts.initial);
  const appSettings = createAppSettingsService({
    repo,
    adminSessionLifetimeDefaultHours: 12,
    aiDefaults: opts.aiDefaults ?? { dailyCap: 20 },
  });
  const fetch = makeFetch({
    chatStatus: opts.chatStatus,
    models: opts.models,
    chatBody: opts.chatBody,
  });
  const resolver = opts.resolver ?? lanResolver;
  const registry = createAiRegistry({
    appSettings,
    fetchImpl: fetch.fn,
    resolver,
    logger: noopLogger,
  });
  const cap = createAiDailyCap({ redis: opts.redisOverride ?? redis, now: opts.now });
  const audit = makeAudit();
  const service = createAiService({
    appSettings,
    registry,
    cap,
    featureFlags: {
      // Resolved through the REAL precedence function against the REAL principal
      // the service passes. A stub that ignored its arguments — as this one used
      // to — made the whole principal argument untestable: swapping the
      // service's `userPrincipal(userId)` for `SYSTEM_PRINCIPAL` left every test
      // in this file green (#1910 review M2).
      isEnabled: async (key, principal) =>
        resolveFeatureFlag(
          {
            enabled: opts.featureEnabled ?? true,
            rolloutPercent: 100,
            allowUserIds: [],
            denyUserIds: [],
            ...opts.aiFlag,
          },
          key,
          principal,
        ),
    },
    audit: audit.service,
    logger: noopLogger,
    resolver,
  });
  return { service, appSettings, fetch, audit };
}

describe('AI capability — disabled unless configured', () => {
  it('reports unavailable and makes NO network call when unconfigured', async () => {
    const { service, fetch } = makeService();
    const cap = await service.capability('user-1');
    expect(cap.available).toBe(false);
    expect(cap.model).toBeNull();
    expect(cap.remaining).toBe(0);
    // Local-only + unconfigured ⇒ nothing is ever fetched.
    expect(fetch.calls).toHaveLength(0);
  });

  it('reports unavailable when configured but the `ai` feature flag is off', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      featureEnabled: false,
    });
    expect((await service.capability('user-1')).available).toBe(false);
  });

  /**
   * The `ai` flag resolves against the ASKING USER (#1910). Both entry points
   * already hold one, and they must: `requireFeature('ai')` on the routes is
   * per-principal, so a capability read that answered globally would tell a user
   * outside the rollout that AI is available and then 404 them at the generation
   * endpoint — the flag equivalent of a dead link.
   */
  it('reports unavailable for a DENIED user while another user is served', async () => {
    const denied = '11111111-1111-4111-8111-111111111111';
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      aiFlag: { denyUserIds: [denied] },
    });

    const refused = await service.capability(denied);
    expect(refused.available).toBe(false);
    expect(refused.model).toBeNull();
    expect(refused.remaining).toBe(0);

    // Same service, same instant, same configuration — the only difference is
    // who is asking.
    expect((await service.capability('22222222-2222-4222-8222-222222222222')).available).toBe(true);
  });

  it('refuses GENERATION for a denied user, so the capability read and the guard agree', async () => {
    const denied = '11111111-1111-4111-8111-111111111111';
    const { service, fetch } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      aiFlag: { denyUserIds: [denied] },
    });

    await expect(service.complete(denied, { prompt: 'hi' })).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    // Refused BEFORE the provider is reached: a flag the user is outside of must
    // not spend a local generation, nor a unit of their daily cap.
    expect(fetch.calls).toHaveLength(0);
  });

  it('serves only the ALLOWLISTED user when the rollout is otherwise closed', async () => {
    const allowed = '33333333-3333-4333-8333-333333333333';
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      aiFlag: { rolloutPercent: 0, allowUserIds: [allowed] },
    });

    expect((await service.capability(allowed)).available).toBe(true);
    expect((await service.capability('44444444-4444-4444-8444-444444444444')).available).toBe(
      false,
    );
  });

  it('reports available with the model + budget once configured', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 5 },
    });
    const cap = await service.capability('user-1');
    expect(cap).toMatchObject({
      available: true,
      model: 'llama3.1:8b',
      dailyCap: 5,
      used: 0,
      remaining: 5,
    });
  });
});

describe('AI completion — the guarded full path (mocked provider)', () => {
  it('runs the whole path and spends one unit of the daily cap', async () => {
    const { service, fetch } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 3 },
    });
    const result = await service.complete('user-1', { prompt: 'hi', system: 'be brief' });
    expect(result).toEqual({ text: 'Hello there.', model: 'llama3.1:8b', provider: 'ollama' });
    // Exactly one chat call, to the LOCAL endpoint, carrying the configured model.
    const chat = fetch.calls.find((c) => c.url.endsWith('/api/chat'));
    expect(chat?.url).toBe(`${ENDPOINT}/api/chat`);
    expect((chat?.body as { model: string }).model).toBe('llama3.1:8b');
    expect((await service.capability('user-1')).used).toBe(1);
  });

  it('throws AiUnavailableError (no fetch) when unconfigured', async () => {
    const { service, fetch } = makeService();
    await expect(service.complete('user-1', { prompt: 'hi' })).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  /**
   * This replaces the assertion that used to stand here (#1656): "every call
   * went to the configured endpoint" is trivially true of an adapter built FROM
   * that endpoint, and says nothing at all about whether the endpoint is local —
   * which was the entire guarantee §16 2026-07-22 asks for. So the endpoint's
   * LOCALITY is what is pinned now: every call is vetted by the egress guard
   * immediately before it leaves, and a public answer stops it.
   */
  it('vets the endpoint as LOCAL before every call, not merely as the configured one', async () => {
    const vetted: string[] = [];
    const recordingResolver: OutboundUrlResolver = async (hostname) => {
      vetted.push(hostname);
      return [{ address: ENDPOINT_ADDRESS, family: 4 }];
    };
    const { service, fetch } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      resolver: recordingResolver,
    });
    await service.complete('user-1', { prompt: 'a' });
    await service.testConnection();

    expect(fetch.calls.length).toBeGreaterThan(0);
    for (const call of fetch.calls) {
      expect(call.url.startsWith(`${ENDPOINT}/`)).toBe(true);
    }
    // At least one guard pass per outbound call — the guard is not a
    // construction-time formality that a later DNS answer can walk past. (It is
    // MORE than one for the admin probe, which refuses a bad target before the
    // adapter is even built and then again before the socket.)
    expect(vetted.length).toBeGreaterThanOrEqual(fetch.calls.length);
    expect(new Set(vetted)).toEqual(new Set(['ollama.test']));
  });

  it('refuses to generate once the configured hostname starts resolving publicly', async () => {
    let call = 0;
    const rebinding: OutboundUrlResolver = async () => [
      { address: call++ === 0 ? ENDPOINT_ADDRESS : PUBLIC_ADDRESS, family: 4 },
    ];
    const { service, fetch } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      resolver: rebinding,
    });

    // The first call proves the rebinding stub is not simply refusing everything.
    await expect(service.complete('user-1', { prompt: 'a' })).resolves.toMatchObject({
      provider: 'ollama',
    });
    const after = fetch.calls.length;

    // The second is refused — and the prompt never leaves the process.
    const err = await service.complete('user-1', { prompt: 'b' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).statusCode).toBe(503);
    expect(fetch.calls).toHaveLength(after);
    // …and the refused call did not burn the user's budget.
    expect((await service.capability('user-1')).used).toBe(1);
  });

  it('turns a 200 with a non-JSON body into a generic failure, never a body excerpt', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      chatBody: '<html><body>internal admin console — token hunter2</body></html>',
    });
    const result = await service.testRequest({ prompt: 'ping' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(AI_DETAIL_INVALID_RESPONSE);
    expect(result.error).not.toContain('hunter2');
    expect(result.error).not.toContain('<');
  });

  it('refunds the cap unit and throws AiProviderError when the provider fails', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      chatStatus: 500,
    });
    const err = await service.complete('user-1', { prompt: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.statusCode).toBe(502);
    // A failed generation must not burn quota.
    expect((await service.capability('user-1')).used).toBe(0);
  });
});

describe('AI daily cap — enforced + admin-configurable', () => {
  it('rejects with a typed 429 once the cap is spent (increment rolled back)', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 2 },
    });
    await service.complete('user-1', { prompt: 'a' });
    await service.complete('user-1', { prompt: 'b' });
    const err = await service.complete('user-1', { prompt: 'c' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiCapExceededError);
    expect(err.code).toBe('AI_CAP_EXCEEDED');
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    // The rejected call did not count — usage sits exactly at the cap.
    expect((await service.capability('user-1')).used).toBe(2);
  });

  it('honours an admin-lowered cap value', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
    });
    await service.updateSettings({ dailyCap: 1 }, { id: 'admin-1', ip: null });
    expect((await service.capability('user-1')).dailyCap).toBe(1);
    await service.complete('user-1', { prompt: 'a' });
    await expect(service.complete('user-1', { prompt: 'b' })).rejects.toBeInstanceOf(
      AiCapExceededError,
    );
  });

  it('scopes the cap per user', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 1 },
    });
    await service.complete('user-1', { prompt: 'a' });
    // user-2 has their own budget.
    await expect(service.complete('user-2', { prompt: 'a' })).resolves.toMatchObject({
      provider: 'ollama',
    });
  });
});

describe('AI admin settings — switch takes effect without redeploy', () => {
  it('resolves the active endpoint/model at request time', async () => {
    const { service, fetch } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'model-a', dailyCap: 20 },
    });
    await service.complete('user-1', { prompt: 'a' });
    const first = fetch.calls.at(-1);
    expect(first?.url).toBe(`${ENDPOINT}/api/chat`);
    expect((first?.body as { model: string }).model).toBe('model-a');

    // Admin switches the endpoint AND model — no restart.
    const other = 'http://other.lan:11434';
    await service.updateSettings(
      { endpoint: other, model: 'model-b' },
      { id: 'admin-1', ip: null },
    );

    await service.complete('user-1', { prompt: 'b' });
    const second = fetch.calls.at(-1);
    expect(second?.url).toBe(`${other}/api/chat`);
    expect((second?.body as { model: string }).model).toBe('model-b');
  });

  it('audit-logs a settings change and reverts to the env default when cleared', async () => {
    const { service, appSettings, audit } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'env-model', dailyCap: 20 },
    });
    await service.updateSettings({ model: 'override-model' }, { id: 'admin-1', ip: '10.0.0.1' });
    expect((await appSettings.getAiSettings()).model).toBe('override-model');
    expect(audit.records.some((r) => r.action === 'ai_settings.updated')).toBe(true);

    // Clearing the override (null) falls back to the owner's env default.
    await service.updateSettings({ model: null }, { id: 'admin-1', ip: null });
    expect((await appSettings.getAiSettings()).model).toBe('env-model');
  });
});

describe('AI test-connection', () => {
  it('lists the models a reachable endpoint serves', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      models: ['llama3.1:8b', 'qwen2.5:14b'],
    });
    const result = await service.testConnection();
    expect(result).toEqual({ ok: true, models: ['llama3.1:8b', 'qwen2.5:14b'], error: null });
  });

  it('returns a soft failure with no endpoint to probe', async () => {
    const { service } = makeService();
    expect(await service.testConnection()).toEqual({ ok: false, models: [], error: 'no endpoint' });
  });
});

describe('AI test request — the admin round-trip diagnostic', () => {
  it('returns the model reply + a latency reading from a candidate endpoint/model', async () => {
    const { service, fetch } = makeService();
    const result = await service.testRequest({
      endpoint: ENDPOINT,
      model: 'qwen2.5:14b',
      prompt: 'Reply with one word: ready',
    });
    expect(result).toMatchObject({
      ok: true,
      model: 'qwen2.5:14b',
      reply: 'Hello there.',
      error: null,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // The unsaved candidate is what was reached — nothing was persisted.
    const chat = fetch.calls.find((c) => c.url.endsWith('/api/chat'));
    expect(chat?.url).toBe(`${ENDPOINT}/api/chat`);
    expect((chat?.body as { model: string }).model).toBe('qwen2.5:14b');
    expect((await service.getSettings()).configured).toBe(false);
  });

  it('spends NO daily cap unit (a diagnostic must never eat a user budget)', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 1 },
    });
    await service.testRequest({ prompt: 'ping' });
    await service.testRequest({ prompt: 'ping' });
    expect((await service.capability('user-1')).used).toBe(0);
    // …and the user's single allowance is still there to spend.
    await expect(service.complete('user-1', { prompt: 'a' })).resolves.toMatchObject({
      provider: 'ollama',
    });
  });

  it('falls back to the stored endpoint/model when no candidate is given', async () => {
    const { service, fetch } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
    });
    expect(await service.testRequest({ prompt: 'ping' })).toMatchObject({
      ok: true,
      model: 'llama3.1:8b',
    });
    expect(fetch.calls.at(-1)?.url).toBe(`${ENDPOINT}/api/chat`);
  });

  it('fails soft with the reason when the model errors', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      chatStatus: 404,
    });
    const result = await service.testRequest({ prompt: 'ping' });
    expect(result).toMatchObject({
      ok: false,
      model: 'llama3.1:8b',
      reply: null,
      error: 'http 404',
    });
  });

  it('fails soft with no endpoint (and never fetches)', async () => {
    const { service, fetch } = makeService();
    expect(await service.testRequest({ prompt: 'ping' })).toEqual({
      ok: false,
      model: null,
      reply: null,
      latencyMs: 0,
      error: 'no endpoint',
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it('fails soft with an endpoint but no model (and never fetches)', async () => {
    const { service, fetch } = makeService();
    expect(await service.testRequest({ endpoint: ENDPOINT, prompt: 'ping' })).toMatchObject({
      ok: false,
      model: null,
      error: 'no model',
    });
    expect(fetch.calls).toHaveLength(0);
  });

  /**
   * The sibling of the completion-path assertion above, and replaced for the
   * same reason (#1656): a diagnostic that reaches "only the given endpoint" is
   * still an internal port scanner if the given endpoint can be anything.
   */
  it('vets the CANDIDATE endpoint as local before probing it', async () => {
    const vetted: string[] = [];
    const recordingResolver: OutboundUrlResolver = async (hostname) => {
      vetted.push(hostname);
      return [{ address: ENDPOINT_ADDRESS, family: 4 }];
    };
    const { service, fetch } = makeService({ resolver: recordingResolver });
    await service.testRequest({ endpoint: ENDPOINT, model: 'llama3.1:8b', prompt: 'ping' });
    expect(fetch.calls.length).toBeGreaterThan(0);
    for (const call of fetch.calls) {
      expect(call.url.startsWith(`${ENDPOINT}/`)).toBe(true);
    }
    expect(vetted.length).toBeGreaterThan(0);
    expect(new Set(vetted)).toEqual(new Set(['ollama.test']));
  });
});

describe('Ollama adapter — health fails soft', () => {
  it('returns ok:false rather than throwing when the endpoint errors', async () => {
    const provider = createOllamaProvider({
      endpoint: ENDPOINT,
      model: 'llama3.1:8b',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.models).toEqual([]);
  });
});

/**
 * §16 2026-07-22 in one describe: the one admin-writable field may only ever
 * name something on the internal network, at write time and at probe time
 * (#1656 defect 1).
 */
describe('AI admin settings — the endpoint may only name the internal network', () => {
  it('refuses to STORE a public endpoint, with the typed 400', async () => {
    const { service, appSettings } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
    });
    const err = await service
      .updateSettings({ endpoint: PUBLIC_ENDPOINT }, { id: 'admin-1', ip: null })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiEndpointNotLocalError);
    expect((err as AiEndpointNotLocalError).statusCode).toBe(400);
    expect((err as AiEndpointNotLocalError).code).toBe('AI_ENDPOINT_NOT_LOCAL');
    // Nothing was written: the endpoint that was there is the endpoint that is there.
    expect((await appSettings.getAiSettings()).endpoint).toBe(ENDPOINT);
  });

  it('refuses to STORE the cloud-metadata address', async () => {
    const { service } = makeService();
    await expect(
      service.updateSettings({ endpoint: 'http://169.254.169.254/' }, { id: 'a', ip: null }),
    ).rejects.toBeInstanceOf(AiEndpointNotLocalError);
  });

  it('still STORES a genuine LAN endpoint (negative space)', async () => {
    const { service, appSettings } = makeService();
    await service.updateSettings(
      { endpoint: 'http://10.0.0.5:11434', model: 'llama3.1:8b' },
      { id: 'admin-1', ip: null },
    );
    expect((await appSettings.getAiSettings()).endpoint).toBe('http://10.0.0.5:11434');
  });

  it('still STORES a loopback endpoint (negative space)', async () => {
    const { service, appSettings } = makeService();
    await service.updateSettings({ endpoint: 'http://localhost:11434' }, { id: 'a', ip: null });
    expect((await appSettings.getAiSettings()).endpoint).toBe('http://localhost:11434');
  });

  it('refuses a metadata probe and never opens a socket to it', async () => {
    const { service, fetch } = makeService();
    const err = await service.testConnection('http://169.254.169.254/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiEndpointNotLocalError);
    // Not a scan result — the caller learns nothing about that address.
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses a public probe and never opens a socket to it', async () => {
    const { service, fetch } = makeService();
    await expect(service.testConnection(PUBLIC_ENDPOINT)).rejects.toBeInstanceOf(
      AiEndpointNotLocalError,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses a test-REQUEST against a public candidate and never opens a socket to it', async () => {
    const { service, fetch } = makeService();
    await expect(
      service.testRequest({ endpoint: PUBLIC_ENDPOINT, model: 'm', prompt: 'ping' }),
    ).rejects.toBeInstanceOf(AiEndpointNotLocalError);
    expect(fetch.calls).toHaveLength(0);
  });

  /**
   * "Unresolvable right now" is a different statement from "you aimed this at
   * the internet", and only the second is permanent. `node:dns` raises NXDOMAIN
   * as a plain `Error{code:'ENOTFOUND'}` — it never returns an empty answer set
   * — so a layer that only handled the empty-array shape turned every DNS blip
   * into a 500 (#1992 review, blocker 1).
   */
  describe('a host that cannot be resolved right now is transient, not a refusal', () => {
    /** Exactly how `node:dns/promises`.lookup fails on NXDOMAIN. */
    const notFound: OutboundUrlResolver = async (hostname) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    };
    const exploding: OutboundUrlResolver = async () => {
      throw new Error('resolver exploded');
    };

    it('STORES an endpoint whose box is not up yet (the documented setup flow)', async () => {
      const { service, appSettings } = makeService({ resolver: notFound });
      await service.updateSettings(
        { endpoint: 'http://ollama.lan:11434', model: 'llama3.1:8b' },
        { id: 'admin-1', ip: null },
      );
      expect((await appSettings.getAiSettings()).endpoint).toBe('http://ollama.lan:11434');
    });

    it.each([
      ['NXDOMAIN', notFound],
      ['a resolver that fails outright', exploding],
    ])('fails test-connection SOFT (never a 500) on %s', async (_label, resolver) => {
      const { service, fetch } = makeService({ resolver });
      const result = await service.testConnection('http://ollama.lan:11434');
      expect(result.ok).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.error).toBeTruthy();
      // …and the probe is still "not local"-free: this is a transport condition.
      expect(result.error).not.toBe('endpoint not local');
      expect(fetch.calls).toHaveLength(0);
    });

    it('fails test-request SOFT (never a 500) on NXDOMAIN', async () => {
      const { service, fetch } = makeService({ resolver: notFound });
      const result = await service.testRequest({
        endpoint: 'http://ollama.lan:11434',
        model: 'llama3.1:8b',
        prompt: 'ping',
      });
      expect(result.ok).toBe(false);
      expect(result.reply).toBeNull();
      expect(result.error).toBe('ENOTFOUND');
      expect(fetch.calls).toHaveLength(0);
    });

    it('still takes GENERATION quiet with the typed 503 while the name is dark', async () => {
      const { service } = makeService({
        aiDefaults: { endpoint: 'http://ollama.lan:11434', model: 'llama3.1:8b', dailyCap: 20 },
        resolver: notFound,
      });
      // Fail-closed on the use even though the write was fail-open: a provider
      // error, not a silent success, and no budget burned.
      await expect(service.complete('user-1', { prompt: 'a' })).rejects.toBeInstanceOf(
        AiProviderError,
      );
      expect((await service.capability('user-1')).used).toBe(0);
    });

    it('still REFUSES a public target outright — the soft path is not a bypass', async () => {
      const { service } = makeService({ resolver: notFound });
      // A public LITERAL needs no resolver at all, so the refusal stands
      // regardless of what DNS is doing.
      await expect(service.testConnection('https://93.184.216.34:11434')).rejects.toBeInstanceOf(
        AiEndpointNotLocalError,
      );
      await expect(
        service.updateSettings({ endpoint: 'http://169.254.169.254/' }, { id: 'a', ip: null }),
      ).rejects.toBeInstanceOf(AiEndpointNotLocalError);
    });
  });

  /**
   * The existing-row question (#1656): a public endpoint stored before this
   * validation existed must take the feature QUIET with the typed 503, not down
   * with a 500, and must stay visible to the admin so it can be fixed.
   */
  it('takes the feature quiet — not down — when a pre-existing row points at the internet', async () => {
    const { service, fetch } = makeService({
      initial: { ai_ollama_endpoint: PUBLIC_ENDPOINT, ai_ollama_model: 'llama3.1:8b' },
    });

    const err = await service.complete('user-1', { prompt: 'a' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).statusCode).toBe(503);
    expect((err as AiUnavailableError).code).toBe('AI_UNAVAILABLE');
    // The prompt never left the process, and the unit was handed back.
    expect(fetch.calls).toHaveLength(0);
    expect((await service.capability('user-1')).used).toBe(0);
    // …and the admin can still SEE the bad value, which is how they fix it.
    expect((await service.getSettings()).endpoint).toBe(PUBLIC_ENDPOINT);
  });
});

/**
 * The endpoint is a URL, never a token — but nothing used to ENFORCE that, and
 * `https://svc:s3cr3t@host/` is exactly how an Ollama behind a basic-auth proxy
 * gets written (#1656 defect 2). The write path refuses it now; these pin the
 * rows that were written before it did.
 */
describe('AI settings — an endpoint may never carry a credential out of the process', () => {
  const legacyRow = {
    ai_ollama_endpoint: LEGACY_CREDENTIALED_ENDPOINT,
    ai_ollama_model: 'llama3.1:8b',
  };

  it('strips credentials out of the admin read', async () => {
    const { service } = makeService({ initial: legacyRow });
    const settings = await service.getSettings();
    expect(settings.endpoint).toBe('http://10.9.8.7:11434/');
    expect(settings.endpoint).not.toContain('s3cr3t');
    expect(settings.endpoint).not.toContain('svc');
    // The destination survives — an admin has to be able to see WHICH host.
    expect(settings.endpoint).toContain('10.9.8.7');
  });

  it('strips credentials out of the audit row on both sides of the diff', async () => {
    const { service, audit } = makeService({ initial: legacyRow });
    await service.updateSettings(
      { endpoint: 'http://10.0.0.5:11434' },
      { id: 'admin-1', ip: '10.0.0.1' },
    );
    const record = audit.records.find((r) => r.action === 'ai_settings.updated');
    expect(record).toBeDefined();
    const serialized = JSON.stringify(record?.meta);
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('svc:');
    // The diff still answers the auditor's question: it moved from A to B.
    expect(serialized).toContain('10.9.8.7');
    expect(serialized).toContain('10.0.0.5');
  });

  it('keeps credentials out of the process log on a failed probe', async () => {
    const warn = vi.fn();
    const logger = { ...noopLogger, warn, child: () => logger } as unknown as Logger;
    const provider = createOllamaProvider({
      endpoint: LEGACY_CREDENTIALED_ENDPOINT,
      model: 'llama3.1:8b',
      resolver: async () => [{ address: '10.9.8.7', family: 4 }],
      // The real leak shape: a fetch failure whose message quotes the URL.
      fetchImpl: (async () => {
        throw new TypeError(`fetch failed for ${LEGACY_CREDENTIALED_ENDPOINT}/api/tags`);
      }) as unknown as typeof fetch,
      logger,
    });

    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('s3cr3t');
    expect(logged).not.toContain('svc:');
    // The soft result the admin UI renders is clean too.
    expect(JSON.stringify(health)).not.toContain('s3cr3t');
    // The adapter's own descriptive endpoint is the redacted spelling.
    expect(provider.endpoint).not.toContain('s3cr3t');
  });
});

/**
 * The cap is a Redis counter, and Redis can be down. That must read as "AI is
 * unavailable right now" (the typed 503 the contract already defines), never as
 * a 500 INTERNAL, and it must stay fail-closed (#1656 defect 5).
 */
describe('AI daily cap — a Redis outage is the typed 503, never a 500', () => {
  /** A Redis whose every cap operation rejects the way ioredis does. */
  function brokenRedis(): Redis {
    const boom = () => Promise.reject(new Error('Connection is closed.'));
    return { get: boom, eval: boom, incr: boom, decr: boom, expire: boom } as unknown as Redis;
  }

  it('answers GET /ai/capability with the typed 503', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      redisOverride: brokenRedis(),
    });
    const err = await service.capability('user-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).statusCode).toBe(503);
    expect((err as AiUnavailableError).code).toBe('AI_UNAVAILABLE');
  });

  it('answers a generation with the typed 503 and generates NOTHING (fail-closed)', async () => {
    const { service, fetch } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
      redisOverride: brokenRedis(),
    });
    const err = await service.complete('user-1', { prompt: 'a' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).statusCode).toBe(503);
    // An unmetered AI endpoint for the length of a Redis outage is the outcome
    // this refuses: nothing was generated.
    expect(fetch.calls).toHaveLength(0);
  });

  it('still surfaces the cap’s OWN typed 429 rather than swallowing it as unavailable', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 1 },
    });
    await service.complete('user-1', { prompt: 'a' });
    await expect(service.complete('user-1', { prompt: 'b' })).rejects.toBeInstanceOf(
      AiCapExceededError,
    );
  });
});

/**
 * `refund` was a GET-then-DECR across two round trips (#1656 defect 4). Under a
 * burst — which is exactly how provider failures arrive — concurrent refunds all
 * read the same value, all pass the `> 0` guard and all decrement, so the
 * counter goes NEGATIVE. `parseCount` then maps that to 0 on the way out, which
 * is why it is invisible: the user silently gets `limit + n` completions.
 */
describe('AI daily cap — concurrent refunds can never mint budget', () => {
  const USER = 'user-burst';

  it('floors the stored counter at exactly 0, and the day’s quota is unchanged', async () => {
    const cap = createAiDailyCap({ redis });
    const key = aiCapKey(USER, utcDayKey(new Date()));

    // One unit outstanding, three refunds racing for it.
    await cap.consume(USER, 1);
    expect(await redis.get(key)).toBe('1');
    await Promise.all([cap.refund(USER), cap.refund(USER), cap.refund(USER)]);

    // Exactly 0 — not -2, which is what the non-atomic read-then-decrement left.
    expect(await redis.get(key)).toBe('0');
    expect(await cap.usage(USER)).toBe(0);

    // …and the user's day is worth exactly what it was: the one refunded unit
    // buys one completion, and the next is refused. (Against a counter of -2
    // the next THREE were free — that is the drift this closes.)
    await expect(cap.consume(USER, 1)).resolves.toMatchObject({ used: 1 });
    await expect(cap.consume(USER, 1)).rejects.toBeInstanceOf(AiCapExceededError);
  });

  it('never credits a unit that was never spent', async () => {
    const cap = createAiDailyCap({ redis });
    const key = aiCapKey('user-untouched', utcDayKey(new Date()));
    await Promise.all([cap.refund('user-untouched'), cap.refund('user-untouched')]);
    expect(await cap.usage('user-untouched')).toBe(0);
    expect(Number(await redis.get(key)) || 0).toBe(0);
  });

  it('keeps a bounded TTL on the counter even after a refund cycle', async () => {
    const cap = createAiDailyCap({ redis });
    const key = aiCapKey('user-ttl', utcDayKey(new Date()));
    await cap.consume('user-ttl', 5);
    await cap.refund('user-ttl');
    await cap.consume('user-ttl', 5);
    // The old `next === 1` test was the ONLY thing that armed it; a counter that
    // had drifted never saw 1 again and lived until eviction.
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });

  it('leaves the counter at 0 after N concurrent FAILING completions', async () => {
    const { service } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 10 },
      chatStatus: 500,
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => service.complete('user-1', { prompt: 'a' }).catch((e) => e)),
    );
    for (const result of results) expect(result).toBeInstanceOf(AiProviderError);
    expect(await redis.get(aiCapKey('user-1', utcDayKey(new Date())))).toBe('0');
    expect((await service.capability('user-1')).remaining).toBe(10);
  });
});
