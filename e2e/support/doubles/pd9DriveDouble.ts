import type {
  DataHomeInfo,
  DataHomeReadResult,
  DataHomeWriteOptions,
} from '../../../apps/web/src/user/vault/dataHome';
import type {
  DriveDataHome,
  DriveReplicaVerifier,
} from '../../../apps/web/src/user/vault/drive/driveDataHome';
import type {
  DriveAccessTokenResult,
  DriveAuthorizationState,
  GoogleDriveTokenClient,
} from '../../../apps/web/src/user/vault/drive/gisTokenClient';
import type { VaultRuntimeProviderDependencies } from '../../../apps/web/src/user/vault/VaultRuntimeProvider';

/**
 * PD9's Drive stand-in, defined as a NORMAL TypeScript module rather than inside
 * the `addInitScript` callback that installs it.
 *
 * That placement is the whole point (#1527). A double built inside
 * `addInitScript` and assigned to an `unknown`-typed global is invisible to
 * `tsc`: when #1354 added `prepare()` to {@link GoogleDriveTokenClient}, the
 * double silently stopped implementing the contract and the enable wizard's
 * Continue button stayed disabled forever — which surfaced as a six-minute
 * nightly timeout on a click retried 3457 times, not as a build error. Here the
 * two doubles are pinned with `satisfies` against the product interfaces they
 * stand in for, so the NEXT method added to either contract fails
 * `pnpm exec tsc --project e2e/tsconfig.json` at the moment it is added.
 *
 * {@link installPd9DriveDoubles} is serialized by Playwright and evaluated in
 * the page, so it must stay self-contained: every import above is `import type`
 * and therefore erased before the function is stringified. Do not reach for a
 * module-scoped value inside it — that would be an out-of-scope reference in the
 * browser, and no type checker can catch it.
 */

/**
 * The secret values are deliberately represented as character codes. A trace of
 * the test source or a Playwright call therefore cannot accidentally carry the
 * passphrase/token canaries as cleartext.
 */
export const PD9_SECRET_CODES = {
  passphrase: [
    80, 100, 57, 45, 86, 97, 117, 108, 116, 45, 79, 110, 108, 121, 45, 50, 48, 50, 54, 33,
  ],
  wrongPassphrase: [
    80, 100, 57, 45, 87, 114, 111, 110, 103, 45, 79, 110, 108, 121, 45, 50, 48, 50, 54, 33,
  ],
  accessToken: [
    112, 100, 57, 45, 109, 101, 109, 111, 114, 121, 45, 116, 111, 107, 101, 110, 45, 99, 97, 110,
    97, 114, 121,
  ],
} as const;

export type Pd9SecretName = keyof typeof PD9_SECRET_CODES;

export type Pd9SecretCodes = Readonly<Record<Pd9SecretName, readonly number[]>>;

export interface Pd9BoundaryEvent {
  seq: number;
  kind:
    | 'drive-read'
    | 'drive-write'
    | 'drive-info'
    | 'drive-observe'
    | 'drive-converge'
    | 'drive-delete-verify'
    | 'drive-delete'
    | 'server-candidate-write'
    | 'server-candidate-read'
    | 'media-patch';
  version: number | null;
  outcome: string;
}

export interface Pd9DriveState {
  present: boolean;
  version: number | null;
  sizeBytes: number;
  tamperReads: boolean;
  revision: number;
}

/** The spec-facing control surface the double publishes on `window`. */
export interface Pd9BrowserDriveControl {
  state(): Pd9DriveState;
  ciphertextCanaries(): string[];
  tamperStored(): void;
  restoreStored(): void;
  setTamperReads(enabled: boolean): void;
}

declare global {
  interface Window {
    __bettertrackPd9Drive?: Pd9BrowserDriveControl;
    __bettertrackPd9Secrets?: Record<Pd9SecretName, string>;
    /**
     * Typed as the real dependency bag, not `unknown`: the composition the
     * patched provider consumes is checked here too, so a new REQUIRED
     * dependency is a build error rather than a runtime surprise.
     */
    __bettertrackE2EVaultDependencies?: VaultRuntimeProviderDependencies;
    __bettertrackPd9DependencyConsumed?: boolean;
  }
}

/**
 * Runs IN THE PAGE (Playwright stringifies it). It installs the deterministic
 * Drive `DataHome`, the Drive token client double and the spec's control
 * surface, then publishes the composed dependency bag the vault provider picks
 * up.
 */
export function installPd9DriveDoubles(secretCodes: Pd9SecretCodes): void {
  const STORAGE_KEY = 'bettertrack:e2e:pd9-drive-v1';
  const MAGIC_LENGTH = 8;
  const PREFIX_LENGTH = MAGIC_LENGTH + 4;

  type StoredDrive = {
    current: string | null;
    lastGood: string | null;
    tamperReads: boolean;
    revision: number;
  };

  const secrets = Object.fromEntries(
    Object.entries(secretCodes).map(([name, codes]) => [name, String.fromCharCode(...codes)]),
  ) as Record<Pd9SecretName, string>;
  window.__bettertrackPd9Secrets = secrets;

  function emptyState(): StoredDrive {
    return { current: null, lastGood: null, tamperReads: false, revision: 0 };
  }

  function load(): StoredDrive {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value == null ? emptyState() : (JSON.parse(value) as StoredDrive);
    } catch {
      return emptyState();
    }
  }

  function save(state: StoredDrive): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64(encoded: string): Uint8Array {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function header(bytes: Uint8Array): {
    formatVersion: number;
    vaultVersion: number;
    writtenAt: string;
  } {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      MAGIC_LENGTH,
      false,
    );
    const value = JSON.parse(
      new TextDecoder().decode(bytes.subarray(PREFIX_LENGTH, PREFIX_LENGTH + length)),
    ) as { formatVersion: number; vaultVersion: number; writtenAt: string };
    return value;
  }

  function info(bytes: Uint8Array): DataHomeInfo {
    const value = header(bytes);
    return {
      medium: 'drive',
      version: value.vaultVersion,
      sizeBytes: bytes.byteLength,
      updatedAt: value.writtenAt,
    };
  }

  function maybeTampered(encoded: string, enabled: boolean): Uint8Array {
    const bytes = fromBase64(encoded);
    if (enabled && bytes.length > 0) bytes[bytes.length - 1]! ^= 0x01;
    return bytes;
  }

  async function report(
    kind: Pd9BoundaryEvent['kind'],
    version: number | null,
    outcome = 'ok',
  ): Promise<void> {
    const params = new URLSearchParams({
      kind,
      version: version == null ? '' : String(version),
      outcome,
    });
    await fetch(`/__bettertrack_pd9_drive__?${params.toString()}`, {
      method: 'POST',
      credentials: 'same-origin',
    });
  }

  function observation(state = load()): DataHomeReadResult {
    if (state.current == null) return { status: 'absent', medium: 'drive' };
    const envelope = maybeTampered(state.current, state.tamperReads);
    return { status: 'ok', medium: 'drive', envelope, info: info(envelope) };
  }

  const drive = {
    medium: 'drive' as const,
    async read(): Promise<DataHomeReadResult> {
      const result = observation();
      await report('drive-read', result.status === 'ok' ? result.info.version : null);
      return result;
    },
    async write(envelope: Uint8Array, options: DataHomeWriteOptions) {
      const state = load();
      const current = state.current == null ? null : header(fromBase64(state.current)).vaultVersion;
      const outgoing = info(envelope);
      if (current !== options.ifVersion || (current != null && outgoing.version <= current)) {
        await report('drive-write', outgoing.version, 'conflict');
        return { status: 'conflict' as const, medium: 'drive' as const, currentVersion: current };
      }
      const encoded = toBase64(envelope);
      save({
        current: encoded,
        lastGood: encoded,
        tamperReads: state.tamperReads,
        revision: state.revision + 1,
      });
      await report('drive-write', outgoing.version);
      return { status: 'ok' as const, medium: 'drive' as const, info: outgoing };
    },
    async info() {
      const result = observation();
      await report('drive-info', result.status === 'ok' ? result.info.version : null);
      return result.status === 'ok'
        ? { status: 'ok' as const, medium: 'drive' as const, info: result.info }
        : result;
    },
    async observeReplicas() {
      const frozen = load();
      const first = observation(frozen);
      await report('drive-observe', first.status === 'ok' ? first.info.version : null);
      return {
        observations: [first],
        async converge(envelope: Uint8Array) {
          const outgoing = info(envelope);
          const encoded = toBase64(envelope);
          const current = load();
          save({
            current: encoded,
            lastGood: encoded,
            tamperReads: current.tamperReads,
            revision: current.revision + 1,
          });
          await report('drive-converge', outgoing.version);
          return { status: 'ok' as const, medium: 'drive' as const, info: outgoing };
        },
        async deleteIfUnchanged(verify: DriveReplicaVerifier) {
          const before = load();
          const refreshed = observation(before);
          await report(
            'drive-delete-verify',
            refreshed.status === 'ok' ? refreshed.info.version : null,
          );
          const unchanged =
            before.revision === frozen.revision && before.current === frozen.current;
          if (!unchanged || !(await verify([refreshed]))) {
            return {
              status: 'transport-failure' as const,
              failure: {
                code: 'api-failure' as const,
                message: 'The deterministic Drive copy changed before deletion.',
              },
            };
          }
          if (before.current == null) return { status: 'ok' as const, deleted: false };
          save({ ...before, current: null, revision: before.revision + 1 });
          await report('drive-delete', null);
          return { status: 'ok' as const, deleted: true };
        },
      };
    },
  } satisfies DriveDataHome;

  // The FULL `DriveAuthorizationState`, not the three states this double
  // happened to need on the day it was written.
  let authorization: DriveAuthorizationState = 'consent-required';
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const tokens = {
    get state() {
      return authorization;
    },
    /**
     * REQUIRED since #1354. The enable wizard preloads GIS before it offers its
     * authorization button (`runtime.prepareDriveStorage()` →
     * `tokenClient.prepare()`) and keeps step 2's Continue disabled until that
     * settles. This double has no GIS to load, so preparation is immediate.
     *
     * `satisfies GoogleDriveTokenClient` below is what keeps this method — and
     * the next one somebody adds to that contract — from going missing again.
     */
    async prepare() {},
    identify() {},
    markRevoked() {
      authorization = 'revoked';
      notify();
    },
    getAccessToken(): DriveAccessTokenResult {
      return authorization === 'connected'
        ? {
            status: 'ok' as const,
            accessToken: secrets.accessToken,
            expiresAt: Date.now() + 3_600_000,
          }
        : { status: authorization, message: 'Local PD9 Drive authorization is required.' };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async authorize(): Promise<DriveAccessTokenResult> {
      authorization = 'connected';
      notify();
      return {
        status: 'ok' as const,
        accessToken: secrets.accessToken,
        expiresAt: Date.now() + 3_600_000,
      };
    },
    clear() {
      authorization = 'consent-required';
      notify();
    },
    markExpired() {
      authorization = 'token-expired';
      notify();
    },
  } satisfies GoogleDriveTokenClient;

  window.__bettertrackPd9Drive = {
    state() {
      const state = load();
      const bytes = state.current == null ? null : fromBase64(state.current);
      return {
        present: bytes != null,
        version: bytes == null ? null : header(bytes).vaultVersion,
        sizeBytes: bytes?.byteLength ?? 0,
        tamperReads: state.tamperReads,
        revision: state.revision,
      };
    },
    ciphertextCanaries() {
      const encoded = load().current;
      if (encoded == null) return [];
      const bytes = fromBase64(encoded);
      const tail = bytes.subarray(Math.max(0, bytes.byteLength - 24));
      return [
        encoded.slice(-32),
        Array.from(tail, (value) => value.toString(16).padStart(2, '0')).join(''),
      ];
    },
    tamperStored() {
      const state = load();
      if (state.current == null) throw new Error('No Drive envelope is available to tamper.');
      const bytes = fromBase64(state.current);
      bytes[bytes.length - 1]! ^= 0x01;
      save({ ...state, current: toBase64(bytes), revision: state.revision + 1 });
    },
    restoreStored() {
      const state = load();
      if (state.lastGood == null) throw new Error('No known-good Drive envelope is available.');
      save({
        ...state,
        current: state.lastGood,
        tamperReads: false,
        revision: state.revision + 1,
      });
    },
    setTamperReads(enabled) {
      const state = load();
      save({ ...state, tamperReads: enabled });
    },
  } satisfies Pd9BrowserDriveControl;

  window.__bettertrackE2EVaultDependencies = {
    clientId: 'pd9-local-drive-data-home',
    tokens,
    drive,
  } satisfies VaultRuntimeProviderDependencies;
}
