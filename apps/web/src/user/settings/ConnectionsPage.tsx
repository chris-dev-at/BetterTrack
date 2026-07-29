import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { formatDateTime } from '../../lib/format';
import {
  getGoogleLinkStatus,
  getParanoidMediaState,
  googleStartUrl,
  unlinkGoogle,
} from '../../lib/userApi';
import { EmptyState, Skeleton } from '../../ui';
import { Badge, Button, Field, Input, SectionHead, type BadgeTone } from '../../ui/origin';
import { Alert } from '../components/ui';
import type {
  DriveConnectionActionResult,
  DriveConnectionController,
  VaultRetiredPurgeResult,
} from '../vault/media';
import { VAULT_MEDIA_QUERY_KEY } from '../vault/usePrivacyMode';
import {
  useOptionalVaultRuntime,
  type VaultDriveUnlockOptions,
} from '../vault/VaultRuntimeProvider';

const GOOGLE_KEY = ['auth', 'google', 'link-status'] as const;
// One shared key so this page's fetch also serves `usePrivacyMode` (and vice
// versa) — kept as a single definition so the two can never drift apart.
const VAULT_MEDIA_KEY = VAULT_MEDIA_QUERY_KEY;

/**
 * Map a Settings-connect failure the callback bounced back as `?error=google_*`
 * to a friendly message (owner order 2026-07-16). The headline case is
 * `google_email_mismatch`: a connect is email-match-only, so only the Google
 * account whose verified email equals this account's email may be linked.
 * Anything not a `google_*` code (or absent) is not a connect error → `null`.
 */
function connectErrorMessage(t: TranslateFn, code: string | null): string | null {
  if (!code || !code.startsWith('google_')) return null;
  switch (code) {
    case 'google_email_mismatch':
      return t('settings.security.google.errorMismatch');
    case 'google_already_linked':
      return t('settings.security.google.errorAlreadyLinked');
    case 'google_admin':
      return t('settings.security.google.errorAdmin');
    default:
      return t('settings.security.google.genericError');
  }
}

/**
 * Google account link/unlink (PROJECTPLAN.md §13.4 V4-P4b; moved to Connections
 * in V5-P0c). Shows the linked Google identity and offers an unlink (password
 * re-auth), or a "Connect Google" affordance when unlinked. Env-gated: a 404 (or
 * `enabled: false`) hides the whole section. Unlink is refused while Google is
 * the only usable sign-in method (`canUnlink: false`) — surfaced as a hint, and
 * the button is withheld. Behaviour is byte-identical to the former Security
 * placement — only the home surface changed.
 */
function GoogleSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [unlinking, setUnlinking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A connect failure the callback bounced back (e.g. email mismatch) — kept
  // separate from the unlink-form `error` so the two never collide.
  const [connectError] = useState<string | null>(() =>
    connectErrorMessage(t, searchParams.get('error')),
  );
  const [notice, setNotice] = useState<string | null>(
    searchParams.get('google') === 'linked' ? t('settings.security.google.linkedNotice') : null,
  );

  // Consume the `?google=linked` / `?error=google_*` markers the connect callback
  // bounced back, so a refresh doesn't keep re-announcing them. Run once on mount —
  // the markers are one-shot handoffs from the redirect.
  useEffect(() => {
    const err = searchParams.get('error');
    if (searchParams.get('google') || (err && err.startsWith('google_'))) {
      const next = new URLSearchParams(searchParams);
      next.delete('google');
      if (err && err.startsWith('google_')) next.delete('error');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const query = useQuery({
    queryKey: GOOGLE_KEY,
    queryFn: ({ signal }) => getGoogleLinkStatus(signal),
    staleTime: 30_000,
    retry: false,
  });

  const unlink = useMutation({
    mutationFn: () => unlinkGoogle(password),
    onSuccess: async () => {
      setUnlinking(false);
      setPassword('');
      setError(null);
      setNotice(t('settings.security.google.unlinkedNotice'));
      await queryClient.invalidateQueries({ queryKey: GOOGLE_KEY });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) {
        setError(t('settings.security.google.wrongPassword'));
      } else if (err instanceof ApiError && err.code === 'GOOGLE_ONLY_SIGN_IN') {
        setError(t('settings.security.google.onlyMethod'));
      } else {
        setError(t('settings.security.google.genericError'));
      }
    },
  });

  // Feature off on this deployment (the routes 404) → render nothing at all.
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) return null;
    return (
      <section className="bt-panel bt-panel--pad flex flex-col gap-3">
        <h3 className="bt-h3">{t('settings.security.google.title')}</h3>
        <EmptyState
          title={t('settings.security.google.loadError')}
          description={t('settings.retryHint')}
        />
      </section>
    );
  }
  if (query.isPending) {
    return (
      <section className="bt-panel bt-panel--pad flex flex-col gap-3">
        <h3 className="bt-h3">{t('settings.security.google.title')}</h3>
        <Skeleton height="h-6" />
      </section>
    );
  }
  if (!query.data.enabled) return null;
  const status = query.data;

  return (
    <section className="bt-panel bt-panel--pad flex flex-col gap-3">
      <h3 className="bt-h3">{t('settings.security.google.title')}</h3>
      <p className="bt-meta">{t('settings.security.google.description')}</p>
      {connectError ? <Alert tone="error">{connectError}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {status.linked ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col items-start gap-1">
            {/* The linked identity IS the status — one badge, no duplicate line. */}
            <Badge tone="pos">
              {t('settings.security.google.linkedAs', { email: status.email ?? '' })}
            </Badge>
            {status.linkedAt ? (
              <p className="bt-meta">
                {t('settings.security.google.linkedOn', {
                  date: formatDateTime(status.linkedAt),
                })}
              </p>
            ) : null}
          </div>
          {status.canUnlink ? (
            unlinking ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  setError(null);
                  unlink.mutate();
                }}
              >
                {error ? <Alert tone="error">{error}</Alert> : null}
                <p className="bt-meta">{t('settings.security.google.unlinkPrompt')}</p>
                <Field
                  className="max-w-sm"
                  htmlFor="google-unlink-password"
                  label={t('settings.security.google.passwordLabel')}
                >
                  <Input
                    autoComplete="current-password"
                    id="google-unlink-password"
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    disabled={unlink.isPending || password.length === 0}
                    type="submit"
                    variant="danger"
                  >
                    {t('settings.security.google.confirmUnlink')}
                  </Button>
                  <Button
                    onClick={() => {
                      setUnlinking(false);
                      setError(null);
                      setPassword('');
                    }}
                    type="button"
                    variant="quiet"
                  >
                    {t('settings.security.google.cancel')}
                  </Button>
                </div>
              </form>
            ) : (
              <div>
                <Button onClick={() => setUnlinking(true)}>
                  {t('settings.security.google.unlinkButton')}
                </Button>
              </div>
            )
          ) : (
            <Alert tone="info">{t('settings.security.google.onlyMethod')}</Alert>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <Badge>{t('settings.security.google.notLinked')}</Badge>
          <a className="bt-btn" href={googleStartUrl()}>
            {t('settings.security.google.connectButton')}
          </a>
        </div>
      )}
    </section>
  );
}

type DriveCardAction = 'connect' | 'disconnect' | 'drive-only' | 'add-server' | 'purge';

/** Status → badge tone: live is positive, "needs you" is gold, idle is quiet. */
const DRIVE_STATUS_TONE: Record<string, BadgeTone> = {
  connected: 'pos',
  needsSignIn: 'gold',
  working: 'blue',
  disconnected: 'neutral',
};

function useDriveAuthorization(connection: DriveConnectionController | null) {
  const subscribe = useCallback(
    (listener: () => void) => connection?.subscribeAuthorization(listener) ?? (() => undefined),
    [connection],
  );
  const getSnapshot = useCallback(() => connection?.authorization ?? null, [connection]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function DriveVaultSection({
  connection,
  configured,
  unlock,
}: {
  connection: DriveConnectionController | null;
  configured: boolean;
  unlock:
    | ((passphrase: string, options: VaultDriveUnlockOptions) => Promise<DriveConnectionController>)
    | null;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'error' | 'success' | 'info';
    key: string;
  } | null>(null);
  const [unlockAction, setUnlockAction] = useState<DriveCardAction | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const authorization = useDriveAuthorization(connection);
  const query = useQuery({
    queryKey: VAULT_MEDIA_KEY,
    queryFn: ({ signal }) => getParanoidMediaState(signal),
    retry: false,
    staleTime: 15_000,
  });

  if (query.isError) {
    return (
      <section className="bt-panel bt-panel--pad flex flex-col gap-3">
        <h3 className="bt-h3">{t('settings.connections.drive.title')}</h3>
        <EmptyState
          title={t('settings.connections.drive.loadError')}
          description={t('settings.retryHint')}
        />
      </section>
    );
  }
  if (query.isPending) {
    return (
      <section className="bt-panel bt-panel--pad flex flex-col gap-3">
        <h3 className="bt-h3">{t('settings.connections.drive.title')}</h3>
        <Skeleton height="h-6" />
      </section>
    );
  }

  if (query.data.privacyMode !== 'paranoid' || query.data.mediaState == null) return null;
  const media = query.data.mediaState;
  const selected = media.mediaSet.includes('drive');
  if (!configured && !selected) return null;

  const needsSignIn = selected && authorization !== 'connected';
  const statusKey = working
    ? 'working'
    : selected
      ? needsSignIn
        ? 'needsSignIn'
        : 'connected'
      : 'disconnected';
  const retired = media.server.retired;
  const canPurgeRetiredServer =
    retired != null &&
    media.server.disposition === 'retired' &&
    !media.mediaSet.includes('server') &&
    media.server.candidate == null;
  const purgeReady = retired != null && Date.now() >= Date.parse(retired.purgeAfter);

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: VAULT_MEDIA_KEY });
  }

  function requireUnlocked(action: DriveCardAction): boolean {
    if (connection) return false;
    if (configured && unlock) {
      setMessage(null);
      setUnlockAction(action);
      return true;
    }
    setMessage({
      tone: 'info',
      key: configured
        ? 'settings.connections.drive.unlockRequired'
        : 'settings.connections.drive.configMissing',
    });
    return true;
  }

  function actionFailed(result: DriveConnectionActionResult | VaultRetiredPurgeResult): boolean {
    return (
      result.status === 'authorization-required' ||
      result.status === 'failed' ||
      result.status === 'last-medium'
    );
  }

  function failureKey(result: DriveConnectionActionResult): string {
    if (result.status === 'last-medium') return 'settings.connections.drive.lastMedium';
    if (result.status === 'failed') {
      if (result.stage === 'preflight-sync') return 'settings.connections.drive.syncRequired';
      if (result.stage === 'authenticate-drive') {
        return 'settings.connections.drive.unreadableLeftover';
      }
    }
    return 'settings.connections.drive.actionError';
  }

  async function perform(
    action: DriveCardAction,
    activeConnection: DriveConnectionController,
  ): Promise<void> {
    if (action === 'purge') {
      const result = await activeConnection.purgeRetiredServer();
      if (result.status === 'ok') {
        setMessage({ tone: 'success', key: 'settings.connections.drive.purgedNotice' });
        await refresh();
      } else {
        setMessage({ tone: 'error', key: 'settings.connections.drive.purgeError' });
      }
      return;
    }

    const result =
      action === 'connect'
        ? await activeConnection.connect()
        : action === 'disconnect'
          ? await activeConnection.disconnect()
          : action === 'drive-only'
            ? await activeConnection.useDriveOnly()
            : await activeConnection.addServerCopy();
    if (!actionFailed(result)) {
      const synchronizationPending =
        result.status !== 'authorization-required' && result.synchronization?.status === 'pending';
      if (result.status === 'drive-leftover') {
        setMessage({
          tone: 'info',
          key: synchronizationPending
            ? 'settings.connections.drive.leftoverSyncPending'
            : 'settings.connections.drive.leftover',
        });
      } else if (synchronizationPending) {
        setMessage({ tone: 'info', key: 'settings.connections.drive.syncPending' });
      } else {
        setMessage({
          tone: 'success',
          key:
            action === 'connect'
              ? 'settings.connections.drive.connectedNotice'
              : action === 'disconnect'
                ? 'settings.connections.drive.disconnectedNotice'
                : action === 'drive-only'
                  ? 'settings.connections.drive.storage.driveOnlyNotice'
                  : 'settings.connections.drive.storage.serverAddedNotice',
        });
      }
      await refresh();
    } else {
      setMessage({ tone: 'error', key: failureKey(result) });
    }
  }

  async function run(action: DriveCardAction): Promise<void> {
    if (requireUnlocked(action)) return;
    setWorking(true);
    setMessage(null);
    try {
      await perform(action, connection!);
    } catch {
      setMessage({
        tone: 'error',
        key:
          action === 'purge'
            ? 'settings.connections.drive.purgeError'
            : 'settings.connections.drive.actionError',
      });
    } finally {
      setWorking(false);
    }
  }

  async function unlockAndContinue(): Promise<void> {
    if (!unlock || !unlockAction || passphrase.length === 0) return;
    setWorking(true);
    setMessage(null);
    let activeConnection: DriveConnectionController;
    try {
      activeConnection = await unlock(passphrase, {
        authorizeDrive: true,
        driveOnly: media.mediaSet.length === 1 && media.mediaSet[0] === 'drive',
      });
    } catch {
      setMessage({ tone: 'error', key: 'settings.connections.drive.unlockError' });
      setWorking(false);
      return;
    }
    const action = unlockAction;
    setPassphrase('');
    setUnlockAction(null);
    try {
      await perform(action, activeConnection);
    } catch {
      setMessage({ tone: 'error', key: 'settings.connections.drive.actionError' });
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="bt-panel bt-panel--pad flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="bt-h3">{t('settings.connections.drive.title')}</h3>
        <Badge tone={DRIVE_STATUS_TONE[statusKey] ?? 'neutral'}>
          {t(`settings.connections.drive.status.${statusKey}`)}
        </Badge>
      </div>
      <p className="bt-meta">{t('settings.connections.drive.description')}</p>
      {message ? <Alert tone={message.tone}>{t(message.key)}</Alert> : null}
      {!configured ? (
        <Alert tone="info">{t('settings.connections.drive.configMissing')}</Alert>
      ) : null}
      {unlockAction ? (
        <form
          className="bt-panel bt-panel--soft flex max-w-sm flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void unlockAndContinue();
          }}
          style={{ padding: 14 }}
        >
          <p className="bt-meta">{t('settings.connections.drive.unlockPrompt')}</p>
          <Field
            htmlFor="drive-vault-passphrase"
            label={t('settings.connections.drive.passphraseLabel')}
          >
            <Input
              autoComplete="current-password"
              autoFocus
              disabled={working}
              id="drive-vault-passphrase"
              onChange={(event) => setPassphrase(event.target.value)}
              required
              type="password"
              value={passphrase}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={working || passphrase.length === 0} type="submit">
              {t('settings.connections.drive.unlockAndContinue')}
            </Button>
            <Button
              disabled={working}
              onClick={() => {
                setUnlockAction(null);
                setPassphrase('');
              }}
              type="button"
              variant="quiet"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {selected && media.mediaSet.length === 1 ? (
        <Alert tone="info">{t('settings.connections.drive.lastMedium')}</Alert>
      ) : null}
      {selected ? (
        <details className="bt-panel bt-panel--soft" style={{ padding: '9px 13px' }}>
          <summary className="bt-h3 cursor-pointer">
            {t('settings.connections.drive.storage.title')}
          </summary>
          <div className="mt-2 flex flex-col items-start gap-2">
            <p className="bt-meta">
              {t(
                media.mediaSet.includes('server')
                  ? 'settings.connections.drive.storage.both'
                  : 'settings.connections.drive.storage.driveOnly',
              )}
            </p>
            <Button
              disabled={working || !configured}
              onClick={() =>
                void run(media.mediaSet.includes('server') ? 'drive-only' : 'add-server')
              }
              size="sm"
              type="button"
            >
              {t(
                media.mediaSet.includes('server')
                  ? 'settings.connections.drive.storage.useDriveOnly'
                  : 'settings.connections.drive.storage.addServer',
              )}
            </Button>
          </div>
        </details>
      ) : null}
      {canPurgeRetiredServer ? (
        <details className="bt-panel bt-panel--soft" style={{ padding: '9px 13px' }}>
          <summary className="bt-h3 cursor-pointer">
            {t('settings.connections.drive.retired.title')}
          </summary>
          <div className="mt-2 flex flex-col items-start gap-2">
            <p className="bt-meta">
              {t(
                purgeReady
                  ? 'settings.connections.drive.retired.ready'
                  : 'settings.connections.drive.retired.wait',
                { date: formatDateTime(retired.purgeAfter) },
              )}
            </p>
            <Button
              disabled={working || !purgeReady || !configured}
              onClick={() => void run('purge')}
              size="sm"
              type="button"
              variant="danger"
            >
              {t('settings.connections.drive.retired.purge')}
            </Button>
          </div>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {configured && (!selected || needsSignIn) ? (
          <Button
            disabled={working}
            onClick={() => void run('connect')}
            type="button"
            variant="primary"
          >
            {t(
              selected ? 'settings.connections.drive.signIn' : 'settings.connections.drive.connect',
            )}
          </Button>
        ) : null}
        {configured && selected && media.mediaSet.length > 1 ? (
          <Button
            disabled={working}
            onClick={() => void run('disconnect')}
            type="button"
            variant="quiet"
          >
            {t('settings.connections.drive.disconnect')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The v6 connectors, as designed-but-inert slots (V5-P0c). Each names itself,
 * says what it does in one line, states its sync semantics (a one-time import
 * vs a connection that stays live and auto-syncs), and wears a plain "coming
 * soon" state — no dead buttons (anti-bloat). The whole set folds away in a
 * collapsed `<details>` so the live Google identity stays the visible thing.
 */
const CONNECTOR_SLOTS = [
  { key: 'bankCash', sync: 'stayConnected' },
  { key: 'parqet', sync: 'oneTime' },
] as const;

function ConnectorSlot({ slotKey, sync }: { slotKey: string; sync: 'oneTime' | 'stayConnected' }) {
  const t = useT();
  return (
    <li className="bt-band__row flex flex-col gap-1" style={{ paddingInline: 0 }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="bt-row-title">{t(`settings.connections.slots.${slotKey}.name`)}</span>
        <Badge outline>{t('settings.connections.comingSoon')}</Badge>
      </div>
      <p className="bt-row-sub">{t(`settings.connections.slots.${slotKey}.purpose`)}</p>
      <p className="bt-row-sub" style={{ color: 'var(--bt-faint)' }}>
        {t(
          sync === 'oneTime'
            ? 'settings.connections.sync.oneTime'
            : 'settings.connections.sync.stayConnected',
        )}
      </p>
    </li>
  );
}

function ConnectorSlots() {
  const t = useT();
  return (
    <details className="bt-panel group">
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-3"
        style={{ padding: '15px 20px' }}
      >
        <span className="flex flex-col gap-0.5">
          <span className="bt-h3">{t('settings.connections.slotsTitle')}</span>
          <span className="bt-meta">{t('settings.connections.slotsSubtitle')}</span>
        </span>
        <span
          aria-hidden="true"
          className="transition-transform group-open:rotate-90"
          style={{ color: 'var(--bt-faint)' }}
        >
          ▸
        </span>
      </summary>
      <ul className="bt-band bt-t-rule flex flex-col" style={{ padding: '0 20px 6px' }}>
        {CONNECTOR_SLOTS.map((slot) => (
          <ConnectorSlot key={slot.key} slotKey={slot.key} sync={slot.sync} />
        ))}
      </ul>
    </details>
  );
}

/**
 * Settings → Connections (PROJECTPLAN.md §13.5 V5-P0c). The single home for
 * everything that links BetterTrack to the outside: the Google sign-in identity
 * (moved here from Security, behaviour unchanged) sits up top as the live thing,
 * and the future connectors fold away below as compact designed placeholders.
 */
export function ConnectionsPage({
  driveConnection,
  driveUnlock,
  driveConfigured = Boolean(import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID),
}: {
  driveConnection?: DriveConnectionController | null;
  driveUnlock?:
    | ((passphrase: string, options: VaultDriveUnlockOptions) => Promise<DriveConnectionController>)
    | null;
  driveConfigured?: boolean;
} = {}) {
  const t = useT();
  const runtime = useOptionalVaultRuntime();
  const resolvedDriveConnection =
    driveConnection === undefined ? (runtime?.connection ?? null) : driveConnection;
  const resolvedDriveUnlock =
    driveUnlock === undefined ? (runtime?.unlockWithPassphrase ?? null) : driveUnlock;
  return (
    <div className="flex flex-col gap-5">
      <SectionHead
        sub={t('settings.connections.subtitle')}
        title={t('settings.connections.title')}
      />

      <GoogleSection />

      <DriveVaultSection
        connection={resolvedDriveConnection}
        configured={driveConfigured}
        unlock={resolvedDriveUnlock}
      />

      <ConnectorSlots />
    </div>
  );
}
