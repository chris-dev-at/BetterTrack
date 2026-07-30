import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { BASE_CURRENCIES, type BaseCurrency } from '@bettertrack/contracts';

import { SUPPORTED_LOCALES, useI18n, useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { formatDate, setMoneyCurrency } from '../../../lib/format';
import { getAccountSettings, updateAccountSettings } from '../../../lib/settingsApi';
import {
  downloadDataExport,
  getDataExportStatus,
  getMe,
  requestDataExport,
} from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Button, Field, Input, Select } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { vaultMoneyErrorKey } from '../../vault/engine/errorCopy';
import type { VaultMoneyFailure } from '../../vault/engine/errors';
import { useVaultMoneySession } from '../../vault/engine/VaultMoneyEngineProvider';
import { createClientCleartextExport } from '../../vault/export/cleartext';
import { deliverClientDownload } from '../../vault/export/deliver';
import { usePrivacyMode } from '../../vault/usePrivacyMode';
import { PanelForm, PanelGroup, PanelHead, PanelNote, Row } from './panelKit';

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
    // Poll while a build is in flight; idle otherwise.
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
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
 * Client-side cleartext export for paranoid accounts (PD7, paranoid design
 * §12): a JSON + CSV zip built entirely in browser memory from the unlocked
 * vault — the server never sees cleartext portfolio data, and nothing is
 * persisted beyond the transient download. Locked vaults cannot export.
 */
function CleartextExportRow() {
  const t = useT();
  const { locale } = useI18n();
  const session = useVaultMoneySession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultMoneyFailure | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Locking drops `session` while this row stays mounted, and leaving the panel
  // unmounts it — both must abort an in-flight generation before any bytes are
  // handed over, so the cleanup is keyed on the session identity.
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
    <Row
      hint={t('settings.export.cleartext.description')}
      label={t('settings.export.cleartext.title')}
      stack
    >
      {failure ? <Alert tone="error">{t(vaultMoneyErrorKey(failure))}</Alert> : null}

      {session === null ? (
        <PanelNote>{t('settings.export.cleartext.locked')}</PanelNote>
      ) : (
        <div>
          <Button disabled={busy} onClick={() => void onExport()} size="sm" type="button">
            {busy
              ? t('settings.export.cleartext.generating')
              : t('settings.export.cleartext.button')}
          </Button>
        </div>
      )}
    </Row>
  );
}

/** Paranoid-only: normal accounts keep exactly the single server export row. */
function CleartextExportGate() {
  const privacy = usePrivacyMode();
  if (privacy.privacyMode !== 'paranoid') return null;
  return <CleartextExportRow />;
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
        <CleartextExportGate />
      </PanelGroup>
    </div>
  );
}
