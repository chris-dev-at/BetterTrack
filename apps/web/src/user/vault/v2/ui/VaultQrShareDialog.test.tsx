import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ reauthenticate: vi.fn() }));
vi.mock('../api', () => api);

import { parseVaultQrPayload, unwrapVaultQrPayload } from '../qr';
import { FIXTURE_PASSPHRASE } from '../testSupport';
import { VaultQrShareDialog } from './VaultQrShareDialog';

const VAULT_ID = '4f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a01';

const keyring = {
  revealPassphrase: vi.fn(() => FIXTURE_PASSPHRASE),
} as unknown as Parameters<typeof VaultQrShareDialog>[0]['keyring'];

function mount(onClose = vi.fn()) {
  return render(
    <VaultQrShareDialog
      keyring={keyring}
      onClose={onClose}
      open
      vaultId={VAULT_ID}
      vaultName="Drive vault"
    />,
  );
}

/** The exact string the rendered QR encodes, captured from the stubbed renderer. */
let lastBuiltPayload = '';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => {
    lastBuiltPayload = value;
    return (
      <svg data-payload={value}>
        <path d="M0 0" />
      </svg>
    );
  },
}));

// The Start-handoff path runs the real code-wrap KDF (Argon2id, m=64MiB) — the
// tests deliberately keep it unmocked so the payload round-trip stays honest.
// That work is CPU-bound and, under a loaded CI runner sharing cores across
// test files, comfortably exceeds vitest's 5s default. Raise the per-test
// budget for this file (and give the crypto-bound waitFors matching headroom
// below) so a slow KDF reads as slow, never as a failure.
vi.setConfig({ testTimeout: 20_000 });
const CRYPTO_WAIT = { timeout: 15_000 } as const;

describe('VaultQrShareDialog — re-auth-gated, code-wrapped handoff (r2 §10, r3 §19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastBuiltPayload = '';
  });
  afterEach(() => vi.useRealTimers());

  it('shows no code until the password verifies', async () => {
    const user = userEvent.setup();
    api.reauthenticate.mockResolvedValue({ status: 'ok' });
    mount();

    expect(screen.queryByRole('img', { name: /QR code/u })).not.toBeInTheDocument();
    expect(keyring.revealPassphrase).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Your BetterTrack password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Start handoff' }));

    await waitFor(
      () => expect(screen.getByRole('img', { name: /QR code for the vault/u })).toBeInTheDocument(),
      CRYPTO_WAIT,
    );
    expect(api.reauthenticate).toHaveBeenCalledWith('hunter2');
  });

  it('FAILS CLOSED when the re-auth route is unavailable', async () => {
    const user = userEvent.setup();
    api.reauthenticate.mockResolvedValue({ status: 'unavailable' });
    mount();

    await user.type(screen.getByLabelText('Your BetterTrack password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Start handoff' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/cannot confirm your password/iu),
    );
    // No code, and the secret was never read out of the keyring.
    expect(screen.queryByRole('img', { name: /QR code/u })).not.toBeInTheDocument();
    expect(keyring.revealPassphrase).not.toHaveBeenCalled();
  });

  it('reports a wrong password and a rate limit without revealing anything', async () => {
    const user = userEvent.setup();
    api.reauthenticate.mockResolvedValueOnce({ status: 'invalid' });
    mount();
    await user.type(screen.getByLabelText('Your BetterTrack password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Start handoff' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/did not match/iu));
    expect(keyring.revealPassphrase).not.toHaveBeenCalled();

    api.reauthenticate.mockResolvedValueOnce({ status: 'rate-limited', retryAfterSeconds: 30 });
    await user.click(screen.getByRole('button', { name: 'Start handoff' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Too many attempts/iu));
    expect(screen.queryByRole('img', { name: /QR code/u })).not.toBeInTheDocument();
  });

  it('encodes a code-wrapped payload that never contains the words', async () => {
    const user = userEvent.setup();
    api.reauthenticate.mockResolvedValue({ status: 'ok' });
    mount();
    await user.type(screen.getByLabelText('Your BetterTrack password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Start handoff' }));
    await waitFor(() => expect(lastBuiltPayload).not.toBe(''), CRYPTO_WAIT);

    expect(lastBuiltPayload.startsWith('btvault1:{"qr":1,')).toBe(true);
    expect(lastBuiltPayload).not.toContain(FIXTURE_PASSPHRASE);
    for (const word of FIXTURE_PASSPHRASE.split(' ')) {
      expect(lastBuiltPayload).not.toContain(`"${word}`);
    }
    expect(parseVaultQrPayload(lastBuiltPayload).ok).toBe(true);
  });

  it('holds the code back until the sender asks for it, then unwraps the image', async () => {
    const user = userEvent.setup();
    api.reauthenticate.mockResolvedValue({ status: 'ok' });
    mount();
    await user.type(screen.getByLabelText('Your BetterTrack password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Start handoff' }));
    await waitFor(() => expect(lastBuiltPayload).not.toBe(''), CRYPTO_WAIT);

    // Screen one: the QR image, no code. A photo of this is useless.
    expect(screen.queryByText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/u)).not.toBeInTheDocument();
    expect(screen.getByText(/Once the other device has scanned/iu)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show the code' }));
    const code = screen.getByText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/u).textContent!;

    const parsed = parseVaultQrPayload(lastBuiltPayload);
    if (!parsed.ok) throw new Error('expected a parsable payload');
    await expect(unwrapVaultQrPayload(parsed.payload, code)).resolves.toEqual({
      ok: true,
      passphrase: FIXTURE_PASSPHRASE,
    });
  });

  it('warns about screenshots on the code screen', async () => {
    const user = userEvent.setup();
    api.reauthenticate.mockResolvedValue({ status: 'ok' });
    mount();
    await user.type(screen.getByLabelText('Your BetterTrack password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Start handoff' }));
    await waitFor(
      () => expect(screen.getByText(/Do not screenshot this/iu)).toBeInTheDocument(),
      CRYPTO_WAIT,
    );
  });

  it('expires the whole handoff after the contract TTL', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    api.reauthenticate.mockResolvedValue({ status: 'ok' });
    mount();
    await user.type(screen.getByLabelText('Your BetterTrack password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Start handoff' }));
    await waitFor(
      () => expect(screen.getByRole('img', { name: /QR code/u })).toBeInTheDocument(),
      CRYPTO_WAIT,
    );

    await vi.advanceTimersByTimeAsync(121_000);
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: /QR code/u })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent(/handoff expired/iu);
  });
});
