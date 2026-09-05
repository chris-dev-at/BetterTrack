import { lazy, Suspense, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  BASE_CURRENCIES,
  EXPORT_PENDING_STALE_MS,
  type BaseCurrency,
  type ExportStatusResponse,
  type ProfileIconId,
} from '@bettertrack/contracts';

import { SUPPORTED_LOCALES, useI18n, useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { formatDate, setMoneyCurrency } from '../../../lib/format';
import { getAccountSettings, updateAccountSettings } from '../../../lib/settingsApi';
import { getProfileSettings, updateProfileSettings } from '../../../lib/socialApi';
import {
  downloadDataExport,
  getDataExportStatus,
  getMe,
  requestDataExport,
} from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Button, Field, Input, Select } from '../../../ui/origin';
import { AsyncReadState } from '../../components/AsyncReadState';
import { Alert } from '../../components/ui';
import { useResolvedPrivacyMode } from '../../vault/usePrivacyMode';
import { PanelForm, PanelGroup, PanelHead, PanelNote, Row } from './panelKit';
import { ProfileIconPicker } from './ProfileIconPicker';

const ME_KEY = ['auth', 'me'] as const;
const ACCOUNT_SETTINGS_KEY = ['settings', 'account'] as const;
const EXPORT_STATUS_KEY = ['settings', 'export'] as const;
const PROFILE_KEY = ['social', 'profile'] as const;

const ParanoidAccountExport = lazy(() =>
  import('./ParanoidAccountExport').then((module) => ({
    default: module.ParanoidAccountExport,
  })),
);

// #951 removes the old durable token cache. Clear it synchronously on mount so
// upgrades cannot leave a previously persisted credential behind.
const LEGACY_EXPORT_TOKEN_STORAGE_KEY = 'bt.export.token';

/**
 * A `pending` job old enough that nothing will build it any more (#1812) — the
 * queue lost the work. The server applies the same shared window when a fresh
 * request arrives (it retires the row instead of 429-ing on it), so offering
 * the form here matches what the request will do — as far as the two clocks
 * agree. A browser clock running fast can offer the form slightly early and get
 * the server's 429; the server stays authoritative, and the error surfaces
 * normally.
 */
function isStalledPending(status: ExportStatusResponse): boolean {
  if (status.status !== 'pending' || !status.requestedAt) return false;
  const requestedAt = Date.parse(status.requestedAt);
  if (!Number.isFinite(requestedAt)) return false;
  return Date.now() - requestedAt >= EXPORT_PENDING_STALE_MS;
}

function clearLegacyExportToken(): void {
  try {
    localStorage.removeItem(LEGACY_EXPORT_TOKEN_STORAGE_KEY);
  } catch {
    // Storage may be blocked; there is no durable-token fallback.
  }
}

/** Friendly message for the codes `POST /account/export` can return. */
function exportErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CREDENTIALS') return t('settings.export.currentWrong');
    if (err.code === 'TWO_FACTOR_INVALID_CODE') return t('settings.export.codeWrong');
    if (err.code === 'EXPORT_RATE_LIMITED' || err.status === 429)
      return t('settings.export.rateLimited');
    if (err.status >= 500) return t('common.genericError');
  }
  return t('settings.export.requestFailed');
}

/** The read-only identity rows, straight from `GET /auth/me`. */
function IdentityRows() {
  const t = useT();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: 30_000,
  });

  if (me.isPending) {
    return (
      <Row label={t('settings.account.field.username')}>
        <Skeleton height="h-4" width="w-32" />
      </Row>
    );
  }
  if (me.isError) {
    return <Row>{<Alert tone="error">{t('settings.account.loadError.title')}</Alert>}</Row>;
  }
  return (
    <>
      <Row label={t('settings.account.field.username')}>
        <span className="bt-num">{me.data.username}</span>
      </Row>
      <Row label={t('settings.account.field.email')}>
        <span className="bt-num">{me.data.email}</span>
      </Row>
      <Row label={t('settings.account.field.memberSince')}>
        <span className="bt-num">{formatDate(me.data.createdAt)}</span>
      </Row>
    </>
  );
}

/**
 * Display-language row (§13.3 V3-P1). Switches the app runtime instantly and
 * persists the choice per-user (`PATCH /settings/account`), so it survives
 * logout/login. Options show each language in its own name (endonyms).
 */
function LanguageRow() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);

  const mutation = useMutation({
    mutationFn: (code: string) => updateAccountSettings({ locale: code }),
    onSuccess: (res) => {
      queryClient.setQueryData(ACCOUNT_SETTINGS_KEY, res);
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setError(false);
    },
    onError: () => setError(true),
  });

  return (
    <Row label={t('language.title')}>
      <Select
        aria-label={t('language.label')}
        disabled={mutation.isPending}
        onChange={(e) => {
          const code = e.target.value;
          setLocale(code);
          mutation.mutate(code);
        }}
        style={{ width: 'auto', maxWidth: 220 }}
        value={locale}
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </Select>
      {error ? <span className="bt-field__error">{t('language.saveError')}</span> : null}
    </Row>
  );
}

/**
 * Base-currency row (§5.4, §13.3 V3-P10d): the currency every valuation, chart
 * and report renders in. Conversion is display-time only — the hint states that,
 * because it is the one thing a user can get wrong here. On change the formatter
 * default flips immediately and every cached query is refetched, since all
 * converted figures change denomination.
 */
function BaseCurrencyRow() {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);
  const query = useQuery({
    queryKey: ACCOUNT_SETTINGS_KEY,
    queryFn: ({ signal }) => getAccountSettings(signal),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (baseCurrency: BaseCurrency) => updateAccountSettings({ baseCurrency }),
    onSuccess: (res) => {
      queryClient.setQueryData(ACCOUNT_SETTINGS_KEY, res);
      setMoneyCurrency(res.baseCurrency);
      // Every money figure on screen is now denominated differently — refetch
      // the lot rather than trying to enumerate the affected queries.
      void queryClient.invalidateQueries();
      setError(false);
    },
    onError: () => setError(true),
  });

  return (
    <Row hint={t('settings.baseCurrency.hint')} label={t('settings.baseCurrency.title')}>
      <AsyncReadState
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      {!query.isPending && !query.error ? (
        <Select
          aria-label={t('settings.baseCurrency.label')}
          disabled={mutation.isPending}
          onChange={(e) => mutation.mutate(e.target.value as BaseCurrency)}
          style={{ width: 'auto', maxWidth: 220 }}
          value={query.data?.baseCurrency ?? 'EUR'}
        >
          {BASE_CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {t(`settings.baseCurrency.option.${code}`)}
            </option>
          ))}
        </Select>
      ) : null}
      {error ? (
        <span className="bt-field__error">{t('settings.baseCurrency.saveError')}</span>
      ) : null}
    </Row>
  );
}

/**
 * Account data export (§13.4 V4-P6a, #494): re-auth → async zip build →
 * expiring, token-gated download. The raw download token is held only in
 * component memory (#951) since the server stores only its hash; the status
 * poll drives the pending/ready/expired states.
 */
function ExportRow() {
  const t = useT();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<{ jobId: string; token: string } | null>(() => {
    clearLegacyExportToken();
    return null;
  });

  const status = useQuery({
    queryKey: EXPORT_STATUS_KEY,
    queryFn: ({ signal }) => getDataExportStatus(signal),
    // Poll while a build is in flight; idle otherwise — and never past the
    // point where the job can no longer make progress (#1812), or a lost build
    // would leave this panel polling a dead row forever.
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' && !isStalledPending(query.state.data) ? 3000 : false,
  });

  const mutation = useMutation({
    mutationFn: () => requestDataExport({ password }),
    onSuccess: (res) => {
      setHeld({ jobId: res.jobId, token: res.downloadToken });
      setPassword('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: EXPORT_STATUS_KEY });
    },
    onError: (err) => setError(exportErrorMessage(t, err)),
  });

  const current = status.data;
  // The in-memory token only unlocks the CURRENT ready job (job ids must match).
  const tokenForJob = current?.jobId && held?.jobId === current.jobId ? held.token : null;
  const isReady = current?.status === 'ready';
  // A build that stopped making progress is not "in flight" any more: the form
  // comes back, and the server lets that request supersede the dead row rather
  // than counting it against the daily allowance (#1812).
  const isStalled = current ? isStalledPending(current) : false;
  const isPending = current?.status === 'pending' && !isStalled;

  const downloadMutation = useMutation({
    mutationFn: async () => {
      if (!tokenForJob) throw new Error('No export download token is available');
      await downloadDataExport({ token: tokenForJob });
    },
    onSuccess: () => {
      // The server-side exchange is one-time. Drop the only client-held copy as
      // soon as the browser has accepted the download.
      setHeld(null);
      setError(null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'EXPORT_NOT_FOUND') setHeld(null);
      setError(t('settings.export.downloadFailed'));
    },
  });

  // A ready response includes the authoritative server expiry. Remove the
  // in-memory credential at that instant and refresh the status so a panel left
  // open naturally moves to the request-again state.
  useEffect(() => {
    if (current?.status !== 'ready' || !current.expiresAt) return;
    const expiresAt = Date.parse(current.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const expire = () => {
      setHeld(null);
      void status.refetch();
    };
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, delay);
    return () => window.clearTimeout(timer);
  }, [current?.expiresAt, current?.status, status.refetch]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <Row hint={t('settings.export.hint')} label={t('settings.export.title')} stack>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <AsyncReadState
        loading={status.isLoading}
        error={status.error}
        onRetry={() => void status.refetch()}
      />

      {isReady && tokenForJob ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="bt-pos" style={{ fontSize: 12 }}>
            {current?.expiresAt
              ? t('settings.export.readyUntil', { date: formatDate(current.expiresAt) })
              : t('settings.export.ready')}
          </span>
          <Button
            disabled={downloadMutation.isPending}
            onClick={() => {
              setError(null);
              downloadMutation.mutate();
            }}
            size="sm"
            type="button"
          >
            {t('settings.export.download')}
          </Button>
        </div>
      ) : isReady && !tokenForJob ? (
        <PanelNote>{t('settings.export.readyNoToken')}</PanelNote>
      ) : isPending ? (
        <PanelNote>{t('settings.export.pending')}</PanelNote>
      ) : isStalled ? (
        <PanelNote>{t('settings.export.stalled')}</PanelNote>
      ) : current?.status === 'expired' ? (
        <PanelNote>{t('settings.export.expired')}</PanelNote>
      ) : current?.status === 'failed' ? (
        // A refusal for size is actionable in a way a transient build failure is
        // not: requesting the same export again cannot succeed (#1714).
        <PanelNote>
          {current.error === 'EXPORT_TOO_LARGE'
            ? t('settings.export.failedTooLarge')
            : t('settings.export.failed')}
        </PanelNote>
      ) : null}

      {!isPending ? (
        <PanelForm onSubmit={onSubmit}>
          <Field htmlFor="exportPassword" label={t('settings.export.password')}>
            <Input
              autoComplete="current-password"
              id="exportPassword"
              name="exportPassword"
              onChange={(e) => setPassword(e.target.value)}
              required
              type="password"
              value={password}
            />
          </Field>
          <Button className="self-start" disabled={mutation.isPending} size="sm" type="submit">
            {mutation.isPending
              ? t('settings.export.submitting')
              : isReady ||
                  isStalled ||
                  current?.status === 'expired' ||
                  current?.status === 'failed'
                ? t('settings.export.requestAgain')
                : t('settings.export.request')}
          </Button>
        </PanelForm>
      ) : null}
    </Row>
  );
}

/** Paranoid-only: normal accounts keep exactly the single server export row. */
function CleartextExportGate() {
  const privacyMode = useResolvedPrivacyMode();
  if (privacyMode !== 'paranoid') return null;
  return (
    <Suspense fallback={null}>
      <ParanoidAccountExport />
    </Suspense>
  );
}

function ParanoidProfileIconRow() {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProfileIconId | null | undefined>(undefined);
  const query = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: ({ signal }) => getProfileSettings(signal),
  });
  const mutation = useMutation({
    // Icon only. The public-profile opt-in is NOT this row's business: sending
    // `isPublic` here would ride a profile-visibility write along with every
    // icon change, harmless today only because the paranoid transition already
    // forced it off. Omitting the field leaves the column untouched server-side.
    mutationFn: (profileIcon: ProfileIconId | null) => updateProfileSettings({ profileIcon }),
    onSuccess: (result) => {
      queryClient.setQueryData(PROFILE_KEY, result);
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setDraft(undefined);
    },
  });

  if (query.isPending) {
    return (
      <Row label={t('profile.icon.title')}>
        <Skeleton height="h-7" width="w-32" />
      </Row>
    );
  }
  if (query.isError || query.data == null) {
    return <Row>{<Alert tone="error">{t('profile.error')}</Alert>}</Row>;
  }

  const stored = query.data.profileIcon ?? null;
  const current = draft === undefined ? stored : draft;
  const dirty = draft !== undefined && draft !== stored;

  return (
    <>
      <Row stack>
        <ProfileIconPicker
          gridId="paranoid-profile-icon-grid"
          onChange={setDraft}
          username={query.data.username}
          value={current}
        />
      </Row>
      {dirty || mutation.isError ? (
        <Row>
          <Button
            disabled={!dirty || mutation.isPending}
            onClick={() => mutation.mutate(current)}
            size="sm"
          >
            {mutation.isPending ? t('sharing.saving') : t('profile.save')}
          </Button>
          {mutation.isError ? (
            <span className="bt-field__error">{t('profile.saveError')}</span>
          ) : null}
        </Row>
      ) : null}
    </>
  );
}

function ParanoidProfileIconGate() {
  const privacyMode = useResolvedPrivacyMode();
  return privacyMode === 'paranoid' ? <ParanoidProfileIconRow /> : null;
}

/**
 * Control Center → Account (PROJECTPLAN.md §6.11, §13.3 V3-P1). Who you are and
 * how the app renders for you: the read-only identity from `GET /auth/me`, the
 * display-language and base-currency pickers, and the re-auth-gated data export.
 *
 * Password moved to the Sign-in panel (it is a credential, not an identity
 * field), deletion to its own Danger-zone panel, and the retired "sharing lives
 * in Social" signpost is gone — sharing is managed where the items are.
 */
export function AccountPanel() {
  const t = useT();
  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('settings.account.title')} />

      <PanelGroup label={t('settings.account.identity')}>
        <IdentityRows />
        <ParanoidProfileIconGate />
      </PanelGroup>

      <PanelGroup label={t('settings.account.display')}>
        <LanguageRow />
        <BaseCurrencyRow />
      </PanelGroup>

      <PanelGroup label={t('settings.account.yourData')}>
        <ExportRow />
        <CleartextExportGate />
      </PanelGroup>
    </div>
  );
}
