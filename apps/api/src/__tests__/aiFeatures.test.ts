import type { Application } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  aiCapabilityResponseSchema,
  aiConglomerateDraftResponseSchema,
  aiInsightsResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { createStubMarketData } from '../testing/marketDataStubs';

/**
 * The user-facing AI features wired through the app (§13.5 V5-P12 2/2, §16
 * 2026-07-22 — LOCAL AI ONLY). Exercises the full stack with a canned local
 * provider (no real Ollama, no network): an insight renders through the real
 * holdings/analytics path with service-computed numbers; the NL builder returns a
 * draft with unresolved intents flagged; an absent provider refuses both surfaces
 * (regression); the daily cap is enforced; and the model is only ever reached at
 * the configured local endpoint.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const DAY_MS = 86_400_000;
const dayOffset = (n: number): string =>
  new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
const tsOffset = (n: number): string => new Date(Date.now() + n * DAY_MS).toISOString();
const cached = <T>(value: T) => ({ value, stale: false, asOf: Date.now() });
const historyOf = (closes: number[]) =>
  cached(closes.map((close, i) => ({ time: `${dayOffset(-6 + i)}T00:00:00.000Z`, close })));

const AI_ENV = {
  BT_OLLAMA_ENDPOINT: 'http://ollama.test:11434',
  BT_OLLAMA_MODEL: 'llama3.1:8b',
} as const;

/** A canned local provider: records every URL it is asked to reach + returns one chat reply. */
function recordingAiFetch(content: string) {
  const calls: string[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ message: { role: 'assistant', content } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function stubMarket() {
  return createStubMarketData({
    history: (ref) =>
      historyOf(ref.providerRef === 'AAA' ? [100, 101, 102, 103, 104, 105, 106] : [1]),
    quote: (ref) =>
      cached({
        price: ref.providerRef === 'AAA' ? 120 : 10,
        currency: 'EUR',
        prevClose: 118,
        asOf: new Date().toISOString(),
      }),
  });
}

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function seedAsset(h: TestHarness, symbol: string) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `Asset ${symbol}`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  return row!;
}

async function buy(agent: ReturnType<typeof request.agent>, pid: string, assetId: string) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({
      transactions: [{ assetId, side: 'buy', quantity: 10, price: 100, executedAt: tsOffset(-6) }],
    });
  expect(res.status).toBe(201);
}

describe('AI features — insights (§13.5 V5-P12 2/2)', () => {
  it('renders an insight with service-computed numbers a lying model cannot override', async () => {
    const { impl, calls } = recordingAiFetch('Your portfolio is 999% concentrated in one name.');
    const harness = await createTestApp({ env: AI_ENV, marketData: stubMarket(), aiFetch: impl });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const aaa = await seedAsset(harness, 'AAA');
    await buy(agent, pid, aaa.id);

    const res = await agent
      .post('/api/v1/ai/insights')
      .set(...XRW)
      .send({ portfolioId: pid });
    expect(res.status).toBe(200);
    const body = aiInsightsResponseSchema.parse(res.body);

    // The model's prose passes through as `summary`; nothing here is an action.
    expect(body.summary).toContain('999%');
    expect(Object.keys(body).sort()).toEqual(['model', 'observations', 'summary']);

    // …but the authoritative numbers are computed from the single holding.
    const concentration = body.observations.find((o) => o.kind === 'concentration')!;
    const facts = Object.fromEntries(concentration.facts.map((f) => [f.key, f.value]));
    expect(facts.topWeightPct).toBe(100); // NOT 999
    expect(facts.positionCount).toBe(1);

    // LOCAL AI ONLY: the model was reached only at the configured local endpoint.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.startsWith('http://ollama.test:11434'))).toBe(true);
  });

  it('rejects insights for a portfolio with no holdings (400, no completion spent)', async () => {
    const { impl, calls } = recordingAiFetch('unused');
    const harness = await createTestApp({ env: AI_ENV, aiFetch: impl });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const res = await agent
      .post('/api/v1/ai/insights')
      .set(...XRW)
      .send({ portfolioId: pid });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('AI features — NL conglomerate builder (§13.5 V5-P12 2/2)', () => {
  it('returns a draft and flags — never drops — an unresolvable intent', async () => {
    const content = JSON.stringify({
      lines: [
        { query: 'AAA', weightPct: 60 },
        { query: 'ZZZQQQ_NOPE', weightPct: 40 },
      ],
    });
    const { impl, calls } = recordingAiFetch(content);
    const harness = await createTestApp({ env: AI_ENV, marketData: stubMarket(), aiFetch: impl });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    await seedAsset(harness, 'AAA');

    const res = await agent
      .post('/api/v1/ai/conglomerate-draft')
      .set(...XRW)
      .send({ prompt: '60% AAA, 40% unicorn dust' });
    expect(res.status).toBe(200);
    const body = aiConglomerateDraftResponseSchema.parse(res.body);

    expect(body.lines).toHaveLength(2); // nothing dropped
    const nope = body.lines.find((l) => l.query === 'ZZZQQQ_NOPE')!;
    expect(nope.asset).toBeNull(); // unresolvable ⇒ flagged
    expect(nope.weightPct).toBe(40); // weight comes from the model
    // Only the configured local endpoint is ever reached.
    expect(calls.every((u) => u.startsWith('http://ollama.test:11434'))).toBe(true);
  });
});

describe('AI features — gating & cap (§13.5 V5-P12 2/2)', () => {
  it('absent provider ⇒ capability disabled and both surfaces refuse (regression)', async () => {
    const harness = await createTestApp({ marketData: stubMarket() }); // no AI env ⇒ unconfigured
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const aaa = await seedAsset(harness, 'AAA');
    await buy(agent, pid, aaa.id);

    // The single client gate reports disabled…
    const cap = aiCapabilityResponseSchema.parse((await agent.get('/api/v1/ai/capability')).body);
    expect(cap.available).toBe(false);

    // …and the server refuses both generation endpoints with the typed 503.
    const insights = await agent
      .post('/api/v1/ai/insights')
      .set(...XRW)
      .send({ portfolioId: pid });
    expect(insights.status).toBe(503);
    expect(insights.body.error.code).toBe('AI_UNAVAILABLE');

    const draft = await agent
      .post('/api/v1/ai/conglomerate-draft')
      .set(...XRW)
      .send({ prompt: 'anything' });
    expect(draft.status).toBe(503);
    expect(draft.body.error.code).toBe('AI_UNAVAILABLE');
  });

  it('enforces the per-user daily cap with the typed 429', async () => {
    const content = JSON.stringify({ lines: [{ query: 'AAA', weightPct: 100 }] });
    const { impl } = recordingAiFetch(content);
    const harness = await createTestApp({
      env: { ...AI_ENV, BT_AI_DAILY_CAP: '1' },
      aiFetch: impl,
    });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const first = await agent
      .post('/api/v1/ai/conglomerate-draft')
      .set(...XRW)
      .send({ prompt: 'all AAA' });
    expect(first.status).toBe(200);

    const second = await agent
      .post('/api/v1/ai/conglomerate-draft')
      .set(...XRW)
      .send({ prompt: 'all AAA' });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('AI_CAP_EXCEEDED');
  });
});
