import { randomUUID } from 'node:crypto';

import request from 'supertest';
import {
  IMPORT_ROW_CANDIDATE_EXCHANGE_MAX,
  IMPORT_ROW_CANDIDATE_LIMIT,
  IMPORT_ROW_CANDIDATE_NAME_MAX,
  IMPORT_ROW_CANDIDATE_SYMBOL_MAX,
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
  it('INTERLEAVES the lookup attempts instead of letting the symbol attempt take the whole cap', async () => {
    const user = await harness.seedUser();
    const pid = (await harness.ctx.portfolio.listPortfolios(user.id)).portfolios[0]!.id;
    const identity = tradeRow({
      symbol: 'ZZMISS',
      isin: 'XS0000000009',
      name: 'Unbekannte Holding',
    });
    // Three lookup attempts run (symbol → ISIN → name); every one of them misses.
    // The later attempts re-return earlier symbols with DIFFERENT ids, which
    // pins WHICH occurrence de-duplication keeps.
    const isinS2 = { ...hit('S2'), id: randomUUID() };
    const nameS1 = { ...hit('S1'), id: randomUUID() };
    const { imports, searchCatalog } = await buildService(rowsMapper([identity]), {
      ZZMISS: [hit('S1'), hit('S2'), hit('S3'), hit('S4'), hit('S5'), hit('S6'), hit('S7')],
      XS0000000009: [isinS2, hit('S8')],
      ['Unbekannte Holding']: [nameS1, hit('S9')],
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

    // !! THIS ASSERTION WAS CHANGED ON PURPOSE, AND THE OLD ONE WAS WRONG. !!
    //
    // It previously read `['S1','S2','S3','S4','S5']` — every entry from the
    // SYMBOL attempt — and called that correct. It was not correct, it was the
    // starvation bug written down as a specification: candidates were
    // concatenated in attempt order, the symbol attempt runs first, and here it
    // returns seven hits, so it consumed the entire cap of five and the ISIN and
    // NAME attempts contributed NOTHING. S8 and S9 — the only things those two
    // attempts found — could never be shown. For a row that failed to resolve,
    // the name attempt is very often the one holding the suggestion the user
    // actually wants (see the trade_republic case at the bottom of this file:
    // "Muster Tech AG Inhaber" resolves against nothing, and only its name
    // search finds "Muster Tech AG"). Do not "restore" the old expectation.
    //
    // Round-robin instead: best of each attempt, then second of each, …
    //   rank 0 → S1 (symbol) · S2 (ISIN) · S1 again (name, de-duplicated away)
    //   rank 1 → S2 again (de-duplicated) · S8 (ISIN) · S9 (name)
    //   rank 2 → S3 (symbol) — cap reached.
    expect(row.candidates?.map((c) => c.symbol)).toEqual(['S1', 'S2', 'S8', 'S9', 'S3']);
    expect(row.candidates).toHaveLength(IMPORT_ROW_CANDIDATE_LIMIT);
    // Every attempt that found something is represented — that is the point.
    expect(row.candidates?.map((c) => c.symbol)).toEqual(expect.arrayContaining(['S8', 'S9']));

    // De-duplication keeps the FIRST occurrence in that round-robin traversal,
    // which ranks by within-attempt rank first: the ISIN attempt's top hit
    // outranks the symbol attempt's second hit, so S2 is the ISIN copy. S1 is
    // the symbol copy, because there it is rank 0 and in the name attempt it is
    // also rank 0 but that lane is visited later in the same round.
    expect(row.candidates?.find((c) => c.symbol === 'S2')?.id).toBe(isinS2.id);
    expect(row.candidates?.find((c) => c.symbol === 'S1')?.id).not.toBe(nameS1.id);
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

  it('TRUNCATES over-long provider strings at capture instead of rejecting the candidate', async () => {
    const user = await harness.seedUser();
    const pid = (await harness.ctx.portfolio.listPortfolios(user.id)).portfolios[0]!.id;
    const identity = tradeRow({ symbol: 'LONGMISS' });
    // A provider is free to return a megabyte of `name`. Unbounded, that string
    // is persisted once per staged row referencing the identity — so it is
    // clipped where it enters, not where it is read. Clipping is deliberately
    // preferred over rejection: a long name is cosmetic, but refusing the
    // candidate would take the row's whole suggestion list with it.
    const monstrous: SearchResultItem = {
      ...hit('S'.repeat(200)),
      name: 'N'.repeat(5_000_000),
      exchange: 'X'.repeat(500),
    };
    const { imports } = await buildService(rowsMapper([identity]), {
      LONGMISS: [monstrous, hit('SANE')],
    });

    // The response schema enforces the same ceilings, so an untruncated capture
    // would make this parse throw rather than quietly ship a 5 MB row.
    const preview = importPreviewResponseSchema.parse(
      await imports.createBatch(user.id, {
        portfolioId: pid,
        filename: 'long.csv',
        content: 'x\ny',
        brokerId: 'candidates_probe',
      }),
    );
    const [clipped, sane] = preview.rows[0]!.candidates ?? [];

    expect(clipped?.symbol).toHaveLength(IMPORT_ROW_CANDIDATE_SYMBOL_MAX);
    expect(clipped?.name).toHaveLength(IMPORT_ROW_CANDIDATE_NAME_MAX);
    expect(clipped?.exchange).toHaveLength(IMPORT_ROW_CANDIDATE_EXCHANGE_MAX);
    // Clipped, not mangled: still a prefix of what the provider said.
    expect(monstrous.name.startsWith(clipped?.name ?? '')).toBe(true);
    // The candidate survived rather than being dropped, and so did its sibling.
    expect(sane?.symbol).toBe('SANE');
    expect(preview.rows[0]?.flag).toBe('unmapped');
  });

  it('holds only what the cap can use, however much the search returns', async () => {
    const user = await harness.seedUser();
    const pid = (await harness.ctx.portfolio.listPortfolios(user.id)).portfolios[0]!.id;
    const identity = tradeRow({ symbol: 'FLOODMISS', name: 'Flood AG' });
    // The sink used to retain every hit of every attempt — up to ~36k
    // SearchResultItems per identity — to hand five of them to the UI. It now
    // stops each attempt's lane at the cap. That bound is EXACT, not lossy: the
    // round-robin can never read past rank 4 of any lane, because doing so would
    // require five earlier entries of that lane to have been picked or
    // de-duplicated against picks, which is already the whole cap.
    const flood = Array.from({ length: 3_000 }, (_unused, index) => hit(`F${index}`));
    const { imports } = await buildService(rowsMapper([identity]), {
      FLOODMISS: flood,
      ['Flood AG']: [hit('NAMEHIT')],
    });

    const preview = importPreviewResponseSchema.parse(
      await imports.createBatch(user.id, {
        portfolioId: pid,
        filename: 'flood.csv',
        content: 'x\ny',
        brokerId: 'candidates_probe',
      }),
    );

    // Exactly the five the interleave would have chosen from the unbounded set:
    // rank 0 takes F0 then NAMEHIT, then ranks 1-3 take F1..F3 (the name lane is
    // exhausted). Nothing from rank 5 of the flood lane is reachable.
    expect(preview.rows[0]?.candidates?.map((c) => c.symbol)).toEqual([
      'F0',
      'NAMEHIT',
      'F1',
      'F2',
      'F3',
    ]);
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
