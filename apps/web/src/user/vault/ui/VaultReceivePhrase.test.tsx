import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { VAULT_DOC_SCHEMA_VERSION } from '@bettertrack/contracts';

import { utf8, zeroBytes } from '../bytes';
import { encryptVaultDoc } from '../keys/documents';
import { deriveAccountBinding, deriveVaultWrapKey, wrapContentKey } from '../keys/keyCore';
import { EndpointVaultKeystore, type OpenedVault, type StorePlainPhraseInput } from '../keystore';
import { consumePlainCustodyAcknowledgment } from '../keystore/acknowledgment';
import type { DevicePasswordArgon2 } from '../keystore/deviceCrypto';
import { EndpointKeystoreError } from '../keystore/errors';
import { createIndexedDbEndpointKeystoreStorage } from '../keystore/storage';
import {
  serializeVaultTransferPayload,
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

const INCOMING_VAULT_ID = '018f6a3e-1111-7000-8000-000000000002';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const DEVICE_PASSWORD = 'correct endpoint password';
const WRONG_DEVICE_PASSWORD = 'wrong endpoint password';
let databaseSequence = 0;

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

  it('checks the entered password against an already-unlocked real keystore before saving', async () => {
    const user = userEvent.setup();
    const keystore = realKeystore();
    const existingHeader = await createHeaderEnvelope(VAULT_TRANSFER_VECTOR_VAULT_ID, 0x31);
    await keystore.storeAfterVerifiedOpen({
      vaultId: VAULT_TRANSFER_VECTOR_VAULT_ID,
      mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
      devicePassword: DEVICE_PASSWORD,
      fetchHeaderEnvelope: async () => existingHeader.slice(),
    });
    const incomingHeader = await createHeaderEnvelope(INCOMING_VAULT_ID, 0x32);
    const fetchHeaderEnvelope = vi.fn(async ({ vaultId }: { vaultId: string }) => {
      expect(vaultId).toBe(INCOMING_VAULT_ID);
      return incomingHeader.slice();
    });
    const onOpened = vi.fn();

    render(
      <VaultReceivePhrase
        fetchHeaderEnvelope={fetchHeaderEnvelope}
        initialPayload={serializeVaultTransferPayload({
          mnemonic: VAULT_TRANSFER_VECTOR_MNEMONIC,
          vaultId: INCOMING_VAULT_ID,
        })}
        keystore={keystore}
        onOpened={onOpened}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const password = screen.getByLabelText('Device password');
    await user.type(password, WRONG_DEVICE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    expect(
      await screen.findByText(
        'The vault could not be opened or saved right now. Nothing was saved on this device; check the connection and try again.',
      ),
    ).toBeInTheDocument();
    expect(onOpened).not.toHaveBeenCalled();
    await expect(keystore.stateFor(INCOMING_VAULT_ID)).resolves.toMatchObject({
      status: 'not-on-this-endpoint',
    });

    await user.clear(password);
    await user.type(password, DEVICE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Verify and open vault' }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    keystore.endSession();
    await expect(keystore.unlock(DEVICE_PASSWORD)).resolves.toMatchObject({
      unlockedVaultIds: expect.arrayContaining([VAULT_TRANSFER_VECTOR_VAULT_ID, INCOMING_VAULT_ID]),
    });
    await expect(keystore.readMnemonic(INCOMING_VAULT_ID)).resolves.toBe(
      VAULT_TRANSFER_VECTOR_MNEMONIC,
    );
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

function realKeystore(): EndpointVaultKeystore {
  databaseSequence += 1;
  return new EndpointVaultKeystore({
    storage: createIndexedDbEndpointKeystoreStorage({
      databaseName: `bettertrack-vault-receiver-test-${databaseSequence}`,
    }),
    argon2: fastArgon2,
    randomBytes: deterministicRandom(),
  });
}

const fastArgon2: DevicePasswordArgon2 = async ({ password, salt }) => {
  const input = new Uint8Array(password.length + salt.length);
  input.set(password);
  input.set(salt, password.length);
  try {
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  } finally {
    zeroBytes(input);
  }
};

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
      keyId: KEY_ID,
      randomBytes: deterministicRandom(),
    });
    const encrypted = await encryptVaultDoc({
      plaintext: utf8(
        JSON.stringify({
          schemaVersion: VAULT_DOC_SCHEMA_VERSION,
          name: 'Transferred test vault',
          portfolios: [],
          keySlots: [keySlot],
          driveConnection: null,
          created: { at: '2026-08-20T12:00:00.000Z', deviceId: DEVICE_ID },
        }),
      ),
      contentKey,
      header: {
        keyId: KEY_ID,
        keySlots: [keySlot],
        vaultId,
        docId: DOC_ID,
        docKind: 'header',
        accountBinding: await deriveAccountBinding('018f6a3e-0000-7000-8000-00000000aaaa'),
        docVersion: 1,
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        writeId: WRITE_ID,
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
