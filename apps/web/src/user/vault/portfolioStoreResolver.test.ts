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
import { beforeEach, describe, expect, it } from 'vitest';

import type { MarketDataSource } from '../../lib/marketDataSource';
import { apiPortfolioStore } from '../../lib/portfolioStore';
import { zeroBytes } from './bytes';
import type {
  DecryptedPortfolioDocumentSet,
  DecryptedVaultDocumentSet,
  PortfolioDocumentSetEngine,
} from './engine/portfolioDocumentSet';
import { createVaultDocumentSetSession } from './engine/portfolioDocumentSet';
import { CLIENT_MONEY_IDS, decryptClientMoneyFixture } from './engine/clientMoney.testSupport';
import type { ClientPortfolioDerivation, ClientTaxReport } from './engine/types';
import { moneyFailure } from './engine/errors';
import {
  resolvePortfolioStore,
  resolvePortfolioStores,
  type PortfolioVaultKeystore,
} from './portfolioStoreResolver';

const VAULT_ID = '018f0000-0000-7000-8000-000000000301';
const HEADER_DOC_ID = '018f0000-0000-7000-8000-000000000302';
const COMMON_DOC_ID = '018f0000-0000-7000-8000-000000000303';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('per-portfolio store resolution', () => {
  it('keeps plain portfolios on the exact API store without touching custody', async () => {
    const fixture = await resolverFixture();
    const plain = { ...fixture.stub, vaultId: null, vaultAlias: null };

    const resolved = await resolvePortfolioStore(plain, [fixture.vault], fixture.dependencies);

    expect(resolved).toEqual({ kind: 'plain', portfolio: plain, store: apiPortfolioStore });
    expect(fixture.calls.stateFor).toBe(0);
    expect(fixture.calls.read).toBe(0);
    expect(fixture.calls.exportLoad).toBe(0);
  });

  it('returns only the locked stub and E3 action without reading encrypted documents', async () => {
    const fixture = await resolverFixture('locked');

    const resolved = await resolvePortfolioStore(
      fixture.stub,
      [fixture.vault],
      fixture.dependencies,
    );

    expect(resolved).toMatchObject({
      kind: 'vaulted-locked',
      portfolio: fixture.stub,
      vault: fixture.vault,
      requiredAction: { kind: 'unlock', credential: 'device-password' },
    });
    expect(fixture.calls.open).toBe(0);
    expect(fixture.calls.read).toBe(0);
    expect(fixture.calls.exportLoad).toBe(0);
  });

  it('overlays true encrypted fields, guards engine/export with an E3 borrow, and composes a mixed roster', async () => {
    // TEST VECTOR: the same checked-in multi-currency vault used by engine
    // parity supplies the decrypted snapshot behind this resolver seam.
    const fixture = await resolverFixture('unlocked');
    const plain = {
      ...fixture.stub,
      id: '018f0000-0000-7000-8000-000000000399',
      name: 'TEST VECTOR plain portfolio',
      isDefault: false,
      vaultId: null,
      vaultAlias: null,
    };

    const roster = await resolvePortfolioStores(
      [plain, fixture.stub, fixture.secondStub],
      [fixture.vault],
      fixture.dependencies,
    );
    expect(roster.map(({ kind }) => kind)).toEqual([
      'plain',
      'vaulted-unlocked',
      'vaulted-unlocked',
    ]);
    const resolved = roster[1];
    if (resolved?.kind !== 'vaulted-unlocked') throw new Error('Expected unlocked resolution.');
    const secondResolved = roster[2];
    if (secondResolved?.kind !== 'vaulted-unlocked') {
      throw new Error('Expected second unlocked resolution.');
    }

    const anchor = VAULT_ENTITY_ROW_SCHEMAS.portfolio.parse(
      fixture.set.portfolio.document.entities.portfolio![0]!.data,
    );
    expect(resolved.portfolio).toMatchObject({
      id: fixture.stub.id,
      name: anchor.name,
      visibility: anchor.visibility,
      sortOrder: anchor.sortOrder,
      defaultPayFromCash: anchor.defaultPayFromCash,
      vaultId: VAULT_ID,
    });
    expect(resolved.portfolio.name).not.toBe(fixture.stub.name);
    // Both portfolio docs share one vault open. Reopening E3 once per member
    // would replace the cached key identity and invalidate sibling borrows.
    expect(fixture.calls.stateFor).toBe(1);
    expect(fixture.calls.open).toBe(1);
    // One header open; the complete vault set is loaded once and shared by both members.
    expect(fixture.calls.read).toBe(1);
    expect(fixture.calls.exportLoad).toBe(1);

    await expect(resolved.engine.derivePortfolio(fixture.stub.id, 'MAX')).resolves.toMatchObject({
      ok: true,
      value: { portfolioId: fixture.stub.id },
    });
    const exported = await resolved.exportCleartext({
      generatedAt: new Date('2026-08-21T12:00:00.000Z'),
    });
    if (!exported.ok) {
      throw new Error(JSON.stringify(exported.error));
    }
    expect(exported).toMatchObject({
      ok: true,
      value: {
        manifest: { userId: CLIENT_MONEY_IDS.user, entities: { portfolios: 2 } },
      },
    });
    expect(fixture.calls.borrow).toBe(4);
    expect(fixture.calls.assertSessionCurrent).toBe(8);
    expect(fixture.calls.borrowedCopies.every((copy) => copy.every((byte) => byte === 0))).toBe(
      true,
    );

    resolved.dispose();
    secondResolved.dispose();
    expect(fixture.calls.engineRevoke).toBe(2);
    expect(fixture.calls.exportRevoke).toBe(1);
    await expect(resolved.engine.derivePortfolio(fixture.stub.id, 'MAX')).resolves.toMatchObject({
      ok: false,
      error: { code: 'VAULT_LOCKED', retryable: true },
    });
  });

  it('zeroes generated archive bytes when the outer E3 post-operation assertion loses a lock race', async () => {
    const fixture = await resolverFixture('unlocked');
    const archive = new Uint8Array([9, 8, 7, 6]);
    const dependencies = {
      ...fixture.dependencies,
      createCleartextExport: async () => ({
        ok: true as const,
        value: {
          filename: 'test-vector.zip',
          mediaType: 'application/zip' as const,
          bytes: archive,
          manifest: {
            format: 'bettertrack-account-export' as const,
            version: 1 as const,
            userId: CLIENT_MONEY_IDS.user,
            generatedAt: '2026-08-21T12:00:00.000Z',
            entities: {},
            csv: [],
            skippedTables: [],
          },
        },
      }),
    };
    const resolved = await resolvePortfolioStore(fixture.stub, [fixture.vault], dependencies, {
      expectedVaultPortfolioIds: fixture.fullSet.header.document.portfolios.map(({ id }) => id),
    });
    if (resolved.kind !== 'vaulted-unlocked') throw new Error('Expected unlocked resolution.');

    const baseBorrow = fixture.dependencies.keys.withContentKey.bind(fixture.dependencies.keys);
    let operationAssertions = 0;
    fixture.dependencies.keys.withContentKey = (vaultId, operation) =>
      baseBorrow(vaultId, (contentKey, keyId, assertSessionCurrent) =>
        operation(contentKey, keyId, () => {
          assertSessionCurrent();
          operationAssertions += 1;
          if (operationAssertions === 2) {
            throw moneyFailure('VAULT_LOCKED', 'TEST VECTOR lock raced the archive.', {
              retryable: true,
            });
          }
        }),
      );

    const outcome = await resolved.exportCleartext();
    expect(outcome).toMatchObject({ ok: false, error: { code: 'VAULT_LOCKED' } });
    expect(operationAssertions).toBe(2);
    expect(archive).toEqual(new Uint8Array(archive.length));
    expect(fixture.calls.exportRevoke).toBe(1);
  });

  it('discards a money result when the synchronized document-set identity changes', async () => {
    const fixture = await resolverFixture('unlocked');
    const resolved = await resolvePortfolioStore(
      fixture.stub,
      [fixture.vault],
      fixture.dependencies,
      { expectedVaultPortfolioIds: fixture.fullSet.header.document.portfolios.map(({ id }) => id) },
    );
    if (resolved.kind !== 'vaulted-unlocked') throw new Error('Expected unlocked resolution.');
    let freshnessChecks = 0;
    fixture.dependencies.isDocumentSetCurrent = () => {
      freshnessChecks += 1;
      return freshnessChecks < 2;
    };

    await expect(resolved.engine.derivePortfolio(fixture.stub.id, 'MAX')).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED', retryable: true },
    });
    expect(freshnessChecks).toBe(2);
  });

  it('refuses an unlocked direct resolution without a complete server-stub roster', async () => {
    const fixture = await resolverFixture('unlocked');

    await expect(
      resolvePortfolioStore(fixture.stub, [fixture.vault], fixture.dependencies),
    ).rejects.toMatchObject({
      name: 'PortfolioStoreResolutionError',
      code: 'VAULT_ROSTER_REQUIRED',
    });
    expect(fixture.calls.open).toBe(0);
    expect(fixture.calls.exportLoad).toBe(0);
  });
});

async function resolverFixture(state: 'locked' | 'unlocked' = 'unlocked') {
  const fixture = await decryptClientMoneyFixture();
  const anchorEntity = fixture.document.entities.portfolio?.[0];
  if (anchorEntity === undefined) throw new Error('TEST VECTOR portfolio anchor is missing.');
  const anchor = VAULT_ENTITY_ROW_SCHEMAS.portfolio.parse(anchorEntity.data);
  const stub: PortfolioSummary = {
    id: anchorEntity.id,
    name: 'TEST VECTOR locked alias',
    visibility: 'private',
    sortOrder: anchor.sortOrder,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
    kind: null,
    vaultId: VAULT_ID,
    vaultAlias: 'TEST VECTOR server-visible vault',
  };
  const vault = {
    id: VAULT_ID,
    name: 'TEST VECTOR server-visible vault',
    headerDocId: HEADER_DOC_ID,
    commonDocId: COMMON_DOC_ID,
    media: ['server'],
    driveConnectionId: null,
    keyFingerprint: 'SGn1pC05gjstkyjs',
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
  const secondPortfolioId = '018f0000-0000-7000-8000-000000000398';
  const secondAnchor = structuredClone(anchorEntity);
  secondAnchor.id = secondPortfolioId;
  secondAnchor.data = {
    ...secondAnchor.data,
    name: 'TEST VECTOR second vaulted portfolio',
    sortOrder: anchor.sortOrder + 1,
  };
  const secondStub: PortfolioSummary = {
    ...stub,
    id: secondPortfolioId,
    name: 'TEST VECTOR second locked alias',
    sortOrder: anchor.sortOrder + 1,
    isDefault: false,
  };
  const portfolioEntities = splitEntities(fixture.document.entities, 'portfolio');
  const commonEntities = splitEntities(fixture.document.entities, 'common');
  const set = {
    vaultId: VAULT_ID,
    portfolioId: stub.id,
    header: {
      envelope: { ...envelope, docId: HEADER_DOC_ID, docKind: 'header' },
      document: {
        schemaVersion: 1,
        name: 'TEST VECTOR true vault',
        portfolios: [
          { id: stub.id, name: anchor.name },
          { id: secondPortfolioId, name: 'TEST VECTOR second vaulted portfolio' },
        ],
        keySlots,
        driveConnection: null,
        created: { at: fixture.header.writtenAt, deviceId: fixture.header.deviceId },
      },
    },
    common: {
      envelope: { ...envelope, docId: COMMON_DOC_ID, docKind: 'common' },
      document: {
        schemaVersion: 1,
        entities: commonEntities,
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
    portfolio: {
      envelope: { ...envelope, docId: stub.id, docKind: 'portfolio' },
      document: {
        schemaVersion: 1,
        portfolioId: stub.id,
        entities: portfolioEntities,
        mergeLog: fixture.document.mergeLog,
      },
    },
  } as DecryptedPortfolioDocumentSet;
  const secondSet: DecryptedPortfolioDocumentSet = {
    ...set,
    portfolioId: secondPortfolioId,
    portfolio: {
      envelope: {
        ...set.portfolio.envelope,
        docId: secondPortfolioId,
        writeId: '018f0000-0000-7000-8000-000000000397',
      },
      document: {
        schemaVersion: 1 as const,
        portfolioId: secondPortfolioId,
        entities: { portfolio: [secondAnchor] },
        mergeLog: [],
      },
    },
  };
  const fullSet: DecryptedVaultDocumentSet = {
    vaultId: set.vaultId,
    header: set.header,
    common: set.common,
    portfolios: [set.portfolio, secondSet.portfolio],
  };
  const calls = {
    stateFor: 0,
    open: 0,
    read: 0,
    exportLoad: 0,
    borrow: 0,
    assertSessionCurrent: 0,
    engineRevoke: 0,
    exportRevoke: 0,
    borrowedCopies: [] as Uint8Array[],
    exportExpectedIds: [] as string[],
  };
  const keys: PortfolioVaultKeystore = {
    async stateFor() {
      calls.stateFor += 1;
      return state === 'locked'
        ? {
            status: 'stored+wrapped',
            session: 'locked',
            requiredAction: { kind: 'unlock', credential: 'device-password' },
          }
        : {
            status: 'stored+wrapped',
            session: 'unlocked',
            requiredAction: { kind: 'open-silently' },
          };
    },
    async openStoredVault(vaultId, fetchHeaderEnvelope) {
      calls.open += 1;
      await fetchHeaderEnvelope({ vaultId });
      return { vaultId, keyId: fixture.header.keyId, keyFingerprint: vault.keyFingerprint };
    },
    async withContentKey(vaultId, operation) {
      calls.borrow += 1;
      if (vaultId !== VAULT_ID) throw new Error('Unexpected TEST VECTOR vault borrow.');
      const borrowed = fixture.vaultKey.slice();
      calls.borrowedCopies.push(borrowed);
      try {
        return await operation(borrowed, fixture.header.keyId, () => {
          calls.assertSessionCurrent += 1;
        });
      } finally {
        zeroBytes(borrowed);
      }
    },
  };
  const engine: PortfolioDocumentSetEngine = {
    async derivePortfolio(portfolioId) {
      return { ok: true, value: { portfolioId } as ClientPortfolioDerivation };
    },
    async deriveTaxReport(portfolioId) {
      return { ok: true, value: { portfolioId } as ClientTaxReport };
    },
    clearCache() {},
    clearTaxCache() {},
    revoke() {
      calls.engineRevoke += 1;
    },
  };
  const dependencies = {
    accountId: CLIENT_MONEY_IDS.user,
    keys,
    reader: {
      async read() {
        calls.read += 1;
        return { envelope: new Uint8Array([1]), header: set.header.envelope };
      },
    },
    market: {} as MarketDataSource,
    isDocumentSetCurrent: () => true,
    loadVaultDocumentSet: async ({
      expectedPortfolioIds,
    }: {
      expectedPortfolioIds: readonly string[];
    }) => {
      calls.exportLoad += 1;
      calls.exportExpectedIds = [...expectedPortfolioIds];
      expect([...expectedPortfolioIds].sort()).toEqual([stub.id, secondPortfolioId].sort());
      return fullSet;
    },
    createEngine: () => engine,
    createVaultExportSession: (vaultSet: DecryptedVaultDocumentSet) => {
      const session = createVaultDocumentSetSession(vaultSet);
      return {
        ...session,
        revoke() {
          calls.exportRevoke += 1;
          session.revoke();
        },
      };
    },
  };
  return { stub, secondStub, vault, set, fullSet, calls, dependencies };
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
