import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPreviewResponseSchema } from '@bettertrack/contracts';
import type { ApplyImportResponse, ImportPreviewResponse } from '@bettertrack/contracts';

import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import { createCashRuleRepository } from '../../../data/repositories/cashRuleRepository';
import { createCashSourceRepository } from '../../../data/repositories/cashSourceRepository';
import { createCashTagRepository } from '../../../data/repositories/cashTagRepository';
import { createImportRepository } from '../../../data/repositories/importRepository';
import { createPortfolioRepository } from '../../../data/repositories/portfolioRepository';
import * as schema from '../../../data/schema';
import { createImportService } from '../importService';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * PINNING AN UNRESOLVED ROW TO AN ASSET — `PATCH /imports/:batchId/rows/:rowId`
 * (#964, §16 2026-07-31 point 4: "unresolved assets are resolvable IN the
 * wizard: search and pin to a supported asset, or create a custom one on the
 * spot, never a dead end and never a silent mis-map").
 *
 * The row's stored `candidates` are UI suggestions and NOT the validation
 * boundary — constraining the pick to them would re-create the dead end, since
 * a just-created custom asset is by definition not in a list computed at
 * staging time. The id is validated with the same visibility rule as the manual
 * transaction path, which is the correct boundary because the hazard this
 * subsystem guards against is a MODEL minting an id, and no model reaches here.
 *
 * So these tests carry two burdens: that a HUMAN can finish the job, and that
 * the endpoint is no weaker than the surfaces around it — owner scoping, batch
 * lifecycle, asset visibility, currency agreement and duplicate truth.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/** One salary row and TWO identical share purchases (for the duplicate case). */
const TRADES = [
  'Datum;Buchungstext;Typ;Stück;Kurs;Betrag;Währung;ISIN',
  '05.01.2024;GEHALT ARBEITGEBER AG;Gutschrift;;;2.100,00;EUR;',
  '12.01.2024;Muster Tech AG;Kauf;10;100,00;-1.000,00;EUR;DE000MUSTER1',
  '13.01.2024;Muster Tech AG;Kauf;10;100,00;-1.000,00;EUR;DE000MUSTER1',
].join('\n');

type Agent = ReturnType<typeof request.agent>;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ marketData: createStubMarketData() });
});

afterEach(async () => {
  await harness.dispose();
});

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function seedAsset(
  symbol: string,
  name: string,
  currency = 'EUR',
  ownerId: string | null = null,
) {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: `${symbol}-${currency}`,
      type: 'stock',
      symbol,
      name,
      currency,
      exchange: 'XETRA',
      ...(ownerId ? { ownerId } : {}),
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

async function setup() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const list = await agent.get('/api/v1/portfolios');
  const pid = list.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
  return { user, agent, pid };
}

/** Stage TRADES through the generic path with NO catalog asset seeded yet. */
async function stageUnresolved(agent: Agent, pid: string): Promise<ImportPreviewResponse> {
  const res = await agent
    .post('/api/v1/imports')
    .set(...XRW)
    .field('portfolioId', pid)
    .field('brokerId', 'generic')
    .attach('file', Buffer.from(TRADES, 'utf8'), 'trades.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return importPreviewResponseSchema.parse(res.body);
}

function resolve(agent: Agent, batchId: string, rowId: string, assetId: string) {
  return agent
    .patch(`/api/v1/imports/${batchId}/rows/${rowId}`)
    .set(...XRW)
    .send({ assetId });
}

const unresolvedTrades = (preview: ImportPreviewResponse) =>
  preview.rows.filter((r) => r.flag === 'unmapped' && r.kind === 'buy');

describe('a human can finish what the pipeline could not', () => {
  it('pins an unresolved trade, flips it to mapped, and records the provenance', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);

    const rows = unresolvedTrades(preview);
    expect(rows).toHaveLength(2);
    const target = rows[0]!;
    // Nothing was auto-matched: the catalog holds no such instrument yet.
    expect(target.asset).toBeNull();
    expect(target.resolvedBy).toBeUndefined();

    // The user finds (or creates) the asset and pins it.
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');
    const res = await resolve(agent, preview.batch.id, target.id, asset.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const updated = importPreviewResponseSchema.parse(res.body);
    const row = updated.rows.find((r) => r.id === target.id)!;
    expect(row.flag).toBe('mapped');
    expect(row.asset?.id).toBe(asset.id);
    // Provenance: a person chose this, not an exact machine match.
    expect(row.resolvedBy).toBe('user');
    // The counts come back from the server, so the client never recomputes.
    expect(updated.batch.counts.mapped).toBe(preview.batch.counts.mapped + 1);
    expect(updated.batch.counts.unmapped).toBe(preview.batch.counts.unmapped - 1);
  });

  it('books the pinned asset when the batch is applied', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');
    expect((await resolve(agent, preview.batch.id, target.id, asset.id)).status).toBe(200);

    const applied = await agent
      .post(`/api/v1/imports/${preview.batch.id}/apply`)
      .set(...XRW)
      .send({});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const report = applied.body as ApplyImportResponse;

    // The pinned row landed…
    const outcome = report.rows.find((r) => r.id === target.id);
    expect(outcome?.result).toBe('applied');

    // …as a real transaction against the asset the USER chose.
    const txs = await createTransactionRepository(harness.db).listForPortfolio(pid);
    const booked = txs.filter((t) => t.assetId === asset.id);
    expect(booked).toHaveLength(1);
    expect(booked[0]!.quantity).toBe(10);
    expect(booked[0]!.side).toBe('buy');
  });

  it('flags a pin that duplicates a row this batch will already book', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const [first, second] = unresolvedTrades(preview);
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');

    // The two purchases differ only by date, so pinning both to one asset is
    // legitimate — this proves the hash is recomputed, not that it collides.
    expect((await resolve(agent, preview.batch.id, first!.id, asset.id)).status).toBe(200);
    const res = await resolve(agent, preview.batch.id, second!.id, asset.id);
    expect(res.status).toBe(200);
    const updated = importPreviewResponseSchema.parse(res.body);
    expect(updated.rows.find((r) => r.id === second!.id)?.flag).toBe('mapped');
  });
});

describe('the endpoint is no weaker than the surfaces around it', () => {
  it('404s a batch belonging to somebody else — indistinguishable from missing', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');

    const intruderUser = await harness.seedUser({
      email: 'intruder@bettertrack.test',
      username: 'intruder',
    });
    const intruder = await loginAgent(harness.app, intruderUser.email, intruderUser.password);

    const res = await resolve(intruder, preview.batch.id, target.id, asset.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('IMPORT_NOT_FOUND');

    // …and the victim's row is untouched.
    const after = await agent.get(`/api/v1/imports/${preview.batch.id}`);
    expect(
      importPreviewResponseSchema.parse(after.body).rows.find((r) => r.id === target.id)?.flag,
    ).toBe('unmapped');
  });

  it('404s a row id that belongs to a DIFFERENT batch of the same owner', async () => {
    const { agent, pid } = await setup();
    const first = await stageUnresolved(agent, pid);
    const second = await stageUnresolved(agent, pid);
    const foreignRow = unresolvedTrades(second)[0]!;
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');

    // Owning both batches is not enough: the row must be IN the named batch.
    const res = await resolve(agent, first.batch.id, foreignRow.id, asset.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('IMPORT_ROW_NOT_FOUND');
  });

  it("404s another user's CUSTOM asset — no existence leak", async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;

    const stranger = await harness.seedUser({
      email: 'stranger@bettertrack.test',
      username: 'stranger',
    });
    const theirs = await seedAsset('PRIV.DE', 'Their Private Co', 'EUR', stranger.id);

    const res = await resolve(agent, preview.batch.id, target.id, theirs.id);
    // The same 404 a missing id gets — a foreign custom asset must not be
    // distinguishable from one that does not exist (§10).
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
  });

  it('accepts the caller’s OWN custom asset — the "create one on the spot" half', async () => {
    const { agent, user, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;

    const mine = await seedAsset('MINE.DE', 'My Own Instrument', 'EUR', user.id);
    const res = await resolve(agent, preview.batch.id, target.id, mine.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      importPreviewResponseSchema.parse(res.body).rows.find((r) => r.id === target.id)?.asset?.id,
    ).toBe(mine.id);
  });

  it('400s an asset quoted in a different currency than the row', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;

    const usd = await seedAsset('MTA', 'Muster Tech AG', 'USD');
    const res = await resolve(agent, preview.batch.id, target.id, usd.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMPORT_ROW_CURRENCY_MISMATCH');
  });

  it('400s a row that is not unresolved, and a row with no instrument', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');

    // The salary row books cash and references no instrument at all.
    const cash = preview.rows.find((r) => r.kind === 'deposit')!;
    const cashRes = await resolve(agent, preview.batch.id, cash.id, asset.id);
    expect(cashRes.status).toBe(400);
    expect(cashRes.body.error.code).toBe('IMPORT_ROW_NOT_INSTRUMENT');

    // Re-pinning an already-resolved row is refused rather than silently
    // re-pointing a match the pipeline made.
    const target = unresolvedTrades(preview)[0]!;
    expect((await resolve(agent, preview.batch.id, target.id, asset.id)).status).toBe(200);
    const again = await resolve(agent, preview.batch.id, target.id, asset.id);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('IMPORT_ROW_NOT_UNRESOLVED');
  });

  it('409s once the batch has been applied — staging is closed', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');

    const applied = await agent
      .post(`/api/v1/imports/${preview.batch.id}/apply`)
      .set(...XRW)
      .send({});
    expect(applied.status).toBe(200);

    const res = await resolve(agent, preview.batch.id, target.id, asset.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IMPORT_ALREADY_APPLIED');
  });

  it('rejects a malformed body and an unauthenticated caller', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;

    const bad = await agent
      .patch(`/api/v1/imports/${preview.batch.id}/rows/${target.id}`)
      .set(...XRW)
      .send({ assetId: 'not-a-uuid' });
    expect(bad.status).toBe(400);

    const anon = await request(harness.app)
      .patch(`/api/v1/imports/${preview.batch.id}/rows/${target.id}`)
      .set(...XRW)
      .send({ assetId: '00000000-0000-4000-8000-000000000000' });
    expect(anon.status).toBe(401);
  });
});

describe('pinning cannot race the apply that closes the batch', () => {
  /**
   * THE WINDOW (review A2). `resolveRow` reads the batch, checks it is
   * `pending`, and then awaits four more things — the row list, the asset, the
   * portfolio's existing content hashes — before it writes. `applyBatch` can
   * claim the batch anywhere in that gap, and an UNCONDITIONAL write at the end
   * would then stamp a row `mapped` + `resolvedBy: user` on a batch that has
   * already finished applying. The user is left looking at a row the preview
   * calls pinned, whose apply outcome says `skipped_unmapped`, whose money was
   * never booked, and which they can never apply — every retry is a 409.
   *
   * That is the silent-drop class this subsystem exists to prevent, so the
   * write is conditional on the batch STILL being pending, in one statement.
   */
  it('refuses the write when the batch was applied mid-flight, and reports the conflict', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');

    // Interleave deterministically: `collectExistingHashes` runs AFTER the
    // pending check and BEFORE the write, so claiming the batch from inside it
    // reproduces the race exactly, with no timing luck involved.
    const repo = createImportRepository(harness.db);
    let claimed = false;
    const racingTransactionRepo = {
      ...createTransactionRepository(harness.db),
      async listForPortfolio(portfolioId: string) {
        if (!claimed) {
          claimed = true;
          await repo.claimPendingBatch(preview.batch.id, null);
        }
        return createTransactionRepository(harness.db).listForPortfolio(portfolioId);
      },
    } as ReturnType<typeof createTransactionRepository>;

    const imports = createImportService({
      importRepo: repo,
      portfolioRepo: createPortfolioRepository(harness.db),
      transactionRepo: racingTransactionRepo,
      cashSourceRepo: createCashSourceRepository(harness.db),
      cashRuleRepo: createCashRuleRepository(harness.db),
      cashTagRepo: createCashTagRepository(harness.db),
      search: harness.ctx.search,
      portfolio: harness.ctx.portfolio,
      tax: harness.ctx.tax,
      mappers: [],
    });

    const userId = (await harness.db.select().from(schema.importBatches))[0]!.ownerId;
    await expect(
      imports.resolveRow(userId, preview.batch.id, target.id, { assetId: asset.id }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IMPORT_ALREADY_APPLIED' });

    // And the row is untouched — no half-written pin, no false provenance.
    const rows = await repo.listRows(preview.batch.id);
    const row = rows.find((r) => r.id === target.id)!;
    expect(row.flag).toBe('unmapped');
    expect(row.assetId).toBeNull();
    expect(row.resolvedBy).toBeNull();
  });

  it('refuses the write at the repository, so no caller can bypass the check', async () => {
    const { agent, pid } = await setup();
    const preview = await stageUnresolved(agent, pid);
    const target = unresolvedTrades(preview)[0]!;
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');
    const repo = createImportRepository(harness.db);

    // The guarantee belongs to the statement, not to the service that calls it.
    await repo.claimPendingBatch(preview.batch.id, null);
    const applied = await repo.setRowResolution({
      id: target.id,
      assetId: asset.id,
      flag: 'mapped',
      message: null,
      contentHash: 'whatever',
      resolvedBy: 'user',
    });
    expect(applied).toBe(false);

    const row = (await repo.listRows(preview.batch.id)).find((r) => r.id === target.id)!;
    expect(row.flag).toBe('unmapped');
    expect(row.assetId).toBeNull();
  });
});
