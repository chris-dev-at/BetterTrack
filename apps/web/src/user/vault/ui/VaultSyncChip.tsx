import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  VAULT_MEDIA,
  VAULT_SERVER_ACCEPTED_MEDIA,
  type ParanoidVaultMediaState,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDateTime } from '../../../lib/format';
import { Icon } from '../../../ui/origin';
import { cx } from '../../components/ui';
import {
  projectVaultMediaSyncStatus,
  type VaultAggregateSyncProjection,
  type VaultDirectorySyncInput,
} from '../media/status';
import { useVaultRuntime } from '../VaultRuntimeContext';
import { VaultStateAction } from './VaultStateAction';

type VaultSyncChipProps =
  | { media: ParanoidVaultMediaState; vaults?: never }
  | { media?: never; vaults: readonly VaultDirectorySyncInput[] };

export function VaultSyncChip(props: VaultSyncChipProps) {
  return props.vaults !== undefined ? (
    <DirectoryVaultSyncChip vaults={props.vaults} />
  ) : (
    <LegacyVaultSyncChip media={props.media} />
  );
}

/** The owner-kept single-vault visual layer. Keep this markup/classes stable. */
function LegacyVaultSyncChip({ media }: { media: ParanoidVaultMediaState }) {
  const t = useT();
  const runtime = useVaultRuntime();
  const [open, setOpen] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sync = runtime.syncState;
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const projection = useMemo(
    () =>
      projectVaultMediaSyncStatus({
        media,
        syncStatus: sync?.status ?? 'locked',
        driveAuthorization: runtime.driveAuthorization,
        online,
        operationPending: resumePending,
        lastWriteAt: sync?.pending?.header.writtenAt ?? sync?.active?.header.writtenAt ?? null,
      }),
    [media, online, resumePending, runtime.driveAuthorization, sync],
  );

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function resumeDrive() {
    if (runtime.connection == null) return;
    setResumePending(true);
    try {
      await runtime.connection.resume();
      await runtime.reconnect();
    } finally {
      setResumePending(false);
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t(`vault.sync.status.${projection.overall}`)}
        className={cx(
          'bt-btn bt-btn--quiet bt-btn--sm',
          projection.overall === 'needs-attention' && 'bt-neg',
        )}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon name="shield" size={15} />
        <span className="bt-hide-below-sm">{t(`vault.sync.status.${projection.overall}`)}</span>
      </button>

      {open ? (
        <div
          aria-label={t('vault.sync.popoverTitle')}
          className="bt-popover"
          role="dialog"
          style={{ minWidth: 280, right: 0, top: 'calc(100% + 6px)' }}
        >
          <div className="flex flex-col gap-3 p-3">
            <div>
              <p className="bt-row-title">{t('vault.sync.popoverTitle')}</p>
              <p className="bt-row-sub">{t(projection.messageKey)}</p>
            </div>

            <dl className="flex flex-col gap-2">
              {VAULT_MEDIA.filter((medium) => media.mediaSet.includes(medium)).map((medium) => (
                <div className="flex items-center justify-between gap-4" key={medium}>
                  <dt className="text-sm">{t(`vault.sync.medium.${medium}`)}</dt>
                  <dd className="bt-muted text-xs">
                    {t(`vault.sync.status.${projection.perMedium[medium]}`)}
                  </dd>
                </div>
              ))}
              <div className="flex items-center justify-between gap-4">
                <dt className="text-sm">{t('vault.sync.lastWrite')}</dt>
                <dd className="bt-muted text-xs">
                  {projection.lastWriteAt == null
                    ? t('vault.sync.never')
                    : formatDateTime(projection.lastWriteAt)}
                </dd>
              </div>
            </dl>

            {sync?.pending != null ? (
              <p className="bt-muted text-xs">{t('vault.sync.pendingWrites')}</p>
            ) : null}
            {sync?.status === 'conflict' ||
            sync?.status === 'corrupt' ||
            sync?.status === 'unresolved' ? (
              <p className="bt-neg text-xs" role="alert">
                {t(`vault.sync.problem.${sync.status}`)}
              </p>
            ) : null}

            {media.mediaSet.includes('drive') && runtime.driveAuthorization !== 'connected' ? (
              <button
                className="bt-link text-left text-sm"
                disabled={resumePending}
                onClick={() => void resumeDrive()}
                type="button"
              >
                {resumePending ? t('vault.sync.reauthorizing') : t('vault.sync.reauthorize')}
              </button>
            ) : null}
            <Link
              className="bt-link text-sm"
              onClick={() => setOpen(false)}
              to="/control/privacy?restore=1"
            >
              {t('vault.sync.restore')}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The aggregate line, resolved ONCE for every place that shows it: the chip
 * label, its aria-label and the popover subtitle. Two of the four aggregate
 * messages carry a placeholder (`Locked ({{count}})`, `Attention: {{name}}`),
 * and `interpolate()` keeps an unfilled token verbatim — so a caller that
 * renders `projection.messageKey` without params paints `{{count}}` on screen.
 * One function, one call site per surface, no way to drift again.
 */
function aggregateSyncLabel(
  t: ReturnType<typeof useT>,
  projection: VaultAggregateSyncProjection,
): string {
  if (projection.overall === 'attention') {
    return t('vault.sync.aggregate.attention', {
      name: projection.attentionVaultName ?? t('vault.lockedStub.fallbackAlias'),
    });
  }
  if (projection.overall === 'locked') {
    return t(
      projection.lockedCount === 1
        ? 'vault.sync.aggregate.lockedOne'
        : 'vault.sync.aggregate.locked',
      { count: projection.lockedCount },
    );
  }
  return t(projection.messageKey);
}

function DirectoryVaultSyncChip({ vaults }: { vaults: readonly VaultDirectorySyncInput[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const projection = useMemo(() => projectVaultMediaSyncStatus({ vaults }), [vaults]);
  const label = aggregateSyncLabel(t, projection);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className={cx(
          'bt-btn bt-btn--quiet bt-btn--sm',
          projection.overall === 'attention' && 'bt-neg',
        )}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon name="shield" size={15} />
        <span className="bt-hide-below-sm">{label}</span>
      </button>

      {open ? (
        <div
          aria-label={t('vault.sync.popoverTitle')}
          className="bt-popover"
          role="dialog"
          style={{ minWidth: 280, right: 0, top: 'calc(100% + 6px)' }}
        >
          <div className="flex flex-col gap-3 p-3">
            <div>
              <p className="bt-row-title">{t('vault.sync.popoverTitle')}</p>
              <p className="bt-row-sub">{label}</p>
            </div>
            <ul className="flex max-h-80 flex-col gap-3 overflow-y-auto">
              {projection.rows.map((row) => (
                <li className="bt-b-rule flex flex-col gap-1 pb-3" key={row.vault.id}>
                  <div className="flex items-center justify-between gap-4">
                    <span className="bt-row-title truncate">{row.vault.name}</span>
                    <span className="bt-muted text-xs">
                      {t(`vault.sync.aggregate.rowState.${row.state}`)}
                    </span>
                  </div>
                  <span className="bt-row-sub">
                    {t(
                      row.vault.media.length > 1
                        ? 'vault.manager.media.both'
                        : `vault.manager.media.${row.vault.media[0] ?? 'server'}`,
                    )}
                  </span>
                  <dl className="flex flex-col gap-1">
                    {VAULT_SERVER_ACCEPTED_MEDIA.filter((medium) =>
                      row.vault.media.includes(medium),
                    ).map((medium) => (
                      <div className="flex items-center justify-between gap-4" key={medium}>
                        <dt className="bt-muted text-xs">{t(`vault.sync.medium.${medium}`)}</dt>
                        <dd className="bt-muted text-xs">
                          {t(`vault.sync.status.${row.perMedium[medium] ?? 'disconnected'}`)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <span className="bt-muted text-xs">{t(row.messageKey)}</span>
                  <span className="bt-muted text-xs">
                    {t('vault.sync.lastWrite')}:{' '}
                    {row.lastWriteAt == null
                      ? t('vault.sync.never')
                      : formatDateTime(row.lastWriteAt)}
                  </span>
                  {row.recoveryAction === 'drive-sign-in' ? (
                    <Link
                      className="bt-link text-sm"
                      to={`/control/connections?vault=${encodeURIComponent(row.vault.id)}`}
                    >
                      {t('vault.sync.aggregate.signInGoogle')}
                    </Link>
                  ) : row.recoveryAction === 'restore' ? (
                    <Link
                      className="bt-link text-sm"
                      to={`/control/privacy?vault=${encodeURIComponent(row.vault.id)}&action=restore`}
                    >
                      {t('vault.sync.aggregate.openRestore')}
                    </Link>
                  ) : null}
                  {/* The storage recovery link answers the storage problem; the
                      endpoint affordance rides alongside it rather than instead
                      of it, so a row that is BOTH needs-sign-in and locked on
                      this device still shows its unlock / enter-words step. */}
                  <VaultStateAction state={row.endpointState} vaultId={row.vault.id} />
                </li>
              ))}
            </ul>
            <Link className="bt-link text-sm" onClick={() => setOpen(false)} to="/control/privacy">
              {t('vault.sync.restore')}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
