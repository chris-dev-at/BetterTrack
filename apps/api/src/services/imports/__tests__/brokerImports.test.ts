import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyImportResponseSchema,
  importPreviewResponseSchema,
  type ApplyImportResponse,
  type ImportPreviewResponse,
} from '@bettertrack/contracts';

import * as schema from '../../../data/schema';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * George/Flatex/IBKR mappers through the FROZEN import framework's HTTP surface
 * (§13.4 V4-P8, issue #508): each anonymized fixture autodetects and applies to
 * its exact golden entity set, re-importing is a zero-duplicate no-op, a
 * malformed row costs only its line, unresolved instruments stay `unmapped`,
 * and dividends respect cash source + tax mode (V3-P4). EUR/USD assets are
 * seeded locally + the provider is stubbed, so no network is ever touched.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GEORGE_FIXTURE = readFileSync(path.join(fixtureDir, 'george.csv'), 'utf8');
const FLATEX_SECURITIES_FIXTURE = readFileSync(
  path.join(fixtureDir, 'flatex-securities.csv'),
  'utf8',
);
const FLATEX_CASH_FIXTURE = readFileSync(path.join(fixtureDir, 'flatex-cash.csv'), 'utf8');
const IBKR_FIXTURE = readFileSync(path.join(fixtureDir, 'ibkr.csv'), 'utf8');

const GEORGE_HEADER = 'Buchungsdatum;Auftragsart;Titel;ISIN;Stück;Kurs;Betrag;Spesen;Währung';
const FLATEX_SECURITIES_HEADER =
  'Buchtag;Valuta;ISIN;Bezeichnung;Nominale;Kurs;Währung;Provision;Endbetrag;Buchungsinformationen';
const IBKR_TRADES_HEADER =
  'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code';

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

/** Seed a global catalog asset (imports resolve by exact symbol/ISIN/name). */
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
  return { user, agent, pid };
}

async function upload(agent: Agent, pid: string, csv: string): Promise<ImportPreviewResponse> {
  const res = await agent
    .post('/api/v1/imports')
    .set(...XRW)
    .field('portfolioId', pid)
    .attach('file', Buffer.from(csv, 'utf8'), 'export.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
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

const txComparable = (t: Awaited<ReturnType<typeof transactions>>[number]) => ({
  side: t.side,
  symbol: t.asset.symbol,
  quantity: t.quantity,
  price: t.price,
  fee: t.fee,
  executedAt: t.executedAt,
});

describe('George (Erste Bank) through the apply path', () => {
  const seedGeorgeAssets = async () => {
    await seedAsset('BBA.VI', 'Beispiel Bau AG');
    await seedAsset('MWE.DE', 'Muster Welt ETF');
  };

  it('autodetects and applies the fixture to its exact golden entity set', async () => {
    const { agent, pid } = await setup();
    await seedGeorgeAssets();

    const preview = await upload(agent, pid, GEORGE_FIXTURE);
    expect(preview.batch.brokerId).toBe('george');
    expect(preview.batch.counts).toEqual({
      total: 4,
      mapped: 4,
      unmapped: 0,
      duplicate: 0,
      error: 0,
    });

    const result = await apply(agent, preview.batch.id);
    expect(result.applied).toBe(4);
    expect(result.failed).toBe(0);

    // Golden transaction set — exact rows, newest first (§13.4 acceptance).
    expect((await transactions(agent, pid)).map(txComparable)).toEqual([
      {
        side: 'sell',
        symbol: 'BBA.VI',
        quantity: 5,
        price: 28.1,
        fee: 5.95,
        executedAt: '2024-06-03T12:00:00.000Z',
      },
      {
        side: 'buy',
        symbol: 'MWE.DE',
        quantity: 3.5,
        price: 92,
        fee: 3.95,
        executedAt: '2024-01-15T12:00:00.000Z',
      },
      {
        side: 'buy',
        symbol: 'BBA.VI',
        quantity: 12,
        price: 25.5,
        fee: 5.95,
        executedAt: '2024-01-02T12:00:00.000Z',
      },
    ]);

    const divs = await dividends(agent, pid);
    expect(divs).toHaveLength(1);
    expect(divs[0]).toMatchObject({ grossAmountEur: 13.2, taxMode: 'none' });

    const ledger = await cash(agent, pid);
    expect(ledger.movements.map((m) => [m.kind, m.amountEur])).toEqual([['dividend', 13.2]]);
  });

  it('re-importing the fixture creates zero duplicates', async () => {
    const { agent, pid } = await setup();
    await seedGeorgeAssets();
    const first = await upload(agent, pid, GEORGE_FIXTURE);
    await apply(agent, first.batch.id);

    const second = await upload(agent, pid, GEORGE_FIXTURE);
    expect(second.batch.counts).toMatchObject({ duplicate: 4, mapped: 0 });
    const result = await apply(agent, second.batch.id);
    expect(result.applied).toBe(0);
    expect(result.rows.every((r) => r.result === 'skipped_duplicate')).toBe(true);

    expect(await transactions(agent, pid)).toHaveLength(3);
    expect(await dividends(agent, pid)).toHaveLength(1);
    expect((await cash(agent, pid)).movements).toHaveLength(1);
  });

  it('reports a malformed row while the rest lands', async () => {
    const { agent, pid } = await setup();
    await seedGeorgeAssets();
    const csv = [
      GEORGE_HEADER,
      '02.01.2024;Kauf;Beispiel Bau AG;AT0000123456;10;25,50;-255,00;0,00;EUR',
      'gestern;Kauf;Beispiel Bau AG;AT0000123456;5;25,50;-127,50;0,00;EUR',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    expect(preview.batch.counts).toMatchObject({ total: 2, mapped: 1, error: 1 });

    const result = await apply(agent, preview.batch.id);
    expect(result.applied).toBe(1);
    expect(result.rows.find((r) => r.rowIndex === 3)?.result).toBe('skipped_error');
    expect(await transactions(agent, pid)).toHaveLength(1);
  });

  it('flags an unresolvable instrument unmapped — never a silent match', async () => {
    const { agent, pid } = await setup();
    const csv = `${GEORGE_HEADER}\n02.01.2024;Kauf;Unbekannte AG;XS0000000009;1;10,00;-10,00;0,00;EUR`;
    const preview = await upload(agent, pid, csv);
    expect(preview.rows[0]?.flag).toBe('unmapped');
    expect(preview.rows[0]?.asset).toBeNull();
  });

  it('books dividends into the chosen cash source under the active tax mode (V3-P4)', async () => {
    const { agent, pid } = await setup();
    await seedGeorgeAssets();
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

    const csv = [
      GEORGE_HEADER,
      '15.01.2024;Kauf;Beispiel Bau AG;AT0000123456;10;50,00;-500,00;0,00;EUR',
      '15.03.2024;Ertrag;Beispiel Bau AG;AT0000123456;;;100,00;;EUR',
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
    expect(
      (await cash(agent, pid)).sources.find((s) => s.id === brokerSourceId)?.balanceEur,
    ).toBeCloseTo(72.5, 2);
  });
});

describe('Flatex through the apply path', () => {
  const seedFlatexAssets = async () => {
    await seedAsset('MTA.DE', 'Muster Tech AG');
    await seedAsset('BWE.DE', 'Beispiel World ETF');
  };

  it('autodetects and applies BOTH export kinds to their exact golden entity sets', async () => {
    const { agent, pid } = await setup();
    await seedFlatexAssets();

    // Wertpapierumsätze first — the cash file's Ertragsgutschrift needs the holding.
    const securities = await upload(agent, pid, FLATEX_SECURITIES_FIXTURE);
    expect(securities.batch.brokerId).toBe('flatex');
    expect(securities.batch.counts).toMatchObject({ total: 3, mapped: 3 });
    const securitiesResult = await apply(agent, securities.batch.id);
    expect(securitiesResult.applied).toBe(3);

    expect((await transactions(agent, pid)).map(txComparable)).toEqual([
      {
        side: 'sell',
        symbol: 'MTA.DE',
        quantity: 4,
        price: 60,
        fee: 5.9,
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
        fee: 5.9,
        executedAt: '2024-01-15T12:00:00.000Z',
      },
    ]);

    const cashBatch = await upload(agent, pid, FLATEX_CASH_FIXTURE);
    expect(cashBatch.batch.brokerId).toBe('flatex');
    expect(cashBatch.batch.counts).toMatchObject({ total: 3, mapped: 3 });
    const cashResult = await apply(agent, cashBatch.batch.id);
    expect(cashResult.applied).toBe(3);

    const divs = await dividends(agent, pid);
    expect(divs).toHaveLength(1);
    expect(divs[0]).toMatchObject({ grossAmountEur: 12.5, taxMode: 'none' });

    const ledger = await cash(agent, pid);
    expect(ledger.balanceEur).toBeCloseTo(1262.5, 2);
    expect(ledger.movements.map((m) => [m.kind, m.amountEur])).toEqual(
      expect.arrayContaining([
        ['deposit', 1500],
        ['dividend', 12.5],
        ['withdrawal', -250],
      ]),
    );
    expect(ledger.movements).toHaveLength(3);
  });

  it('re-importing both fixtures creates zero duplicates', async () => {
    const { agent, pid } = await setup();
    await seedFlatexAssets();
    for (const fixture of [FLATEX_SECURITIES_FIXTURE, FLATEX_CASH_FIXTURE]) {
      const first = await upload(agent, pid, fixture);
      await apply(agent, first.batch.id);
    }

    for (const fixture of [FLATEX_SECURITIES_FIXTURE, FLATEX_CASH_FIXTURE]) {
      const again = await upload(agent, pid, fixture);
      expect(again.batch.counts).toMatchObject({ duplicate: 3, mapped: 0 });
      const result = await apply(agent, again.batch.id);
      expect(result.applied).toBe(0);
      expect(result.rows.every((r) => r.result === 'skipped_duplicate')).toBe(true);
    }

    expect(await transactions(agent, pid)).toHaveLength(3);
    expect(await dividends(agent, pid)).toHaveLength(1);
    expect((await cash(agent, pid)).movements).toHaveLength(3);
  });

  it('reports a malformed row while the rest lands', async () => {
    const { agent, pid } = await setup();
    await seedFlatexAssets();
    const csv = [
      FLATEX_SECURITIES_HEADER,
      '15.01.2024;17.01.2024;DE0001234567;Muster Tech AG;10;50,00;EUR;5,90;-505,90;Kauf Xetra',
      '20.01.2024;22.01.2024;DE0001234567;Muster Tech AG;5;50,00;EUR;0,00;-250,00;Depotübertrag',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    expect(preview.batch.counts).toMatchObject({ total: 2, mapped: 1, error: 1 });
    expect(preview.rows.find((r) => r.rowIndex === 3)?.message).toContain('Depotübertrag');

    const result = await apply(agent, preview.batch.id);
    expect(result.applied).toBe(1);
    expect(await transactions(agent, pid)).toHaveLength(1);
  });

  it('flags an unresolvable dividend instrument unmapped — never a silent match', async () => {
    const { agent, pid } = await setup();
    const csv =
      'Buchtag;Valuta;Buchungsinformationen;TA-Nr.;Betrag\n' +
      '15.03.2024;15.03.2024;Ertragsgutschrift XS0000000009 Unbekannte AG;1;12,50';
    const preview = await upload(agent, pid, csv);
    expect(preview.rows[0]?.flag).toBe('unmapped');
    expect(preview.rows[0]?.asset).toBeNull();
  });
});

describe('IBKR through the apply path', () => {
  const seedIbkrAssets = async () => {
    await seedAsset('ACME', 'Acme Corp', 'USD');
    await seedAsset('MTA', 'Muster Tech AG');
  };

  it('autodetects and applies the fixture — incl. the non-EUR trades — to its golden entity set', async () => {
    const { agent, pid } = await setup();
    await seedIbkrAssets();

    const preview = await upload(agent, pid, IBKR_FIXTURE);
    expect(preview.batch.brokerId).toBe('ibkr');
    // 19 physical lines, 6 transactions — metadata/summary lines are not staged.
    expect(preview.batch.counts).toEqual({
      total: 6,
      mapped: 6,
      unmapped: 0,
      duplicate: 0,
      error: 0,
    });

    const result = await apply(agent, preview.batch.id);
    expect(result.applied).toBe(6);
    expect(result.failed).toBe(0);

    // Golden transaction set — the USD listing carries USD prices unconverted.
    expect((await transactions(agent, pid)).map(txComparable)).toEqual([
      {
        side: 'sell',
        symbol: 'ACME',
        quantity: 5,
        price: 200,
        fee: 1.02,
        executedAt: '2024-05-10T12:00:00.000Z',
      },
      {
        side: 'buy',
        symbol: 'MTA',
        quantity: 4,
        price: 51.25,
        fee: 1.25,
        executedAt: '2024-02-20T12:00:00.000Z',
      },
      {
        side: 'buy',
        symbol: 'ACME',
        quantity: 10,
        price: 185.5,
        fee: 1,
        executedAt: '2024-01-16T12:00:00.000Z',
      },
    ]);

    const divs = await dividends(agent, pid);
    expect(divs).toHaveLength(1);
    expect(divs[0]).toMatchObject({ grossAmountEur: 2, taxMode: 'none' });

    // Cash: deposit 2500 + dividend 2 − withdrawal 400.
    const ledger = await cash(agent, pid);
    expect(ledger.balanceEur).toBeCloseTo(2102, 2);
    expect(ledger.movements.map((m) => [m.kind, m.amountEur])).toEqual(
      expect.arrayContaining([
        ['deposit', 2500],
        ['dividend', 2],
        ['withdrawal', -400],
      ]),
    );
    expect(ledger.movements).toHaveLength(3);
  });

  it('re-importing the fixture creates zero duplicates', async () => {
    const { agent, pid } = await setup();
    await seedIbkrAssets();
    const first = await upload(agent, pid, IBKR_FIXTURE);
    await apply(agent, first.batch.id);

    const second = await upload(agent, pid, IBKR_FIXTURE);
    expect(second.batch.counts).toMatchObject({ duplicate: 6, mapped: 0 });
    const result = await apply(agent, second.batch.id);
    expect(result.applied).toBe(0);
    expect(result.rows.every((r) => r.result === 'skipped_duplicate')).toBe(true);

    expect(await transactions(agent, pid)).toHaveLength(3);
    expect(await dividends(agent, pid)).toHaveLength(1);
    expect((await cash(agent, pid)).movements).toHaveLength(3);
  });

  it('reports a malformed row while the rest lands', async () => {
    const { agent, pid } = await setup();
    await seedIbkrAssets();
    const csv = [
      IBKR_TRADES_HEADER,
      'Trades,Data,Order,Stocks,USD,ACME,"2024-01-16, 09:32:11",10,185.50,,,-1,,,,',
      'Trades,Data,Order,Forex,USD,EUR.USD,"2024-01-17, 10:00:00",1000,1.09,,,-2,,,,',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    expect(preview.batch.counts).toMatchObject({ total: 2, mapped: 1, error: 1 });
    expect(preview.rows.find((r) => r.rowIndex === 3)?.message).toContain('Forex');

    const result = await apply(agent, preview.batch.id);
    expect(result.applied).toBe(1);
    expect(await transactions(agent, pid)).toHaveLength(1);
  });

  it('flags an unresolvable symbol unmapped — never a silent match', async () => {
    const { agent, pid } = await setup();
    const csv = [
      IBKR_TRADES_HEADER,
      'Trades,Data,Order,Stocks,USD,ZZZZ,"2024-01-16, 09:32:11",10,185.50,,,-1,,,,',
    ].join('\n');
    const preview = await upload(agent, pid, csv);
    expect(preview.rows[0]?.flag).toBe('unmapped');
    expect(preview.rows[0]?.message).toContain('ZZZZ');
    expect(preview.rows[0]?.asset).toBeNull();
  });
});
