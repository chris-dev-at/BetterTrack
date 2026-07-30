import type { VaultDocument, VaultEntity, VaultMirrorProvenance } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { VaultCryptoError } from './errors';
import {
  forkProvenanceDominates,
  mergeForkProvenance,
  normalizeForkProvenance,
  pruneForkProvenance,
  withForkProvenance,
} from './mirrorProvenance';

const CHAIN = '018f0000-0000-7000-8000-0000000000c1';
const OTHER_CHAIN = '018f0000-0000-7000-8000-0000000000c2';
const PORTFOLIO = '018f0000-0000-7000-8000-0000000000c3';
const TX_MIRROR = '018f0000-0000-7000-8000-0000000000c4';
const TX_LOCAL = '018f0000-0000-7000-8000-0000000000c5';
const SOURCE_MIRROR = '018f0000-0000-7000-8000-0000000000c6';
const SOURCE_LOCAL = '018f0000-0000-7000-8000-0000000000c7';
const DELETED_LOCAL = '018f0000-0000-7000-8000-0000000000c8';
const DEVICE = '018f0000-0000-7000-8000-0000000000c9';

const transactionEntry: VaultMirrorProvenance = {
  chainId: CHAIN,
  kind: 'transaction',
  mirrorId: TX_MIRROR,
  portfolioId: PORTFOLIO,
  localId: TX_LOCAL,
};
const sourceEntry: VaultMirrorProvenance = {
  chainId: CHAIN,
  kind: 'cash_source',
  mirrorId: SOURCE_MIRROR,
  portfolioId: PORTFOLIO,
  localId: SOURCE_LOCAL,
};

function entity(id: string, deletedAt: string | null = null): VaultEntity {
  return {
    id,
    rev: 1,
    editedAt: '2026-07-24T10:00:00.000Z',
    editedBy: DEVICE,
    deletedAt,
    data: {},
  };
}

function document(mirrorProvenance: VaultMirrorProvenance[] = []): VaultDocument {
  return {
    schemaVersion: 1,
    entities: {
      transaction: [entity(TX_LOCAL), entity(DELETED_LOCAL, '2026-07-25T10:00:00.000Z')],
      cashSource: [entity(SOURCE_LOCAL)],
    },
    mergeLog: [],
    mirrorProvenance,
  };
}

describe('severed-fork provenance carriage', () => {
  it('orders and de-duplicates one capture deterministically', () => {
    const normalized = normalizeForkProvenance([sourceEntry, transactionEntry, sourceEntry]);
    expect(normalized).toEqual([sourceEntry, transactionEntry]);
    expect(normalizeForkProvenance([transactionEntry, sourceEntry])).toEqual(normalized);
  });

  it('fails closed on two local rows claiming one logical identity', () => {
    expect(() =>
      normalizeForkProvenance([transactionEntry, { ...transactionEntry, localId: DELETED_LOCAL }]),
    ).toThrow(VaultCryptoError);
    expect(() =>
      normalizeForkProvenance([transactionEntry, { ...transactionEntry, mirrorId: SOURCE_MIRROR }]),
    ).toThrow(VaultCryptoError);
  });

  it('rejects a malformed entry rather than carrying it into the vault', () => {
    expect(() =>
      normalizeForkProvenance([{ ...transactionEntry, kind: 'cashMovement' } as never]),
    ).toThrow(VaultCryptoError);
  });

  it('merges two replicas by union, in either direction', () => {
    expect(mergeForkProvenance([transactionEntry], [sourceEntry])).toEqual(
      mergeForkProvenance([sourceEntry], [transactionEntry]),
    );
    expect(mergeForkProvenance([transactionEntry], [sourceEntry])).toHaveLength(2);
    expect(mergeForkProvenance([transactionEntry], [transactionEntry])).toEqual([transactionEntry]);
  });

  it('only dominates when it already contains the other replica capture', () => {
    expect(forkProvenanceDominates([transactionEntry, sourceEntry], [transactionEntry])).toBe(true);
    expect(forkProvenanceDominates([transactionEntry], [transactionEntry, sourceEntry])).toBe(
      false,
    );
    expect(
      forkProvenanceDominates([transactionEntry], [{ ...transactionEntry, chainId: OTHER_CHAIN }]),
    ).toBe(false);
  });

  it('prunes an entry whose local row was deleted or never existed', () => {
    const stale = { ...transactionEntry, mirrorId: SOURCE_MIRROR, localId: DELETED_LOCAL };
    const missing = { ...transactionEntry, mirrorId: OTHER_CHAIN, localId: OTHER_CHAIN };
    expect(pruneForkProvenance([transactionEntry, stale, missing], document().entities)).toEqual([
      transactionEntry,
    ]);
  });

  it('folds a capture into the document idempotently', () => {
    const once = withForkProvenance(document(), [transactionEntry, sourceEntry]);
    const twice = withForkProvenance(once, [transactionEntry, sourceEntry]);
    expect(once.mirrorProvenance).toEqual([sourceEntry, transactionEntry]);
    expect(twice.mirrorProvenance).toEqual(once.mirrorProvenance);
    expect(twice.entities).toEqual(once.entities);
  });
});
