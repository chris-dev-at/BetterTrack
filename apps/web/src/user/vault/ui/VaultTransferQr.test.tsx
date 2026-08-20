import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VAULT_TRANSFER_QR_EXPIRY_MS,
  VAULT_TRANSFER_QR_OPTIONS,
  VAULT_TRANSFER_STEP_UP_MAX_AGE_MS,
  VAULT_TRANSFER_VECTOR_FINGERPRINT,
  VAULT_TRANSFER_VECTOR_MNEMONIC,
  VAULT_TRANSFER_VECTOR_VAULT_ID,
} from '../qr';
import { VaultTransferQr, type VaultTransferQrSource } from './VaultTransferQr';

const DEVICE_PASSWORD = 'correct endpoint password';

function wrappedSource(): Extract<VaultTransferQrSource, { custody: 'wrapped' }> {
  return {
    custody: 'wrapped',
    requireLiveUnlock: vi.fn(async () => undefined),
    verifyDevicePassword: vi.fn(async () => undefined),
    readMnemonic: vi.fn(async () => VAULT_TRANSFER_VECTOR_MNEMONIC),
  };
}

function plainSource(): Extract<VaultTransferQrSource, { custody: 'plain' }> {
  return {
    custody: 'plain',
    requireLiveUnlock: vi.fn(async () => undefined),
    readMnemonic: vi.fn(async () => VAULT_TRANSFER_VECTOR_MNEMONIC),
  };
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
  });

  it('uses byte-mode UTF-8, exact level M, and renders a roughly 220-character payload', async () => {
    const source = plainSource();
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

    expect({
      mode: qr.getAttribute('data-encoding-mode'),
      characterEncoding: qr.getAttribute('data-character-encoding'),
      errorCorrectionLevel: qr.getAttribute('data-error-correction-level'),
      payloadLength: Number(qr.getAttribute('data-payload-length')),
      configured: VAULT_TRANSFER_QR_OPTIONS,
      rendered: qr.querySelector('path') !== null,
    }).toEqual({
      mode: 'byte',
      characterEncoding: 'UTF-8',
      errorCorrectionLevel: 'M',
      payloadLength: 217,
      configured: {
        mode: 'byte',
        characterEncoding: 'UTF-8',
        errorCorrectionLevel: 'M',
        boostErrorCorrectionLevel: false,
      },
      rendered: true,
    });
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
