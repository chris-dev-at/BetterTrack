import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { VaultConfig } from '@bettertrack/contracts';

import { EndpointVaultKeystore } from '../../vault/keystore/core';
import type { OpenedVault } from '../../vault/keystore/types';
import { VAULT_TRANSFER_GOLDEN_PAYLOAD, VAULT_TRANSFER_VECTOR_MNEMONIC } from '../../vault/qr';
import { createVaultTransferRuntime } from '../../vault/qr/runtime';
import { vaultEndpointStateQueryKey } from '../../vault/ui/useVaultEndpointState';
import { VaultTransferActions } from './VaultTransferActions';

const ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000aaaa';

function renderPanel(element: ReactElement): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

const VAULT: VaultConfig = {
  id: '018f6a3e-1111-7000-8000-000000000001',
  name: 'Phone vault',
  headerDocId: '018f6a3e-2222-7000-8000-000000000001',
  commonDocId: '018f6a3e-2222-7000-8000-000000000002',
  media: ['server'],
  driveConnectionId: null,
  keyFingerprint: 'AbCdEfGhIjKlMn_o',
  retirementProofPublicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  retirementGeneration: 0,
  mediaAttestedAt: null,
  mediaAttestedDriveConnectionId: null,
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
};

class LiveTransferKeystore extends EndpointVaultKeystore {
  private opened = false;

  override async storeAfterVerifiedOpen(): Promise<OpenedVault> {
    this.opened = true;
    return {
      vaultId: VAULT.id,
      keyId: '018f6a3e-3333-7000-8000-000000000001',
      keyFingerprint: VAULT.keyFingerprint,
    };
  }

  override async stateFor() {
    return this.opened
      ? {
          status: 'stored+wrapped' as const,
          session: 'unlocked' as const,
          requiredAction: { kind: 'open-silently' as const },
        }
      : {
          status: 'not-on-this-endpoint' as const,
          requiredAction: {
            kind: 'provide-phrase' as const,
            methods: ['enter-words', 'scan-qr'] as const,
          },
        };
  }

  override async readMnemonic(): Promise<string> {
    if (!this.opened) throw new Error('locked');
    return VAULT_TRANSFER_VECTOR_MNEMONIC;
  }

  override async verifyDevicePassword(): Promise<void> {}

  override async withContentKey<T>(
    _vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (!this.opened) throw new Error('locked');
    const contentKey = new Uint8Array(32);
    return operation(contentKey, '018f6a3e-3333-7000-8000-000000000001', () => undefined);
  }
}

class LockedTransferKeystore extends EndpointVaultKeystore {
  private unlocked = false;
  private opened = false;

  override async stateFor() {
    return this.unlocked
      ? {
          status: 'stored+wrapped' as const,
          session: 'unlocked' as const,
          requiredAction: { kind: 'open-silently' as const },
        }
      : {
          status: 'stored+wrapped' as const,
          session: 'locked' as const,
          requiredAction: {
            kind: 'unlock' as const,
            credential: 'device-password' as const,
          },
        };
  }

  override async unlock(devicePassword: string) {
    if (devicePassword !== 'correct endpoint password') throw new Error('wrong password');
    this.unlocked = true;
    return { unlockedVaultIds: [VAULT.id] };
  }

  override async openStoredVault(): Promise<OpenedVault> {
    if (!this.unlocked) throw new Error('locked');
    this.opened = true;
    return {
      vaultId: VAULT.id,
      keyId: '018f6a3e-3333-7000-8000-000000000001',
      keyFingerprint: VAULT.keyFingerprint,
    };
  }

  override async withContentKey<T>(
    _vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (!this.opened) throw new Error('locked');
    return operation(new Uint8Array(32), '018f6a3e-3333-7000-8000-000000000001', () => undefined);
  }

  override async readMnemonic(): Promise<string> {
    return VAULT_TRANSFER_VECTOR_MNEMONIC;
  }

  override async verifyDevicePassword(): Promise<void> {}
}

/** A wrapped row whose password is gone: §12's only exit is the keystore reset. */
class ResettableTransferKeystore extends EndpointVaultKeystore {
  private wiped = false;

  override async stateFor() {
    return this.wiped
      ? {
          status: 'not-on-this-endpoint' as const,
          requiredAction: {
            kind: 'provide-phrase' as const,
            methods: ['enter-words', 'scan-qr'] as const,
          },
        }
      : {
          status: 'stored+wrapped' as const,
          session: 'locked' as const,
          requiredAction: { kind: 'unlock' as const, credential: 'device-password' as const },
        };
  }

  override async withContentKey<T>(
    _vaultId: string,
    _operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    throw new Error('locked');
  }

  override async reset() {
    this.wiped = true;
    this.endSession();
    return {
      scope: 'this-endpoint-only' as const,
      storedPhrases: 'removed' as const,
      remoteVaultCopies: 'server-and-drive-untouched' as const,
      vaultDataLost: false as const,
      nextAction: 're-enter-words-or-scan-qr' as const,
    };
  }
}

describe('VaultTransferActions production entry points', () => {
  it('reaches both the live sender and receive surfaces from Vault settings', async () => {
    const user = userEvent.setup();
    const runtime = createVaultTransferRuntime({
      keystore: new LiveTransferKeystore(),
      requestJson: vi.fn(async () => ({ vaults: [VAULT] })),
      bindLockSignal: false,
    });

    renderPanel(<VaultTransferActions onNotice={vi.fn()} runtime={runtime} />);
    await user.click(screen.getByText('Transfer between devices'));

    expect(await screen.findByText(VAULT.name)).toBeInTheDocument();
    expect(await screen.findByText(/phrase is not stored on this device/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Receive transferred vault' }));

    expect(screen.getByRole('heading', { name: 'Open a transferred vault' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter 12 words instead' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Transfer code'), VAULT_TRANSFER_GOLDEN_PAYLOAD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Device password'), 'new endpoint password');
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    expect(runtime.isVaultOpen(VAULT.id)).toBe(true);
    expect(
      screen.queryByRole('heading', { name: 'Open a transferred vault' }),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Show transfer QR' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 12 words instead' })).toBeInTheDocument();

    runtime.endSession();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Show transfer QR' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/vault session was locked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen for transfer' })).toBeInTheDocument();
  });

  it('opens an existing wrapped endpoint entry before enabling the sender', async () => {
    const user = userEvent.setup();
    const runtime = createVaultTransferRuntime({
      keystore: new LockedTransferKeystore(),
      requestJson: vi.fn(async () => ({ vaults: [VAULT] })),
      bindLockSignal: false,
    });

    renderPanel(<VaultTransferActions onNotice={vi.fn()} runtime={runtime} />);
    await user.click(screen.getByText('Transfer between devices'));

    const password = await screen.findByLabelText('Device password');
    await user.type(password, 'correct endpoint password');
    await user.click(screen.getByRole('button', { name: 'Unlock for transfer' }));

    expect(await screen.findByRole('button', { name: 'Show transfer QR' })).toBeInTheDocument();
    expect(runtime.isVaultOpen(VAULT.id)).toBe(true);
  });

  it('offers the §12 keystore reset from the row password prompt', async () => {
    const user = userEvent.setup();
    const runtime = createVaultTransferRuntime({
      keystore: new ResettableTransferKeystore(),
      requestJson: vi.fn(async () => ({ vaults: [VAULT] })),
      bindLockSignal: false,
    });

    renderPanel(<VaultTransferActions onNotice={vi.fn()} runtime={runtime} />);
    await user.click(screen.getByText('Transfer between devices'));
    await screen.findByLabelText('Device password');

    await user.click(screen.getByRole('button', { name: 'Forgot the password?' }));
    expect(screen.getByText(/no vault data is lost/i)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Remove the phrases stored on this device' }),
    );

    // The prompt gives way to the honest not-on-this-endpoint affordance, not
    // to a second dead end.
    expect(await screen.findByText(/phrase is not stored on this device/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Device password')).not.toBeInTheDocument();
  });

  /**
   * #2013, the same-panel half.
   *
   * The [E10-A7] trace caught the receiver printing "The transferred vault was
   * verified and saved on this device." while the manager row a few hundred
   * pixels up, in the SAME panel, still read "Words needed on this device" —
   * two contradictory statements on one screen, and the row only corrected
   * itself after a navigation. Binding the keystore fixes the post-reload half
   * and nothing else: `readVaultEndpointState` short-circuits on the memoized
   * per-tab session resume, so no state surface re-reads the keystore until a
   * lock, a sign-out or a full page load.
   *
   * So the receive has to say so, exactly as both sibling custody writers do
   * (`VaultProvidePhraseDialog`, `VaultUnlockDialog`). The probe below hangs off
   * the SHIPPED query key those surfaces share — a stale row is a stale entry
   * under `vaultEndpointStateQueryKey`, whatever renders it.
   */
  it('tells the endpoint-state surfaces the moment the receive succeeds — no reload', async () => {
    const user = userEvent.setup();
    // Typed as the endpoint keystore the app declares, so the probe below asks
    // it exactly what `readVaultEndpointState` asks the real singleton.
    const keystore: EndpointVaultKeystore = new LiveTransferKeystore();
    const runtime = createVaultTransferRuntime({
      keystore,
      requestJson: vi.fn(async () => ({ vaults: [VAULT] })),
      bindLockSignal: false,
    });

    function EndpointStateProbe() {
      const { data } = useQuery({
        queryKey: vaultEndpointStateQueryKey(VAULT.id),
        queryFn: () => keystore.stateFor(VAULT.id),
        staleTime: 5_000,
      });
      return <p>{`row: ${data?.status ?? 'pending'}`}</p>;
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <EndpointStateProbe />
        <VaultTransferActions accountId={ACCOUNT_ID} onNotice={vi.fn()} runtime={runtime} />
      </QueryClientProvider>,
    );

    // The panel is the app's §12 account edge for this runtime: the keystore it
    // drives has to KNOW whose session the receiver is about to establish, or
    // `rememberSession()` is a no-op and the device stays locked (#2013).
    expect(keystore.boundAccountId()).toBe(ACCOUNT_ID);

    expect(await screen.findByText('row: not-on-this-endpoint')).toBeInTheDocument();

    await user.click(screen.getByText('Transfer between devices'));
    await user.click(await screen.findByRole('button', { name: 'Receive transferred vault' }));
    await user.type(screen.getByLabelText('Transfer code'), VAULT_TRANSFER_GOLDEN_PAYLOAD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Device password'), 'new endpoint password');
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    // Nothing remounted, nothing navigated, no second password: the row this
    // panel contradicted has to agree with it before the user's next click.
    expect(await screen.findByText('row: stored+wrapped')).toBeInTheDocument();
    expect(screen.queryByText('row: not-on-this-endpoint')).not.toBeInTheDocument();
  });
});
