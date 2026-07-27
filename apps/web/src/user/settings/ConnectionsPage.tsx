import { useEffect, useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { formatDateTime } from '../../lib/format';
import {
  getGoogleLinkStatus,
  getVaultMediaState,
  googleStartUrl,
  unlinkGoogle,
} from '../../lib/userApi';
import { EmptyState, Skeleton } from '../../ui';
import {
  getDriveConnectionController,
  type DriveConnectionActionResult,
  type DriveConnectionController,
} from '../vault/media';
import { Alert, Button, TextField, cx } from '../components/ui';

const GOOGLE_KEY = ['auth', 'google', 'link-status'] as const;
const VAULT_MEDIA_KEY = ['account', 'paranoid', 'media'] as const;

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
      <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.security.google.title')}
        </h3>
        <EmptyState
          title={t('settings.security.google.loadError')}
          description={t('settings.retryHint')}
        />
      </section>
    );
  }
  if (query.isPending) {
    return (
      <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.security.google.title')}
        </h3>
        <Skeleton height="h-6" />
      </section>
    );
  }
  if (!query.data.enabled) return null;
  const status = query.data;

  return (
    <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <h3 className="text-sm font-semibold text-neutral-100">
        {t('settings.security.google.title')}
      </h3>
      <p className="text-xs text-neutral-500">{t('settings.security.google.description')}</p>
      {connectError ? <Alert tone="error">{connectError}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {status.linked ? (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm text-neutral-300">
              {t('settings.security.google.linkedAs', { email: status.email ?? '' })}
            </p>
            {status.linkedAt ? (
              <p className="text-xs text-neutral-500">
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
                <p className="text-xs text-neutral-400">
                  {t('settings.security.google.unlinkPrompt')}
                </p>
                <TextField
                  label={t('settings.security.google.passwordLabel')}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={unlink.isPending || password.length === 0}
                  >
                    {t('settings.security.google.confirmUnlink')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setUnlinking(false);
                      setError(null);
                      setPassword('');
                    }}
                  >
                    {t('settings.security.google.cancel')}
                  </Button>
                </div>
              </form>
            ) : (
              <div>
                <Button variant="secondary" onClick={() => setUnlinking(true)}>
                  {t('settings.security.google.unlinkButton')}
                </Button>
              </div>
            )
          ) : (
            <Alert tone="info">{t('settings.security.google.onlyMethod')}</Alert>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-400">{t('settings.security.google.notLinked')}</p>
          <a
            href={googleStartUrl()}
            className="inline-flex w-fit items-center justify-center rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-semibold text-neutral-200 transition-colors hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {t('settings.security.google.connectButton')}
          </a>
        </div>
      )}
    </section>
  );
}

function DriveVaultSection({
  connection,
  configured,
}: {
  connection: DriveConnectionController | null;
  configured: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'error' | 'success' | 'info';
    key: string;
  } | null>(null);
  const query = useQuery({
    queryKey: VAULT_MEDIA_KEY,
    queryFn: ({ signal }) => getVaultMediaState(signal),
    retry: false,
    staleTime: 15_000,
  });

  if (query.isError) {
    // Normal-mode accounts have no paranoid media state, so the card is absent.
    if (
      query.error instanceof ApiError &&
      (query.error.status === 403 || query.error.status === 404)
    ) {
      return null;
    }
    return (
      <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.connections.drive.title')}
        </h3>
        <EmptyState
          title={t('settings.connections.drive.loadError')}
          description={t('settings.retryHint')}
        />
      </section>
    );
  }
  if (query.isPending) {
    return (
      <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.connections.drive.title')}
        </h3>
        <Skeleton height="h-6" />
      </section>
    );
  }

  const media = query.data;
  const selected = media.mediaSet.includes('drive');
  const needsSignIn = selected && connection?.authorization !== 'connected';
  const statusKey = working
    ? 'working'
    : selected
      ? needsSignIn
        ? 'needsSignIn'
        : 'connected'
      : 'disconnected';

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: VAULT_MEDIA_KEY });
  }

  function unavailable(): boolean {
    if (connection) return false;
    setMessage({
      tone: 'info',
      key: configured
        ? 'settings.connections.drive.unlockRequired'
        : 'settings.connections.drive.configMissing',
    });
    return true;
  }

  async function connect(): Promise<void> {
    if (unavailable()) return;
    setWorking(true);
    setMessage(null);
    try {
      const result = await connection!.connect();
      if (result.status === 'ok' || result.status === 'noop') {
        setMessage({ tone: 'success', key: 'settings.connections.drive.connectedNotice' });
        await refresh();
      } else {
        setMessage({ tone: 'error', key: 'settings.connections.drive.actionError' });
      }
    } catch {
      setMessage({ tone: 'error', key: 'settings.connections.drive.actionError' });
    } finally {
      setWorking(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (unavailable()) return;
    setWorking(true);
    setMessage(null);
    try {
      const result: DriveConnectionActionResult = await connection!.disconnect();
      if (result.status === 'ok' || result.status === 'noop') {
        setMessage({ tone: 'success', key: 'settings.connections.drive.disconnectedNotice' });
        await refresh();
      } else if (result.status === 'drive-leftover') {
        setMessage({ tone: 'info', key: 'settings.connections.drive.leftover' });
        await refresh();
      } else {
        setMessage({ tone: 'error', key: 'settings.connections.drive.actionError' });
      }
    } catch {
      setMessage({ tone: 'error', key: 'settings.connections.drive.actionError' });
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.connections.drive.title')}
        </h3>
        <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-neutral-300">
          {t(`settings.connections.drive.status.${statusKey}`)}
        </span>
      </div>
      <p className="text-xs text-neutral-500">{t('settings.connections.drive.description')}</p>
      {message ? <Alert tone={message.tone}>{t(message.key)}</Alert> : null}
      {selected && media.mediaSet.length === 1 ? (
        <Alert tone="info">{t('settings.connections.drive.lastMedium')}</Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!selected || needsSignIn ? (
          <Button type="button" variant="secondary" disabled={working} onClick={connect}>
            {t(
              selected ? 'settings.connections.drive.signIn' : 'settings.connections.drive.connect',
            )}
          </Button>
        ) : null}
        {selected && media.mediaSet.length > 1 ? (
          <Button type="button" variant="ghost" disabled={working} onClick={disconnect}>
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
    <li className="flex flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-neutral-200">
          {t(`settings.connections.slots.${slotKey}.name`)}
        </span>
        <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-neutral-400">
          {t('settings.connections.comingSoon')}
        </span>
      </div>
      <p className="text-xs text-neutral-500">
        {t(`settings.connections.slots.${slotKey}.purpose`)}
      </p>
      <p className="text-xs text-neutral-600">
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
    <details className="group rounded-md border border-neutral-800 bg-neutral-900">
      <summary
        className={cx(
          'flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4',
          'text-sm font-semibold text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        )}
      >
        <span className="flex flex-col gap-0.5">
          <span>{t('settings.connections.slotsTitle')}</span>
          <span className="text-xs font-normal text-neutral-500">
            {t('settings.connections.slotsSubtitle')}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="text-neutral-500 transition-transform group-open:rotate-90"
        >
          ▸
        </span>
      </summary>
      <ul className="flex flex-col gap-2 px-5 pb-5">
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
  driveConnection = getDriveConnectionController(),
  driveConfigured = Boolean(import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID),
}: {
  driveConnection?: DriveConnectionController | null;
  driveConfigured?: boolean;
} = {}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">
          {t('settings.connections.title')}
        </h2>
        <p className="text-sm text-neutral-500">{t('settings.connections.subtitle')}</p>
      </div>

      <GoogleSection />

      <DriveVaultSection connection={driveConnection} configured={driveConfigured} />

      <ConnectorSlots />
    </div>
  );
}
