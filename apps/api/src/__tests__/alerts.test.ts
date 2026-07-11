import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  alertListResponseSchema,
  alertSchema,
  type AlertKind,
  type Quote,
} from '@bettertrack/contracts';

import { createAlertRepository } from '../data/repositories/alertRepository';
import * as schema from '../data/schema';
import {
  alertConditionMet,
  alertFireLockKey,
  alertFireWindowStart,
  runAlertsEvaluation,
} from '../services/alerts/alertEvaluator';
import { createStubMarketData, type StubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import type { NotificationCenter } from '../services/notifications/notificationCenter';
import type { DispatchableEvent } from '../services/notifications/notificationDispatcher';
import type { Logger } from '../logger';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({
    // Ref-price capture (the *_from_ref kinds) reads the current quote at create.
    marketData: createStubMarketData({ quote: () => quoteResult(100) }),
  });
});

function quoteResult(price: number, dayChangePct: number | null = null) {
  const value: Quote = { price, currency: 'USD', dayChangePct, asOf: '2026-07-07T00:00:00.000Z' };
  return { value, stale: false, asOf: 0 };
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

type Agent = ReturnType<typeof request.agent>;

async function seedAsset(
  h: TestHarness,
  overrides: Partial<typeof schema.assets.$inferInsert> = {},
) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: overrides.providerId ?? 'yahoo',
      providerRef: overrides.providerRef ?? 'AAPL',
      type: overrides.type ?? 'stock',
      symbol: overrides.symbol ?? 'AAPL',
      name: overrides.name ?? 'Apple Inc.',
      currency: overrides.currency ?? 'USD',
      exchange: overrides.exchange ?? 'NASDAQ',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('failed to seed asset');
  return row;
}

async function createAlert(
  agent: Agent,
  body: { assetId: string; kind: AlertKind; threshold: number; repeat?: boolean },
) {
  return agent
    .post('/api/v1/alerts')
    .set(...XRW)
    .send(body);
}

/** Recording notification center (#368) — captures what the evaluator emits. */
function recordingCenter(): NotificationCenter & { published: DispatchableEvent[] } {
  const published: DispatchableEvent[] = [];
  return {
    published,
    async emit(event) {
      published.push(event);
      return true;
    },
  };
}

interface EvaluatorSetup {
  bus: ReturnType<typeof recordingCenter>;
  market: StubMarketData;
  run: (nowMs?: number) => Promise<{ evaluated: number; fired: number }>;
}

function evaluator(h: TestHarness, market: StubMarketData, nowMs: number): EvaluatorSetup {
  const bus = recordingCenter();
  const alertRepo = createAlertRepository(h.db);
  return {
    bus,
    market,
    run: (at = nowMs) =>
      runAlertsEvaluation({
        alertRepo,
        marketData: market,
        redis: h.ctx.redis,
        notify: bus,
        logger: silentLogger,
        now: () => at,
      }),
  };
}

// ─── pure predicate ──────────────────────────────────────────────────────────

describe('alertConditionMet (§14 rule predicate)', () => {
  it('price_above / price_below trigger at or past the threshold', () => {
    const base = { refPrice: null, dayChangePct: null } as const;
    expect(alertConditionMet({ kind: 'price_above', threshold: 100, price: 100, ...base })).toBe(
      true,
    );
    expect(alertConditionMet({ kind: 'price_above', threshold: 100, price: 99, ...base })).toBe(
      false,
    );
    expect(alertConditionMet({ kind: 'price_below', threshold: 100, price: 100, ...base })).toBe(
      true,
    );
    expect(alertConditionMet({ kind: 'price_below', threshold: 100, price: 101, ...base })).toBe(
      false,
    );
  });

  it('pct_up/down_from_ref measure against the captured reference', () => {
    const d = { dayChangePct: null } as const;
    expect(
      alertConditionMet({
        kind: 'pct_up_from_ref',
        threshold: 10,
        refPrice: 100,
        price: 110,
        ...d,
      }),
    ).toBe(true);
    expect(
      alertConditionMet({
        kind: 'pct_up_from_ref',
        threshold: 10,
        refPrice: 100,
        price: 109,
        ...d,
      }),
    ).toBe(false);
    expect(
      alertConditionMet({
        kind: 'pct_down_from_ref',
        threshold: 10,
        refPrice: 100,
        price: 90,
        ...d,
      }),
    ).toBe(true);
    // No reference captured ⇒ never fires.
    expect(
      alertConditionMet({
        kind: 'pct_up_from_ref',
        threshold: 10,
        refPrice: null,
        price: 999,
        ...d,
      }),
    ).toBe(false);
  });

  it('pct_day_up/down use the provider day-change and no-op when it is missing', () => {
    const r = { refPrice: null } as const;
    expect(
      alertConditionMet({ kind: 'pct_day_up', threshold: 5, price: 1, dayChangePct: 5, ...r }),
    ).toBe(true);
    expect(
      alertConditionMet({ kind: 'pct_day_down', threshold: 5, price: 1, dayChangePct: -6, ...r }),
    ).toBe(true);
    expect(
      alertConditionMet({ kind: 'pct_day_down', threshold: 5, price: 1, dayChangePct: -4, ...r }),
    ).toBe(false);
    expect(
      alertConditionMet({ kind: 'pct_day_up', threshold: 5, price: 1, dayChangePct: null, ...r }),
    ).toBe(false);
  });
});

// ─── CRUD API ────────────────────────────────────────────────────────────────

describe('alerts CRUD (§14)', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .get('/api/v1/alerts')
      .set(...XRW);
    expect(res.status).toBe(401);
  });

  it('creates every kind and captures a reference price only for the *_from_ref kinds', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);

    const kinds: AlertKind[] = [
      'price_above',
      'price_below',
      'pct_up_from_ref',
      'pct_down_from_ref',
      'pct_day_up',
      'pct_day_down',
    ];
    for (const kind of kinds) {
      const res = await createAlert(agent, { assetId: asset.id, kind, threshold: 5 });
      expect(res.status).toBe(201);
      const parsed = alertSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(res.body.kind).toBe(kind);
      expect(res.body.status).toBe('active');
      // Reference captured (100 from the stub) only for the from-ref kinds.
      if (kind === 'pct_up_from_ref' || kind === 'pct_down_from_ref') {
        expect(res.body.refPrice).toBe(100);
      } else {
        expect(res.body.refPrice).toBeNull();
      }
    }

    const list = await agent.get('/api/v1/alerts');
    expect(list.status).toBe(200);
    expect(alertListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.items).toHaveLength(6);
  });

  it('rejects an alert on an asset the caller cannot see', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await createAlert(agent, {
      assetId: MISSING_ID,
      kind: 'price_above',
      threshold: 1,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it('updates threshold/repeat and re-arms a fired alert', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const asset = await seedAsset(harness);
    const created = await createAlert(agent, {
      assetId: asset.id,
      kind: 'price_above',
      threshold: 100,
    });
    const id = created.body.id as string;

    const patched = await agent
      .patch(`/api/v1/alerts/${id}`)
      .set(...XRW)
      .send({ threshold: 150, repeat: true });
    expect(patched.status).toBe(200);
    expect(patched.body.threshold).toBe(150);
    expect(patched.body.repeat).toBe(true);

    // Simulate a fire, then re-arm.
    await createAlertRepository(harness.db).recordTriggered(id, 'triggered', new Date());
    const rearmed = await agent
      .post(`/api/v1/alerts/${id}/rearm`)
      .set(...XRW)
      .send();
    expect(rearmed.status).toBe(200);
    expect(rearmed.body.status).toBe('active');
  });

  it('scopes every mutation to the owner (a foreign id is a 404)', async () => {
    const alice = await harness.seedUser({ email: 'a@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'b@bt.test', username: 'bob' });
    const asset = await seedAsset(harness);
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    const created = await createAlert(aliceAgent, {
      assetId: asset.id,
      kind: 'price_above',
      threshold: 1,
    });
    const id = created.body.id as string;

    expect(
      (
        await bobAgent
          .patch(`/api/v1/alerts/${id}`)
          .set(...XRW)
          .send({ threshold: 2 })
      ).status,
    ).toBe(404);
    expect(
      (
        await bobAgent
          .post(`/api/v1/alerts/${id}/rearm`)
          .set(...XRW)
          .send()
      ).status,
    ).toBe(404);
    expect((await bobAgent.delete(`/api/v1/alerts/${id}`).set(...XRW)).status).toBe(404);
    // Bob never sees Alice's alert.
    expect((await bobAgent.get('/api/v1/alerts')).body.items).toHaveLength(0);

    // Alice can delete her own.
    expect((await aliceAgent.delete(`/api/v1/alerts/${id}`).set(...XRW)).status).toBe(204);
  });
});

// ─── minute evaluator ────────────────────────────────────────────────────────

describe('alerts evaluator (§14)', () => {
  const NOW = Date.parse('2026-07-07T12:34:56.000Z');

  it('fires a met one-shot exactly once, then never again until re-armed', async () => {
    const user = await harness.seedUser();
    const asset = await seedAsset(harness);
    const alertRepo = createAlertRepository(harness.db);
    const alert = await alertRepo.create({
      userId: user.id,
      assetId: asset.id,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });

    const market = createStubMarketData({ quote: () => quoteResult(150) });
    const setup = evaluator(harness, market, NOW);

    const first = await setup.run();
    expect(first.fired).toBe(1);
    expect(setup.bus.published.map((e) => e.type)).toEqual(['alert.triggered']);

    // Flipped to triggered and dropped from the active set.
    expect((await alertRepo.findByIdForUser(user.id, alert.id))?.status).toBe('triggered');

    // A later run (new window) does not re-fire the one-shot.
    const second = await setup.run(NOW + 120_000);
    expect(second.fired).toBe(0);
    expect(setup.bus.published).toHaveLength(1);
  });

  it('reads the cached quote once per asset, however many alerts reference it', async () => {
    const user = await harness.seedUser();
    const asset = await seedAsset(harness);
    const alertRepo = createAlertRepository(harness.db);
    await alertRepo.create({
      userId: user.id,
      assetId: asset.id,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });
    await alertRepo.create({
      userId: user.id,
      assetId: asset.id,
      kind: 'price_below',
      threshold: 200,
      refPrice: null,
      repeat: false,
    });

    const market = createStubMarketData({ quote: () => quoteResult(150) });
    const setup = evaluator(harness, market, NOW);
    const result = await setup.run();

    expect(result.evaluated).toBe(2);
    expect(result.fired).toBe(2);
    // Exactly one upstream/cache read for the single shared asset.
    expect(market.calls.quote).toBe(1);
  });

  it('repeat alerts honour the 24 h cooldown', async () => {
    const user = await harness.seedUser();
    const asset = await seedAsset(harness);
    const alertRepo = createAlertRepository(harness.db);
    const alert = await alertRepo.create({
      userId: user.id,
      assetId: asset.id,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: true,
    });

    const market = createStubMarketData({ quote: () => quoteResult(150) });
    const setup = evaluator(harness, market, NOW);

    expect((await setup.run()).fired).toBe(1);
    // Stays active (repeat), so it is re-evaluated…
    expect((await alertRepo.findByIdForUser(user.id, alert.id))?.status).toBe('active');
    // …but within 24 h it does not re-fire.
    expect((await setup.run(NOW + 6 * 60 * 60 * 1000)).fired).toBe(0);
    // After 24 h it fires again.
    expect((await setup.run(NOW + 25 * 60 * 60 * 1000)).fired).toBe(1);
    expect(setup.bus.published).toHaveLength(2);
  });

  it('fires once per trigger window even under concurrent/repeated evaluator runs', async () => {
    const user = await harness.seedUser();
    const asset = await seedAsset(harness);
    const alertRepo = createAlertRepository(harness.db);
    const alert = await alertRepo.create({
      userId: user.id,
      assetId: asset.id,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      // repeat so persisted status alone would NOT stop a double-fire — the Redis
      // (alert, window) lock is what makes this idempotent.
      repeat: true,
    });

    const market = createStubMarketData({ quote: () => quoteResult(150) });
    const setup = evaluator(harness, market, NOW);

    // Two evaluator runs racing in the same minute window.
    const [a, b] = await Promise.all([setup.run(), setup.run()]);
    expect(a.fired + b.fired).toBe(1);
    expect(setup.bus.published.filter((e) => e.type === 'alert.triggered')).toHaveLength(1);

    // The (alert, window) idempotency key is set.
    const key = alertFireLockKey(alert.id, alertFireWindowStart(NOW));
    expect(await harness.ctx.redis.get(key)).toBe('1');
  });
});

// ─── matrix delivery ─────────────────────────────────────────────────────────

describe('alert.triggered delivery through the notification matrix (§6.10, §14)', () => {
  const NOW_ISO = '2026-07-07T12:34:00.000Z';

  async function makeFiredAlert(kind: AlertKind = 'price_above') {
    const user = await harness.seedUser();
    const asset = await seedAsset(harness);
    const alert = await createAlertRepository(harness.db).create({
      userId: user.id,
      assetId: asset.id,
      kind,
      threshold: 100,
      refPrice: null,
      repeat: false,
    });
    return { user, asset, alert };
  }

  it('writes an in-app bell row, deduped per (user, trigger window)', async () => {
    const { user, asset, alert } = await makeFiredAlert();

    const event = {
      type: 'alert.triggered' as const,
      userId: user.id,
      alertId: alert.id,
      assetId: asset.id,
      occurredAt: NOW_ISO,
    };
    await harness.ctx.notificationDispatcher.dispatch(event);
    // Redelivery of the same fire is a no-op (same event key).
    await harness.ctx.notificationDispatcher.dispatch(event);

    const rows = await harness.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('alert.triggered');
    expect(rows[0]!.title).toBe('Price alert: AAPL');
    expect(rows[0]!.body).toContain('AAPL rose above 100 USD');
  });

  it('honours the per-type email routing (muted email ⇒ no email, in-app still lands)', async () => {
    const sent: { to: string; subject: string }[] = [];
    const harnessWithEmail = await createTestApp({
      env: {
        SMTP_HOST: 'smtp.test',
        SMTP_PORT: '587',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        SMTP_FROM: 'BetterTrack <no-reply@bt.test>',
      },
      emailTransport: {
        async send(mail) {
          sent.push({ to: mail.to, subject: mail.subject });
        },
      },
      marketData: createStubMarketData({ quote: () => quoteResult(100) }),
    });

    const user = await harnessWithEmail.seedUser();
    const asset = await (async () => {
      const [row] = await harnessWithEmail.db
        .insert(schema.assets)
        .values({
          providerId: 'yahoo',
          providerRef: 'AAPL',
          type: 'stock',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          currency: 'USD',
        })
        .returning();
      return row!;
    })();
    const alert = await createAlertRepository(harnessWithEmail.db).create({
      userId: user.id,
      assetId: asset.id,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });

    const dispatch = (occurredAt: string) =>
      harnessWithEmail.ctx.notificationDispatcher.dispatch({
        type: 'alert.triggered',
        userId: user.id,
        alertId: alert.id,
        assetId: asset.id,
        occurredAt,
      });

    // Default matrix (email on) → an email is sent.
    await dispatch('2026-07-07T10:00:00.000Z');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Price alert: AAPL');

    // Mute the email channel for alert.triggered, keep in-app.
    await harnessWithEmail.ctx.notificationSettings.update(user.id, {
      matrix: { 'alert.triggered': { inapp: true, email: false, push: true, webpush: true } },
    });
    await dispatch('2026-07-07T11:00:00.000Z');
    expect(sent).toHaveLength(1); // no new email

    const rows = await harnessWithEmail.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, user.id));
    expect(rows).toHaveLength(2); // both fires still produced a bell row
  });
});
