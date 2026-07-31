import { useState } from 'react';
import type { FormEvent } from 'react';

import {
  withImpliedReadScopes,
  type ApiKeyScope,
  type CreateOAuthClientResponse,
  type OAuthClientSummary,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { ScopePicker } from '../../ui';
import { formatDateTime } from '../../lib/format';
import { useResource } from '../useResource';
import { Modal } from '../components/Modal';
import {
  Alert,
  Badge,
  Button,
  CopyField,
  EmptyState,
  PageHeader,
  Spinner,
  TextField,
} from '../components/ui';

function errorMessage(err: unknown, t: TranslateFn): string {
  return err instanceof ApiError ? err.message : t('common.genericError');
}

/**
 * Admin → OAuth apps: register and manage the official FIRST-PARTY apps (the
 * BetterTrack mobile/web clients). These belong to the system, not a user, and
 * are trusted — their "Login with BetterTrack" consent screen is BetterTrack-
 * branded and auto-approved. Third-party apps are still self-registered by users
 * under their own Settings → API Access; this page is only for our own apps.
 */
export function OAuthAppsPage() {
  const t = useT();
  const [name, setName] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(['portfolio:read']));
  const [isPublic, setIsPublic] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreateOAuthClientResponse | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<OAuthClientSummary | null>(null);
  const [deleting, setDeleting] = useState<OAuthClientSummary | null>(null);

  const apps = useResource((signal) => api.listFirstPartyApps(signal), []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (scopes.size === 0) {
      setFormError(t('admin.oauthApps.scopeRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.createFirstPartyApp({
        name: name.trim(),
        redirectUris: [redirectUri.trim()],
        scopes: withImpliedReadScopes([...scopes]),
        public: isPublic,
      });
      setName('');
      setRedirectUri('');
      setScopes(new Set(['portfolio:read']));
      setIsPublic(true);
      setCreated(result);
      apps.reload();
    } catch (err) {
      setFormError(errorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(app: OAuthClientSummary) {
    if (busyId !== null) return;
    setRowError(null);
    setBusyId(app.id);
    try {
      await api.deleteFirstPartyApp(app.id);
      apps.reload();
      setDeleting(null);
    } catch (err) {
      setRowError(errorMessage(err, t));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.oauthApps.title')} description={t('admin.oauthApps.subtitle')} />

      <form
        onSubmit={onCreate}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('admin.oauthApps.appNameLabel')}
            name="oauth-name"
            placeholder={t('admin.oauthApps.appNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <TextField
            label={t('admin.oauthApps.redirectLabel')}
            name="oauth-redirect"
            placeholder={t('admin.oauthApps.redirectPlaceholder')}
            hint={t('admin.oauthApps.redirectHint')}
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            required
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-300">
            {t('admin.oauthApps.scopes')}
          </legend>
          <ScopePicker scopes={scopes} onChange={setScopes} collapsible />
        </fieldset>

        <label className="flex items-start gap-2 text-sm text-neutral-200">
          <input
            type="checkbox"
            className="mt-1"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span>
            <span className="font-medium">{t('admin.oauthApps.publicClient')}</span>
            <br />
            <span className="text-neutral-400">{t('admin.oauthApps.publicClientHint')}</span>
          </span>
        </label>

        <div>
          <Button type="submit" disabled={submitting}>
            {submitting ? t('admin.oauthApps.registering') : t('admin.oauthApps.register')}
          </Button>
        </div>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
      </form>

      {rowError ? <Alert tone="error">{rowError}</Alert> : null}

      {apps.loading ? (
        <Spinner label={t('admin.oauthApps.loading')} />
      ) : apps.error ? (
        <Alert tone="error">
          {apps.error}{' '}
          <button className="underline" onClick={apps.reload}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : !apps.data || apps.data.clients.length === 0 ? (
        <EmptyState>{t('admin.oauthApps.empty')}</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {apps.data.clients.map((app) => (
            <div
              key={app.id}
              className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-neutral-100">{app.name}</span>
                    <Badge tone="green">{t('admin.oauthApps.firstParty')}</Badge>
                    <Badge tone={app.public ? 'neutral' : 'amber'}>
                      {app.public
                        ? t('admin.oauthApps.publicPkce')
                        : t('admin.oauthApps.confidential')}
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-xs text-neutral-400">{app.clientId}</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="secondary"
                    disabled={busyId === app.id}
                    onClick={() => {
                      setRowError(null);
                      setEditing(app);
                    }}
                  >
                    {t('admin.oauthApps.edit')}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busyId === app.id}
                    onClick={() => {
                      setRowError(null);
                      setDeleting(app);
                    }}
                  >
                    {t('admin.actions.delete')}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {app.scopes.map((scope) => (
                  <span
                    key={scope}
                    className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-300"
                  >
                    {scope}
                  </span>
                ))}
              </div>
              <div className="text-xs text-neutral-400">
                {t('admin.oauthApps.redirectCreated', {
                  redirects: app.redirectUris.join(', '),
                  date: formatDateTime(app.createdAt),
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {created ? <CreatedOAuthAppDialog result={created} onClose={() => setCreated(null)} /> : null}

      {editing ? (
        <EditOAuthAppModal
          app={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            apps.reload();
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteOAuthAppDialog
          app={deleting}
          busy={busyId === deleting.id}
          error={rowError}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      ) : null}
    </div>
  );
}

function CreatedOAuthAppDialog({
  result,
  onClose,
}: {
  result: CreateOAuthClientResponse;
  onClose: () => void;
}) {
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(result.clientSecret == null);

  return (
    <Modal
      title={t('admin.oneTimeCredentials.oauthClient.title')}
      onClose={onClose}
      dismissable={acknowledged}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          {result.clientSecret
            ? t('admin.oneTimeCredentials.oauthClient.secretDescription', {
                name: result.client.name,
              })
            : t('admin.oneTimeCredentials.oauthClient.publicDescription', {
                name: result.client.name,
              })}
        </p>
        <CopyField
          label={t('admin.oneTimeCredentials.oauthClient.clientIdLabel')}
          value={result.client.clientId}
        />
        {result.clientSecret ? (
          <CopyField
            label={t('admin.oneTimeCredentials.oauthClient.clientSecretLabel')}
            value={result.clientSecret}
            onCopied={() => setAcknowledged(true)}
          />
        ) : null}
        <Button
          onClick={() => {
            setAcknowledged(true);
            onClose();
          }}
        >
          {result.clientSecret ? t('common.savedOneTimeSecret') : t('common.done')}
        </Button>
      </div>
    </Modal>
  );
}

function DeleteOAuthAppDialog({
  app,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  app: OAuthClientSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();

  return (
    <Modal
      title={t('admin.confirmations.deleteOAuthApp.title')}
      onClose={onCancel}
      dismissable={!busy}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          {t('admin.confirmations.deleteOAuthApp.description', { name: app.name })}
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy
              ? t('admin.confirmations.deleteOAuthApp.pending')
              : t('admin.confirmations.deleteOAuthApp.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Edit an existing first-party app. The client_id and public/confidential nature
 * are immutable (issued tokens reference the client_id; flipping the client type
 * would force a secret rotation), so only the name, redirect URIs and allowed
 * scopes are editable — with the same validation as registration.
 *
 * Consent-safety note surfaced to the admin: ADDING a scope here does not grant
 * it to anyone already signed in — the API clamps every live token to the app's
 * allowed scopes and users receive a newly-added scope only after re-consenting.
 * REMOVING a scope (or a redirect URI) takes effect immediately.
 */
function EditOAuthAppModal({
  app,
  onClose,
  onSaved,
}: {
  app: OAuthClientSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(app.name);
  const [redirectText, setRedirectText] = useState(app.redirectUris.join('\n'));
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(app.scopes));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const redirectUris = redirectText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (redirectUris.length === 0) {
      setError(t('admin.oauthApps.redirectRequired'));
      return;
    }
    if (scopes.size === 0) {
      setError(t('admin.oauthApps.scopeRequired'));
      return;
    }
    setSaving(true);
    try {
      await api.updateFirstPartyApp(app.id, {
        name: name.trim(),
        redirectUris,
        scopes: withImpliedReadScopes([...scopes]),
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={t('admin.oauthApps.editTitle', { name: app.name })} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
          <div className="text-xs text-neutral-400">{t('admin.oauthApps.clientIdImmutable')}</div>
          <div className="font-mono text-xs text-neutral-300">{app.clientId}</div>
        </div>

        <TextField
          label={t('admin.oauthApps.appNameLabel')}
          name="edit-oauth-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-300">{t('admin.oauthApps.redirectUris')}</span>
          <span className="text-xs text-neutral-400">{t('admin.oauthApps.redirectUrisHint')}</span>
          <textarea
            name="edit-oauth-redirects"
            rows={3}
            value={redirectText}
            onChange={(e) => setRedirectText(e.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-300">
            {t('admin.oauthApps.scopes')}
          </legend>
          <p className="text-xs text-neutral-400">{t('admin.oauthApps.scopeChangeHint')}</p>
          <ScopePicker scopes={scopes} onChange={setScopes} collapsible />
        </fieldset>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? t('common.saving') : t('admin.oauthApps.saveChanges')}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
