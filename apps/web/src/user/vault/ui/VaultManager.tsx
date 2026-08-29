import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

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
import { Button, Field, Input, Select, SkeletonBlock } from '../../../ui/origin';
import { CHECKBOX_STYLE } from '../../components/ui';
import { useAuth } from '../../AuthContext';
import { portfolioDisplayName } from '../../portfolio/lockedPortfolio';
import { usePortfolioStore } from '../../portfolio/PortfolioStoreProvider';
import { PER_VAULT_DRIVE_PROVISIONING_AVAILABLE } from '../capabilities';
import type { EndpointVaultState } from '../keystore';
import { EndpointKeystoreError } from '../keystore/errors';
import { endpointVaultKeystore } from '../keystore/runtime';
import { provisionVault, type ProvisionVaultInput } from '../provisionVault';
import type { RestoreCandidate } from '../restore';
import {
  isVaultStateActionKind,
  vaultStateAffordance,
  vaultStateOffersAction,
  vaultStateRetryAt,
} from '../vaultStateAffordance';
import { vaultRetryTimeLabel } from './retryTime';
import { VaultCreationCeremony, type VaultCreationInput } from './VaultCreationCeremony';
import { VaultRestorePicker } from './VaultRestorePicker';
import { VaultStateAction } from './VaultStateAction';
import { useVaultEndpointState, vaultEndpointStateQueryKey } from './useVaultEndpointState';

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
  const endpointQueries = useQueries({
    queries: vaults.map((vault) => ({
      queryKey: vaultEndpointStateQueryKey(vault.id),
      queryFn: () => endpointVaultKeystore.stateFor(vault.id),
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

      <ul className="grid gap-2 text-sm sm:grid-cols-3">
        {(['names', 'storage', 'privacy'] as const).map((item) => (
          <li className="bt-soft" key={item}>
            {t(`vault.manager.explainer.${item}`)}
          </li>
        ))}
      </ul>

      {creating ? (
        <>
          {driveConnectionsNeeded && connectionsQuery.isPending ? (
            <SkeletonBlock height={48} />
          ) : null}
          {driveConnectionsNeeded && connectionsQuery.isError ? (
            <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
              <span>{t('vault.manager.connectionsError')}</span>
              <Button onClick={() => void connectionsQuery.refetch()} size="sm" type="button">
                {t('common.retry')}
              </Button>
            </div>
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
        <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
          <span>{t('vault.manager.loadError')}</span>
          <Button onClick={() => void vaultsQuery.refetch()} size="sm" type="button">
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {vaultsQuery.isSuccess && vaults.length === 0 && !creating ? (
        <p className="bt-soft text-sm">{t('vault.manager.empty')}</p>
      ) : null}

      {portfoliosQuery.isPending && vaults.length > 0 ? <SkeletonBlock height={36} /> : null}
      {portfoliosQuery.isError && vaults.length > 0 ? (
        <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
          <span>{t('vault.manager.portfoliosError')}</span>
          <Button onClick={() => void portfoliosQuery.refetch()} size="sm" type="button">
            {t('common.retry')}
          </Button>
        </div>
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
              vault={vault}
            />
          ))}
        </ul>
      ) : null}

      {activeVault && activeAction ? (
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
}: {
  vault: VaultConfig;
  endpointQuery: UseQueryResult<EndpointVaultState, Error> | undefined;
  driveConnection: DriveConnection | undefined;
  memberships: readonly PortfolioSummary[];
  membershipReady: boolean;
  onChanged(): Promise<void>;
  operations: VaultManagerOperations;
}) {
  const t = useT();
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

  return (
    <li className="bt-panel flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="bt-row-title truncate">{vault.name}</p>
          <p className="bt-row-sub">
            {t(
              vault.media.length === 2
                ? 'vault.manager.media.both'
                : `vault.manager.media.${vault.media[0] ?? 'server'}`,
            )}
            {state ? ` · ${t(vaultStateAffordance(state).stateKey)}` : ''}
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
          <VaultStateAction state={state} vaultId={vault.id} />
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
          <ul className="mt-1 flex flex-wrap gap-2">
            {memberships.map((portfolio) => (
              <li className="bt-badge" key={portfolio.id}>
                {portfolioDisplayName(portfolio, t('vault.lockedStub.fallbackAlias'))}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="bt-row-sub">{t('vault.manager.noPortfolios')}</p>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <button className="bt-link" onClick={() => setRenameOpen((open) => !open)} type="button">
          {t('vault.manager.action.rename')}
        </button>
        <Link className="bt-link" to={`/control/connections?vault=${encodeURIComponent(vault.id)}`}>
          {t('vault.manager.action.changeMedia')}
        </Link>
        {/* An action this build cannot finish is never a link: it stays visible
            as what it is, with the missing piece named beside it. */}
        {rotateDeferred ? (
          <span className="bt-muted">{t('vault.manager.action.rotate')}</span>
        ) : (
          <Link
            className="bt-link"
            to={`/control/privacy?vault=${encodeURIComponent(vault.id)}&action=rotate`}
          >
            {t('vault.manager.action.rotate')}
          </Link>
        )}
        {startFreshDeferred ? (
          <span className="bt-muted">{t('vault.manager.action.startFresh')}</span>
        ) : (
          <Link
            className="bt-link"
            to={`/control/privacy?vault=${encodeURIComponent(vault.id)}&action=start-fresh`}
          >
            {t('vault.manager.action.startFresh')}
          </Link>
        )}
        <button
          className="bt-link bt-neg"
          disabled={!membershipReady || memberships.length > 0}
          onClick={() => setDeleteOpen((open) => !open)}
          type="button"
        >
          {t('common.delete')}
        </button>
      </div>
      {rotateDeferred ? <p className="bt-meta">{t(rotateDeferred)}</p> : null}
      {startFreshDeferred ? <p className="bt-meta">{t(startFreshDeferred)}</p> : null}
      {/* "Delete refuses while a portfolio is inside, and says so" — said with
          the membership list already in hand, not after a server round trip.
          The server refusal below still stands for the cross-device race. */}
      {membershipReady && memberships.length > 0 ? (
        <p className="bt-meta">{t('vault.manager.deleteReferenced')}</p>
      ) : null}

      {renameOpen ? (
        <div className="flex flex-wrap items-end gap-2">
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
        </div>
      ) : null}

      {deleteOpen ? (
        <div className="bt-soft flex flex-col gap-3">
          <p className="text-sm">{t('vault.manager.deleteWarning')}</p>
          <CredentialFields
            credential={credential}
            credentialKind={credentialKind}
            id={`vault-delete-${vault.id}`}
            onCredentialChange={setCredential}
            onKindChange={setCredentialKind}
          />
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
      ) : null}
      {errorKey ? (
        <p className="bt-neg text-sm" role="alert">
          {t(errorKey)}
        </p>
      ) : null}
    </li>
  );
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
  const effectiveAction = action;
  // A URL is a request, not a state. This surface is the only one reachable
  // without passing a row affordance, so it reconciles `?action=` against the
  // live endpoint state exactly as `vaultStateAffordance` does for the rows —
  // otherwise a link minted before the fifth wrong password keeps rendering a
  // live unlock form that submission can only refuse.
  const stateQuery = useVaultEndpointState(vault.id);
  const liveState = stateQuery.data ?? null;
  const stateGoverned = isVaultStateActionKind(effectiveAction);
  const restoreAvailable =
    operations.listRestoreCandidates != null && operations.restoreCandidate != null;
  const restoreCandidates = useQuery({
    queryKey: ['vaults', vault.id, 'restore-candidates'],
    queryFn: () => operations.listRestoreCandidates!(vault),
    enabled: effectiveAction === 'restore' && restoreAvailable,
    retry: false,
  });

  async function submit() {
    setWorking(true);
    setFailure(null);
    try {
      const fetchHeaderEnvelope = () => operations.fetchHeader(vault);
      if (effectiveAction === 'unlock') {
        await endpointVaultKeystore.unlock(secret);
        await endpointVaultKeystore.openStoredVault(
          vault.id,
          fetchHeaderEnvelope,
          vault.keyFingerprint,
        );
      } else if (effectiveAction === 'open') {
        await endpointVaultKeystore.openStoredVault(
          vault.id,
          fetchHeaderEnvelope,
          vault.keyFingerprint,
        );
      } else if (effectiveAction === 'provide-phrase') {
        await endpointVaultKeystore.storeAfterVerifiedOpen({
          vaultId: vault.id,
          mnemonic: secret,
          devicePassword,
          expectedFingerprint: vault.keyFingerprint,
          fetchHeaderEnvelope,
        });
      } else if (effectiveAction === 'reset-endpoint') {
        if (!resetAcknowledged) return;
        await endpointVaultKeystore.reset();
      } else if (effectiveAction === 'rotate' && operations.rotate) {
        await operations.rotate(vault);
      } else if (effectiveAction === 'start-fresh' && operations.startFresh) {
        if (!destructionAcknowledged || stepUpValue.trim() === '') return;
        await operations.startFresh(vault, {
          [stepUpKind]: stepUpValue.trim(),
        } as VaultStepUpCredential);
      } else if (effectiveAction === 'scan-qr' && operations.scanQr) {
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

  const needsPhrase = effectiveAction === 'provide-phrase';
  const needsSecret = effectiveAction === 'unlock' || needsPhrase;
  const isReset = effectiveAction === 'reset-endpoint';
  const isStartFresh = effectiveAction === 'start-fresh';
  // A deep link can still reach a deferred action. It gets the reason and the
  // vault's live next step — never a Continue button that can only refuse.
  const deferredKey = deferredReasonKey(effectiveAction, operations);

  // A stale or hand-edited `?action=` never becomes a raw key on screen with a
  // Continue that can only throw: it gets named as unknown, plus this vault's
  // own live next step.
  if (!ACCESS_ACTIONS.has(effectiveAction)) {
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
          <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
            <span>{t('vault.manager.access.stateError')}</span>
            <Button onClick={() => void stateQuery.refetch()} size="sm" type="button">
              {t('common.retry')}
            </Button>
          </div>
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
  if (liveState != null && stateGoverned && !vaultStateOffersAction(liveState, effectiveAction)) {
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

  if (effectiveAction === 'open') {
    return (
      <SilentVaultOpen
        failure={failure}
        open={() => void submit()}
        title={t('vault.manager.access.title', { name: vault.name })}
      />
    );
  }

  if (effectiveAction === 'restore') {
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
          <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
            <span>{t('vault.manager.access.restoreLoadError')}</span>
            <Button onClick={() => void restoreCandidates.refetch()} size="sm" type="button">
              {t('common.retry')}
            </Button>
          </div>
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
          {t(`vault.manager.access.${effectiveAction}`)}
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
        <label className="bt-soft flex items-start gap-2 text-sm">
          <input
            checked={resetAcknowledged}
            onChange={(event) => setResetAcknowledged(event.target.checked)}
            style={CHECKBOX_STYLE}
            type="checkbox"
          />
          <span>{t('vault.manager.access.resetConfirm')}</span>
        </label>
      ) : null}
      {isStartFresh ? (
        <>
          <label className="bt-soft flex items-start gap-2 text-sm">
            <input
              checked={destructionAcknowledged}
              onChange={(event) => setDestructionAcknowledged(event.target.checked)}
              style={CHECKBOX_STYLE}
              type="checkbox"
            />
            <span>{t('vault.manager.access.startFreshConfirm')}</span>
          </label>
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
    <div className="bt-soft flex flex-col items-start gap-2 text-sm">
      <p>{t(reasonKey, reasonVars)}</p>
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
    </div>
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
