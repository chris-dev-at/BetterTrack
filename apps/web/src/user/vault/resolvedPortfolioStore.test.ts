import { webcrypto } from 'node:crypto';

import {
  VAULT_ENTITY_DOC_BUCKETS,
  VAULT_ENTITY_ROW_SCHEMAS,
  type PortfolioSummary,
  type VaultConfig,
  type VaultDocEnvelopeHeader,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioStore } from '../../lib/portfolioStore';
import { zeroBytes } from './bytes';
import { CLIENT_MONEY_IDS, decryptClientMoneyFixture } from './engine/clientMoney.testSupport';
import { createClientMoneyMarket } from './engine/clientMoney.testSupport';
import type { DecryptedVaultDocumentSet } from './engine/portfolioDocumentSet';
import {
  resolvePortfolioStore,
  type PortfolioVaultKeystore,
  type UnlockedVaultPortfolioStoreResolution,
} from './portfolioStoreResolver';
import { createUnlockedVaultPortfolioAccess } from './resolvedPortfolioStore';

/**
 * The wiring proof for the E6 store resolver (#1416): a store built over one
 * unlocked resolution serves the REAL decrypted portfolio, and does so without
 * a single server money request.
 *
 * The money itself is not re-asserted here — `clientMoney.test.ts` owns the
 * derivation and `paranoidPortfolioStore` owns the response shaping. What this
 * file pins is that the right derivation reaches the right response, that every
 * operation the resolution cannot answer refuses in a TYPED way rather than
 * returning an empty list or a zero, and that a lock closes the store instantly.
 */

const VAULT_ID = '018f0000-0000-7000-8000-000000000401';
const HEADER_DOC_ID = '018f0000-0000-7000-8000-000000000402';
const COMMON_DOC_ID = '018f0000-0000-7000-8000-000000000403';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('the resolver-backed client portfolio store', () => {
  it('serves the true decrypted portfolio and issues no server money request', async () => {
    const fixture = await storeFixture();

    const holdings = await fixture.access.store.getPortfolio(fixture.stub.id);
    const history = await fixture.access.store.getPortfolioHistory(fixture.stub.id, 'MAX');

    // The buy is visible: both TEST VECTOR assets carry a position.
    expect(holdings.holdings.map((holding) => holding.asset.id).sort()).toEqual(
      [CLIENT_MONEY_IDS.eurAsset, CLIENT_MONEY_IDS.usdAsset].sort(),
    );
    expect(holdings.holdings.every((holding) => holding.quantity > 0)).toBe(true);
    expect(history.points.length).toBeGreaterThan(0);
    expect(history.baseCurrency).toBe('EUR');

    // The response reports the CLIENT derivation, not a second computation of
    // it: comparing against the engine's own numbers is what makes this a
    // wiring assertion instead of a duplicated money expectation.
    const derived = await fixture.resolution.engine.derivePortfolio(fixture.stub.id, '1D');
    if (!derived.ok) throw new Error(JSON.stringify(derived.error));
    expect(holdings.totals.marketValueEur).toBe(derived.value.holdingsValueEur);
    expect(holdings.totals.cashEur).toBe(derived.value.cashBalanceEur);

    // THE FENCE: no server request for this portfolio's money. The market
    // source is a test double here for the same reason the engine's own suites
    // use one — quotes and FX are the vault design's accepted network surface,
    // and only the PORTFOLIO reads are what this store must never issue.
    expect(fixture.fetchSpy).not.toHaveBeenCalled();
    expect(fixture.plainCalls).toEqual([]);
  });

  it('brands its totals with the same snapshot identity the derivation carries', async () => {
    const fixture = await storeFixture();

    const totals = await fixture.access.readTotals();
    const derived = await fixture.resolution.engine.derivePortfolio(fixture.stub.id, '1D');
    if (!derived.ok) throw new Error(JSON.stringify(derived.error));

    expect(totals.snapshotId).toBe(derived.value.snapshotId);
    expect(totals.snapshotId.length).toBeGreaterThan(0);
    expect(fixture.fetchSpy).not.toHaveBeenCalled();
  });

  it('reads the content-free stub roster from the server and nothing else', async () => {
    const fixture = await storeFixture();

    await fixture.access.store.listPortfolios();

    expect(fixture.plainCalls).toEqual(['listPortfolios']);
  });

  it.each([
    ['listTransactions', (store: PortfolioStore) => store.listTransactions('p')],
    ['listCashSources', (store: PortfolioStore) => store.listCashSources('p')],
    ['getCashMovements', (store: PortfolioStore) => store.getCashMovements('p')],
    ['listStandingOrders', (store: PortfolioStore) => store.listStandingOrders('p')],
    ['listCustomAssets', (store: PortfolioStore) => store.listCustomAssets()],
    ['getTaxSettings', (store: PortfolioStore) => store.getTaxSettings()],
    ['createTransactions', (store: PortfolioStore) => store.createTransactions('p', [])],
    ['depositCash', (store: PortfolioStore) => store.depositCash('p', {} as never)],
    ['deleteTransaction', (store: PortfolioStore) => store.deleteTransaction('p', 't')],
    ['archivePortfolio', (store: PortfolioStore) => store.archivePortfolio('p')],
  ])(
    '%s refuses in a typed way instead of answering with an empty result',
    async (_label, call) => {
      const fixture = await storeFixture();

      // Not `[]`, not `0`, not a server round trip: an unreadable ledger and an
      // empty one must never look the same on screen.
      await expect(call(fixture.access.store)).rejects.toMatchObject({
        name: 'VaultPortfolioStoreError',
        code: 'VAULT_OPERATION_UNAVAILABLE',
      });
      expect(fixture.fetchSpy).not.toHaveBeenCalled();
      expect(fixture.plainCalls).toEqual([]);
    },
  );

  it('closes every read the moment the vault session is revoked', async () => {
    const fixture = await storeFixture();
    await expect(fixture.access.store.getPortfolio(fixture.stub.id)).resolves.toBeDefined();
    expect(fixture.access.isCurrent()).toBe(true);

    fixture.access.dispose();

    expect(fixture.access.isCurrent()).toBe(false);
    await expect(fixture.access.store.getPortfolio(fixture.stub.id)).rejects.toMatchObject({
      failure: { code: 'VAULT_LOCKED', retryable: true },
    });
    await expect(fixture.access.readTotals()).rejects.toMatchObject({
      failure: { code: 'VAULT_LOCKED' },
    });
    expect(fixture.fetchSpy).not.toHaveBeenCalled();
  });

  it('stops serving the document as soon as the synchronized set moves underneath it', async () => {
    const fixture = await storeFixture();
    await expect(fixture.access.store.getPortfolio(fixture.stub.id)).resolves.toBeDefined();

    fixture.setDocumentSetCurrent(false);

    expect(fixture.access.isCurrent()).toBe(false);
    // Typed and retryable — the data is not gone, this device just cannot
    // prove the set it holds is still the current one.
    await expect(fixture.access.store.getPortfolio(fixture.stub.id)).rejects.toMatchObject({
      failure: { retryable: true },
    });
  });
});

async function storeFixture(): Promise<{
  stub: PortfolioSummary;
  resolution: UnlockedVaultPortfolioStoreResolution;
  access: ReturnType<typeof createUnlockedVaultPortfolioAccess>;
  plainCalls: string[];
  fetchSpy: ReturnType<typeof vi.fn>;
  setDocumentSetCurrent(current: boolean): void;
}> {
  const fixture = await decryptClientMoneyFixture();
  const anchorEntity = (fixture.document.entities.portfolio ?? []).find(
    (entity) => entity.id === CLIENT_MONEY_IDS.portfolio,
  );
  if (anchorEntity === undefined) throw new Error('The TEST VECTOR has no portfolio anchor.');
  const anchor = VAULT_ENTITY_ROW_SCHEMAS.portfolio.parse(anchorEntity.data);

  const stub: PortfolioSummary = {
    id: CLIENT_MONEY_IDS.portfolio,
    name: 'TEST VECTOR server-visible alias',
    visibility: 'private',
    sortOrder: anchor.sortOrder,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
    kind: null,
    vaultId: VAULT_ID,
    vaultAlias: 'TEST VECTOR vault',
  };
  const vault = {
    id: VAULT_ID,
    name: 'TEST VECTOR vault',
    headerDocId: HEADER_DOC_ID,
    commonDocId: COMMON_DOC_ID,
    media: ['server'],
    driveConnectionId: null,
    // Obviously fake, exactly as in `portfolioStoreResolver.test.ts`: it is only
    // handed back through a stubbed open, so it never has to be a real digest.
    keyFingerprint: 'TESTVECTOR000000',
    retirementProofPublicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    retirementGeneration: 0,
    mediaAttestedAt: null,
    mediaAttestedDriveConnectionId: null,
    createdAt: '2026-08-21T08:00:00.000Z',
    updatedAt: '2026-08-21T08:00:00.000Z',
  } satisfies VaultConfig;
  const keySlots = [
    { keyId: fixture.header.keyId, slot: 'seed-v1' as const, wrappedKc: 'TEST_VECTOR' },
  ];
  const envelope = {
    keyId: fixture.header.keyId,
    keySlots,
    docVersion: fixture.header.vaultVersion,
    writeId: fixture.header.writeId,
  } as VaultDocEnvelopeHeader;

  const fullSet: DecryptedVaultDocumentSet = {
    vaultId: VAULT_ID,
    header: {
      envelope: { ...envelope, docId: HEADER_DOC_ID, docKind: 'header' },
      document: {
        schemaVersion: 1,
        name: 'TEST VECTOR vault',
        portfolios: [{ id: stub.id, name: anchor.name }],
        keySlots,
        driveConnection: null,
        created: { at: fixture.header.writtenAt, deviceId: fixture.header.deviceId },
      },
    },
    common: {
      envelope: { ...envelope, docId: COMMON_DOC_ID, docKind: 'common' },
      document: {
        schemaVersion: 1,
        entities: splitEntities(fixture.document.entities, 'common'),
        mergeLog: fixture.document.mergeLog,
        mirrorProvenance: fixture.document.mirrorProvenance ?? [],
        clientSecurity: {
          retirementProof: {
            publicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            privateKey: 'MC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
        },
      },
    },
    portfolios: [
      {
        envelope: { ...envelope, docId: stub.id, docKind: 'portfolio' },
        document: {
          schemaVersion: 1,
          portfolioId: stub.id,
          entities: splitEntities(fixture.document.entities, 'portfolio'),
          mergeLog: fixture.document.mergeLog,
        },
      },
    ],
  } as DecryptedVaultDocumentSet;

  const keys: PortfolioVaultKeystore = {
    async stateFor() {
      return {
        status: 'stored+wrapped',
        session: 'unlocked',
        requiredAction: { kind: 'open-silently' },
      };
    },
    async openStoredVault(vaultId) {
      return { vaultId, keyId: fixture.header.keyId, keyFingerprint: vault.keyFingerprint };
    },
    async withContentKey(_vaultId, operation) {
      const borrowed = fixture.vaultKey.slice();
      try {
        return await operation(borrowed, fixture.header.keyId, () => {});
      } finally {
        zeroBytes(borrowed);
      }
    },
  };

  let documentSetCurrent = true;
  const plainCalls: string[] = [];
  const plainStore = {
    listPortfolios: async () => {
      plainCalls.push('listPortfolios');
      return { portfolios: [stub] };
    },
  } as unknown as PortfolioStore;

  const resolution = await resolvePortfolioStore(
    stub,
    [vault],
    {
      accountId: CLIENT_MONEY_IDS.user,
      keys,
      reader: {
        async read() {
          return { envelope: new Uint8Array([1]), header: fullSet.header.envelope };
        },
      },
      market: createClientMoneyMarket().market,
      plainStore,
      isDocumentSetCurrent: () => documentSetCurrent,
      loadVaultDocumentSet: async () => fullSet,
    },
    { expectedVaultPortfolioIds: [stub.id] },
  );
  if (resolution.kind !== 'vaulted-unlocked') throw new Error('Expected an unlocked resolution.');

  // Installed AFTER the resolution so the fixture's own stubbed reads do not
  // register: from here on, any fetch at all is a wiring failure.
  const fetchSpy = vi.fn(() => {
    throw new Error('The resolver-backed store must not reach the network.');
  });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchSpy });
  plainCalls.length = 0;

  return {
    stub,
    resolution,
    access: createUnlockedVaultPortfolioAccess(resolution, { plainStore }),
    plainCalls,
    fetchSpy,
    setDocumentSetCurrent: (current: boolean) => {
      documentSetCurrent = current;
    },
  };
}

function splitEntities(
  entities: Partial<Record<VaultEntityKind, VaultEntity[]>>,
  bucket: 'common' | 'portfolio',
): Record<string, VaultEntity[]> {
  return Object.fromEntries(
    (Object.entries(entities) as [VaultEntityKind, VaultEntity[]][]).filter(
      ([kind]) => VAULT_ENTITY_DOC_BUCKETS[kind] === bucket,
    ),
  );
}
