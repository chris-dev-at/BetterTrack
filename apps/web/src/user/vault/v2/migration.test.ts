import type { VaultDocument, VaultEntity, VaultEntityKind } from '@bettertrack/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { decryptVaultBlob } from './blobCrypto';
import { buildVaultHeader } from './headerCrypto';
import { encodeHeaderDoc } from './api';
import {
  claimIsHeldByOther,
  MIGRATION_CLAIM_TTL_MS,
  missingDocs,
  runVaultMigration,
  type LegacyVaultState,
  type MigrationDocRef,
  type MigrationStep,
  type MigrationTransport,
} from './migration';
import {
  deterministicBytes,
  entity,
  fastDeps,
  FIXTURE_DEVICE_ID,
  FIXTURE_PASSPHRASE,
  FIXTURE_PORTFOLIO_A,
  FIXTURE_PORTFOLIO_B,
  FIXTURE_VAULT_ID,
  FIXTURE_WRITE_ID,
  FIXTURE_WRITTEN_AT,
} from './testSupport';

const LEGACY_ID = '3f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a30';
const NOW = new Date('2026-08-08T09:00:00.000Z');

function legacyDocument(): VaultDocument {
  const entities: Partial<Record<VaultEntityKind, VaultEntity[]>> = {
    portfolio: [
      entity(FIXTURE_PORTFOLIO_A, { name: 'Tech' }),
      entity(FIXTURE_PORTFOLIO_B, { name: 'Pension' }),
    ],
    transaction: [
      entity('92222222-2222-4222-8222-222222222222', {
        portfolioId: FIXTURE_PORTFOLIO_A,
        // r2 §11: op clientIds must survive the split verbatim.
        clientId: 'op-abc-123',
      }),
    ],
    taxSetting: [entity('a1111111-1111-4111-8111-111111111112', { mode: 'country' })],
  };
  return { schemaVersion: 1, entities: entities as VaultDocument['entities'], mergeLog: [] };
}

/** An in-memory legacy row + doc store that enforces the same CAS the server does. */
function createTransport(initial: Partial<LegacyVaultState> = {}) {
  const state: LegacyVaultState = {
    claim: null,
    migratedTo: null,
    version: 1,
    ...initial,
  };
  const docs = new Map<string, Uint8Array>();
  const writes: string[] = [];

  const key = (ref: MigrationDocRef) =>
    ref.kind === 'portfolio' ? `portfolio:${ref.portfolioId}` : ref.kind;

  const transport: MigrationTransport = {
    readLegacyState: () => Promise.resolve({ ...state }),
    writeClaim: (_id, claim, ifVersion) => {
      if (ifVersion !== state.version) return Promise.resolve(false);
      state.claim = claim;
      state.version += 1;
      return Promise.resolve(true);
    },
    writeDoc: (_vaultId, ref, bytes) => {
      writes.push(key(ref));
      docs.set(key(ref), bytes);
      return Promise.resolve();
    },
    listDocs: () =>
      Promise.resolve(
        [...docs.keys()].map((entry) =>
          entry.startsWith('portfolio:')
            ? { kind: 'portfolio' as const, portfolioId: entry.slice('portfolio:'.length) }
            : { kind: entry as 'header' | 'common' },
        ),
      ),
    flip: (_id, vaultId, ifVersion) => {
      if (ifVersion !== state.version) return Promise.resolve(false);
      state.migratedTo = vaultId;
      state.version += 1;
      return Promise.resolve(true);
    },
  };

  return { transport, state, docs, writes };
}

async function fixtureHeader() {
  return buildVaultHeader({
    vaultId: FIXTURE_VAULT_ID,
    name: 'My vault',
    backends: 'server',
    passphrase: FIXTURE_PASSPHRASE,
    deviceId: FIXTURE_DEVICE_ID,
    writeId: FIXTURE_WRITE_ID,
    writtenAt: FIXTURE_WRITTEN_AT,
    randomBytes: deterministicBytes(7),
    deps: fastDeps,
  });
}

async function run(
  harness: ReturnType<typeof createTransport>,
  overrides: Partial<Parameters<typeof runVaultMigration>[0]> = {},
) {
  const built = await fixtureHeader();
  return runVaultMigration({
    identity: { legacyVaultId: LEGACY_ID, vaultId: FIXTURE_VAULT_ID },
    document: legacyDocument(),
    header: built.header,
    headerBytes: encodeHeaderDoc(built.header),
    contentKey: built.contentKey,
    transport: harness.transport,
    clientNonce: 'client-1',
    now: () => NOW,
    ...overrides,
  });
}

describe('v1 → v2 migration protocol (r2 §11)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('runs claim → write → verify → flip in order and commits once', async () => {
    const harness = createTransport();
    const steps: MigrationStep[] = [];

    const outcome = await run(harness, { onStep: (step) => steps.push(step) });

    expect(steps).toEqual(['claim', 'write', 'verify', 'flip', 'done']);
    expect(outcome).toMatchObject({ status: 'migrated', vaultId: FIXTURE_VAULT_ID });
    expect(harness.state.migratedTo).toBe(FIXTURE_VAULT_ID);
    expect(harness.state.claim?.migratingBy).toBe('client-1');
    expect([...harness.docs.keys()].sort()).toEqual([
      'common',
      'header',
      `portfolio:${FIXTURE_PORTFOLIO_A}`,
      `portfolio:${FIXTURE_PORTFOLIO_B}`,
    ]);
  });

  it('claims with a renewable 15-minute TTL', async () => {
    const harness = createTransport();
    await run(harness);
    expect(harness.state.claim?.expiresAt).toBe(
      new Date(NOW.getTime() + MIGRATION_CLAIM_TTL_MS).toISOString(),
    );
  });

  it('does nothing when another client already flipped', async () => {
    const harness = createTransport({ migratedTo: FIXTURE_VAULT_ID });
    const outcome = await run(harness);
    expect(outcome).toEqual({ status: 'already-migrated', vaultId: FIXTURE_VAULT_ID });
    expect(harness.docs.size).toBe(0);
  });

  it('waits behind another client’s live claim instead of racing it', async () => {
    const claim = {
      migratingBy: 'other-client',
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    const harness = createTransport({ claim });
    const outcome = await run(harness);
    expect(outcome).toEqual({ status: 'claimed-by-other', claim });
    expect(harness.docs.size).toBe(0);
  });

  it('takes over an expired claim', async () => {
    const harness = createTransport({
      claim: { migratingBy: 'other-client', expiresAt: new Date(NOW.getTime() - 1).toISOString() },
    });
    const outcome = await run(harness);
    expect(outcome).toMatchObject({ status: 'migrated' });
  });

  it('resumes onto the same doc identities with the same plaintext (idempotent)', async () => {
    const built = await fixtureHeader();
    const common = {
      identity: { legacyVaultId: LEGACY_ID, vaultId: FIXTURE_VAULT_ID },
      document: legacyDocument(),
      header: built.header,
      headerBytes: encodeHeaderDoc(built.header),
      contentKey: built.contentKey,
      clientNonce: 'client-1',
      now: () => NOW,
    };

    const first = createTransport();
    await runVaultMigration({ ...common, transport: first.transport });

    // r3 §18: a resumed run writes the SAME identities AND the SAME BYTES. The
    // IV and writer identity are derived from K_c per docId, so two claim
    // holders produce byte-identical envelopes — that is what makes a resumed
    // or racing migration safe, closing mobile A2.1. (Idempotent addressing
    // alone was not enough: random keys/IVs produced mutually undecryptable
    // blobs under one identity.)
    const second = createTransport();
    await runVaultMigration({ ...common, transport: second.transport });

    expect([...second.docs.keys()].sort()).toEqual([...first.docs.keys()].sort());
    for (const [name, bytes] of second.docs) {
      expect(Array.from(bytes)).toEqual(Array.from(first.docs.get(name)!));
      if (name === 'header') continue;
      const resumed = await decryptVaultBlob(bytes, built.contentKey);
      const original = await decryptVaultBlob(first.docs.get(name)!, built.contentKey);
      expect(resumed.document).toEqual(original.document);
    }
  });

  it('refuses to flip when a doc did not land, leaving v1 authoritative', async () => {
    const harness = createTransport();
    const original = harness.transport.writeDoc;
    harness.transport.writeDoc = (vaultId, ref, bytes) =>
      ref.kind === 'portfolio' && ref.portfolioId === FIXTURE_PORTFOLIO_B
        ? Promise.resolve()
        : original(vaultId, ref, bytes);

    await expect(run(harness)).rejects.toThrowError(/incomplete/u);
    expect(harness.state.migratedTo).toBeNull();
  });

  it('reports already-migrated when it loses the flip race', async () => {
    const harness = createTransport();
    harness.transport.flip = () => Promise.resolve(false);
    const readLegacy = harness.transport.readLegacyState;
    let reads = 0;
    harness.transport.readLegacyState = async (id) => {
      reads += 1;
      const state = await readLegacy(id);
      // The winner flipped between our verify and our flip.
      return reads > 1 ? { ...state, migratedTo: FIXTURE_VAULT_ID } : state;
    };
    await expect(run(harness)).resolves.toEqual({
      status: 'already-migrated',
      vaultId: FIXTURE_VAULT_ID,
    });
  });

  it('preserves op clientIds verbatim into the split docs (r2 §11)', async () => {
    const harness = createTransport();
    const built = await fixtureHeader();
    await runVaultMigration({
      identity: { legacyVaultId: LEGACY_ID, vaultId: FIXTURE_VAULT_ID },
      document: legacyDocument(),
      header: built.header,
      headerBytes: encodeHeaderDoc(built.header),
      contentKey: built.contentKey,
      transport: harness.transport,
      clientNonce: 'client-1',
      now: () => NOW,
    });

    const blob = harness.docs.get(`portfolio:${FIXTURE_PORTFOLIO_A}`)!;
    const { document } = await decryptVaultBlob(blob, built.contentKey);
    if (document.docKind !== 'portfolio') throw new Error('expected a portfolio doc');
    expect(document.entities.transaction?.[0]?.data.clientId).toBe('op-abc-123');
  });

  it('routes vault-scoped rows to the common doc', async () => {
    const harness = createTransport();
    const built = await fixtureHeader();
    await runVaultMigration({
      identity: { legacyVaultId: LEGACY_ID, vaultId: FIXTURE_VAULT_ID },
      document: legacyDocument(),
      header: built.header,
      headerBytes: encodeHeaderDoc(built.header),
      contentKey: built.contentKey,
      transport: harness.transport,
      clientNonce: 'client-1',
      now: () => NOW,
    });
    const { document } = await decryptVaultBlob(harness.docs.get('common')!, built.contentKey);
    expect(document.docKind).toBe('common');
    if (document.docKind !== 'common') return;
    expect(document.entities.taxSetting).toHaveLength(1);
  });
});

describe('migration helpers', () => {
  it('treats only a live foreign claim as blocking', () => {
    const live = { migratingBy: 'other', expiresAt: new Date(NOW.getTime() + 1000).toISOString() };
    const expired = { migratingBy: 'other', expiresAt: new Date(NOW.getTime() - 1).toISOString() };
    const base = { migratedTo: null, version: 1 };

    expect(claimIsHeldByOther({ ...base, claim: live }, 'me', NOW)).toBe(true);
    expect(claimIsHeldByOther({ ...base, claim: expired }, 'me', NOW)).toBe(false);
    expect(claimIsHeldByOther({ ...base, claim: null }, 'me', NOW)).toBe(false);
    expect(claimIsHeldByOther({ ...base, claim: { ...live, migratingBy: 'me' } }, 'me', NOW)).toBe(
      false,
    );
  });

  it('names every doc the verify step is still waiting for', () => {
    expect(missingDocs([{ kind: 'header' }], [FIXTURE_PORTFOLIO_A])).toEqual([
      { kind: 'common' },
      { kind: 'portfolio', portfolioId: FIXTURE_PORTFOLIO_A },
    ]);
    expect(
      missingDocs(
        [
          { kind: 'header' },
          { kind: 'common' },
          { kind: 'portfolio', portfolioId: FIXTURE_PORTFOLIO_A },
        ],
        [FIXTURE_PORTFOLIO_A],
      ),
    ).toEqual([]);
  });
});
