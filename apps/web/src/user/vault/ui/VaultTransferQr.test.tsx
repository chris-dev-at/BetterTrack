import 'fake-indexeddb/auto';

import type { ComponentProps } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VAULT_DOC_SCHEMA_VERSION } from '@bettertrack/contracts';

import { utf8, zeroBytes } from '../bytes';
import { acknowledgePlainCustodyRisk } from '../keystore/acknowledgment';
import { EndpointVaultKeystore } from '../keystore/core';
import { createIndexedDbEndpointKeystoreStorage } from '../keystore/storage';
import { encryptVaultDoc } from '../keys/documents';
import { deriveAccountBinding, deriveVaultWrapKey, wrapContentKey } from '../keys/keyCore';
import {
  createVaultTransferQrSource,
  parseVaultTransferPayload,
  VAULT_TRANSFER_QR_EXPIRY_MS,
  VAULT_TRANSFER_STEP_UP_MAX_AGE_MS,
  VAULT_TRANSFER_VECTOR_FINGERPRINT,
  VAULT_TRANSFER_VECTOR_MNEMONIC,
  VAULT_TRANSFER_VECTOR_VAULT_ID,
} from '../qr';

const qrEncoder = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('qrcode.react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('qrcode.react')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    QRCodeSVG: (props: ComponentProps<typeof actual.QRCodeSVG>) => {
      qrEncoder.render(props);
      return createElement(actual.QRCodeSVG, props);
    },
  };
});

import { VaultTransferQr } from './VaultTransferQr';
import { VaultReceivePhrase } from './VaultReceivePhrase';

const DEVICE_PASSWORD = 'correct endpoint password';
const SECOND_VAULT_ID = '018f6a3e-1111-7000-8000-000000000002';
const HEADER_KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const HEADER_DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const HEADER_DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const HEADER_WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const testDatabaseNames = new Set<string>();

function wrappedSource() {
  const lifecycle = sessionLifecycle();
  return {
    ...lifecycle,
    requireLiveUnlock: vi.fn(async () => 'wrapped' as const),
    verifyDevicePassword: vi.fn(async () => undefined),
    readMnemonic: vi.fn(async () => VAULT_TRANSFER_VECTOR_MNEMONIC),
  };
}

function plainSource() {
  const lifecycle = sessionLifecycle();
  return {
    ...lifecycle,
    requireLiveUnlock: vi.fn(async () => 'plain' as const),
    verifyDevicePassword: vi.fn(async () => undefined),
    readMnemonic: vi.fn(async () => VAULT_TRANSFER_VECTOR_MNEMONIC),
  };
}

function sessionLifecycle() {
  const listeners = new Set<() => void>();
  return {
    subscribeToSessionEnd(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    endSession() {
      for (const listener of [...listeners]) listener();
    },
  };
}

class ControlledTransferKeystore implements Pick<
  EndpointVaultKeystore,
  'readMnemonic' | 'stateFor' | 'subscribeToSessionEnd' | 'verifyDevicePassword' | 'withContentKey'
> {
  readonly mnemonic = deferred<string>();
  readonly readMnemonic = vi.fn(() => this.mnemonic.promise);
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  subscribeToSessionEnd(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async verifyDevicePassword(): Promise<void> {}

  async stateFor() {
    return {
      status: 'stored+plain' as const,
      requiredAction: { kind: 'open-silently' as const },
    };
  }

  async withContentKey<T>(
    _vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    const generation = this.generation;
    const contentKey = new Uint8Array(32);
    const assertSessionCurrent = () => {
      if (generation !== this.generation) throw new Error('session-ended');
    };
    try {
      const result = await operation(contentKey, 'test-key', assertSessionCurrent);
      assertSessionCurrent();
      return result;
    } finally {
      contentKey.fill(0);
    }
  }

  endSession(): void {
    this.generation += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

async function openWrapped() {
  fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
  const password = await screen.findByLabelText('Device password');
  fireEvent.change(password, { target: { value: DEVICE_PASSWORD } });
  fireEvent.submit(password.closest('form')!);
  return screen.findByLabelText('Vault seed-phrase transfer QR code');
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  qrEncoder.render.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'vault-transfer-test=; Max-Age=0; path=/';
  Reflect.deleteProperty(globalThis, 'reportError');
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(globalThis, 'caches');
  await Promise.all([...testDatabaseNames].map(deleteDatabase));
  testDatabaseNames.clear();
});

describe('VaultTransferQr sender', () => {
  it('requires wrapped password step-up again after the 60-second freshness window', async () => {
    let clock = 0;
    const source = wrappedSource();
    render(
      <VaultTransferQr
        keyFingerprint={VAULT_TRANSFER_VECTOR_FINGERPRINT}
        now={() => clock}
        source={source}
        vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID}
        vaultName="Phone vault"
      />,
    );

    await openWrapped();
    expect(source.verifyDevicePassword).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    clock = VAULT_TRANSFER_STEP_UP_MAX_AGE_MS;
    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    await screen.findByLabelText('Vault seed-phrase transfer QR code');
    expect(source.verifyDevicePassword).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    clock = VAULT_TRANSFER_STEP_UP_MAX_AGE_MS + 1_000;
    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    expect(await screen.findByLabelText('Device password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
  });

  it('rechecks wrapped password freshness after an asynchronous mnemonic read', async () => {
    let clock = 0;
    const mnemonic = deferred<string>();
    const source = wrappedSource();
    source.readMnemonic = vi.fn(() => mnemonic.promise);
    render(
      <VaultTransferQr
        now={() => clock}
        source={source}
        vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    const password = await screen.findByLabelText('Device password');
    fireEvent.change(password, { target: { value: DEVICE_PASSWORD } });
    fireEvent.submit(password.closest('form')!);
    await vi.waitFor(() => expect(source.readMnemonic).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('Device password')).not.toBeInTheDocument();

    clock = VAULT_TRANSFER_STEP_UP_MAX_AGE_MS + 1_000;
    await act(async () => {
      mnemonic.resolve(VAULT_TRANSFER_VECTOR_MNEMONIC);
      await mnemonic.promise;
    });

    expect(await screen.findByLabelText('Device password')).toBeInTheDocument();
    expect(source.verifyDevicePassword).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
    expect(screen.queryAllByText('abandon')).toHaveLength(0);
  });

  it('requires a live unlock for plain custody too', async () => {
    const source = plainSource();
    source.requireLiveUnlock = vi.fn(async () => {
      throw new Error('locked');
    });
    render(<VaultTransferQr source={source} vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));

    expect(
      await screen.findByText(
        'Unlock and open this vault on this device before showing its transfer code.',
      ),
    ).toBeInTheDocument();
    expect(source.requireLiveUnlock).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Device password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
    expect(
      screen.queryByText('This transfer code expired and is now blank. Show it again manually.'),
    ).not.toBeInTheDocument();
  });

  it('moves an immediately revoked show request to the locked state', async () => {
    const source = plainSource();
    source.requireLiveUnlock = vi.fn(async () => {
      source.endSession();
      return 'plain' as const;
    });
    render(<VaultTransferQr source={source} vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));

    expect(
      await screen.findByText(
        'Unlock and open this vault on this device before showing its transfer code.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Checking this endpoint…')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
  });

  it('passes the byte-only payload with exact level M and boost disabled to the encoder', async () => {
    const source = plainSource();
    const callSequence: string[] = [];
    source.requireLiveUnlock = vi.fn(async () => {
      callSequence.push('unlock');
      return 'plain' as const;
    });
    source.readMnemonic = vi.fn(async () => {
      callSequence.push('read');
      return VAULT_TRANSFER_VECTOR_MNEMONIC;
    });
    render(
      <VaultTransferQr
        keyFingerprint={VAULT_TRANSFER_VECTOR_FINGERPRINT}
        source={source}
        vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID}
        vaultName={'x'.repeat(52)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    const qr = await screen.findByLabelText('Vault seed-phrase transfer QR code');
    const props = latestQrEncoderProps();

    expect({
      payloadPrefix: props.value.slice(0, 'btvault1:'.length),
      payloadLength: props.value.length,
      level: props.level,
      boostLevel: props.boostLevel,
      rendered: qr.querySelector('path') !== null,
    }).toEqual({
      payloadPrefix: 'btvault1:',
      payloadLength: 217,
      level: 'M',
      boostLevel: false,
      rendered: true,
    });
    expect(callSequence).toEqual(['unlock', 'unlock', 'read', 'unlock']);
  });

  it('omits a legal vault name that is too long for the optional transfer hint', async () => {
    const source = wrappedSource();
    render(
      <VaultTransferQr
        source={source}
        vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID}
        vaultName={'x'.repeat(80)}
      />,
    );

    await openWrapped();

    expect(parseVaultTransferPayload(latestQrEncoderProps().value)).toEqual({
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });
    expect(source.verifyDevicePassword).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(
        'The device password could not be verified. The transfer code remains hidden.',
      ),
    ).not.toBeInTheDocument();
  });

  it('preserves a 64-character composed Unicode vault-name hint', async () => {
    const source = plainSource();
    const vaultName = 'é'.repeat(64);
    render(
      <VaultTransferQr
        source={source}
        vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID}
        vaultName={vaultName}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));

    expect(parseVaultTransferPayload((await latestQr()).value)).toMatchObject({ name: vaultName });
  });

  it('completes manual handoff using only the words and vault ID shown by the sender', async () => {
    const source = plainSource();
    const databaseName = `bettertrack-transfer-manual-${testDatabaseNames.size + 1}`;
    testDatabaseNames.add(databaseName);
    const receiverKeystore = new EndpointVaultKeystore({
      storage: createIndexedDbEndpointKeystoreStorage({ databaseName }),
      randomBytes: deterministicRandom(),
    });
    const header = await createHeaderEnvelope(VAULT_TRANSFER_VECTOR_VAULT_ID, 0x52);
    const onOpened = vi.fn();
    const sender = render(
      <VaultTransferQr source={source} vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show 12 words instead' }));
    await screen.findByLabelText('Vault seed-phrase transfer QR code');
    const exposedVaultId = screen.getByText(VAULT_TRANSFER_VECTOR_VAULT_ID).textContent ?? '';
    const exposedMnemonic = screen
      .getAllByRole('listitem')
      .map((item) => (item.textContent ?? '').replace(/^\d+\.\s*/, ''))
      .join(' ');
    sender.unmount();

    render(
      <VaultReceivePhrase
        fetchHeaderEnvelope={vi.fn(async () => header.slice())}
        keystore={receiverKeystore}
        onOpened={onOpened}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enter 12 words instead' }));
    fireEvent.change(screen.getByLabelText('12-word seed phrase'), {
      target: { value: exposedMnemonic },
    });
    fireEvent.change(screen.getByLabelText('Vault ID'), {
      target: { value: exposedVaultId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(exposedMnemonic).toBe(VAULT_TRANSFER_VECTOR_MNEMONIC);
    expect(exposedVaultId).toBe(VAULT_TRANSFER_VECTOR_VAULT_ID);
    expect(await screen.findByText(VAULT_TRANSFER_VECTOR_VAULT_ID)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /store without password wrapping/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /i understand the weaker protection/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(onOpened).toHaveBeenCalledWith({
      opened: expect.objectContaining({ vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID }),
    });
  });

  it('does not misreport payload creation failures as a rejected device password', async () => {
    const source = wrappedSource();
    source.readMnemonic = vi.fn(async () => 'not a valid seed phrase');
    render(<VaultTransferQr source={source} vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    const password = await screen.findByLabelText('Device password');
    fireEvent.change(password, { target: { value: DEVICE_PASSWORD } });
    fireEvent.submit(password.closest('form')!);

    expect(
      await screen.findByText(
        'The transfer code could not be created. Close this screen and try again.',
      ),
    ).toBeInTheDocument();
    expect(source.verifyDevicePassword).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/device password could not be verified/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText('This transfer code expired and is now blank. Show it again manually.'),
    ).not.toBeInTheDocument();
  });

  it('blanks the code at 60 seconds and only restores it after a manual action', async () => {
    vi.useFakeTimers();
    const source = plainSource();
    render(<VaultTransferQr source={source} vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    });
    expect(screen.getByLabelText('Vault seed-phrase transfer QR code')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(VAULT_TRANSFER_QR_EXPIRY_MS));
    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
    expect(screen.queryByText(VAULT_TRANSFER_VECTOR_MNEMONIC)).not.toBeInTheDocument();
    expect(
      screen.getByText('This transfer code expired and is now blank. Show it again manually.'),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show again' }));
    });
    expect(screen.getByLabelText('Vault seed-phrase transfer QR code')).toBeInTheDocument();
  });

  it('synchronously blanks an already-visible phrase when the live session ends', async () => {
    const source = plainSource();
    render(<VaultTransferQr source={source} vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    await screen.findByLabelText('Vault seed-phrase transfer QR code');
    expect(screen.getAllByText('abandon')).toHaveLength(11);

    act(() => source.endSession());

    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
    expect(screen.queryAllByText('abandon')).toHaveLength(0);
    expect(
      screen.getByText(
        'Unlock and open this vault on this device before showing its transfer code.',
      ),
    ).toBeInTheDocument();
  });

  it('does not reveal a production-source plain read that crosses session end', async () => {
    const keystore = new ControlledTransferKeystore();
    const source = createVaultTransferQrSource({
      keystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });
    render(<VaultTransferQr source={source} vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    await vi.waitFor(() => expect(keystore.readMnemonic).toHaveBeenCalledTimes(1));

    act(() => keystore.endSession());
    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();

    await act(async () => {
      keystore.mnemonic.resolve(VAULT_TRANSFER_VECTOR_MNEMONIC);
      await keystore.mnemonic.promise;
    });

    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
    expect(screen.queryAllByText('abandon')).toHaveLength(0);
    expect(
      screen.getByText(
        'Unlock and open this vault on this device before showing its transfer code.',
      ),
    ).toBeInTheDocument();
  });

  it('invalidates in-flight and visible secrets when rebound to another vault source', async () => {
    const firstKeystore = new ControlledTransferKeystore();
    const firstSource = createVaultTransferQrSource({
      keystore: firstKeystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });
    const secondSource = plainSource();
    const view = render(
      <VaultTransferQr source={firstSource} vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    await vi.waitFor(() => expect(firstKeystore.readMnemonic).toHaveBeenCalledTimes(1));

    view.rerender(<VaultTransferQr source={secondSource} vaultId={SECOND_VAULT_ID} />);
    await act(async () => {
      firstKeystore.mnemonic.resolve(VAULT_TRANSFER_VECTOR_MNEMONIC);
      await firstKeystore.mnemonic.promise;
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
    expect(screen.queryAllByText('abandon')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    expect(parseVaultTransferPayload((await latestQr()).value)).toMatchObject({
      vaultId: SECOND_VAULT_ID,
    });

    view.rerender(<VaultTransferQr source={plainSource()} vaultId={SECOND_VAULT_ID} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Vault seed-phrase transfer QR code')).not.toBeInTheDocument();
    expect(screen.queryAllByText('abandon')).toHaveLength(0);
  });

  it('has no network, clipboard, log, analytics, error-report or persistence leak path', async () => {
    const databaseName = `bettertrack-transfer-reveal-${testDatabaseNames.size + 1}`;
    testDatabaseNames.add(databaseName);
    const keystore = new EndpointVaultKeystore({
      storage: createIndexedDbEndpointKeystoreStorage({ databaseName }),
      randomBytes: deterministicRandom(),
    });
    const header = await createHeaderEnvelope(VAULT_TRANSFER_VECTOR_VAULT_ID, 0x31);
    await keystore.storePlainAfterVerifiedOpen({
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      acknowledgment: acknowledgePlainCustodyRisk(VAULT_TRANSFER_VECTOR_VAULT_ID),
      fetchHeaderEnvelope: async () => header.slice(),
    });
    const source = createVaultTransferQrSource({
      keystore,
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
    });

    localStorage.setItem('unrelated', 'theme');
    sessionStorage.setItem('unrelated', 'tab');
    document.cookie = 'vault-transfer-test=unrelated; path=/';
    installInspectableCaches();
    const before = await persistentSurfaceSnapshot();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const logSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const reportError = vi.fn();
    Object.defineProperty(globalThis, 'reportError', { configurable: true, value: reportError });
    render(
      <VaultTransferQr
        keyFingerprint={VAULT_TRANSFER_VECTOR_FINGERPRINT}
        source={source}
        vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show transfer QR' }));
    const payload = (await latestQr()).value;
    const after = await persistentSurfaceSnapshot();
    const persistedValues = persistentValues(after);
    const forbiddenBytes = [utf8(VAULT_TRANSFER_VECTOR_MNEMONIC), utf8(payload)];

    expect({
      fetches: fetchSpy.mock.calls,
      clipboard: clipboardWrite.mock.calls,
      logs: logSpies.flatMap((spy) => spy.mock.calls),
      analyticsEvents: dispatchSpy.mock.calls,
      reports: reportError.mock.calls,
      storageUnchanged: after,
      manualFallbackCount: screen.getAllByText('Show 12 words instead').length,
    }).toEqual({
      fetches: [],
      clipboard: [],
      logs: [],
      analyticsEvents: [],
      reports: [],
      storageUnchanged: before,
      manualFallbackCount: 2,
    });
    expect(JSON.stringify(after)).not.toContain(VAULT_TRANSFER_VECTOR_MNEMONIC);
    expect(JSON.stringify(after)).not.toContain(payload);
    for (const forbidden of forbiddenBytes) {
      expect(containsByteSequence(persistedValues, forbidden)).toBe(false);
      zeroBytes(forbidden);
    }
  });
});

function latestQrEncoderProps(): {
  value: string;
  level?: string;
  boostLevel?: boolean;
} {
  const props = qrEncoder.render.mock.lastCall?.[0];
  if (props == null) throw new Error('QR encoder was not rendered.');
  return props as { value: string; level?: string; boostLevel?: boolean };
}

async function latestQr() {
  await screen.findByLabelText('Vault seed-phrase transfer QR code');
  return latestQrEncoderProps();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function persistentSurfaceSnapshot() {
  const databaseNames = (await indexedDB.databases())
    .map(({ name }) => name)
    .filter((name): name is string => name != null)
    .sort();
  const databases = await Promise.all(
    databaseNames.map(async (name) => ({ name, stores: await readAllDatabaseStores(name) })),
  );
  const cacheNames = typeof globalThis.caches === 'undefined' ? [] : await globalThis.caches.keys();
  const cacheContents = await Promise.all(
    cacheNames.sort().map(async (name) => {
      const cache = await globalThis.caches.open(name);
      const requests = await cache.keys();
      return {
        name,
        entries: await Promise.all(
          requests.map(async (request) => {
            const response = await cache.match(request);
            const binary = response?.clone();
            return {
              url: request.url,
              text: response == null ? null : await response.text(),
              bytes: binary == null ? null : new Uint8Array(await binary.arrayBuffer()),
            };
          }),
        ),
      };
    }),
  );
  return {
    local: Object.keys(localStorage)
      .sort()
      .map((key) => [key, localStorage.getItem(key)]),
    session: Object.keys(sessionStorage)
      .sort()
      .map((key) => [key, sessionStorage.getItem(key)]),
    cookie: document.cookie,
    databases,
    caches: cacheContents,
  };
}

async function readAllDatabaseStores(databaseName: string): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const storeNames = Array.from(db.objectStoreNames).sort();
    if (storeNames.length === 0) return [];
    const transaction = db.transaction(storeNames, 'readonly');
    return await Promise.all(
      storeNames.map(async (name) => {
        const store = transaction.objectStore(name);
        const [keys, values] = await Promise.all([
          idbRequest(store.getAllKeys()),
          idbRequest(store.getAll()),
        ]);
        return { name, keys, values };
      }),
    );
  } finally {
    db.close();
  }
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function persistentValues(snapshot: Awaited<ReturnType<typeof persistentSurfaceSnapshot>>) {
  return [snapshot.databases, snapshot.caches];
}

function containsByteSequence(value: unknown, needle: Uint8Array): boolean {
  if (typeof value === 'string') return bytesContain(utf8(value), needle);
  if (value instanceof ArrayBuffer) return bytesContain(new Uint8Array(value), needle);
  if (ArrayBuffer.isView(value)) {
    return bytesContain(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), needle);
  }
  if (Array.isArray(value)) return value.some((entry) => containsByteSequence(entry, needle));
  if (value != null && typeof value === 'object') {
    return Object.values(value).some((entry) => containsByteSequence(entry, needle));
  }
  return false;
}

function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  for (let offset = 0; offset + needle.length <= haystack.length; offset += 1) {
    let matches = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function installInspectableCaches(): void {
  const records = new Map<string, Map<string, Uint8Array>>([
    [
      'unrelated-cache',
      new Map([['https://cache.test/public-resource', utf8('unrelated public response')]]),
    ],
  ]);
  const open = async (cacheName: string) => {
    const entries = records.get(cacheName) ?? new Map<string, Uint8Array>();
    records.set(cacheName, entries);
    return {
      keys: async () => [...entries.keys()].map((url) => new Request(url)),
      match: async (request: RequestInfo | URL) => {
        const bytes = entries.get(requestUrl(request));
        return bytes == null ? undefined : new Response(bytes.slice());
      },
      put: async (request: RequestInfo | URL, response: Response) => {
        entries.set(requestUrl(request), new Uint8Array(await response.arrayBuffer()));
      },
    } as unknown as Cache;
  };
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      keys: async () => [...records.keys()],
      open,
    } as unknown as CacheStorage,
  });
}

function requestUrl(request: RequestInfo | URL): string {
  return typeof request === 'string'
    ? request
    : request instanceof URL
      ? request.toString()
      : request.url;
}

function deterministicRandom(): (length: number) => Uint8Array {
  let next = 1;
  return (length) =>
    Uint8Array.from({ length }, () => {
      const value = next % 256;
      next += 1;
      return value;
    });
}

async function createHeaderEnvelope(vaultId: string, contentByte: number): Promise<Uint8Array> {
  const contentKey = new Uint8Array(32).fill(contentByte);
  const wrapKey = await deriveVaultWrapKey(VAULT_TRANSFER_VECTOR_MNEMONIC, vaultId);
  try {
    const keySlot = await wrapContentKey({
      contentKey,
      wrapKey,
      vaultId,
      keyId: HEADER_KEY_ID,
      randomBytes: deterministicRandom(),
    });
    const encrypted = await encryptVaultDoc({
      plaintext: utf8(
        JSON.stringify({
          schemaVersion: VAULT_DOC_SCHEMA_VERSION,
          name: 'Transfer leak test vault',
          portfolios: [],
          keySlots: [keySlot],
          driveConnection: null,
          created: { at: '2026-08-20T12:00:00.000Z', deviceId: HEADER_DEVICE_ID },
        }),
      ),
      contentKey,
      header: {
        keyId: HEADER_KEY_ID,
        keySlots: [keySlot],
        vaultId,
        docId: HEADER_DOC_ID,
        docKind: 'header',
        accountBinding: await deriveAccountBinding('018f6a3e-0000-7000-8000-00000000aaaa'),
        docVersion: 1,
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        deviceId: HEADER_DEVICE_ID,
        writeId: HEADER_WRITE_ID,
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
