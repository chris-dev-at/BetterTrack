import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import type {
  DriveConnection,
  PortfolioSummary,
  VaultConfig,
  VaultStepUpCredential,
} from '@bettertrack/contracts';
import { PER_VAULT_ERROR_CODES } from '@bettertrack/contracts';

import { useT, type TranslateVars } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import {
  deleteVault,
  DRIVE_CONNECTIONS_QUERY_KEY,
  listVaultDriveConnections,
  listVaults,
  readVaultHeaderDocument,
  renameVault,
  VAULTS_QUERY_KEY,
} from '../../../lib/vaultApi';
import {
  Badge,
  Button,
  CheckRow,
  Disclosure,
  Empty,
  Field,
  Icon,
  Input,
  LinkButton,
  Panel,
  Select,
  SkeletonBlock,
} from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { portfolioDisplayName } from '../../portfolio/lockedPortfolio';
import { usePortfolioStore } from '../../portfolio/PortfolioStoreProvider';
import { PER_VAULT_DRIVE_PROVISIONING_AVAILABLE } from '../capabilities';
import type { EndpointVaultState } from '../keystore';
import { EndpointKeystoreError } from '../keystore/errors';
import { endpointVaultKeystore } from '../keystore/runtime';
import { provisionVault, type ProvisionVaultInput } from '../provisionVault';
import { useUnlockedPortfolioNames } from '../useUnlockedPortfolioNames';
import type { RestoreCandidate } from '../restore';
import {
  isVaultStateActionKind,
  vaultStateAffordance,
  vaultStateOffersAction,
  vaultStateRetryAt,
  vaultStateTone,
} from '../vaultStateAffordance';
import { vaultRetryTimeLabel } from './retryTime';
import { VaultCreationCeremony, type VaultCreationInput } from './VaultCreationCeremony';
import { VaultRestorePicker } from './VaultRestorePicker';
import { VaultStateAction } from './VaultStateAction';
import {
  readVaultEndpointState,
  useVaultEndpointState,
  vaultEndpointStateQueryKey,
} from './useVaultEndpointState';

export interface VaultManagerOperations {
  provision(input: ProvisionVaultInput): Promise<VaultConfig>;
  fetchHeader(vault: VaultConfig): Promise<Uint8Array>;
  scanQr?(vault: VaultConfig): Promise<void> | void;
  rotate?(vault: VaultConfig): Promise<void>;
  startFresh?(vault: VaultConfig, stepUp: VaultStepUpCredential): Promise<void>;
  listRestoreCandidates?(vault: VaultConfig): Promise<readonly RestoreCandidate[]>;
  restoreCandidate?(vault: VaultConfig, candidate: RestoreCandidate): Promise<void>;
}

/**
 * What this build can actually do. The optional operations above are the seams
 * their epics fill; until then this surface states which one is missing instead
 * of offering a control that refuses — every entry either acts or explains.
 */
const DEFAULT_OPERATIONS: VaultManagerOperations = {
  provision: provisionVault,
  fetchHeader: (vault) => readVaultHeaderDocument(vault.id, vault.headerDocId),
};

/**
 * Deferred actions, each with the copy that names what is still missing:
 * rotation and "start fresh" both need E5's authenticated per-medium round trip
 * (#1415), the restore write needs E6's client engine (#1416), and the QR
 * reader is E7's surface (#1417).
 */
const DEFERRED_ACTION_REASONS = {
  rotate: 'vault.manager.deferred.rotate',
  'start-fresh': 'vault.manager.deferred.startFresh',
  'scan-qr': 'vault.manager.deferred.scanQr',
  restore: 'vault.manager.deferred.restore',
} as const;

type DeferrableAction = keyof typeof DEFERRED_ACTION_REASONS;

/**
 * Every `?action=` this surface knows. Anything else is a stale or hand-edited
 * deep link — still a state, and a state without a next action is a design bug,
 * so it gets the vault's own live affordance instead of a raw i18n key and a
 * Continue button that can only refuse.
 */
const ACCESS_ACTIONS: ReadonlySet<string> = new Set([
  'unlock',
  'open',
  'provide-phrase',
  'reset-endpoint',
  'scan-qr',
  'rotate',
  'start-fresh',
  'restore',
]);

/**
 * A read that failed and offers a retry. It was four copies of a `bt-soft` div
 * — a class that is ONE declaration, `color`, so the "banner" had no surface at
 * all and read as loose text with a button beside it. One component, one soft
 * panel, one retry.
 */
function RetryNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <Panel
      className="flex flex-wrap items-center justify-between gap-3 p-3"
      pad={false}
      role="alert"
      soft
    >
      <span className="bt-soft text-sm">{message}</span>
      <Button icon="refresh" onClick={onRetry} size="sm" type="button">
        {t('common.retry')}
      </Button>
    </Panel>
  );
}

/** Null when the action can run; otherwise the i18n key explaining why not. */
function deferredReasonKey(action: string, operations: VaultManagerOperations): string | null {
  const available: Record<DeferrableAction, boolean> = {
    rotate: operations.rotate != null,
    'start-fresh': operations.startFresh != null,
    'scan-qr': operations.scanQr != null,
    restore: operations.listRestoreCandidates != null && operations.restoreCandidate != null,
  };
  if (!(action in available)) return null;
  const key = action as DeferrableAction;
  return available[key] ? null : DEFERRED_ACTION_REASONS[key];
}

export function VaultManager({
  operations = DEFAULT_OPERATIONS,
}: {
  operations?: VaultManagerOperations;
}) {
  const t = useT();
  const { user } = useAuth();
  const store = usePortfolioStore();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const vaultsQuery = useQuery({
    queryKey: VAULTS_QUERY_KEY,
    queryFn: ({ signal }) => listVaults(signal),
  });
  const vaults = vaultsQuery.data ?? [];
  // The Drive connection directory is E5's route (#1415), unmounted on `main`.
  // This build also refuses to provision a Drive vault at all, so the ceremony
  // does not need the list: asking for it on every "Create vault" click would
  // 404 into a permanent error banner with a Retry that can never succeed,
  // directly above step 1. Only a vault ALREADY bound to Drive needs the names,
  // and one can exist only once E5 has landed the route that serves them.
  const driveConnectionsNeeded =
    (creating && PER_VAULT_DRIVE_PROVISIONING_AVAILABLE) ||
    vaults.some((vault) => vault.media.includes('drive'));
  const connectionsQuery = useQuery({
    queryKey: DRIVE_CONNECTIONS_QUERY_KEY,
    queryFn: ({ signal }) => listVaultDriveConnections(signal),
    enabled: driveConnectionsNeeded,
    retry: false,
  });
  // The canonical portfolio read: same key and same store seam as the switcher,
  // the workspace and home, so this panel shares their cache entry instead of
  // issuing a second identical request — and, in paranoid v1, still reads
  // through the vault-backed store rather than around it.
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
  });
  // Resolved over the WHOLE roster, never per row: the resolution registry is
  // keyed by roster, so asking per vault would open each vault and decrypt its
  // documents once per row instead of once per panel.
  const unlockedNames = useUnlockedPortfolioNames(
    useMemo(() => portfoliosQuery.data?.portfolios ?? [], [portfoliosQuery.data]),
  );
  const endpointQueries = useQueries({
    queries: vaults.map((vault) => ({
      queryKey: vaultEndpointStateQueryKey(vault.id),
      queryFn: () => readVaultEndpointState(vault.id),
      staleTime: 5_000,
    })),
  });
  const activeVault = vaults.find((vault) => vault.id === searchParams.get('vault')) ?? null;
  const activeAction = searchParams.get('action');

  function closeAction() {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete('vault');
        next.delete('action');
        return next;
      },
      { replace: true },
    );
  }

  async function refreshVaults() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: VAULTS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['vaults', 'endpoint-state'] }),
      queryClient.invalidateQueries({ queryKey: ['portfolios'] }),
    ]);
  }

  async function create(input: VaultCreationInput) {
    if (!user) throw new Error('session-required');
    await operations.provision({ accountId: user.id, ...input });
    await refreshVaults();
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="vault-manager-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="bt-h2" id="vault-manager-title">
            {t('vault.manager.title')}
          </h3>
          <p className="bt-row-sub">{t('vault.manager.subtitle')}</p>
        </div>
        {!creating ? (
          <Button onClick={() => setCreating(true)} size="sm" type="button">
            {t('vault.manager.create')}
          </Button>
        ) : null}
      </div>

      {/* The cleartext boundaries. Three sentences with nothing behind them read
          as loose prose; on one soft panel, ruled and glyphed, they read as the
          rules of the surface they introduce. */}
      <Panel pad={false} soft>
        <ul className="bt-band flex flex-col">
          {(
            [
              ['names', 'eye'],
              ['storage', 'database'],
              ['privacy', 'lock'],
            ] as const
          ).map(([item, icon]) => (
            <li className="bt-soft flex items-start gap-2.5 px-3 py-2.5 text-sm" key={item}>
              <span className="bt-muted mt-0.5 shrink-0">
                <Icon name={icon} size={15} />
              </span>
              <span className="min-w-0">{t(`vault.manager.explainer.${item}`)}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {creating ? (
        <>
          {driveConnectionsNeeded && connectionsQuery.isPending ? (
            <SkeletonBlock height={48} />
          ) : null}
          {driveConnectionsNeeded && connectionsQuery.isError ? (
            <RetryNotice
              message={t('vault.manager.connectionsError')}
              onRetry={() => void connectionsQuery.refetch()}
            />
          ) : null}
          <VaultCreationCeremony
            connections={connectionsQuery.data ?? []}
            onCancel={() => setCreating(false)}
            onCreate={create}
            onCreated={() => setCreating(false)}
          />
        </>
      ) : null}

      {vaultsQuery.isPending ? <SkeletonBlock height={112} /> : null}
      {vaultsQuery.isError ? (
        <RetryNotice
          message={t('vault.manager.loadError')}
          onRetry={() => void vaultsQuery.refetch()}
        />
      ) : null}
      {vaultsQuery.isSuccess && vaults.length === 0 && !creating ? (
        <Empty icon="shield" title={t('vault.manager.empty')} />
      ) : null}

      {portfoliosQuery.isPending && vaults.length > 0 ? <SkeletonBlock height={36} /> : null}
      {portfoliosQuery.isError && vaults.length > 0 ? (
        <RetryNotice
          message={t('vault.manager.portfoliosError')}
          onRetry={() => void portfoliosQuery.refetch()}
        />
      ) : null}

      {vaults.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label={t('vault.manager.listLabel')}>
          {vaults.map((vault, index) => (
            <VaultManagerRow
              endpointQuery={endpointQueries[index]}
              driveConnection={connectionsQuery.data?.find(
                (connection) => connection.id === vault.driveConnectionId,
              )}
              key={vault.id}
              memberships={(portfoliosQuery.data?.portfolios ?? []).filter(
                (portfolio) => portfolio.vaultId === vault.id,
              )}
              membershipReady={portfoliosQuery.isSuccess}
              onChanged={refreshVaults}
              operations={operations}
              unlockedNames={unlockedNames}
              vault={vault}
            />
          ))}
        </ul>
      ) : null}

      {activeVault && activeAction ? (
        <ArrivedFromDeepLink>
          <VaultAccessAction
            action={activeAction}
            onClose={closeAction}
            onDone={async () => {
              await refreshVaults();
              closeAction();
            }}
            operations={operations}
            vault={activeVault}
          />
        </ArrivedFromDeepLink>
      ) : null}
    </section>
  );
}

function VaultManagerRow({
  vault,
  endpointQuery,
  driveConnection,
  memberships,
  membershipReady,
  onChanged,
  operations,
  unlockedNames,
}: {
  vault: VaultConfig;
  endpointQuery: UseQueryResult<EndpointVaultState, Error> | undefined;
  driveConnection: DriveConnection | undefined;
  memberships: readonly PortfolioSummary[];
  membershipReady: boolean;
  onChanged(): Promise<void>;
  operations: VaultManagerOperations;
  /** Decrypted names for the portfolios this device currently holds open. */
  unlockedNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const deferredFoldId = useId();
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(vault.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [credentialKind, setCredentialKind] = useState<'password' | 'code' | 'recoveryCode'>(
    'password',
  );
  const [credential, setCredential] = useState('');
  const [working, setWorking] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const state = endpointQuery?.data;
  const rotateDeferred = deferredReasonKey('rotate', operations);
  const startFreshDeferred = deferredReasonKey('start-fresh', operations);

  async function saveName() {
    if (name.trim() === '' || name.trim() === vault.name) return;
    setWorking(true);
    setErrorKey(null);
    try {
      await renameVault(vault.id, { name: name.trim() });
      await onChanged();
      setRenameOpen(false);
    } catch {
      setErrorKey('vault.manager.renameError');
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    const value = credential.trim();
    if (value === '') return;
    setWorking(true);
    setErrorKey(null);
    try {
      const stepUp = { [credentialKind]: value } as VaultStepUpCredential;
      await deleteVault(vault.id, { stepUp });
      await onChanged();
    } catch (error) {
      setErrorKey(
        error instanceof ApiError && error.code === PER_VAULT_ERROR_CODES.deleteReferenced
          ? 'vault.manager.deleteReferenced'
          : 'vault.manager.deleteError',
      );
    } finally {
      setWorking(false);
    }
  }

  const deferredReasons = [
    'vault.manager.deferred.changeMedia',
    rotateDeferred,
    startFreshDeferred,
  ].filter((key): key is string => key != null);

  return (
    <li className="bt-panel flex flex-col gap-3 p-3">
      {/* Identity, live state, and the one act this row is FOR. Everything
          below the rule is maintenance. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="bt-row-title truncate">{vault.name}</p>
            {state ? (
              <Badge tone={vaultStateTone(state)}>{t(vaultStateAffordance(state).stateKey)}</Badge>
            ) : null}
          </div>
          <p className="bt-row-sub">
            {t(
              vault.media.length === 2
                ? 'vault.manager.media.both'
                : `vault.manager.media.${vault.media[0] ?? 'server'}`,
            )}
          </p>
          {vault.driveConnectionId ? (
            <p className="bt-row-sub">
              {t('vault.manager.boundDrive', {
                connection: driveConnection
                  ? driveConnection.displayName
                    ? `${driveConnection.displayName} · ${driveConnection.email}`
                    : driveConnection.email
                  : t('vault.manager.boundDriveUnavailable'),
              })}
            </p>
          ) : null}
        </div>
        {state ? (
          <VaultStateAction emphasis="primary" state={state} vaultId={vault.id} />
        ) : (
          <Button
            onClick={() => void endpointQuery?.refetch()}
            size="sm"
            type="button"
            variant="quiet"
          >
            {endpointQuery?.isError ? t('common.retry') : t('common.loading')}
          </Button>
        )}
      </div>

      {!membershipReady ? null : memberships.length > 0 ? (
        <div>
          <p className="bt-label">{t('vault.manager.portfolios')}</p>
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {memberships.map((portfolio) => (
              <li key={portfolio.id}>
                {/* "Private Holdings · Private Holdings" — the vault named after
                    itself — is what this chip read while the vault was open
                    (failure map #6). With the name in hand it says which
                    portfolio; locked, it stays the alias. */}
                <Badge>
                  <Icon name="portfolios" size={12} />
                  {portfolioDisplayName(
                    portfolio,
                    t('vault.lockedStub.fallbackAlias'),
                    unlockedNames.get(portfolio.id),
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="bt-row-sub">{t('vault.manager.noPortfolios')}</p>
      )}

      {/* The maintenance bar. It used to be five underlined words in a line —
          three of them `<span>`s pretending to be links — followed by up to
          three explainer paragraphs. Now it is one ruled action bar with real
          hierarchy, and the paragraphs are folded into the single disclosure
          below it. */}
      <div className="bt-action-bar bt-t-rule bt-row-actions flex flex-wrap items-center gap-2 pt-3">
        <Button
          icon="pen"
          onClick={() => setRenameOpen((open) => !open)}
          size="sm"
          type="button"
          variant="quiet"
        >
          {t('vault.manager.action.rename')}
        </Button>
        {/* "Change storage" WAS a link to `/control/connections?vault=<id>`,
            and that panel has never read the `vault` param (#1520): the link
            landed on an unscoped Drive-connection list with no per-vault media
            control on it, because this build provisions no per-vault Drive
            medium at all (`PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false`,
            E5/#1415). Honouring the param would have scoped the page to a
            control that is not there. So it follows the same rule as `rotate`
            and `start-fresh` below — stated as what it is, with the missing
            piece named, and never a link.

            `aria-disabled` rather than `disabled`: §12 forbids a SILENT
            disabled control, and a real `disabled` button drops out of the tab
            order, so a keyboard user would meet three actions that simply are
            not there. This way each one is still reachable, still announced,
            and points at the fold that names what is missing. */}
        <DeferredAction
          describedBy={deferredFoldId}
          label={t('vault.manager.action.changeMedia')}
        />
        {rotateDeferred ? (
          <DeferredAction describedBy={deferredFoldId} label={t('vault.manager.action.rotate')} />
        ) : (
          <LinkButton
            size="sm"
            to={`/control/privacy?vault=${encodeURIComponent(vault.id)}&action=rotate`}
            variant="quiet"
          >
            {t('vault.manager.action.rotate')}
          </LinkButton>
        )}
        {startFreshDeferred ? (
          <DeferredAction
            describedBy={deferredFoldId}
            label={t('vault.manager.action.startFresh')}
          />
        ) : (
          <LinkButton
            size="sm"
            to={`/control/privacy?vault=${encodeURIComponent(vault.id)}&action=start-fresh`}
            variant="quiet"
          >
            {t('vault.manager.action.startFresh')}
          </LinkButton>
        )}
        <span className="grow" />
        <Button
          disabled={!membershipReady || memberships.length > 0}
          icon="trash"
          onClick={() => setDeleteOpen((open) => !open)}
          size="sm"
          type="button"
          variant="danger"
        >
          {t('common.delete')}
        </Button>
      </div>

      {/* Three "isn't available yet" paragraphs stacked above the fold were the
          wall the owner met on this panel. Same words, one disclosure. */}
      {deferredReasons.length > 0 ? (
        <div id={deferredFoldId}>
          <Disclosure summary={t('vault.manager.deferredFold')}>
            <div className="flex flex-col gap-2">
              {deferredReasons.map((key) => (
                <p className="bt-meta" key={key}>
                  {t(key)}
                </p>
              ))}
            </div>
          </Disclosure>
        </div>
      ) : null}

      {/* "Delete refuses while a portfolio is inside, and says so" — said with
          the membership list already in hand, not after a server round trip.
          It stays OUT of the fold above: that fold explains what this build
          cannot do, while this explains a control the user can see is off. */}
      {membershipReady && memberships.length > 0 ? (
        <p className="bt-meta">{t('vault.manager.deleteReferenced')}</p>
      ) : null}

      {renameOpen ? (
        <Panel className="flex flex-wrap items-end gap-2 p-3" pad={false} soft>
          <Field htmlFor={`vault-name-${vault.id}`} label={t('vault.manager.nameLabel')}>
            <Input
              id={`vault-name-${vault.id}`}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </Field>
          <Button
            disabled={working || name.trim() === ''}
            onClick={() => void saveName()}
            size="sm"
            type="button"
          >
            {t('common.save')}
          </Button>
        </Panel>
      ) : null}

      {deleteOpen ? (
        <Panel className="flex flex-col gap-3 p-3" pad={false} soft>
          <p className="bt-soft text-sm">{t('vault.manager.deleteWarning')}</p>
          <CredentialFields
            credential={credential}
            credentialKind={credentialKind}
            id={`vault-delete-${vault.id}`}
            onCredentialChange={setCredential}
            onKindChange={setCredentialKind}
          />
          <div>
            <Button
              disabled={working || credential.trim() === ''}
              onClick={() => void remove()}
              size="sm"
              type="button"
              variant="danger"
            >
              {t('vault.manager.deleteAction')}
            </Button>
          </div>
        </Panel>
      ) : null}
      {errorKey ? (
        <p className="bt-neg text-sm" role="alert">
          {t(errorKey)}
        </p>
      ) : null}
    </li>
  );
}

/**
 * An action this build cannot finish, kept in the bar as a peer of the ones it
 * can. Focusable and announced (`aria-disabled`, not `disabled`) and pointed at
 * the disclosure that names the missing piece — §12's "never a silent disabled
 * control", without the three paragraphs that used to say it above the fold.
 */
function DeferredAction({ describedBy, label }: { describedBy: string; label: string }) {
  return (
    <Button
      aria-describedby={describedBy}
      aria-disabled="true"
      size="sm"
      type="button"
      variant="quiet"
    >
      {label}
    </Button>
  );
}

/**
 * The settings side of #4: a `?vault=…&action=…` deep link must LAND on its
 * form, not somewhere above it.
 *
 * The Control Center opens on the Privacy panel with the access section far
 * down the page, under the deferred-capability paragraphs — which is how the
 * old bare `Unlock` link stranded users on a screen whose password field was
 * below the fold. The in-place dialog is now the primary path; this keeps the
 * secondary one honest.
 *
 * The focus deliberately does NOT run on mount: the section renders
 * "Checking what this vault needs…" first and only grows its field once the
 * live endpoint state arrives. So it waits for a field to exist, takes it once,
 * and never fights the user for the caret afterwards.
 */
function ArrivedFromDeepLink({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const claimed = useRef(false);

  useEffect(() => {
    if (claimed.current) return;
    const container = containerRef.current;
    if (container == null) return;
    // Never steal focus from a checkbox or a button — only the credential the
    // link came for.
    const field = container.querySelector<HTMLInputElement>(
      'input[type="password"], input[type="text"]',
    );
    if (field == null) return;
    claimed.current = true;
    if (typeof container.scrollIntoView === 'function') {
      container.scrollIntoView({ block: 'center' });
    }
    field.focus();
  });

  return <div ref={containerRef}>{children}</div>;
}

function VaultAccessAction({
  vault,
  action,
  operations,
  onClose,
  onDone,
}: {
  vault: VaultConfig;
  action: string;
  operations: VaultManagerOperations;
  onClose(): void;
  onDone(): Promise<void>;
}) {
  const t = useT();
  const [secret, setSecret] = useState('');
  const [devicePassword, setDevicePassword] = useState('');
  const [resetAcknowledged, setResetAcknowledged] = useState(false);
  const [destructionAcknowledged, setDestructionAcknowledged] = useState(false);
  const [stepUpKind, setStepUpKind] = useState<'password' | 'code' | 'recoveryCode'>('password');
  const [stepUpValue, setStepUpValue] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<AccessFailure | null>(null);
  // A URL is a request, not a state. This surface is the only one reachable
  // without passing a row affordance, so it reconciles `?action=` against the
  // live endpoint state below (see the withdrawn-action branch) exactly as
  // `vaultStateAffordance` does for the rows — otherwise a link minted before
  // the fifth wrong password keeps rendering a live unlock form that submission
  // can only refuse (#1526).
  const stateQuery = useVaultEndpointState(vault.id);
  const liveState = stateQuery.data ?? null;
  const stateGoverned = isVaultStateActionKind(action);
  const restoreAvailable =
    operations.listRestoreCandidates != null && operations.restoreCandidate != null;
  const restoreCandidates = useQuery({
    queryKey: ['vaults', vault.id, 'restore-candidates'],
    queryFn: () => operations.listRestoreCandidates!(vault),
    enabled: action === 'restore' && restoreAvailable,
    retry: false,
  });

  async function submit() {
    setWorking(true);
    setFailure(null);
    try {
      const fetchHeaderEnvelope = () => operations.fetchHeader(vault);
      if (action === 'unlock') {
        await endpointVaultKeystore.unlock(secret);
        await endpointVaultKeystore.openStoredVault(
          vault.id,
          fetchHeaderEnvelope,
          vault.keyFingerprint,
        );
      } else if (action === 'open') {
        await endpointVaultKeystore.openStoredVault(
          vault.id,
          fetchHeaderEnvelope,
          vault.keyFingerprint,
        );
      } else if (action === 'provide-phrase') {
        await endpointVaultKeystore.storeAfterVerifiedOpen({
          vaultId: vault.id,
          mnemonic: secret,
          devicePassword,
          expectedFingerprint: vault.keyFingerprint,
          fetchHeaderEnvelope,
        });
      } else if (action === 'reset-endpoint') {
        if (!resetAcknowledged) return;
        await endpointVaultKeystore.reset();
      } else if (action === 'rotate' && operations.rotate) {
        await operations.rotate(vault);
      } else if (action === 'start-fresh' && operations.startFresh) {
        if (!destructionAcknowledged || stepUpValue.trim() === '') return;
        await operations.startFresh(vault, {
          [stepUpKind]: stepUpValue.trim(),
        } as VaultStepUpCredential);
      } else if (action === 'scan-qr' && operations.scanQr) {
        await operations.scanQr(vault);
      } else {
        throw new Error('vault-action-unavailable');
      }
      await onDone();
    } catch (cause) {
      setFailure(accessFailure(cause));
      // A lockout also changed this endpoint's state: re-read it so the surface
      // stops offering the action the keystore just withdrew.
      if (isLockedOut(cause)) void stateQuery.refetch();
    } finally {
      setWorking(false);
    }
  }

  const needsPhrase = action === 'provide-phrase';
  const needsSecret = action === 'unlock' || needsPhrase;
  const isReset = action === 'reset-endpoint';
  const isStartFresh = action === 'start-fresh';
  // A deep link can still reach a deferred action. It gets the reason and the
  // vault's live next step — never a Continue button that can only refuse.
  const deferredKey = deferredReasonKey(action, operations);

  // A stale or hand-edited `?action=` never becomes a raw key on screen with a
  // Continue that can only throw: it gets named as unknown, plus this vault's
  // own live next step.
  if (!ACCESS_ACTIONS.has(action)) {
    return (
      <section
        aria-label={t('vault.manager.access.title', { name: vault.name })}
        className="bt-panel flex flex-col gap-3 p-4"
      >
        <h4 className="bt-h2">{t('vault.manager.access.title', { name: vault.name })}</h4>
        <DeferredActionNotice reasonKey="vault.manager.access.unknownAction" vault={vault} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} type="button" variant="quiet">
            {t('common.cancel')}
          </Button>
        </div>
      </section>
    );
  }

  // A state-governed action is never rendered on a guess: until this endpoint's
  // own state is known, the surface says it is checking rather than painting a
  // form that the next tick may withdraw.
  if (stateGoverned && liveState == null) {
    return (
      <section
        aria-label={t('vault.manager.access.title', { name: vault.name })}
        className="bt-panel flex flex-col gap-3 p-4"
      >
        <h4 className="bt-h2">{t('vault.manager.access.title', { name: vault.name })}</h4>
        {stateQuery.isPending ? (
          <p aria-live="polite" className="bt-row-sub">
            {t('vault.manager.access.checkingState')}
          </p>
        ) : null}
        {stateQuery.isError ? (
          <RetryNotice
            message={t('vault.manager.access.stateError')}
            onRetry={() => void stateQuery.refetch()}
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} type="button" variant="quiet">
            {t('common.cancel')}
          </Button>
        </div>
      </section>
    );
  }

  // The reconciliation itself: an action this state no longer offers is answered
  // with the affordance the row would give — and, in lockout, with the instant
  // the endpoint accepts a password again instead of an invitation to type one.
  if (liveState != null && stateGoverned && !vaultStateOffersAction(liveState, action)) {
    const retryAt = vaultStateRetryAt(liveState);
    return (
      <section
        aria-label={t('vault.manager.access.title', { name: vault.name })}
        className="bt-panel flex flex-col gap-3 p-4"
      >
        <h4 className="bt-h2">{t('vault.manager.access.title', { name: vault.name })}</h4>
        <DeferredActionNotice
          reasonKey={
            retryAt == null
              ? 'vault.manager.access.withdrawnAction'
              : 'vault.manager.access.lockedOut'
          }
          reasonVars={retryAt == null ? undefined : { time: vaultRetryTimeLabel(retryAt) }}
          vault={vault}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} type="button" variant="quiet">
            {t('common.cancel')}
          </Button>
        </div>
      </section>
    );
  }

  if (action === 'open') {
    return (
      <SilentVaultOpen
        failure={failure}
        open={() => void submit()}
        title={t('vault.manager.access.title', { name: vault.name })}
      />
    );
  }

  if (action === 'restore') {
    return (
      <section
        aria-label={t('vault.manager.access.title', { name: vault.name })}
        className="bt-panel flex flex-col gap-3 p-4"
      >
        <div>
          <h4 className="bt-h2">{t('vault.manager.access.title', { name: vault.name })}</h4>
          <p className="bt-row-sub">{t('vault.manager.access.restore')}</p>
        </div>
        {!restoreAvailable ? (
          <DeferredActionNotice reasonKey={DEFERRED_ACTION_REASONS.restore} vault={vault} />
        ) : restoreCandidates.isPending ? (
          <SkeletonBlock height={96} />
        ) : restoreCandidates.isError ? (
          <RetryNotice
            message={t('vault.manager.access.restoreLoadError')}
            onRetry={() => void restoreCandidates.refetch()}
          />
        ) : (
          <VaultRestorePicker
            candidates={restoreCandidates.data}
            onRestore={async (candidate) => {
              await operations.restoreCandidate!(vault, candidate);
              await onDone();
            }}
          />
        )}
        <Button onClick={onClose} type="button" variant="quiet">
          {t('common.cancel')}
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-label={t('vault.manager.access.title', { name: vault.name })}
      className="bt-panel flex flex-col gap-3 p-4"
    >
      <div>
        <h4 className="bt-h2">{t('vault.manager.access.title', { name: vault.name })}</h4>
        <p className={isStartFresh ? 'bt-gold-note' : 'bt-row-sub'}>
          {t(`vault.manager.access.${action}`)}
        </p>
      </div>
      {deferredKey ? <DeferredActionNotice reasonKey={deferredKey} vault={vault} /> : null}
      {needsSecret ? (
        <Field
          htmlFor={`vault-access-secret-${vault.id}`}
          label={t(
            needsPhrase ? 'vault.manager.access.words' : 'vault.manager.access.devicePassword',
          )}
        >
          <Input
            autoComplete={needsPhrase ? 'off' : 'current-password'}
            id={`vault-access-secret-${vault.id}`}
            onChange={(event) => setSecret(event.target.value)}
            type={needsPhrase ? 'text' : 'password'}
            value={secret}
          />
        </Field>
      ) : null}
      {needsPhrase ? (
        <>
          <Field
            htmlFor={`vault-access-device-password-${vault.id}`}
            label={t('vault.manager.access.newDevicePassword')}
          >
            <Input
              autoComplete="new-password"
              id={`vault-access-device-password-${vault.id}`}
              onChange={(event) => setDevicePassword(event.target.value)}
              type="password"
              value={devicePassword}
            />
          </Field>
          {operations.scanQr ? (
            <Button
              onClick={() => void operations.scanQr?.(vault)}
              size="sm"
              type="button"
              variant="quiet"
            >
              {t('vault.manager.action.scanQr')}
            </Button>
          ) : (
            <p className="bt-meta">{t(DEFERRED_ACTION_REASONS['scan-qr'])}</p>
          )}
        </>
      ) : null}
      {isReset ? (
        <CheckRow checked={resetAcknowledged} onChange={setResetAcknowledged} tone="gold">
          {t('vault.manager.access.resetConfirm')}
        </CheckRow>
      ) : null}
      {isStartFresh ? (
        <>
          <CheckRow
            checked={destructionAcknowledged}
            onChange={setDestructionAcknowledged}
            tone="gold"
          >
            {t('vault.manager.access.startFreshConfirm')}
          </CheckRow>
          <CredentialFields
            credential={stepUpValue}
            credentialKind={stepUpKind}
            id={`vault-start-fresh-${vault.id}`}
            onCredentialChange={setStepUpValue}
            onKindChange={setStepUpKind}
          />
        </>
      ) : null}
      {failure ? <AccessFailureNotice failure={failure} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={working} onClick={onClose} type="button" variant="quiet">
          {t('common.cancel')}
        </Button>
        {deferredKey ? null : (
          <Button
            disabled={
              working ||
              (needsSecret && secret.trim() === '') ||
              (needsPhrase && devicePassword === '') ||
              (isReset && !resetAcknowledged) ||
              (isStartFresh && (!destructionAcknowledged || stepUpValue.trim() === ''))
            }
            onClick={() => void submit()}
            type="button"
            variant={isStartFresh ? 'danger' : 'primary'}
          >
            {working ? t('common.loading') : t('vault.manager.access.action')}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * The §12 invariant applied to an action this build cannot finish: say what is
 * missing, and still offer the vault's own live next step. Never a silent
 * disabled control — "a state without a next action is a design bug".
 */
function DeferredActionNotice({
  reasonKey,
  reasonVars,
  vault,
}: {
  reasonKey: string;
  reasonVars?: TranslateVars;
  vault: VaultConfig;
}) {
  const t = useT();
  const stateQuery = useVaultEndpointState(vault.id);
  return (
    <Panel className="flex flex-col items-start gap-2 p-3" pad={false} soft>
      <p className="bt-soft text-sm">{t(reasonKey, reasonVars)}</p>
      {stateQuery.data ? (
        <VaultStateAction state={stateQuery.data} vaultId={vault.id} />
      ) : (
        <Button
          disabled={stateQuery.isPending}
          onClick={() => void stateQuery.refetch()}
          size="sm"
          type="button"
          variant="quiet"
        >
          {stateQuery.isError ? t('common.retry') : t('common.loading')}
        </Button>
      )}
    </Panel>
  );
}

/**
 * A refusal this surface can name. §12: a device-password lockout is not "that
 * action could not be completed" — it has a code and a deadline, and the QR
 * sender already says so. Collapsing it here would invite the user to retype a
 * password no verification will look at, with the retry instant never shown.
 */
interface AccessFailure {
  key: string;
  vars?: TranslateVars;
}

function isLockedOut(cause: unknown): cause is EndpointKeystoreError {
  return cause instanceof EndpointKeystoreError && cause.code === 'locked-out';
}

function accessFailure(cause: unknown): AccessFailure {
  const retryAt = isLockedOut(cause) ? cause.details.retryAt : undefined;
  return retryAt == null
    ? { key: 'vault.manager.access.error' }
    : {
        key: 'vault.manager.access.lockedOut',
        vars: { time: vaultRetryTimeLabel(retryAt) },
      };
}

function AccessFailureNotice({ failure }: { failure: AccessFailure }) {
  const t = useT();
  return (
    <p className="bt-neg text-sm" role="alert">
      {t(failure.key, failure.vars)}
    </p>
  );
}

function SilentVaultOpen({
  open,
  failure,
  title,
}: {
  open(): void;
  failure: AccessFailure | null;
  title: string;
}) {
  const t = useT();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    open();
  }, [open]);
  return (
    <section aria-label={title} className="bt-panel flex flex-col gap-3 p-4">
      <p className="bt-row-sub">{t('vault.manager.access.opening')}</p>
      {failure ? <AccessFailureNotice failure={failure} /> : null}
    </section>
  );
}

function CredentialFields({
  id,
  credentialKind,
  credential,
  onKindChange,
  onCredentialChange,
}: {
  id: string;
  credentialKind: 'password' | 'code' | 'recoveryCode';
  credential: string;
  onKindChange(kind: 'password' | 'code' | 'recoveryCode'): void;
  onCredentialChange(value: string): void;
}) {
  const t = useT();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field htmlFor={`${id}-kind`} label={t('vault.portfolioMove.credentialKind')}>
        <Select
          id={`${id}-kind`}
          onChange={(event) =>
            onKindChange(event.target.value as 'password' | 'code' | 'recoveryCode')
          }
          value={credentialKind}
        >
          <option value="password">{t('vault.portfolioMove.credential.password')}</option>
          <option value="code">{t('vault.portfolioMove.credential.code')}</option>
          <option value="recoveryCode">{t('vault.portfolioMove.credential.recoveryCode')}</option>
        </Select>
      </Field>
      <Field htmlFor={`${id}-value`} label={t('vault.portfolioMove.credentialValue')}>
        <Input
          id={`${id}-value`}
          onChange={(event) => onCredentialChange(event.target.value)}
          type={credentialKind === 'password' ? 'password' : 'text'}
          value={credential}
        />
      </Field>
    </div>
  );
}
