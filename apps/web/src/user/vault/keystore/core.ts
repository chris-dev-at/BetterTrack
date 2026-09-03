import { vaultIdParamSchema } from '@bettertrack/contracts';

import { equalBytes, zeroBytes } from '../bytes';
import { type RandomBytes, secureRandomBytes } from '../crypto';
import { entropyToMnemonic, mnemonicToEntropy } from '../bip39/mnemonic';
import { openVaultHeaderWithMnemonic, type VerifiedVaultHeaderOpen } from '../keys/documents';
import { VAULT_LOCK_REQUEST_EVENT, vaultLockSignalStorageKey } from '../lockSignal';
import {
  consumePlainCustodyAcknowledgment,
  invalidatePlainCustodyAcknowledgments,
} from './acknowledgment';
import {
  createEndpointPassword,
  deriveDeviceKey,
  unwrapMnemonicEntropy,
  verifyEndpointPassword,
  wrapMnemonicEntropy,
  type DevicePasswordArgon2,
} from './deviceCrypto';
import {
  forgetEndpointDeviceLocked,
  isEndpointDeviceLocked,
  rememberEndpointDeviceLocked,
  type EndpointDeviceKeyMaterial,
} from './deviceLock';
import {
  createBroadcastEndpointSessionTransport,
  importShareableDeviceKey,
  isShareableDeviceKey,
  type CreateEndpointSessionTransport,
  type EndpointSessionMessage,
  type EndpointSessionTransport,
} from './sessionChannel';
import { decodeBase64Url, encodeBase64Url } from './encoding';
import { EndpointKeystoreError } from './errors';
import { parseEndpointPasswordMetadata, parseStoredPhraseEntry } from './records';
import {
  createIndexedDbEndpointSessionPersistence,
  ENDPOINT_SESSION_PERSISTENCE_TTL_MS,
  type EndpointSessionPersistence,
} from './sessionPersistence';
import { createIndexedDbEndpointKeystoreStorage, type EndpointKeystoreStorage } from './storage';
import {
  ENDPOINT_KEYSTORE_VERSION,
  type EndpointPasswordMetadataV1,
  type EndpointUnlockResult,
  type EndpointVaultState,
  type FetchVaultHeaderEnvelope,
  type KeystoreResetResult,
  type OpenedVault,
  type PlainCustodyAcknowledgmentToken,
  type StorePlainPhraseInput,
  type StoreWrappedPhraseInput,
  type StoredPhraseEntry,
} from './types';

const LOCKOUT_FIRST_FAILURE = 5;
const LOCKOUT_INITIAL_MS = 30_000;
const LOCKOUT_MAX_MS = 300_000;
/**
 * How long a fresh tab waits for a sibling to answer with its live session.
 *
 * Every first endpoint-state read blocks on this, so it is a first-paint budget,
 * not a network timeout: a live tab answers within a task plus one `importKey`.
 * A device with no other tab open pays it once and then paints the prompt — the
 * ordering that matters, because painting "Unlock" and correcting it a moment
 * later is the flicker this whole seam exists to avoid.
 */
const SESSION_GRANT_TIMEOUT_MS = 300;

interface CachedContentKey {
  keyId: string;
  keyFingerprint: OpenedVault['keyFingerprint'];
  bytes: Uint8Array;
}

interface StoredMnemonicRead {
  mnemonic: string;
  revision: number;
}

interface RecordedPasswordFailure {
  revision: number;
  failures: number;
  lockedUntil: number | null;
}

export interface EndpointVaultKeystoreOptions {
  storage?: EndpointKeystoreStorage;
  argon2?: DevicePasswordArgon2;
  randomBytes?: RandomBytes;
  now?: () => number;
  /**
   * How this keystore reaches the account's other tabs. Absent (or returning
   * null) ⇒ no sharing, and every tab asks for the password on its own — the
   * behaviour of a browser without `BroadcastChannel`, and the fallback that
   * makes sharing an optimization rather than a dependency.
   */
  createSessionTransport?: CreateEndpointSessionTransport;
  /** First-paint budget for a sibling tab's answer. */
  sessionGrantTimeoutMs?: number;
  /** Correlation id for one request/grant pair. Not a secret; must be unique. */
  newRequestId?: () => string;
  /**
   * Where a live session outlives the tab (§12 as amended 2026-09-03, see
   * `sessionPersistence.ts`). Absent ⇒ IndexedDB; pass
   * `NO_ENDPOINT_SESSION_PERSISTENCE` for the memory-only behaviour.
   */
  sessionPersistence?: EndpointSessionPersistence;
  /** Absolute lifetime of a persisted session. */
  sessionPersistenceTtlMs?: number;
}

/**
 * Headless E3 endpoint keystore. The device password, mnemonic entropy and
 * every K_c are held only by this object, in volatile memory, and are
 * synchronously zeroed when the session ends (`docs/paranoid-design.md` §12).
 * Nothing in this class writes a password, a phrase, entropy or a content key
 * to IndexedDB, localStorage, sessionStorage, a cookie or a log.
 *
 * A session is scoped to the ENDPOINT, not to the tab: `sessionChannel.ts`
 * hands the live session to the account's other same-origin tabs over
 * `BroadcastChannel`, and — since the owner's 2026-09-03 amendment to §12 —
 * `sessionPersistence.ts` keeps K_dev as a NON-EXTRACTABLE `CryptoKey` on the
 * device for a bounded time, so a reload, an OAuth round-trip or a closed tab
 * no longer ends the session. Every user-intended lock (manual, sign-out, PIN
 * idle, account switch) writes the §12 marker first and then removes that
 * record; the marker alone keeps a persisted key inert until the next password.
 */
export class EndpointVaultKeystore {
  private readonly storage: EndpointKeystoreStorage;
  private readonly argon2: DevicePasswordArgon2 | undefined;
  private readonly randomBytes: RandomBytes;
  private readonly now: () => number;
  private readonly createSessionTransport: CreateEndpointSessionTransport;
  private readonly sessionGrantTimeoutMs: number;
  private readonly newRequestId: () => string;
  /** The account this endpoint session belongs to; null ⇒ nobody is signed in. */
  private accountId: string | null = null;
  private transport: EndpointSessionTransport | null = null;
  /** Grants in flight, keyed by the request id each one answers. */
  private readonly pendingGrants = new Map<string, (deviceKey: CryptoKey | null) => void>();
  /** One resume per tab at a time; concurrent callers share its outcome. */
  private sessionResume: Promise<EndpointUnlockResult> | null = null;
  private deviceKey: EndpointDeviceKeyMaterial | null = null;
  private devicePasswordMetadata: EndpointPasswordMetadataV1 | null = null;
  private readonly wrappedEntropy = new Map<string, Uint8Array>();
  private readonly contentKeys = new Map<string, CachedContentKey>();
  private readonly activeContentKeyBorrows = new Set<Uint8Array>();
  private readonly sessionEndListeners = new Set<() => void>();
  private readonly vaultOpenedListeners = new Set<(vaultId: string) => void>();
  private sessionGeneration = 0;
  private sessionRevision: number | null = null;
  private readonly sessionPersistence: EndpointSessionPersistence;
  private readonly sessionPersistenceTtlMs: number;

  constructor(options: EndpointVaultKeystoreOptions = {}) {
    this.storage = options.storage ?? createIndexedDbEndpointKeystoreStorage();
    this.sessionPersistence =
      options.sessionPersistence ?? createIndexedDbEndpointSessionPersistence();
    this.sessionPersistenceTtlMs =
      options.sessionPersistenceTtlMs ?? ENDPOINT_SESSION_PERSISTENCE_TTL_MS;
    this.argon2 = options.argon2;
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.now = options.now ?? Date.now;
    this.createSessionTransport =
      options.createSessionTransport ?? createBroadcastEndpointSessionTransport;
    this.sessionGrantTimeoutMs = options.sessionGrantTimeoutMs ?? SESSION_GRANT_TIMEOUT_MS;
    this.newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID());
  }

  /**
   * Bind (or release) the account this endpoint session belongs to, and with it
   * the channel the session may be shared on.
   *
   * PER-ACCOUNT SCOPING IS A SECURITY BOUNDARY, not bookkeeping. Two accounts
   * sharing one browser profile share one origin, one IndexedDB and one
   * localStorage; the only thing that keeps A's live session out of B's tab is
   * that B never listens on A's channel and never accepts a grant stamped with
   * A's id. So: one channel per account, the id is re-checked after every await
   * in the resume, and a CHANGE of account is a revocation — the live session
   * was proven by the previous account's password and cannot carry into the
   * next one. The first bind of a tab is not a change (nothing is live) and
   * must not fire a spurious session end at every mount.
   */
  bindAccount(accountId: string | null): void {
    const next = accountId?.trim() || null;
    if (this.accountId === next) return;
    const previous = this.accountId;
    const hadAccount = previous !== null;
    this.closeSessionTransport();
    this.accountId = next;
    this.sessionResume = null;
    if (hadAccount) {
      this.endSession();
      // An account switch is a revocation (see above), and since §12's 2026-09-03
      // amendment a session also lives on the device — so the previous account's
      // record goes with it, or signing back in would reopen without a password.
      if (previous != null) this.forgetPersistedSession(previous);
    }
    if (next != null) {
      this.transport = this.createSessionTransport(next, (message) =>
        this.onSessionMessage(message),
      );
    }
  }

  /** The account currently bound, for surfaces that must not guess it. */
  boundAccountId(): string | null {
    return this.accountId;
  }

  async stateFor(vaultId: string): Promise<EndpointVaultState> {
    requireVaultId(vaultId);
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    try {
      const entries = stable.entries.map((record) =>
        parseStoredPhraseEntry(record.value, record.vaultId),
      );
      const metadata =
        stable.metadata == null ? null : parseEndpointPasswordMetadata(stable.metadata);
      if (metadata == null && entries.some((entry) => entry.custody === 'wrapped')) {
        return invalidEndpointState();
      }
      const entry = entries.find((candidate) => candidate.vaultId === vaultId);
      if (entry == null) {
        return {
          status: 'not-on-this-endpoint',
          requiredAction: {
            kind: 'provide-phrase',
            methods: ['enter-words', 'scan-qr'],
          },
        };
      }
      if (entry.custody === 'plain') {
        return { status: 'stored+plain', requiredAction: { kind: 'open-silently' } };
      }
      if (metadata == null) return invalidEndpointState();
      if (metadata.lockout.lockedUntil != null && metadata.lockout.lockedUntil > this.now()) {
        return {
          status: 'stored+wrapped',
          session: 'locked',
          requiredAction: {
            kind: 'wait-or-reset',
            retryAt: metadata.lockout.lockedUntil,
            alternative: 'reset-endpoint-keystore',
          },
        };
      }
      const sessionMatches =
        this.deviceKey != null &&
        this.devicePasswordMetadata != null &&
        this.sessionRevision === stable.revision &&
        sameEndpointPassword(metadata, this.devicePasswordMetadata) &&
        this.wrappedEntropy.has(vaultId);
      if (this.deviceKey != null && !sessionMatches) this.endSession();
      return sessionMatches
        ? {
            status: 'stored+wrapped',
            session: 'unlocked',
            requiredAction: { kind: 'open-silently' },
          }
        : {
            status: 'stored+wrapped',
            session: 'locked',
            requiredAction: { kind: 'unlock', credential: 'device-password' },
          };
    } catch (cause) {
      if (cause instanceof EndpointKeystoreError && cause.code === 'storage-invalid') {
        return invalidEndpointState();
      }
      throw cause;
    }
  }

  /**
   * The device password, once per endpoint session (§12). There is no
   * "keep unlocked on this device" option and there is no persisted key: what
   * this establishes lives in memory and is shared with the account's other
   * tabs over `sessionChannel.ts` for as long as one of them is open.
   */
  async unlock(devicePassword: string): Promise<EndpointUnlockResult> {
    const accountId = this.accountId;
    const generation = this.beginSessionChange();
    const snapshot = await this.storage.readEndpointSnapshot();
    if (snapshot.metadata == null) {
      throw new EndpointKeystoreError(
        'device-password-not-configured',
        'This endpoint has no device password.',
      );
    }
    const metadata = parseEndpointPasswordMetadata(snapshot.metadata);
    this.assertNotLockedOut(metadata);
    let candidate: Uint8Array | undefined;
    const entropy = new Map<string, Uint8Array>();
    try {
      candidate = await deriveDeviceKey(devicePassword, metadata.kdf, this.argon2);
      this.requireCurrentGeneration(generation);
      if (!(await verifyEndpointPassword(metadata, candidate))) {
        await this.recordWrongPassword(metadata, snapshot.revision);
      }
      this.requireCurrentGeneration(generation);
      const resetRevision = await this.resetPasswordLockout(metadata, snapshot.revision);
      const listed = await this.storage.listEntries(resetRevision);
      if (listed.status === 'stale') {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint keystore changed during password verification.',
        );
      }
      for (const record of listed.entries) {
        const entry = parseStoredPhraseEntry(record.value, record.vaultId);
        if (entry.custody === 'wrapped') {
          if (entropy.has(entry.vaultId)) {
            throw new EndpointKeystoreError(
              'storage-invalid',
              'Endpoint keystore contains duplicate vault entries.',
            );
          }
          entropy.set(
            entry.vaultId,
            await unwrapMnemonicEntropy(entry.vaultId, entry.payload, candidate),
          );
        }
      }
      const finalSnapshot = await this.storage.readEndpointSnapshot();
      if (
        finalSnapshot.revision !== listed.revision ||
        finalSnapshot.metadata == null ||
        !sameEndpointPassword(parseEndpointPasswordMetadata(finalSnapshot.metadata), metadata)
      ) {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint keystore changed while stored phrases were being unlocked.',
        );
      }
      this.requireCurrentGeneration(generation);
      this.deviceKey = candidate;
      this.devicePasswordMetadata = metadata;
      this.sessionRevision = listed.revision;
      candidate = undefined;
      for (const [vaultId, bytes] of entropy) this.wrappedEntropy.set(vaultId, bytes);
      entropy.clear();
      // The §12 marker's ONLY clearing edge. The user just proved the device
      // password, so "the last deliberate act on this device was a lock" has
      // stopped being true and sibling tabs may share this session again.
      if (accountId != null) {
        forgetEndpointDeviceLocked(accountId);
        this.rememberSession(accountId, this.deviceKey);
      }
      const unlockedVaultIds = [...this.wrappedEntropy.keys()].sort();
      // Tell the store resolver, so an unlock is enough on its own.
      //
      // Until now only `openStoredVault` raised this edge, so every caller had
      // to follow `unlock()` with an open of its own to make the page resolve —
      // which the settings manager does and a surface holding nothing but a
      // vault id (the locked stub, the switcher, the shield chip) cannot. Every
      // id here is a real transition: `beginSessionChange` cleared the session
      // at the top of this method.
      this.notifyVaultsAvailable(unlockedVaultIds);
      return { unlockedVaultIds };
    } catch (cause) {
      if (this.sessionGeneration === generation) this.clearSessionSecrets();
      throw cause;
    } finally {
      if (candidate != null) zeroBytes(candidate);
      for (const bytes of entropy.values()) zeroBytes(bytes);
    }
  }

  /**
   * Join the session the account's other tabs already hold — the second-tab and
   * reload-beside-a-sibling path.
   *
   * Speculative and silent by design: every refusal (no account, no transport,
   * nobody answering, the §12 marker, an active lockout, a grant that does not
   * open this endpoint's wrap-check) resolves to "nothing restored" and leaves
   * the surface asking for the password, which is what it would have done
   * anyway. It never throws at a caller who merely wanted to read state.
   */
  async resumeSessionFromOpenTabs(): Promise<EndpointUnlockResult> {
    if (this.deviceKey != null) {
      return { unlockedVaultIds: [...this.wrappedEntropy.keys()].sort() };
    }
    // Deferred by one microtask so `this.sessionResume` is ASSIGNED before the
    // resume body runs: a re-entrant caller inside that body (a synchronous
    // query re-run, see `runSessionResume`) must find the in-flight promise and
    // share it, never start a second resume.
    this.sessionResume ??= Promise.resolve()
      .then(() => this.runSessionResume())
      .catch(() => ({ unlockedVaultIds: [] }) as EndpointUnlockResult)
      .finally(() => {
        this.sessionResume = null;
      });
    return this.sessionResume;
  }

  /**
   * ── THE RACE DISCIPLINE (reviewer finding B2, probe P1b) ──────────────────
   *
   * The first shape of this method read its refusal signals BEFORE it minted a
   * generation guard, so a lock landing during the async exchange was invisible
   * to the guard and the resumed session handed back the seed phrase AFTER
   * revocation. The order below is the fix and is load-bearing:
   *
   *   1. read the §12 marker and mint the generation with NO await between
   *      them, so nothing can interleave;
   *   2. re-check the generation, the account AND the marker after the exchange;
   *   3. check all three once more IMMEDIATELY before the session is installed,
   *      with no await in between.
   *
   * `lockDevice` bumps the generation synchronously, so any lock this instance
   * observed fails step 2 or 3. The marker is the independent backstop for a
   * lock this instance has NOT yet observed — the message is still in flight —
   * because whichever tab locked wrote it before its own first await.
   */
  private async runSessionResume(): Promise<EndpointUnlockResult> {
    const nothing: EndpointUnlockResult = { unlockedVaultIds: [] };
    const accountId = this.accountId;
    const transport = this.transport;
    if (accountId == null) return nothing;
    // (1) Fail closed, then arm the guard. Both statements are synchronous.
    if (isEndpointDeviceLocked(accountId)) return nothing;
    // SNAPSHOT the guard; do not mint one, and do not announce a session end.
    // There is no session to end here (`deviceKey` is null by construction at
    // entry, see the caller), and both alternatives are hazards:
    //   • `beginSessionChange()` (the first shape) notified a session end from
    //     inside a resume. The runtime's listener drops its resume memo, the
    //     shell invalidates the endpoint-state queries in the same tick,
    //     TanStack re-runs a query that already has data SYNCHRONOUSLY, its
    //     queryFn asks for a resume again — and lands back here before
    //     `sessionResume` was assigned: 300+ nested resumes (review of #1707).
    //     Its `clearSessionSecrets()` also wiped plain-custody content keys a
    //     resume has no business touching.
    //   • Bumping the generation silently cancels a concurrent `unlock()` — the
    //     user typed the password, a speculative resume raced it, and the
    //     unlock died with "cancelled".
    // A snapshot is enough: any lock OR unlock that lands during this resume
    // bumps the generation itself, and `sessionStillCurrent` below then refuses
    // to install — the lock keeps the device locked, the unlock keeps its own
    // session. A resume never has to win a race.
    const generation = this.sessionGeneration;

    // A sibling tab answers first (fast, and it proves the session is live on
    // this device right now); with no sibling — or no channel at all — the
    // device's persisted record (§12 as amended 2026-09-03) is the second
    // source. Both go through the SAME verification below: neither is trusted
    // for more than "a candidate".
    const granted = transport == null ? null : await this.requestSessionGrant(transport, accountId);
    if (!this.sessionStillCurrent(generation, accountId)) return nothing;
    const deviceKey =
      granted ?? (await this.sessionPersistence.read(accountId, this.now()).catch(() => null));
    if (deviceKey == null) return nothing;
    // The transport validates too, but a keystore that trusts its transport to
    // police key SHAPE would re-broadcast whatever it was handed: `grantSession`
    // passes an already-shareable key straight on. An extractable key must never
    // become this endpoint's K_dev, or the origin gains exportable K_dev bytes.
    if (!isShareableDeviceKey(deviceKey)) return nothing;
    // (2) The exchange is over. Fail fast so a revoked session never reaches the
    // decryption below. Redundant with (3), which is the boundary that counts.
    if (!this.sessionStillCurrent(generation, accountId)) return nothing;

    const snapshot = await this.storage.readEndpointSnapshot();
    if (!this.sessionStillCurrent(generation, accountId)) return nothing;
    // No metadata means this endpoint was reset. A grant from a tab that has not
    // noticed yet opens nothing here.
    if (snapshot.metadata == null) return nothing;
    const metadata = parseEndpointPasswordMetadata(snapshot.metadata);
    // A lockout is about the PASSWORD and a granted session is not a password
    // guess — but refusing keeps ONE rule for "this endpoint is not accepting
    // device-password sessions right now", at the cost of the lockout window.
    if (metadata.lockout.lockedUntil != null && metadata.lockout.lockedUntil > this.now()) {
      return nothing;
    }
    // THE AUTHORITATIVE BINDING, and the reason a hostile grant is harmless:
    // the wrap-check is the same AES-GCM open `unlock` performs, so a key that
    // was not derived from THIS endpoint's device password cannot pass it.
    if (!(await verifyEndpointPassword(metadata, deviceKey))) return nothing;
    if (!this.sessionStillCurrent(generation, accountId)) return nothing;

    const listed = await this.storage.listEntries(snapshot.revision);
    if (listed.status === 'stale') return nothing;
    const entropy = new Map<string, Uint8Array>();
    try {
      for (const record of listed.entries) {
        const entry = parseStoredPhraseEntry(record.value, record.vaultId);
        if (entry.custody !== 'wrapped') continue;
        if (entropy.has(entry.vaultId)) {
          throw new EndpointKeystoreError(
            'storage-invalid',
            'Endpoint keystore contains duplicate vault entries.',
          );
        }
        entropy.set(
          entry.vaultId,
          await unwrapMnemonicEntropy(entry.vaultId, entry.payload, deviceKey),
        );
      }
      const finalSnapshot = await this.storage.readEndpointSnapshot();
      if (
        finalSnapshot.revision !== listed.revision ||
        finalSnapshot.metadata == null ||
        !sameEndpointPassword(parseEndpointPasswordMetadata(finalSnapshot.metadata), metadata)
      ) {
        return nothing;
      }
      // (3) Last word before the session exists. Nothing may await past here.
      if (!this.sessionStillCurrent(generation, accountId)) return nothing;
      this.deviceKey = deviceKey;
      this.devicePasswordMetadata = metadata;
      this.sessionRevision = listed.revision;
      for (const [vaultId, bytes] of entropy) this.wrappedEntropy.set(vaultId, bytes);
      entropy.clear();
      // A session granted by a sibling tab is now this device's session too, so
      // it must survive this tab being the last one left — but only when the
      // device holds no record yet. Re-persisting on every grant would restart
      // the clock, and the TTL is ABSOLUTE from the unlock that created the
      // session (§12); the re-check is one IDB read, off the critical path.
      if (granted != null) {
        void this.sessionPersistence
          .read(accountId, this.now())
          .then((existing) => {
            if (existing == null && this.sessionStillCurrent(generation, accountId)) {
              this.rememberSession(accountId, deviceKey);
            }
          })
          .catch(() => undefined);
      }
      const unlockedVaultIds = [...this.wrappedEntropy.keys()].sort();
      // The edge #1531/#1533 already built for exactly this question. A resolver
      // that finished against the locked endpoint milliseconds ago has published
      // stubs; without this ping nothing would ever tell it otherwise, and the
      // user would stare at a locked portfolio they never locked.
      this.notifyVaultsAvailable(unlockedVaultIds);
      return { unlockedVaultIds };
    } finally {
      for (const bytes of entropy.values()) zeroBytes(bytes);
    }
  }

  /**
   * All three revocation signals, read together. Called after every await in the
   * resume, and once more with nothing awaited between it and the assignment.
   *
   * The generation and the marker are independently load-bearing and each has a
   * test that isolates it. The ACCOUNT term is deliberate redundancy: today
   * `bindAccount` already ends the session and settles every pending grant with
   * null, so no mutation of this clause alone can be observed — it is here so
   * that a future change to `bindAccount` cannot silently open the boundary. The
   * per-account boundary that IS observable, and pinned, is the channel name.
   */
  private sessionStillCurrent(generation: number, accountId: string): boolean {
    return (
      this.sessionGeneration === generation &&
      this.accountId === accountId &&
      !isEndpointDeviceLocked(accountId)
    );
  }

  private requestSessionGrant(
    transport: EndpointSessionTransport,
    accountId: string,
  ): Promise<CryptoKey | null> {
    const requestId = this.newRequestId();
    return new Promise<CryptoKey | null>((resolve) => {
      // A device with no other tab open is the ORDINARY case, so the timeout is
      // the normal exit from here, not an error path. It settles THROUGH the
      // pending map rather than through a captured closure, which keeps the
      // "first answer wins" rule in exactly one place.
      const timer = setTimeout(
        () => this.pendingGrants.get(requestId)?.(null),
        this.sessionGrantTimeoutMs,
      );
      this.pendingGrants.set(requestId, (deviceKey) => {
        // A second grant for the same request id is dropped, not installed.
        if (!this.pendingGrants.delete(requestId)) return;
        clearTimeout(timer);
        resolve(deviceKey);
      });
      transport.post({ kind: 'session-request', accountId, requestId });
    });
  }

  /**
   * The other side of the exchange. Note that it carries the SAME race
   * discipline as the resume: a lock landing between "I hold a session" and
   * "I posted it" must cancel the grant, or a locking tab would hand its
   * revoked session to a tab that asked a moment earlier.
   */
  private async grantSession(requestId: string, accountId: string): Promise<void> {
    // Fail fast. Redundant with the `sessionStillCurrent` call below, which
    // reads the same marker — kept because refusing before touching the session
    // at all is the cheaper and more obvious shape of "do not hand this out".
    if (isEndpointDeviceLocked(accountId)) return;
    const generation = this.sessionGeneration;
    const deviceKey = this.deviceKey;
    if (deviceKey == null) return;
    const shareable = isShareableDeviceKey(deviceKey)
      ? deviceKey
      : await importShareableDeviceKey(deviceKey).catch(() => null);
    if (shareable == null) return;
    if (!this.sessionStillCurrent(generation, accountId) || this.deviceKey == null) return;
    this.transport?.post({ kind: 'session-grant', accountId, requestId, deviceKey: shareable });
  }

  private onSessionMessage(message: EndpointSessionMessage): void {
    // A message that outlived its account binding is not this session's news.
    if (this.accountId !== message.accountId) return;
    switch (message.kind) {
      case 'session-request':
        void this.grantSession(message.requestId, message.accountId).catch(() => undefined);
        return;
      case 'session-grant':
        this.pendingGrants.get(message.requestId)?.(message.deviceKey);
        return;
      case 'session-lock':
        this.applyRemoteLock();
        return;
    }
  }

  /**
   * The user-intended lock: manual lock, sign-out, PIN idle lock.
   *
   * SYNCHRONOUS ON PURPOSE. A lock that can be awaited is a lock that can be
   * raced, and the previous shape — which awaited an IndexedDB delete — is
   * exactly what let a reset be blocked by a failing cleanup (finding B4) and a
   * revoked session be handed back (B2). There is nothing left to await: the
   * marker is a localStorage write, the teardown is memory, and the broadcast is
   * a `postMessage` whose failures are swallowed by the transport.
   */
  lockDevice(): void {
    const accountId = this.accountId;
    // Marker first, before anything that could throw: a lock whose broadcast
    // never lands must still fail closed on the next resume, here and in every
    // other tab — and it is what keeps the persisted record inert while the
    // asynchronous delete below is still in flight (or has failed).
    if (accountId != null) rememberEndpointDeviceLocked(accountId);
    this.sessionResume = null;
    this.endSession();
    if (accountId != null) {
      this.forgetPersistedSession(accountId);
      this.transport?.post({ kind: 'session-lock', accountId });
    }
  }

  /**
   * A lock that happened in ANOTHER tab, arriving on the channel or as the
   * account-scoped `storage` twin. It tears this tab down exactly like a local
   * lock and deliberately does NOT re-broadcast: the originating tab already
   * reached every tab of the account, and echoing would only multiply the
   * message. Idempotent — a lock delivered on both paths ends a session once and
   * then finds nothing left to end.
   */
  private applyRemoteLock(): void {
    const accountId = this.accountId;
    if (accountId != null) rememberEndpointDeviceLocked(accountId);
    this.sessionResume = null;
    this.endSession();
    if (accountId != null) this.forgetPersistedSession(accountId);
  }

  private closeSessionTransport(): void {
    for (const settle of [...this.pendingGrants.values()]) settle(null);
    this.pendingGrants.clear();
    this.transport?.close();
    this.transport = null;
  }

  /**
   * E7 step-up: verifies the endpoint password without tearing down the live
   * content-key session. No mnemonic is read, no remote medium is touched, and
   * the normal wrong-password lockout ladder still advances.
   */
  async verifyDevicePassword(devicePassword: string): Promise<void> {
    const generation = this.sessionGeneration;
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    this.requireCurrentGeneration(generation);
    if (
      stable.metadata == null ||
      this.devicePasswordMetadata == null ||
      this.deviceKey == null ||
      this.sessionRevision !== stable.revision
    ) {
      throw new EndpointKeystoreError(
        'phrase-locked',
        'A live wrapped-custody session is required for password step-up.',
      );
    }
    const metadata = parseEndpointPasswordMetadata(stable.metadata);
    if (!sameEndpointPassword(metadata, this.devicePasswordMetadata)) {
      this.endSession();
      throw new EndpointKeystoreError(
        'session-ended',
        'Endpoint password metadata changed before step-up.',
      );
    }
    this.assertNotLockedOut(metadata);

    let candidate: Uint8Array | undefined;
    try {
      candidate = await deriveDeviceKey(devicePassword, metadata.kdf, this.argon2);
      this.requireCurrentGeneration(generation);
      if (!(await verifyEndpointPassword(metadata, candidate))) {
        const failure = await this.registerWrongPassword(metadata, stable.revision);
        this.requireCurrentGeneration(generation);
        if (failure.revision !== stable.revision + 1) {
          this.endSession();
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint custody changed during password step-up.',
          );
        }
        this.sessionRevision = failure.revision;
        this.devicePasswordMetadata = {
          ...metadata,
          lockout: { failures: failure.failures, lockedUntil: failure.lockedUntil },
        };
        throw passwordFailureError(failure);
      }
      this.requireCurrentGeneration(generation);
      if (metadata.lockout.failures === 0 && metadata.lockout.lockedUntil == null) return;

      const resetRevision = await this.resetPasswordLockout(metadata, stable.revision);
      this.requireCurrentGeneration(generation);
      if (resetRevision !== stable.revision + 1) {
        this.endSession();
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint custody changed during password step-up.',
        );
      }
      this.sessionRevision = resetRevision;
      this.devicePasswordMetadata = {
        ...metadata,
        lockout: { failures: 0, lockedUntil: null },
      };
    } finally {
      if (candidate != null) zeroBytes(candidate);
    }
  }

  /** Default save path: verified open first, then wrapped custody. */
  async storeAfterVerifiedOpen(input: StoreWrappedPhraseInput): Promise<OpenedVault> {
    requireVaultId(input.vaultId);
    assertNotAborted(input.signal);
    const initialGeneration = this.sessionGeneration;
    const snapshot = await this.storage.readEndpointSnapshot();
    assertNotAborted(input.signal);
    this.reconcileSessionRevision(snapshot.revision);
    this.requireCurrentGeneration(initialGeneration);
    const entropy = mnemonicToEntropy(input.mnemonic);
    let verified: VerifiedVaultHeaderOpen | undefined;
    try {
      verified = await this.runVerifiedOpen(
        input.vaultId,
        input.mnemonic,
        input.fetchHeaderEnvelope,
        input.expectedFingerprint,
        input.signal,
      );
      assertNotAborted(input.signal);
      this.requireCurrentGeneration(initialGeneration);
      let custodySnapshot = snapshot;
      // The receiver deliberately asks for a password even when this endpoint
      // already has a live wrapped session. Never let ensureDeviceKey's normal
      // session-reuse path turn that user-supplied value into an unchecked
      // decoration: a wrong value must fail before the new phrase is wrapped.
      if (input.devicePassword !== undefined && this.deviceKey != null) {
        await this.verifyDevicePassword(input.devicePassword);
        assertNotAborted(input.signal);
        this.requireCurrentGeneration(initialGeneration);
        custodySnapshot = await this.storage.readEndpointSnapshot();
        assertNotAborted(input.signal);
        this.reconcileSessionRevision(custodySnapshot.revision);
        this.requireCurrentGeneration(initialGeneration);
      }
      const session = await this.ensureDeviceKey(
        input.devicePassword,
        custodySnapshot,
        initialGeneration,
      );
      assertNotAborted(input.signal);
      const payload = await wrapMnemonicEntropy(
        input.vaultId,
        entropy,
        session.deviceKey,
        this.randomBytes,
      );
      assertNotAborted(input.signal);
      const entry: StoredPhraseEntry = { vaultId: input.vaultId, custody: 'wrapped', payload };
      this.requireCurrentGeneration(session.generation);
      assertNotAborted(input.signal);
      const written = await this.storage.writeEntry(session.revision, input.vaultId, entry);
      if (written.status === 'stale') {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint keystore changed before the phrase could be stored.',
        );
      }
      if (session.generation !== this.sessionGeneration) {
        zeroBytes(verified.contentKey);
        return openedVaultReceipt(verified);
      }
      this.cacheWrappedEntropy(input.vaultId, entropy);
      this.sessionRevision = written.revision;
      return this.cacheVerifiedOpen(verified);
    } catch (cause) {
      if (verified != null) zeroBytes(verified.contentKey);
      throw cause;
    } finally {
      zeroBytes(entropy);
    }
  }

  /** Exceptional save path: impossible without a fresh runtime acknowledgment. */
  async storePlainAfterVerifiedOpen(input: StorePlainPhraseInput): Promise<OpenedVault> {
    requireVaultId(input.vaultId);
    assertNotAborted(input.signal);
    const generation = this.sessionGeneration;
    const snapshot = await this.storage.readEndpointSnapshot();
    assertNotAborted(input.signal);
    this.reconcileSessionRevision(snapshot.revision);
    this.requireCurrentGeneration(generation);
    const entropy = mnemonicToEntropy(input.mnemonic);
    let verified: VerifiedVaultHeaderOpen | undefined;
    try {
      verified = await this.runVerifiedOpen(
        input.vaultId,
        input.mnemonic,
        input.fetchHeaderEnvelope,
        input.expectedFingerprint,
        input.signal,
      );
      assertNotAborted(input.signal);
      this.requireCurrentGeneration(generation);
      consumePlainCustodyAcknowledgment(input.vaultId, input.acknowledgment);
      assertNotAborted(input.signal);
      const entry: StoredPhraseEntry = {
        vaultId: input.vaultId,
        custody: 'plain',
        payload: {
          version: ENDPOINT_KEYSTORE_VERSION,
          encoding: 'bip39-entropy-base64url',
          entropy: encodeBase64Url(entropy),
        },
      };
      assertNotAborted(input.signal);
      const written = await this.storage.writeEntry(snapshot.revision, input.vaultId, entry);
      if (written.status === 'stale') {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint keystore changed before the phrase could be stored.',
        );
      }
      if (generation !== this.sessionGeneration) {
        zeroBytes(verified.contentKey);
        return openedVaultReceipt(verified);
      }
      this.dropWrappedEntropy(input.vaultId);
      this.sessionRevision = written.revision;
      return this.cacheVerifiedOpen(verified);
    } catch (cause) {
      if (verified != null) zeroBytes(verified.contentKey);
      throw cause;
    } finally {
      zeroBytes(entropy);
    }
  }

  async openStoredVault(
    vaultId: string,
    fetchHeaderEnvelope: FetchVaultHeaderEnvelope,
    expectedFingerprint?: OpenedVault['keyFingerprint'],
  ): Promise<OpenedVault> {
    const generation = this.sessionGeneration;
    const stored = await this.readStoredMnemonic(vaultId);
    this.requireCurrentGeneration(generation);
    let verified: VerifiedVaultHeaderOpen | undefined;
    try {
      verified = await this.runVerifiedOpen(
        vaultId,
        stored.mnemonic,
        fetchHeaderEnvelope,
        expectedFingerprint,
      );
      this.requireCurrentGeneration(generation);
      const current = await this.storage.listEntries(stored.revision);
      if (current.status === 'stale') {
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint custody changed while the vault was opening.',
        );
      }
      this.requireCurrentGeneration(generation);
      this.sessionRevision = current.revision;
      return this.cacheVerifiedOpen(verified);
    } catch (cause) {
      if (verified != null) zeroBytes(verified.contentKey);
      throw cause;
    }
  }

  async readMnemonic(vaultId: string): Promise<string> {
    return (await this.readStoredMnemonic(vaultId)).mnemonic;
  }

  private async readStoredMnemonic(vaultId: string): Promise<StoredMnemonicRead> {
    requireVaultId(vaultId);
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    const record = stable.entries.find((candidate) => candidate.vaultId === vaultId);
    if (record == null) {
      throw new EndpointKeystoreError('vault-not-stored', 'Vault phrase is not on this endpoint.');
    }
    const entry = parseStoredPhraseEntry(record.value, record.vaultId);
    if (entry.custody === 'wrapped') {
      const entropy = this.wrappedEntropy.get(vaultId);
      if (
        this.deviceKey == null ||
        this.devicePasswordMetadata == null ||
        entropy == null ||
        stable.metadata == null ||
        this.sessionRevision !== stable.revision ||
        !sameEndpointPassword(
          parseEndpointPasswordMetadata(stable.metadata),
          this.devicePasswordMetadata,
        )
      ) {
        if (this.deviceKey != null) this.endSession();
        throw new EndpointKeystoreError(
          'phrase-locked',
          'The endpoint device password must be unlocked first.',
        );
      }
      return { mnemonic: entropyToMnemonic(entropy), revision: stable.revision };
    }
    const entropy = decodeBase64Url(entry.payload.entropy);
    try {
      return { mnemonic: entropyToMnemonic(entropy), revision: stable.revision };
    } finally {
      zeroBytes(entropy);
    }
  }

  async switchToPlain(
    vaultId: string,
    acknowledgment: PlainCustodyAcknowledgmentToken,
  ): Promise<void> {
    requireVaultId(vaultId);
    const generation = this.sessionGeneration;
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    this.requireCurrentGeneration(generation);
    const record = stable.entries.find((candidate) => candidate.vaultId === vaultId);
    if (record == null) {
      throw new EndpointKeystoreError('vault-not-stored', 'Vault phrase is not on this endpoint.');
    }
    const entry = parseStoredPhraseEntry(record.value, record.vaultId);
    if (entry.custody === 'plain') {
      consumePlainCustodyAcknowledgment(vaultId, acknowledgment);
      return;
    }
    const entropy = this.wrappedEntropy.get(vaultId);
    if (this.deviceKey == null || entropy == null) {
      throw new EndpointKeystoreError(
        'phrase-locked',
        'The endpoint device password must be unlocked first.',
      );
    }
    consumePlainCustodyAcknowledgment(vaultId, acknowledgment);
    const written = await this.storage.writeEntry(stable.revision, vaultId, {
      vaultId,
      custody: 'plain',
      payload: {
        version: ENDPOINT_KEYSTORE_VERSION,
        encoding: 'bip39-entropy-base64url',
        entropy: encodeBase64Url(entropy),
      },
    } satisfies StoredPhraseEntry);
    if (written.status === 'stale') {
      throw new EndpointKeystoreError('session-ended', 'Endpoint keystore changed during switch.');
    }
    if (generation !== this.sessionGeneration) {
      return;
    }
    this.dropWrappedEntropy(vaultId);
    this.sessionRevision = written.revision;
  }

  /** Plain → wrapped always requires the password again, even in an open session. */
  async switchToWrapped(vaultId: string, devicePassword: string): Promise<void> {
    requireVaultId(vaultId);
    const initialGeneration = this.sessionGeneration;
    const stable = await this.readStableEntries();
    this.reconcileSessionRevision(stable.revision);
    this.requireCurrentGeneration(initialGeneration);
    const record = stable.entries.find((candidate) => candidate.vaultId === vaultId);
    if (record == null) {
      throw new EndpointKeystoreError('vault-not-stored', 'Vault phrase is not on this endpoint.');
    }
    const entry = parseStoredPhraseEntry(record.value, record.vaultId);
    if (entry.custody === 'wrapped') return;
    const entropy = decodeBase64Url(entry.payload.entropy);
    try {
      const session = await this.ensureDeviceKey(
        devicePassword,
        { revision: stable.revision, metadata: stable.metadata },
        initialGeneration,
        true,
      );
      const payload = await wrapMnemonicEntropy(
        vaultId,
        entropy,
        session.deviceKey,
        this.randomBytes,
      );
      this.requireCurrentGeneration(session.generation);
      const written = await this.storage.writeEntry(session.revision, vaultId, {
        vaultId,
        custody: 'wrapped',
        payload,
      });
      if (written.status === 'stale') {
        throw new EndpointKeystoreError('session-ended', 'Custody switch was cancelled.');
      }
      if (session.generation !== this.sessionGeneration) {
        return;
      }
      this.cacheWrappedEntropy(vaultId, entropy);
      this.sessionRevision = written.revision;
    } finally {
      zeroBytes(entropy);
    }
  }

  /**
   * Borrows a session-scoped K_c copy that is wiped when custody locks.
   * Consumers MUST call assertSessionCurrent between any crypto operation and
   * any external side effect; an async suspension may cross a session teardown.
   */
  withContentKey<T>(
    vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    const cached = this.contentKeys.get(vaultId);
    if (cached == null) {
      return Promise.reject(
        new EndpointKeystoreError('phrase-locked', 'The vault content key is not unlocked.'),
      );
    }
    const generation = this.sessionGeneration;
    const borrowed = cached.bytes.slice();
    this.activeContentKeyBorrows.add(borrowed);
    const assertSessionCurrent = () => {
      if (generation !== this.sessionGeneration || this.contentKeys.get(vaultId) !== cached) {
        throw new EndpointKeystoreError('session-ended', 'Vault session ended during operation.');
      }
    };
    return Promise.resolve()
      .then(async () => {
        const stable = await this.readStableEntries();
        if (
          this.sessionRevision !== stable.revision ||
          !stable.entries.some((entry) => entry.vaultId === vaultId)
        ) {
          this.endSession();
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint custody changed during the vault session.',
          );
        }
        assertSessionCurrent();
        return operation(borrowed, cached.keyId, assertSessionCurrent);
      })
      .then(async (result) => {
        assertSessionCurrent();
        const stable = await this.readStableEntries();
        if (this.sessionRevision !== stable.revision) {
          this.endSession();
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint custody changed during the vault operation.',
          );
        }
        assertSessionCurrent();
        return result;
      })
      .finally(() => {
        this.activeContentKeyBorrows.delete(borrowed);
        zeroBytes(borrowed);
      });
  }

  /** Manual lock, logout, tab teardown and PIN idle-lock all call this seam. */
  endSession(): void {
    this.sessionGeneration += 1;
    invalidatePlainCustodyAcknowledgments();
    this.clearSessionSecrets();
    this.notifySessionEnd();
  }

  /** Synchronous revocation signal for secret-bearing session UI. */
  subscribeToSessionEnd(listener: () => void): () => void {
    this.sessionEndListeners.add(listener);
    return () => {
      this.sessionEndListeners.delete(listener);
    };
  }

  /**
   * The opposite edge: a vault's content key just became available on this
   * endpoint.
   *
   * `subscribeToSessionEnd` cannot answer this. It fires when an unlock
   * BEGINS (`beginSessionChange`), not when one succeeds, so a surface that
   * only listened there would tear its session down and never learn that the
   * vault it needs is now open. The portfolio store resolver (#1416) is such a
   * surface: without this edge, unlocking a vault leaves every one of its
   * portfolios rendering as a locked stub until the next full navigation.
   *
   * Carries the vault id and nothing else — no key material, no custody claim.
   * It is a "re-ask me about THAT vault" ping, and every consumer still has to
   * prove custody through `withContentKey`. The id is what lets a listener tell
   * an open it caused itself from a foreign one PER VAULT (#1533): judging that
   * by the run's outcome instead collapses two vaults unlocked in quick
   * succession into one signal and drops the second one's edge.
   */
  subscribeToVaultOpened(listener: (vaultId: string) => void): () => void {
    this.vaultOpenedListeners.add(listener);
    return () => {
      this.vaultOpenedListeners.delete(listener);
    };
  }

  handleIdle(pinLockEnabled: boolean): Promise<void> {
    if (pinLockEnabled) this.lockDevice();
    return Promise.resolve();
  }

  /**
   * The one seam every user-intended lock arrives on.
   *
   * TWO INDEPENDENT PATHS, both pinned by tests, because either one alone has a
   * hole:
   *
   *   • `VAULT_LOCK_REQUEST_EVENT` — dispatched in THIS tab by sign-out, the PIN
   *     idle lock, an account switch, a confirmed-unauthorized bootstrap and the
   *     manual "Lock vault". It is a local intent, so it locks AND broadcasts.
   *   • the account-scoped `storage` twin — the same lock arriving from another
   *     tab. It reaches tabs of a normal account that deliberately mount no
   *     vault provider, and it keeps working when `BroadcastChannel` does not
   *     exist. It tears down without re-broadcasting.
   *
   * The channel's own `session-lock` message is the third delivery and is
   * handled in `onSessionMessage`; a lock delivered twice ends one session and
   * then finds nothing left to end.
   *
   * Plaintext is revoked SYNCHRONOUSLY on all of them — `lockDevice` writes the
   * §12 marker and ends the session with nothing awaited — so a sign-out in
   * flight can never leave decrypted state mounted.
   */
  bindToVaultLockSignal(
    target: EventTarget = globalThis,
    accountId?: () => string | null,
  ): () => void {
    const onLock = () => this.lockDevice();
    const readAccountId = accountId ?? (() => this.accountId);
    const onStorage = (event: Event) => {
      const active = readAccountId() ?? null;
      if (active == null) return;
      if ((event as StorageEvent).key === vaultLockSignalStorageKey(active)) this.applyRemoteLock();
    };
    target.addEventListener(VAULT_LOCK_REQUEST_EVENT, onLock);
    target.addEventListener('storage', onStorage);
    return () => {
      target.removeEventListener(VAULT_LOCK_REQUEST_EVENT, onLock);
      target.removeEventListener('storage', onStorage);
    };
  }

  /**
   * Wipes only this endpoint's phrase copies. Server/Drive ciphertext is never
   * touched; the words or E7 QR restore access without vault-data loss.
   */
  async reset(): Promise<KeystoreResetResult> {
    // B4: `reset()` is the "I cannot get in any more" escape hatch, so CLEANUP
    // MUST NEVER BE ABLE TO BLOCK IT. The lock is synchronous and swallows its
    // own failures; the try/catch is the belt to that braces, so that even a
    // throwing lock leaves the wipe below reachable. A reset is also the most
    // deliberate lock there is — the live session opens phrases that are about
    // to stop existing.
    try {
      this.lockDevice();
    } catch {
      // A device that cannot signal its lock must still be wipeable.
    }
    await this.storage.reset();
    return {
      scope: 'this-endpoint-only',
      storedPhrases: 'removed',
      remoteVaultCopies: 'server-and-drive-untouched',
      vaultDataLost: false,
      nextAction: 're-enter-words-or-scan-qr',
    };
  }

  private async runVerifiedOpen(
    vaultId: string,
    mnemonic: string,
    fetchHeaderEnvelope: FetchVaultHeaderEnvelope,
    expectedFingerprint: OpenedVault['keyFingerprint'] | undefined,
    signal?: AbortSignal,
  ): Promise<VerifiedVaultHeaderOpen> {
    let envelope: Uint8Array;
    try {
      assertNotAborted(signal);
      envelope = await fetchHeaderEnvelope({ vaultId, ...(signal ? { signal } : {}) });
      assertNotAborted(signal);
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      if (cause instanceof EndpointKeystoreError) throw cause;
      throw new EndpointKeystoreError(
        'vault-header-unavailable',
        'The authenticated vault header could not be fetched.',
        {},
        { cause },
      );
    }
    if (!(envelope instanceof Uint8Array)) {
      throw new EndpointKeystoreError(
        'vault-header-unavailable',
        'Vault header fetch did not return envelope bytes.',
      );
    }

    let verified: VerifiedVaultHeaderOpen;
    try {
      assertNotAborted(signal);
      verified = await openVaultHeaderWithMnemonic({
        envelope,
        mnemonic,
        expectedVaultId: vaultId,
        expectedFingerprint,
      });
      assertNotAborted(signal);
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      throw new EndpointKeystoreError(
        'verification-failed',
        'The words did not open the authenticated vault header.',
        {},
        { cause },
      );
    }
    zeroBytes(verified.plaintext);
    return verified;
  }

  private cacheVerifiedOpen(verified: VerifiedVaultHeaderOpen): OpenedVault {
    const existing = this.contentKeys.get(verified.vaultId);
    const opened: OpenedVault = {
      vaultId: verified.vaultId,
      keyId: verified.keyId,
      keyFingerprint: verified.keyFingerprint,
    };
    // RE-OPENING AN ALREADY-OPEN VAULT MUST NOT CANCEL ITS LIVE BORROWS.
    //
    // `withContentKey` proves its session by identity — `contentKeys.get(id)
    // !== cached` is `session-ended` — so replacing an entry that reduces to
    // the very same key invalidated every in-flight operation for no reason.
    // Two independent readers of one vault is now ordinary (a move-out capture
    // beside a resolved portfolio store), and this cost one of them its borrow
    // mid-flight. The verification above is unchanged and still ran in full:
    // only the CACHE OBJECT is reused, and only when the re-open proved exactly
    // the same key.
    if (
      existing != null &&
      existing.keyId === verified.keyId &&
      existing.keyFingerprint === verified.keyFingerprint &&
      equalBytes(existing.bytes, verified.contentKey)
    ) {
      zeroBytes(verified.contentKey);
      return opened;
    }
    if (existing != null) zeroBytes(existing.bytes);
    this.contentKeys.set(verified.vaultId, {
      keyId: verified.keyId,
      keyFingerprint: verified.keyFingerprint,
      bytes: verified.contentKey,
    });
    // Only a real transition is news: a vault that was not open, or whose key
    // changed. A no-op re-open notifying here would make every listener that
    // reacts by re-reading the vault trigger its own next notification.
    this.notifyVaultOpened(verified.vaultId);
    return opened;
  }

  /**
   * Isolated from the caller on purpose: a listener that throws is a bug in a
   * SURFACE, and an unlock that already succeeded must not be reported as
   * failed because of one. The session-end path deliberately keeps its
   * unguarded shape — there, a listener that cannot run is a revocation that
   * did not happen, and failing loudly is the safe direction.
   */
  /**
   * "Re-ask me about these vaults." Raised whenever a vault this endpoint could
   * not serve a moment ago becomes servable — a password unlock, a custody
   * restore — in addition to the content-key open below. Listeners still have to
   * prove custody through `withContentKey`; nothing here hands one out.
   */
  private notifyVaultsAvailable(vaultIds: readonly string[]): void {
    for (const vaultId of vaultIds) this.notifyVaultOpened(vaultId);
  }

  /**
   * Persist the live session for this device (§12 as amended 2026-09-03).
   *
   * Fire-and-forget on purpose: the session is already installed in memory and
   * persistence is a convenience, so neither a slow IndexedDB nor a failing one
   * may delay or fail the unlock. Raw K_dev is imported to a NON-EXTRACTABLE
   * key first — the only shape that ever leaves process memory — and a runtime
   * that hands back an extractable key persists nothing.
   */
  private rememberSession(accountId: string, deviceKey: EndpointDeviceKeyMaterial): void {
    const generation = this.sessionGeneration;
    const expiresAt = this.now() + this.sessionPersistenceTtlMs;
    void (async () => {
      const shareable = isShareableDeviceKey(deviceKey)
        ? deviceKey
        : await importShareableDeviceKey(deviceKey).catch(() => null);
      if (shareable == null) return;
      // A lock that landed while the import ran must win: persist nothing.
      if (!this.sessionStillCurrent(generation, accountId)) return;
      await this.sessionPersistence.persist(accountId, shareable, expiresAt);
    })().catch(() => undefined);
  }

  private forgetPersistedSession(accountId: string): void {
    void this.sessionPersistence.clear(accountId).catch(() => undefined);
  }

  private notifyVaultOpened(vaultId: string): void {
    for (const listener of [...this.vaultOpenedListeners]) {
      try {
        listener(vaultId);
      } catch {
        // Intentionally swallowed; see above.
      }
    }
  }

  private async ensureDeviceKey(
    devicePassword: string | undefined,
    snapshot: { revision: number; metadata: unknown | null },
    initialGeneration: number,
    forcePassword = false,
  ): Promise<{ deviceKey: EndpointDeviceKeyMaterial; revision: number; generation: number }> {
    if (!forcePassword && this.deviceKey != null) {
      this.requireCurrentGeneration(initialGeneration);
      if (snapshot.metadata == null) {
        this.endSession();
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint device-password metadata was reset.',
        );
      }
      const metadata = parseEndpointPasswordMetadata(snapshot.metadata);
      if (
        this.devicePasswordMetadata == null ||
        !sameEndpointPassword(metadata, this.devicePasswordMetadata) ||
        this.sessionRevision !== snapshot.revision
      ) {
        this.endSession();
        throw new EndpointKeystoreError(
          'session-ended',
          'Endpoint device-password metadata changed during the session.',
        );
      }
      return {
        deviceKey: this.deviceKey,
        revision: snapshot.revision,
        generation: initialGeneration,
      };
    }
    if (devicePassword == null) {
      throw new EndpointKeystoreError(
        'device-password-required',
        'The endpoint device password is required.',
      );
    }
    if (snapshot.metadata == null) {
      const configured = await createEndpointPassword(devicePassword, {
        argon2: this.argon2,
        randomBytes: this.randomBytes,
      });
      try {
        this.requireCurrentGeneration(initialGeneration);
        const initialized = await this.storage.initializeMetadata(
          snapshot.revision,
          configured.metadata,
        );
        if (initialized.status === 'created') {
          this.requireCurrentGeneration(initialGeneration);
          this.deviceKey = configured.deviceKey;
          this.devicePasswordMetadata = configured.metadata;
          this.sessionRevision = initialized.revision;
          // The ceremony's first password IS this device's first session — so
          // it also clears the §12 marker a previous `reset()`/lock left behind,
          // exactly as `unlock()` does: the user just proved a password.
          if (this.accountId != null) {
            forgetEndpointDeviceLocked(this.accountId);
            this.rememberSession(this.accountId, configured.deviceKey);
          }
          return {
            deviceKey: configured.deviceKey,
            revision: initialized.revision,
            generation: initialGeneration,
          };
        }
        zeroBytes(configured.deviceKey);
        await this.unlock(devicePassword);
        return this.requireUnlockedSession();
      } catch (cause) {
        if (this.deviceKey !== configured.deviceKey) zeroBytes(configured.deviceKey);
        throw cause;
      }
    }
    await this.unlock(devicePassword);
    return this.requireUnlockedSession();
  }

  private requireUnlockedSession(): {
    deviceKey: EndpointDeviceKeyMaterial;
    revision: number;
    generation: number;
  } {
    if (this.deviceKey == null || this.sessionRevision == null) {
      throw new EndpointKeystoreError('session-ended', 'Device-password unlock was cancelled.');
    }
    return {
      deviceKey: this.deviceKey,
      revision: this.sessionRevision,
      generation: this.sessionGeneration,
    };
  }

  private assertNotLockedOut(metadata: EndpointPasswordMetadataV1): void {
    if (metadata.lockout.lockedUntil != null && metadata.lockout.lockedUntil > this.now()) {
      throw new EndpointKeystoreError(
        'locked-out',
        'Device-password verification is temporarily locked.',
        {
          failures: metadata.lockout.failures,
          retryAt: metadata.lockout.lockedUntil,
        },
      );
    }
  }

  private async recordWrongPassword(
    verifiedMetadata: EndpointPasswordMetadataV1,
    expectedRevision: number,
  ): Promise<never> {
    throw passwordFailureError(
      await this.registerWrongPassword(verifiedMetadata, expectedRevision),
    );
  }

  private async registerWrongPassword(
    verifiedMetadata: EndpointPasswordMetadataV1,
    expectedRevision: number,
  ): Promise<RecordedPasswordFailure> {
    let revision = expectedRevision;
    for (let retry = 0; retry < 32; retry += 1) {
      const now = this.now();
      const updated = await this.storage.updateMetadata(revision, (current) => {
        if (current == null) {
          throw new EndpointKeystoreError('session-ended', 'Endpoint password metadata was reset.');
        }
        const metadata = parseEndpointPasswordMetadata(current);
        if (!sameEndpointPassword(metadata, verifiedMetadata)) {
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint password metadata changed during verification.',
          );
        }
        if (metadata.lockout.lockedUntil != null && metadata.lockout.lockedUntil > now) {
          return { value: metadata, result: metadata.lockout };
        }
        const failures = metadata.lockout.failures + 1;
        const delay = lockoutDelayMs(failures);
        const lockedUntil = delay === 0 ? null : now + delay;
        const lockout = { failures, lockedUntil };
        return { value: { ...metadata, lockout }, result: lockout };
      });
      if (updated.status === 'stale') {
        revision = updated.revision;
        continue;
      }
      const { failures, lockedUntil } = updated.result;
      return { revision: updated.revision, failures, lockedUntil };
    }
    throw new EndpointKeystoreError(
      'session-ended',
      'Endpoint password lockout changed too many times concurrently.',
    );
  }

  private async resetPasswordLockout(
    verifiedMetadata: EndpointPasswordMetadataV1,
    expectedRevision: number,
  ): Promise<number> {
    let revision = expectedRevision;
    for (let retry = 0; retry < 32; retry += 1) {
      const updated = await this.storage.updateMetadata(revision, (current) => {
        if (current == null) {
          throw new EndpointKeystoreError('session-ended', 'Endpoint password metadata was reset.');
        }
        const metadata = parseEndpointPasswordMetadata(current);
        if (!sameEndpointPassword(metadata, verifiedMetadata)) {
          throw new EndpointKeystoreError(
            'session-ended',
            'Endpoint password metadata changed during verification.',
          );
        }
        return {
          value: { ...metadata, lockout: { failures: 0, lockedUntil: null } },
          result: undefined,
        };
      });
      if (updated.status === 'updated') return updated.revision;
      revision = updated.revision;
    }
    throw new EndpointKeystoreError(
      'session-ended',
      'Endpoint password state changed too many times concurrently.',
    );
  }

  private async readStableEntries(): Promise<{
    revision: number;
    metadata: unknown | null;
    entries: readonly { vaultId: string; value: unknown }[];
  }> {
    for (let retry = 0; retry < 16; retry += 1) {
      const snapshot = await this.storage.readEndpointSnapshot();
      const listed = await this.storage.listEntries(snapshot.revision);
      if (listed.status === 'current') {
        return { ...snapshot, entries: listed.entries };
      }
    }
    throw new EndpointKeystoreError(
      'storage-invalid',
      'Endpoint keystore changed too many times while reading.',
    );
  }

  private beginSessionChange(): number {
    this.sessionGeneration += 1;
    invalidatePlainCustodyAcknowledgments();
    this.clearSessionSecrets();
    this.notifySessionEnd();
    return this.sessionGeneration;
  }

  private notifySessionEnd(): void {
    for (const listener of [...this.sessionEndListeners]) listener();
  }

  private requireCurrentGeneration(generation: number): void {
    if (generation !== this.sessionGeneration) {
      throw new EndpointKeystoreError('session-ended', 'Device-password unlock was cancelled.');
    }
  }

  private clearSessionSecrets(): void {
    // A custody-restored K_dev is an opaque, non-extractable CryptoKey: there
    // are no bytes to zero, and dropping the reference is the whole teardown.
    if (this.deviceKey instanceof Uint8Array) zeroBytes(this.deviceKey);
    this.deviceKey = null;
    this.devicePasswordMetadata = null;
    this.sessionRevision = null;
    for (const entropy of this.wrappedEntropy.values()) zeroBytes(entropy);
    this.wrappedEntropy.clear();
    for (const contentKey of this.contentKeys.values()) zeroBytes(contentKey.bytes);
    this.contentKeys.clear();
    for (const borrowed of this.activeContentKeyBorrows) zeroBytes(borrowed);
    this.activeContentKeyBorrows.clear();
  }

  private reconcileSessionRevision(revision: number): void {
    if (this.sessionRevision != null && this.sessionRevision !== revision) this.endSession();
  }

  private cacheWrappedEntropy(vaultId: string, entropy: Uint8Array): void {
    this.dropWrappedEntropy(vaultId);
    this.wrappedEntropy.set(vaultId, entropy.slice());
  }

  private dropWrappedEntropy(vaultId: string): void {
    const existing = this.wrappedEntropy.get(vaultId);
    if (existing != null) zeroBytes(existing);
    this.wrappedEntropy.delete(vaultId);
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The vault receive operation was canceled.', 'AbortError');
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

export function lockoutDelayMs(failures: number): number {
  if (!Number.isInteger(failures) || failures < LOCKOUT_FIRST_FAILURE) return 0;
  const doubling = Math.min(failures - LOCKOUT_FIRST_FAILURE, 4);
  return Math.min(LOCKOUT_INITIAL_MS * 2 ** doubling, LOCKOUT_MAX_MS);
}

function requireVaultId(vaultId: string): void {
  if (!vaultIdParamSchema.safeParse({ vaultId }).success) {
    throw new EndpointKeystoreError('storage-invalid', 'Vault id is invalid.');
  }
}

function invalidEndpointState(): EndpointVaultState {
  return {
    status: 'endpoint-keystore-invalid',
    requiredAction: { kind: 'reset-endpoint-keystore' },
  };
}

function sameEndpointPassword(
  left: EndpointPasswordMetadataV1,
  right: EndpointPasswordMetadataV1,
): boolean {
  return (
    left.kdf.algorithm === right.kdf.algorithm &&
    left.kdf.memoryKiB === right.kdf.memoryKiB &&
    left.kdf.iterations === right.kdf.iterations &&
    left.kdf.parallelism === right.kdf.parallelism &&
    left.kdf.salt === right.kdf.salt &&
    left.wrapCheck.algorithm === right.wrapCheck.algorithm &&
    left.wrapCheck.iv === right.wrapCheck.iv &&
    left.wrapCheck.ciphertext === right.wrapCheck.ciphertext
  );
}

function openedVaultReceipt(verified: VerifiedVaultHeaderOpen): OpenedVault {
  return {
    vaultId: verified.vaultId,
    keyId: verified.keyId,
    keyFingerprint: verified.keyFingerprint,
  };
}

function passwordFailureError(failure: RecordedPasswordFailure): EndpointKeystoreError {
  return new EndpointKeystoreError(
    failure.lockedUntil == null ? 'wrong-password' : 'locked-out',
    failure.lockedUntil == null
      ? 'The endpoint device password is incorrect.'
      : 'Device-password verification is temporarily locked.',
    {
      failures: failure.failures,
      ...(failure.lockedUntil == null ? {} : { retryAt: failure.lockedUntil }),
    },
  );
}
