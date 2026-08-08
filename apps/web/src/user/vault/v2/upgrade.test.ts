import {
  VAULT_ENTITY_KINDS,
  VAULT2_COMMON_SCOPED_KINDS,
  VAULT2_PORTFOLIO_SCOPED_KINDS,
  VAULT2_UNSCOPED_KINDS,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { buildPortfolioDoc, splitVaultDocument } from './upgrade';
import { entity, FIXTURE_PORTFOLIO_A, FIXTURE_PORTFOLIO_B, FIXTURE_VAULT_ID } from './testSupport';

const STANDING_ORDER_A = 'aaaa1111-1111-4111-8111-111111111111';
const IMPORT_BATCH_B = 'bbbb2222-2222-4222-8222-222222222222';
const CASH_BUDGET_A = 'cccc3333-3333-4333-8333-333333333333';
const CASH_MOVEMENT_B = 'dddd4444-4444-4444-8444-444444444444';

function v1Document(
  entities: Partial<Record<VaultEntityKind, VaultEntity[]>>,
  overrides: Partial<VaultDocument> = {},
): VaultDocument {
  return {
    schemaVersion: 1,
    entities: entities as VaultDocument['entities'],
    mergeLog: [],
    ...overrides,
  } as VaultDocument;
}

/** A realistic two-portfolio account with every kind of parent reference. */
function fullAccount(): VaultDocument {
  return v1Document({
    portfolio: [
      entity(FIXTURE_PORTFOLIO_A, { name: 'Tech', visibility: 'private' }),
      entity(FIXTURE_PORTFOLIO_B, { name: 'Pension', visibility: 'private' }),
    ],
    transaction: [
      entity('t1111111-1111-4111-8111-111111111111'.replace('t', '1'), {
        portfolioId: FIXTURE_PORTFOLIO_A,
      }),
      entity('92222222-2222-4222-8222-222222222222', { portfolioId: FIXTURE_PORTFOLIO_B }),
    ],
    cashMovement: [entity(CASH_MOVEMENT_B, { portfolioId: FIXTURE_PORTFOLIO_B })],
    cashMovementTag: [
      entity('e5555555-5555-4555-8555-555555555555'.replace('e', '5'), {
        movementId: CASH_MOVEMENT_B,
        tagId: '66666666-6666-4666-8666-666666666666',
      }),
    ],
    standingOrder: [entity(STANDING_ORDER_A, { portfolioId: FIXTURE_PORTFOLIO_A })],
    standingOrderRun: [
      entity('77777777-7777-4777-8777-777777777777', { standingOrderId: STANDING_ORDER_A }),
    ],
    importBatch: [entity(IMPORT_BATCH_B, { portfolioId: FIXTURE_PORTFOLIO_B })],
    importRow: [entity('88888888-8888-4888-8888-888888888888', { batchId: IMPORT_BATCH_B })],
    cashBudget: [entity(CASH_BUDGET_A, { portfolioId: FIXTURE_PORTFOLIO_A })],
    cashBudgetFire: [entity('99999999-9999-4999-8999-999999999999', { budgetId: CASH_BUDGET_A })],
    // Account-scoped: belongs to no single portfolio.
    taxSetting: [entity('a1111111-1111-4111-8111-111111111112', { mode: 'country' })],
    expenseTransaction: [entity('a2222222-2222-4222-8222-222222222223', { amount: '10' })],
    cashTag: [entity('66666666-6666-4666-8666-666666666666', { name: 'Rent' })],
    customAsset: [entity('a3333333-3333-4333-8333-333333333334', { symbol: 'PRIV' })],
  });
}

describe('v1 → v2 split', () => {
  it('partitions every contract entity kind exactly once', () => {
    expect(VAULT2_UNSCOPED_KINDS).toEqual([]);
    const union = [...VAULT2_PORTFOLIO_SCOPED_KINDS, ...VAULT2_COMMON_SCOPED_KINDS];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...VAULT_ENTITY_KINDS].sort());
  });

  it('never loses a row: entities in equals entities out', () => {
    const split = splitVaultDocument({ document: fullAccount(), vaultId: FIXTURE_VAULT_ID });
    expect(split.report.entitiesIn).toBe(16);
    expect(split.report.entitiesOut).toBe(split.report.entitiesIn);
    expect(split.report.orphans).toEqual([]);

    const written =
      split.portfolioDocs.reduce(
        (total, doc) =>
          total + Object.values(doc.entities).reduce((sum, list) => sum + (list?.length ?? 0), 0),
        0,
      ) +
      Object.values(split.commonDoc.entities).reduce((sum, list) => sum + (list?.length ?? 0), 0);
    expect(written).toBe(split.report.entitiesIn);
  });

  it('routes rows to the portfolio their parent chain resolves to', () => {
    const split = splitVaultDocument({ document: fullAccount(), vaultId: FIXTURE_VAULT_ID });
    const docA = split.portfolioDocs.find((doc) => doc.portfolioId === FIXTURE_PORTFOLIO_A)!;
    const docB = split.portfolioDocs.find((doc) => doc.portfolioId === FIXTURE_PORTFOLIO_B)!;

    // standingOrderRun → standingOrder → portfolio A
    expect(docA.entities.standingOrderRun).toHaveLength(1);
    // importRow → importBatch → portfolio B
    expect(docB.entities.importRow).toHaveLength(1);
    // cashMovementTag → cashMovement → portfolio B
    expect(docB.entities.cashMovementTag).toHaveLength(1);

    expect(docA.entities.standingOrderRun).toBeDefined();
    expect(docB.entities.standingOrderRun).toBeUndefined();

    // r2 §8 moved cashBudget to `common`, so its fire rows follow it there.
    expect(split.commonDoc.entities.cashBudget).toHaveLength(1);
    expect(split.commonDoc.entities.cashBudgetFire).toHaveLength(1);
    expect(docA.entities.cashBudget).toBeUndefined();
  });

  it('keeps vault-scoped rows encrypted in the vault instead of declassifying them', () => {
    const split = splitVaultDocument({ document: fullAccount(), vaultId: FIXTURE_VAULT_ID });
    expect(split.commonDoc.docKind).toBe('common');
    expect(split.commonDoc.entities.taxSetting).toHaveLength(1);
    expect(split.commonDoc.entities.expenseTransaction).toHaveLength(1);
    expect(split.commonDoc.entities.cashTag).toHaveLength(1);
    expect(split.commonDoc.entities.customAsset).toHaveLength(1);
    for (const doc of split.portfolioDocs) {
      expect(doc.entities.taxSetting).toBeUndefined();
      expect(doc.entities.expenseTransaction).toBeUndefined();
    }
  });

  it('builds the cleartext portfolio index from portfolio names, overridable by alias', () => {
    const plain = splitVaultDocument({ document: fullAccount(), vaultId: FIXTURE_VAULT_ID });
    expect(plain.index).toEqual([
      { portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' },
      { portfolioId: FIXTURE_PORTFOLIO_B, alias: 'Pension' },
    ]);

    const aliased = splitVaultDocument({
      document: fullAccount(),
      vaultId: FIXTURE_VAULT_ID,
      aliases: { [FIXTURE_PORTFOLIO_A]: 'Vault portfolio 1' },
    });
    expect(aliased.index[0]).toEqual({
      portfolioId: FIXTURE_PORTFOLIO_A,
      alias: 'Vault portfolio 1',
    });
  });

  it('rescues rows with a dangling parent into the common doc and reports them', () => {
    const document = v1Document({
      portfolio: [entity(FIXTURE_PORTFOLIO_A, { name: 'Tech' })],
      importRow: [entity('88888888-8888-4888-8888-888888888888', { batchId: IMPORT_BATCH_B })],
      transaction: [entity('92222222-2222-4222-8222-222222222222', { portfolioId: 'ghost' })],
    });
    const split = splitVaultDocument({ document, vaultId: FIXTURE_VAULT_ID });

    expect(split.report.entitiesOut).toBe(split.report.entitiesIn);
    expect(split.report.orphans).toEqual([
      {
        kind: 'transaction',
        entityId: '92222222-2222-4222-8222-222222222222',
        reason: 'unknown-portfolio',
      },
      {
        kind: 'importRow',
        entityId: '88888888-8888-4888-8888-888888888888',
        reason: 'missing-reference',
      },
    ]);
    expect(split.commonDoc.entities.importRow).toHaveLength(1);
    expect(split.commonDoc.entities.transaction).toHaveLength(1);
  });

  it('carries the severed-fork provenance map on the vault common doc (r2 §8)', () => {
    const provenance = {
      chainId: 'f1111111-1111-4111-8111-111111111111',
      membershipId: 'f2222222-2222-4222-8222-222222222222',
      kind: 'transaction' as const,
      mirrorId: 'f3333333-3333-4333-8333-333333333333',
      portfolioId: FIXTURE_PORTFOLIO_B,
      localId: 'f4444444-4444-4444-8444-444444444444',
    };
    const split = splitVaultDocument({
      document: v1Document(
        {
          portfolio: [
            entity(FIXTURE_PORTFOLIO_A, { name: 'A' }),
            entity(FIXTURE_PORTFOLIO_B, { name: 'B' }),
          ],
        },
        { mirrorProvenance: [provenance] },
      ),
      vaultId: FIXTURE_VAULT_ID,
    });
    expect(split.commonDoc.mirrorProvenance).toEqual([provenance]);
    // Portfolio docs no longer carry it; divergence is a per-vault question.
    for (const doc of split.portfolioDocs) {
      expect(doc).not.toHaveProperty('mirrorProvenance');
    }
  });

  it('keeps mergeLog/clientSecurity/mirrorProvenance as document MEMBERS, never as entities (r3 §20)', () => {
    const provenance = {
      chainId: 'c0000000-0000-4000-8000-000000000000',
      membershipId: 'd0000000-0000-4000-8000-000000000000',
      portfolioId: FIXTURE_PORTFOLIO_A,
      alias: 'x',
      severedAt: '2026-08-08T00:00:00.000Z',
    };
    const security = {
      retirementProofPublicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    };
    const split = splitVaultDocument({
      document: v1Document({ portfolio: [entity(FIXTURE_PORTFOLIO_A, { name: 'A' })] }, {
        schemaVersion: 2,
        mirrorProvenance: [provenance],
        clientSecurity: security,
      } as unknown as Partial<VaultDocument>),
      vaultId: FIXTURE_VAULT_ID,
    });
    // They live on the object, not inside `entities`.
    expect(split.commonDoc.mirrorProvenance).toEqual([provenance]);
    expect(split.commonDoc.clientSecurity).toEqual(security);
    for (const key of ['mergeLog', 'clientSecurity', 'mirrorProvenance']) {
      expect(split.commonDoc.entities).not.toHaveProperty(key);
      for (const doc of split.portfolioDocs) expect(doc.entities).not.toHaveProperty(key);
    }
  });

  it('trims the common doc mergeLog on write rather than rejecting an oversized one (r3 §20 / A1.2)', () => {
    const record = (into: number) => ({
      mergedAt: '2026-08-08T00:00:00.000Z',
      parents: [into - 1],
      into,
      deviceId: '018f0000-0000-7000-8000-00000000000b',
    });
    const oversized = Array.from({ length: 45 }, (_, index) => record(index + 2));
    const split = splitVaultDocument({
      document: v1Document(
        { portfolio: [entity(FIXTURE_PORTFOLIO_A, { name: 'A' })] },
        { mergeLog: oversized },
      ),
      vaultId: FIXTURE_VAULT_ID,
    });
    // A 45-record log does not make the split throw; it is trimmed to the
    // newest 20, keeping the common doc parseable.
    expect(split.commonDoc.mergeLog).toHaveLength(20);
    expect(split.commonDoc.mergeLog.at(-1)).toEqual(record(46));
    expect(split.commonDoc.mergeLog[0]).toEqual(record(27));
  });

  it('produces an empty-but-valid split for an account with no portfolios', () => {
    const split = splitVaultDocument({ document: v1Document({}), vaultId: FIXTURE_VAULT_ID });
    expect(split.portfolioDocs).toEqual([]);
    expect(split.index).toEqual([]);
    expect(split.commonDoc.entities).toEqual({});
    expect(split.report).toEqual({ entitiesIn: 0, entitiesOut: 0, orphans: [] });
  });

  it('keeps a portfolio with no rows in the index so it does not vanish', () => {
    const split = splitVaultDocument({
      document: v1Document({ portfolio: [entity(FIXTURE_PORTFOLIO_A, { name: 'Empty' })] }),
      vaultId: FIXTURE_VAULT_ID,
    });
    expect(split.portfolioDocs).toHaveLength(1);
    expect(split.index).toEqual([{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Empty' }]);
  });
});

describe('buildPortfolioDoc', () => {
  it('refuses to place an vault-scoped kind in a portfolio document', () => {
    expect(() =>
      buildPortfolioDoc({
        vaultId: FIXTURE_VAULT_ID,
        portfolioId: FIXTURE_PORTFOLIO_A,
        entities: { expenseTransaction: [entity('a2222222-2222-4222-8222-222222222223')] },
      }),
    ).toThrowError(/vault-scoped/u);
  });

  it('builds a joinable document from cleartext rows', () => {
    const doc = buildPortfolioDoc({
      vaultId: FIXTURE_VAULT_ID,
      portfolioId: FIXTURE_PORTFOLIO_A,
      entities: { transaction: [entity('92222222-2222-4222-8222-222222222222')] },
    });
    expect(doc).toMatchObject({
      schemaVersion: 1,
      docKind: 'portfolio',
      vaultId: FIXTURE_VAULT_ID,
      portfolioId: FIXTURE_PORTFOLIO_A,
    });
  });
});
