import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import type { DriveConnection, VaultConfig } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { formatDateTime } from '../../../lib/format';
import { getGoogleDriveClientId } from '../../../lib/runtimeConfig';
import {
  createDriveConnection,
  deleteDriveConnection,
  getGoogleLinkStatus,
  getParanoidMediaState,
  googleStartUrl,
  listDriveConnections,
  listVaultConfigs,
  unlinkGoogle,
  verifyDriveConnection,
} from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Badge, Button, Field, Input, type BadgeTone } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import type {
  DriveConnectionActionResult,
  DriveConnectionController,
  VaultRetiredPurgeResult,
} from '../../vault/media';
import { useDriveGisPreparation } from '../../vault/drive/useDriveGisPreparation';
import {
  createDriveConnectionRegistry,
  type DriveConnectionRegistry,
} from '../../vault/media/driveConnectionRegistry';
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

const DRIVE_CONNECTIONS_KEY = ['vaults', 'drive-connections'] as const;
const VAULT_CONFIGS_KEY = ['vaults', 'configs'] as const;

function useRegistryAuthorization(registry: DriveConnectionRegistry, connection: DriveConnection) {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(connection, listener),
    [connection, registry],
  );
  const getSnapshot = useCallback(() => registry.authorization(connection), [connection, registry]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function DriveIdentityRow({
  connection,
  registry,
  vaults,
  working,
  onAuthorize,
  onDisconnect,
}: {
  connection: DriveConnection;
  registry: DriveConnectionRegistry;
  vaults: readonly VaultConfig[];
  working: boolean;
  onAuthorize: () => void;
  onDisconnect: () => void;
}) {
  const t = useT();
  const authorization = useRegistryAuthorization(registry, connection);
  const bound = vaults.filter(({ driveConnectionId }) => driveConnectionId === connection.id);
  const label = connection.displayName
    ? `${connection.displayName} · ${connection.email}`
    : connection.email;
  return (
    <Row
      hint={
        bound.length === 0
          ? t('settings.connections.driveAccounts.unbound')
          : t('settings.connections.driveAccounts.boundVaults', {
              vaults: bound.map(({ name }) => name).join(', '),
            })
      }
      label={label}
    >
      <Badge tone={authorization === 'connected' ? 'pos' : 'gold'}>
        {t(
          authorization === 'connected'
            ? 'settings.connections.driveAccounts.connected'
            : authorization === 'revoked'
              ? 'settings.connections.driveAccounts.revoked'
              : 'settings.connections.driveAccounts.needsSignIn',
        )}
      </Badge>
      {authorization !== 'connected' ? (
        <Button disabled={working} onClick={onAuthorize} size="sm" variant="primary">
          {t('settings.connections.driveAccounts.signIn', { email: connection.email })}
        </Button>
      ) : null}
      <Button disabled={working} onClick={onDisconnect} size="sm" variant="quiet">
        {t('settings.connections.driveAccounts.disconnect')}
      </Button>
    </Row>
  );
}

export interface DriveVaultMoveResult {
  cleanupFailures: readonly { docId: string; message: string }[];
}

/** Compact N-account registry and per-vault binding projection (E5). */
function DriveAccountsSection({
  registry,
  moveVault,
}: {
  registry: DriveConnectionRegistry;
  moveVault?: (vaultId: string, connectionId: string) => Promise<DriveVaultMoveResult>;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [working, setWorking] = useState<string | null>(null);
  const [acknowledge, setAcknowledge] = useState<DriveConnection | null>(null);
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    tone: 'error' | 'success' | 'info';
    text: string;
  } | null>(null);
  const connections = useQuery({
    queryKey: DRIVE_CONNECTIONS_KEY,
    queryFn: ({ signal }) => listDriveConnections(signal),
    staleTime: 15_000,
  });
  const vaults = useQuery({
    queryKey: VAULT_CONFIGS_KEY,
    queryFn: ({ signal }) => listVaultConfigs(signal),
    staleTime: 15_000,
  });

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: DRIVE_CONNECTIONS_KEY }),
      queryClient.invalidateQueries({ queryKey: VAULT_CONFIGS_KEY }),
    ]);
  }

  async function connect(): Promise<void> {
    setWorking('new');
    setMessage(null);
    const result = await registry.connect();
    if (result.status === 'ok') {
      setMessage({ tone: 'success', text: t('settings.connections.driveAccounts.added') });
      await refresh();
    } else {
      // Closing the Google consent popup is the common outcome here, and it is
      // actionable: say what to do instead of "could not be changed".
      setMessage({
        tone: 'error',
        text: t(
          result.status === 'authorization-required'
            ? 'settings.connections.driveAccounts.signInNew'
            : 'settings.connections.driveAccounts.error',
        ),
      });
    }
    setWorking(null);
  }

  async function authorize(connection: DriveConnection): Promise<void> {
    setWorking(connection.id);
    setMessage(null);
    const result = await registry.authorize(connection);
    setMessage(
      result.status === 'ok'
        ? { tone: 'success', text: t('settings.connections.driveAccounts.verified') }
        : {
            tone: 'error',
            text:
              result.status === 'authorization-required' || result.status === 'identity-mismatch'
                ? t('settings.connections.driveAccounts.signIn', { email: connection.email })
                : t('settings.connections.driveAccounts.error'),
          },
    );
    if (result.status === 'ok') await refresh();
    setWorking(null);
  }

  async function disconnect(connection: DriveConnection, confirmed: boolean): Promise<void> {
    setWorking(connection.id);
    setMessage(null);
    try {
      await registry.disconnect(connection, confirmed);
      setAcknowledge(null);
      setMessage({ tone: 'success', text: t('settings.connections.driveAccounts.disconnected') });
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'DRIVE_CONNECTION_BOUND' && !confirmed) {
        setAcknowledge(connection);
      } else {
        setMessage({
          tone: 'error',
          text:
            error instanceof ApiError && error.code === 'DRIVE_CONNECTION_LAST_MEDIUM'
              ? t('settings.connections.driveAccounts.lastMedium')
              : t('settings.connections.driveAccounts.error'),
        });
      }
    } finally {
      setWorking(null);
    }
  }

  async function move(vault: VaultConfig): Promise<void> {
    const target = moveTargets[vault.id];
    if (!moveVault || !target) return;
    setWorking(vault.id);
    setMessage(null);
    try {
      const result = await moveVault(vault.id, target);
      // The chosen target is now the vault's own connection, so it drops out of
      // the option list and the <select> renders blank. Clearing the remembered
      // choice disables **Move** with it — otherwise the button stays live on a
      // value that would ask for a migration onto the connection the vault
      // already sits on.
      setMoveTargets(({ [vault.id]: _chosen, ...rest }) => rest);
      setMessage({
        tone: result.cleanupFailures.length > 0 ? 'info' : 'success',
        text: t(
          result.cleanupFailures.length > 0
            ? 'settings.connections.driveAccounts.moveCleanupFailed'
            : 'settings.connections.driveAccounts.moved',
        ),
      });
      await refresh();
    } catch {
      setMessage({ tone: 'error', text: t('settings.connections.driveAccounts.moveError') });
    } finally {
      setWorking(null);
    }
  }

  return (
    <PanelGroup label={t('settings.connections.driveAccounts.title')}>
      {connections.isPending || vaults.isPending ? (
        <Row stack>
          <Skeleton height="h-4" width="w-40" />
        </Row>
      ) : connections.isError || vaults.isError ? (
        <Row stack>
          <PanelNote>{t('settings.connections.driveAccounts.loadError')}</PanelNote>
        </Row>
      ) : (
        <>
          {connections.data.length === 0 ? (
            <Row stack>
              <PanelNote>{t('settings.connections.driveAccounts.empty')}</PanelNote>
            </Row>
          ) : (
            connections.data.map((connection) => (
              <DriveIdentityRow
                connection={connection}
                key={connection.id}
                onAuthorize={() => void authorize(connection)}
                onDisconnect={() => void disconnect(connection, false)}
                registry={registry}
                vaults={vaults.data}
                working={working === connection.id}
              />
            ))
          )}
          <Row stack>
            <Button disabled={working !== null} onClick={() => void connect()} size="sm">
              {t(
                connections.data.length === 0
                  ? 'settings.connections.driveAccounts.addFirst'
                  : 'settings.connections.driveAccounts.add',
              )}
            </Button>
          </Row>

          {moveVault && connections.data.length > 1 ? (
            <PanelFold summary={t('settings.connections.driveAccounts.bindings')}>
              <div className="flex flex-col gap-3">
                {vaults.data
                  .filter(({ driveConnectionId }) => driveConnectionId != null)
                  .map((vault) => (
                    <div className="flex flex-wrap items-center gap-2" key={vault.id}>
                      <span className="text-sm">{vault.name}</span>
                      <select
                        aria-label={t('settings.connections.driveAccounts.moveTarget', {
                          vault: vault.name,
                        })}
                        className="bt-input w-auto"
                        onChange={(event) =>
                          setMoveTargets((current) => ({
                            ...current,
                            [vault.id]: event.target.value,
                          }))
                        }
                        value={moveTargets[vault.id] ?? ''}
                      >
                        <option value="">{t('settings.connections.driveAccounts.choose')}</option>
                        {connections.data
                          .filter(({ id }) => id !== vault.driveConnectionId)
                          .map((connection) => (
                            <option key={connection.id} value={connection.id}>
                              {connection.email}
                            </option>
                          ))}
                      </select>
                      <Button
                        disabled={!moveTargets[vault.id] || working !== null}
                        onClick={() => void move(vault)}
                        size="sm"
                      >
                        {t('settings.connections.driveAccounts.move')}
                      </Button>
                    </div>
                  ))}
              </div>
            </PanelFold>
          ) : null}
        </>
      )}

      {acknowledge ? (
        <Row stack>
          <Alert tone="info">{t('settings.connections.driveAccounts.acknowledge')}</Alert>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void disconnect(acknowledge, true)} size="sm" variant="danger">
              {t('settings.connections.driveAccounts.acknowledgeAction')}
            </Button>
            <Button onClick={() => setAcknowledge(null)} size="sm" variant="quiet">
              {t('common.cancel')}
            </Button>
          </div>
        </Row>
      ) : null}
      {message ? (
        <Row stack>
          <Alert tone={message.tone}>{message.text}</Alert>
        </Row>
      ) : null}
    </PanelGroup>
  );
}

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
  prepareDrive,
  unlock,
}: {
  accountId: string | null;
  connection: DriveConnectionController | null;
  configured: boolean;
  prepareDrive: (() => Promise<void>) | null;
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
  const [driveConnectionRequested, setDriveConnectionRequested] = useState(false);
  const authorization = useDriveAuthorization(connection);
  const mediaQueryKey = vaultMediaQueryKey(accountId);
  const query = useQuery({
    queryKey: mediaQueryKey,
    queryFn: ({ signal }) => getParanoidMediaState(signal),
    retry: false,
    staleTime: 15_000,
  });
  // Loading GIS contacts Google, so do not do it just because Connections is
  // open. A vault already using Drive is an intended Drive flow; a server-only
  // vault starts preparation only after its explicit Connect Drive gesture.
  const driveSelected =
    query.data?.privacyMode === 'paranoid' &&
    query.data.mediaState?.mediaSet.includes('drive') === true;
  const drivePreparationEnabled =
    configured && prepareDrive != null && (driveSelected || driveConnectionRequested);
  const drivePreparation = useDriveGisPreparation(drivePreparationEnabled, prepareDrive);
  const driveReady = prepareDrive == null || drivePreparation.state === 'ready';
  const drivePreparing =
    drivePreparationEnabled &&
    (drivePreparation.state === 'idle' || drivePreparation.state === 'preparing');
  const driveActionDisabled = working || drivePreparing;

  function driveActionLabel(key: string): string {
    if (drivePreparing) return t('settings.connections.drive.preparing');
    if (drivePreparationEnabled && drivePreparation.state === 'failed') {
      return t('settings.connections.drive.retryPreparation');
    }
    return t(key);
  }

  if (!configured && (query.isError || query.isPending)) return null;

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
  const selected = driveSelected;
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
    if (!driveReady) {
      if (!drivePreparationEnabled) {
        setDriveConnectionRequested(true);
      } else if (drivePreparation.state === 'failed') {
        drivePreparation.retry();
      }
      return;
    }
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
    if (!driveReady) {
      if (!drivePreparationEnabled) {
        setDriveConnectionRequested(true);
      } else if (drivePreparation.state === 'failed') {
        drivePreparation.retry();
      }
      return;
    }
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
            disabled={driveActionDisabled}
            onClick={() => void run('connect')}
            size="sm"
            variant="primary"
          >
            {driveActionLabel(
              selected ? 'settings.connections.drive.signIn' : 'settings.connections.drive.connect',
            )}
          </Button>
        ) : null}
        {configured && selected && media.mediaSet.length > 1 ? (
          <Button
            disabled={driveActionDisabled}
            onClick={() => void run('disconnect')}
            size="sm"
            variant="quiet"
          >
            {driveActionLabel('settings.connections.drive.disconnect')}
          </Button>
        ) : null}
      </Row>

      {/* The one kept line states the least-privilege drive.file boundary. */}
      <Row stack>
        <PanelNote>{t('settings.connections.drive.description')}</PanelNote>
      </Row>

      {message ? (
        <Row stack>
          <Alert tone={message.tone}>{t(message.key)}</Alert>
        </Row>
      ) : null}
      {drivePreparation.state === 'failed' ? (
        <Row stack>
          <PanelNote warn>{t('settings.connections.drive.preparationFailed')}</PanelNote>
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
              <Button
                disabled={driveActionDisabled || passphrase.length === 0}
                size="sm"
                type="submit"
              >
                {driveActionLabel('settings.connections.drive.unlockAndContinue')}
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
              disabled={driveActionDisabled || !configured}
              onClick={() =>
                void run(media.mediaSet.includes('server') ? 'drive-only' : 'add-server')
              }
              size="sm"
              type="button"
            >
              {driveActionLabel(
                media.mediaSet.includes('server')
                  ? 'settings.connections.drive.storage.useDriveOnly'
                  : 'settings.connections.drive.storage.addServer',
              )}
            </Button>
          </div>
        </PanelFold>
      ) : null}

      {canPurgeRetiredServer ? (
        <PanelFold summary={t('settings.connections.drive.retired.title')}>
          <div className="flex flex-col items-start gap-2">
            <PanelNote>
              {t(
                purgeReady
                  ? 'settings.connections.drive.retired.ready'
                  : 'settings.connections.drive.retired.wait',
                { date: formatDateTime(retired.purgeAfter) },
              )}
            </PanelNote>
            <Button
              disabled={driveActionDisabled || !purgeReady || !configured}
              onClick={() => void run('purge')}
              size="sm"
              type="button"
              variant="danger"
            >
              {driveActionLabel('settings.connections.drive.retired.purge')}
            </Button>
          </div>
        </PanelFold>
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
  drivePrepare,
  driveRegistry,
  driveMoveVault,
  driveConfigured = Boolean(getGoogleDriveClientId()),
}: {
  driveConnection?: DriveConnectionController | null;
  driveUnlock?:
    | ((passphrase: string, options: VaultDriveUnlockOptions) => Promise<DriveConnectionController>)
    | null;
  drivePrepare?: (() => Promise<void>) | null;
  driveRegistry?: DriveConnectionRegistry | null;
  /**
   * The Y → Z move. No production caller supplies it yet: `migrateDriveConnection`
   * needs one source/target `DriveDataHome` PAIR PER DOCUMENT and a replicated
   * write path for the §8 identity echo, and the live runtime still composes the
   * single account-scoped envelope-v1 home. Both arrive with the client-engine
   * re-home in E6 (#1416), which is where this prop gets its implementation,
   * and the vault UI that surfaces it lands in E8 (#1418). Recorded as an
   * unmet #1415 acceptance line in PROJECTPLAN §16 (2026-08-22).
   */
  driveMoveVault?: (vaultId: string, connectionId: string) => Promise<DriveVaultMoveResult>;
  driveConfigured?: boolean;
} = {}) {
  const t = useT();
  const runtime = useOptionalVaultRuntime();
  const privacy = useResolvedPrivacyModeState();
  const driveClientId = getGoogleDriveClientId();
  // The account-level `privacyMode` is NOT the audience gate. It is the retired
  // v1 column: per §16 (2026-08-21, E2) it reports 'normal' for every new-model
  // vault owner and E9 deletes it, and `createVault` never writes 'paranoid' —
  // only the legacy enable ceremony did. Gating on it hid this whole group from
  // exactly the owners E8 creates.
  //
  // What makes the group meaningful is owning a vault to bind a Drive account
  // to, so the audience is "has at least one vault", with legacy paranoid
  // accounts kept in the OR until E9 removes their account-level rail. The
  // runtime client id stays capability, not audience: without it there is no
  // registry, so nothing renders and nothing is requested.
  const legacyParanoid = privacy.privacyMode === 'paranoid';
  const resolvedDriveRegistry = useMemo(
    () =>
      driveRegistry === undefined
        ? driveClientId
          ? createDriveConnectionRegistry({
              clientId: driveClientId,
              api: {
                create: createDriveConnection,
                verify: verifyDriveConnection,
                delete: deleteDriveConnection,
              },
            })
          : null
        : driveRegistry,
    [driveClientId, driveRegistry],
  );
  const resolvedDriveConnection =
    driveConnection === undefined ? (runtime?.connection ?? null) : driveConnection;
  const resolvedDriveUnlock =
    driveUnlock === undefined ? (runtime?.unlockWithPassphrase ?? null) : driveUnlock;
  const resolvedDrivePrepare =
    drivePrepare === undefined ? (runtime?.prepareDriveStorage ?? null) : drivePrepare;
  // The section's own vault read, hoisted so the answer decides whether the
  // section exists at all. Same key and staleTime, so the two observers share
  // ONE request — the audience test costs nothing extra once the group renders,
  // and an account with no vault pays a single cheap config read instead of the
  // pair (connections + vaults) the group would fire.
  const vaultConfigs = useQuery({
    queryKey: VAULT_CONFIGS_KEY,
    queryFn: ({ signal }) => listVaultConfigs(signal),
    staleTime: 15_000,
    enabled: resolvedDriveRegistry != null,
  });
  const showDriveAccounts =
    resolvedDriveRegistry != null && (legacyParanoid || (vaultConfigs.data?.length ?? 0) > 0);
  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.connections')} />

      <GoogleSection />

      {showDriveAccounts && resolvedDriveRegistry ? (
        <DriveAccountsSection registry={resolvedDriveRegistry} moveVault={driveMoveVault} />
      ) : null}

      <DriveVaultSection
        accountId={privacy.accountId}
        configured={driveConfigured}
        connection={resolvedDriveConnection}
        prepareDrive={resolvedDrivePrepare}
        unlock={resolvedDriveUnlock}
      />

      <ConnectorSlots />
    </div>
  );
}
