import type { Application } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aiCapabilityResponseSchema,
  aiSettingsResponseSchema,
  aiTestRequestResponseSchema,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Local-AI provider layer wired through the app (§13.5 V5-P12, §16 2026-07-22 —
 * LOCAL AI ONLY). Covers the capability regression (unconfigured ⇒ disabled), the
 * admin endpoint/model/cap settings, the auth boundaries, and that a switch takes
 * effect with no redeploy. No real Ollama runs — capability + settings never call
 * out, and test-connection targets a refused local port (fails soft).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

async function loginUser(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  return agent;
}

describe('AI capability endpoint (regression: disabled unless configured)', () => {
  let harness: TestHarness;
  afterEach(() => {
    /* harness torn down by lifecycle */
  });

  describe('no provider configured', () => {
    beforeEach(async () => {
      harness = await createTestApp();
    });

    it('401s an anonymous caller', async () => {
      expect((await request(harness.app).get('/api/v1/ai/capability')).status).toBe(401);
    });

    it('reports available:false for a signed-in user', async () => {
      const user = await harness.seedUser();
      const agent = await loginUser(harness.app, user.email, user.password);
      const res = await agent.get('/api/v1/ai/capability');
      expect(res.status).toBe(200);
      const cap = aiCapabilityResponseSchema.parse(res.body);
      expect(cap.available).toBe(false);
      expect(cap.model).toBeNull();
      expect(cap.remaining).toBe(0);
    });
  });

  describe('provider configured via env', () => {
    beforeEach(async () => {
      harness = await createTestApp({
        env: {
          BT_OLLAMA_ENDPOINT: 'http://ollama.test:11434',
          BT_OLLAMA_MODEL: 'llama3.1:8b',
          BT_AI_DAILY_CAP: '9',
        },
      });
    });

    it('reports available:true with the model + full daily budget', async () => {
      const user = await harness.seedUser();
      const agent = await loginUser(harness.app, user.email, user.password);
      const cap = aiCapabilityResponseSchema.parse((await agent.get('/api/v1/ai/capability')).body);
      expect(cap).toMatchObject({
        available: true,
        model: 'llama3.1:8b',
        dailyCap: 9,
        used: 0,
        remaining: 9,
      });
    });
  });
});

describe('admin AI settings (§13.5 V5-P12)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  it('404s the settings to anonymous callers (no leak)', async () => {
    expect((await request(harness.app).get('/api/v1/admin/ai/settings')).status).toBe(404);
  });

  it('reads the (unconfigured) settings for an admin', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent.get('/api/v1/admin/ai/settings');
    expect(res.status).toBe(200);
    const settings = aiSettingsResponseSchema.parse(res.body);
    expect(settings.configured).toBe(false);
    expect(settings.endpoint).toBeNull();
  });

  it('persists an endpoint/model/cap and reflects it in the user capability', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const patched = await adminAgent
      .patch('/api/v1/admin/ai/settings')
      .set(...XRW)
      .send({ endpoint: 'http://ollama.local:11434', model: 'llama3.1:8b', dailyCap: 7 });
    expect(patched.status).toBe(200);
    const settings = aiSettingsResponseSchema.parse(patched.body);
    expect(settings).toMatchObject({
      endpoint: 'http://ollama.local:11434',
      model: 'llama3.1:8b',
      dailyCap: 7,
      configured: true,
    });
    expect(settings.updatedBy).toBe(admin.id);

    // The switch is live with no redeploy — a user's capability now reads enabled.
    const user = await harness.seedUser();
    const userAgent = await loginUser(harness.app, user.email, user.password);
    const cap = aiCapabilityResponseSchema.parse(
      (await userAgent.get('/api/v1/ai/capability')).body,
    );
    expect(cap).toMatchObject({ available: true, model: 'llama3.1:8b', dailyCap: 7 });
  });

  it('rejects an invalid (non-URL) endpoint with a 400', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent
      .patch('/api/v1/admin/ai/settings')
      .set(...XRW)
      .send({ endpoint: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('test-connection fails soft against an unreachable endpoint', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent
      .post('/api/v1/admin/ai/test-connection')
      .set(...XRW)
      // A refused local port ⇒ deterministic, network-free failure.
      .send({ endpoint: 'http://127.0.0.1:1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.models).toEqual([]);
  });
});

describe('admin AI test request (§13.5 V5-P12)', () => {
  /** A canned local provider: records the URLs it is asked to reach + one chat reply. */
  function cannedAiFetch(content: string) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ message: { role: 'assistant', content } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('404s an anonymous caller (no leak)', async () => {
    const harness = await createTestApp();
    const res = await request(harness.app)
      .post('/api/v1/admin/ai/test-request')
      .set(...XRW)
      .send({ prompt: 'Reply with one word: ready' });
    expect(res.status).toBe(404);
  });

  it('404s a signed-in non-admin user', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const agent = await loginUser(harness.app, user.email, user.password);
    const res = await agent
      .post('/api/v1/admin/ai/test-request')
      .set(...XRW)
      .send({ prompt: 'Reply with one word: ready' });
    expect(res.status).toBe(404);
  });

  it('renders the model reply + latency for an unsaved candidate, spending no cap', async () => {
    const { impl, calls } = cannedAiFetch('  ready  ');
    const harness = await createTestApp({ aiFetch: impl });
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const res = await agent
      .post('/api/v1/admin/ai/test-request')
      .set(...XRW)
      .send({
        endpoint: 'http://ollama.test:11434',
        model: 'qwen2.5:14b',
        prompt: 'Reply with one word: ready',
      });
    expect(res.status).toBe(200);
    const body = aiTestRequestResponseSchema.parse(res.body);
    expect(body).toMatchObject({ ok: true, model: 'qwen2.5:14b', reply: 'ready', error: null });
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);

    // The candidate was reached (and only it) — nothing was saved.
    expect(calls.map((c) => c.url)).toEqual(['http://ollama.test:11434/api/chat']);
    expect((calls[0]?.body as { model: string }).model).toBe('qwen2.5:14b');
    const settings = aiSettingsResponseSchema.parse(
      (await agent.get('/api/v1/admin/ai/settings')).body,
    );
    expect(settings.configured).toBe(false);

    // The diagnostic burns nobody's daily budget.
    const user = await harness.seedUser();
    const userAgent = await loginUser(harness.app, user.email, user.password);
    expect((await userAgent.get('/api/v1/ai/capability')).body.used).toBe(0);
  });

  it('fails soft against an unreachable endpoint', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent
      .post('/api/v1/admin/ai/test-request')
      .set(...XRW)
      // A refused local port ⇒ deterministic, network-free failure.
      .send({ endpoint: 'http://127.0.0.1:1', model: 'llama3.1:8b', prompt: 'ping' });
    expect(res.status).toBe(200);
    const body = aiTestRequestResponseSchema.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.reply).toBeNull();
    expect(body.error).toBeTruthy();
  });

  it('fails soft when nothing is configured and no candidate is given', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent
      .post('/api/v1/admin/ai/test-request')
      .set(...XRW)
      .send({ prompt: 'ping' });
    expect(res.status).toBe(200);
    expect(aiTestRequestResponseSchema.parse(res.body)).toEqual({
      ok: false,
      model: null,
      reply: null,
      latencyMs: 0,
      error: 'no endpoint',
    });
  });

  it('rejects an empty prompt with a 400', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent
      .post('/api/v1/admin/ai/test-request')
      .set(...XRW)
      .send({ prompt: '   ' });
    expect(res.status).toBe(400);
  });
});
