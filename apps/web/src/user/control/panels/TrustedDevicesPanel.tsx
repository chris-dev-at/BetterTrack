import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RememberedDeviceSummary } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDateTime } from '../../../lib/format';
import {
  listRememberedDevices,
  revokeAllRememberedDevices,
  revokeRememberedDevice,
} from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Button } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { PanelGroup, PanelHead, PanelList, PanelListItem, PanelNote, Row } from './panelKit';

const TRUSTED_DEVICES_KEY = ['auth', 'remembered-devices'] as const;

/**
 * Control Center → Trusted devices. The signed `bt_rdid` cookie is httpOnly and
 * the server intentionally exposes only opaque revocation handles, so the web
 * cannot reliably identify the current browser here. It deliberately shows no
 * current-browser marker rather than pretending it knows which row that is.
 */
export function TrustedDevicesPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: TRUSTED_DEVICES_KEY,
    queryFn: ({ signal }) => listRememberedDevices(signal),
    staleTime: 30_000,
  });

  const revokeOne = useMutation({
    mutationFn: (handle: string) => revokeRememberedDevice(handle),
    onSuccess: (_result, handle) => {
      setError(null);
      queryClient.setQueryData<RememberedDeviceSummary[]>(TRUSTED_DEVICES_KEY, (devices) =>
        devices?.filter((device) => device.handle !== handle),
      );
      void queryClient.invalidateQueries({ queryKey: TRUSTED_DEVICES_KEY });
    },
    onError: () => setError(t('settings.security.trustedDevices.revokeError')),
  });

  const revokeAll = useMutation({
    mutationFn: () => revokeAllRememberedDevices(),
    onSuccess: () => {
      setError(null);
      setConfirmingAll(false);
      queryClient.setQueryData<RememberedDeviceSummary[]>(TRUSTED_DEVICES_KEY, []);
      void queryClient.invalidateQueries({ queryKey: TRUSTED_DEVICES_KEY });
    },
    onError: () => setError(t('settings.security.trustedDevices.revokeAllError')),
  });

  const devices = query.data ?? [];
  const mutationPending = revokeOne.isPending || revokeAll.isPending;

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.trustedDevices')} />
      <PanelNote>{t('settings.security.trustedDevices.description')}</PanelNote>

      <PanelGroup>
        {error ? (
          <Row stack>
            <Alert tone="error">{error}</Alert>
          </Row>
        ) : null}

        {query.isPending ? (
          <Row stack>
            <Skeleton height="h-16" />
          </Row>
        ) : query.isError ? (
          <Row stack>
            <Alert tone="error">{t('settings.security.trustedDevices.loadError.title')}</Alert>
            <Button onClick={() => void query.refetch()} size="sm" type="button">
              {t('common.retry')}
            </Button>
          </Row>
        ) : devices.length === 0 ? (
          <Row stack>
            <PanelNote>{t('settings.security.trustedDevices.empty')}</PanelNote>
          </Row>
        ) : (
          <>
            <PanelList>
              {devices.map((device) => (
                <PanelListItem
                  actions={
                    <Button
                      disabled={mutationPending}
                      onClick={() => {
                        setError(null);
                        revokeOne.mutate(device.handle);
                      }}
                      size="sm"
                      type="button"
                      variant="danger"
                    >
                      {t('settings.security.trustedDevices.revoke')}
                    </Button>
                  }
                  key={device.handle}
                  main={
                    <>
                      <span className="bt-cc-row__label">
                        {t('settings.security.trustedDevices.device')}
                      </span>
                      <span className="bt-cc-row__hint">
                        {t('settings.security.trustedDevices.timestamps', {
                          createdAt: formatDateTime(device.createdAt),
                          lastSeenAt: formatDateTime(device.lastSeenAt),
                          expiresAt: formatDateTime(device.expiresAt),
                        })}
                      </span>
                    </>
                  }
                />
              ))}
            </PanelList>

            <Row stack>
              {confirmingAll ? (
                <div className="flex flex-col gap-2">
                  <PanelNote>{t('settings.security.trustedDevices.confirmRevokeAll')}</PanelNote>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={mutationPending}
                      onClick={() => revokeAll.mutate()}
                      size="sm"
                      type="button"
                      variant="danger"
                    >
                      {revokeAll.isPending
                        ? t('settings.security.trustedDevices.revoking')
                        : t('settings.security.trustedDevices.revokeAll')}
                    </Button>
                    <Button
                      disabled={mutationPending}
                      onClick={() => setConfirmingAll(false)}
                      size="sm"
                      type="button"
                      variant="quiet"
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  className="self-start"
                  disabled={mutationPending}
                  onClick={() => {
                    setError(null);
                    setConfirmingAll(true);
                  }}
                  size="sm"
                  type="button"
                  variant="danger"
                >
                  {t('settings.security.trustedDevices.revokeAll')}
                </Button>
              )}
            </Row>
          </>
        )}
      </PanelGroup>
    </div>
  );
}
