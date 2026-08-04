import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { VaultMediaSet } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getTwoFactorStatus } from '../../../lib/twoFactorApi';
import { Button as OriginButton } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { AsyncReadState } from '../../components/AsyncReadState';
import { Alert, AuthCard, Button, CHECKBOX_STYLE, TextField } from '../../components/ui';
import { VaultCryptoError } from '../errors';
import { useVaultRuntime } from '../VaultRuntimeProvider';

/** What the §3 destruction exit re-authenticates with — one credential, like `DELETE /account`. */
export interface VaultDiscardCredential {
  confirmUsername: string;
  password?: string;
  code?: string;
}

/**
 * The locked-vault gate. It replaces the whole authenticated subtree, so — like
 * the PIN gate, which traps every route the same way and ships a Sign-out
 * button for exactly that reason — it must never be a dead end: a user who
 * cannot unlock can always sign out, and (§3) can always take the one recovery
 * BetterTrack has, which is destruction.
 */
export function VaultUnlockGate({
  mediaSet,
  onStartFresh,
}: {
  mediaSet: VaultMediaSet;
  /**
   * Discards the unrecoverable vault and returns the account to an empty normal
   * one (docs/paranoid-design.md §3). Omitted ⇒ the entry point is not offered,
   * so an isolated caller cannot destroy data it never wired up. The credential
   * it collects is verified by the SERVER; this form is the affordance, not the
   * gate.
   */
  onStartFresh?: (credential: VaultDiscardCredential) => Promise<void>;
}) {
  const t = useT();
  const runtime = useVaultRuntime();
  const { user, logout } = useAuth();
  const [passphrase, setPassphrase] = useState('');
  const [keepUnlocked, setKeepUnlocked] = useState(false);
  const [recoveryKit, setRecoveryKit] = useState<Uint8Array | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const trustedAttempted = useRef(false);
  const driveSelected = mediaSet.includes('drive');
  const busy = runtime.phase === 'unlocking';
  /*
   * The enable hand-off, carried by the only signal that survives it. The
   * wizard commits, flips the account mode from the receipt and starts the
   * automatic first unlock in the same turn — which swaps the whole
   * authenticated subtree for this gate, so §13's "migration progress → done"
   * frame is unmounted before it can paint and the user's last sight of a
   * one-way, irreversible flow would otherwise be a passphrase prompt.
   * Mounting while an unlock is ALREADY in flight is exactly that hand-off:
   * this gate never starts one at mount (the effect below requires 'locked'),
   * so somebody else owns it. Read once at mount, and never a lie either way —
   * an account that reaches this gate at all is paranoid, so its vault is on.
   */
  const [handedOverFromEnable] = useState(() => runtime.phase === 'unlocking');

  useEffect(() => {
    if (trustedAttempted.current || runtime.phase !== 'locked') return;
    trustedAttempted.current = true;
    void runtime.unlockFromDevice({ authorizeDrive: false, driveOnly: false });
  }, [runtime]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrorKey(null);
    try {
      const options = {
        authorizeDrive: driveSelected,
        driveOnly: mediaSet.length === 1 && driveSelected,
        keepUnlocked,
      };
      if (recoveryKit != null) {
        await runtime.unlockWithRecoveryKit(recoveryKit, options);
      } else {
        await runtime.unlockWithPassphrase(passphrase, options);
      }
    } catch (cause) {
      setErrorKey(unlockErrorKey(cause));
    }
  }

  return (
    <AuthCard subtitle={t('vault.unlock.title')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {handedOverFromEnable && errorKey == null ? (
          <Alert tone="success">{t('vault.enable.done')}</Alert>
        ) : null}
        <p className="bt-soft text-sm">{t('vault.unlock.description')}</p>

        <TextField
          autoComplete="current-password"
          disabled={busy || recoveryKit != null}
          label={t('vault.unlock.passphrase')}
          onChange={(event) => setPassphrase(event.target.value)}
          required={recoveryKit == null}
          type="password"
          value={passphrase}
        />

        <label className="bt-soft flex items-start gap-2 text-sm">
          <input
            checked={keepUnlocked}
            disabled={busy}
            onChange={(event) => setKeepUnlocked(event.target.checked)}
            style={CHECKBOX_STYLE}
            type="checkbox"
          />
          <span>
            {t('vault.unlock.keepUnlocked')}
            <span className="bt-muted mt-1 block text-xs">
              {t('vault.unlock.keepUnlockedHint')}
            </span>
          </span>
        </label>

        <div className="bt-panel flex flex-col gap-2 p-3">
          <label className="bt-row-title" htmlFor="vault-recovery-kit">
            {t('vault.unlock.recoveryKit')}
          </label>
          <input
            accept=".txt,text/plain"
            disabled={busy}
            id="vault-recovery-kit"
            onChange={(event) => {
              const file = event.target.files?.[0];
              setRecoveryKit(null);
              if (file == null) return;
              setErrorKey(null);
              // A gate whose job is to fail closed must also fail legibly: an
              // unreadable file (permission denied, removed medium) says so
              // instead of leaving the form armed with no kit.
              void file.arrayBuffer().then(
                (buffer) => setRecoveryKit(new Uint8Array(buffer)),
                () => setErrorKey('vault.unlock.errors.recoveryKitUnreadable'),
              );
            }}
            type="file"
          />
          <p className="bt-row-sub">{t('vault.unlock.recoveryKitHint')}</p>
        </div>

        {driveSelected ? (
          <p className="bt-muted text-xs">{t('vault.unlock.driveGesture')}</p>
        ) : null}
        {errorKey ? <Alert tone="error">{t(errorKey)}</Alert> : null}

        <Button disabled={busy || (recoveryKit == null && passphrase.length === 0)} type="submit">
          {busy ? t('vault.unlock.unlocking') : t('vault.unlock.action')}
        </Button>
      </form>

      {/* Outside the unlock form on purpose: neither action may be reachable by
          an Enter keypress meant for the passphrase. */}
      <div className="mt-4 flex flex-col gap-3">
        <Button disabled={busy} onClick={() => void logout()} type="button" variant="ghost">
          {t('auth.common.signOut')}
        </Button>
        {onStartFresh ? (
          <StuckFold
            driveSelected={driveSelected}
            onStartFresh={onStartFresh}
            username={user?.username ?? null}
          />
        ) : null}
      </div>
    </AuthCard>
  );
}

/**
 * The §3 recovery story, folded away (anti-bloat) until a stuck user opens it:
 * BetterTrack holds no escrow, so the only exit that does not need the key is
 * destruction. Friction is the account-deletion rung, in full: the username has
 * to be typed AND a credential re-verified — both server-side (see
 * `paranoidDiscardReauth`). This form only collects them; a caller POSTing the
 * endpoint from a live session faces exactly the same two gates.
 */
function StuckFold({
  driveSelected,
  onStartFresh,
  username,
}: {
  driveSelected: boolean;
  onStartFresh: (credential: VaultDiscardCredential) => Promise<void>;
  username: string | null;
}) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirmed =
    username != null && typed.trim().toLowerCase() === username.trim().toLowerCase();

  // Only a TOTP-enrolled account can re-auth with a code instead of a password
  // — the same read the deletion page makes. A failed/absent status simply
  // leaves the password field, which every account has.
  const twoFactor = useQuery({
    queryKey: ['auth', '2fa', 'status'],
    queryFn: ({ signal }) => getTwoFactorStatus(signal),
    staleTime: 30_000,
    retry: false,
  });
  const codeAvailable = twoFactor.data?.totpEnabled === true;
  const credentialEntered = useCode && codeAvailable ? code.trim().length > 0 : password.length > 0;

  async function startFresh() {
    if (!confirmed || !credentialEntered || working) return;
    setWorking(true);
    setFailed(false);
    try {
      await onStartFresh({
        confirmUsername: typed.trim(),
        ...(useCode && codeAvailable ? { code: code.trim() } : { password }),
      });
    } catch {
      setFailed(true);
      setWorking(false);
    }
  }

  return (
    <details className="bt-panel p-3">
      <summary className="bt-row-title cursor-pointer">{t('vault.unlock.stuck.title')}</summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="bt-soft text-sm">{t('vault.unlock.stuck.body')}</p>
        <p className="bt-muted text-xs">{t('vault.unlock.stuck.keptHint')}</p>
        {/* Nothing can reach the user's Drive without a decrypted session, so
            the leftover ciphertext there is theirs to remove — say so instead
            of leaving a file behind after a screen that promised removal. */}
        {driveSelected ? (
          <p className="bt-muted text-xs">{t('vault.unlock.stuck.driveLeftover')}</p>
        ) : null}
        <AsyncReadState
          loading={twoFactor.isLoading}
          error={twoFactor.error}
          onRetry={() => void twoFactor.refetch()}
        />
        <TextField
          autoComplete="off"
          disabled={working}
          id="vault-start-fresh-confirm"
          label={t('vault.unlock.stuck.confirmLabel', { username: username ?? '' })}
          onChange={(event) => setTyped(event.target.value)}
          value={typed}
        />
        {useCode && codeAvailable ? (
          <TextField
            autoComplete="one-time-code"
            disabled={working}
            id="vault-start-fresh-code"
            inputMode="numeric"
            label={t('vault.unlock.stuck.codeLabel')}
            onChange={(event) => setCode(event.target.value)}
            value={code}
          />
        ) : (
          <TextField
            autoComplete="current-password"
            disabled={working}
            id="vault-start-fresh-password"
            label={t('vault.unlock.stuck.passwordLabel')}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        )}
        {/* The account password, NOT the vault passphrase — a stuck user has by
            definition lost the latter. */}
        <p className="bt-muted text-xs">{t('vault.unlock.stuck.credentialHint')}</p>
        {codeAvailable ? (
          <button
            className="bt-link self-start text-xs"
            disabled={working}
            onClick={() => setUseCode((previous) => !previous)}
            type="button"
          >
            {t(useCode ? 'vault.unlock.stuck.usePassword' : 'vault.unlock.stuck.useCode')}
          </button>
        ) : null}
        {failed ? <Alert tone="error">{t('vault.unlock.stuck.error')}</Alert> : null}
        <OriginButton
          disabled={!confirmed || !credentialEntered || working}
          onClick={() => void startFresh()}
          size="sm"
          type="button"
          variant="danger"
        >
          {working ? t('vault.unlock.stuck.working') : t('vault.unlock.stuck.action')}
        </OriginButton>
      </div>
    </details>
  );
}

function unlockErrorKey(cause: unknown): string {
  if (!(cause instanceof VaultCryptoError)) return 'vault.unlock.errors.unavailable';
  switch (cause.code) {
    case 'authentication-failed':
      return 'vault.unlock.errors.wrongPassphrase';
    case 'recovery-kit-invalid':
      return 'vault.unlock.errors.recoveryKit';
    case 'update-required':
      return 'vault.unlock.errors.updateRequired';
    case 'document-invalid':
    case 'envelope-invalid':
      return 'vault.unlock.errors.corrupt';
    case 'custody-failed':
      return 'vault.unlock.errors.custody';
    case 'storage-failed':
    case 'locked':
    case 'kdf-failed':
    case 'unsupported-crypto':
      return 'vault.unlock.errors.unavailable';
  }
}
