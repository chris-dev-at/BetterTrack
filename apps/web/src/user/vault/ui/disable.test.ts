import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParanoidDisableRequest, VaultDocument, VaultEntity } from '@bettertrack/contracts';

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

import { disableUnlockedVault, discardLockedVault, toStrictRestoreDocument } from './disable';

const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000000ab';
const CREDENTIAL = { confirmUsername: 'ada', password: 'hunter2hunter2' };
const USER_ID = '018f0000-0000-7000-8000-000000000001';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000010';
const MARKET_ID = '018f0000-0000-7000-8000-000000000030';
const OWNED_ID = '018f0000-0000-7000-8000-000000000031';
const RETIRED_OWNED_ID = '018f0000-0000-7000-8000-000000000032';
const RETIRED_MARKET_ID = '018f0000-0000-7000-8000-000000000033';
const DEVICE_ID = '018f0000-0000-7000-8000-0000000000d1';
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
