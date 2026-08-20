import 'fake-indexeddb/auto';

import type { ComponentProps } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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

  it('passes the byte-only payload with exact level M and boost disabled to the encoder', async () => {
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
