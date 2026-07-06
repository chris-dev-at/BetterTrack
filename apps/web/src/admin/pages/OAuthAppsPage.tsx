import { useState } from 'react';
import type { FormEvent } from 'react';

import {
  API_KEY_SCOPES,
  OAUTH_SCOPE_LABELS,
  type ApiKeyScope,
  type CreateOAuthClientResponse,
  type OAuthClientSummary,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../format';
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

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

/**
 * Admin → OAuth apps: register and manage the official FIRST-PARTY apps (the
 * BetterTrack mobile/web clients). These belong to the system, not a user, and
 * are trusted — their "Login with BetterTrack" consent screen is BetterTrack-
 * branded and auto-approved. Third-party apps are still self-registered by users
 * under their own Settings → API Access; this page is only for our own apps.
 */
export function OAuthAppsPage() {
  const [name, setName] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(['portfolio:read']));
  const [isPublic, setIsPublic] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreateOAuthClientResponse | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const apps = useResource((signal) => api.listFirstPartyApps(signal), []);

  function toggleScope(scope: ApiKeyScope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (scopes.size === 0) {
      setFormError('Select at least one scope.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.createFirstPartyApp({
        name: name.trim(),
        redirectUris: [redirectUri.trim()],
        scopes: [...scopes],
        public: isPublic,
      });
      setName('');
      setRedirectUri('');
      setScopes(new Set(['portfolio:read']));
      setIsPublic(true);
      setCreated(result);
      apps.reload();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(app: OAuthClientSummary) {
    setRowError(null);
    setBusyId(app.id);
    try {
      await api.deleteFirstPartyApp(app.id);
      apps.reload();
    } catch (err) {
      setRowError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="OAuth apps"
        description="Register the official first-party BetterTrack apps. They're trusted — users see BetterTrack branding and skip the consent screen when signing in."
      />

      <form
        onSubmit={onCreate}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="App name"
            name="oauth-name"
            placeholder="BetterTrack Mobile"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <TextField
            label="Redirect URI"
            name="oauth-redirect"
            placeholder="https://app.bettertrack.io/callback"
            hint="Where users return after login. https, http-loopback, or a custom scheme."
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            required
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-300">Scopes</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {API_KEY_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={scopes.has(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span>
                  <span className="font-mono text-xs text-neutral-400">{scope}</span>
                  <br />
                  {OAUTH_SCOPE_LABELS[scope]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex items-start gap-2 text-sm text-neutral-200">
          <input
            type="checkbox"
            className="mt-1"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span>
            <span className="font-medium">Public client (PKCE)</span>
            <br />
            <span className="text-neutral-500">
              Mobile / SPA apps that can&apos;t keep a secret. Uncheck for a backend that can hold a
              client secret.
            </span>
          </span>
        </label>

        <div>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Registering…' : 'Register app'}
          </Button>
        </div>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
      </form>

      {rowError ? <Alert tone="error">{rowError}</Alert> : null}

      {apps.loading ? (
        <Spinner label="Loading apps…" />
      ) : apps.error ? (
        <Alert tone="error">
          {apps.error}{' '}
          <button className="underline" onClick={apps.reload}>
            Retry
          </button>
        </Alert>
      ) : !apps.data || apps.data.clients.length === 0 ? (
        <EmptyState>No first-party apps yet. Register one above.</EmptyState>
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
                    <Badge tone="green">first-party</Badge>
                    <Badge tone={app.public ? 'neutral' : 'amber'}>
                      {app.public ? 'public / PKCE' : 'confidential'}
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-xs text-neutral-500">{app.clientId}</div>
                </div>
                <Button
                  variant="danger"
                  disabled={busyId === app.id}
                  onClick={() => void remove(app)}
                >
                  Delete
                </Button>
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
              <div className="text-xs text-neutral-500">
                Redirect: {app.redirectUris.join(', ')} · Created {formatDateTime(app.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}

      {created ? (
        <Modal title="App registered" onClose={() => setCreated(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-400">
              <span className="text-neutral-200">{created.client.name}</span> is ready. Put the
              client ID in the app&apos;s OAuth config.
              {created.clientSecret
                ? ' The client secret is shown only once — copy it now.'
                : ' This is a public client, so there is no secret (it uses PKCE).'}
            </p>
            <CopyField label="Client ID" value={created.client.clientId} />
            {created.clientSecret ? (
              <CopyField label="Client secret (shown once)" value={created.clientSecret} />
            ) : null}
            <Button onClick={() => setCreated(null)}>Done</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
