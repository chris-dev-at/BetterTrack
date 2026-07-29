import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { BASE_CURRENCIES, type BaseCurrency } from '@bettertrack/contracts';

import { SUPPORTED_LOCALES, useI18n, useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { formatDate, setMoneyCurrency } from '../../../lib/format';
import { getAccountSettings, updateAccountSettings } from '../../../lib/settingsApi';
import {
  dataExportDownloadUrl,
  getDataExportStatus,
  getMe,
  requestDataExport,
} from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Button, Field, Input, Select } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { PanelForm, PanelGroup, PanelHead, PanelNote, Row } from './panelKit';

const ME_KEY = ['auth', 'me'] as const;
const ACCOUNT_SETTINGS_KEY = ['settings', 'account'] as const;
const EXPORT_STATUS_KEY = ['settings', 'export'] as const;

// The raw download token is delivered once (in the request response) and only
// its hash is stored server-side, so the SPA keeps it in localStorage — keyed by
// job id — to survive a reload until the export is downloaded or expires.
const EXPORT_TOKEN_STORAGE_KEY = 'bt.export.token';

function readStoredExportToken(): { jobId: string; token: string } | null {
  try {
    const raw = localStorage.getItem(EXPORT_TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { jobId?: unknown; token?: unknown };
    if (typeof parsed.jobId === 'string' && typeof parsed.token === 'string') {
      return { jobId: parsed.jobId, token: parsed.token };
    }
  } catch {
    // Corrupt/blocked storage — treat as no stored token.
  }
  return null;
}

function writeStoredExportToken(value: { jobId: string; token: string } | null): void {
  try {
    if (value) localStorage.setItem(EXPORT_TOKEN_STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(EXPORT_TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable — the token simply won't persist across reloads.
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
      {query.isPending ? (
        <Skeleton height="h-7" width="w-32" />
      ) : (
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
      )}
      {error ? (
        <span className="bt-field__error">{t('settings.baseCurrency.saveError')}</span>
      ) : null}
    </Row>
  );
}

/**
 * Account data export (§13.4 V4-P6a, #494): re-auth → async zip build →
 * expiring, token-gated download. The raw download token is kept in
 * localStorage (see helpers above) since the server stores only its hash; the
 * status poll drives the pending/ready/expired states.
 */
function ExportRow() {
  const t = useT();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stored, setStored] = useState(() => readStoredExportToken());

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
      writeStoredExportToken(next);
      setStored(next);
      setPassword('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: EXPORT_STATUS_KEY });
    },
    onError: (err) => setError(exportErrorMessage(t, err)),
  });

  const current = status.data;
  // The stored token only unlocks the CURRENT ready job (job ids must match).
  const tokenForJob = current?.jobId && stored?.jobId === current.jobId ? stored.token : null;
  const isReady = current?.status === 'ready';
  const isPending = current?.status === 'pending';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <Row hint={t('settings.export.hint')} label={t('settings.export.title')} stack>
      {error ? <Alert tone="error">{error}</Alert> : null}

      {isReady && tokenForJob ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="bt-pos" style={{ fontSize: 12 }}>
            {current?.expiresAt
              ? t('settings.export.readyUntil', { date: formatDate(current.expiresAt) })
              : t('settings.export.ready')}
          </span>
          <a className="bt-btn bt-btn--sm" href={dataExportDownloadUrl(tokenForJob)}>
            {t('settings.export.download')}
          </a>
        </div>
      ) : isReady && !tokenForJob ? (
        <PanelNote>{t('settings.export.readyNoToken')}</PanelNote>
      ) : isPending ? (
        <PanelNote>{t('settings.export.pending')}</PanelNote>
      ) : current?.status === 'expired' ? (
        <PanelNote>{t('settings.export.expired')}</PanelNote>
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
              : isReady || current?.status === 'expired' || current?.status === 'failed'
                ? t('settings.export.requestAgain')
                : t('settings.export.request')}
          </Button>
        </PanelForm>
      ) : null}
    </Row>
  );
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
      </PanelGroup>

      <PanelGroup label={t('settings.account.display')}>
        <LanguageRow />
        <BaseCurrencyRow />
      </PanelGroup>

      <PanelGroup label={t('settings.account.yourData')}>
        <ExportRow />
      </PanelGroup>
    </div>
  );
}
