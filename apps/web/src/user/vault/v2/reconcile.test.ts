import type { VaultCommonDoc, VaultPortfolioDoc } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { mergeVaultContentDocs, reconcileVaultDocs } from './reconcile';
import { entity, FIXTURE_PORTFOLIO_A, FIXTURE_VAULT_ID } from './testSupport';

const DEVICE_PHONE = '018f0000-0000-7000-8000-0000000000a1';
const DEVICE_WEB = '018f0000-0000-7000-8000-0000000000a2';

function portfolioDoc(
  entities: VaultPortfolioDoc['entities'],
  mergeLog: VaultPortfolioDoc['mergeLog'] = [],
): VaultPortfolioDoc {
  return {
    schemaVersion: 1,
    docKind: 'portfolio',
    vaultId: FIXTURE_VAULT_ID,
    portfolioId: FIXTURE_PORTFOLIO_A,
    entities,
    mergeLog,
  };
}

const TX_A = '11111111-1111-4111-8111-111111111111';
const TX_B = '22222222-2222-4222-8222-222222222222';

describe('both-backend reconcile (r3 §17 / mobile A8)', () => {
  it('MERGES the two-device divergence — both legs survive, not one clobbered by clock', () => {
    // Both media at version 5. The phone books TX_A offline (its own v6); the
    // web books TX_B (its own v6). r2's LWW would keep one document and lose the
    // other entity entirely. The merge keeps BOTH.
    const phone = portfolioDoc({
      transaction: [entity(TX_A, { side: 'buy' }, { editedBy: DEVICE_PHONE })],
    });
    const web = portfolioDoc({
      transaction: [entity(TX_B, { side: 'buy' }, { editedBy: DEVICE_WEB })],
    });

    const outcome = reconcileVaultDocs(
      { readable: true, doc: phone, version: 6, updatedAt: '2026-08-08T10:00:01.000Z' },
      { readable: true, doc: web, version: 6, updatedAt: '2026-08-08T10:00:00.000Z' },
    );
    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') throw new Error('unreachable');

    const ids = (outcome.doc.entities.transaction ?? []).map((row) => row.id).sort();
    expect(ids).toEqual([TX_A, TX_B]);
    // A new CAS successor above both parents.
    expect(outcome.version).toBe(7);
    expect(outcome.converged).toBe(false);
  });

  it('an edit beats a tombstone at equal rev (§4 rule 2), never the reverse', () => {
    const edited = portfolioDoc({
      transaction: [
        entity(TX_A, { side: 'buy', note: 'kept' }, { rev: 3, editedBy: DEVICE_PHONE }),
      ],
    });
    const tombstoned = portfolioDoc({
      transaction: [
        {
          ...entity(TX_A, { side: 'buy' }, { rev: 3, editedBy: DEVICE_WEB }),
          deletedAt: '2026-08-08T09:00:00.000Z',
        },
      ],
    });
    const outcome = reconcileVaultDocs(
      { readable: true, doc: edited, version: 6, updatedAt: '2026-08-08T09:00:00.000Z' },
      { readable: true, doc: tombstoned, version: 6, updatedAt: '2026-08-08T12:00:00.000Z' },
    );
    if (outcome.kind !== 'merged') throw new Error('unreachable');
    const row = outcome.doc.entities.transaction![0]!;
    expect(row.deletedAt).toBeNull();
    expect(row.data.note).toBe('kept');
  });

  it('converges without a new version when both legs are byte-identical', () => {
    const doc = portfolioDoc({ transaction: [entity(TX_A, { side: 'buy' })] });
    const outcome = reconcileVaultDocs(
      { readable: true, doc, version: 4, updatedAt: '2026-08-08T10:00:00.000Z' },
      { readable: true, doc, version: 4, updatedAt: '2026-08-08T10:00:00.000Z' },
    );
    if (outcome.kind !== 'merged') throw new Error('unreachable');
    expect(outcome.converged).toBe(true);
    expect(outcome.version).toBe(4);
  });

  it('a readable leg always beats an undecryptable sibling, regardless of version', () => {
    const doc = portfolioDoc({ transaction: [entity(TX_A, { side: 'buy' })] });
    const outcome = reconcileVaultDocs(
      { readable: true, doc, version: 3, updatedAt: '2026-08-08T10:00:00.000Z' },
      { readable: false, version: 99, updatedAt: '2026-08-08T23:00:00.000Z' },
    );
    expect(outcome).toEqual({ kind: 'readable-wins', doc, version: 3 });
  });

  it('falls back to (version, then updatedAt) ONLY when both legs are undecryptable', () => {
    const outcome = reconcileVaultDocs(
      { readable: false, version: 7, updatedAt: '2026-08-08T10:00:00.000Z' },
      { readable: false, version: 7, updatedAt: '2026-08-08T11:00:00.000Z' },
    );
    expect(outcome).toEqual({
      kind: 'undecryptable-fallback',
      version: 7,
      updatedAt: '2026-08-08T11:00:00.000Z',
    });
  });

  it('unions mirrorProvenance on a common-doc merge — a merge never loses an identity map', () => {
    const provenance = (chainId: string) => ({
      chainId,
      membershipId: 'd0000000-0000-4000-8000-000000000000',
      kind: 'transaction' as const,
      mirrorId: 'e0000000-0000-4000-8000-000000000000',
      portfolioId: FIXTURE_PORTFOLIO_A,
      localId: 'f0000000-0000-4000-8000-000000000000',
    });
    const common = (rows: ReturnType<typeof provenance>[]): VaultCommonDoc => ({
      schemaVersion: 1,
      docKind: 'common',
      vaultId: FIXTURE_VAULT_ID,
      entities: {},
      mergeLog: [],
      mirrorProvenance: rows,
    });
    const left = common([provenance('c0000000-0000-4000-8000-000000000001')]);
    const right = common([provenance('c0000000-0000-4000-8000-000000000002')]);
    const { doc } = mergeVaultContentDocs(left, right);
    if (doc.docKind !== 'common') throw new Error('unreachable');
    expect(doc.mirrorProvenance).toHaveLength(2);
  });

  it('throws rather than fusing two documents of different identity', () => {
    const a = portfolioDoc({ transaction: [entity(TX_A)] });
    const b: VaultPortfolioDoc = {
      ...portfolioDoc({ transaction: [entity(TX_B)] }),
      portfolioId: '99999999-9999-4999-8999-999999999999',
    };
    expect(() => mergeVaultContentDocs(a, b)).toThrowError(/different portfolios/u);
  });
});
