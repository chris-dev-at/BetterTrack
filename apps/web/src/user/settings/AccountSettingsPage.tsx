import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  BASE_CURRENCIES,
  MIN_PASSWORD_LENGTH,
  type BaseCurrency,
  type ChangePasswordRequest,
} from '@bettertrack/contracts';

import { SUPPORTED_LOCALES, useI18n, useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { formatDate, setMoneyCurrency } from '../../lib/format';
import { getAccountSettings, updateAccountSettings } from '../../lib/settingsApi';
import {
  changePassword,
  downloadDataExport,
  getDataExportStatus,
  getMe,
  requestDataExport,
} from '../../lib/userApi';
import type { TranslateFn } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { Button, Field, Input, SectionHead, Select } from '../../ui/origin';
import { Alert } from '../components/ui';
import { vaultMoneyErrorKey } from '../vault/engine/errorCopy';
import type { VaultMoneyFailure } from '../vault/engine/errors';
import { useVaultMoneySession } from '../vault/engine/VaultMoneyEngineProvider';
import { createClientCleartextExport } from '../vault/export/cleartext';
import { deliverClientDownload } from '../vault/export/deliver';
import { usePrivacyMode } from '../vault/usePrivacyMode';

const ME_KEY = ['auth', 'me'] as const;
const ACCOUNT_SETTINGS_KEY = ['settings', 'account'] as const;
const EXPORT_STATUS_KEY = ['settings', 'export'] as const;

// #951 removes the old durable token cache. Clear it synchronously on mount so
// upgrades cannot leave a previously persisted credential behind.
const LEGACY_EXPORT_TOKEN_STORAGE_KEY = 'bt.export.token';

function clearLegacyExportToken(): void {
  try {
    localStorage.removeItem(LEGACY_EXPORT_TOKEN_STORAGE_KEY);
  } catch {
    // Storage may be blocked; there is no durable-token fallback.
  }
}

/** Friendly message for the codes `POST /auth/change-password` can return. */
function changeErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CREDENTIALS') return t('settings.password.currentWrong');
    if (err.code === 'WEAK_PASSWORD') return err.message;
    if (err.status >= 500) return t('common.genericError');
  }
  return t('settings.password.changeFailed');
}

/** One labelled read-only row in the identity card. */
function IdentityField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="bt-label">{label}</span>
      <span className="bt-num">{value}</span>
    </div>
  );
}

function ChangePasswordForm() {
  const t = useT();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: (body: ChangePasswordRequest) => changePassword(body),
    onSuccess: () => {
      // Success rotates the session server-side; refetch the identity so the
      // page (and anything else keyed on `getMe`) stays in step.
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setDone(true);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (newPassword !== confirmPassword) {
      setError(t('settings.password.mismatch'));
      return;
    }
    mutation.mutate(
      { currentPassword, newPassword },
      { onError: (err) => setError(changeErrorMessage(t, err)) },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h3 className="bt-h3">{t('settings.password.title')}</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {done ? <Alert tone="success">{t('settings.password.success')}</Alert> : null}
      <Field className="max-w-sm" htmlFor="currentPassword" label={t('settings.password.current')}>
        <Input
          autoComplete="current-password"
          id="currentPassword"
          name="currentPassword"
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          type="password"
          value={currentPassword}
        />
      </Field>
      <Field
        className="max-w-sm"
        hint={t('settings.password.hint', { count: MIN_PASSWORD_LENGTH })}
        htmlFor="newPassword"
        label={t('settings.password.new')}
      >
        <Input
          autoComplete="new-password"
          id="newPassword"
          minLength={MIN_PASSWORD_LENGTH}
          name="newPassword"
          onChange={(e) => setNewPassword(e.target.value)}
          required
          type="password"
          value={newPassword}
        />
      </Field>
      <Field className="max-w-sm" htmlFor="confirmPassword" label={t('settings.password.confirm')}>
        <Input
          autoComplete="new-password"
          id="confirmPassword"
          minLength={MIN_PASSWORD_LENGTH}
          name="confirmPassword"
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          type="password"
          value={confirmPassword}
        />
      </Field>
      <div>
        {/* The page's single primary action; every other block stays quiet. */}
        <Button disabled={mutation.isPending} type="submit" variant="primary">
          {mutation.isPending ? t('settings.password.submitting') : t('settings.password.submit')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Display-language picker (§13.3 V3-P1). Switches the app runtime instantly and
 * persists the choice per-user (`PATCH /settings/account`), so it survives
 * logout/login. Options show each language in its own name (endonyms).
 */
function LanguageControl() {
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="bt-h3">{t('language.title')}</h3>
        <p className="bt-meta">{t('language.description')}</p>
      </div>
      <Select
        aria-label={t('language.label')}
        disabled={mutation.isPending}
        onChange={(e) => {
          const code = e.target.value;
          setLocale(code);
          mutation.mutate(code);
        }}
        style={{ width: 'auto', maxWidth: 260 }}
        value={locale}
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </Select>
      {error ? <Alert tone="error">{t('language.saveError')}</Alert> : null}
    </div>
  );
}

/**
 * Base-currency picker (§5.4, §13.3 V3-P10d): the currency every valuation,
 * chart and report renders in, persisted per user (`PATCH /settings/account`).
 * Conversion is display-time only — stored amounts stay in each asset's native
 * currency. On change the formatter default flips immediately and every cached
 * query is refetched, since all converted figures change denomination.
 */
function BaseCurrencyControl() {
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="bt-h3">{t('settings.baseCurrency.title')}</h3>
        <p className="bt-meta">{t('settings.baseCurrency.description')}</p>
      </div>
      {query.isPending ? (
        <Skeleton height="h-10" width="w-40" />
      ) : (
        <Select
          aria-label={t('settings.baseCurrency.label')}
          disabled={mutation.isPending}
          onChange={(e) => mutation.mutate(e.target.value as BaseCurrency)}
          style={{ width: 'auto', maxWidth: 260 }}
          value={query.data?.baseCurrency ?? 'EUR'}
        >
          {BASE_CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {t(`settings.baseCurrency.option.${code}`)}
            </option>
          ))}
        </Select>
      )}
      {error ? <Alert tone="error">{t('settings.baseCurrency.saveError')}</Alert> : null}
    </div>
  );
}

/**
 * Portfolio visibility moved out of Settings (#377). ALL sharing/audience
 * management now lives in the Social area — "My items" lists EVERY shareable item
 * the user owns (portfolios, conglomerates, watchlists), each with its own
 * AudiencePicker, so a secondary portfolio is as shareable as the default and new
 * portfolios stay private until explicitly shared (#384). This is a signpost, not
 * a control (the legacy private↔friends toggle and the create-time default toggle
 * are retired; the audience model is the one source of truth, and existing shares
 * are untouched).
 */
function SharingMovedNote() {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="bt-h3">{t('settings.sharingMoved.title')}</h3>
        <p className="bt-meta">{t('settings.sharingMoved.description')}</p>
      </div>
      <Link className="bt-link w-fit" to="/people/shared">
        {t('settings.sharingMoved.link')}
      </Link>
    </div>
  );
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

/**
 * Account data export (§13.4 V4-P6a, #494): "Export my data" → re-auth →
 * async zip build → expiring, token-gated download. The raw download token is
 * held only in component memory since the server stores only its hash; the
 * status poll drives the pending/ready/expired states.
 */
function ExportDataSection() {
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
    // Poll while a build is in flight; idle otherwise.
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  });

  const mutation = useMutation({
    mutationFn: () => requestDataExport({ password }),
    onSuccess: (res) => {
      const next = { jobId: res.jobId, token: res.downloadToken };
      setHeld(next);
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
  const isPending = current?.status === 'pending';

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
  // in-memory credential at that instant and refresh the status so a page left
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="bt-h3">{t('settings.export.title')}</h3>
        <p className="bt-meta">{t('settings.export.description')}</p>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {isReady && tokenForJob ? (
        <div className="flex flex-col gap-2">
          <Alert tone="success">
            {current?.expiresAt
              ? t('settings.export.readyUntil', { date: formatDate(current.expiresAt) })
              : t('settings.export.ready')}
          </Alert>
          <Button
            disabled={downloadMutation.isPending}
            onClick={() => {
              setError(null);
              downloadMutation.mutate();
            }}
            type="button"
          >
            {t('settings.export.download')}
          </Button>
        </div>
      ) : isReady && !tokenForJob ? (
        <Alert tone="info">{t('settings.export.readyNoToken')}</Alert>
      ) : isPending ? (
        <Alert tone="info">{t('settings.export.pending')}</Alert>
      ) : current?.status === 'expired' ? (
        <Alert tone="info">{t('settings.export.expired')}</Alert>
      ) : null}

      {!isPending ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field
            className="max-w-sm"
            hint={t('settings.export.passwordHint')}
            htmlFor="exportPassword"
            label={t('settings.export.password')}
          >
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
          <div>
            <Button disabled={mutation.isPending} type="submit">
              {mutation.isPending
                ? t('settings.export.submitting')
                : isReady || current?.status === 'expired' || current?.status === 'failed'
                  ? t('settings.export.requestAgain')
                  : t('settings.export.request')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/**
 * Client-side cleartext export for paranoid accounts (PD7, paranoid design
 * §12): a JSON + CSV zip built entirely in browser memory from the unlocked
 * vault — the server never sees cleartext portfolio data, and nothing is
 * persisted beyond the transient download. Locked vaults cannot export.
 */
function CleartextExportSection() {
  const t = useT();
  const { locale } = useI18n();
  const session = useVaultMoneySession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultMoneyFailure | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Locking drops `session` while this section stays mounted, and leaving the
  // page unmounts it — both must abort an in-flight generation before any
  // bytes are handed over, so the cleanup is keyed on the session identity.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [session],
  );

  const exportLocale = locale === 'de' ? 'de' : 'en';

  async function onExport() {
    if (session === null || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setFailure(null);
    try {
      const result = await createClientCleartextExport(session.sync, {
        locale: exportLocale,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setFailure(result.error);
        return;
      }
      deliverClientDownload(result.value.bytes, result.value.mediaType, result.value.filename);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="bt-h3">{t('settings.export.cleartext.title')}</h3>
        <p className="bt-meta">{t('settings.export.cleartext.description')}</p>
      </div>

      {failure ? <Alert tone="error">{t(vaultMoneyErrorKey(failure))}</Alert> : null}

      {session === null ? (
        <Alert tone="info">{t('settings.export.cleartext.locked')}</Alert>
      ) : (
        <div>
          <Button type="button" onClick={() => void onExport()} disabled={busy}>
            {busy
              ? t('settings.export.cleartext.generating')
              : t('settings.export.cleartext.button')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Paranoid-only: normal accounts keep exactly the single server export block. */
function CleartextExportGate() {
  const privacy = usePrivacyMode();
  if (privacy.privacyMode !== 'paranoid') return null;
  return (
    <section className="bt-band__row">
      <CleartextExportSection />
    </section>
  );
}

/**
 * Settings → Account (PROJECTPLAN.md §6.11, §13.3 V3-P1). Shows the identity read
 * from `GET /auth/me` (username, email, member-since), a change-password form, the
 * display-language and base-currency pickers, and a signpost to the Socials tab
 * where ALL portfolio sharing now lives (#377). All shapes derive from
 * `@bettertrack/contracts`; all copy from the i18n layer.
 */
export function AccountSettingsPage() {
  const t = useT();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: 30_000,
  });

  return (
    <div className="flex flex-col gap-7">
      <SectionHead sub={t('settings.account.subtitle')} title={t('settings.account.title')} />

      {/* Identity reads as a stat strip, not a card: values first, labels quiet. */}
      <section>
        {me.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton height="h-6" />
            <Skeleton height="h-6" />
          </div>
        ) : me.isError ? (
          <EmptyState
            title={t('settings.account.loadError.title')}
            description={t('settings.account.loadError.description')}
          />
        ) : (
          <div
            className="bt-t-rule bt-b-rule grid grid-cols-1 gap-5 sm:grid-cols-3"
            style={{ padding: '15px 0' }}
          >
            <IdentityField label={t('settings.account.field.username')} value={me.data.username} />
            <IdentityField label={t('settings.account.field.email')} value={me.data.email} />
            <IdentityField
              label={t('settings.account.field.memberSince')}
              value={formatDate(me.data.createdAt)}
            />
          </div>
        )}
      </section>

      {/* One ruled band of settings blocks — no card-in-card, one hairline each. */}
      <div className="bt-panel bt-band">
        <section className="bt-band__row">
          <LanguageControl />
        </section>

        <section className="bt-band__row">
          <BaseCurrencyControl />
        </section>

        <section className="bt-band__row">
          <ChangePasswordForm />
        </section>

        <section className="bt-band__row">
          <SharingMovedNote />
        </section>

        <section className="bt-band__row">
          <ExportDataSection />
        </section>

        <CleartextExportGate />
      </div>

      <section
        className="bt-panel"
        style={{ borderColor: 'rgba(251, 113, 133, 0.28)', padding: '16px 20px' }}
      >
        <DangerZone />
      </section>
    </div>
  );
}

/**
 * Danger zone (§13.4 V4-P2c, #362): the in-app entry to the standalone
 * `/account/delete` flow — the same stable URL the Google Play listing points
 * at. This is only a signpost; every gate (typed confirmation + re-auth) lives
 * on the deletion page and server-side.
 */
function DangerZone() {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="bt-h3 bt-neg">{t('settings.dangerZone.title')}</h3>
        <p className="bt-meta">{t('settings.dangerZone.description')}</p>
      </div>
      <Link className="bt-btn bt-btn--danger bt-btn--sm w-fit" to="/account/delete">
        {t('settings.dangerZone.link')}
      </Link>
    </div>
  );
}
