import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyImportResponseSchema,
  importBrokerListResponseSchema,
  importPreviewResponseSchema,
  type ApplyImportResponse,
  type ImportPreviewResponse,
} from '@bettertrack/contracts';

import * as schema from '../../../data/schema';
import { createCashSourceRepository } from '../../../data/repositories/cashSourceRepository';
import { createImportRepository } from '../../../data/repositories/importRepository';
import { createPortfolioRepository } from '../../../data/repositories/portfolioRepository';
import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createImportService } from '../importService';
import type { BrokerMapper } from '../types';

/**
 * V4-P8 broker-import framework end-to-end over the HTTP surface (issue #492):
 * staged preview writes NOTHING, the anonymized Trade Republic fixture applies
 * to its exact golden entity set, re-importing the same file is a zero-duplicate
 * no-op, malformed rows are reported while the rest lands, unresolved
 * instruments stay excluded, dividends respect cash source + tax mode (V3-P4),
 * and cash-linked buys fail per-row on insufficient cash. EUR assets throughout
 * + a stubbed provider, so no network is ever touched.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/trade-republic.csv'),
  'utf8',
);

const HEADER = 'Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ marketData: createStubMarketData() });
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

/** Seed a global catalog asset (imports resolve TR rows by exact name). */
async function seedAsset(symbol: string, name: string, currency = 'EUR') {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
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

async function setup() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  const tech = await seedAsset('MTA.DE', 'Muster Tech AG');
  const etf = await seedAsset('BWE.DE', 'Beispiel World ETF');
  return { user, agent, pid, tech, etf };
}

async function upload(
  agent: Agent,
  pid: string,
  csv: string,
  opts: { brokerId?: string; expectedStatus?: number } = {},
): Promise<ImportPreviewResponse> {
  let req = agent
    .post('/api/v1/imports')
    .set(...XRW)
    .field('portfolioId', pid);
  if (opts.brokerId) req = req.field('brokerId', opts.brokerId);
  const res = await req.attach('file', Buffer.from(csv, 'utf8'), 'export.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(opts.expectedStatus ?? 201);
  if (res.status !== 201) return res.body as ImportPreviewResponse;
  return importPreviewResponseSchema.parse(res.body);
}

async function apply(
  agent: Agent,
  batchId: string,
  body: Record<string, unknown> = {},
): Promise<ApplyImportResponse> {
  const res = await agent
    .post(`/api/v1/imports/${batchId}/apply`)
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return applyImportResponseSchema.parse(res.body);
}

const transactions = async (agent: Agent, pid: string) =>
  (await agent.get(`/api/v1/portfolios/${pid}/transactions`)).body.items as Array<{
    side: string;
    quantity: number;
    price: number;
    fee: number;
    executedAt: string;
    asset: { symbol: string };
  }>;

const dividends = async (agent: Agent, pid: string) =>
  (await agent.get(`/api/v1/portfolios/${pid}/dividends`)).body.dividends as Array<{
    grossAmountEur: number;
    taxMode: string;
    taxAmountEur: number | null;
    cashSourceId: string;
    executedAt: string;
  }>;

const cash = async (agent: Agent, pid: string) =>
  (await agent.get(`/api/v1/portfolios/${pid}/cash`)).body as {
    balanceEur: number;
    movements: Array<{ kind: string; amountEur: number; sourceId: string }>;
    sources: Array<{ id: string; isMain: boolean; balanceEur: number }>;
  };

describe('POST /imports — staged preview', () => {
  it('autodetects Trade Republic, flags every fixture row mapped, and writes NOTHING', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, FIXTURE);

    expect(preview.batch.brokerId).toBe('trade_republic');
    expect(preview.batch.brokerLabel).toBe('Trade Republic');
    expect(preview.batch.status).toBe('pending');
    expect(preview.batch.counts).toEqual({
      total: 7,
      mapped: 7,
      unmapped: 0,
      duplicate: 0,
      error: 0,
    });
    const buyRow = preview.rows.find((r) => r.rowIndex === 3);
    expect(buyRow?.kind).toBe('buy');
    expect(buyRow?.asset?.symbol).toBe('MTA.DE');

    // The §13.4 acceptance: nothing is written before confirm.
    expect(await transactions(agent, pid)).toHaveLength(0);
    expect(await dividends(agent, pid)).toHaveLength(0);
    expect((await cash(agent, pid)).movements).toHaveLength(0);
  });

  it('lists brokers, honors a manual pick, and rejects unknown/unrecognized ones', async () => {
    const { agent, pid } = await setup();

    const brokers = importBrokerListResponseSchema.parse(
      (await agent.get('/api/v1/imports/brokers')).body,
    );
    expect(brokers.brokers).toEqual([
      { id: 'trade_republic', label: 'Trade Republic' },
      { id: 'george', label: 'George (Erste Bank)' },
      { id: 'flatex', label: 'Flatex' },
      { id: 'ibkr', label: 'Interactive Brokers' },
    ]);

    const manual = await upload(agent, pid, FIXTURE, { brokerId: 'trade_republic' });
    expect(manual.batch.brokerId).toBe('trade_republic');

    const unknown = await upload(agent, pid, FIXTURE, {
      brokerId: 'nope',
      expectedStatus: 400,
    });
    expect((unknown as unknown as { error: { code: string } }).error.code).toBe(
      'IMPORT_BROKER_UNKNOWN',
    );

    const foreign = await upload(agent, pid, 'Date,Type,Symbol\n2024-01-01,BUY,AAPL', {
      expectedStatus: 400,
    });
    expect((foreign as unknown as { error: { code: string } }).error.code).toBe(
      'IMPORT_BROKER_UNRECOGNIZED',
    );
  });

  it('requires a file part', async () => {
    const { agent, pid } = await setup();
    const res = await agent
      .post('/api/v1/imports')
      .set(...XRW)
      .field('portfolioId', pid);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMPORT_FILE_REQUIRED');
  });

  it('flags unresolvable instruments unmapped — never a silent match', async () => {
    const { agent, pid } = await setup();
    const csv = `${HEADER}\n2024-01-15;Kauf;Unbekannte AG;XS0000000009;1;10,00;0;-10,00;EUR`;
    const preview = await upload(agent, pid, csv);
    expect(preview.rows[0]?.flag).toBe('unmapped');
    expect(preview.rows[0]?.message).toContain('XS0000000009');
    expect(preview.rows[0]?.asset).toBeNull();
  });

  it('flags a currency mismatch between the row and the resolved listing as an error', async () => {
    const { agent, pid } = await setup();
    await seedAsset('DLC', 'Dollar Corp', 'USD');
    const csv = `${HEADER}\n2024-01-15;Kauf;Dollar Corp;US0000000001;1;10,00;0;-10,00;EUR`;
    const preview = await upload(agent, pid, csv);
    expect(preview.rows[0]?.flag).toBe('error');
    expect(preview.rows[0]?.message).toContain('USD');
  });

  it('flags an in-file repeat of the same date+instrument+qty+price as duplicate', async () => {
    const { agent, pid } = await setup();
    const line = '2024-01-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EUR';
    const preview = await upload(agent, pid, `${HEADER}\n${line}\n${line}`);
    expect(preview.rows.map((r) => r.flag)).toEqual(['mapped', 'duplicate']);
  });

  it('keeps a same-day buy and sell at equal quantity and price distinct (flat round-trip)', async () => {
    const { agent, pid } = await setup();
    const csv = [
      HEADER,
      '2024-01-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EUR',
      '2024-01-15;Verkauf;Muster Tech AG;DE0001234567;10;50,00;1,00;499,00;EUR',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    expect(preview.rows.map((r) => r.flag)).toEqual(['mapped', 'mapped']);

    const result = await apply(agent, preview.batch.id);
    expect(result.applied).toBe(2);
    expect((await transactions(agent, pid)).map((t) => t.side).sort()).toEqual(['buy', 'sell']);
  });

  it('flags a malformed Währung cell as one row error while the rest of the file stages', async () => {
    // Regression: `EURO` on a trade row used to reach the char(3) staging
    // column and kill the whole batch INSERT with a 500 (per-row tolerance,
    // §13.4). It must cost exactly its own line.
    const { agent, pid } = await setup();
    const csv = [
      HEADER,
      '2024-01-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EURO',
      '2024-01-16;Einzahlung;;;;;;100,00;EUR',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    expect(preview.batch.counts).toMatchObject({ total: 2, mapped: 1, error: 1 });
    expect(preview.rows[0]?.flag).toBe('error');
    expect(preview.rows[0]?.message).toContain('EURO');
    expect(preview.rows[1]?.flag).toBe('mapped');
  });

  it('flags an over-large numeric as one row error while the rest of the file stages', async () => {
    // Same mechanism as the currency regression above, other column class:
    // quantity stages into numeric(20,8) — 12 integer digits. A valid-notation
    // but 13-integer-digit German value used to reach the batch INSERT and
    // kill the whole upload with a `numeric field overflow` 500. It must cost
    // exactly its own line.
    const { agent, pid } = await setup();
    const csv = [
      HEADER,
      '2024-01-15;Kauf;Muster Tech AG;DE0001234567;1.234.567.890.123,45;50,00;1,00;-501,00;EUR',
      '2024-01-16;Einzahlung;;;;;;100,00;EUR',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    expect(preview.batch.counts).toMatchObject({ total: 2, mapped: 1, error: 1 });
    expect(preview.rows[0]?.flag).toBe('error');
    expect(preview.rows[0]?.message).toContain('1234567890123.45');
    expect(preview.rows[0]?.quantity).toBeNull();
    expect(preview.rows[1]?.flag).toBe('mapped');
  });

  it('guards staging against a future mapper letting a malformed currency or oversized numeric through', async () => {
    // George/Flatex/IBKR land against this frozen framework — even if such a
    // mapper forgets to validate a column, the framework itself must fail the
    // ROW before any value a staging column refuses reaches the insert
    // (char(3) currency, numeric(20,8)/(20,6) magnitudes), never the upload.
    const { user, pid } = await setup();
    const rogue: BrokerMapper = {
      id: 'rogue',
      label: 'Rogue Broker',
      detect: () => 1,
      map: (csv) =>
        csv.records.map((record, i) => ({
          line: record.line,
          raw: record.raw,
          ok: true,
          row: {
            kind: 'deposit',
            executedAt: new Date('2024-01-02T12:00:00.000Z'),
            isin: null,
            symbol: null,
            name: null,
            quantity: null,
            price: null,
            fee: null,
            // Row 0: malformed currency. Row 1: an amount numeric(20,6)
            // cannot hold (≥ 10^14). Row 2: just under the ceiling — must
            // pass the guard AND the real column insert (pins the derived
            // bound to the actual schema).
            amountEur: i === 1 ? 1e15 : i === 2 ? 99999999999999.5 : 100,
            currency: i === 0 ? 'EUR/USD' : 'EUR',
            note: null,
          },
        })),
    };
    const imports = createImportService({
      importRepo: createImportRepository(harness.db),
      portfolioRepo: createPortfolioRepository(harness.db),
      transactionRepo: createTransactionRepository(harness.db),
      cashSourceRepo: createCashSourceRepository(harness.db),
      search: harness.ctx.search,
      portfolio: harness.ctx.portfolio,
      tax: harness.ctx.tax,
      mappers: [rogue],
    });

    const preview = await imports.createBatch(user.id, {
      portfolioId: pid,
      filename: 'rogue.csv',
      content: 'A;B\n1;2\n3;4\n5;6',
      brokerId: 'rogue',
    });
    expect(preview.batch.counts).toMatchObject({ total: 3, mapped: 1, error: 2 });
    expect(preview.rows[0]?.flag).toBe('error');
    expect(preview.rows[0]?.message).toContain('EUR/USD');
    expect(preview.rows[0]?.currency).toBeNull();
    expect(preview.rows[1]?.flag).toBe('error');
    expect(preview.rows[1]?.message).toContain('1000000000000000');
    expect(preview.rows[1]?.amountEur).toBeNull();
    expect(preview.rows[2]?.flag).toBe('mapped');
    expect(preview.rows[2]?.amountEur).toBe(99999999999999.5);
  });
});

describe('POST /imports/:batchId/apply — golden fixture', () => {
  it('applies the fixture to its exact transaction/dividend/cash set', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, FIXTURE);
    const result = await apply(agent, preview.batch.id);

    expect(result.applied).toBe(7);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.batch.status).toBe('applied');
    expect(result.rows.every((r) => r.result === 'applied')).toBe(true);

    // Golden transaction set — exact rows, newest first (§13.4 acceptance).
    const txs = await transactions(agent, pid);
    expect(
      txs.map((t) => ({
        side: t.side,
        symbol: t.asset.symbol,
        quantity: t.quantity,
        price: t.price,
        fee: t.fee,
        executedAt: t.executedAt,
      })),
    ).toEqual([
      {
        side: 'sell',
        symbol: 'MTA.DE',
        quantity: 4,
        price: 60,
        fee: 1,
        executedAt: '2024-04-10T12:00:00.000Z',
      },
      {
        side: 'buy',
        symbol: 'BWE.DE',
        quantity: 2.5,
        price: 40,
        fee: 0,
        executedAt: '2024-02-01T12:00:00.000Z',
      },
      {
        side: 'buy',
        symbol: 'MTA.DE',
        quantity: 10,
        price: 50,
        fee: 1,
        executedAt: '2024-01-15T12:00:00.000Z',
      },
    ]);

    // The dividend landed in Main (no cash source picked) under tax mode none.
    const divs = await dividends(agent, pid);
    expect(divs).toHaveLength(1);
    expect(divs[0]).toMatchObject({ grossAmountEur: 12.5, taxMode: 'none' });

    // Cash: deposit 2000 + dividend 12.50 + interest 3.75 − withdrawal 250.
    const ledger = await cash(agent, pid);
    expect(ledger.balanceEur).toBeCloseTo(1766.25, 2);
    expect(ledger.movements.map((m) => [m.kind, m.amountEur])).toEqual(
      expect.arrayContaining([
        ['deposit', 2000],
        ['dividend', 12.5],
        ['deposit', 3.75],
        ['withdrawal', -250],
      ]),
    );
    expect(ledger.movements).toHaveLength(4);
  });

  it('re-importing the same file creates zero duplicates', async () => {
    const { agent, pid } = await setup();
    const first = await upload(agent, pid, FIXTURE);
    await apply(agent, first.batch.id);

    // The re-upload already previews every row as a duplicate.
    const second = await upload(agent, pid, FIXTURE);
    expect(second.batch.counts.duplicate).toBe(7);
    expect(second.batch.counts.mapped).toBe(0);

    const result = await apply(agent, second.batch.id);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(7);
    expect(result.rows.every((r) => r.result === 'skipped_duplicate')).toBe(true);

    expect(await transactions(agent, pid)).toHaveLength(3);
    expect(await dividends(agent, pid)).toHaveLength(1);
    expect((await cash(agent, pid)).movements).toHaveLength(4);
  });

  it('reports a malformed row while the rest lands', async () => {
    const { agent, pid } = await setup();
    const csv = [
      HEADER,
      '2024-01-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EUR',
      'kaputt;Kauf;Muster Tech AG;DE0001234567;5;50,00;1,00;-251,00;EUR',
      '2024-01-16;Hexerei;;;;;;1,00;EUR',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    expect(preview.batch.counts).toMatchObject({ total: 3, mapped: 1, error: 2 });
    expect(preview.rows.find((r) => r.rowIndex === 3)?.message).toContain('date');
    expect(preview.rows.find((r) => r.rowIndex === 4)?.message).toContain('Hexerei');

    const result = await apply(agent, preview.batch.id);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.rows.filter((r) => r.result === 'skipped_error')).toHaveLength(2);
    expect(await transactions(agent, pid)).toHaveLength(1);
  });

  it('excludes unmapped rows from apply', async () => {
    const { agent, pid } = await setup();
    const csv = [
      HEADER,
      '2024-01-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EUR',
      '2024-01-16;Kauf;Unbekannte AG;XS0000000009;1;10,00;0;-10,00;EUR',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    const result = await apply(agent, preview.batch.id);
    expect(result.applied).toBe(1);
    expect(result.rows.find((r) => r.rowIndex === 3)?.result).toBe('skipped_unmapped');
    const txs = await transactions(agent, pid);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.asset.symbol).toBe('MTA.DE');
  });

  it('books dividends into the chosen cash source under the active tax mode (V3-P4)', async () => {
    const { agent, pid } = await setup();
    // Austrian KESt mode: the engine withholds 27.5 % of the gross at recording.
    const settings = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'AT' });
    expect(settings.status).toBe(200);
    const created = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources`)
      .set(...XRW)
      .send({ name: 'Broker', type: 'bank' });
    expect(created.status).toBe(201);
    const brokerSourceId = created.body.source.id as string;

    // The buy precedes the dividend chronologically inside the same file — the
    // tax engine only accepts dividends on assets the portfolio holds (V3-P4c).
    const csv = [
      HEADER,
      '2024-01-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EUR',
      '2024-03-15;Dividende;Muster Tech AG;DE0001234567;;;;100,00;EUR',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    const result = await apply(agent, preview.batch.id, { cashSourceId: brokerSourceId });
    expect(result.applied).toBe(2);

    const divs = await dividends(agent, pid);
    expect(divs).toHaveLength(1);
    expect(divs[0]).toMatchObject({
      grossAmountEur: 100,
      taxMode: 'country_specific',
      cashSourceId: brokerSourceId,
    });
    expect(divs[0]?.taxAmountEur).toBeCloseTo(27.5, 2);

    const ledger = await cash(agent, pid);
    const bySource = ledger.movements.filter((m) => m.sourceId === brokerSourceId);
    expect(bySource.map((m) => [m.kind, m.amountEur])).toEqual(
      expect.arrayContaining([
        ['dividend', 100],
        ['tax_withholding', -27.5],
      ]),
    );
    expect(ledger.sources.find((s) => s.id === brokerSourceId)?.balanceEur).toBeCloseTo(72.5, 2);
  });

  it('funds linked buys from cash and fails a row on insufficient cash without killing the rest', async () => {
    const { agent, pid } = await setup();
    const csv = [
      HEADER,
      '2024-01-01;Einzahlung;;;;;;600,00;EUR',
      '2024-01-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EUR',
      '2024-02-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EUR',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    const result = await apply(agent, preview.batch.id, { linkCashOnTrades: true });

    expect(result.applied).toBe(2);
    expect(result.failed).toBe(1);
    const failedRow = result.rows.find((r) => r.result === 'failed');
    expect(failedRow?.rowIndex).toBe(4);
    expect(failedRow?.message).toContain('cash');

    expect(await transactions(agent, pid)).toHaveLength(1);
    const ledger = await cash(agent, pid);
    expect(ledger.movements.map((m) => [m.kind, m.amountEur])).toEqual(
      expect.arrayContaining([
        ['deposit', 600],
        ['buy', -501],
      ]),
    );
    expect(ledger.balanceEur).toBeCloseTo(99, 2);
  });

  it('does not flag an imported sell as a duplicate of an already-recorded buy', async () => {
    const { agent, pid } = await setup();
    const buy = '2024-01-15;Kauf;Muster Tech AG;DE0001234567;10;50,00;1,00;-501,00;EUR';
    const first = await upload(agent, pid, `${HEADER}\n${buy}`);
    await apply(agent, first.batch.id);

    // The exit at the entry price: same day/instrument/qty/price, opposite side.
    // Dropping it as a "duplicate" would leave a holding that was actually sold.
    const sell = '2024-01-15;Verkauf;Muster Tech AG;DE0001234567;10;50,00;1,00;499,00;EUR';
    const second = await upload(agent, pid, `${HEADER}\n${sell}`);
    expect(second.rows[0]?.flag).toBe('mapped');

    const result = await apply(agent, second.batch.id);
    expect(result.applied).toBe(1);
    expect((await transactions(agent, pid)).map((t) => t.side).sort()).toEqual(['buy', 'sell']);
  });

  it('books a batch exactly once under concurrent applies (atomic pending→applied claim)', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, FIXTURE);

    const fire = () =>
      agent
        .post(`/api/v1/imports/${preview.batch.id}/apply`)
        .set(...XRW)
        .send({});
    const [a, b] = await Promise.all([fire(), fire()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('IMPORT_ALREADY_APPLIED');

    // The golden entity set exists exactly once — nothing double-booked.
    expect(await transactions(agent, pid)).toHaveLength(3);
    expect(await dividends(agent, pid)).toHaveLength(1);
    expect((await cash(agent, pid)).movements).toHaveLength(4);
  });

  it('replays the memoized response on an Idempotency-Key retry (V4-P2a)', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, FIXTURE);

    const send = () =>
      agent
        .post(`/api/v1/imports/${preview.batch.id}/apply`)
        .set(...XRW)
        .set('Idempotency-Key', '018f5c1a-2222-7000-8000-0123456789ab')
        .send({});
    const first = await send();
    expect(first.status).toBe(200);

    // The retry (the mobile offline queue re-sending after a dropped response)
    // gets the recorded body back instead of the atomic claim's 409.
    const retry = await send();
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(await transactions(agent, pid)).toHaveLength(3);
  });

  it('rejects a second apply and a foreign cash source', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, FIXTURE);

    const badSource = await agent
      .post(`/api/v1/imports/${preview.batch.id}/apply`)
      .set(...XRW)
      .send({ cashSourceId: '00000000-0000-7000-8000-000000000000' });
    expect(badSource.status).toBe(400);
    expect(badSource.body.error.code).toBe('CASH_SOURCE_NOT_FOUND');

    await apply(agent, preview.batch.id);
    const again = await agent
      .post(`/api/v1/imports/${preview.batch.id}/apply`)
      .set(...XRW)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('IMPORT_ALREADY_APPLIED');
  });
});

describe('ownership + lifecycle', () => {
  it("404s another user's batch on read/apply/discard (no IDOR)", async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, FIXTURE);

    const other = await harness.seedUser({ email: 'other@bettertrack.test', username: 'other' });
    const otherAgent = await loginAgent(harness.app, other.email, other.password);

    expect((await otherAgent.get(`/api/v1/imports/${preview.batch.id}`)).status).toBe(404);
    expect(
      (
        await otherAgent
          .post(`/api/v1/imports/${preview.batch.id}/apply`)
          .set(...XRW)
          .send({})
      ).status,
    ).toBe(404);
    expect(
      (await otherAgent.delete(`/api/v1/imports/${preview.batch.id}`).set(...XRW)).status,
    ).toBe(404);
  });

  it('re-reads and discards an own staged batch', async () => {
    const { agent, pid } = await setup();
    const preview = await upload(agent, pid, FIXTURE);

    const reread = importPreviewResponseSchema.parse(
      (await agent.get(`/api/v1/imports/${preview.batch.id}`)).body,
    );
    expect(reread.rows).toHaveLength(7);

    expect((await agent.delete(`/api/v1/imports/${preview.batch.id}`).set(...XRW)).status).toBe(
      204,
    );
    expect((await agent.get(`/api/v1/imports/${preview.batch.id}`)).status).toBe(404);
  });
});
