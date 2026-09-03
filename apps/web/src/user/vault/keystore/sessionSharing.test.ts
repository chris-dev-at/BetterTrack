import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VAULT_DOC_SCHEMA_VERSION } from '@bettertrack/contracts';

import { utf8, zeroBytes } from '../bytes';
import { encryptVaultDoc } from '../keys/documents';
import {
  deriveAccountBinding,
  deriveKeyFingerprint,
  deriveVaultWrapKey,
  wrapContentKey,
} from '../keys/keyCore';
import { EndpointVaultKeystore } from './core';
import { deriveDeviceKey, verifyEndpointPassword, type DevicePasswordArgon2 } from './deviceCrypto';
import { isEndpointDeviceLocked, rememberEndpointDeviceLocked } from './deviceLock';
import { parseEndpointPasswordMetadata } from './records';
import {
  endpointSessionChannelName,
  importShareableDeviceKey,
  type CreateEndpointSessionTransport,
  type EndpointSessionMessage,
  type EndpointSessionTransport,
} from './sessionChannel';
import {
  createMemoryEndpointSessionPersistence,
  NO_ENDPOINT_SESSION_PERSISTENCE,
  type EndpointSessionPersistence,
} from './sessionPersistence';
import { createIndexedDbEndpointKeystoreStorage, type EndpointKeystoreStorage } from './storage';
import type { EndpointPasswordMetadataV1, FetchVaultHeaderEnvelope } from './types';

/**
 * VAULT-UX-B — §12-conformant cross-tab session sharing.
 *
 * These tests are the reviewer's adversarial probes for PR #1604, carried over
 * to the shape the Chief ruled: K_dev is NEVER persisted, and what makes a
 * second tab work is a live handoff between tabs of one device, not a record on
 * disk. Every probe that was red against the persisted design has an heir here:
 *
 *   P1/P1b (a lock racing an in-flight restore handed the phrase back) → R1/R1b
 *   P3     (the cross-tab storage lock listener)                       → G1
 *   P4     (reset() blocked by failing cleanup)                        → B4
 *   P5     (user A's key restoring into user B's session)              → G5
 *   P6     (the device-locked marker is per account)                   → G3
 *   P7     (a key that does not open this endpoint's wrap-check)       → G6
 *
 * Everything runs over the SAME IndexedDB and the SAME localStorage for every
 * "tab", because that is what a device is.
 */

const VAULT_1 = '018f6a3e-1111-7000-8000-000000000001';
const VAULT_2 = '018f6a3e-1111-7000-8000-000000000002';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000aaaa';
const ACCOUNT_B = '018f6a3e-0000-7000-8000-00000000bbbb';
const PASSWORD = 'endpoint password secret';

/** Public BIP39 TEST VECTOR: 128 zero entropy bits, never production material. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const KEYSTORE_DB = 'bettertrack-session-test-keystore';
/** The database the retired persisted-custody design used. Nothing may recreate it. */
const RETIRED_CUSTODY_DB = 'bettertrack-endpoint-custody-v1';

let storage: EndpointKeystoreStorage;
let bus: TestSessionBus;
let openTabs: EndpointVaultKeystore[] = [];

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  localStorage.clear();
  sessionStorage.clear();
  storage = createIndexedDbEndpointKeystoreStorage({ databaseName: KEYSTORE_DB });
  bus = createTestSessionBus();
  openTabs = [];
});

afterEach(async () => {
  for (const keystore of openTabs) keystore.bindAccount(null);
  vi.restoreAllMocks();
  await deleteDatabase(KEYSTORE_DB);
});

describe('endpoint session sharing (§12: memory-only, endpoint-scoped)', () => {
  it('S1: a tab with no live sibling resumes nothing — a reload re-locks', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    expect(await first.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });

    // THE RELOAD. The tab is gone, and with it the only copy of K_dev.
    closeTab(first);
    const reloaded = tab();

    await expect(reloaded.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
    expect(await reloaded.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    await expect(reloaded.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  it('S2: a second tab joins the live session of the first, with no password', async () => {
    const first = tab();
    await seedWrappedVault(first, VAULT_1);
    await seedWrappedVault(first, VAULT_2);
    await first.unlock(PASSWORD);

    const second = tab();
    await expect(second.resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1, VAULT_2],
    });
    expect(await second.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });
    await expect(second.readMnemonic(VAULT_2)).resolves.toBe(MNEMONIC);
    // …and tab one is untouched by tab two having asked.
    expect(await first.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });
  });

  it('S3: what crosses the channel is a NON-EXTRACTABLE key, and nothing is persisted', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);

    const second = tab();
    await second.resumeSessionFromOpenTabs();

    const grants = bus.sent.filter((message) => message.kind === 'session-grant');
    expect(grants).toHaveLength(1);
    const granted = grants[0]!;
    expect(granted.kind).toBe('session-grant');
    if (granted.kind !== 'session-grant') throw new Error('unreachable');
    expect(granted.deviceKey.extractable).toBe(false);
    expect(granted.deviceKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    // No mnemonic, no entropy, no password, no content key ever leaves a tab.
    expect(JSON.stringify(bus.sent.map(redactKeys))).not.toContain('abandon');

    // §12: nothing is at rest. The retired custody database must not exist, and
    // localStorage may hold only the lock marker — never key material.
    const databases = await indexedDB.databases();
    expect(databases.map((entry) => entry.name)).not.toContain(RETIRED_CUSTODY_DB);
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)!;
      expect(localStorage.getItem(key)).toBe('1');
      expect(key).toContain('endpoint-device-locked');
    }

    // The session dies with the last tab: with both closed, a third resumes nothing.
    closeTab(first);
    closeTab(second);
    const third = tab();
    await expect(third.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
  });

  it('S4: sharing is transitive — a tab that JOINED can hand the session on', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);

    const second = tab();
    await second.resumeSessionFromOpenTabs();
    // The tab that derived K_dev from the password goes away; the device still
    // has a live session, so the endpoint still has one.
    closeTab(first);

    const third = tab();
    await expect(third.resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
    await expect(third.readMnemonic(VAULT_1)).resolves.toBe(MNEMONIC);
  });
});

describe('the race discipline (reviewer finding B2, probes P1/P1b)', () => {
  /**
   * R1. A lock that lands while a grant is still in flight. The generation is
   * minted BEFORE the exchange, so the lock this instance observed is visible to
   * the guard that runs after it. Against the pre-fix ordering this is red.
   */
  it('R1: a lock during an in-flight grant must leave this tab locked', async () => {
    const granter = tab();
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);

    const joining = tab({ grantTimeoutMs: 5_000 });
    bus.holdGrants();
    const resuming = joining.resumeSessionFromOpenTabs();
    await bus.settle();
    // The grant is REAL and already on the wire. Without this the test would
    // assert nothing: a refusal is trivial when nobody ever answered.
    expect(bus.heldGrants(), 'a real grant must be in flight').toBe(1);

    // The user locks — in THIS tab, which is the strongest form: the instance
    // itself knows, and must not install the session it is still waiting for.
    joining.lockDevice();
    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(true);

    bus.releaseGrants();
    await expect(resuming).resolves.toEqual({ unlockedVaultIds: [] });
    expect(bus.sent.some((message) => message.kind === 'session-grant')).toBe(true);
    expect(await joining.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * R1b. The same race asserted from the attacker's side. The reviewer's P1b
   * passed against the persisted design — that PASS was the bug — so this is its
   * inversion: after the lock, the tab must hand back NOTHING.
   */
  it('R1b: the raced resume must not hand back the seed phrase after a lock', async () => {
    const granter = tab();
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);

    const joining = tab({ grantTimeoutMs: 5_000 });
    bus.holdGrants();
    const resuming = joining.resumeSessionFromOpenTabs();
    await bus.settle();
    expect(bus.heldGrants(), 'a real grant must be in flight').toBe(1);
    joining.lockDevice();
    bus.releaseGrants();
    await resuming;

    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(true);
    expect(await joining.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * R1c. The marker's OWN job, isolated. Here the locking tab's broadcast never
   * arrives (a channel this tab cannot hear, a message still in flight), so the
   * session generation is untouched and the marker is the only thing standing
   * between the grant and an installed session.
   *
   * Deleting the post-exchange `isEndpointDeviceLocked` re-check turns this red
   * while every other test in this file stays green.
   */
  it('R1c: a lock this tab never heard about still refuses the grant', async () => {
    const granter = tab();
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);

    const joining = tab({ grantTimeoutMs: 5_000 });
    const generationBefore = sessionGeneration(joining);
    bus.holdGrants();
    const resuming = joining.resumeSessionFromOpenTabs();
    await bus.settle();
    expect(bus.heldGrants(), 'a real grant must be in flight').toBe(1);

    // Another tab of this device locked. Only its synchronous marker write has
    // reached us; nothing has touched this instance.
    rememberEndpointDeviceLocked(ACCOUNT_ID);

    bus.releaseGrants();
    await expect(resuming).resolves.toEqual({ unlockedVaultIds: [] });
    // Proof the generation guard was NOT what refused: nothing bumped it after
    // the resume's own `beginSessionChange`.
    expect(sessionGeneration(joining)).toBe(generationBefore + 1);
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * R1d. The generation guard's OWN job, isolated: the marker cannot be written
   * at all (private mode, a wedged quota), so the only thing between the grant
   * in flight and an installed session is the counter minted before the
   * exchange. Moving `beginSessionChange()` back below the await turns this red.
   */
  it('R1d: a lock whose marker cannot be written still refuses the grant', async () => {
    const granter = tab();
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);

    const joining = tab({ grantTimeoutMs: 5_000 });
    bus.holdGrants();
    const resuming = joining.resumeSessionFromOpenTabs();
    await bus.settle();
    expect(bus.heldGrants(), 'a real grant must be in flight').toBe(1);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    joining.lockDevice();
    expect(isEndpointDeviceLocked(ACCOUNT_ID), 'the marker must be unavailable here').toBe(false);

    bus.releaseGrants();
    await expect(resuming).resolves.toEqual({ unlockedVaultIds: [] });
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * R1e. The LAST guard, isolated. The lock lands after the grant was accepted
   * and the entries were read — inside the window where this tab is holding
   * unwrapped BIP39 entropy and is one assignment away from installing it.
   * Deleting the check immediately above `this.deviceKey = deviceKey` turns this
   * red while R1/R1b/R1c/R1d stay green, because their lock lands earlier.
   */
  it('R1e: a lock landing after the entries are read must still refuse', async () => {
    const granter = tab();
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);

    const race: { keystore: EndpointVaultKeystore | null; snapshots: number } = {
      keystore: null,
      snapshots: 0,
    };
    // The resume reads the snapshot twice: once to get the metadata, once to
    // prove the revision did not move. The lock goes into the second window.
    const racingStorage = decorate(storage, {
      readEndpointSnapshot: (inner) => async () => {
        race.snapshots += 1;
        const snapshot = await inner();
        if (race.snapshots === 2) race.keystore?.lockDevice();
        return snapshot;
      },
    });
    const joining = tab({ grantTimeoutMs: 5_000, storage: racingStorage });
    race.keystore = joining;

    await expect(joining.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
    expect(race.snapshots, 'the race window must actually have been reached').toBeGreaterThan(1);
    expect(await joining.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * R2. The responder's half of the same race: a tab that locks between reading
   * the request and posting its answer must never post the answer.
   */
  it('R2: a tab that locks mid-request must not grant the session it just revoked', async () => {
    const granter = tab();
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);

    const joining = tab({ grantTimeoutMs: 40 });
    const resuming = joining.resumeSessionFromOpenTabs();
    // Deliver the request SYNCHRONOUSLY, so the lock below lands inside the
    // window `grantSession` spends importing the shareable key — it has read
    // "I hold a session" and has not posted anything yet.
    bus.flushSync();
    granter.lockDevice();

    await expect(resuming).resolves.toEqual({ unlockedVaultIds: [] });
    expect(bus.sent.some((message) => message.kind === 'session-grant')).toBe(false);
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  it('R3: a lock revokes the session in EVERY tab of the device', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    const second = tab();
    await second.resumeSessionFromOpenTabs();
    expect(await second.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });

    second.lockDevice();
    await bus.settle();

    expect(await second.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    expect(await first.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    await expect(first.readMnemonic(VAULT_1)).rejects.toThrow();
    // …and it stays locked for a tab opened afterwards.
    const third = tab();
    await expect(third.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
  });
});

describe('the guards that survived unpinned (reviewer finding B5)', () => {
  /** G1 — the reviewer's P3: the account-scoped `storage` lock listener. */
  it('G1: a cross-tab StorageEvent lock revokes this tab', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);

    const target = new EventTarget();
    const release = first.bindToVaultLockSignal(target);
    target.dispatchEvent(
      new StorageEvent('storage', {
        key: `bettertrack:vault-lock:${ACCOUNT_ID}`,
        newValue: '1',
      }),
    );

    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(true);
    expect(await first.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    await expect(first.readMnemonic(VAULT_1)).rejects.toThrow();
    release();
  });

  it("G1b: a StorageEvent for ANOTHER account's lock key is ignored", async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);

    const target = new EventTarget();
    const release = first.bindToVaultLockSignal(target);
    target.dispatchEvent(
      new StorageEvent('storage', {
        key: `bettertrack:vault-lock:${ACCOUNT_B}`,
        newValue: '1',
      }),
    );

    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(false);
    expect(await first.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });
    release();
  });

  /** G2 — the same propagation over the session channel, which is new here. */
  it('G2: a session-lock on the channel revokes this tab without echoing it', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    const second = tab();
    await second.resumeSessionFromOpenTabs();

    bus.sent.length = 0;
    second.lockDevice();
    await bus.settle();

    expect(await first.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    // Exactly ONE lock message on the wire: the receiver must not echo it back.
    expect(bus.sent.filter((message) => message.kind === 'session-lock')).toHaveLength(1);
  });

  /** G3 — the reviewer's P6. */
  it('G3: the device-locked marker is per account', () => {
    localStorage.setItem(`bettertrack:endpoint-device-locked:${ACCOUNT_ID}`, '1');
    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(true);
    expect(isEndpointDeviceLocked(ACCOUNT_B)).toBe(false);
  });

  /** G4 — the marker is read FAIL-CLOSED. An unreadable store means locked. */
  it('G4: a localStorage that throws reads as locked and refuses a live grant', async () => {
    const granter = tab();
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);

    const joining = tab();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    await expect(joining.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * G5c — the keystore's OWN account check on every inbound message
   * (`onSessionMessage`), pinned independently of the channel naming.
   *
   * Today two things keep accounts apart: the channel is named per account, and
   * the keystore re-checks the stamp on what arrives. The first makes the second
   * unreachable through the shipped transport — which is exactly why it needs a
   * test that does NOT go through the shipped transport. If the channel is ever
   * shared, coarsened, or replaced by an adapter that fans out more widely, this
   * check becomes the only account boundary left, and a silent one.
   *
   * So: deliver foreign-account messages straight to the listener the keystore
   * registered, as a shared channel would, and prove all three kinds bounce.
   */
  it('G5c: a message stamped with another account is ignored on every kind', async () => {
    let deliver!: (message: EndpointSessionMessage) => void;
    const captured: CreateEndpointSessionTransport = (_accountId, onMessage) => {
      deliver = onMessage;
      return { post: () => undefined, close: () => undefined };
    };
    const keystore = tab({ transport: captured, grantTimeoutMs: 20 });
    await seedWrappedVault(keystore);
    await keystore.unlock(PASSWORD);
    expect(await keystore.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });

    // (a) A foreign LOCK must not revoke this account's session.
    deliver({ kind: 'session-lock', accountId: ACCOUNT_B });
    await bus.settle();
    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(false);
    expect(await keystore.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });
    await expect(keystore.readMnemonic(VAULT_1)).resolves.toBe(MNEMONIC);

    // (b) A foreign REQUEST must not be answered with this account's session.
    const posted: EndpointSessionMessage[] = [];
    const speaking = tab({
      transport: (_accountId, onMessage) => {
        deliver = onMessage;
        return { post: (message) => posted.push(message), close: () => undefined };
      },
      grantTimeoutMs: 20,
    });
    await speaking.unlock(PASSWORD);
    deliver({ kind: 'session-request', accountId: ACCOUNT_B, requestId: 'foreign-request' });
    await bus.settle();
    expect(posted.some((message) => message.kind === 'session-grant')).toBe(false);

    // (c) A foreign GRANT must not settle a pending request of ours. The resume
    // times out and resolves to nothing rather than installing the stranger.
    const joining = tab({
      transport: (_accountId, onMessage) => {
        deliver = onMessage;
        return { post: () => undefined, close: () => undefined };
      },
      grantTimeoutMs: 60,
    });
    const resuming = joining.resumeSessionFromOpenTabs();
    const foreignKey = await importShareableDeviceKey(new Uint8Array(32).fill(0x5a));
    const requestId = pendingRequestIds(joining)[0];
    expect(requestId, 'the resume must really be waiting on a request').toBeDefined();
    deliver({
      kind: 'session-grant',
      accountId: ACCOUNT_B,
      requestId: requestId!,
      deviceKey: foreignKey,
    });
    await expect(resuming).resolves.toEqual({ unlockedVaultIds: [] });
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * G5 — the reviewer's P5, and the one guard nothing defended before: on a
   * shared browser profile, user A's live session must never reach user B.
   */
  it('G5: user A session must never resume into user B on the same profile', async () => {
    const a = tab();
    await seedWrappedVault(a);
    await a.unlock(PASSWORD);
    expect(await a.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });

    // B signs in on the same profile, over the same IndexedDB and localStorage,
    // while A's tab is still open and still holding a live session.
    const b = tab({ accountId: ACCOUNT_B });
    await expect(b.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
    expect(await b.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    await expect(b.readMnemonic(VAULT_1)).rejects.toThrow();
    // A never even saw a request: the channels are named per account.
    expect(bus.channelNames()).toEqual([
      endpointSessionChannelName(ACCOUNT_ID),
      endpointSessionChannelName(ACCOUNT_B),
    ]);
    expect(bus.sent.some((message) => message.kind === 'session-grant')).toBe(false);
  });

  it('G5b: rebinding to another account revokes the live session', async () => {
    const keystore = tab();
    await seedWrappedVault(keystore);
    await keystore.unlock(PASSWORD);

    keystore.bindAccount(ACCOUNT_B);

    expect(keystore.boundAccountId()).toBe(ACCOUNT_B);
    await expect(keystore.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * G6 — the reviewer's P7, restated for a live grant: the wrap-check is the
   * authority, so a key from a DIFFERENT endpoint password opens nothing here.
   */
  it('G6: a grant that does not open this endpoint wrap-check is refused, unused', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);

    // The refusal has to be the WRAP-CHECK, not "AES-GCM threw three steps
    // later". Counting entry reads is what tells those apart: a verified refusal
    // never reaches the stored phrases at all, whereas a keystore that skipped
    // the check would try to unwrap them with a foreign key.
    let entryReads = 0;
    const countingStorage = decorate(storage, {
      listEntries: (inner) => (revision) => {
        entryReads += 1;
        return inner(revision);
      },
    });
    const joining = tab({ grantTimeoutMs: 5_000, storage: countingStorage });
    // A hostile — or simply stale — same-origin sender answers first with a
    // well-formed, genuinely non-extractable key that is not this endpoint's.
    const impostor = await webcrypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(0xc3),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    bus.answerNextRequestWith(impostor);

    await expect(joining.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
    expect(entryReads, 'a key that fails the wrap-check must never touch a phrase').toBe(0);
    expect(await joining.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  /**
   * G8 — the responder's fail-closed pre-check. Another tab of this device
   * locked and only its synchronous marker has landed here; this tab still holds
   * a live session and must refuse to hand it to anyone.
   */
  it('G8: a tab that has not yet heard the lock must not grant its session', async () => {
    const granter = tab();
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);

    rememberEndpointDeviceLocked(ACCOUNT_ID);
    const joining = tab({ grantTimeoutMs: 40 });

    await expect(joining.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
    expect(bus.sent.some((message) => message.kind === 'session-grant')).toBe(false);
  });

  /**
   * G9 — the non-extractability INVARIANT, not just the outgoing import. A tab
   * accepting an extractable key would re-broadcast it as-is, so exportable
   * K_dev bytes would spread through the origin. Even a CORRECT key is refused
   * when it arrives extractable.
   */
  it('G9: an extractable grant is refused even when the key itself is right', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);

    // The GENUINE K_dev for this endpoint — it opens the wrap-check — but handed
    // over in exportable form. Extractability is therefore the only thing that
    // can refuse it, which is what makes this test isolate that gate.
    const metadata = (await storage.readEndpointSnapshot()).metadata as EndpointPasswordMetadataV1;
    const derived = await deriveDeviceKey(PASSWORD, metadata.kdf, fastArgon2());
    const extractable = await webcrypto.subtle.importKey(
      'raw',
      derived,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt'],
    );
    expect(extractable.extractable).toBe(true);
    await expect(verifyEndpointPassword(metadata, extractable)).resolves.toBe(true);

    const joining = tab({ grantTimeoutMs: 5_000 });
    bus.answerNextRequestWith(extractable);

    await expect(joining.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });
    await expect(joining.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  it('G7: a grant arriving during a password lockout is refused', async () => {
    const now = { value: Date.UTC(2026, 8, 1) };
    const granter = tab({ now: () => now.value });
    await seedWrappedVault(granter);
    await granter.unlock(PASSWORD);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(granter.verifyDevicePassword('definitely wrong password')).rejects.toThrow();
    }

    const joining = tab({ now: () => now.value, grantTimeoutMs: 5_000 });
    await expect(joining.resumeSessionFromOpenTabs()).resolves.toEqual({ unlockedVaultIds: [] });

    // Past the window, the same live sibling is accepted.
    now.value += 60_000;
    const afterLockout = tab({ now: () => now.value, grantTimeoutMs: 5_000 });
    await expect(afterLockout.resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
  });
});

describe('reset (reviewer finding B4)', () => {
  /**
   * B4 — the reviewer's P4. `reset()` is the "I cannot get in any more" escape
   * hatch, so no cleanup may be able to block it. The lock is now synchronous,
   * and even a lock that throws outright must leave the wipe reachable.
   */
  it('B4: reset() wipes the endpoint even when the lock itself throws', async () => {
    // A wedged channel: `post` throws instead of returning. The production
    // transport swallows that, but `reset()` must not DEPEND on it swallowing —
    // that dependency is precisely what the persisted design got wrong, where a
    // failing IndexedDB delete blocked the wipe.
    const keystore = tab({ transport: throwingTransport });
    await seedWrappedVault(keystore);
    await keystore.unlock(PASSWORD);
    expect(() => keystore.lockDevice(), 'the lock must really throw here').toThrow(
      'channel wedged',
    );

    await expect(keystore.reset()).resolves.toMatchObject({ storedPhrases: 'removed' });
    expect(await keystore.stateFor(VAULT_1)).toMatchObject({ status: 'not-on-this-endpoint' });
  });

  it('B4b: a lock whose marker cannot be written still ends the session', async () => {
    const keystore = tab();
    await seedWrappedVault(keystore);
    await keystore.unlock(PASSWORD);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    keystore.lockDevice();
    await expect(keystore.readMnemonic(VAULT_1)).rejects.toThrow();
  });

  it('B4c: a reset revokes the session and every sibling tab with it', async () => {
    const first = tab();
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    const second = tab();
    await second.resumeSessionFromOpenTabs();

    await first.reset();
    await bus.settle();

    await expect(second.readMnemonic(VAULT_1)).rejects.toThrow();
    expect(await second.stateFor(VAULT_1)).toMatchObject({ status: 'not-on-this-endpoint' });
  });
});

// ── harness ─────────────────────────────────────────────────────────────────

describe('endpoint session persistence (§12 as amended by the owner, 2026-09-03)', () => {
  /** A "reload": the old tab simply dies (no lock, no unbind) and a new one boots alone. */
  function reload(persistence: EndpointSessionPersistence, now?: () => number) {
    return tab({ persistence, transport: () => null, ...(now ? { now } : {}) });
  }

  it('P1: an unlocked session survives a reload with no sibling tab, without a password', async () => {
    const persistence = createMemoryEndpointSessionPersistence();
    const first = tab({ persistence, transport: () => null });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    await bus.settle();
    expect(persistence.size()).toBe(1);

    const reloaded = reload(persistence);
    await expect(reloaded.resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
    expect(await reloaded.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });
    await expect(reloaded.readMnemonic(VAULT_1)).resolves.toBe(MNEMONIC);
  });

  it('P2: what is persisted is a NON-EXTRACTABLE key — never bytes, never the password', async () => {
    const persistence = createMemoryEndpointSessionPersistence();
    const persisted: CryptoKey[] = [];
    const spy: EndpointSessionPersistence = {
      persist: async (accountId, key, expiresAt) => {
        persisted.push(key);
        await persistence.persist(accountId, key, expiresAt);
      },
      read: persistence.read,
      clear: persistence.clear,
    };
    const first = tab({ persistence: spy, transport: () => null });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    await bus.settle();
    // The ceremony's first password and the explicit unlock each remember the
    // session; what matters is the SHAPE of every record, not how many.
    expect(persisted.length).toBeGreaterThanOrEqual(1);
    for (const key of persisted) {
      expect(key).toBeInstanceOf(CryptoKey);
      expect(key.extractable).toBe(false);
      expect(key.type).toBe('secret');
    }
  });

  it('P3: a manual lock removes the record, and the §12 marker keeps a stale one inert', async () => {
    const persistence = createMemoryEndpointSessionPersistence();
    const first = tab({ persistence, transport: () => null });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    await bus.settle();

    first.lockDevice();
    await bus.settle();
    expect(persistence.size()).toBe(0);
    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(true);
    await expect(reload(persistence).resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [],
    });

    // A delete that never landed (quota, a crashed tab): the record is still
    // there, but the marker written BEFORE the delete refuses it all the same.
    const stale = tab({ persistence, transport: () => null });
    await stale.unlock(PASSWORD);
    await bus.settle();
    stale.lockDevice();
    await bus.settle();
    const key = await deriveDeviceKey(PASSWORD, (await readMetadata()).kdf, fastArgon2());
    await persistence.persist(
      ACCOUNT_ID,
      await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]),
      Date.now() + 60_000,
    );
    expect(persistence.size()).toBe(1);
    await expect(reload(persistence).resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [],
    });

    // Only the password clears the marker — and then the device remembers again.
    const again = reload(persistence);
    await again.unlock(PASSWORD);
    await bus.settle();
    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(false);
    await expect(reload(persistence).resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
  });

  it('P4: the record expires — a reload past the TTL asks for the password again', async () => {
    const persistence = createMemoryEndpointSessionPersistence();
    let clock = 1_000_000;
    const now = () => clock;
    const first = tab({ persistence, transport: () => null, now, persistenceTtlMs: 10_000 });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    await bus.settle();

    clock += 9_999;
    await expect(reload(persistence, now).resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
    clock += 2;
    await expect(reload(persistence, now).resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [],
    });
    expect(persistence.size()).toBe(0);
  });

  it('P5: switching accounts on the same profile forgets the previous account’s record', async () => {
    const persistence = createMemoryEndpointSessionPersistence();
    const first = tab({ persistence, transport: () => null });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    await bus.settle();
    expect(persistence.size()).toBe(1);

    first.bindAccount(ACCOUNT_B);
    await bus.settle();
    expect(persistence.size()).toBe(0);
    await expect(reload(persistence).resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [],
    });
  });

  it('P6: a session joined from a sibling tab is remembered for this device too', async () => {
    const persistence = createMemoryEndpointSessionPersistence();
    const first = tab({ persistence: NO_ENDPOINT_SESSION_PERSISTENCE });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);

    const second = tab({ persistence });
    await expect(second.resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
    await bus.settle();
    expect(persistence.size()).toBe(1);

    // A tab booting with NO sibling reachable (transport-less) still finds the
    // device record the joined tab wrote, and opens without a password.
    const reloaded = reload(persistence);
    await expect(reloaded.resumeSessionFromOpenTabs()).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
    await expect(reloaded.readMnemonic(VAULT_1)).resolves.toBe(MNEMONIC);
  });

  it('P7: a remote lock arriving on the channel removes the record as well', async () => {
    const persistence = createMemoryEndpointSessionPersistence();
    const first = tab({ persistence });
    await seedWrappedVault(first);
    await first.unlock(PASSWORD);
    await bus.settle();
    expect(persistence.size()).toBe(1);

    const other = tab({ persistence });
    other.lockDevice();
    await bus.settle();
    expect(persistence.size()).toBe(0);
    expect(await first.stateFor(VAULT_1)).toMatchObject({ session: 'locked' });
  });
});

/** The current endpoint password metadata, for tests that derive K_dev themselves. */
async function readMetadata(): Promise<EndpointPasswordMetadataV1> {
  const snapshot = await storage.readEndpointSnapshot();
  return parseEndpointPasswordMetadata(snapshot.metadata);
}

function tab(
  options: {
    accountId?: string;
    grantTimeoutMs?: number;
    now?: () => number;
    storage?: EndpointKeystoreStorage;
    transport?: CreateEndpointSessionTransport;
    /**
     * The device-side session record (§12 as amended 2026-09-03). The sharing
     * and race suites above pin the CHANNEL in isolation, so they run without
     * it; the persistence suite passes its own in-memory store.
     */
    persistence?: EndpointSessionPersistence;
    persistenceTtlMs?: number;
  } = {},
): EndpointVaultKeystore {
  const keystore = new EndpointVaultKeystore({
    storage: options.storage ?? storage,
    argon2: fastArgon2(),
    randomBytes: deterministicRandom(),
    createSessionTransport: options.transport ?? bus.create,
    sessionGrantTimeoutMs: options.grantTimeoutMs ?? 25,
    sessionPersistence: options.persistence ?? NO_ENDPOINT_SESSION_PERSISTENCE,
    ...(options.persistenceTtlMs ? { sessionPersistenceTtlMs: options.persistenceTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  keystore.bindAccount(options.accountId ?? ACCOUNT_ID);
  openTabs.push(keystore);
  return keystore;
}

/** A channel that is wedged: every `post` throws instead of returning. */
const throwingTransport: CreateEndpointSessionTransport = () => ({
  post() {
    throw new Error('channel wedged');
  },
  close() {
    // Nothing to release.
  },
});

/** Wrap one or two storage methods to open a precise race window. */
function decorate(
  inner: EndpointKeystoreStorage,
  overrides: {
    [K in keyof EndpointKeystoreStorage]?: (
      original: EndpointKeystoreStorage[K],
    ) => EndpointKeystoreStorage[K];
  },
): EndpointKeystoreStorage {
  return {
    readEndpointSnapshot:
      overrides.readEndpointSnapshot?.(inner.readEndpointSnapshot.bind(inner)) ??
      inner.readEndpointSnapshot.bind(inner),
    listEntries:
      overrides.listEntries?.(inner.listEntries.bind(inner)) ?? inner.listEntries.bind(inner),
    initializeMetadata: inner.initializeMetadata.bind(inner),
    updateMetadata: inner.updateMetadata.bind(inner),
    readEntry: inner.readEntry.bind(inner),
    writeEntry: inner.writeEntry.bind(inner),
    deleteEntry: inner.deleteEntry.bind(inner),
    reset: inner.reset.bind(inner),
  };
}

/** Closing a tab is what a reload and a window close both are. */
function closeTab(keystore: EndpointVaultKeystore): void {
  keystore.bindAccount(null);
  openTabs = openTabs.filter((open) => open !== keystore);
}

/** Read-only access to the private counter the race guards are built on. */
function sessionGeneration(keystore: EndpointVaultKeystore): number {
  return (keystore as unknown as { sessionGeneration: number }).sessionGeneration;
}

/** The request ids this keystore is currently waiting on a grant for. */
function pendingRequestIds(keystore: EndpointVaultKeystore): string[] {
  return [...(keystore as unknown as { pendingGrants: Map<string, unknown> }).pendingGrants.keys()];
}

interface TestSessionBus {
  create: CreateEndpointSessionTransport;
  /** Every message posted by any tab, in order. */
  sent: EndpointSessionMessage[];
  channelNames(): string[];
  /**
   * Freeze `session-grant` delivery only, so a test can hold a REAL grant in
   * flight — minted by the real granter, already on the wire — and put a lock
   * exactly inside the window before it is installed. Requests and locks keep
   * flowing, which is what makes the held grant real rather than never-issued.
   */
  holdGrants(): void;
  /** How many grants are currently held. A race test with 0 is vacuous. */
  heldGrants(): number;
  /** Deliver everything held, and stop holding. */
  releaseGrants(): void;
  /** Drain what is deliverable right now, synchronously. */
  flushSync(): void;
  settle(): Promise<void>;
  /** Race the real granter with a foreign key, as a hostile sender would. */
  answerNextRequestWith(deviceKey: CryptoKey): void;
}

/**
 * A faithful `BroadcastChannel`: same-origin fan-out to every OTHER subscriber
 * of the same channel name, asynchronous, structured-cloned.
 */
function createTestSessionBus(): TestSessionBus {
  const channels = new Map<string, Set<(message: EndpointSessionMessage) => void>>();
  const sent: EndpointSessionMessage[] = [];
  const pending: (() => void)[] = [];
  const held: (() => void)[] = [];
  let holdingGrants = false;
  let impostor: CryptoKey | null = null;

  const drain = () => {
    while (pending.length > 0) pending.shift()!();
  };

  const enqueue = (message: EndpointSessionMessage, deliver: () => void) => {
    if (holdingGrants && message.kind === 'session-grant') {
      held.push(deliver);
      return;
    }
    pending.push(deliver);
    queueMicrotask(drain);
  };

  const create: CreateEndpointSessionTransport = (accountId, onMessage) => {
    const name = endpointSessionChannelName(accountId);
    const peers = channels.get(name) ?? new Set();
    peers.add(onMessage);
    channels.set(name, peers);
    const transport: EndpointSessionTransport = {
      post(message) {
        sent.push(message);
        if (message.kind === 'session-request' && impostor != null) {
          const deviceKey = impostor;
          impostor = null;
          const forged: EndpointSessionMessage = {
            kind: 'session-grant',
            accountId,
            requestId: message.requestId,
            deviceKey,
          };
          enqueue(forged, () => onMessage(forged));
        }
        for (const peer of [...peers]) {
          if (peer === onMessage) continue;
          // Structured clone, exactly as the platform does it — which is also
          // the proof that a non-extractable CryptoKey survives the crossing.
          const delivered = structuredClone(message);
          enqueue(delivered, () => peer(delivered));
        }
      },
      close() {
        peers.delete(onMessage);
        if (peers.size === 0) channels.delete(name);
      },
    };
    return transport;
  };

  return {
    create,
    sent,
    channelNames: () => [...channels.keys()],
    holdGrants: () => {
      holdingGrants = true;
    },
    heldGrants: () => held.length,
    releaseGrants: () => {
      holdingGrants = false;
      pending.push(...held.splice(0));
      drain();
    },
    flushSync: drain,
    settle: async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    },
    answerNextRequestWith: (deviceKey) => {
      impostor = deviceKey;
    },
  };
}

/** Messages carry a CryptoKey, which JSON cannot see; make that explicit. */
function redactKeys(message: EndpointSessionMessage): unknown {
  return message.kind === 'session-grant'
    ? { ...message, deviceKey: `CryptoKey(extractable=${message.deviceKey.extractable})` }
    : message;
}

async function seedWrappedVault(keystore: EndpointVaultKeystore, vaultId = VAULT_1): Promise<void> {
  await keystore.storeAfterVerifiedOpen({
    vaultId,
    mnemonic: MNEMONIC,
    devicePassword: PASSWORD,
    fetchHeaderEnvelope: verifiedHeaderFetch(vaultId),
  });
}

function fastArgon2(): DevicePasswordArgon2 {
  return async (options) => {
    const input = new Uint8Array(options.password.length + options.salt.length);
    input.set(options.password);
    input.set(options.salt, options.password.length);
    const digest = await webcrypto.subtle.digest('SHA-256', input);
    zeroBytes(input);
    return new Uint8Array(digest);
  };
}

function deterministicRandom(): (length: number) => Uint8Array {
  let next = 1;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = next++ % 256;
    return bytes;
  };
}

function verifiedHeaderFetch(expectedVaultId: string): FetchVaultHeaderEnvelope {
  const envelope = createHeaderEnvelope(expectedVaultId);
  return vi.fn(async ({ vaultId }) => {
    if (vaultId !== expectedVaultId) throw new Error('wrong vault requested');
    return (await envelope).slice();
  });
}

async function createHeaderEnvelope(vaultId: string): Promise<Uint8Array> {
  const contentKey = new Uint8Array(32).fill(0x31);
  const wrapKey = await deriveVaultWrapKey(MNEMONIC, vaultId);
  try {
    const keySlot = await wrapContentKey({
      contentKey,
      wrapKey,
      vaultId,
      keyId: KEY_ID,
      randomBytes: deterministicRandom(),
    });
    await deriveKeyFingerprint(contentKey);
    const encrypted = await encryptVaultDoc({
      plaintext: utf8(
        JSON.stringify({
          schemaVersion: VAULT_DOC_SCHEMA_VERSION,
          name: 'TEST VECTOR vault',
          portfolios: [],
          keySlots: [keySlot],
          driveConnection: null,
          created: { at: '2026-08-20T12:00:00.000Z', deviceId: DEVICE_ID },
        }),
      ),
      contentKey,
      header: {
        keyId: KEY_ID,
        keySlots: [keySlot],
        vaultId,
        docId: DOC_ID,
        docKind: 'header',
        accountBinding: await deriveAccountBinding(ACCOUNT_ID),
        docVersion: 1,
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        writeId: WRITE_ID,
        writtenAt: '2026-08-20T12:00:00.000Z',
      },
      randomBytes: deterministicRandom(),
    });
    return encrypted.envelope;
  } finally {
    zeroBytes(contentKey);
    zeroBytes(wrapKey);
  }
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Deletion of ${databaseName} was blocked.`));
  });
}
