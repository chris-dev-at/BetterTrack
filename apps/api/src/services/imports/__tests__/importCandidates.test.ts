import { randomUUID } from 'node:crypto';

import request from 'supertest';
import {
  IMPORT_ROW_CANDIDATE_LIMIT,
  applyImportResponseSchema,
  importPreviewResponseSchema,
  type ApplyImportResponse,
  type SearchResultItem,
} from '@bettertrack/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCashSourceRepository } from '../../../data/repositories/cashSourceRepository';
import { createImportRepository } from '../../../data/repositories/importRepository';
import { createPortfolioRepository } from '../../../data/repositories/portfolioRepository';
import { createTransactionRepository } from '../../../data/repositories/transactionRepository';
import * as schema from '../../../data/schema';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import type { SearchService } from '../../search/searchService';
import { createImportService } from '../importService';
import type { BrokerMapper, NormalizedImportRow } from '../types';

/**
 * §13.4 candidate surfacing: when an instrument identity does NOT resolve, the
 * ranked near-matches the search ALREADY returned are surfaced on the preview
 * row as display-only suggestions. Hard boundaries under test: candidates are
 * captured at zero extra search cost, never auto-apply (the row stays
 * `unmapped` and is skipped by apply), are capped/de-duplicated/rank-ordered,
 * and their absence is an absent list — never a crash.
 */

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ marketData: createStubMarketData() });
});

const hit = (symbol: string, name = `${symbol} AG`): SearchResultItem => ({
  id: randomUUID(),
  providerId: 'yahoo',
  providerRef: symbol,
  symbol,
  name,
  exchange: 'XETRA',
  type: 'stock',
  currency: 'EUR',
  isCustom: false,
});

/** Seed a global catalog asset; its id is what a resolved row stages (FK). */
async function seedAsset(symbol: string, name: string) {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

/** A mapper emitting the given normalized rows, one per CSV record. */
function rowsMapper(rows: NormalizedImportRow[]): BrokerMapper {
  return {
    id: 'candidates_probe',
    label: 'Candidates probe',
    detect: () => 1,
    map: (csv) =>
      csv.records.map((record, index) => ({
        line: record.line,
        raw: record.raw,
        ok: true,
        row: rows[index]!,
      })),
  };
}

const tradeRow = (identity: Partial<NormalizedImportRow>): NormalizedImportRow => ({
  kind: 'buy',
  executedAt: new Date('2024-01-15T12:00:00.000Z'),
  isin: null,
  symbol: null,
  name: null,
  quantity: 1,
  price: 10,
  fee: 0,
  amountEur: null,
  currency: 'EUR',
  note: null,
  ...identity,
});

function stubSearch(resultsByQuery: Record<string, SearchResultItem[]>) {
  const searchCatalog = vi.fn(
    async (_userId: string, query: string, _options?: { allowEnrichment?: boolean }) => ({
      results: resultsByQuery[query] ?? [],
      enriching: false,
    }),
  );
  const search: SearchService = {
    search: searchCatalog,
    searchWithFreshness: async (userId, query) => ({
      ...(await searchCatalog(userId, query)),
      freshness: null,
    }),
    catalogFreshness: async () => null,
    enrichmentSettled: async () => {},
  };
  return { search, searchCatalog };
}

async function buildService(
  mapper: BrokerMapper,
  resultsByQuery: Record<string, SearchResultItem[]>,
) {
  const { search, searchCatalog } = stubSearch(resultsByQuery);
  const imports = createImportService({
    importRepo: createImportRepository(harness.db),
    portfolioRepo: createPortfolioRepository(harness.db),
    transactionRepo: createTransactionRepository(harness.db),
    cashSourceRepo: createCashSourceRepository(harness.db),
    search,
    portfolio: harness.ctx.portfolio,
    tax: harness.ctx.tax,
    mappers: [mapper],
  });
  return { imports, searchCatalog };
}

describe('import preview instrument candidates', () => {
  it('exposes near-matches ranked, de-duplicated by symbol, capped at five — from results already fetched', async () => {
    const user = await harness.seedUser();
    const pid = (await harness.ctx.portfolio.listPortfolios(user.id)).portfolios[0]!.id;
    const identity = tradeRow({
      symbol: 'ZZMISS',
      isin: 'XS0000000009',
      name: 'Unbekannte Holding',
    });
    // Three lookup attempts run (symbol → ISIN → name); every one of them misses.
    // The later attempts re-return earlier symbols with DIFFERENT ids to prove
    // de-duplication keeps the first (better-ranked) occurrence per symbol.
    const { imports, searchCatalog } = await buildService(rowsMapper([identity]), {
      ZZMISS: [hit('S1'), hit('S2'), hit('S3'), hit('S4'), hit('S5'), hit('S6'), hit('S7')],
      XS0000000009: [{ ...hit('S2'), id: randomUUID() }, hit('S8')],
      ['Unbekannte Holding']: [{ ...hit('S1'), id: randomUUID() }, hit('S9')],
    });

    const preview = importPreviewResponseSchema.parse(
      await imports.createBatch(user.id, {
        portfolioId: pid,
        filename: 'candidates.csv',
        content: 'x\ny',
        brokerId: 'candidates_probe',
      }),
    );
    const row = preview.rows[0]!;

    expect(row.flag).toBe('unmapped');
    expect(row.asset).toBeNull();
    expect(row.candidates?.map((c) => c.symbol)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(row.candidates).toHaveLength(IMPORT_ROW_CANDIDATE_LIMIT);
    // Every suggestion carries what a human needs — and nothing invented:
    for (const c of row.candidates ?? []) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.symbol).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(c.currency).toBe('EUR');
      expect(c.exchange).toBe('XETRA');
      expect(c.type).toBe('stock');
      expect(Object.keys(c).sort()).toEqual([
        'currency',
        'exchange',
        'id',
        'name',
        'symbol',
        'type',
      ]);
    }

    // Zero extra searches: 3 local-pass + 3 budgeted enrichment attempts +
    // 3 catalog-only sweep calls — exactly what resolution spent before this
    // feature existed; capture rides on those result sets.
    expect(searchCatalog).toHaveBeenCalledTimes(9);
    const enrichingCalls = searchCatalog.mock.calls.filter(
      ([, , options]) => options?.allowEnrichment !== false,
    );
    expect(enrichingCalls).toHaveLength(3);

    // The suggestions survive a re-read of the staged batch.
    const reread = importPreviewResponseSchema.parse(
      await imports.getBatch(user.id, preview.batch.id),
    );
    expect(reread.rows[0]?.candidates).toEqual(row.candidates);
  });

  it('never auto-applies: the row stays unmapped and apply skips it', async () => {
    const user = await harness.seedUser();
    const pid = (await harness.ctx.portfolio.listPortfolios(user.id)).portfolios[0]!.id;
    const identity = tradeRow({ symbol: 'ONLYMISS' });
    const { imports } = await buildService(rowsMapper([identity]), {
      ONLYMISS: [hit('NEAR1'), hit('NEAR2')],
    });

    const preview = await imports.createBatch(user.id, {
      portfolioId: pid,
      filename: 'no-auto-apply.csv',
      content: 'x\ny',
      brokerId: 'candidates_probe',
    });
    expect(preview.rows[0]?.flag).toBe('unmapped');
    expect(preview.batch.counts).toMatchObject({ mapped: 0, unmapped: 1 });

    const result: ApplyImportResponse = applyImportResponseSchema.parse(
      await imports.applyBatch(user.id, preview.batch.id, {}),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.rows[0]?.result).toBe('skipped_unmapped');

    // Nothing reached the portfolio — the suggestions stayed information only.
    const txRepo = createTransactionRepository(harness.db);
    expect(await txRepo.listForPortfolio(pid)).toHaveLength(0);

    // The stored preview flag survives apply untouched.
    const after = await imports.getBatch(user.id, preview.batch.id);
    expect(after.rows[0]?.flag).toBe('unmapped');
    expect(after.rows[0]?.asset).toBeNull();
  });

  it('leaves an exactly-resolved row unchanged and without candidates', async () => {
    const user = await harness.seedUser();
    const pid = (await harness.ctx.portfolio.listPortfolios(user.id)).portfolios[0]!.id;
    const seededExact = await seedAsset('EXACTQ', 'Exact Q AG');
    const identity = tradeRow({ symbol: 'EXACTQ' });
    // The stub answers with the REAL catalog row id, as the search service does.
    const { imports } = await buildService(rowsMapper([identity]), {
      EXACTQ: [{ ...hit('EXACTQ', 'Exact Q AG'), id: seededExact.id }, hit('OTHER1')],
    });

    const preview = await imports.createBatch(user.id, {
      portfolioId: pid,
      filename: 'exact.csv',
      content: 'x\ny',
      brokerId: 'candidates_probe',
    });
    expect(preview.rows[0]?.flag).toBe('mapped');
    expect(preview.rows[0]?.asset?.symbol).toBe('EXACTQ');
    expect(preview.rows[0]?.candidates).toBeUndefined();

    const result = await imports.applyBatch(user.id, preview.batch.id, {});
    expect(result.applied).toBe(1);
  });

  it('stages an empty-handed miss with an absent candidate list instead of crashing', async () => {
    const user = await harness.seedUser();
    const pid = (await harness.ctx.portfolio.listPortfolios(user.id)).portfolios[0]!.id;
    const identity = tradeRow({ name: 'Nirgendwo AG' });
    const { imports, searchCatalog } = await buildService(rowsMapper([identity]), {});

    const preview = await imports.createBatch(user.id, {
      portfolioId: pid,
      filename: 'nothing.csv',
      content: 'x\ny',
      brokerId: 'candidates_probe',
    });
    expect(searchCatalog).toHaveBeenCalled();
    expect(preview.rows[0]?.flag).toBe('unmapped');
    expect(preview.rows[0]?.message).toContain('Nirgendwo AG');
    expect(preview.rows[0]?.candidates).toBeUndefined();
  });

  it('surfaces real catalog near-matches over HTTP and keeps them on re-read', async () => {
    const user = await harness.seedUser();
    const pid = (await harness.ctx.portfolio.listPortfolios(user.id)).portfolios[0]!.id;
    await seedAsset('MTA.DE', 'Muster Tech AG');
    const agent = request.agent(harness.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);

    const csv = [
      'Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Gebühr;Betrag;Währung',
      '2024-01-15;Kauf;Muster Tech AG Inhaber;XS0000000042;1;10,00;0;-10,00;EUR',
    ].join('\n');
    const res = await agent
      .post('/api/v1/imports')
      .set('X-Requested-With', 'BetterTrack')
      .field('portfolioId', pid)
      .field('brokerId', 'trade_republic')
      .attach('file', Buffer.from(csv, 'utf8'), 'export.csv');
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const preview = importPreviewResponseSchema.parse(res.body);
    const row = preview.rows[0]!;
    // "Muster Tech AG Inhaber" fails exact whole-name identity against the
    // seeded "Muster Tech AG" but the catalog search returns it as a near-match.
    expect(row.flag).toBe('unmapped');
    expect(row.asset).toBeNull();
    expect(row.candidates?.map((c) => c.symbol)).toContain('MTA.DE');

    const reread = importPreviewResponseSchema.parse(
      (await agent.get(`/api/v1/imports/${preview.batch.id}`)).body,
    );
    expect(reread.rows[0]?.candidates?.map((c) => c.symbol)).toContain('MTA.DE');

    // And nothing was booked.
    expect(await harness.db.select().from(schema.transactions)).toHaveLength(0);
  });
});
