import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPreviewResponseSchema } from '@bettertrack/contracts';
import type { ApplyImportResponse, ImportPreviewResponse, ImportRow } from '@bettertrack/contracts';

import { createCashRuleRepository } from '../../../data/repositories/cashRuleRepository';
import { createCashSourceRepository } from '../../../data/repositories/cashSourceRepository';
import { createCashTagRepository } from '../../../data/repositories/cashTagRepository';
import { createImportRepository } from '../../../data/repositories/importRepository';
import { createPortfolioRepository } from '../../../data/repositories/portfolioRepository';
import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import * as schema from '../../../data/schema';
import { createImportService } from '../importService';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * CONFIRMING A ROW'S KIND — `PATCH /imports/:batchId/rows/:rowId` with `{ kind }`
 * (#964; the §16 2026-08-29 gap (b): "a cash row whose file carries no
 * booking-type column (memo + signed amount only — Raiffeisen ELBA is the
 * reference fixture) classifies below the review bar, so it is reported rather
 * than booked; making those importable needs a 'confirm this row's kind'
 * affordance, a small extension of the same PATCH").
 *
 * The whole file is about ONE statement the wizard could preview but never
 * import. Its three lines carry a memo and a signed amount and nothing else, so
 * the classifier refuses to name a kind — correctly, because the sign alone
 * cannot separate "money out" from "bought something". The fix is not a better
 * guess: it is a person saying what the row is.
 *
 * Three properties carry the safety, and each has tests here:
 *
 *  1. THE CLIENT ASSERTS A KIND AND NOTHING ELSE. The body carries one enum
 *     member; every number and every id is re-derived server-side from the
 *     fields staging already parsed. A client cannot send an amount, and no
 *     model is re-invoked.
 *  2. THE DERIVATION MAY REFUSE. A negative amount is not confirmable as an
 *     inflow, a row with no quantity and price is not confirmable as a trade —
 *     the refusal is explained and the row is left exactly as it was.
 *  3. THE WRITE IS CONDITIONAL ON THE BATCH STILL BEING PENDING, the same
 *     compare-and-set the asset-pinning path uses, for the same reason.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** The reference fixture the §16 row names: no booking-type column at all. */
const ELBA = readFileSync(path.join(fixtureDir, 'raiffeisen-elba.csv'), 'utf8');

/** A trade whose direction the file never signs — quantity + price, no amount. */
const UNSIGNED_TRADE = [
  'Datum;Buchungstext;Stück;Kurs;Währung;ISIN',
  '12.01.2024;Muster Tech AG;10;100,00;EUR;DE000MUSTER1',
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

async function setup() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const list = await agent.get('/api/v1/portfolios');
  const pid = list.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
  return { user, agent, pid };
}

async function upload(
  agent: Agent,
  pid: string,
  csv = ELBA,
  filename = 'elba.csv',
): Promise<ImportPreviewResponse> {
  const res = await agent
    .post('/api/v1/imports')
    .set(...XRW)
    .field('portfolioId', pid)
    .field('brokerId', 'generic')
    .attach('file', Buffer.from(csv, 'utf8'), filename);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return importPreviewResponseSchema.parse(res.body);
}

function confirm(agent: Agent, batchId: string, rowId: string, kind: string) {
  return agent
    .patch(`/api/v1/imports/${batchId}/rows/${rowId}`)
    .set(...XRW)
    .send({ kind });
}

async function apply(agent: Agent, batchId: string): Promise<ApplyImportResponse> {
  const res = await agent
    .post(`/api/v1/imports/${batchId}/apply`)
    .set(...XRW)
    .send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ApplyImportResponse;
}

/** The staged row whose original line contains `needle`. */
const rowByRaw = (preview: ImportPreviewResponse, needle: string): ImportRow =>
  preview.rows.find((r) => r.raw.includes(needle))!;

/**
 * Fund the portfolio's Main cash source before applying a statement.
 *
 * The ELBA statement spends before it earns (a card payment on the 3rd, rent on
 * the 18th, salary on the 31st), and the cash ledger refuses to go negative
 * (§14, "no silent negative balances"). That refusal is the portfolio service's
 * and is entirely correct — an import must not be a way around it — so these
 * tests give the account the opening balance a real one would have. It is also
 * what makes the assertions about WHAT was booked meaningful rather than
 * assertions about an overdraw.
 */
async function fundMain(agent: Agent, pid: string, amountEur: number): Promise<void> {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/cash/deposit`)
    .set(...XRW)
    .send({ amountEur, executedAt: '2023-12-31T00:00:00.000Z', note: 'Opening balance' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function seedAsset(symbol: string, name: string, currency = 'EUR') {
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
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

describe('a statement with no booking-type column keeps what it parsed', () => {
  it('stages every ELBA row with its date, memo and signed amount intact', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid);

    expect(preview.rows).toHaveLength(3);
    // Unchanged, and deliberately so: the wire flag vocabulary is frozen, and a
    // row nobody has decided yet is still a row this import will not book.
    expect(preview.batch.counts.error).toBe(3);

    const rent = rowByRaw(preview, 'MIETE JAENNER');
    // THE REGRESSION THIS FILE EXISTS FOR: staging used to write every column
    // null on a `!ok` line, so the reviewer saw a row with no date, no amount
    // and no memo — and confirming a kind would have had nothing to derive
    // from, since the upload itself is never retained.
    expect(rent.executedAt?.slice(0, 10)).toBe('2024-01-18');
    expect(rent.note).toBe('MIETE JAENNER');
    expect(rent.currency).toBe('EUR');
    // SIGNED while undecided: the direction is the file's own statement, and it
    // is what makes the refusal in the next describe block possible. Apply
    // never reads it — an undecided row is `error`, and error rows are skipped.
    expect(rent.amountEur).toBe(-780);
    // The kind is exactly what is missing, so it stays null.
    expect(rent.kind).toBeNull();
    expect(rent.message).toMatch(/needs a human decision/i);
  });

  it('names the kinds it will accept, and refuses to offer an inflow for money out', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid);

    const rent = rowByRaw(preview, 'MIETE JAENNER');
    const salary = rowByRaw(preview, 'GEHALT ARBEITGEBER AG');

    // A negative amount is unambiguous evidence of an OUTFLOW, so the inflow
    // kinds are not on offer for the rent row…
    expect(rent.confirmableKinds).toEqual(['withdrawal']);
    // …and because THIS file writes an outflow as a negative, its positives are
    // inflows rather than unsigned magnitudes — so the salary row is not on
    // offer as money leaving either. That is what keeps the wizard's "confirm
    // the rest as withdrawals" sweep off a salary line.
    expect(salary.confirmableKinds).toContain('deposit');
    expect(salary.confirmableKinds).not.toContain('withdrawal');

    // Neither row names an instrument or a quantity, so no trade kind derives.
    expect(rent.confirmableKinds).not.toContain('buy');
    expect(salary.confirmableKinds).not.toContain('sell');
    // The file-level fact behind that, stated where the wizard shows what it
    // understood rather than inferred per row.
    expect(preview.understanding?.amountsSigned).toBe(true);
  });

  it('leaves BOTH directions open on a file that never signs an amount', async () => {
    const { agent, pid } = await setup();
    // The same statement with the minus signs stripped — a magnitudes-only
    // export, which is a shape real banks ship. Nothing in the file says which
    // way the money went, so nothing may be withheld from the person deciding.
    const unsigned = ELBA.replace(/;-/g, ';');
    const preview = await upload(agent, pid, unsigned, 'unsigned.csv');

    expect(preview.understanding?.amountsSigned).toBe(false);
    const rent = rowByRaw(preview, 'MIETE JAENNER');
    expect(rent.confirmableKinds).toEqual(expect.arrayContaining(['deposit', 'withdrawal']));
  });

  it('offers both trade directions when the file signs no direction at all', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, UNSIGNED_TRADE, 'trade.csv');

    const trade = preview.rows[0]!;
    expect(trade.flag).toBe('error');
    expect(trade.quantity).toBe(10);
    expect(trade.price).toBe(100);
    expect(trade.isin).toBe('DE000MUSTER1');
    // Quantity and price make it a trade; with no amount there is no sign, so
    // the two directions are equally available and the person picks.
    expect(trade.confirmableKinds).toEqual(expect.arrayContaining(['buy', 'sell']));
  });
});

describe('a person confirms the kind and the statement imports', () => {
  it('confirms each row, re-derives the fields, and books the whole file', async () => {
    const { agent, pid } = await setup();
    await fundMain(agent, pid, 1000);
    const staged = await upload(agent, pid);

    const plan: Array<[needle: string, kind: string]> = [
      ['HOFER DANKT KARTE', 'withdrawal'],
      ['MIETE JAENNER', 'withdrawal'],
      ['GEHALT ARBEITGEBER AG', 'deposit'],
    ];

    let preview = staged;
    for (const [needle, kind] of plan) {
      const res = await confirm(agent, staged.batch.id, rowByRaw(staged, needle).id, kind);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // The WHOLE preview comes back, so the client never recomputes a count.
      preview = importPreviewResponseSchema.parse(res.body);
    }

    expect(preview.batch.counts.mapped).toBe(3);
    expect(preview.batch.counts.error).toBe(0);

    const rent = rowByRaw(preview, 'MIETE JAENNER');
    expect(rent.kind).toBe('withdrawal');
    expect(rent.flag).toBe('mapped');
    // Direction now lives in `kind`, so the stored amount is the magnitude —
    // exactly what staging writes for a row the classifier was sure about.
    expect(rent.amountEur).toBe(780);
    expect(rent.confirmableKinds).toBeUndefined();
    expect(rent.resolvedBy).toBe('user');

    const report = await apply(agent, staged.batch.id);
    expect(report.applied).toBe(3);

    const cash = await agent.get(`/api/v1/portfolios/${pid}/cash`);
    expect(cash.status).toBe(200);
    const booked = (cash.body.movements as Array<{ kind: string; amountEur: number; note: string }>)
      .map((m) => `${m.kind}:${Math.abs(m.amountEur)}:${m.note}`)
      .sort();
    // Every line of the statement, in the direction the file stated and at the
    // magnitude the file stated — none of which the client ever sent.
    expect(booked).toEqual([
      'deposit:1000:Opening balance',
      'deposit:2100:GEHALT ARBEITGEBER AG',
      'withdrawal:52.3:HOFER DANKT KARTE 5678',
      'withdrawal:780:MIETE JAENNER',
    ]);
  });

  it('resolves the instrument locally when a trade kind is confirmed', async () => {
    const { agent, pid } = await setup();
    const asset = await seedAsset('MTA.DE', 'Muster Tech AG');
    const staged = await upload(agent, pid, UNSIGNED_TRADE, 'trade.csv');

    const res = await confirm(agent, staged.batch.id, staged.rows[0]!.id, 'buy');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = importPreviewResponseSchema.parse(res.body).rows[0]!;

    expect(row.kind).toBe('buy');
    expect(row.flag).toBe('mapped');
    expect(row.asset?.id).toBe(asset.id);
    // The magnitudes are the file's, unsigned, exactly as staging derives them.
    expect(row.quantity).toBe(10);
    expect(row.price).toBe(100);
  });

  it('leaves a confirmed trade unresolved (never guessed) when the catalog has nothing', async () => {
    const { agent, pid } = await setup();
    const staged = await upload(agent, pid, UNSIGNED_TRADE, 'trade.csv');

    const res = await confirm(agent, staged.batch.id, staged.rows[0]!.id, 'buy');
    expect(res.status).toBe(200);
    const row = importPreviewResponseSchema.parse(res.body).rows[0]!;

    // Confirming the KIND never invents the instrument: the row lands in the
    // same `unmapped` state staging would have given it, and the existing pin
    // affordance finishes the job.
    expect(row.kind).toBe('buy');
    expect(row.flag).toBe('unmapped');
    expect(row.asset).toBeNull();
    expect(row.message).toMatch(/not found in the asset catalog/i);
  });

  it('re-runs dedupe, so confirming a row already in the ledger flags it duplicate', async () => {
    const { agent, pid } = await setup();
    await fundMain(agent, pid, 1000);

    const first = await upload(agent, pid);
    expect(
      (await confirm(agent, first.batch.id, rowByRaw(first, 'MIETE JAENNER').id, 'withdrawal'))
        .status,
    ).toBe(200);
    await apply(agent, first.batch.id);

    // The same statement, uploaded again. Staging cannot flag the row a
    // duplicate — an undecided row has no kind to hash — so the check has to
    // happen at confirmation, against what is recorded NOW.
    const second = await upload(agent, pid);
    const res = await confirm(
      agent,
      second.batch.id,
      rowByRaw(second, 'MIETE JAENNER').id,
      'withdrawal',
    );
    expect(res.status).toBe(200);
    const row = rowByRaw(importPreviewResponseSchema.parse(res.body), 'MIETE JAENNER');
    expect(row.flag).toBe('duplicate');

    const report = await apply(agent, second.batch.id);
    expect(report.rows.find((r) => r.id === row.id)?.result).toBe('skipped_duplicate');
  });

  it('pre-tags a confirmed cash row with the caller’s own rules', async () => {
    const { agent, pid } = await setup();
    const tag = await agent
      .post('/api/v1/cash/tags')
      .set(...XRW)
      .send({ name: 'Rent' });
    expect(tag.status, JSON.stringify(tag.body)).toBe(201);
    const rule = await agent
      .post('/api/v1/cash/rules')
      .set(...XRW)
      .send({ tagIds: [tag.body.tag.id], pattern: 'MIETE', matchType: 'contains' });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);

    const staged = await upload(agent, pid);
    const res = await confirm(
      agent,
      staged.batch.id,
      rowByRaw(staged, 'MIETE JAENNER').id,
      'withdrawal',
    );
    expect(res.status).toBe(200);

    // A row that only BECOMES a cash row at confirmation still arrives
    // pre-tagged: the preview promises the label before anything is booked.
    const row = rowByRaw(importPreviewResponseSchema.parse(res.body), 'MIETE JAENNER');
    expect(row.ruleTagIds).toEqual([tag.body.tag.id]);
  });
});

describe('the derivation refuses rather than inventing a booking', () => {
  it('will not book money out as money in', async () => {
    const { agent, pid } = await setup();
    const staged = await upload(agent, pid);
    const rent = rowByRaw(staged, 'MIETE JAENNER');

    const res = await confirm(agent, staged.batch.id, rent.id, 'deposit');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMPORT_ROW_KIND_UNSUPPORTED');
    expect(res.body.error.message).toMatch(/money out/i);

    // …and the row is untouched, so the right kind can still be confirmed.
    const after = importPreviewResponseSchema.parse(
      (await agent.get(`/api/v1/imports/${staged.batch.id}`)).body,
    );
    const row = rowByRaw(after, 'MIETE JAENNER');
    expect(row.kind).toBeNull();
    expect(row.amountEur).toBe(-780);
    expect(row.confirmableKinds).toEqual(['withdrawal']);
  });

  it('will not book a cash line as a trade it has no numbers for', async () => {
    const { agent, pid } = await setup();
    const staged = await upload(agent, pid);

    const res = await confirm(agent, staged.batch.id, rowByRaw(staged, 'MIETE').id, 'buy');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMPORT_ROW_KIND_UNSUPPORTED');
    expect(res.body.error.message).toMatch(/quantity and price/i);
  });

  it('accepts a kind from the contract enum and nothing else', async () => {
    const { agent, pid } = await setup();
    const staged = await upload(agent, pid);
    const rowId = rowByRaw(staged, 'MIETE').id;
    const url = `/api/v1/imports/${staged.batch.id}/rows/${rowId}`;

    // Not a member of the wire vocabulary — `fee` is an INTERNAL classifier
    // kind and must not become bookable through this door.
    const fee = await agent
      .patch(url)
      .set(...XRW)
      .send({ kind: 'fee' });
    expect(fee.status).toBe(400);

    // The body carries an assertion, never data: an amount alongside the kind
    // is refused by the strict schema rather than quietly ignored.
    const withAmount = await agent
      .patch(url)
      .set(...XRW)
      .send({ kind: 'withdrawal', amountEur: 999999 });
    expect(withAmount.status).toBe(400);

    // Exactly one intent per request: neither both, nor neither.
    const both = await agent
      .patch(url)
      .set(...XRW)
      .send({ kind: 'withdrawal', assetId: '00000000-0000-4000-8000-000000000000' });
    expect(both.status).toBe(400);
    const neither = await agent
      .patch(url)
      .set(...XRW)
      .send({});
    expect(neither.status).toBe(400);

    // Nothing was written by any of them.
    const after = importPreviewResponseSchema.parse(
      (await agent.get(`/api/v1/imports/${staged.batch.id}`)).body,
    );
    expect(rowByRaw(after, 'MIETE').kind).toBeNull();
  });
});

describe('the endpoint is no weaker than the surfaces around it', () => {
  it('is one-shot: a decided row is not re-decidable', async () => {
    const { agent, pid } = await setup();
    const staged = await upload(agent, pid);
    const rowId = rowByRaw(staged, 'MIETE').id;

    expect((await confirm(agent, staged.batch.id, rowId, 'withdrawal')).status).toBe(200);
    const again = await confirm(agent, staged.batch.id, rowId, 'deposit');
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('IMPORT_ROW_KIND_DECIDED');
  });

  it('refuses a row whose kind the pipeline itself decided', async () => {
    const { agent, pid } = await setup();
    // `Lastschrift` is a keyword the classifier resolves above the review bar,
    // so this row was never open for confirmation.
    const decided = [
      'Datum;Buchungstext;Betrag;Währung',
      '11.01.2024;LASTSCHRIFT HOFER;-52,30;EUR',
    ].join('\n');
    const staged = await upload(agent, pid, decided, 'decided.csv');
    expect(staged.rows[0]!.flag).toBe('mapped');
    expect(staged.rows[0]!.confirmableKinds).toBeUndefined();

    const res = await confirm(agent, staged.batch.id, staged.rows[0]!.id, 'deposit');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMPORT_ROW_KIND_DECIDED');
  });

  it('404s a foreign batch and a row from another batch; 401s an anonymous caller', async () => {
    const { agent, pid } = await setup();
    const mine = await upload(agent, pid);
    const other = await upload(agent, pid);
    const rowId = rowByRaw(mine, 'MIETE').id;

    const intruderUser = await harness.seedUser({
      email: 'intruder@bettertrack.test',
      username: 'intruder',
    });
    const intruder = await loginAgent(harness.app, intruderUser.email, intruderUser.password);
    const foreign = await confirm(intruder, mine.batch.id, rowId, 'withdrawal');
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('IMPORT_NOT_FOUND');

    // Owning both batches is not enough: the row must be IN the named batch.
    const crossed = await confirm(agent, other.batch.id, rowId, 'withdrawal');
    expect(crossed.status).toBe(404);
    expect(crossed.body.error.code).toBe('IMPORT_ROW_NOT_FOUND');

    const anon = await request(harness.app)
      .patch(`/api/v1/imports/${mine.batch.id}/rows/${rowId}`)
      .set(...XRW)
      .send({ kind: 'withdrawal' });
    expect(anon.status).toBe(401);

    // The victim's row survived all three.
    const after = importPreviewResponseSchema.parse(
      (await agent.get(`/api/v1/imports/${mine.batch.id}`)).body,
    );
    expect(rowByRaw(after, 'MIETE').kind).toBeNull();
  });

  it('409s once the batch has been applied — staging is closed', async () => {
    const { agent, pid } = await setup();
    const staged = await upload(agent, pid);
    await apply(agent, staged.batch.id);

    const res = await confirm(agent, staged.batch.id, rowByRaw(staged, 'MIETE').id, 'withdrawal');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IMPORT_ALREADY_APPLIED');
  });
});

describe('confirming cannot race the apply that closes the batch', () => {
  /**
   * The window the asset-pinning path documents, on this path: the service
   * checks `pending` and then awaits the row list, the caller's cash rules and
   * the portfolio's existing content hashes before it writes. `applyBatch` can
   * claim the batch anywhere in that gap, and an unconditional write would then
   * stamp a row `mapped` with a kind on a batch that has already finished —
   * a row the preview calls importable, whose money was never booked, and which
   * every retry answers with a 409.
   */
  it('refuses the write when the batch was applied mid-flight', async () => {
    const { agent, pid } = await setup();
    const staged = await upload(agent, pid);
    const rowId = rowByRaw(staged, 'MIETE').id;

    const repo = createImportRepository(harness.db);
    let claimed = false;
    const racingTransactionRepo = {
      ...createTransactionRepository(harness.db),
      async listForPortfolio(portfolioId: string) {
        if (!claimed) {
          claimed = true;
          await repo.claimPendingBatch(staged.batch.id, null);
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
      imports.resolveRow(userId, staged.batch.id, rowId, { kind: 'withdrawal' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IMPORT_ALREADY_APPLIED' });

    const row = (await repo.listRows(staged.batch.id)).find((r) => r.id === rowId)!;
    expect(row.kind).toBeNull();
    expect(row.flag).toBe('error');
    expect(row.kindUndecided).toBe(true);
  });

  it('refuses the write at the repository, so no caller can bypass the check', async () => {
    const { agent, pid } = await setup();
    const staged = await upload(agent, pid);
    const rowId = rowByRaw(staged, 'MIETE').id;
    const repo = createImportRepository(harness.db);

    await repo.claimPendingBatch(staged.batch.id, null);
    const written = await repo.confirmRowKind({
      id: rowId,
      kind: 'withdrawal',
      flag: 'mapped',
      message: null,
      executedAt: new Date('2024-01-18T00:00:00.000Z'),
      isin: null,
      symbol: null,
      name: null,
      quantity: null,
      price: null,
      fee: null,
      amountEur: 780,
      currency: 'EUR',
      note: 'MIETE JAENNER',
      assetId: null,
      contentHash: 'whatever',
      candidates: null,
      ruleTagIds: null,
      resolvedBy: 'user',
    });
    expect(written).toBe(false);

    const row = (await repo.listRows(staged.batch.id)).find((r) => r.id === rowId)!;
    expect(row.kind).toBeNull();
    expect(row.kindUndecided).toBe(true);
  });
});
