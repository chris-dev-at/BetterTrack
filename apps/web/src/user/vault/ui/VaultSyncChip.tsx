import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { ParanoidVaultMediaState, VaultMedium } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDateTime } from '../../../lib/format';
import { Icon } from '../../../ui/origin';
import { cx } from '../../components/ui';
import { projectVaultMediaSyncStatus } from '../media/status';
import { useVaultRuntime } from '../VaultRuntimeProvider';

const MEDIUMS: readonly VaultMedium[] = ['server', 'drive'];

export function VaultSyncChip({ media }: { media: ParanoidVaultMediaState }) {
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
              {MEDIUMS.filter((medium) => media.mediaSet.includes(medium)).map((medium) => (
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
