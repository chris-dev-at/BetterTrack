import 'fake-indexeddb/auto';

import type { ComponentProps } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createVaultTransferQrSource,
  parseVaultTransferPayload,
  VAULT_TRANSFER_QR_EXPIRY_MS,
  VAULT_TRANSFER_STEP_UP_MAX_AGE_MS,
  VAULT_TRANSFER_VECTOR_FINGERPRINT,
  VAULT_TRANSFER_VECTOR_MNEMONIC,
  VAULT_TRANSFER_VECTOR_VAULT_ID,
} from '../qr';
import type { EndpointVaultKeystore } from '../keystore/core';

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

const DEVICE_PASSWORD = 'correct endpoint password';
const SECOND_VAULT_ID = '018f6a3e-1111-7000-8000-000000000002';

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  qrEncoder.render.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'vault-transfer-test=; Max-Age=0; path=/';
  Reflect.deleteProperty(globalThis, 'reportError');
  Reflect.deleteProperty(navigator, 'clipboard');
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
    localStorage.setItem('unrelated', 'theme');
    sessionStorage.setItem('unrelated', 'tab');
    document.cookie = 'vault-transfer-test=unrelated; path=/';
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
    const source = wrappedSource();
    render(
      <VaultTransferQr
        keyFingerprint={VAULT_TRANSFER_VECTOR_FINGERPRINT}
        source={source}
        vaultId={VAULT_TRANSFER_VECTOR_VAULT_ID}
      />,
    );

    await openWrapped();
    const after = await persistentSurfaceSnapshot();

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
  return {
    local: Object.keys(localStorage)
      .sort()
      .map((key) => [key, localStorage.getItem(key)]),
    session: Object.keys(sessionStorage)
      .sort()
      .map((key) => [key, sessionStorage.getItem(key)]),
    cookie: document.cookie,
    databases: (await indexedDB.databases()).map(({ name, version }) => ({ name, version })),
  };
}
