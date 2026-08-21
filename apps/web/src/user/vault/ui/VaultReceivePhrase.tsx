import { useEffect, useState, type FormEvent } from 'react';

import type { VaultKeyFingerprint } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Button, Field, Input, Textarea } from '../../../ui/origin';
import { acknowledgePlainCustodyRisk } from '../keystore/acknowledgment';
import type { EndpointVaultKeystore } from '../keystore/core';
import { EndpointKeystoreError } from '../keystore/errors';
import type { FetchVaultHeaderEnvelope, OpenedVault } from '../keystore/types';
import {
  parseVaultTransferPayload,
  serializeVaultTransferPayload,
  VaultTransferPayloadError,
  VAULT_TRANSFER_NAME_MAX_CHARS,
  type VaultTransferPayload,
  type VaultTransferPayloadErrorOutcome,
} from '../qr';

type ReceiveSource = 'qr' | 'manual';
type ReceiveCustody = 'wrapped' | 'plain';

interface ReceiveCandidate extends VaultTransferPayload {
  source: ReceiveSource;
}

export interface VaultReceivePhraseReceipt {
  opened: OpenedVault;
  vaultName?: string;
}

export interface VaultReceivePhraseProps {
  keystore: Pick<EndpointVaultKeystore, 'storeAfterVerifiedOpen' | 'storePlainAfterVerifiedOpen'>;
  fetchHeaderEnvelope: FetchVaultHeaderEnvelope;
  /** Camera/scanner adapters hand their decoded text into this same web flow. */
  initialPayload?: string;
  onOpened(receipt: VaultReceivePhraseReceipt): void;
  onCancel?: () => void;
}

/**
 * E7 receiver: one QR/paste parser and one manual fallback converge on E3's
 * verified-before-write keystore methods. No phrase can be persisted through a
 * component path that skips authenticated header open.
 */
export function VaultReceivePhrase({
  keystore,
  fetchHeaderEnvelope,
  initialPayload,
  onOpened,
  onCancel,
}: VaultReceivePhraseProps) {
  const t = useT();
  const [source, setSource] = useState<ReceiveSource>('qr');
  const [payloadInput, setPayloadInput] = useState(initialPayload ?? '');
  const [manualMnemonic, setManualMnemonic] = useState('');
  const [manualVaultId, setManualVaultId] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualFingerprint, setManualFingerprint] = useState('');
  const [candidate, setCandidate] = useState<ReceiveCandidate | null>(null);
  const [vaultName, setVaultName] = useState('');
  const [custody, setCustody] = useState<ReceiveCustody>('wrapped');
  const [devicePassword, setDevicePassword] = useState('');
  const [plainAcknowledged, setPlainAcknowledged] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (initialPayload === undefined) return;
    setPayloadInput(initialPayload);
    setSource('qr');
    setCandidate(null);
    setErrorKey(null);
  }, [initialPayload]);

  function chooseSource(next: ReceiveSource) {
    setSource(next);
    setCandidate(null);
    setCustody('wrapped');
    setDevicePassword('');
    setPlainAcknowledged(false);
    setErrorKey(null);
  }

  function acceptCandidate(next: VaultTransferPayload, nextSource: ReceiveSource) {
    setCandidate({ ...next, source: nextSource });
    setVaultName(next.name ?? '');
    setCustody('wrapped');
    setDevicePassword('');
    setPlainAcknowledged(false);
    setErrorKey(null);
    if (nextSource === 'qr') setPayloadInput('');
  }

  function inspectInput(event: FormEvent) {
    event.preventDefault();
    try {
      if (source === 'qr') {
        acceptCandidate(parseVaultTransferPayload(payloadInput.trim()), 'qr');
        return;
      }
      const serialized = serializeVaultTransferPayload({
        mnemonic: manualMnemonic,
        vaultId: manualVaultId.trim(),
        ...(manualName === '' ? {} : { name: manualName }),
        ...(manualFingerprint.trim() === ''
          ? {}
          : { fingerprint: manualFingerprint.trim() as VaultKeyFingerprint }),
      });
      acceptCandidate(parseVaultTransferPayload(serialized), 'manual');
    } catch (error) {
      setErrorKey(payloadErrorKey(error));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (candidate == null) return;
    if (custody === 'wrapped' && devicePassword.length === 0) return;
    if (custody === 'plain' && !plainAcknowledged) return;

    setWorking(true);
    setErrorKey(null);
    try {
      const expectedFingerprint = candidate.fingerprint as VaultKeyFingerprint | undefined;
      const opened =
        custody === 'wrapped'
          ? await keystore.storeAfterVerifiedOpen({
              vaultId: candidate.vaultId,
              mnemonic: candidate.mnemonic,
              devicePassword,
              expectedFingerprint,
              fetchHeaderEnvelope,
            })
          : await keystore.storePlainAfterVerifiedOpen({
              vaultId: candidate.vaultId,
              mnemonic: candidate.mnemonic,
              acknowledgment: acknowledgePlainCustodyRisk(candidate.vaultId),
              expectedFingerprint,
              fetchHeaderEnvelope,
            });
      const receipt: VaultReceivePhraseReceipt = {
        opened,
        ...(vaultName === '' ? {} : { vaultName }),
      };
      setCandidate(null);
      setManualMnemonic('');
      setDevicePassword('');
      setPlainAcknowledged(false);
      onOpened(receipt);
    } catch (error) {
      setErrorKey(receiveErrorKey(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="flex flex-col gap-5" data-vault-transfer-screen="receiver">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="bt-h2">{t('vault.transfer.receiver.title')}</h2>
          <p className="bt-meta mt-1">{t('vault.transfer.receiver.intro')}</p>
        </div>
        {onCancel ? (
          <Button
            aria-label={t('common.close')}
            icon="x"
            iconOnly
            onClick={onCancel}
            variant="quiet"
          />
        ) : null}
      </div>

      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t('vault.transfer.receiver.method')}
      >
        <Button
          aria-pressed={source === 'qr'}
          onClick={() => chooseSource('qr')}
          size="sm"
          variant={source === 'qr' ? 'primary' : 'quiet'}
        >
          {t('vault.transfer.receiver.scanPaste')}
        </Button>
        <Button
          aria-pressed={source === 'manual'}
          onClick={() => chooseSource('manual')}
          size="sm"
          variant={source === 'manual' ? 'primary' : 'quiet'}
        >
          {t('vault.transfer.manualEntry')}
        </Button>
      </div>

      {errorKey ? (
        <p
          className="bt-neg rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm"
          role="alert"
        >
          {t(errorKey)}
        </p>
      ) : null}

      {candidate == null ? (
        <form className="flex flex-col gap-4" onSubmit={inspectInput}>
          {source === 'qr' ? (
            <Field
              htmlFor="vault-transfer-payload"
              hint={t('vault.transfer.receiver.payloadHint')}
              label={t('vault.transfer.receiver.payload')}
            >
              <Textarea
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                id="vault-transfer-payload"
                onChange={(event) => setPayloadInput(event.target.value)}
                required
                rows={5}
                spellCheck={false}
                value={payloadInput}
              />
            </Field>
          ) : (
            <>
              <Field
                htmlFor="vault-transfer-mnemonic"
                hint={t('vault.transfer.receiver.mnemonicHint')}
                label={t('vault.transfer.receiver.mnemonic')}
              >
                <Textarea
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  id="vault-transfer-mnemonic"
                  onChange={(event) => setManualMnemonic(event.target.value)}
                  required
                  rows={4}
                  spellCheck={false}
                  value={manualMnemonic}
                />
              </Field>
              <Field htmlFor="vault-transfer-vault-id" label={t('vault.transfer.receiver.vaultId')}>
                <Input
                  autoCapitalize="none"
                  autoComplete="off"
                  id="vault-transfer-vault-id"
                  onChange={(event) => setManualVaultId(event.target.value)}
                  required
                  spellCheck={false}
                  value={manualVaultId}
                />
              </Field>
              <Field
                htmlFor="vault-transfer-name"
                label={t('vault.transfer.receiver.nameOptional')}
              >
                <Input
                  id="vault-transfer-name"
                  maxLength={VAULT_TRANSFER_NAME_MAX_CHARS}
                  onChange={(event) => setManualName(event.target.value)}
                  value={manualName}
                />
              </Field>
              <Field
                htmlFor="vault-transfer-fingerprint"
                label={t('vault.transfer.receiver.fingerprintOptional')}
              >
                <Input
                  autoCapitalize="none"
                  autoComplete="off"
                  id="vault-transfer-fingerprint"
                  onChange={(event) => setManualFingerprint(event.target.value)}
                  spellCheck={false}
                  value={manualFingerprint}
                />
              </Field>
            </>
          )}
          <Button
            disabled={source === 'qr' ? payloadInput.trim() === '' : manualMnemonic.trim() === ''}
            type="submit"
            variant="primary"
          >
            {t('common.continue')}
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={(event) => void save(event)}>
          <div className="rounded-lg border border-neutral-800 p-4">
            <p className="bt-row-title">{t('vault.transfer.receiver.checked')}</p>
            <dl className="mt-3 grid gap-2 text-sm">
              <div>
                <dt className="bt-muted">{t('vault.transfer.receiver.vaultId')}</dt>
                <dd className="bt-num break-all">{candidate.vaultId}</dd>
              </div>
            </dl>
          </div>

          <Field htmlFor="vault-receive-name" label={t('vault.transfer.receiver.vaultName')}>
            <Input
              id="vault-receive-name"
              maxLength={VAULT_TRANSFER_NAME_MAX_CHARS}
              onChange={(event) => setVaultName(event.target.value)}
              value={vaultName}
            />
          </Field>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold">
              {t('vault.transfer.receiver.custody')}
            </legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                checked={custody === 'wrapped'}
                name="vault-transfer-custody"
                onChange={() => {
                  setCustody('wrapped');
                  setPlainAcknowledged(false);
                }}
                type="radio"
                value="wrapped"
              />
              <span>
                <strong className="block">{t('vault.transfer.receiver.wrapped')}</strong>
                <span className="bt-muted">{t('vault.transfer.receiver.wrappedHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                checked={custody === 'plain'}
                name="vault-transfer-custody"
                onChange={() => {
                  setCustody('plain');
                  setDevicePassword('');
                }}
                type="radio"
                value="plain"
              />
              <span>
                <strong className="block">{t('vault.transfer.receiver.plain')}</strong>
                <span className="bt-muted">{t('vault.transfer.receiver.plainHint')}</span>
              </span>
            </label>
          </fieldset>

          {custody === 'wrapped' ? (
            <Field
              htmlFor="vault-receive-device-password"
              hint={t('vault.transfer.receiver.devicePasswordHint')}
              label={t('vault.transfer.receiver.devicePassword')}
            >
              <Input
                autoComplete="new-password"
                id="vault-receive-device-password"
                onChange={(event) => setDevicePassword(event.target.value)}
                required
                type="password"
                value={devicePassword}
              />
            </Field>
          ) : (
            <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-4 text-sm">
              <p className="font-semibold text-amber-100">
                {t('vault.transfer.receiver.plainWarning')}
              </p>
              <label className="mt-3 flex items-start gap-2">
                <input
                  checked={plainAcknowledged}
                  onChange={(event) => setPlainAcknowledged(event.target.checked)}
                  type="checkbox"
                />
                <span>{t('vault.transfer.receiver.plainAcknowledgment')}</span>
              </label>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                working ||
                (custody === 'wrapped' && devicePassword.length === 0) ||
                (custody === 'plain' && !plainAcknowledged)
              }
              loading={working}
              type="submit"
              variant="primary"
            >
              {working ? t('vault.transfer.receiver.verifying') : t('vault.transfer.receiver.open')}
            </Button>
            <Button onClick={() => chooseSource(source)} type="button" variant="quiet">
              {t('vault.transfer.receiver.back')}
            </Button>
            {source === 'qr' ? (
              <Button onClick={() => chooseSource('manual')} type="button" variant="quiet">
                {t('vault.transfer.manualEntry')}
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}

export function payloadErrorKey(error: unknown): string {
  const outcome =
    error instanceof VaultTransferPayloadError ? error.outcome : ('invalid-mnemonic' as const);
  const keys: Record<VaultTransferPayloadErrorOutcome, string> = {
    'update-required': 'vault.transfer.receiver.errors.updateRequired',
    'missing-mnemonic': 'vault.transfer.receiver.errors.missingMnemonic',
    'missing-vault-id': 'vault.transfer.receiver.errors.missingVaultId',
    'invalid-mnemonic': 'vault.transfer.receiver.errors.invalidMnemonic',
    'invalid-vault-id': 'vault.transfer.receiver.errors.invalidVaultId',
    'invalid-name': 'vault.transfer.receiver.errors.invalidName',
    'invalid-fingerprint': 'vault.transfer.receiver.errors.invalidFingerprint',
  };
  return keys[outcome];
}

function receiveErrorKey(error: unknown): string {
  if (!(error instanceof EndpointKeystoreError)) {
    return 'vault.transfer.receiver.errors.operation';
  }
  switch (error.code) {
    case 'verification-failed':
      return 'vault.transfer.receiver.errors.verification';
    case 'wrong-password':
      return 'vault.transfer.receiver.errors.password';
    case 'locked-out':
      return 'vault.transfer.receiver.errors.passwordLocked';
    default:
      return 'vault.transfer.receiver.errors.operation';
  }
}
