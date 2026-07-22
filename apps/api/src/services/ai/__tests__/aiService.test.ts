import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettingRow } from '../../../data/schema';
import type { AppSettingsRepository } from '../../../data/repositories/appSettingsRepository';
import type { Logger } from '../../../logger';
import type { AuditService } from '../../audit/auditService';
import { createAppSettingsService } from '../../appSettings/appSettingsService';
import {
  AiCapExceededError,
  AiProviderError,
  AiUnavailableError,
  createAiDailyCap,
  createAiRegistry,
  createAiService,
  createOllamaProvider,
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
function makeFetch(opts: { chatStatus?: number; models?: string[] } = {}) {
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
  now?: () => Date;
  chatStatus?: number;
  models?: string[];
}

function makeService(opts: BuildOpts = {}) {
  const repo = makeRepo(opts.initial);
  const appSettings = createAppSettingsService({
    repo,
    adminSessionLifetimeDefaultHours: 12,
    aiDefaults: opts.aiDefaults ?? { dailyCap: 20 },
  });
  const fetch = makeFetch({ chatStatus: opts.chatStatus, models: opts.models });
  const registry = createAiRegistry({ appSettings, fetchImpl: fetch.fn, logger: noopLogger });
  const cap = createAiDailyCap({ redis, now: opts.now });
  const audit = makeAudit();
  const service = createAiService({
    appSettings,
    registry,
    cap,
    featureFlags: { isEnabled: async () => opts.featureEnabled ?? true },
    audit: audit.service,
    logger: noopLogger,
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

  it('never reaches any host but the configured endpoint (local-only)', async () => {
    const { service, fetch } = makeService({
      aiDefaults: { endpoint: ENDPOINT, model: 'llama3.1:8b', dailyCap: 20 },
    });
    await service.complete('user-1', { prompt: 'a' });
    await service.testConnection();
    expect(fetch.calls.length).toBeGreaterThan(0);
    for (const call of fetch.calls) {
      expect(call.url.startsWith(`${ENDPOINT}/`)).toBe(true);
    }
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
