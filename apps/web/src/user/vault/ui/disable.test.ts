import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ParanoidDisableRequest,
  VaultDocument,
  VaultEntity,
  VaultMirrorProvenance,
} from '@bettertrack/contracts';

const api = vi.hoisted(() => ({
  disableParanoidMode: vi.fn(async (_body: unknown) => ({
    mode: 'normal' as const,
    rehydrationId: '018f0000-0000-7000-8000-0000000000aa',
    completedAt: '2026-07-30T10:00:00.000Z',
    idempotent: false,
    postCommit: { invalidate: [] as never[] },
  })),
}));

vi.mock('../../../lib/userApi', () => api);

// The exit ships the ONE converter, from its canonical home — importing it from
// anywhere else here would let this file certify a copy the app never runs.
import { toStrictRestoreDocument } from '../paranoidDisable';
import { disableUnlockedVault, discardLockedVault } from './disable';

const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000000ab';
const CREDENTIAL = { confirmUsername: 'ada', password: 'hunter2hunter2' };
const USER_ID = '018f0000-0000-7000-8000-000000000001';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000010';
const MARKET_ID = '018f0000-0000-7000-8000-000000000030';
const OWNED_ID = '018f0000-0000-7000-8000-000000000031';
const RETIRED_OWNED_ID = '018f0000-0000-7000-8000-000000000032';
const RETIRED_MARKET_ID = '018f0000-0000-7000-8000-000000000033';
const DEVICE_ID = '018f0000-0000-7000-8000-0000000000d1';
const CHAIN_ID = '018f0000-0000-7000-8000-0000000000c1';
const MEMBERSHIP_ID = '018f0000-0000-7000-8000-0000000000c2';
const SOURCE_MIRROR_ID = '018f0000-0000-7000-8000-0000000000c3';
const SOURCE_LOCAL_ID = '018f0000-0000-7000-8000-0000000000c4';
const DELETED_MIRROR_ID = '018f0000-0000-7000-8000-0000000000c5';
const DELETED_LOCAL_ID = '018f0000-0000-7000-8000-0000000000c6';
const AT = '2026-07-30T09:00:00.000Z';

function entity(id: string, data: Record<string, unknown>, deletedAt: string | null = null) {
  return { id, rev: 1, editedAt: AT, editedBy: DEVICE_ID, deletedAt, data } satisfies VaultEntity;
}

function assetRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    providerId: 'yahoo',
    providerRef: 'ACME',
    ownerId: null,
    type: 'stock',
    symbol: 'ACME',
    name: 'Acme',
    exchange: 'XETRA',
    currency: 'EUR',
    meta: null,
    searchText: 'ACME Acme',
    ...overrides,
  };
}

/** A local asset table holding both market snapshots and the owner's assets. */
function documentWithAssetTable(): VaultDocument {
  return {
    schemaVersion: 1,
    entities: {
      portfolio: [
        entity(PORTFOLIO_ID, {
          userId: USER_ID,
          name: 'Main',
          visibility: 'private',
          sortOrder: 0,
          defaultPayFromCash: false,
          archivedAt: null,
        }),
      ],
      customAsset: [
        entity(MARKET_ID, assetRow({})),
        entity(RETIRED_MARKET_ID, assetRow({ symbol: 'OLD', name: 'Old' }), AT),
        entity(
          OWNED_ID,
          assetRow({
            // A reference written as the NAME, the shape an older client
            // produced: derivable, so it must not be able to block the exit.
            providerId: 'manual',
            providerRef: 'HOUSE',
            ownerId: USER_ID,
            type: 'custom',
            symbol: 'HOUSE',
            name: 'House',
            exchange: null,
            meta: { category: 'other', smoothing: false },
            searchText: 'HOUSE House',
          }),
        ),
        entity(
          RETIRED_OWNED_ID,
          assetRow({
            providerId: 'manual',
            providerRef: RETIRED_OWNED_ID,
            ownerId: USER_ID,
            type: 'custom',
            symbol: 'CAR',
            name: 'Car',
            exchange: null,
            meta: { category: 'other', smoothing: false },
            searchText: 'CAR Car',
          }),
          AT,
        ),
      ],
    },
    mergeLog: [],
  };
}

function cashSourceRow(name: string): Record<string, unknown> {
  return {
    portfolioId: PORTFOLIO_ID,
    name,
    type: 'bank',
    isMain: true,
    archivedAt: null,
    createdAt: AT,
  };
}

const RETAINED_FORK_ENTRY: VaultMirrorProvenance = {
  chainId: CHAIN_ID,
  membershipId: MEMBERSHIP_ID,
  kind: 'cash_source',
  mirrorId: SOURCE_MIRROR_ID,
  portfolioId: PORTFOLIO_ID,
  localId: SOURCE_LOCAL_ID,
};

/**
 * An account that left a MIRRORCHAIN keeping its fork, then went paranoid: the
 * §7.1 identity map rides inside the ciphertext (`captureForkProvenanceIntoVault`
 * folds it in on every unlocked session) because `mirror_rows` died at enable.
 * One entry names a live row and one names a row the user has since deleted.
 */
function documentWithRetainedFork(): VaultDocument {
  const document = documentWithAssetTable();
  return {
    ...document,
    entities: {
      ...document.entities,
      cashSource: [
        entity(SOURCE_LOCAL_ID, cashSourceRow('Giro')),
        entity(DELETED_LOCAL_ID, cashSourceRow('Closed'), AT),
      ],
    },
    mirrorProvenance: [
      RETAINED_FORK_ENTRY,
      { ...RETAINED_FORK_ENTRY, mirrorId: DELETED_MIRROR_ID, localId: DELETED_LOCAL_ID },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage?.clear();
});

describe('toStrictRestoreDocument', () => {
  it('hands back only the owner-claimed assets — market snapshots are the server’s own rows', () => {
    // `validateCustomAssetFacts` walks EVERY customAsset entity, tombstones
    // included, and refuses one that is not this account's manual asset. A
    // market snapshot is a copy of a global `assets` row that survived the
    // enable purge; the server re-resolves it in `resolveReferencedAssets`.
    const restore = toStrictRestoreDocument(documentWithAssetTable());
    const assets = restore.entities.filter((row) => row.kind === 'customAsset');

    expect(assets.map((row) => row.id)).toEqual([OWNED_ID, RETIRED_OWNED_ID]);
    for (const asset of assets) {
      expect(asset.data.ownerId).toBe(USER_ID);
      expect(asset.data.providerId).toBe('manual');
      expect(asset.data.providerRef).toBe(asset.id);
    }
    // The tombstone must survive: `retainedCustomAssetRetireIds` refuses a
    // restore that cannot account for a retained identity, and the tombstone is
    // what retires it.
    expect(assets.find((row) => row.id === RETIRED_OWNED_ID)?.deletedAt).toBe(AT);
    // Nothing else is filtered.
    expect(restore.entities.filter((row) => row.kind === 'portfolio')).toHaveLength(1);
  });

  it('sends the filtered document on disable', async () => {
    await disableUnlockedVault(documentWithAssetTable(), ACCOUNT_ID);

    const body = api.disableParanoidMode.mock.calls[0]![0] as ParanoidDisableRequest;
    expect(body.discard).toBeUndefined();
    expect(
      body.document.entities
        .filter((row) => row.kind === 'customAsset')
        .map((row) => [row.id, row.data.providerRef]),
    ).toEqual([
      [OWNED_ID, OWNED_ID],
      [RETIRED_OWNED_ID, RETIRED_OWNED_ID],
    ]);
  });

  it('carries §7.1 fork provenance to the server — without it the exit is refused forever', async () => {
    await disableUnlockedVault(documentWithRetainedFork(), ACCOUNT_ID);

    const body = api.disableParanoidMode.mock.calls[0]![0] as ParanoidDisableRequest;
    // A sanctioned chain correction replaces the local row, so `localId =
    // mirrorId` no longer holds and restore-time validation cannot re-derive the
    // association. Ship an EMPTY map and `proveForkProvenance` short-circuits,
    // `validateLedgerSolvency` calls the correction an overdraw, and the disable
    // fails with 400 PARANOID_REHYDRATION_INVALID on every retry — stranding the
    // account in paranoid mode with only the irreversible discard left. The
    // strict schema defaults this field to `[]`, so nothing but this assertion
    // can catch a converter that drops it.
    expect(body.document.mirrorProvenance).toEqual([RETAINED_FORK_ENTRY]);
    // Pruned, not passed through: an entry naming a row the document no longer
    // restores is rejected server-side, so a stale alias would block the exit
    // just as surely as a missing one.
    expect(body.document.mirrorProvenance.map((entry) => entry.localId)).not.toContain(
      DELETED_LOCAL_ID,
    );
  });
});

describe('discardLockedVault', () => {
  it('restores nothing and says so explicitly — the locked client has no rows to hand back (§3)', async () => {
    await discardLockedVault(ACCOUNT_ID, CREDENTIAL);

    expect(api.disableParanoidMode).toHaveBeenCalledTimes(1);
    const body = api.disableParanoidMode.mock.calls[0]![0] as ParanoidDisableRequest;
    expect(body.document).toEqual({
      schemaVersion: 1,
      entities: [],
      mergeLog: [],
      mirrorProvenance: [],
    });
    // The flag is what authorizes destruction; an empty graph alone is refused
    // server-side precisely so a lost-rows bug cannot wipe an account.
    expect(body.discard).toBe(true);
    expect(body.confirm).toBe(true);
    expect(body.rehydrationId).toMatch(/^[0-9a-f-]{36}$/i);
    // The account-deletion rung travels with it: the server re-verifies both
    // halves, so a caller that skips them is refused before anything is wiped.
    expect(body.confirmUsername).toBe('ada');
    expect(body.password).toBe('hunter2hunter2');
  });

  it('reuses an interrupted rehydration id so the server can answer idempotently', async () => {
    const key = `bettertrack:vault-rehydration:${ACCOUNT_ID}`;
    const interrupted = '018f0000-0000-7000-8000-0000000000ac';
    globalThis.sessionStorage.setItem(key, interrupted);

    await discardLockedVault(ACCOUNT_ID, CREDENTIAL);

    const body = api.disableParanoidMode.mock.calls[0]![0] as ParanoidDisableRequest;
    expect(body.rehydrationId).toBe(interrupted);
    // The completed transition releases the marker.
    expect(globalThis.sessionStorage.getItem(key)).toBeNull();
  });

  it('keeps the retry marker when the transition fails', async () => {
    api.disableParanoidMode.mockRejectedValueOnce(new Error('offline'));

    await expect(discardLockedVault(ACCOUNT_ID, CREDENTIAL)).rejects.toThrow('offline');
    expect(
      globalThis.sessionStorage.getItem(`bettertrack:vault-rehydration:${ACCOUNT_ID}`),
    ).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
