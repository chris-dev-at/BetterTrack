import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errors as playwrightErrors } from '@playwright/test';
import type { BrowserContext, Download, Page, TestInfo } from '@playwright/test';

import { installPd9DriveDoubles, PD9_SECRET_CODES } from './doubles/pd9DriveDouble';
import type { Pd9BoundaryEvent, Pd9DriveState, Pd9SecretName } from './doubles/pd9DriveDouble';

/**
 * PD9's Drive stand-in lives at the same boundary as the production Google
 * adapter: it implements only the encrypted `DriveDataHome` contract. The
 * browser still runs the real vault crypto, sync engine, media switcher and
 * server APIs. No Drive HTTP/OAuth request exists in this spec.
 *
 * This module owns the NODE-side harness — the boundary monitor, the source
 * patch that composes the double in, and the secret-canary scanner. The doubles
 * themselves live in `doubles/pd9DriveDouble.ts`, where `tsc` can hold them
 * against the product interfaces they stand in for (#1527).
 *
 * The secret values are deliberately represented as character codes. A trace
 * of the test source or a Playwright call therefore cannot accidentally carry
 * the passphrase/token canaries as cleartext. The focused spec also disables
 * trace, screenshots and video, then scans every remaining artifact.
 */

export type { Pd9BoundaryEvent, Pd9DriveState, Pd9SecretName } from './doubles/pd9DriveDouble';

export interface Pd9SensitiveCanary {
  name: string;
  value: string;
}

export interface Pd9DriveMonitor {
  mark(): number;
  since(mark: number): readonly Pd9BoundaryEvent[];
  all(): readonly Pd9BoundaryEvent[];
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

  // The doubles are STRINGIFIED from a normally-typed module rather than written
  // inline here: that is what puts them inside `tsc`'s reach. See the header of
  // `doubles/pd9DriveDouble.ts` for the 3457-click failure this prevents.
  await context.addInitScript(installPd9DriveDoubles, PD9_SECRET_CODES);

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
