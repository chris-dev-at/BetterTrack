import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { formatDateTime } from '../../../lib/format';
import { getGoogleDriveClientId } from '../../../lib/runtimeConfig';
import {
  getGoogleLinkStatus,
  getParanoidMediaState,
  googleStartUrl,
  unlinkGoogle,
} from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Badge, Button, Field, Input, type BadgeTone } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import type {
  DriveConnectionActionResult,
  DriveConnectionController,
  VaultRetiredPurgeResult,
} from '../../vault/media';
import { useResolvedPrivacyModeState, vaultMediaQueryKey } from '../../vault/usePrivacyMode';
import {
  useOptionalVaultRuntime,
  type VaultDriveUnlockOptions,
} from '../../vault/VaultRuntimeContext';
import {
  PanelFold,
  PanelForm,
  PanelGroup,
  PanelHead,
  PanelList,
  PanelListItem,
  PanelNote,
  Row,
} from './panelKit';

const GOOGLE_KEY = ['auth', 'google', 'link-status'] as const;
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
 * in V5-P0c, compacted into the Control Center's row grammar in R2). Shows the
 * linked Google identity and offers an unlink (password re-auth), or a "Connect
 * Google" affordance when unlinked. Env-gated: a 404 (or `enabled: false`) hides
 * the whole group. Unlink is refused while Google is the only usable sign-in
 * method (`canUnlink: false`) — surfaced as the group's one note line, and the
 * button is withheld. Behaviour is byte-identical to the page it replaced: same
 * query key, same mutation, same error mapping, same one-shot marker consumption.
 *
 * The group label is a real `<h3>` ("Google account"), which is the heading the
 * Google e2e flow looks for.
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
      <PanelGroup label={t('settings.security.google.title')}>
        <Row stack>
          <PanelNote>{t('settings.security.google.loadError')}</PanelNote>
          <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>
        </Row>
      </PanelGroup>
    );
  }
  if (query.isPending) {
    return (
      <PanelGroup label={t('settings.security.google.title')}>
        <Row stack>
          <Skeleton height="h-4" width="w-40" />
        </Row>
      </PanelGroup>
    );
  }
  if (!query.data.enabled) return null;
  const status = query.data;

  return (
    <PanelGroup label={t('settings.security.google.title')}>
      {connectError ? (
        <Row stack>
          <Alert tone="error">{connectError}</Alert>
        </Row>
      ) : null}
      {notice ? (
        <Row stack>
          <Alert tone="success">{notice}</Alert>
        </Row>
      ) : null}

      {status.linked ? (
        <>
          {/* The linked identity IS the status — one badge, no duplicate line. */}
          <Row
            hint={
              status.linkedAt
                ? t('settings.security.google.linkedOn', { date: formatDateTime(status.linkedAt) })
                : undefined
            }
            label={
              <Badge tone="pos">
                {t('settings.security.google.linkedAs', { email: status.email ?? '' })}
              </Badge>
            }
          >
            {status.canUnlink && !unlinking ? (
              <Button onClick={() => setUnlinking(true)} size="sm">
                {t('settings.security.google.unlinkButton')}
              </Button>
            ) : null}
          </Row>

          {/* The one constraint worth a line: an unlink is refused while Google
              is the only usable sign-in method. */}
          {status.canUnlink ? null : (
            <Row stack>
              <PanelNote warn>{t('settings.security.google.onlyMethod')}</PanelNote>
            </Row>
          )}

          {status.canUnlink && unlinking ? (
            <Row stack>
              <PanelForm
                onSubmit={(e) => {
                  e.preventDefault();
                  setError(null);
                  unlink.mutate();
                }}
              >
                {error ? <Alert tone="error">{error}</Alert> : null}
                <Field
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
                    size="sm"
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
                    size="sm"
                    type="button"
                    variant="quiet"
                  >
                    {t('settings.security.google.cancel')}
                  </Button>
                </div>
              </PanelForm>
            </Row>
          ) : null}
        </>
      ) : (
        <Row label={<Badge>{t('settings.security.google.notLinked')}</Badge>}>
          <a className="bt-btn bt-btn--sm" href={googleStartUrl()}>
            {t('settings.security.google.connectButton')}
          </a>
        </Row>
      )}
    </PanelGroup>
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

/**
 * The paranoid vault's Drive medium (§13.5 V5-P13/PD6), as popup rows: the live
 * status badge with its actions on one line, the storage-copy and retained-copy
 * blocks folded away, and the passphrase unlock as the panel's narrow inline
 * form. Every transition still runs through the media controller — same
 * verified-copy semantics, same messages, same `['vault','media']` refresh.
 */
function DriveVaultSection({
  accountId,
  connection,
  configured,
  unlock,
}: {
  accountId: string | null;
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
  const mediaQueryKey = vaultMediaQueryKey(accountId);
  const query = useQuery({
    queryKey: mediaQueryKey,
    queryFn: ({ signal }) => getParanoidMediaState(signal),
    retry: false,
    staleTime: 15_000,
  });

  if (query.isError) {
    return (
      <PanelGroup label={t('settings.connections.drive.title')}>
        <Row stack>
          <PanelNote>{t('settings.connections.drive.loadError')}</PanelNote>
          <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>
        </Row>
      </PanelGroup>
    );
  }
  if (query.isPending) {
    return (
      <PanelGroup label={t('settings.connections.drive.title')}>
        <Row stack>
          <Skeleton height="h-4" width="w-40" />
        </Row>
      </PanelGroup>
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
    await queryClient.invalidateQueries({ queryKey: mediaQueryKey, exact: true });
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
    <PanelGroup label={t('settings.connections.drive.title')}>
      {/* Status left, its two actions right — the whole live surface on one row. */}
      <Row
        label={
          <Badge tone={DRIVE_STATUS_TONE[statusKey] ?? 'neutral'}>
            {t(`settings.connections.drive.status.${statusKey}`)}
          </Badge>
        }
      >
        {configured && (!selected || needsSignIn) ? (
          <Button
            disabled={working}
            onClick={() => void run('connect')}
            size="sm"
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
            size="sm"
            variant="quiet"
          >
            {t('settings.connections.drive.disconnect')}
          </Button>
        ) : null}
      </Row>

      {/* The one kept line of Drive prose: it states the access scope — the
          app-data folder only, never ordinary Drive files. */}
      <Row stack>
        <PanelNote>{t('settings.connections.drive.description')}</PanelNote>
      </Row>

      {message ? (
        <Row stack>
          <Alert tone={message.tone}>{t(message.key)}</Alert>
        </Row>
      ) : null}
      {!configured ? (
        <Row stack>
          <PanelNote warn>{t('settings.connections.drive.configMissing')}</PanelNote>
        </Row>
      ) : null}
      {selected && media.mediaSet.length === 1 ? (
        <Row stack>
          <PanelNote warn>{t('settings.connections.drive.lastMedium')}</PanelNote>
        </Row>
      ) : null}

      {unlockAction ? (
        <Row stack>
          <PanelForm
            onSubmit={(event) => {
              event.preventDefault();
              void unlockAndContinue();
            }}
          >
            {/* Kept: the passphrase is asked for mid-flow because Drive
                authorization and the migration continue from THIS gesture. */}
            <PanelNote>{t('settings.connections.drive.unlockPrompt')}</PanelNote>
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
              <Button disabled={working || passphrase.length === 0} size="sm" type="submit">
                {t('settings.connections.drive.unlockAndContinue')}
              </Button>
              <Button
                disabled={working}
                onClick={() => {
                  setUnlockAction(null);
                  setPassphrase('');
                }}
                size="sm"
                type="button"
                variant="quiet"
              >
                {t('common.cancel')}
              </Button>
            </div>
          </PanelForm>
        </Row>
      ) : null}

      {selected ? (
        <PanelFold summary={t('settings.connections.drive.storage.title')}>
          <div className="flex flex-col items-start gap-2">
            <PanelNote>
              {t(
                media.mediaSet.includes('server')
                  ? 'settings.connections.drive.storage.both'
                  : 'settings.connections.drive.storage.driveOnly',
              )}
            </PanelNote>
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
        </PanelFold>
      ) : null}

      {canPurgeRetiredServer ? (
        <Row stack>
          <div className="flex flex-col items-start gap-2">
            <span className="bt-cc-row__label">
              {t('settings.connections.drive.retired.title')}
            </span>
            {/* This state is intentionally outside every fold: Drive-only is
                not a zero-server-bytes claim until this dated recovery copy is
                gone. The hourly job finishes it automatically; the button is
                the post-window "delete now" shortcut. */}
            <Alert tone="info">
              {t(
                purgeReady
                  ? 'settings.connections.drive.retired.ready'
                  : 'settings.connections.drive.retired.wait',
                { date: formatDateTime(retired.purgeAfter) },
              )}
            </Alert>
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
        </Row>
      ) : null}
    </PanelGroup>
  );
}

/**
 * The v6 connectors, as designed-but-inert slots (V5-P0c). Each names itself,
 * says what it does in one line, states its sync semantics (a one-time import
 * vs a connection that stays live and auto-syncs), and wears a plain "coming
 * soon" chip — no dead buttons (anti-bloat). In the popup they are two dense
 * list rows rather than a folded card: the fold and its "these are on the way"
 * subtitle were pure narration.
 */
const CONNECTOR_SLOTS = [
  { key: 'bankCash', sync: 'stayConnected' },
  { key: 'parqet', sync: 'oneTime' },
] as const;

function ConnectorSlot({ slotKey, sync }: { slotKey: string; sync: 'oneTime' | 'stayConnected' }) {
  const t = useT();
  return (
    <PanelListItem
      actions={<Badge outline>{t('settings.connections.comingSoon')}</Badge>}
      main={
        <>
          <span className="bt-cc-row__label">
            {t(`settings.connections.slots.${slotKey}.name`)}
          </span>
          <span className="bt-cc-row__hint">
            {t(`settings.connections.slots.${slotKey}.purpose`)}
          </span>
          <span className="bt-cc-list__meta">
            {t(
              sync === 'oneTime'
                ? 'settings.connections.sync.oneTime'
                : 'settings.connections.sync.stayConnected',
            )}
          </span>
        </>
      }
    />
  );
}

function ConnectorSlots() {
  const t = useT();
  return (
    <PanelGroup label={t('settings.connections.slotsTitle')}>
      <PanelList>
        {CONNECTOR_SLOTS.map((slot) => (
          <ConnectorSlot key={slot.key} slotKey={slot.key} sync={slot.sync} />
        ))}
      </PanelList>
    </PanelGroup>
  );
}

/**
 * Control Center → Connections (PROJECTPLAN.md §13.5 V5-P0c, compacted in R2).
 * The single home for everything that links BetterTrack to the outside: the
 * Google sign-in identity, the paranoid vault's Drive medium, and the future
 * connectors as inert slots. Content only was rebuilt for popup density — every
 * query key, mutation, endpoint and confirmation flow is the page's.
 *
 * The Drive props stay injectable (the vault runtime is optional at this depth
 * and the suite drives the media flows through a stub controller).
 */
export function ConnectionsPanel({
  driveConnection,
  driveUnlock,
  driveConfigured = Boolean(getGoogleDriveClientId()),
}: {
  driveConnection?: DriveConnectionController | null;
  driveUnlock?:
    | ((passphrase: string, options: VaultDriveUnlockOptions) => Promise<DriveConnectionController>)
    | null;
  driveConfigured?: boolean;
} = {}) {
  const t = useT();
  const runtime = useOptionalVaultRuntime();
  const privacy = useResolvedPrivacyModeState();
  const resolvedDriveConnection =
    driveConnection === undefined ? (runtime?.connection ?? null) : driveConnection;
  const resolvedDriveUnlock =
    driveUnlock === undefined ? (runtime?.unlockWithPassphrase ?? null) : driveUnlock;
  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.connections')} />

      <GoogleSection />

      <DriveVaultSection
        accountId={privacy.accountId}
        configured={driveConfigured}
        connection={resolvedDriveConnection}
        unlock={resolvedDriveUnlock}
      />

      <ConnectorSlots />
    </div>
  );
}
