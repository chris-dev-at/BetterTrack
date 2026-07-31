import type { VaultDocument, VaultEntity, VaultMirrorProvenance } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { VaultCryptoError } from './errors';
import {
  captureForkProvenanceIntoVault,
  carriedForkProvenance,
  forkProvenanceDominates,
  mergeForkProvenance,
  normalizeForkProvenance,
  pruneForkProvenance,
  withForkProvenance,
} from './mirrorProvenance';
import type { VaultSyncCandidate, VaultSyncState } from './sync';

const CHAIN = '018f0000-0000-7000-8000-0000000000c1';
const OTHER_CHAIN = '018f0000-0000-7000-8000-0000000000c2';
const PORTFOLIO = '018f0000-0000-7000-8000-0000000000c3';
const TX_MIRROR = '018f0000-0000-7000-8000-0000000000c4';
const TX_LOCAL = '018f0000-0000-7000-8000-0000000000c5';
const SOURCE_MIRROR = '018f0000-0000-7000-8000-0000000000c6';
const SOURCE_LOCAL = '018f0000-0000-7000-8000-0000000000c7';
const DELETED_LOCAL = '018f0000-0000-7000-8000-0000000000c8';
const DEVICE = '018f0000-0000-7000-8000-0000000000c9';
const MEMBERSHIP = '018f0000-0000-7000-8000-0000000000ca';
const REJOINED_MEMBERSHIP = '018f0000-0000-7000-8000-0000000000cb';
const REJOINED_PORTFOLIO = '018f0000-0000-7000-8000-0000000000cc';
const REJOINED_LOCAL = '018f0000-0000-7000-8000-0000000000cd';

const transactionEntry: VaultMirrorProvenance = {
  chainId: CHAIN,
  membershipId: MEMBERSHIP,
  kind: 'transaction',
  mirrorId: TX_MIRROR,
  portfolioId: PORTFOLIO,
  localId: TX_LOCAL,
};
const sourceEntry: VaultMirrorProvenance = {
  chainId: CHAIN,
  membershipId: MEMBERSHIP,
  kind: 'cash_source',
  mirrorId: SOURCE_MIRROR,
  portfolioId: PORTFOLIO,
  localId: SOURCE_LOCAL,
};
/** The same chain and logical entity, kept by a SECOND membership's copy. */
const rejoinedEntry: VaultMirrorProvenance = {
  chainId: CHAIN,
  membershipId: REJOINED_MEMBERSHIP,
  kind: 'transaction',
  mirrorId: TX_MIRROR,
  portfolioId: REJOINED_PORTFOLIO,
  localId: REJOINED_LOCAL,
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
      transaction: [
        entity(TX_LOCAL),
        entity(REJOINED_LOCAL),
        entity(DELETED_LOCAL, '2026-07-25T10:00:00.000Z'),
      ],
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

  /**
   * Re-joining a chain is a normal flow: the second membership gets its own copy,
   * so one chain can hold two retained forks that both kept the same logical
   * entity. Keying by chain alone would call that a fatal duplicate.
   */
  it('keeps two retained forks of one chain apart by membership', () => {
    expect(normalizeForkProvenance([transactionEntry, rejoinedEntry])).toHaveLength(2);
    expect(forkProvenanceDominates([transactionEntry], [rejoinedEntry])).toBe(false);
    expect(() =>
      normalizeForkProvenance([transactionEntry, { ...rejoinedEntry, localId: TX_LOCAL }]),
    ).toThrow(VaultCryptoError);
  });

  it('never invents the key on a document that has none', () => {
    const withoutKey: VaultDocument = { ...document(), mirrorProvenance: undefined };
    expect(carriedForkProvenance(withoutKey)).toBeUndefined();
    expect(withForkProvenance(withoutKey, [])).toBe(withoutKey);
    expect(carriedForkProvenance(document([transactionEntry]))).toEqual([transactionEntry]);
  });

  it('captures into the vault through one mutation and no-ops when unchanged', async () => {
    const engine = fakeEngine(document([]));
    expect(await captureForkProvenanceIntoVault(engine, async () => [transactionEntry])).not.toBe(
      null,
    );
    expect(engine.mutations).toBe(1);
    expect(engine.state.active?.document.mirrorProvenance).toEqual([transactionEntry]);

    expect(await captureForkProvenanceIntoVault(engine, async () => [transactionEntry])).toBe(null);
    expect(engine.mutations).toBe(1);
  });

  /**
   * The pre-enable capture reads a map that still names a row the user deleted
   * locally in the meantime: folding it verbatim would carry an alias the server
   * rejects, which would block ever disabling paranoid mode.
   */
  it('drops a captured entry whose local row is already deleted', async () => {
    const engine = fakeEngine(document([]));
    const state = await captureForkProvenanceIntoVault(engine, async () => [
      transactionEntry,
      { ...sourceEntry, kind: 'transaction', localId: DELETED_LOCAL },
    ]);
    expect(state).not.toBe(null);
    expect(engine.state.active?.document.mirrorProvenance).toEqual([transactionEntry]);
  });
});

/** A minimal stand-in for the sync engine's mutate/state surface. */
function fakeEngine(initial: VaultDocument) {
  let current = initial;
  let mutations = 0;
  const state = (): VaultSyncState => ({
    status: 'synced',
    active: { document: current } as VaultSyncCandidate,
    pending: null,
  });
  return {
    get state() {
      return state();
    },
    get mutations() {
      return mutations;
    },
    async mutate(
      mutator: (context: { document: VaultDocument; currentVersion: number }) => VaultDocument,
    ) {
      mutations += 1;
      current = mutator({ document: current, currentVersion: 1 });
      return state();
    },
  };
}
