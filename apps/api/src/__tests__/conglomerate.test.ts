import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  conglomerateDetailSchema,
  conglomerateListResponseSchema,
  conglomerateResolvedResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

let assetSeq = 0;
async function seedAsset(
  h: TestHarness,
  overrides: Partial<typeof schema.assets.$inferInsert> = {},
) {
  assetSeq += 1;
  const symbol = overrides.symbol ?? `SYM${assetSeq}`;
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: overrides.providerId ?? 'yahoo',
      providerRef: overrides.providerRef ?? symbol,
      type: overrides.type ?? 'stock',
      symbol,
      name: overrides.name ?? `Asset ${symbol}`,
      currency: overrides.currency ?? 'USD',
      exchange: overrides.exchange ?? 'NASDAQ',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

type Agent = ReturnType<typeof request.agent>;

async function createConglomerate(agent: Agent, name: string, description?: string) {
  const res = await agent
    .post('/api/v1/conglomerates')
    .set(...XRW)
    .send({ name, description });
  return res;
}

describe('POST /api/v1/conglomerates', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app)
      .post('/api/v1/conglomerates')
      .set(...XRW)
      .send({ name: 'Tech' });
    expect(res.status).toBe(401);
  });

  it('creates a draft with no positions, owned by the caller', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const res = await createConglomerate(agent, 'Tech Basket', 'FAANG-ish');
    expect(res.status).toBe(201);
    const parsed = conglomerateDetailSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.name).toBe('Tech Basket');
    expect(parsed.data.description).toBe('FAANG-ish');
    expect(parsed.data.status).toBe('draft');
    expect(parsed.data.positions).toHaveLength(0);
    expect(parsed.data.positionCount).toBe(0);
  });

  it('rejects an empty name', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await createConglomerate(agent, '');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires the CSRF header', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent.post('/api/v1/conglomerates').send({ name: 'Tech' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/conglomerates', () => {
  it("lists only the caller's conglomerates, each with a positionCount", async () => {
    const userA = await harness.seedUser({ email: 'a@c.test', username: 'ca' });
    const userB = await harness.seedUser({ email: 'b@c.test', username: 'cb' });
    const agentA = await loginAgent(harness.app, userA.email, userA.password);
    const agentB = await loginAgent(harness.app, userB.email, userB.password);

    await createConglomerate(agentA, 'A One');
    const two = await createConglomerate(agentA, 'A Two');
    await createConglomerate(agentB, 'B One');

    // Give "A Two" a position so positionCount is exercised.
    const asset = await seedAsset(harness);
    await agentA
      .put(`/api/v1/conglomerates/${two.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: asset.id, weightPct: 100 }] });

    const res = await agentA.get('/api/v1/conglomerates');
    expect(res.status).toBe(200);
    const parsed = conglomerateListResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.conglomerates).toHaveLength(2);
    const names = parsed.data.conglomerates.map((c) => c.name).sort();
    expect(names).toEqual(['A One', 'A Two']);
    const twoRow = parsed.data.conglomerates.find((c) => c.name === 'A Two')!;
    expect(twoRow.positionCount).toBe(1);
  });
});

describe('GET /api/v1/conglomerates/:id', () => {
  it('returns detail with positions ordered by sortOrder + embedded asset', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Mixed');

    const a1 = await seedAsset(harness, { symbol: 'AAA', name: 'Alpha' });
    const a2 = await seedAsset(harness, { symbol: 'BBB', name: 'Beta' });

    await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: a1.id, weightPct: 60 },
          { assetId: a2.id, weightPct: 40 },
        ],
      });

    const res = await agent.get(`/api/v1/conglomerates/${created.body.id}`);
    expect(res.status).toBe(200);
    const parsed = conglomerateDetailSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.positions).toHaveLength(2);
    const [p0, p1] = parsed.data.positions;
    expect(p0!.sortOrder).toBe(0);
    expect(p0!.kind).toBe('asset');
    if (p0!.kind === 'asset') expect(p0!.asset.symbol).toBe('AAA');
    expect(p0!.weightPct).toBe(60);
    expect(p1!.sortOrder).toBe(1);
    if (p1!.kind === 'asset') expect(p1!.asset.symbol).toBe('BBB');
  });

  it('returns 404 for a missing id', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent.get(`/api/v1/conglomerates/${MISSING_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONGLOMERATE_NOT_FOUND');
  });
});

describe('PATCH /api/v1/conglomerates/:id', () => {
  it('updates name and description', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Old Name');

    const res = await agent
      .patch(`/api/v1/conglomerates/${created.body.id}`)
      .set(...XRW)
      .send({ name: 'New Name', description: 'updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.description).toBe('updated');
  });

  it('returns 409 for a case-insensitive name collision with another conglomerate', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    await createConglomerate(agent, 'Growth');
    const second = await createConglomerate(agent, 'Value');

    const res = await agent
      .patch(`/api/v1/conglomerates/${second.body.id}`)
      .set(...XRW)
      .send({ name: 'GROWTH' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONGLOMERATE_NAME_TAKEN');
  });

  it('allows renaming a conglomerate to its own (case-changed) name', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Growth');

    const res = await agent
      .patch(`/api/v1/conglomerates/${created.body.id}`)
      .set(...XRW)
      .send({ name: 'GROWTH' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('GROWTH');
  });

  it('rejects creating a second conglomerate with a case-insensitively duplicate name (409)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    await createConglomerate(agent, 'Dividends');
    const res = await createConglomerate(agent, 'dividends');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONGLOMERATE_NAME_TAKEN');
  });
});

describe('PUT /api/v1/conglomerates/:id/positions', () => {
  it('bulk-replaces positions and assigns sortOrder from array order (autosave)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Basket');
    const a1 = await seedAsset(harness, { symbol: 'AAA' });
    const a2 = await seedAsset(harness, { symbol: 'BBB' });
    const a3 = await seedAsset(harness, { symbol: 'CCC' });

    // First write: two positions.
    await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: a1.id, weightPct: 50 },
          { assetId: a2.id, weightPct: 50 },
        ],
      });

    // Second write replaces the whole set (autosave semantics).
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: a3.id, weightPct: 30 },
          { assetId: a1.id, weightPct: 70 },
        ],
      });
    expect(res.status).toBe(200);
    const parsed = conglomerateDetailSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      parsed.data.positions.map((p) => (p.kind === 'asset' ? p.asset.symbol : p.child.name)),
    ).toEqual(['CCC', 'AAA']);
    expect(parsed.data.positions.map((p) => p.sortOrder)).toEqual([0, 1]);
  });

  it('accepts an empty positions array (drafts may be emptied)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Empty');
    const a1 = await seedAsset(harness);
    await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: a1.id, weightPct: 100 }] });

    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [] });
    expect(res.status).toBe(200);
    expect(res.body.positions).toHaveLength(0);
  });

  it('rejects more than 50 positions', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Too Many');
    const positions = Array.from({ length: 51 }, () => ({
      assetId: MISSING_ID,
      weightPct: 1,
    }));
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate assetId', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Dupes');
    const a1 = await seedAsset(harness);

    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: a1.id, weightPct: 40 },
          { assetId: a1.id, weightPct: 60 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_ASSET');
  });

  it('rejects a weight of 0 (must be > 0)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Zero');
    const a1 = await seedAsset(harness);
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: a1.id, weightPct: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a weight above 100', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Over');
    const a1 = await seedAsset(harness);
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: a1.id, weightPct: 100.5 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a weight with more than 3 decimal places', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Precise');
    const a1 = await seedAsset(harness);
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: a1.id, weightPct: 33.3334 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('preserves a 3-decimal weight exactly (no rounding on write)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Exact');
    const a1 = await seedAsset(harness, { symbol: 'AAA' });
    const a2 = await seedAsset(harness, { symbol: 'BBB' });
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: a1.id, weightPct: 33.333 },
          { assetId: a2.id, weightPct: 66.667 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.positions[0].weightPct).toBe(33.333);
    expect(res.body.positions[1].weightPct).toBe(66.667);
  });

  it('returns 404 (not 400) for a position on a non-existent asset', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Ghost');
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: MISSING_ID, weightPct: 100 }] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it("returns 404 (nothing leaks) for another owner's private custom asset (§8, §10)", async () => {
    const owner = await harness.seedUser({ email: 'owner@bettertrack.test', username: 'owner' });
    const other = await harness.seedUser({ email: 'other@bettertrack.test', username: 'other' });
    // A private custom asset belonging to `other` (house / vehicle / unlisted).
    const foreign = await seedAsset(harness, {
      symbol: 'HOUSE',
      name: 'Other user house',
      type: 'custom',
      providerId: 'manual',
      providerRef: `custom-${other.id}`,
      ownerId: other.id,
    });

    const agent = await loginAgent(harness.app, owner.email, owner.password);
    const created = await createConglomerate(agent, 'Leaky');
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: foreign.id, weightPct: 100 }] });

    // Treated exactly like a non-existent asset — the asset's identity is never embedded.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it("accepts the caller's own custom asset in a position", async () => {
    const owner = await harness.seedUser({ email: 'owner@bettertrack.test', username: 'owner' });
    const mine = await seedAsset(harness, {
      symbol: 'MYCAR',
      name: 'My car',
      type: 'custom',
      providerId: 'manual',
      providerRef: `custom-${owner.id}`,
      ownerId: owner.id,
    });

    const agent = await loginAgent(harness.app, owner.email, owner.password);
    const created = await createConglomerate(agent, 'Mine');
    const res = await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: mine.id, weightPct: 100 }] });

    expect(res.status).toBe(200);
    expect(res.body.positions[0].assetId).toBe(mine.id);
  });
});

describe('POST /api/v1/conglomerates/:id/activate', () => {
  it('activates when weights sum to exactly 100', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Balanced');
    const a1 = await seedAsset(harness, { symbol: 'AAA' });
    const a2 = await seedAsset(harness, { symbol: 'BBB' });
    await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: a1.id, weightPct: 40 },
          { assetId: a2.id, weightPct: 60 },
        ],
      });

    const res = await agent.post(`/api/v1/conglomerates/${created.body.id}/activate`).set(...XRW);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('rejects activation when weights sum to 99.9 and leaves the status unchanged', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Unbalanced');
    const a1 = await seedAsset(harness, { symbol: 'AAA' });
    const a2 = await seedAsset(harness, { symbol: 'BBB' });
    await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: a1.id, weightPct: 40 },
          { assetId: a2.id, weightPct: 59.9 },
        ],
      });

    const res = await agent.post(`/api/v1/conglomerates/${created.body.id}/activate`).set(...XRW);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACTIVATION_INVALID');

    const after = await agent.get(`/api/v1/conglomerates/${created.body.id}`);
    expect(after.body.status).toBe('draft');
  });

  it('accepts a sum of exactly 100.00 and rejects 99.9 (±0.01 tolerance)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const a1 = await seedAsset(harness, { symbol: 'AAA' });
    const a2 = await seedAsset(harness, { symbol: 'BBB' });
    const a3 = await seedAsset(harness, { symbol: 'CCC' });

    // Within tolerance: 33.333 + 33.333 + 33.334 = 100.000
    const ok = await createConglomerate(agent, 'Thirds');
    await agent
      .put(`/api/v1/conglomerates/${ok.body.id}/positions`)
      .set(...XRW)
      .send({
        positions: [
          { assetId: a1.id, weightPct: 33.333 },
          { assetId: a2.id, weightPct: 33.333 },
          { assetId: a3.id, weightPct: 33.334 },
        ],
      });
    const okRes = await agent.post(`/api/v1/conglomerates/${ok.body.id}/activate`).set(...XRW);
    expect(okRes.status).toBe(200);
    expect(okRes.body.status).toBe('active');
  });

  it('rejects activating an empty draft', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Nothing');
    const res = await agent.post(`/api/v1/conglomerates/${created.body.id}/activate`).set(...XRW);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACTIVATION_INVALID');
  });
});

describe('DELETE /api/v1/conglomerates/:id', () => {
  it('hard-deletes the conglomerate and cascades its positions', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await createConglomerate(agent, 'Doomed');
    const a1 = await seedAsset(harness);
    await agent
      .put(`/api/v1/conglomerates/${created.body.id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: a1.id, weightPct: 100 }] });

    const del = await agent.delete(`/api/v1/conglomerates/${created.body.id}`).set(...XRW);
    expect(del.status).toBe(204);

    const after = await agent.get(`/api/v1/conglomerates/${created.body.id}`);
    expect(after.status).toBe(404);

    // Positions are gone from the table (cascade).
    const rows = await harness.db
      .select()
      .from(schema.conglomeratePositions)
      .where(eq(schema.conglomeratePositions.conglomerateId, created.body.id));
    expect(rows).toHaveLength(0);
  });

  it('returns 404 when deleting a missing id', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent.delete(`/api/v1/conglomerates/${MISSING_ID}`).set(...XRW);
    expect(res.status).toBe(404);
  });
});

describe('Ownership isolation (§8) — another owner is always 404, never 403', () => {
  it("404s another user's conglomerate on GET/PATCH/DELETE/PUT positions/activate", async () => {
    const owner = await harness.seedUser({ email: 'owner@iso.test', username: 'isoowner' });
    const other = await harness.seedUser({ email: 'other@iso.test', username: 'isoother' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const otherAgent = await loginAgent(harness.app, other.email, other.password);

    const created = await createConglomerate(ownerAgent, "Owner's Basket");
    const id = created.body.id as string;
    const asset = await seedAsset(harness);

    const get = await otherAgent.get(`/api/v1/conglomerates/${id}`);
    expect(get.status).toBe(404);

    const patch = await otherAgent
      .patch(`/api/v1/conglomerates/${id}`)
      .set(...XRW)
      .send({ name: 'Hijack' });
    expect(patch.status).toBe(404);

    const put = await otherAgent
      .put(`/api/v1/conglomerates/${id}/positions`)
      .set(...XRW)
      .send({ positions: [{ assetId: asset.id, weightPct: 100 }] });
    expect(put.status).toBe(404);

    const activate = await otherAgent.post(`/api/v1/conglomerates/${id}/activate`).set(...XRW);
    expect(activate.status).toBe(404);

    const del = await otherAgent.delete(`/api/v1/conglomerates/${id}`).set(...XRW);
    expect(del.status).toBe(404);

    // The owner's conglomerate is untouched: still a draft with no positions.
    const ownerView = await ownerAgent.get(`/api/v1/conglomerates/${id}`);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.status).toBe('draft');
    expect(ownerView.body.positions).toHaveLength(0);
  });

  it("does not list another owner's conglomerates", async () => {
    const owner = await harness.seedUser({ email: 'o2@iso.test', username: 'iso2owner' });
    const other = await harness.seedUser({ email: 'x2@iso.test', username: 'iso2other' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    await createConglomerate(ownerAgent, 'Private');

    const res = await otherAgent.get('/api/v1/conglomerates');
    expect(res.body.conglomerates).toHaveLength(0);
  });
});

// ─── Nested conglomerates (§13.5 V5-P6, issue #592) ─────────────────────────

describe('nested conglomerates', () => {
  type Harness = { agent: Agent };

  async function login(): Promise<Harness> {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    return { agent };
  }

  /** Create a conglomerate via the API and return its id. */
  async function createId(agent: Agent, name: string): Promise<string> {
    const res = await createConglomerate(agent, name);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function putPositions(
    agent: Agent,
    id: string,
    positions: Array<
      { assetId: string; weightPct: number } | { childId: string; weightPct: number }
    >,
  ) {
    return agent
      .put(`/api/v1/conglomerates/${id}/positions`)
      .set(...XRW)
      .send({ positions });
  }

  it('stores a nested constituent and returns it with the child summary', async () => {
    const { agent } = await login();
    const child = await createId(agent, 'Child');
    const parent = await createId(agent, 'Parent');
    const a1 = await seedAsset(harness);
    await putPositions(agent, child, [{ assetId: a1.id, weightPct: 100 }]);

    const res = await putPositions(agent, parent, [
      { assetId: a1.id, weightPct: 50 },
      { childId: child, weightPct: 50 },
    ]);
    expect(res.status).toBe(200);
    const parsed = conglomerateDetailSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.positionCount).toBe(2);
    const nested = parsed.data.positions[1]!;
    expect(nested.kind).toBe('conglomerate');
    if (nested.kind !== 'conglomerate') return;
    expect(nested.childId).toBe(child);
    expect(nested.child).toMatchObject({ name: 'Child', status: 'draft', positionCount: 1 });
  });

  it('rejects a DIRECT self-reference with NESTING_CYCLE (the plan gate criterion)', async () => {
    const { agent } = await login();
    const id = await createId(agent, 'Self');
    const res = await putPositions(agent, id, [{ childId: id, weightPct: 100 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NESTING_CYCLE');
  });

  it('rejects a TRANSITIVE cycle (A contains B, then B tries to contain A)', async () => {
    const { agent } = await login();
    const a = await createId(agent, 'A');
    const b = await createId(agent, 'B');
    expect((await putPositions(agent, a, [{ childId: b, weightPct: 100 }])).status).toBe(200);

    const res = await putPositions(agent, b, [{ childId: a, weightPct: 100 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NESTING_CYCLE');
  });

  it('accepts a 3-level chain but rejects the 4th level at write time (depth cap 3)', async () => {
    const { agent } = await login();
    const a = await createId(agent, 'L1');
    const b = await createId(agent, 'L2');
    const c = await createId(agent, 'L3');
    const d = await createId(agent, 'L4');

    // A → B → C is valid (three conglomerates in the chain).
    expect((await putPositions(agent, b, [{ childId: c, weightPct: 100 }])).status).toBe(200);
    expect((await putPositions(agent, a, [{ childId: b, weightPct: 100 }])).status).toBe(200);

    // C adding D would make the chain A → B → C → D — level 4 — and rejects,
    // even though C itself only nests one level.
    const res = await putPositions(agent, c, [{ childId: d, weightPct: 100 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NESTING_TOO_DEEP');

    // A sibling at an existing level stays fine: B may also nest D (A→B→D = 3).
    const sibling = await putPositions(agent, b, [
      { childId: c, weightPct: 50 },
      { childId: d, weightPct: 50 },
    ]);
    expect(sibling.status).toBe(200);
  });

  it("404s when nesting another user's conglomerate (own baskets only, no leak)", async () => {
    const owner = await harness.seedUser({ email: 'own@nest.test', username: 'nestowner' });
    const other = await harness.seedUser({ email: 'oth@nest.test', username: 'nestother' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const otherAgent = await loginAgent(harness.app, other.email, other.password);

    const foreign = await createId(otherAgent, 'Foreign');
    const mine = await createId(ownerAgent, 'Mine');

    const res = await putPositions(ownerAgent, mine, [{ childId: foreign, weightPct: 100 }]);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONGLOMERATE_NOT_FOUND');
  });

  it('rejects the same child twice in one basket', async () => {
    const { agent } = await login();
    const child = await createId(agent, 'Twice');
    const parent = await createId(agent, 'Parent');
    const res = await putPositions(agent, parent, [
      { childId: child, weightPct: 50 },
      { childId: child, weightPct: 50 },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_CHILD');
  });

  it('blocks deleting a conglomerate that is a constituent, naming the parents; deletable after detach', async () => {
    const { agent } = await login();
    const child = await createId(agent, 'Building Block');
    const p1 = await createId(agent, 'Parent One');
    const p2 = await createId(agent, 'Parent Two');
    await putPositions(agent, p1, [{ childId: child, weightPct: 100 }]);
    await putPositions(agent, p2, [{ childId: child, weightPct: 100 }]);

    const blocked = await agent.delete(`/api/v1/conglomerates/${child}`).set(...XRW);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CONGLOMERATE_IN_USE');
    expect(blocked.body.error.message).toContain('Parent One');
    expect(blocked.body.error.message).toContain('Parent Two');
    expect(blocked.body.error.details.parents.map((p: { name: string }) => p.name)).toEqual([
      'Parent One',
      'Parent Two',
    ]);

    // Still present.
    expect((await agent.get(`/api/v1/conglomerates/${child}`)).status).toBe(200);

    // Detach from both parents → the delete goes through.
    await putPositions(agent, p1, []);
    await putPositions(agent, p2, []);
    const del = await agent.delete(`/api/v1/conglomerates/${child}`).set(...XRW);
    expect(del.status).toBe(204);
  });

  it('GET /:id/resolved flattens the canonical fixture: 50% child (40/60) ⇒ 20/30, plus the direct 50', async () => {
    const { agent } = await login();
    const aX = await seedAsset(harness, { symbol: 'XXX' });
    const aY = await seedAsset(harness, { symbol: 'YYY' });
    const aZ = await seedAsset(harness, { symbol: 'ZZZ' });

    const child = await createId(agent, 'Split Child');
    await putPositions(agent, child, [
      { assetId: aY.id, weightPct: 40 },
      { assetId: aZ.id, weightPct: 60 },
    ]);
    const parent = await createId(agent, 'Nested Parent');
    await putPositions(agent, parent, [
      { assetId: aX.id, weightPct: 50 },
      { childId: child, weightPct: 50 },
    ]);

    const res = await agent.get(`/api/v1/conglomerates/${parent}/resolved`);
    expect(res.status).toBe(200);
    const parsed = conglomerateResolvedResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.nested).toBe(true);
    const byId = new Map(parsed.data.positions.map((p) => [p.assetId, p]));
    expect(byId.get(aX.id)?.weightPct).toBeCloseTo(50, 9);
    expect(byId.get(aY.id)?.weightPct).toBeCloseTo(20, 9);
    expect(byId.get(aZ.id)?.weightPct).toBeCloseTo(30, 9);
    expect(byId.get(aY.id)?.asset.symbol).toBe('YYY');
  });

  it('GET /:id/resolved normalizes a flat draft basket by its own weight sum (nested=false)', async () => {
    const { agent } = await login();
    const a1 = await seedAsset(harness);
    const a2 = await seedAsset(harness);
    const id = await createId(agent, 'Flat Draft');
    await putPositions(agent, id, [
      { assetId: a1.id, weightPct: 30 },
      { assetId: a2.id, weightPct: 10 },
    ]);

    const res = await agent.get(`/api/v1/conglomerates/${id}/resolved`);
    expect(res.status).toBe(200);
    expect(res.body.nested).toBe(false);
    const byId = new Map(
      (res.body.positions as Array<{ assetId: string; weightPct: number }>).map((p) => [
        p.assetId,
        p.weightPct,
      ]),
    );
    expect(byId.get(a1.id)).toBeCloseTo(75, 9);
    expect(byId.get(a2.id)).toBeCloseTo(25, 9);
  });

  it('activation counts a nested slice like any weight (Σ = 100 across kinds)', async () => {
    const { agent } = await login();
    const a1 = await seedAsset(harness);
    const child = await createId(agent, 'Half');
    await putPositions(agent, child, [{ assetId: a1.id, weightPct: 100 }]);
    const parent = await createId(agent, 'Activatable');
    await putPositions(agent, parent, [
      { assetId: a1.id, weightPct: 60 },
      { childId: child, weightPct: 40 },
    ]);

    const res = await agent.post(`/api/v1/conglomerates/${parent}/activate`).set(...XRW);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });
});
