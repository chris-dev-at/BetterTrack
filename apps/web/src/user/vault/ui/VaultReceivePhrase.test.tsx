import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { OpenedVault, StorePlainPhraseInput } from '../keystore';
import { consumePlainCustodyAcknowledgment } from '../keystore/acknowledgment';
import { EndpointKeystoreError } from '../keystore/errors';
import {
  VAULT_TRANSFER_GOLDEN_PAYLOAD,
  VAULT_TRANSFER_VECTOR_FINGERPRINT,
  VAULT_TRANSFER_VECTOR_MNEMONIC,
  VAULT_TRANSFER_VECTOR_NAME,
  VAULT_TRANSFER_VECTOR_VAULT_ID,
} from '../qr';
import { VaultReceivePhrase } from './VaultReceivePhrase';

const OPENED: OpenedVault = {
  vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
  keyId: '018f6a3e-3333-7000-8000-000000000001',
  keyFingerprint: VAULT_TRANSFER_VECTOR_FINGERPRINT,
};

function receiver() {
  return {
    storeAfterVerifiedOpen: vi.fn(async () => OPENED),
    storePlainAfterVerifiedOpen: vi.fn(async () => OPENED),
  };
}

describe('VaultReceivePhrase receiver', () => {
  it('prefills the scanned vault hints and defaults to verified wrapped custody', async () => {
    const user = userEvent.setup();
    const keystore = receiver();
    const fetchHeaderEnvelope = vi.fn(async () => new Uint8Array([1]));
    const onOpened = vi.fn();
    render(
      <VaultReceivePhrase
        fetchHeaderEnvelope={fetchHeaderEnvelope}
        initialPayload={VAULT_TRANSFER_GOLDEN_PAYLOAD}
        keystore={keystore}
        onOpened={onOpened}
      />,
    );

    expect(screen.getByRole('button', { name: 'Enter 12 words instead' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText(VAULT_TRANSFER_VECTOR_VAULT_ID)).toBeInTheDocument();
    expect(screen.getByLabelText('Vault name')).toHaveValue(VAULT_TRANSFER_VECTOR_NAME);
    expect(screen.getByRole('radio', { name: /Protect with a device password/ })).toBeChecked();
    await user.type(screen.getByLabelText('Device password'), 'new endpoint password');
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(keystore.storeAfterVerifiedOpen).toHaveBeenCalledWith({
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      devicePassword: 'new endpoint password',
      expectedFingerprint: VAULT_TRANSFER_VECTOR_FINGERPRINT,
      fetchHeaderEnvelope,
    });
    expect(keystore.storePlainAfterVerifiedOpen).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledWith({
      opened: OPENED,
      vaultName: VAULT_TRANSFER_VECTOR_NAME,
    });
  });

  it('issues the E3 one-use acknowledgment only after the plain-custody warning is accepted', async () => {
    const user = userEvent.setup();
    const keystore = receiver();
    keystore.storePlainAfterVerifiedOpen = vi.fn(async (input: StorePlainPhraseInput) => {
      consumePlainCustodyAcknowledgment(input.vaultId, input.acknowledgment);
      return OPENED;
    });
    render(
      <VaultReceivePhrase
        fetchHeaderEnvelope={vi.fn(async () => new Uint8Array([1]))}
        initialPayload={VAULT_TRANSFER_GOLDEN_PAYLOAD}
        keystore={keystore}
        onOpened={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('radio', { name: /Store without password wrapping/ }));

    expect(
      screen.getByText(
        'Without password wrapping, anyone who can access this browser profile may recover the seed phrase and own the vault.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify and open vault' })).toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', {
        name: 'I understand the weaker protection and want plain custody for this vault.',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    await waitFor(() => expect(keystore.storePlainAfterVerifiedOpen).toHaveBeenCalledTimes(1));
    expect(keystore.storeAfterVerifiedOpen).not.toHaveBeenCalled();
  });

  it('rejects unknown versions with an update notice while preserving manual entry', async () => {
    const user = userEvent.setup();
    render(
      <VaultReceivePhrase
        fetchHeaderEnvelope={vi.fn(async () => new Uint8Array([1]))}
        initialPayload={VAULT_TRANSFER_GOLDEN_PAYLOAD.replace('btvault1:', 'btvault2:')}
        keystore={receiver()}
        onOpened={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      screen.getByText(
        'This transfer code uses an unsupported version. Update the app before trying again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter 12 words instead' })).toBeInTheDocument();
  });

  it('offers manual words wherever QR is offered and validates them through the same format', async () => {
    const user = userEvent.setup();
    render(
      <VaultReceivePhrase
        fetchHeaderEnvelope={vi.fn(async () => new Uint8Array([1]))}
        keystore={receiver()}
        onOpened={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Enter 12 words instead' }));
    fireEvent.change(screen.getByLabelText('12-word seed phrase'), {
      target: { value: VAULT_TRANSFER_VECTOR_MNEMONIC },
    });
    fireEvent.change(screen.getByLabelText('Vault ID'), {
      target: { value: VAULT_TRANSFER_VECTOR_VAULT_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(VAULT_TRANSFER_VECTOR_VAULT_ID)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Protect with a device password/ })).toBeChecked();
  });

  it('does not report success when verified open rejects the phrase', async () => {
    const user = userEvent.setup();
    const keystore = receiver();
    keystore.storeAfterVerifiedOpen = vi.fn(async () => {
      throw new EndpointKeystoreError('verification-failed', 'Authenticated header did not open.');
    });
    const onOpened = vi.fn();
    render(
      <VaultReceivePhrase
        fetchHeaderEnvelope={vi.fn(async () => new Uint8Array([1]))}
        initialPayload={VAULT_TRANSFER_GOLDEN_PAYLOAD}
        keystore={keystore}
        onOpened={onOpened}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Device password'), 'new endpoint password');
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    expect(
      await screen.findByText(
        'The phrase did not open the authenticated vault header. Nothing was saved on this device.',
      ),
    ).toBeInTheDocument();
    expect(onOpened).not.toHaveBeenCalled();
    expect(keystore.storePlainAfterVerifiedOpen).not.toHaveBeenCalled();
  });

  it('does not blame the phrase when the authenticated header is unavailable', async () => {
    const user = userEvent.setup();
    const keystore = receiver();
    keystore.storeAfterVerifiedOpen = vi.fn(async () => {
      throw new EndpointKeystoreError(
        'vault-header-unavailable',
        'Authenticated header is offline.',
      );
    });
    const onOpened = vi.fn();
    render(
      <VaultReceivePhrase
        fetchHeaderEnvelope={vi.fn(async () => {
          throw new Error('offline');
        })}
        initialPayload={VAULT_TRANSFER_GOLDEN_PAYLOAD}
        keystore={keystore}
        onOpened={onOpened}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Device password'), 'new endpoint password');
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    expect(
      await screen.findByText(
        'The vault could not be opened or saved right now. Nothing was saved on this device; check the connection and try again.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'The phrase did not open the authenticated vault header. Nothing was saved on this device.',
      ),
    ).not.toBeInTheDocument();
    expect(onOpened).not.toHaveBeenCalled();
  });
});
