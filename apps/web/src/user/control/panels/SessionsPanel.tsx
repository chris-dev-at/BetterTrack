import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useT } from '../../../i18n';
import { formatDateTime } from '../../../lib/format';
import { getSession, listSessions, revokeOtherSessions, revokeSession } from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Badge, Button } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { PanelGroup, PanelHead, PanelList, PanelListItem, PanelNote, Row } from './panelKit';

const SESSION_KEY = ['auth', 'session'] as const;
const SESSIONS_KEY = ['auth', 'sessions'] as const;

/** Signed-in-since / expiry line, read from `GET /auth/session`. */
function ThisSessionRow() {
  const t = useT();
  const query = useQuery({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000,
  });

  return (
    <Row label={t('settings.security.session.title')}>
      {query.isPending ? (
        <Skeleton height="h-4" width="w-48" />
      ) : query.isError ? (
        <span className="bt-field__error">{t('settings.security.session.loadError.title')}</span>
      ) : (
        <span className="bt-cc-row__hint">
          {/* Ephemeral sessions die on browser close and are server-capped
              (≤6h) — reporting the persistent 30-day window would lie (V4-P2b). */}
          {t(
            query.data.persistent
              ? 'settings.security.session.info'
              : 'settings.security.session.infoEphemeral',
            {
              signedInAt: formatDateTime(query.data.signedInAt),
              expiresAt: formatDateTime(query.data.expiresAt),
            },
          )}
        </span>
      )}
    </Row>
  );
}

/**
 * Active-sessions manager (PROJECTPLAN.md §6.1, §6.11 Security, V3-P11a). Lists
 * the caller's own sessions with a device label, sign-in + last-seen times and a
 * current-device marker; each other device can be logged out individually, or
 * all at once. The current session isn't revoked from here — use Log out.
 */
function SessionsGroup() {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirmingOthers, setConfirmingOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: ({ signal }) => listSessions(signal),
    staleTime: 30_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });

  const revokeOne = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: () => setError(t('settings.security.sessions.revokeOneError')),
  });

  const revokeOthers = useMutation({
    mutationFn: () => revokeOtherSessions(),
    onSuccess: () => {
      setError(null);
      setConfirmingOthers(false);
      void refresh();
    },
    onError: () => setError(t('settings.security.sessions.revokeOthersError')),
  });

  const sessions = query.data ?? [];
  const otherCount = sessions.filter((s) => !s.current).length;

  return (
    <PanelGroup label={t('settings.security.sessions.title')}>
      <Row stack>
        {/* A security instruction, not narration — it tells the user what to DO. */}
        <PanelNote>{t('settings.security.sessions.description')}</PanelNote>
        {error ? <Alert tone="error">{error}</Alert> : null}
      </Row>

      {query.isPending ? (
        <Row>
          <Skeleton height="h-10" />
        </Row>
      ) : query.isError ? (
        <Row stack>
          <PanelNote>{t('settings.security.sessions.loadError.title')}</PanelNote>
        </Row>
      ) : (
        <PanelList>
          {sessions.map((session) => (
            <PanelListItem
              actions={
                session.current ? null : (
                  <Button
                    disabled={revokeOne.isPending}
                    onClick={() => {
                      setError(null);
                      revokeOne.mutate(session.id);
                    }}
                    size="sm"
                    type="button"
                    variant="danger"
                  >
                    {t('settings.security.sessions.logOut')}
                  </Button>
                )
              }
              key={session.id}
              main={
                <>
                  <span className="bt-cc-row__label flex flex-wrap items-center gap-2">
                    <span>{session.device}</span>
                    {session.current ? (
                      <Badge tone="gold">{t('settings.security.sessions.currentDevice')}</Badge>
                    ) : null}
                    {/* Persistent vs ephemeral ("stay signed in") — V4-P2b, §399 §A. */}
                    <Badge outline>
                      {session.persistent
                        ? t('settings.security.sessions.persistent')
                        : t('settings.security.sessions.ephemeral')}
                    </Badge>
                  </span>
                  <span className="bt-cc-row__hint">
                    {t('settings.security.sessions.timestamps', {
                      createdAt: formatDateTime(session.createdAt),
                      lastSeenAt: formatDateTime(session.lastSeenAt),
                    })}
                  </span>
                </>
              }
            />
          ))}
        </PanelList>
      )}

      {otherCount > 0 ? (
        <Row stack>
          {confirmingOthers ? (
            <div className="flex flex-col gap-2">
              <PanelNote>
                {t(
                  otherCount === 1
                    ? 'settings.security.sessions.confirmLogoutOthersOne'
                    : 'settings.security.sessions.confirmLogoutOthersOther',
                  { count: otherCount },
                )}
              </PanelNote>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={revokeOthers.isPending}
                  onClick={() => revokeOthers.mutate()}
                  size="sm"
                  type="button"
                  variant="danger"
                >
                  {revokeOthers.isPending
                    ? t('settings.security.sessions.loggingOut')
                    : t('settings.security.sessions.logOutAllOthers')}
                </Button>
                <Button
                  onClick={() => setConfirmingOthers(false)}
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
              onClick={() => {
                setError(null);
                setConfirmingOthers(true);
              }}
              size="sm"
              type="button"
              variant="danger"
            >
              {t('settings.security.sessions.logOutAllOthers')}
            </Button>
          )}
        </Row>
      ) : null}
    </PanelGroup>
  );
}

/**
 * Control Center → Sessions (PROJECTPLAN.md §6.1, §6.11). Answers one question:
 * WHERE am I signed in? The current session and the full device list, with
 * per-device and log-out-all-others revocation.
 *
 * Everything that proves it's you — password, two-factor, passkeys and the PIN
 * app lock — is the Sign-in panel's job. The PIN moved there on owner order: it
 * is a credential, not a device listing.
 */
export function SessionsPanel() {
  const t = useT();

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.sessions')} />

      <PanelGroup>
        <ThisSessionRow />
      </PanelGroup>

      <SessionsGroup />
    </div>
  );
}
