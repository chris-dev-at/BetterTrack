import { webcrypto } from 'node:crypto';

import {
  VAULT_DOC_SCHEMA_VERSION,
  VAULT_ENTITY_DOC_BUCKETS,
  VAULT_ENTITY_ROW_SCHEMAS,
  vaultCommonDocSchema,
  vaultHeaderDocSchema,
  vaultPortfolioDocSchema,
  type VaultDocKind,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import { settleDeYear } from '@bettertrack/domain/tax';
import { beforeEach, describe, expect, it } from 'vitest';

import { utf8, zeroBytes } from '../bytes';
import { encodeBase64Url } from '../keys/base64url';
import { encryptVaultDoc } from '../keys/documents';
import { createVaultMoneyEngine } from './index';
import {
  PortfolioDocumentSetError,
  createPortfolioDocumentSetEngine,
  createPortfolioDocumentSetSession,
  loadDecryptedPortfolioDocumentSet,
  loadDecryptedVaultDocumentSet,
  type VaultContentKeyBorrower,
  type VaultDocEnvelopeRead,
  type VaultDocEnvelopeReader,
} from './portfolioDocumentSet';
import {
  CLIENT_MONEY_IDS,
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
  expectedClientMoneyFixtureDerivation,
} from './clientMoney.testSupport';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const VAULT_ID = '018f0000-0000-7000-8000-000000000301';
const HEADER_DOC_ID = '018f0000-0000-7000-8000-000000000302';
const COMMON_DOC_ID = '018f0000-0000-7000-8000-000000000303';
const HEADER_WRITE_ID = '018f0000-0000-7000-8000-000000000304';
const COMMON_WRITE_ID = '018f0000-0000-7000-8000-000000000305';
const OTHER_PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000306';
/** TEST VECTOR: sha256("bettertrack-vault-owner-v1:" + CLIENT_MONEY_IDS.user). */
const ACCOUNT_BINDING = 'Hv91YuTcvtSHD9kTkBVK2d-L-fhtxfee-HQQFMj2fPo';
const OTHER_ACCOUNT_BINDING = 'A'.repeat(43);

/** TEST VECTOR: canonical Ed25519 SPKI prefix followed by 32 zero public-key bytes. */
const RETIREMENT_PUBLIC_KEY = encodeBase64Url(
  new Uint8Array([
    0x30,
    0x2a,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x03,
    0x21,
    0x00,
    ...new Array<number>(32).fill(0),
  ]),
);
/** TEST VECTOR: canonical Ed25519 PKCS#8 prefix followed by 32 zero private-key bytes. */
const RETIREMENT_PRIVATE_KEY = encodeBase64Url(
  new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x04,
    0x22,
    0x04,
    0x20,
    ...new Array<number>(32).fill(0),
  ]),
);

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('split portfolio document-set engine', () => {
  it('decrypts the client-money TEST VECTOR and matches the legacy engine exactly', async () => {
    // TEST VECTOR: the checked-in encrypted multi-currency clientMoney fixture is
    // first opened through the legacy envelope, split only by E0's exhaustive
    // bucket table, then independently encrypted as v2 header/common/portfolio docs.
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture);
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    const set = await loadDecryptedPortfolioDocumentSet({
      vault: encrypted.vault,
      accountId: CLIENT_MONEY_IDS.user,
      portfolioId: CLIENT_MONEY_IDS.portfolio,
      expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
      keys: borrow.keys,
      reader: mapReader(encrypted.reads),
    });

    expect(borrow.state.assertSessionCurrentCalls).toBe(5);
    expect(borrow.state.usedDistinctKeyCopy).toBe(true);
    expect(borrow.state.borrowedKey).toEqual(new Uint8Array(fixture.vaultKey.length));

    // The source key and E3's borrowed copy are both gone before any engine call.
    // Successful derivation below therefore also proves the document set retained
    // authenticated plaintext, never K_c.
    zeroBytes(fixture.vaultKey);
    const splitMarket = createClientMoneyMarket();
    const splitEngine = createPortfolioDocumentSetEngine(set, splitMarket.market, {
      now: () => NOW,
    });
    const legacyEngine = createVaultMoneyEngine(
      createMutableTestSync(fixture.document, fixture.header, fixture.envelope),
      createClientMoneyMarket().market,
      { now: () => NOW },
    );

    const legacyPortfolio = await legacyEngine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    const splitPortfolio = await splitEngine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX');
    const legacyTax = await legacyEngine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    const splitTax = await splitEngine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);

    expect(legacyPortfolio.ok, outcomeError(legacyPortfolio)).toBe(true);
    expect(splitPortfolio.ok, outcomeError(splitPortfolio)).toBe(true);
    expect(legacyTax.ok, outcomeError(legacyTax)).toBe(true);
    expect(splitTax.ok, outcomeError(splitTax)).toBe(true);
    if (!legacyPortfolio.ok || !splitPortfolio.ok || !legacyTax.ok || !splitTax.ok) return;

    const plainDomain = await expectedClientMoneyFixtureDerivation();
    const portfolioBytes = exactDecimalJson(withoutSnapshotId(splitPortfolio.value));
    const taxBytes = exactDecimalJson(withoutSnapshotId(splitTax.value));
    expect(portfolioBytes).toContain('"totalValueEur":"2285"');
    expect(splitPortfolio.value.snapshotId).not.toBe(legacyPortfolio.value.snapshotId);
    expect(splitTax.value.snapshotId).toBe(splitPortfolio.value.snapshotId);
    expect(portfolioBytes).toBe(exactDecimalJson(withoutSnapshotId(legacyPortfolio.value)));
    expect(taxBytes).toBe(exactDecimalJson(withoutSnapshotId(legacyTax.value)));

    // Independent plain/server-domain oracle over the same fixture inputs —
    // not a second invocation of the client adapter under test.
    expect(exactDecimalJson(splitPortfolio.value.holdings)).toBe(
      exactDecimalJson(plainDomain.holdings),
    );
    expect(exactDecimalJson(splitPortfolio.value.series)).toBe(
      exactDecimalJson(
        plainDomain.series.map((point) => ({
          date: point.date,
          valueEur: point.valueEur,
          costBasisEur: point.costBasisEur,
          pnlEur: point.pnlEur,
          twrPct: point.twrPct,
          missingAssetIds: [],
          freshness: 'fresh',
          isLiveToday: point.date === '2026-07-27',
        })),
      ),
    );
    expect(exactDecimalJson(splitPortfolio.value.stats)).toBe(exactDecimalJson(plainDomain.stats));
    expect(exactDecimalJson(splitPortfolio.value.cashSources)).toBe(
      exactDecimalJson([{ sourceId: CLIENT_MONEY_IDS.cashSource, name: 'Main', balanceEur: 1020 }]),
    );
    expect(exactDecimalJson(splitPortfolio.value.holdingsValueEur)).toBe('"1265"');
    expect(exactDecimalJson(splitPortfolio.value.cashBalanceEur)).toBe('"1020"');
    expect(exactDecimalJson(splitPortfolio.value.totalValueEur)).toBe('"2285"');

    const plainDeTax = settleDeYear({
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      existingEvents: [
        { kind: 'sell_gain', category: 'aktien', amountEur: 37 },
        { kind: 'dividend', amountEur: 30 },
      ],
      heldEur: 0,
      newEvents: [],
    });
    expect(exactDecimalJson(splitTax.value.computedTaxTargetEur)).toBe(
      exactDecimalJson(plainDeTax.heldAfterEur),
    );
    expect(exactDecimalJson(splitTax.value.report.summary.de)).toBe(
      exactDecimalJson({
        allowanceUsedEur: plainDeTax.yearEnd.allowanceUsedEur,
        allowanceRemainingEur: plainDeTax.yearEnd.allowanceRemainingEur,
        aktienPotInEur: 0,
        aktienPotOutEur: plainDeTax.yearEnd.aktienPotOutEur,
        sonstigePotInEur: 0,
        sonstigePotOutEur: plainDeTax.yearEnd.sonstigePotOutEur,
        kapestEur: plainDeTax.yearEnd.kapestEur,
        soliEur: plainDeTax.yearEnd.soliEur,
      }),
    );

    // Quote privacy boundary (§5/#1344): the engine uses the public market seam
    // one opaque asset id at a time. No portfolio id or holdings-roster batch is
    // ever supplied; E2's unattributed-read usage suppression remains effective.
    expect(splitMarket.calls.quote.sort()).toEqual(
      [CLIENT_MONEY_IDS.eurAsset, CLIENT_MONEY_IDS.usdAsset].sort(),
    );
    expect(splitMarket.calls.quote).not.toContain(CLIENT_MONEY_IDS.portfolio);
    expect(splitMarket.calls.quote.every((argument) => typeof argument === 'string')).toBe(true);

    splitEngine.revoke();
    await expect(
      splitEngine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, 'MAX'),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VAULT_LOCKED' } });
  });

  it('rejects a successfully decrypted document mixed from another account binding', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture, {
      accountBindingByKind: { common: OTHER_ACCOUNT_BINDING },
    });
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PortfolioDocumentSetError>>({
        name: 'PortfolioDocumentSetError',
        code: 'VAULT_DOCUMENT_INVALID',
      }),
    );

    expect(borrow.state.assertSessionCurrentCalls).toBe(2);
    expect(borrow.state.borrowedKey).toEqual(new Uint8Array(fixture.vaultKey.length));
    zeroBytes(fixture.vaultKey);
  });

  it('rejects unauthenticated transport metadata that differs from the envelope header', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture);
    const common = encrypted.reads.get(COMMON_DOC_ID)!;
    encrypted.reads.set(COMMON_DOC_ID, {
      envelope: common.envelope,
      header: { ...common.header, docVersion: common.header.docVersion + 1 },
    });
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_SET_CHANGED',
    });

    expect(borrow.state.assertSessionCurrentCalls).toBe(2);
    expect(borrow.state.borrowedKey).toEqual(new Uint8Array(fixture.vaultKey.length));
    zeroBytes(fixture.vaultKey);
  });

  it('rejects a self-consistent document set bound to another authenticated account', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture, {
      accountBindingByKind: {
        header: OTHER_ACCOUNT_BINDING,
        common: OTHER_ACCOUNT_BINDING,
        portfolio: OTHER_ACCOUNT_BINDING,
      },
    });
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_INVALID',
    });

    expect(borrow.state.assertSessionCurrentCalls).toBe(0);
    zeroBytes(fixture.vaultKey);
  });

  it('rejects rows scoped to a different portfolio before erasing document boundaries', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture, {
      mutatePortfolioEntities(entities) {
        const transaction = entities.transaction?.[0];
        if (transaction === undefined) throw new Error('TEST VECTOR transaction is missing.');
        transaction.data = { ...transaction.data, portfolioId: OTHER_PORTFOLIO_ID };
      },
    });
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_INVALID',
    });

    expect(borrow.state.assertSessionCurrentCalls).toBe(4);
    zeroBytes(fixture.vaultKey);
  });

  it('rejects duplicate entity ids within the authenticated split set', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture, {
      mutatePortfolioEntities(entities) {
        const transaction = entities.transaction?.[0];
        if (transaction === undefined) throw new Error('TEST VECTOR transaction is missing.');
        entities.transaction!.push(structuredClone(transaction));
      },
    });
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_INVALID',
    });

    zeroBytes(fixture.vaultKey);
  });

  it('requires the encrypted header roster to equal the current locked-stub roster', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture);
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedVaultDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio, OTHER_PORTFOLIO_ID],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_SET_CHANGED',
    });

    // The mismatch is found before plaintext roster ids drive more network reads.
    expect(borrow.state.assertSessionCurrentCalls).toBe(1);
    zeroBytes(fixture.vaultKey);
  });

  it('requires the same complete roster for a single-portfolio engine read', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture);
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio, OTHER_PORTFOLIO_ID],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_SET_CHANGED',
    });

    // Header plaintext is never accepted as a complete snapshot, so common
    // and portfolio ciphertext are not decrypted into engine rows.
    expect(borrow.state.assertSessionCurrentCalls).toBe(1);
    zeroBytes(fixture.vaultKey);
  });

  it('tolerates a roster extra proven plain-owned and never touches its document (#1528 F1)', async () => {
    // §9's recoverable in-flight state: the capture wrote the roster entry,
    // the step-up-gated commit was refused, and the retry's capture-begin may
    // already have deleted the prospective blob. The reader below REFUSES any
    // read for the extra id, so success also proves the loader never reads,
    // decrypts, or returns a non-member document.
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture, {
      headerRosterExtras: [{ id: OTHER_PORTFOLIO_ID, name: 'In-flight move-in' }],
    });
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    const set = await loadDecryptedVaultDocumentSet({
      vault: encrypted.vault,
      accountId: CLIENT_MONEY_IDS.user,
      expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
      plainOwnedPortfolioIds: [OTHER_PORTFOLIO_ID],
      keys: borrow.keys,
      reader: mapReader(encrypted.reads),
    });
    expect(set.portfolios.map(({ envelope }) => envelope.docId)).toEqual([
      CLIENT_MONEY_IDS.portfolio,
    ]);
    expect(set.header.document.portfolios.map(({ id }) => id)).toEqual([
      CLIENT_MONEY_IDS.portfolio,
      OTHER_PORTFOLIO_ID,
    ]);

    // The single-portfolio loader applies the identical tolerance.
    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
        plainOwnedPortfolioIds: [OTHER_PORTFOLIO_ID],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).resolves.toMatchObject({ portfolioId: CLIENT_MONEY_IDS.portfolio });

    zeroBytes(fixture.vaultKey);
  });

  it('still refuses the same roster extra without plain-owned provenance (#1528 F1 mutation guard)', async () => {
    // Removing the provenance check — tolerating every extra — must turn this
    // red: an extra id that the server-truth listing does not prove to be a
    // currently-plain owned portfolio remains tampering, with the identical
    // pre-tolerance error.
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture, {
      headerRosterExtras: [{ id: OTHER_PORTFOLIO_ID, name: 'In-flight move-in' }],
    });
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    for (const plainOwnedPortfolioIds of [undefined, [] as string[]]) {
      await expect(
        loadDecryptedVaultDocumentSet({
          vault: encrypted.vault,
          accountId: CLIENT_MONEY_IDS.user,
          expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
          plainOwnedPortfolioIds,
          keys: borrow.keys,
          reader: mapReader(encrypted.reads),
        }),
      ).rejects.toMatchObject({
        name: 'PortfolioDocumentSetError',
        code: 'VAULT_DOCUMENT_SET_CHANGED',
        message: 'The encrypted header roster does not match the current locked-stub roster.',
      });
    }

    zeroBytes(fixture.vaultKey);
  });

  it('never lets the tolerance load the in-flight extra itself as a member (#1528 F1)', async () => {
    // Requesting the tolerated extra as the single-portfolio document set must
    // fail: the tolerance widens which roster EXTRAS are survivable, never
    // which portfolios are loadable — a plain portfolio's store is the server.
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture, {
      headerRosterExtras: [{ id: OTHER_PORTFOLIO_ID, name: 'In-flight move-in' }],
    });
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: OTHER_PORTFOLIO_ID,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
        plainOwnedPortfolioIds: [OTHER_PORTFOLIO_ID],
        keys: borrow.keys,
        reader: mapReader(
          new Map([...encrypted.reads, [OTHER_PORTFOLIO_ID, encrypted.reads.get(HEADER_DOC_ID)!]]),
        ),
      }),
    ).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_SET_CHANGED',
    });

    zeroBytes(fixture.vaultKey);
  });

  it('never lets the tolerance excuse an omitted member (#1528 F1)', async () => {
    // The anti-tamper direction stays intact: a stale header that OMITS a
    // member fails even when that id also appears in the plain-owned list —
    // the tolerance only ever widens the roster, never the membership.
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture);
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);

    await expect(
      loadDecryptedVaultDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio, OTHER_PORTFOLIO_ID],
        plainOwnedPortfolioIds: [OTHER_PORTFOLIO_ID],
        keys: borrow.keys,
        reader: mapReader(encrypted.reads),
      }),
    ).rejects.toMatchObject({
      name: 'PortfolioDocumentSetError',
      code: 'VAULT_DOCUMENT_SET_CHANGED',
    });

    zeroBytes(fixture.vaultKey);
  });

  it('observes an abort that races asynchronous document decryption', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture);
    const controller = new AbortController();
    const keys: VaultContentKeyBorrower = {
      async withContentKey(vaultId, operation) {
        if (vaultId !== VAULT_ID) throw new Error(`Unexpected vault borrow ${vaultId}.`);
        const borrowed = fixture.vaultKey.slice();
        try {
          const pending = operation(borrowed, fixture.header.keyId, () => undefined);
          controller.abort();
          return await pending;
        } finally {
          zeroBytes(borrowed);
        }
      },
    };

    await expect(
      loadDecryptedPortfolioDocumentSet({
        vault: encrypted.vault,
        accountId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
        keys,
        reader: mapReader(encrypted.reads),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    zeroBytes(fixture.vaultKey);
  });

  it('uses the full per-doc CAS vector as the split snapshot identity', async () => {
    const fixture = await decryptClientMoneyFixture();
    const encrypted = await encryptSplitFixture(fixture);
    const borrow = trackedBorrower(fixture.vaultKey, fixture.header.keyId);
    const set = await loadDecryptedPortfolioDocumentSet({
      vault: encrypted.vault,
      accountId: CLIENT_MONEY_IDS.user,
      portfolioId: CLIENT_MONEY_IDS.portfolio,
      expectedPortfolioIds: [CLIENT_MONEY_IDS.portfolio],
      keys: borrow.keys,
      reader: mapReader(encrypted.reads),
    });
    const changedCommon = {
      ...set,
      common: {
        ...set.common,
        envelope: { ...set.common.envelope, writeId: OTHER_PORTFOLIO_ID },
      },
    };

    const first = createPortfolioDocumentSetSession(set);
    const second = createPortfolioDocumentSetSession(changedCommon);
    expect(first.validatedSnapshot()).toMatchObject({
      vaultVersion: set.portfolio.envelope.docVersion,
      writeId: set.portfolio.envelope.writeId,
    });
    expect(second.validatedSnapshot()).toMatchObject({
      vaultVersion: set.portfolio.envelope.docVersion,
      writeId: set.portfolio.envelope.writeId,
    });
    expect(second.validatedSnapshot().snapshotId).not.toBe(first.validatedSnapshot().snapshotId);

    first.revoke();
    second.revoke();
    zeroBytes(fixture.vaultKey);
  });
});

type ClientMoneyFixture = Awaited<ReturnType<typeof decryptClientMoneyFixture>>;

interface EncryptedSplitFixture {
  vault: { id: string; headerDocId: string; commonDocId: string };
  reads: Map<string, VaultDocEnvelopeRead>;
}

async function encryptSplitFixture(
  fixture: ClientMoneyFixture,
  options: {
    accountBindingByKind?: Partial<Record<VaultDocKind, string>>;
    mutatePortfolioEntities?: (entities: Record<string, VaultEntity[]>) => void;
    /** Extra header-roster entries WITHOUT a document — §9's in-flight shape. */
    headerRosterExtras?: readonly { id: string; name: string }[];
  } = {},
): Promise<EncryptedSplitFixture> {
  const commonEntities: Record<string, VaultEntity[]> = {};
  const portfolioEntities: Record<string, VaultEntity[]> = {};
  for (const [kind, rows] of Object.entries(fixture.document.entities) as [
    VaultEntityKind,
    VaultEntity[],
  ][]) {
    const target = VAULT_ENTITY_DOC_BUCKETS[kind] === 'common' ? commonEntities : portfolioEntities;
    target[kind] = structuredClone(rows);
  }
  options.mutatePortfolioEntities?.(portfolioEntities);

  const anchorEntity = portfolioEntities.portfolio?.find(
    ({ id }) => id === CLIENT_MONEY_IDS.portfolio,
  );
  if (anchorEntity === undefined) throw new Error('TEST VECTOR portfolio anchor is missing.');
  const anchor = VAULT_ENTITY_ROW_SCHEMAS.portfolio.parse(anchorEntity.data);

  const keySlots = [
    {
      keyId: fixture.header.keyId,
      slot: 'seed-v1' as const,
      wrappedKc: 'VEVTVF9WRUNUT1JfV1JBUFBFRF9LQw',
    },
  ];
  const headerDocument = vaultHeaderDocSchema.parse({
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    name: 'Client money TEST VECTOR vault',
    portfolios: [
      { id: CLIENT_MONEY_IDS.portfolio, name: anchor.name },
      ...(options.headerRosterExtras ?? []),
    ],
    keySlots,
    driveConnection: null,
    created: { at: fixture.header.writtenAt, deviceId: fixture.header.deviceId },
  });
  const commonDocument = vaultCommonDocSchema.parse({
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    entities: commonEntities,
    mergeLog: fixture.document.mergeLog,
    mirrorProvenance: fixture.document.mirrorProvenance ?? [],
    clientSecurity: {
      retirementProof: {
        publicKey: RETIREMENT_PUBLIC_KEY,
        privateKey: RETIREMENT_PRIVATE_KEY,
      },
    },
  });
  const portfolioDocument = vaultPortfolioDocSchema.parse({
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    portfolioId: CLIENT_MONEY_IDS.portfolio,
    entities: portfolioEntities,
    mergeLog: fixture.document.mergeLog,
  });
  const reads = new Map<string, VaultDocEnvelopeRead>();

  await addEncryptedRead(HEADER_DOC_ID, 'header', HEADER_WRITE_ID, headerDocument);
  await addEncryptedRead(COMMON_DOC_ID, 'common', COMMON_WRITE_ID, commonDocument);
  await addEncryptedRead(
    CLIENT_MONEY_IDS.portfolio,
    'portfolio',
    fixture.header.writeId,
    portfolioDocument,
  );

  return {
    vault: { id: VAULT_ID, headerDocId: HEADER_DOC_ID, commonDocId: COMMON_DOC_ID },
    reads,
  };

  async function addEncryptedRead(
    docId: string,
    docKind: VaultDocKind,
    writeId: string,
    document: unknown,
  ): Promise<void> {
    const plaintext = utf8(JSON.stringify(document));
    try {
      const encrypted = await encryptVaultDoc({
        plaintext,
        contentKey: fixture.vaultKey,
        header: {
          keyId: fixture.header.keyId,
          keySlots,
          vaultId: VAULT_ID,
          docId,
          docKind,
          accountBinding: options.accountBindingByKind?.[docKind] ?? ACCOUNT_BINDING,
          docVersion: fixture.header.vaultVersion,
          schemaVersion: VAULT_DOC_SCHEMA_VERSION,
          deviceId: fixture.header.deviceId,
          writeId,
          writtenAt: fixture.header.writtenAt,
        },
      });
      reads.set(docId, encrypted);
    } finally {
      zeroBytes(plaintext);
    }
  }
}

function mapReader(reads: ReadonlyMap<string, VaultDocEnvelopeRead>): VaultDocEnvelopeReader {
  return {
    async read(vaultId, docId) {
      if (vaultId !== VAULT_ID) throw new Error(`Unexpected vault read ${vaultId}.`);
      const read = reads.get(docId);
      if (read === undefined) throw new Error(`Missing TEST VECTOR document ${docId}.`);
      return read;
    },
  };
}

function trackedBorrower(
  sourceKey: Uint8Array,
  keyId: string,
): {
  keys: VaultContentKeyBorrower;
  state: {
    assertSessionCurrentCalls: number;
    borrowedKey: Uint8Array | null;
    usedDistinctKeyCopy: boolean;
  };
} {
  const state = {
    assertSessionCurrentCalls: 0,
    borrowedKey: null as Uint8Array | null,
    usedDistinctKeyCopy: false,
  };
  const keys: VaultContentKeyBorrower = {
    async withContentKey(vaultId, operation) {
      if (vaultId !== VAULT_ID) throw new Error(`Unexpected vault borrow ${vaultId}.`);
      const borrowedKey = sourceKey.slice();
      state.borrowedKey = borrowedKey;
      state.usedDistinctKeyCopy = borrowedKey !== sourceKey;
      try {
        return await operation(borrowedKey, keyId, () => {
          state.assertSessionCurrentCalls += 1;
        });
      } finally {
        zeroBytes(borrowedKey);
      }
    },
  };
  return { keys, state };
}

function exactDecimalJson(value: unknown): string {
  return JSON.stringify(exactDecimalValue(value));
}

function withoutSnapshotId<T extends { snapshotId: string }>(value: T): Omit<T, 'snapshotId'> {
  const { snapshotId: _snapshotId, ...rest } = value;
  return rest;
}

function exactDecimalValue(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Money TEST VECTOR produced a non-finite number.');
    return Object.is(value, -0) ? '0' : value.toString();
  }
  if (Array.isArray(value)) return value.map(exactDecimalValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, exactDecimalValue(child)]),
    );
  }
  return value;
}

function outcomeError(outcome: { ok: boolean; error?: unknown }): string | undefined {
  return outcome.ok ? undefined : JSON.stringify(outcome.error);
}
