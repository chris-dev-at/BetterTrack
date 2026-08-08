import { describe, expect, it } from 'vitest';

import { createMemoryVaultPassphraseStore, RAW_STORAGE_ACKNOWLEDGEMENT } from './devicePassphrase';
import { deterministicBytes, fastDeps, FIXTURE_PASSPHRASE, FIXTURE_VAULT_ID } from './testSupport';

const DEVICE_PASSWORD = 'correct horse battery staple';

describe('device passphrase storage', () => {
  it('stores the passphrase encrypted by default and reopens it with the device password', async () => {
    const store = createMemoryVaultPassphraseStore();
    await store.putWrapped({
      vaultId: FIXTURE_VAULT_ID,
      passphrase: FIXTURE_PASSPHRASE,
      devicePassword: DEVICE_PASSWORD,
      randomBytes: deterministicBytes(2),
      deps: fastDeps,
    });

    const record = await store.read(FIXTURE_VAULT_ID);
    expect(record?.mode).toBe('wrapped');
    // The stored record must not contain the words in any recoverable form.
    expect(JSON.stringify(record)).not.toContain('legal');
    expect(JSON.stringify(record)).not.toContain(FIXTURE_PASSPHRASE);

    await expect(
      store.open({ vaultId: FIXTURE_VAULT_ID, devicePassword: DEVICE_PASSWORD, deps: fastDeps }),
    ).resolves.toBe(FIXTURE_PASSPHRASE);
  });

  it('refuses the wrong device password', async () => {
    const store = createMemoryVaultPassphraseStore();
    await store.putWrapped({
      vaultId: FIXTURE_VAULT_ID,
      passphrase: FIXTURE_PASSPHRASE,
      devicePassword: DEVICE_PASSWORD,
      randomBytes: deterministicBytes(2),
      deps: fastDeps,
    });
    await expect(
      store.open({ vaultId: FIXTURE_VAULT_ID, devicePassword: 'wrong', deps: fastDeps }),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('refuses to open a wrapped record without a device password', async () => {
    const store = createMemoryVaultPassphraseStore();
    await store.putWrapped({
      vaultId: FIXTURE_VAULT_ID,
      passphrase: FIXTURE_PASSPHRASE,
      devicePassword: DEVICE_PASSWORD,
      randomBytes: deterministicBytes(2),
      deps: fastDeps,
    });
    await expect(store.open({ vaultId: FIXTURE_VAULT_ID })).rejects.toMatchObject({
      code: 'locked',
    });
  });

  it('binds the ciphertext to its vault id, so a record cannot be relabelled', async () => {
    const source = createMemoryVaultPassphraseStore();
    await source.putWrapped({
      vaultId: FIXTURE_VAULT_ID,
      passphrase: FIXTURE_PASSPHRASE,
      devicePassword: DEVICE_PASSWORD,
      randomBytes: deterministicBytes(2),
      deps: fastDeps,
    });
    const record = (await source.read(FIXTURE_VAULT_ID))!;

    // An attacker with write access to the local store moves the row under
    // another vault's id. The vault id is the GCM additional authenticated
    // data, so the record no longer opens.
    const otherVaultId = '5f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a05';
    const tampered = createMemoryVaultPassphraseStore([{ ...record, vaultId: otherVaultId }]);
    await expect(
      tampered.open({ vaultId: otherVaultId, devicePassword: DEVICE_PASSWORD, deps: fastDeps }),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('only stores an unencrypted passphrase behind the explicit acknowledgement', async () => {
    const store = createMemoryVaultPassphraseStore();
    await expect(
      store.putRaw({
        vaultId: FIXTURE_VAULT_ID,
        passphrase: FIXTURE_PASSPHRASE,
        // @ts-expect-error — a stray truthy value must not reach raw storage.
        acknowledgement: true,
      }),
    ).rejects.toMatchObject({ code: 'storage-failed' });

    await store.putRaw({
      vaultId: FIXTURE_VAULT_ID,
      passphrase: FIXTURE_PASSPHRASE,
      acknowledgement: RAW_STORAGE_ACKNOWLEDGEMENT,
    });
    await expect(store.open({ vaultId: FIXTURE_VAULT_ID })).resolves.toBe(FIXTURE_PASSPHRASE);
  });

  it('refuses to store something that is not a valid vault passphrase', async () => {
    const store = createMemoryVaultPassphraseStore();
    await expect(
      store.putWrapped({
        vaultId: FIXTURE_VAULT_ID,
        passphrase: 'hunter2',
        devicePassword: DEVICE_PASSWORD,
        deps: fastDeps,
      }),
    ).rejects.toMatchObject({ code: 'kdf-failed' });
    await expect(
      store.putRaw({
        vaultId: FIXTURE_VAULT_ID,
        passphrase: 'hunter2',
        acknowledgement: RAW_STORAGE_ACKNOWLEDGEMENT,
      }),
    ).rejects.toMatchObject({ code: 'kdf-failed' });
  });

  it('refuses an empty device password rather than deriving from nothing', async () => {
    const store = createMemoryVaultPassphraseStore();
    await expect(
      store.putWrapped({
        vaultId: FIXTURE_VAULT_ID,
        passphrase: FIXTURE_PASSPHRASE,
        devicePassword: '',
        deps: fastDeps,
      }),
    ).rejects.toMatchObject({ code: 'storage-failed' });
  });

  it('forgets one vault and all vaults', async () => {
    const store = createMemoryVaultPassphraseStore();
    await store.putRaw({
      vaultId: FIXTURE_VAULT_ID,
      passphrase: FIXTURE_PASSPHRASE,
      acknowledgement: RAW_STORAGE_ACKNOWLEDGEMENT,
    });
    expect(await store.list()).toHaveLength(1);
    await store.forget(FIXTURE_VAULT_ID);
    expect(await store.read(FIXTURE_VAULT_ID)).toBeNull();
    await expect(store.open({ vaultId: FIXTURE_VAULT_ID })).rejects.toMatchObject({
      code: 'locked',
    });

    await store.putRaw({
      vaultId: FIXTURE_VAULT_ID,
      passphrase: FIXTURE_PASSPHRASE,
      acknowledgement: RAW_STORAGE_ACKNOWLEDGEMENT,
    });
    await store.forgetAll();
    expect(await store.list()).toEqual([]);
  });
});
