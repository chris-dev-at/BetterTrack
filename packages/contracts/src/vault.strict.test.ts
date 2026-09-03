import { describe, expect, it } from 'vitest';

import {
  paranoidDisableRequestSchema,
  paranoidDisableRehydrationRequestSchema,
  paranoidDisableRehydrationResultSchema,
  paranoidDisableResponseSchema,
  paranoidEnableRequestSchema,
  paranoidEnableResponseSchema,
  paranoidForkProvenanceResponseSchema,
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_ENTITY_KINDS,
  VAULT_MIRROR_PROVENANCE_DROPPED_COLUMNS,
  type VaultStrictEntity,
  vaultDocumentV1Schema,
  vaultMediaStateSchema,
  vaultMirrorProvenanceSchema,
  vaultStrictDocumentV1Schema,
  vaultStrictEntitySchema,
} from './vault';

const uuid = (value: number) => `018f0000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
const AT = '2026-07-24T10:00:00.000Z';
const USER_ID = uuid(1);
const PORTFOLIO_ID = uuid(2);
const ASSET_ID = uuid(3);
const CASH_SOURCE_ID = uuid(4);
const CATEGORY_ID = uuid(5);
const ORDER_ID = uuid(6);
const BUDGET_ID = uuid(7);
const CASH_TAG_ID = uuid(30);
const CASH_BUDGET_ID = uuid(32);
const CASH_RULE_ID = uuid(34);
const ORIGINAL_EXPENSE_HASH = 'a'.repeat(64);

describe('public paranoid transitions', () => {
  const emptyDocument = {
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities: [],
    mergeLog: [],
    mirrorProvenance: [],
  };

  it('ties selected media evidence to one exact supported vault version', () => {
    const REVISION = 'aXf9_capture-token';
    expect(
      paranoidEnableRequestSchema.parse({
        mediaSet: ['server'],
        vaultVersion: 1,
        normalDataRevision: REVISION,
      }),
    ).toEqual({
      mediaSet: ['server'],
      vaultVersion: 1,
      driveAttestation: null,
      normalDataRevision: REVISION,
    });
    expect(
      paranoidEnableRequestSchema.parse({
        mediaSet: ['drive'],
        vaultVersion: 7,
        driveAttestation: { verifiedRoundTrip: true, vaultVersion: 7 },
        normalDataRevision: REVISION,
      }),
    ).toEqual({
      mediaSet: ['drive'],
      vaultVersion: 7,
      driveAttestation: { verifiedRoundTrip: true, vaultVersion: 7 },
      normalDataRevision: REVISION,
    });

    for (const invalid of [
      { mediaSet: ['drive'], vaultVersion: 7, normalDataRevision: REVISION },
      {
        mediaSet: ['drive'],
        vaultVersion: 7,
        driveAttestation: { verifiedRoundTrip: true, vaultVersion: 6 },
        normalDataRevision: REVISION,
      },
      {
        mediaSet: ['server'],
        vaultVersion: 7,
        driveAttestation: { verifiedRoundTrip: true, vaultVersion: 7 },
        normalDataRevision: REVISION,
      },
      { mediaSet: ['server'], vaultVersion: 0, normalDataRevision: REVISION },
      { mediaSet: ['server'], vaultVersion: 1, normalDataRevision: REVISION, plaintextHash: 'x' },
      // The capture token is NOT optional: an enable without it would skip the
      // compare-and-swap on the one transition that cannot be undone.
      { mediaSet: ['server'], vaultVersion: 1 },
      { mediaSet: ['server'], vaultVersion: 1, normalDataRevision: '' },
      { mediaSet: ['server'], vaultVersion: 1, normalDataRevision: 'not a token' },
    ]) {
      expect(paranoidEnableRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('requires explicit disable confirmation and preserves the PD3a idempotency key', () => {
    const request = {
      confirm: true,
      rehydrationId: uuid(90),
      document: emptyDocument,
    };
    expect(paranoidDisableRequestSchema.parse(request)).toEqual(request);
    expect(paranoidDisableRequestSchema.safeParse({ ...request, confirm: false }).success).toBe(
      false,
    );
    expect(
      paranoidDisableRequestSchema.safeParse({
        ...request,
        document: { ...emptyDocument, schemaVersion: 2 },
      }).success,
    ).toBe(false);
  });

  it('keeps public receipts portfolio-free and strict', () => {
    const enabled = {
      mode: 'paranoid',
      mediaSet: ['server'],
      vaultVersion: 3,
      completedAt: AT,
      idempotent: false,
    };
    expect(paranoidEnableResponseSchema.parse(enabled)).toEqual(enabled);
    expect(paranoidEnableResponseSchema.safeParse({ ...enabled, portfolioCount: 2 }).success).toBe(
      false,
    );

    const disabled = {
      mode: 'normal',
      rehydrationId: uuid(90),
      completedAt: AT,
      idempotent: true,
      postCommit: { invalidate: ['account'] },
    };
    expect(paranoidDisableResponseSchema.parse(disabled)).toEqual(disabled);
    expect(
      paranoidDisableResponseSchema.safeParse({ ...disabled, documentHash: 'no' }).success,
    ).toBe(false);
  });
});

const meta = (id: string) => ({
  id,
  rev: 3,
  editedAt: AT,
  editedBy: uuid(99),
  deletedAt: null,
});

/**
 * One fully populated persisted row per vault-classified table. Numeric values
 * stay decimal strings, timestamps stay ISO strings, and JSON columns stay
 * JSON: parsing never converts, defaults, hashes, or reconstructs a column.
 */
const fixtures: VaultStrictEntity[] = [
  {
    ...meta(PORTFOLIO_ID),
    kind: 'portfolio',
    data: {
      userId: USER_ID,
      name: 'Main',
      visibility: 'private',
      sortOrder: 2,
      defaultPayFromCash: true,
      archivedAt: '2026-07-25T10:00:00.000Z',
      kind: 'business',
      // Vaults v2: a portfolio that lived in a v2 vault must come back pointing
      // at the same vault, so the membership is part of the persisted fixture.
      vaultId: uuid(77),
      alias: 'Locked wallet',
      // E0 (#1410): the fresh `portfolios.vault_alias` column — always null in
      // an ACCOUNT-level document (the two paranoid systems are mutually
      // exclusive per account), carried so the strict payload stays
      // column-complete.
      vaultAlias: null,
    },
  },
  {
    ...meta(uuid(10)),
    kind: 'transaction',
    data: {
      portfolioId: PORTFOLIO_ID,
      assetId: ASSET_ID,
      side: 'sell',
      quantity: '1.25000000',
      price: '123.456789',
      fee: '1.250000',
      executedAt: AT,
      note: 'frozen facts',
      taxMode: 'custom',
      taxCountry: 'DE',
      taxAmountEur: '-5.500000',
      taxParams: {
        ratePct: 27.5,
        lossOffset: true,
        refund: true,
        yearReset: true,
        carryForward: true,
        costBasis: 'fifo',
      },
      allowUncovered: true,
      uncoveredEntryPrice: '100.000000',
      source: 'import:ibkr',
    },
  },
  {
    ...meta(uuid(11)),
    kind: 'dividend',
    data: {
      portfolioId: PORTFOLIO_ID,
      assetId: ASSET_ID,
      cashSourceId: CASH_SOURCE_ID,
      grossAmountEur: '12.500000',
      executedAt: AT,
      note: 'quarterly',
      taxMode: 'country_specific',
      taxCountry: 'DE',
      taxAmountEur: '3.296875',
      taxParams: { source: 'frozen' },
      source: 'sync:broker',
      createdAt: '2026-07-23T09:00:00.000Z',
    },
  },
  {
    ...meta(CASH_SOURCE_ID),
    kind: 'cashSource',
    data: {
      portfolioId: PORTFOLIO_ID,
      name: 'Main',
      type: 'bank',
      isMain: true,
      archivedAt: '2026-07-25T10:00:00.000Z',
      createdAt: '2026-07-20T08:00:00.000Z',
    },
  },
  {
    ...meta(uuid(12)),
    kind: 'cashMovement',
    data: {
      portfolioId: PORTFOLIO_ID,
      sourceId: CASH_SOURCE_ID,
      kind: 'tax_refund',
      amountEur: '5.500000',
      transactionId: uuid(10),
      transferId: null,
      counterpartSourceId: null,
      dividendId: uuid(11),
      taxYear: 2026,
      executedAt: AT,
      note: 'settlement',
      source: 'manual',
      dedupHash: null,
      originalCurrency: null,
      createdAt: '2026-07-22T08:00:00.000Z',
    },
  },
  {
    ...meta(uuid(13)),
    kind: 'portfolioSetting',
    data: {
      portfolioId: PORTFOLIO_ID,
      key: 'tax',
      value: { mode: 'custom', nested: [1, true, null] },
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(14)),
    kind: 'taxSetting',
    data: {
      userId: USER_ID,
      mode: 'manual_per_trade',
      country: null,
      manualDefaultAmountEur: '12.345678',
      manualDefaultRatePct: null,
      customParams: null,
      updatedAt: AT,
    },
  },
  {
    ...meta(ASSET_ID),
    kind: 'customAsset',
    data: {
      providerId: 'manual',
      providerRef: ASSET_ID,
      ownerId: USER_ID,
      type: 'custom',
      symbol: 'HOME',
      name: 'House',
      exchange: 'OFF-MARKET',
      currency: 'EUR',
      meta: {
        category: 'other',
        smoothing: true,
        recategorize: true,
        futureMetadata: { retained: true },
      },
      searchText: "'house':2 'home':1",
    },
  },
  {
    ...meta(uuid(15)),
    kind: 'customAssetValue',
    data: {
      assetId: ASSET_ID,
      date: '2026-07-24',
      close: '456789.1234567',
      basis: 'unadjusted',
    },
  },
  {
    ...meta(ORDER_ID),
    kind: 'standingOrder',
    data: {
      userId: USER_ID,
      portfolioId: PORTFOLIO_ID,
      kind: 'buy-asset',
      assetId: ASSET_ID,
      amount: '0.12500000',
      currency: 'EUR',
      label: 'Monthly home slice',
      cadence: 'monthly',
      anchorDay: 31,
      startDate: '2026-01-31',
      endDate: '2026-12-31',
      status: 'paused',
      lastRunAt: AT,
      lastPeriodKey: '2026-07-24',
      createdAt: '2026-01-01T08:00:00.000Z',
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(16)),
    kind: 'standingOrderRun',
    data: {
      standingOrderId: ORDER_ID,
      periodKey: '2026-07-24',
      bookedAt: '2026-07-24T09:59:59.000Z',
    },
  },
  {
    ...meta(uuid(17)),
    kind: 'importBatch',
    data: {
      ownerId: USER_ID,
      portfolioId: PORTFOLIO_ID,
      brokerId: 'ibkr',
      filename: 'history.csv',
      status: 'applied',
      cashSourceId: CASH_SOURCE_ID,
      createdAt: '2026-07-20T08:00:00.000Z',
      appliedAt: AT,
    },
  },
  {
    ...meta(uuid(18)),
    kind: 'importRow',
    data: {
      batchId: uuid(17),
      rowIndex: 2,
      raw: '2026-07-24,BUY,HOME',
      kind: 'buy',
      flag: 'mapped',
      message: 'mapped exactly',
      executedAt: AT,
      isin: 'AT0000000001',
      symbol: 'HOME',
      name: 'House',
      quantity: '1.25000000',
      price: '123.456789',
      fee: '1.250000',
      amountEur: '154.320000',
      currency: 'EUR',
      note: 'import note',
      assetId: ASSET_ID,
      contentHash: 'b'.repeat(64),
      result: 'applied',
      resultMessage: 'booked',
      candidates: [
        {
          id: uuid(40),
          symbol: 'HOME.VI',
          name: 'House Holding AG',
          currency: 'EUR',
          exchange: 'XWBO',
          type: 'stock',
        },
      ],
      // TRUE on purpose: the column's own default is `false`, so a fixture
      // carrying `false` would round-trip identically whether the field
      // survived the document or was silently re-defaulted on the way back.
      // Only a `true` proves the value itself made the trip.
      kindUndecided: true,
    },
  },
  {
    ...meta(uuid(19)),
    kind: 'portfolioDailySnapshot',
    data: {
      portfolioId: PORTFOLIO_ID,
      date: '2026-07-24',
      valueEur: '10000.123456',
      costBasisEur: '9000.000000',
      plEur: '1000.123456',
      flowEur: '-25.000000',
      cashBySource: { [CASH_SOURCE_ID]: '500.000000' },
      assetValues: { [ASSET_ID]: '9500.123456' },
      computedAt: AT,
    },
  },
  {
    ...meta(uuid(20)),
    kind: 'portfolioSnapshotState',
    data: {
      portfolioId: PORTFOLIO_ID,
      computedThrough: '2026-07-24',
      dirtyFrom: '2026-07-01',
      updatedAt: AT,
    },
  },
  {
    ...meta(CATEGORY_ID),
    kind: 'expenseCategory',
    data: {
      userId: USER_ID,
      name: 'Groceries',
      direction: 'expense',
      color: '#22c55e',
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(21)),
    kind: 'expenseTransaction',
    data: {
      userId: USER_ID,
      categoryId: CATEGORY_ID,
      direction: 'income',
      amount: '12.50',
      currency: 'EUR',
      bookedOn: '2026-07-24',
      description: 'Edited merchant description',
      source: 'import:n26',
      dedupHash: ORIGINAL_EXPENSE_HASH,
      createdAt: AT,
      updatedAt: '2026-07-25T10:00:00.000Z',
    },
  },
  {
    ...meta(uuid(22)),
    kind: 'expenseRule',
    data: {
      userId: USER_ID,
      categoryId: CATEGORY_ID,
      matchType: 'regex',
      pattern: '^market',
      priority: 7,
      enabled: true,
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(BUDGET_ID),
    kind: 'expenseBudget',
    data: {
      userId: USER_ID,
      categoryId: CATEGORY_ID,
      amount: '350.25',
      currency: 'EUR',
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(23)),
    kind: 'expenseBudgetFire',
    data: {
      budgetId: BUDGET_ID,
      periodKey: '2026-07',
      firedAt: AT,
    },
  },
  // ── V5 cash fusion ──
  {
    ...meta(CASH_TAG_ID),
    kind: 'cashTag',
    data: {
      userId: USER_ID,
      name: 'Tax',
      color: '#ef4444',
      system: true,
      systemKey: 'tax',
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(31)),
    kind: 'cashMovementTag',
    data: {
      movementId: uuid(12),
      tagId: CASH_TAG_ID,
      createdAt: AT,
    },
  },
  {
    ...meta(CASH_BUDGET_ID),
    kind: 'cashBudget',
    data: {
      portfolioId: PORTFOLIO_ID,
      tagId: CASH_TAG_ID,
      periodKey: '2026-07',
      amount: '300.00',
      currency: 'EUR',
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(33)),
    kind: 'cashBudgetFire',
    data: {
      budgetId: CASH_BUDGET_ID,
      periodKey: '2026-07',
      firedAt: AT,
    },
  },
  {
    ...meta(CASH_RULE_ID),
    kind: 'cashRule',
    data: {
      userId: USER_ID,
      matchType: 'starts_with',
      pattern: 'REWE',
      priority: 5,
      enabled: true,
      createdAt: AT,
      updatedAt: AT,
    },
  },
  {
    ...meta(uuid(35)),
    kind: 'cashRuleTag',
    data: {
      ruleId: CASH_RULE_ID,
      tagId: CASH_TAG_ID,
      createdAt: AT,
    },
  },
];

describe('strict vault document v1', () => {
  it('has a fully populated round-trip fixture for every enrolled entity kind', () => {
    expect(fixtures.map((fixture) => fixture.kind).sort()).toEqual([...VAULT_ENTITY_KINDS].sort());
  });

  for (const fixture of fixtures) {
    it(`round-trips every persisted ${fixture.kind} field byte-for-byte`, () => {
      const payload = JSON.stringify({
        schemaVersion: VAULT_DOCUMENT_V1_VERSION,
        entities: [fixture],
        mergeLog: [],
        mirrorProvenance: [],
      });
      const parsed = vaultStrictDocumentV1Schema.parse(JSON.parse(payload));
      expect(JSON.stringify(parsed)).toBe(payload);
    });
  }

  it('fails closed for a forward document version', () => {
    expect(
      vaultStrictDocumentV1Schema.safeParse({
        schemaVersion: VAULT_DOCUMENT_V1_VERSION + 1,
        entities: fixtures,
        mergeLog: [],
      }).success,
    ).toBe(false);
  });

  it('requires every strict row field instead of defaulting or deriving one', () => {
    const expense = fixtures.find((fixture) => fixture.kind === 'expenseTransaction');
    if (expense?.kind !== 'expenseTransaction') throw new Error('expense fixture missing');
    const { dedupHash: _omitted, ...withoutDedupHash } = expense.data;
    expect(vaultStrictEntitySchema.safeParse({ ...expense, data: withoutDedupHash }).success).toBe(
      false,
    );
  });

  it('admits a custom-asset value written before `basis` existed', () => {
    // The second — and last — non-required field in the strict graph, for the
    // same mechanical reason as `portfolio.kind`: documents already written
    // carry no `basis` key, and a required field would lock those vaults out.
    // Unlike `kind` it DEFAULTS rather than staying absent, because there is no
    // user choice to fabricate: a custom asset's value marks are the user's own
    // raw valuations — no issuer, no dividend, no split — so `unadjusted` is
    // the only basis such a row can ever have been on (§16 2026-09-03).
    const value = fixtures.find((fixture) => fixture.kind === 'customAssetValue');
    if (value?.kind !== 'customAssetValue') throw new Error('customAssetValue fixture missing');
    const { basis: _omitted, ...withoutBasis } = value.data;
    const parsed = vaultStrictEntitySchema.parse({ ...value, data: withoutBasis });
    if (parsed.kind !== 'customAssetValue') throw new Error('parse changed kind');
    expect(parsed.data.basis).toBe('unadjusted');
    // A bogus token is still refused — the default is a fallback, not a sponge.
    expect(
      vaultStrictEntitySchema.safeParse({
        ...value,
        data: { ...value.data, basis: 'total-return' },
      }).success,
    ).toBe(false);
  });

  it('admits a portfolio row written before `kind` existed, and never invents one', () => {
    // One of the two non-required fields in the strict graph (see `basis`
    // above), and the reason is mechanical:
    // disable strict-parses the rows a vault ALREADY holds, and every document
    // written before board #69 carries no `kind` key at all. Required would
    // lock every pre-existing paranoid vault out of disable. Absent stays
    // absent — it is not defaulted to 'private', which would fabricate a choice
    // the user never made and destroy the null the restore path needs.
    const portfolio = fixtures.find((fixture) => fixture.kind === 'portfolio');
    if (portfolio?.kind !== 'portfolio') throw new Error('portfolio fixture missing');
    const { kind: _omitted, ...withoutKind } = portfolio.data;
    const parsed = vaultStrictEntitySchema.parse({ ...portfolio, data: withoutKind });
    if (parsed.kind !== 'portfolio') throw new Error('portfolio parse changed kind');
    expect(parsed.data.kind).toBeUndefined();
    expect('kind' in parsed.data).toBe(false);
    // A stored null stays null, and a bogus token is still refused.
    expect(
      vaultStrictEntitySchema.safeParse({ ...portfolio, data: { ...portfolio.data, kind: null } })
        .success,
    ).toBe(true);
    expect(
      vaultStrictEntitySchema.safeParse({
        ...portfolio,
        data: { ...portfolio.data, kind: 'yacht' },
      }).success,
    ).toBe(false);
  });

  /**
   * The import-row `candidates` list is a display-only "did you mean" for a row
   * that never resolved. It is enrolled in the strict payload because the
   * export-completeness sweep requires every persisted column to be — NOT
   * because anything depends on its contents. So it degrades instead of
   * rejecting: no suggestion list may ever be the reason a user cannot get a
   * portfolio back. Each case below is a document a stricter field would have
   * refused outright, taking that row's transactions with it.
   */
  describe('import-row candidates degrade instead of locking a portfolio out', () => {
    const importRow = fixtures.find((fixture) => fixture.kind === 'importRow');
    if (importRow?.kind !== 'importRow') throw new Error('importRow fixture missing');
    const candidate = importRow.data.candidates?.[0];
    if (!candidate) throw new Error('importRow fixture carries no candidates');

    const parseWithCandidates = (candidates: unknown) => {
      const parsed = vaultStrictEntitySchema.parse({
        ...importRow,
        data: { ...importRow.data, candidates },
      });
      if (parsed.kind !== 'importRow') throw new Error('importRow parse changed kind');
      return parsed;
    };

    it('parses a valid list verbatim — the tolerance never touches good data', () => {
      const parsed = parseWithCandidates(importRow.data.candidates);
      expect(parsed.data.candidates).toEqual(importRow.data.candidates);
      // And the whole row is still intact around it.
      expect(parsed.data.contentHash).toBe(importRow.data.contentHash);
    });

    it('degrades an OVER-CAP list to null rather than rejecting the row', () => {
      const overCap = Array.from({ length: 6 }, (_unused, index) => ({
        ...candidate,
        id: uuid(50 + index),
      }));
      expect(overCap).toHaveLength(6);
      const parsed = parseWithCandidates(overCap);
      expect(parsed.data.candidates).toBeNull();
      expect(parsed.data.rowIndex).toBe(importRow.data.rowIndex);
    });

    it('degrades an UNKNOWN asset type to null rather than rejecting the row', () => {
      const parsed = parseWithCandidates([{ ...candidate, type: 'yacht' }]);
      expect(parsed.data.candidates).toBeNull();
      expect(parsed.data.quantity).toBe(importRow.data.quantity);
    });

    it('degrades an EXTRA key inside a candidate to null rather than rejecting the row', () => {
      const parsed = parseWithCandidates([{ ...candidate, score: 0.91 }]);
      expect(parsed.data.candidates).toBeNull();
      expect(parsed.data.assetId).toBe(importRow.data.assetId);
    });

    it('degrades any other malformed shape to null, and keeps null/absent meaning "none"', () => {
      for (const malformed of ['not-an-array', 42, {}, [null], [{ id: 'not-a-uuid' }]]) {
        expect(parseWithCandidates(malformed).data.candidates).toBeNull();
      }
      expect(parseWithCandidates(null).data.candidates).toBeNull();
      // Absent (every document written before the column existed) stays absent.
      const { candidates: _omitted, ...withoutCandidates } = importRow.data;
      const parsed = vaultStrictEntitySchema.parse({ ...importRow, data: withoutCandidates });
      if (parsed.kind !== 'importRow') throw new Error('importRow parse changed kind');
      expect(parsed.data.candidates).toBeUndefined();
    });
  });

  /**
   * The import-row `ruleTagIds` list is the cash-rule tag SUGGESTION a staged
   * row was pre-tagged with (#964), enrolled in the strict payload for the same
   * mechanical reason as `candidates` directly above: the export-completeness
   * sweep requires every persisted column to be — NOT because a restore depends
   * on its contents. An import batch is a short-lived preview; the portfolio
   * behind it is the user's actual money, so a staging-time suggestion must
   * never be the reason a portfolio cannot be restored. It degrades to null,
   * field-locally, and the row still parses.
   */
  describe('import-row ruleTagIds degrade instead of locking a portfolio out', () => {
    const importRow = fixtures.find((fixture) => fixture.kind === 'importRow');
    if (importRow?.kind !== 'importRow') throw new Error('importRow fixture missing');
    const validIds = [uuid(70), uuid(71)];

    const parseWithRuleTagIds = (ruleTagIds: unknown) => {
      const parsed = vaultStrictEntitySchema.parse({
        ...importRow,
        data: { ...importRow.data, ruleTagIds },
      });
      if (parsed.kind !== 'importRow') throw new Error('importRow parse changed kind');
      return parsed;
    };

    it('parses a valid list verbatim — the tolerance never touches good data', () => {
      const parsed = parseWithRuleTagIds(validIds);
      expect(parsed.data.ruleTagIds).toEqual(validIds);
      // And the whole row is still intact around it.
      expect(parsed.data.contentHash).toBe(importRow.data.contentHash);
    });

    it('degrades an OVER-CAP list to null rather than rejecting the row', () => {
      // One past `CASH_TAGS_PER_ITEM_MAX` (20). No API path can build a rule
      // with that many tags, which is exactly why a document carrying one is
      // corrupt rather than merely unusual — and still not worth a refusal.
      const overCap = Array.from({ length: 21 }, (_unused, index) => uuid(80 + index));
      expect(overCap).toHaveLength(21);
      const parsed = parseWithRuleTagIds(overCap);
      expect(parsed.data.ruleTagIds).toBeNull();
      expect(parsed.data.rowIndex).toBe(importRow.data.rowIndex);
    });

    it('degrades a MALFORMED member to null rather than rejecting the row', () => {
      // One good id and one that is not a uuid: the list is refused as a WHOLE,
      // never half-kept — a partial suggestion would be a fabricated one.
      const parsed = parseWithRuleTagIds([validIds[0], 'not-a-uuid']);
      expect(parsed.data.ruleTagIds).toBeNull();
      expect(parsed.data.quantity).toBe(importRow.data.quantity);
      // …and the same for a member of the wrong type entirely.
      expect(parseWithRuleTagIds([validIds[0], 42]).data.ruleTagIds).toBeNull();
      expect(parseWithRuleTagIds([null]).data.ruleTagIds).toBeNull();
    });

    it('degrades any other malformed shape to null, and keeps null/absent meaning "none"', () => {
      for (const malformed of ['not-an-array', 42, {}, [[validIds[0]]]]) {
        expect(parseWithRuleTagIds(malformed).data.ruleTagIds).toBeNull();
      }
      // A stored null already means "none" and stays null, row intact.
      expect(parseWithRuleTagIds(null).data.ruleTagIds).toBeNull();
      expect(parseWithRuleTagIds(null).data.assetId).toBe(importRow.data.assetId);
      // Absent (every document written before the column existed) stays absent
      // — NOT defaulted to null, which would invent a value no writer produced.
      const { ruleTagIds: _omitted, ...withoutRuleTagIds } = importRow.data;
      const parsed = vaultStrictEntitySchema.parse({ ...importRow, data: withoutRuleTagIds });
      if (parsed.kind !== 'importRow') throw new Error('importRow parse changed kind');
      expect(parsed.data.ruleTagIds).toBeUndefined();
      expect('ruleTagIds' in parsed.data).toBe(false);
    });
  });

  it('keeps assets.meta.recategorize and every sibling metadata field', () => {
    const asset = fixtures.find((fixture) => fixture.kind === 'customAsset');
    if (asset?.kind !== 'customAsset') throw new Error('asset fixture missing');
    const parsed = vaultStrictEntitySchema.parse(JSON.parse(JSON.stringify(asset)));
    expect(parsed.kind).toBe('customAsset');
    if (parsed.kind !== 'customAsset') throw new Error('asset parse changed kind');
    expect(parsed.data.meta).toEqual(asset.data.meta);
    expect(parsed.data.meta).toMatchObject({ recategorize: true });
  });

  it('keeps an imported-then-edited expense original dedup_hash verbatim', () => {
    const expense = fixtures.find((fixture) => fixture.kind === 'expenseTransaction');
    if (expense?.kind !== 'expenseTransaction') throw new Error('expense fixture missing');
    const parsed = vaultStrictEntitySchema.parse(JSON.parse(JSON.stringify(expense)));
    expect(parsed.kind).toBe('expenseTransaction');
    if (parsed.kind !== 'expenseTransaction') throw new Error('expense parse changed kind');
    expect(parsed.data.description).toBe('Edited merchant description');
    expect(parsed.data.direction).toBe('income');
    expect(parsed.data.dedupHash).toBe(ORIGINAL_EXPENSE_HASH);
  });

  it('binds the internal disable request to the strict graph, not the shipped client map', () => {
    const request = {
      rehydrationId: uuid(98),
      document: {
        schemaVersion: VAULT_DOCUMENT_V1_VERSION,
        entities: fixtures,
        mergeLog: [],
        mirrorProvenance: [],
      },
    };
    expect(paranoidDisableRehydrationRequestSchema.parse(request)).toEqual(request);
    expect(
      paranoidDisableRehydrationRequestSchema.safeParse({
        ...request,
        document: {
          schemaVersion: VAULT_DOCUMENT_V1_VERSION,
          entities: { portfolio: [] },
          mergeLog: [],
          mirrorProvenance: [],
        },
      }).success,
    ).toBe(false);
  });

  it('keeps the completion receipt non-sensitive and strict', () => {
    const result = {
      rehydrationId: uuid(98),
      completedAt: AT,
      idempotent: false,
      postCommit: {
        invalidate: ['account', 'portfolio', 'expenses', 'standingOrders', 'tax'] as const,
      },
    };
    expect(paranoidDisableRehydrationResultSchema.parse(result)).toEqual(result);
    expect(
      paranoidDisableRehydrationResultSchema.safeParse({ ...result, restoredRows: fixtures.length })
        .success,
    ).toBe(false);
  });
});

describe('severed-fork MIRRORCHAIN provenance', () => {
  const CHAIN_ID = uuid(200);
  const MIRROR_ID = uuid(201);
  const LOCAL_ID = uuid(202);
  const MEMBERSHIP_ID = uuid(205);
  const entry = {
    chainId: CHAIN_ID,
    membershipId: MEMBERSHIP_ID,
    kind: 'transaction',
    mirrorId: MIRROR_ID,
    portfolioId: PORTFOLIO_ID,
    localId: LOCAL_ID,
  };

  it('round-trips the identity map byte-for-byte inside the strict document', () => {
    const payload = JSON.stringify({
      schemaVersion: VAULT_DOCUMENT_V1_VERSION,
      entities: [],
      mergeLog: [],
      mirrorProvenance: [entry],
    });
    expect(JSON.stringify(vaultStrictDocumentV1Schema.parse(JSON.parse(payload)))).toBe(payload);
  });

  it('carries the logical id and the CURRENT local id as separate fields', () => {
    // The whole point of §7.1: a sanctioned correction replaces the local row, so
    // `localId = mirrorId` cannot be assumed by restore-time validation.
    const parsed = vaultMirrorProvenanceSchema.parse(entry);
    expect(parsed.localId).not.toBe(parsed.mirrorId);
    expect(Object.keys(parsed).sort()).toEqual([
      'chainId',
      'kind',
      'localId',
      'membershipId',
      'mirrorId',
      'portfolioId',
    ]);
  });

  it('carries the ended-membership identity, because a re-join mints a second one', () => {
    // Two retained forks of ONE chain each keep the same logical entity under
    // their own local id. Without the tombstone identity they collide, and the
    // older fork would be proved against the newer copy's higher watermark.
    const rejoined = { ...entry, membershipId: uuid(206), localId: uuid(207) };
    const parsed = [entry, rejoined].map((row) => vaultMirrorProvenanceSchema.parse(row));
    expect(new Set(parsed.map((row) => row.membershipId)).size).toBe(2);
    expect(new Set(parsed.map((row) => row.mirrorId)).size).toBe(1);
    expect(vaultMirrorProvenanceSchema.safeParse({ ...entry, membershipId: 'nope' }).success).toBe(
      false,
    );
    expect(
      vaultMirrorProvenanceSchema.safeParse((({ membershipId: _omitted, ...rest }) => rest)(entry))
        .success,
    ).toBe(false);
  });

  it('never carries a co-member identity', () => {
    for (const forbidden of Object.keys(VAULT_MIRROR_PROVENANCE_DROPPED_COLUMNS)) {
      expect(
        vaultMirrorProvenanceSchema.safeParse({ ...entry, [forbidden]: uuid(203) }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it('rejects a malformed entry instead of coercing it', () => {
    for (const invalid of [
      { ...entry, kind: 'portfolio' },
      { ...entry, kind: 'cashMovement' },
      { ...entry, localId: 'not-a-uuid' },
      { ...entry, chainId: null },
      (({ portfolioId: _omitted, ...rest }) => rest)(entry),
    ]) {
      expect(vaultMirrorProvenanceSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('reads an older supported document deterministically as "no severed fork"', () => {
    // A document written before §7.1 simply has no key. It must keep opening —
    // and mean exactly the same thing every time — instead of failing closed as
    // corrupt or being reinterpreted under a bumped schema version.
    const older = {
      schemaVersion: VAULT_DOCUMENT_V1_VERSION,
      entities: [fixtures[0]!],
      mergeLog: [],
    };
    const first = vaultStrictDocumentV1Schema.parse(JSON.parse(JSON.stringify(older)));
    const second = vaultStrictDocumentV1Schema.parse(JSON.parse(JSON.stringify(older)));
    expect(first.schemaVersion).toBe(VAULT_DOCUMENT_V1_VERSION);
    expect(first.mirrorProvenance).toEqual([]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    // The CLIENT document leaves the key ABSENT instead of defaulting it in: a
    // re-encrypted fork-free vault must keep emitting byte-identical plaintext,
    // so absent stays absent and means exactly what `[]` means.
    const clientPayload = JSON.stringify({
      schemaVersion: VAULT_DOCUMENT_V1_VERSION,
      entities: {},
      mergeLog: [],
    });
    const clientDocument = vaultDocumentV1Schema.parse(JSON.parse(clientPayload));
    expect(clientDocument.mirrorProvenance).toBeUndefined();
    expect(JSON.stringify(clientDocument)).toBe(clientPayload);
    expect(
      vaultDocumentV1Schema.parse({
        schemaVersion: VAULT_DOCUMENT_V1_VERSION,
        entities: {},
        mergeLog: [],
        mirrorProvenance: [entry],
      }).mirrorProvenance,
    ).toEqual([entry]);
  });

  it('fails closed for an unsupported version or an unknown sibling key', () => {
    expect(
      vaultStrictDocumentV1Schema.safeParse({
        schemaVersion: VAULT_DOCUMENT_V1_VERSION + 1,
        entities: [],
        mergeLog: [],
        mirrorProvenance: [entry],
      }).success,
    ).toBe(false);
    expect(
      vaultStrictDocumentV1Schema.safeParse({
        schemaVersion: VAULT_DOCUMENT_V1_VERSION,
        entities: [],
        mergeLog: [],
        mirrorProvenance: [entry],
        mirrorAttribution: [{ userId: uuid(204) }],
      }).success,
    ).toBe(false);
  });

  it('keeps the capture read to the identity map and nothing else', () => {
    expect(paranoidForkProvenanceResponseSchema.parse({ provenance: [entry] })).toEqual({
      provenance: [entry],
    });
    expect(
      paranoidForkProvenanceResponseSchema.safeParse({
        provenance: [entry],
        chainName: 'Family',
      }).success,
    ).toBe(false);
    expect(
      paranoidForkProvenanceResponseSchema.safeParse({
        provenance: [{ ...entry, createdByUsername: 'alice' }],
      }).success,
    ).toBe(false);
  });
});

describe('vault media state', () => {
  it('rejects a Drive attestation unless Drive is selected', () => {
    expect(
      vaultMediaStateSchema.safeParse({
        mediaSet: ['server'],
        driveAttestedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      vaultMediaStateSchema.safeParse({
        mediaSet: ['drive'],
        driveAttestedVersion: 1,
      }).success,
    ).toBe(true);
  });
});

it('accepts a cash movement written before V5 cash fusion', () => {
  // Regression: dedupHash/originalCurrency were required-but-nullable on a
  // .strict() schema, so every vault document written BEFORE cash fusion —
  // including a user's own older backup — failed to read as VAULT_CORRUPT.
  // Absent keys mean exactly what null means: no import hash, amount in EUR.
  const preFusion = {
    ...meta(uuid(120)),
    kind: 'cashMovement',
    data: {
      portfolioId: PORTFOLIO_ID,
      sourceId: CASH_SOURCE_ID,
      kind: 'deposit',
      amountEur: '100.000000',
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      executedAt: AT,
      note: null,
      source: 'manual',
      createdAt: AT,
    },
  };

  const parsed = vaultStrictEntitySchema.parse(preFusion) as Extract<
    VaultStrictEntity,
    { kind: 'cashMovement' }
  >;

  expect(parsed.data.dedupHash).toBeNull();
  expect(parsed.data.originalCurrency).toBeNull();
});
