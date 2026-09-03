import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useT } from '../../../i18n';
import { listVaults, readVaultHeaderDocument, VAULTS_QUERY_KEY } from '../../../lib/vaultApi';
import { Button, Field, Input, ODialog, Textarea } from '../../../ui/origin';
import { MnemonicError } from '../bip39/mnemonic';
import { EndpointKeystoreError } from '../keystore/errors';
import { endpointVaultKeystore } from '../keystore/runtime';
import { VAULT_ENDPOINT_STATE_QUERY_PREFIX } from './useVaultEndpointState';

/**
 * "Words needed on this device", answered where the user stands.
 *
 * The `not-on-this-endpoint` state used to have exactly one affordance on a
 * locked stub: a link into `/control/privacy?vault=…&action=provide-phrase`,
 * where the same two fields sat inside the vault manager's access panel — and
 * success left the user in the Control Center looking for the way back. That is
 * the "redirected to some sub page where I have to find out what to press"
 * the owner described. This dialog is those two fields, here, and nothing else.
 *
 * It goes through the SAME verified-before-write seam the manager uses
 * (`storeAfterVerifiedOpen`): the words open the vault's authenticated header
 * first, and only a phrase that proves itself is wrapped under the device
 * password and stored. The scan-a-QR method stays in the manager, because it is
 * a settings-sized flow with its own surface (E7) — the dialog says so only if
 * the words fail, never as a first offer.
 */
export function VaultProvidePhraseDialog({
  vaultId,
  vaultName,
  onClose,
  onStored,
}: {
  vaultId: string;
  vaultName?: string | undefined;
  onClose: () => void;
  /** Fired once the phrase is stored and the vault opened on this device. */
  onStored?: (() => void) | undefined;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [words, setWords] = useState('');
  const [devicePassword, setDevicePassword] = useState('');
  const [working, setWorking] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // The vault's config carries the header document id and the key fingerprint
  // the open is verified against. It is the same cached directory the shell and
  // the manager read, so this is one network read per session, not per dialog.
  const vaults = useQuery({
    queryKey: VAULTS_QUERY_KEY,
    queryFn: ({ signal }) => listVaults(signal),
    staleTime: 600_000,
  });
  const vault = vaults.data?.find((candidate) => candidate.id === vaultId) ?? null;

  // Typeable the instant it appears — the whole difference from a settings
  // page whose field sits below the fold. ODialog's focus trap has already
  // claimed the panel by the time this runs, so this is the last word on focus.
  useEffect(() => {
    formRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working || vault == null || words.trim() === '' || devicePassword === '') return;
    setWorking(true);
    setErrorKey(null);
    try {
      await endpointVaultKeystore.storeAfterVerifiedOpen({
        vaultId: vault.id,
        mnemonic: words.trim().toLowerCase().split(/\s+/u).join(' '),
        devicePassword,
        expectedFingerprint: vault.keyFingerprint,
        fetchHeaderEnvelope: () => readVaultHeaderDocument(vault.id, vault.headerDocId),
      });
      setWords('');
      setDevicePassword('');
      void queryClient.invalidateQueries({ queryKey: VAULT_ENDPOINT_STATE_QUERY_PREFIX });
      onStored?.();
      onClose();
    } catch (cause) {
      setErrorKey(provideFailureKey(cause));
    } finally {
      setWorking(false);
    }
  }

  const formId = `vault-provide-phrase-form-${vaultId}`;

  return (
    <ODialog
      foot={
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={working} onClick={onClose} type="button" variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button
            disabled={working || vault == null || words.trim() === '' || devicePassword === ''}
            form={formId}
            type="submit"
          >
            {working ? t('vault.providePhrase.working') : t('vault.providePhrase.action')}
          </Button>
        </div>
      }
      onClose={onClose}
      open
      title={
        vaultName
          ? t('vault.providePhrase.titleNamed', { name: vaultName })
          : t('vault.providePhrase.title')
      }
    >
      <form
        className="flex flex-col gap-4"
        id={formId}
        onSubmit={(event) => void submit(event)}
        ref={formRef}
      >
        <p className="bt-soft text-sm">{t('vault.providePhrase.body')}</p>
        <Field htmlFor={`vault-provide-words-${vaultId}`} label={t('vault.providePhrase.words')}>
          <Textarea
            autoComplete="off"
            disabled={working}
            id={`vault-provide-words-${vaultId}`}
            onChange={(event) => setWords(event.target.value)}
            rows={3}
            spellCheck={false}
            value={words}
          />
        </Field>
        <Field
          htmlFor={`vault-provide-password-${vaultId}`}
          label={t('vault.providePhrase.devicePassword')}
        >
          <Input
            autoComplete="current-password"
            disabled={working}
            id={`vault-provide-password-${vaultId}`}
            onChange={(event) => setDevicePassword(event.target.value)}
            type="password"
            value={devicePassword}
          />
          <p className="bt-muted mt-1 text-xs">{t('vault.providePhrase.devicePasswordHint')}</p>
        </Field>
        {vaults.isPending ? (
          <p className="bt-muted text-xs" role="status">
            {t('common.loading')}
          </p>
        ) : null}
        {vaults.isError ? (
          <p className="bt-neg text-sm" role="alert">
            {t('vault.manager.loadError')}
          </p>
        ) : null}
        {errorKey ? (
          <p className="bt-neg text-sm" role="alert">
            {t(errorKey)}
          </p>
        ) : null}
      </form>
    </ODialog>
  );
}

function provideFailureKey(cause: unknown): string {
  // A malformed phrase (wrong word count, a word outside the wordlist, a bad
  // checksum) is refused before the header is even fetched — and it is still
  // "wrong words", not a storage problem.
  if (cause instanceof MnemonicError) return 'vault.providePhrase.wrongWords';
  if (!(cause instanceof EndpointKeystoreError)) return 'vault.providePhrase.error';
  switch (cause.code) {
    case 'wrong-password':
    case 'device-password-invalid':
    case 'locked-out':
      return 'vault.providePhrase.wrongPassword';
    // The words did not open this vault's authenticated header (or named
    // another vault's key): the phrase is wrong for THIS vault.
    case 'verification-failed':
      return 'vault.providePhrase.wrongWords';
    default:
      return 'vault.providePhrase.error';
  }
}
