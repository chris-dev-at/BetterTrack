import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errors as playwrightErrors } from '@playwright/test';
import type { BrowserContext, Download, Page, TestInfo } from '@playwright/test';

/**
 * PD9's Drive stand-in lives at the same boundary as the production Google
 * adapter: it implements only the encrypted `DriveDataHome` contract. The
 * browser still runs the real vault crypto, sync engine, media switcher and
 * server APIs. No Drive HTTP/OAuth request exists in this spec.
 *
 * The secret values are deliberately represented as character codes. A trace
 * of the test source or a Playwright call therefore cannot accidentally carry
 * the passphrase/token canaries as cleartext. The focused spec also disables
 * trace, screenshots and video, then scans every remaining artifact.
 */
const PD9_SECRET_CODES = {
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

export interface Pd9SensitiveCanary {
  name: string;
  value: string;
}

export interface Pd9DriveMonitor {
  mark(): number;
  since(mark: number): readonly Pd9BoundaryEvent[];
  all(): readonly Pd9BoundaryEvent[];
}

interface BrowserDriveControl {
  state(): Pd9DriveState;
  ciphertextCanaries(): string[];
  tamperStored(): void;
  restoreStored(): void;
  setTamperReads(enabled: boolean): void;
}

const VAULT_RUNTIME_PROVIDER_SOURCE_PATH = '/src/user/vault/VaultRuntimeProvider.tsx';
const PD9_DEPENDENCY_CONSUMPTION_TIMEOUT_MS = 15_000;

function isVaultRuntimeProviderSource(url: URL): boolean {
  // This predicate runs for EVERY request in the context, so it must never
  // throw: a stray `%` survives URL parsing and would make `decodeURIComponent`
  // raise a URIError that surfaces as an unrelated route-matcher failure. The
  // cheap substring test short-circuits before the decode for all other traffic.
  if (!url.pathname.includes('VaultRuntimeProvider')) return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  return pathname.replaceAll('\\', '/').endsWith(VAULT_RUNTIME_PROVIDER_SOURCE_PATH);
}

declare global {
  interface Window {
    __bettertrackPd9Drive?: BrowserDriveControl;
    __bettertrackPd9Secrets?: Record<Pd9SecretName, string>;
    __bettertrackE2EVaultDependencies?: unknown;
    __bettertrackPd9DependencyConsumed?: boolean;
  }
}

/** Install the deterministic Drive DataHome and its sanitized ordering monitor. */
export async function installPd9Drive(context: BrowserContext): Promise<Pd9DriveMonitor> {
  const events: Pd9BoundaryEvent[] = [];
  let sequence = 0;
  const append = (event: Omit<Pd9BoundaryEvent, 'seq'>) => {
    events.push({ seq: ++sequence, ...event });
  };

  // The browser mock awaits this intercepted, body-free request before it
  // returns from a boundary operation. That gives the spec one total order
  // spanning Drive reads/writes and the real media PATCH without exposing bytes.
  await context.route(/\/__bettertrack_pd9_drive__\?.*$/, async (route) => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get('kind') as Pd9BoundaryEvent['kind'] | null;
    if (kind?.startsWith('drive-')) {
      const parsedVersion = Number(url.searchParams.get('version'));
      append({
        kind,
        version: Number.isInteger(parsedVersion) ? parsedVersion : null,
        outcome: url.searchParams.get('outcome') ?? 'ok',
      });
    }
    await route.fulfill({ status: 204, body: '' });
  });

  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/vault/media') && request.method() === 'PATCH') {
      append({ kind: 'media-patch', version: null, outcome: 'requested' });
      return;
    }
    if (!url.pathname.includes('/vault/media/server-candidate')) return;
    if (request.method() === 'PUT') {
      append({ kind: 'server-candidate-write', version: null, outcome: 'requested' });
    } else if (request.method() === 'GET') {
      append({ kind: 'server-candidate-read', version: null, outcome: 'requested' });
    }
  });

  // Vite serves this module as transformed JavaScript. The single assignment is
  // an e2e-only composition hook: production source and build output stay
  // untouched, while the real provider receives the boundary double.
  await context.route(isVaultRuntimeProviderSource, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const coreDeclaration = /^(\s*)const \[core\]/m;
    if (!coreDeclaration.test(body)) {
      throw new Error('PD9 could not install the e2e Drive dependency at the vault boundary.');
    }
    const patched = body.replace(
      coreDeclaration,
      [
        '$1const pd9Dependencies = globalThis.__bettertrackE2EVaultDependencies;',
        '$1if (pd9Dependencies) {',
        '$1  dependencies = pd9Dependencies;',
        '$1  globalThis.__bettertrackPd9DependencyConsumed = true;',
        '$1}',
        '$1const [core]',
      ].join('\n'),
    );
    await route.fulfill({ response, body: patched });
  });

  await context.addInitScript((secretCodes) => {
    const STORAGE_KEY = 'bettertrack:e2e:pd9-drive-v1';
    const MAGIC_LENGTH = 8;
    const PREFIX_LENGTH = MAGIC_LENGTH + 4;

    type StoredDrive = {
      current: string | null;
      lastGood: string | null;
      tamperReads: boolean;
      revision: number;
    };

    type DriveInfo = {
      medium: 'drive';
      version: number;
      sizeBytes: number;
      updatedAt: string | null;
    };

    type DriveRead =
      | { status: 'absent'; medium: 'drive' }
      | { status: 'ok'; medium: 'drive'; envelope: Uint8Array; info: DriveInfo };

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

    function info(bytes: Uint8Array): DriveInfo {
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
      if (enabled && bytes.length > 0) bytes[bytes.length - 1] ^= 0x01;
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

    function observation(state = load()): DriveRead {
      if (state.current == null) return { status: 'absent', medium: 'drive' };
      const envelope = maybeTampered(state.current, state.tamperReads);
      return { status: 'ok', medium: 'drive', envelope, info: info(envelope) };
    }

    const drive = {
      medium: 'drive' as const,
      async read(): Promise<DriveRead> {
        const result = observation();
        await report('drive-read', result.status === 'ok' ? result.info.version : null);
        return result;
      },
      async write(envelope: Uint8Array, options: { ifVersion: number | null }) {
        const state = load();
        const current =
          state.current == null ? null : header(fromBase64(state.current)).vaultVersion;
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
          async deleteIfUnchanged(verify: (reads: DriveRead[]) => Promise<boolean>) {
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
    };

    let authorization: 'consent-required' | 'connected' | 'token-expired' = 'consent-required';
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((listener) => listener());
    const tokens = {
      get state() {
        return authorization;
      },
      getAccessToken() {
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
      async authorize() {
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
    };

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
        bytes[bytes.length - 1] ^= 0x01;
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
    };
    window.__bettertrackE2EVaultDependencies = {
      clientId: 'pd9-local-drive-data-home',
      tokens,
      drive,
    };
  }, PD9_SECRET_CODES);

  return {
    mark: () => events.length,
    since: (mark) => events.slice(mark),
    all: () => [...events],
  };
}

/** Prove the transformed, lazily loaded provider consumed the boundary double. */
export async function assertPd9DriveInstalled(
  page: Page,
  timeoutMs = PD9_DEPENDENCY_CONSUMPTION_TIMEOUT_MS,
): Promise<void> {
  try {
    await page.waitForFunction(
      () => window.__bettertrackPd9DependencyConsumed === true,
      undefined,
      { timeout: timeoutMs },
    );
  } catch (cause) {
    // `waitForFunction` also rejects on page close, navigation crash and
    // evaluation errors. Collapsing those into the seam message would report a
    // dead page as a lazy-boundary regression, so only a real timeout — the flag
    // never turning true — is translated; everything else keeps its diagnosis.
    if (!(cause instanceof playwrightErrors.TimeoutError)) throw cause;
    throw new Error('PD9 Drive dependency was installed but not consumed by the vault provider.', {
      cause,
    });
  }
}

/** Fill a password input without passing the cleartext value through Playwright. */
export async function fillPd9Secret(
  page: Page,
  label: string,
  secret: Pd9SecretName,
): Promise<void> {
  await page.getByLabel(label, { exact: true }).evaluate((node, key) => {
    const input = node as HTMLInputElement;
    const value = window.__bettertrackPd9Secrets?.[key];
    if (value == null) throw new Error('PD9 browser secret is unavailable.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('PD9 could not set the password input.');
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, secret);
}

export function pd9DriveState(page: Page): Promise<Pd9DriveState> {
  return page.evaluate(() => {
    if (!window.__bettertrackPd9Drive) throw new Error('PD9 Drive control is unavailable.');
    return window.__bettertrackPd9Drive.state();
  });
}

/** Capture opaque ciphertext suffixes without moving an envelope into the test process. */
export async function pd9CiphertextCanaries(page: Page): Promise<Pd9SensitiveCanary[]> {
  const values = await page.evaluate(() => {
    if (!window.__bettertrackPd9Drive) throw new Error('PD9 Drive control is unavailable.');
    return window.__bettertrackPd9Drive.ciphertextCanaries();
  });
  return values.map((value, index) => ({ name: `ciphertext-${index + 1}`, value }));
}

/**
 * Read the real recovery download only long enough to seed the leak scanner,
 * then delete Playwright's temporary plaintext file.
 */
export async function pd9RecoveryCanaries(download: Download): Promise<Pd9SensitiveCanary[]> {
  const path = await download.path();
  if (path == null) throw new Error('PD9 recovery download did not produce a local file.');
  try {
    const text = await readFile(path, 'utf8');
    const keyId = /^keyId: (.+)$/m.exec(text)?.[1];
    const vaultKey = /^vaultKey: (.+)$/m.exec(text)?.[1];
    if (!keyId || !vaultKey) throw new Error('PD9 recovery download has an unexpected format.');
    return [
      { name: 'recovery-key-id', value: keyId },
      { name: 'vault-key', value: vaultKey },
    ];
  } finally {
    await download.delete();
  }
}

export async function tamperPd9StoredDrive(page: Page): Promise<void> {
  await page.evaluate(() => window.__bettertrackPd9Drive?.tamperStored());
}

export async function restorePd9StoredDrive(page: Page): Promise<void> {
  await page.evaluate(() => window.__bettertrackPd9Drive?.restoreStored());
}

export async function setPd9TamperReads(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((value) => window.__bettertrackPd9Drive?.setTamperReads(value), enabled);
}

/**
 * Fail if a passphrase/token canary appears in diagnostics or in any artifact.
 * The error names only the canary category; it never echoes the secret.
 */
export async function assertNoPd9Secrets(
  testInfo: TestInfo,
  diagnostics: readonly string[] = [],
  sensitive: readonly Pd9SensitiveCanary[] = [],
): Promise<void> {
  const canaries = [
    ...Object.entries(PD9_SECRET_CODES).map(([name, codes]) => ({
      name,
      value: String.fromCharCode(...codes),
    })),
    ...sensitive,
  ].filter(
    (canary, index, all) =>
      canary.value.length > 0 && all.findIndex((entry) => entry.value === canary.value) === index,
  );
  const text = [
    ...diagnostics,
    ...testInfo.errors.flatMap((error) => [error.message ?? '', error.stack ?? '']),
  ].join('\n');
  for (const canary of canaries) {
    if (text.includes(canary.value)) {
      throw new Error(`PD9 ${canary.name} canary escaped into test diagnostics.`);
    }
  }

  for (const attachment of testInfo.attachments) {
    if (attachment.body) assertBufferClean(attachment.body, attachment.name, canaries);
    if (attachment.path) {
      const body = await readFile(attachment.path).catch(() => null);
      if (body) assertBufferClean(body, attachment.name, canaries);
    }
  }

  const files = await listFiles(testInfo.outputDir);
  if (files.some((path) => path.endsWith('trace.zip'))) {
    throw new Error('PD9 secret-bearing scenario unexpectedly produced a Playwright trace.');
  }
  for (const path of files) {
    const body = await readFile(path).catch(() => null);
    if (body) assertBufferClean(body, path, canaries);
  }
}

function assertBufferClean(
  body: Buffer,
  source: string,
  canaries: ReadonlyArray<{ name: string; value: string }>,
): void {
  for (const canary of canaries) {
    if (body.includes(Buffer.from(canary.value))) {
      throw new Error(`PD9 ${canary.name} canary escaped into ${source}.`);
    }
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
