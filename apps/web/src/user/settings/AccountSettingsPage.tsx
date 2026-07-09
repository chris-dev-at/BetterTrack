import { useState } from 'react';
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
import { changePassword, getMe } from '../../lib/userApi';
import type { TranslateFn } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, TextField } from '../components/ui';

const ME_KEY = ['auth', 'me'] as const;
const ACCOUNT_SETTINGS_KEY = ['settings', 'account'] as const;

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
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</span>
      <span className="text-sm text-neutral-100">{value}</span>
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
      <h3 className="text-sm font-semibold text-neutral-100">{t('settings.password.title')}</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {done ? <Alert tone="success">{t('settings.password.success')}</Alert> : null}
      <TextField
        label={t('settings.password.current')}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        required
      />
      <TextField
        label={t('settings.password.new')}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        minLength={MIN_PASSWORD_LENGTH}
        required
        hint={t('settings.password.hint', { count: MIN_PASSWORD_LENGTH })}
      />
      <TextField
        label={t('settings.password.confirm')}
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        minLength={MIN_PASSWORD_LENGTH}
        required
      />
      <div>
        <Button type="submit" disabled={mutation.isPending}>
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
        <h3 className="text-sm font-semibold text-neutral-100">{t('language.title')}</h3>
        <p className="text-xs text-neutral-500">{t('language.description')}</p>
      </div>
      <select
        aria-label={t('language.label')}
        value={locale}
        disabled={mutation.isPending}
        onChange={(e) => {
          const code = e.target.value;
          setLocale(code);
          mutation.mutate(code);
        }}
        className="w-fit rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed"
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
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
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.baseCurrency.title')}
        </h3>
        <p className="text-xs text-neutral-500">{t('settings.baseCurrency.description')}</p>
      </div>
      {query.isPending ? (
        <Skeleton height="h-10" width="w-40" />
      ) : (
        <select
          aria-label={t('settings.baseCurrency.label')}
          value={query.data?.baseCurrency ?? 'EUR'}
          disabled={mutation.isPending}
          onChange={(e) => mutation.mutate(e.target.value as BaseCurrency)}
          className="w-fit rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed"
        >
          {BASE_CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {t(`settings.baseCurrency.option.${code}`)}
            </option>
          ))}
        </select>
      )}
      {error ? <Alert tone="error">{t('settings.baseCurrency.saveError')}</Alert> : null}
    </div>
  );
}

/**
 * Portfolio visibility moved out of Settings (#377). ALL sharing/audience
 * management now lives in the Socials tab — My Shared Items lists EVERY portfolio
 * the user owns, each with its own AudiencePicker, so a secondary portfolio is as
 * shareable as the default and new portfolios stay private until explicitly
 * shared. This is a signpost, not a control (the legacy private↔friends toggle
 * and the create-time default toggle are retired; the audience model is the one
 * source of truth, and existing shares are untouched).
 */
function SharingMovedNote() {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.sharingMoved.title')}
        </h3>
        <p className="text-xs text-neutral-500">{t('settings.sharingMoved.description')}</p>
      </div>
      <Link
        to="/social/my-shared"
        className="w-fit text-sm font-medium text-sky-400 hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {t('settings.sharingMoved.link')}
      </Link>
    </div>
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
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">{t('settings.account.title')}</h2>
        <p className="text-sm text-neutral-500">{t('settings.account.subtitle')}</p>
      </div>

      <section className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-900 p-5">
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('settings.account.field.username')} value={me.data.username} />
            <Field label={t('settings.account.field.email')} value={me.data.email} />
            <Field
              label={t('settings.account.field.memberSince')}
              value={formatDate(me.data.createdAt)}
            />
          </div>
        )}
      </section>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <LanguageControl />
      </section>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <BaseCurrencyControl />
      </section>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <ChangePasswordForm />
      </section>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <SharingMovedNote />
      </section>
    </div>
  );
}
