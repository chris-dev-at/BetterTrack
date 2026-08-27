import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PORTFOLIO_KIND,
  MAX_CASH_AMOUNT_EUR,
  MAX_TAX_REPORT_FIGURE_EUR,
  PORTFOLIO_KINDS,
  cashEntryRequestSchema,
  cashMovementKindSchema,
  cashMovementsQuerySchema,
  cashPreviewRequestSchema,
  createPortfolioRequestSchema,
  decodeTransactionExecutedAtCursor,
  encodeTransactionExecutedAtCursor,
  importSourceTag,
  portfolioKindSchema,
  portfolioSummarySchema,
  sourceTagSchema,
  taxYearChangesResponseSchema,
  taxYearReportResponseSchema,
  taxYearSummarySchema,
  transactionListQuerySchema,
  transactionListResponseSchema,
  updatePortfolioRequestSchema,
  vaultTaxYearReportResponseSchema,
} from './portfolio';

describe('cash amount validation (§14 hardening)', () => {
  it('accepts a normal positive magnitude', () => {
    expect(cashEntryRequestSchema.safeParse({ amountEur: 1000 }).success).toBe(true);
    expect(cashEntryRequestSchema.safeParse({ amountEur: MAX_CASH_AMOUNT_EUR }).success).toBe(true);
  });

  it('rejects a non-finite amount rather than letting Infinity reach the ledger', () => {
    // A finite guard: without it, zod `.number()` admits Infinity, which reaches
    // Postgres `numeric(20,6)` as a 500 instead of a clean 400.
    expect(cashEntryRequestSchema.safeParse({ amountEur: Infinity }).success).toBe(false);
    expect(cashEntryRequestSchema.safeParse({ amountEur: -Infinity }).success).toBe(false);
    expect(cashEntryRequestSchema.safeParse({ amountEur: Number.NaN }).success).toBe(false);
  });

  it('rejects an amount beyond the representable ledger range', () => {
    expect(cashEntryRequestSchema.safeParse({ amountEur: MAX_CASH_AMOUNT_EUR + 1 }).success).toBe(
      false,
    );
    expect(cashEntryRequestSchema.safeParse({ amountEur: 1e300 }).success).toBe(false);
  });

  it('still rejects zero and negative magnitudes', () => {
    expect(cashEntryRequestSchema.safeParse({ amountEur: 0 }).success).toBe(false);
    expect(cashEntryRequestSchema.safeParse({ amountEur: -5 }).success).toBe(false);
  });

  it('applies the same bounds to the preview schema', () => {
    expect(cashPreviewRequestSchema.safeParse({ kind: 'deposit', amountEur: 50 }).success).toBe(
      true,
    );
    expect(
      cashPreviewRequestSchema.safeParse({ kind: 'deposit', amountEur: Infinity }).success,
    ).toBe(false);
    expect(cashPreviewRequestSchema.safeParse({ kind: 'deposit', amountEur: 1e300 }).success).toBe(
      false,
    );
  });
});

describe('cash movement kinds (§16 2026-07-30 — the `fee` kind)', () => {
  it('pins the wire enum, `fee` included', () => {
    // `packages/contracts` depends on zod alone (never on `@bettertrack/domain`),
    // so it cannot assert agreement with `CASH_MOVEMENT_KINDS` here — the real
    // three-way cross-check against the domain list AND the Postgres enum lives
    // in apps/api/src/__tests__/cashFee.test.ts, where all three are in scope.
    // This is the change detector for the wire shape itself.
    expect([...cashMovementKindSchema.options].sort()).toEqual(
      [
        'buy',
        'deposit',
        'dividend',
        'fee',
        'sell_proceeds',
        'tax_refund',
        'tax_withholding',
        'transfer_in',
        'transfer_out',
        'withdrawal',
      ].sort(),
    );
  });

  it('lets the preview endpoint size a proposed fee like any other outflow', () => {
    expect(cashPreviewRequestSchema.safeParse({ kind: 'fee', amountEur: 12.5 }).success).toBe(true);
    // Still a positive MAGNITUDE on the wire — the service assigns the sign.
    expect(cashPreviewRequestSchema.safeParse({ kind: 'fee', amountEur: -12.5 }).success).toBe(
      false,
    );
  });
});

describe('source tag validation (V5-P0c)', () => {
  it('accepts manual, standing-order, and import/sync slugs', () => {
    for (const tag of [
      'manual',
      'standing-order',
      'import:trade_republic',
      'import:george',
      'import:flatex',
      'import:ibkr',
      'sync:parqet',
      'sync:george',
    ]) {
      expect(sourceTagSchema.safeParse(tag).success, tag).toBe(true);
    }
  });

  it('rejects malformed, uppercase, empty-slug, and unknown-kind tags', () => {
    for (const tag of [
      'IMPORT',
      'import',
      'import:',
      'import:Trade_Republic',
      'sync',
      'export:foo',
      'sync :parqet',
      'manual:x',
      '',
    ]) {
      expect(sourceTagSchema.safeParse(tag).success, tag).toBe(false);
    }
  });

  it('builds a valid import tag from a broker id', () => {
    expect(importSourceTag('trade_republic')).toBe('import:trade_republic');
    expect(sourceTagSchema.safeParse(importSourceTag('george')).success).toBe(true);
  });
});

describe('cash movement pagination', () => {
  it('coerces a bounded limit and accepts UUID or untagged filters', () => {
    const cursor = '11111111-1111-7111-8111-111111111111';
    expect(cashMovementsQuerySchema.parse({ cursor, limit: '20', tag: cursor })).toEqual({
      cursor,
      limit: 20,
      tag: cursor,
    });
    expect(cashMovementsQuerySchema.safeParse({ tag: 'untagged' }).success).toBe(true);
  });

  it('rejects malformed cursors, tags, and out-of-range limits', () => {
    expect(cashMovementsQuerySchema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false);
    expect(cashMovementsQuerySchema.safeParse({ tag: 'food' }).success).toBe(false);
    expect(cashMovementsQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});

describe('transaction pagination modes and facets', () => {
  const id = '11111111-1111-7111-8111-111111111111';
  const assetId = '22222222-2222-7222-8222-222222222222';
  const executedAt = '2026-08-05T12:34:56.000Z';

  it('keeps the legacy UUID cursor as the default and accepts bounded asset filters', () => {
    expect(transactionListQuerySchema.parse({ cursor: id, limit: '8', assetId })).toEqual({
      cursor: id,
      limit: 8,
      assetId,
      order: 'id',
      includeSourceTags: false,
    });
    expect(transactionListQuerySchema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false);
  });

  it('round-trips the compound executed-time cursor only in its explicit ordering mode', () => {
    const cursor = encodeTransactionExecutedAtCursor({ executedAt, id });
    expect(decodeTransactionExecutedAtCursor(cursor)).toEqual({ executedAt, id });
    expect(
      transactionListQuerySchema.parse({
        cursor,
        order: 'executedAt',
        includeSourceTags: 'true',
      }),
    ).toEqual({ cursor, order: 'executedAt', includeSourceTags: true });

    expect(transactionListQuerySchema.safeParse({ cursor, order: 'id' }).success).toBe(false);
    expect(transactionListQuerySchema.safeParse({ cursor: id, order: 'executedAt' }).success).toBe(
      false,
    );
  });

  it('validates the optional distinct-source response facet', () => {
    expect(
      transactionListResponseSchema.safeParse({
        items: [],
        nextCursor: null,
        sourceTags: ['manual', 'standing-order', 'import:george'],
      }).success,
    ).toBe(true);
    expect(
      transactionListResponseSchema.safeParse({
        items: [],
        nextCursor: null,
        sourceTags: ['forged:source'],
      }).success,
    ).toBe(false);
  });
});

describe('living tax-year documentation (§16 2026-08-19)', () => {
  const summary = {
    year: 2025,
    lastChangedAt: '2026-08-19T10:30:00.000Z',
    realizedPnlEur: 100,
    dividendsGrossEur: 0,
    taxWithheldEur: 27.5,
    taxRefundedEur: 0,
    taxNetEur: 27.5,
  };

  it('the year summary requires a nullable last-change marker', () => {
    expect(taxYearSummarySchema.safeParse(summary).success).toBe(true);
    expect(taxYearSummarySchema.safeParse({ ...summary, lastChangedAt: null }).success).toBe(true);
    expect(taxYearSummarySchema.safeParse({ ...summary, lastChangedAt: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('the account documentation list carries newest-first-compatible markers', () => {
    expect(
      taxYearChangesResponseSchema.safeParse({
        years: [
          { year: 2025, lastChangedAt: '2026-08-19T10:30:00.000Z' },
          { year: 2024, lastChangedAt: null },
        ],
      }).success,
    ).toBe(true);
    expect(taxYearChangesResponseSchema.safeParse({ years: [{ year: 2025 }] }).success).toBe(false);
  });
});

describe('portfolio kind (board #69)', () => {
  const summary = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Main',
    visibility: 'private' as const,
    sortOrder: 0,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
  };

  it('is exactly the five tokens both clients ported, in their shipped order', () => {
    // The web `portfolioKinds.ts` stopgap defined this list and the mobile app
    // ported these hues off it. Renaming or reordering a token silently
    // repaints (or blanks) icons on a client we cannot redeploy, so the enum is
    // pinned literally here rather than derived from anything.
    expect(PORTFOLIO_KINDS).toEqual(['private', 'family', 'business', 'savings', 'property']);
    expect(DEFAULT_PORTFOLIO_KIND).toBe('private');
    expect(PORTFOLIO_KINDS).toContain(DEFAULT_PORTFOLIO_KIND);
    for (const kind of PORTFOLIO_KINDS) {
      expect(portfolioKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(portfolioKindSchema.safeParse('yacht').success).toBe(false);
    expect(portfolioKindSchema.safeParse('PRIVATE').success).toBe(false);
  });

  it('reads back as a kind, as null, or absent — all three are legal', () => {
    // Absent keeps every pre-#69 fixture and every older client parsing; null is
    // "the user never chose", which is what lets a client that carried local
    // kinds keep falling back to them until the first server write.
    expect(portfolioSummarySchema.safeParse({ ...summary, kind: 'family' }).success).toBe(true);
    expect(portfolioSummarySchema.safeParse({ ...summary, kind: null }).success).toBe(true);
    expect(portfolioSummarySchema.safeParse(summary).success).toBe(true);
    expect(portfolioSummarySchema.safeParse({ ...summary, kind: 'yacht' }).success).toBe(false);
  });

  it('create accepts an optional concrete kind and nothing else', () => {
    expect(createPortfolioRequestSchema.parse({ name: 'Book', kind: 'savings' })).toEqual({
      name: 'Book',
      kind: 'savings',
    });
    expect(createPortfolioRequestSchema.safeParse({ name: 'Book' }).success).toBe(true);
    // No clear-back-to-null verb: the picker has no "none" option.
    expect(createPortfolioRequestSchema.safeParse({ name: 'Book', kind: null }).success).toBe(
      false,
    );
    expect(createPortfolioRequestSchema.safeParse({ name: 'Book', kind: 'yacht' }).success).toBe(
      false,
    );
  });

  it('update accepts a kind alone, mixed, or not at all', () => {
    expect(updatePortfolioRequestSchema.parse({ kind: 'business' })).toEqual({ kind: 'business' });
    expect(
      updatePortfolioRequestSchema.safeParse({ name: 'Renamed', kind: 'property' }).success,
    ).toBe(true);
    expect(updatePortfolioRequestSchema.safeParse({}).success).toBe(true);
    expect(updatePortfolioRequestSchema.safeParse({ kind: null }).success).toBe(false);
    expect(updatePortfolioRequestSchema.safeParse({ kind: 'yacht' }).success).toBe(false);
  });
});

describe('vault tax report bounds (#1514 review F4)', () => {
  const asset = {
    id: '018f0000-0000-7000-8000-0000000005a1',
    symbol: 'TEST',
    name: 'TEST VECTOR asset',
    exchange: 'XETRA',
    currency: 'EUR',
    type: 'stock',
    isCustom: false,
    category: null,
    smoothing: false,
  };

  function reportWith(realizedPnlEur: number, grossAmountEur: number): unknown {
    return {
      year: 2026,
      summary: {
        year: 2026,
        lastChangedAt: '2026-06-01T10:00:00.000Z',
        realizedPnlEur,
        dividendsGrossEur: grossAmountEur,
        taxWithheldEur: 0,
        taxRefundedEur: 0,
        taxNetEur: 0,
      },
      positions: [
        {
          asset,
          realizedPnlEur,
          dividendsGrossEur: grossAmountEur,
          taxEur: 0,
          sells: [
            {
              transactionId: '018f0000-0000-7000-8000-0000000005a2',
              executedAt: '2026-03-01T10:00:00.000Z',
              quantity: 1,
              proceedsEur: 0,
              costBasisEur: 0,
              realizedPnlEur,
              taxMode: 'country_specific',
              taxAmountEur: null,
              taxCountry: 'DE',
              taxParams: null,
            },
          ],
          dividends: [
            {
              dividendId: '018f0000-0000-7000-8000-0000000005a3',
              executedAt: '2026-06-01T10:00:00.000Z',
              grossAmountEur,
              taxMode: 'country_specific',
              taxAmountEur: null,
              taxCountry: 'DE',
              taxParams: null,
            },
          ],
        },
      ],
    };
  }

  it('leaves the published server response contract exactly as it was', () => {
    // The bound belongs to the VAULT path only. Tightening the response schema
    // would turn an out-of-range server figure into a whole-page `.parse`
    // failure in portfolioApi and would change the OpenAPI document; the
    // paranoid path wants a one-portfolio degradation instead.
    expect(taxYearReportResponseSchema.safeParse(reportWith(1.7e308, 1.7e308)).success).toBe(true);
    expect(taxYearReportResponseSchema.safeParse(reportWith(Infinity, 0)).success).toBe(true);
  });

  it('accepts every magnitude a server can actually produce', () => {
    // `numeric(20,6)` — the widest EUR column behind a report — tops out just
    // under 1e14, and user entry is capped at MAX_CASH_AMOUNT_EUR (1e12).
    expect(MAX_TAX_REPORT_FIGURE_EUR).toBeGreaterThan(1e14);
    expect(MAX_TAX_REPORT_FIGURE_EUR).toBeGreaterThan(MAX_CASH_AMOUNT_EUR);
    expect(MAX_TAX_REPORT_FIGURE_EUR).toBeLessThan(Number.MAX_SAFE_INTEGER);

    for (const magnitude of [0, 1234.56, MAX_CASH_AMOUNT_EUR, 1e14, MAX_TAX_REPORT_FIGURE_EUR]) {
      expect(
        vaultTaxYearReportResponseSchema.safeParse(reportWith(-magnitude, magnitude)).success,
        `magnitude ${magnitude}`,
      ).toBe(true);
    }
  });

  it('rejects the row magnitudes that overflow a pooled settlement', () => {
    expect(vaultTaxYearReportResponseSchema.safeParse(reportWith(1.7e308, 0)).success).toBe(false);
    expect(vaultTaxYearReportResponseSchema.safeParse(reportWith(-1.7e308, 0)).success).toBe(false);
    expect(vaultTaxYearReportResponseSchema.safeParse(reportWith(0, 1.7e308)).success).toBe(false);
    expect(
      vaultTaxYearReportResponseSchema.safeParse(reportWith(MAX_TAX_REPORT_FIGURE_EUR + 1e9, 0))
        .success,
    ).toBe(false);
  });

  it('rejects non-finite row figures the base contract still admits', () => {
    for (const figure of [Infinity, -Infinity, Number.NaN]) {
      expect(
        vaultTaxYearReportResponseSchema.safeParse(reportWith(figure, 0)).success,
        `realizedPnlEur ${String(figure)}`,
      ).toBe(false);
      expect(
        vaultTaxYearReportResponseSchema.safeParse(reportWith(0, figure)).success,
        `grossAmountEur ${String(figure)}`,
      ).toBe(false);
    }
  });

  it('keeps the strictness the base schemas were declared with', () => {
    // `.extend()` must not have quietly rebuilt these objects as passthrough:
    // an unknown key on a vault-supplied row is exactly the kind of smuggling
    // the strict contract exists to refuse.
    const base = reportWith(1, 1) as {
      positions: { sells: Record<string, unknown>[] }[];
    };
    base.positions[0]!.sells[0]!.smuggled = 'payload';

    expect(vaultTaxYearReportResponseSchema.safeParse(base).success).toBe(false);
    expect(taxYearReportResponseSchema.safeParse(base).success).toBe(false);
  });
});
