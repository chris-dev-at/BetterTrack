import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  API_KEY_SCOPES,
  OAUTH_SCOPE_LABELS,
  impliedReadScope,
  withImpliedReadScopes,
  writeScopeForRead,
  type ApiKeyScope,
  type ApiKeySummary,
  type CreateApiKeyResponse,
  type CreateOAuthClientRequest,
  type CreateOAuthClientResponse,
  type OAuthClientSummary,
  type OAuthGrantSummary,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { createApiKey, listApiKeys, revokeApiKey } from '../../lib/apiKeysApi';
import {
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  listOAuthGrants,
  revokeOAuthGrant,
} from '../../lib/oauthApi';
import { formatDate } from '../../lib/format';
import { EmptyState, Skeleton } from '../../ui';
import { Dialog } from '../components/Dialog';
import { Alert, Button, TextField, cx } from '../components/ui';

const API_KEYS_KEY = ['settings', 'api-keys'] as const;
const OAUTH_CLIENTS_KEY = ['settings', 'oauth-clients'] as const;
const OAUTH_GRANTS_KEY = ['settings', 'oauth-grants'] as const;

/** Human labels for each grantable scope (§6.13). */
function scopeMeta(t: TranslateFn): Record<ApiKeyScope, { label: string; description: string }> {
  return {
    'portfolio:read': {
      label: t('settings.api.scope.portfolioRead.label'),
      description: t('settings.api.scope.portfolioRead.description'),
    },
    'portfolio:write': {
      label: t('settings.api.scope.portfolioWrite.label'),
      description: t('settings.api.scope.portfolioWrite.description'),
    },
    'workboard:read': {
      label: t('settings.api.scope.workboardRead.label'),
      description: t('settings.api.scope.workboardRead.description'),
    },
    'workboard:write': {
      label: t('settings.api.scope.workboardWrite.label'),
      description: t('settings.api.scope.workboardWrite.description'),
    },
    'market:read': {
      label: t('settings.api.scope.marketRead.label'),
      description: t('settings.api.scope.marketRead.description'),
    },
    'social:read': {
      label: t('settings.api.scope.socialRead.label'),
      description: t('settings.api.scope.socialRead.description'),
    },
    'social:write': {
      label: t('settings.api.scope.socialWrite.label'),
      description: t('settings.api.scope.socialWrite.description'),
    },
    'notifications:read': {
      label: t('settings.api.scope.notificationsRead.label'),
      description: t('settings.api.scope.notificationsRead.description'),
    },
    'notifications:write': {
      label: t('settings.api.scope.notificationsWrite.label'),
      description: t('settings.api.scope.notificationsWrite.description'),
    },
    'chat:read': {
      label: t('settings.api.scope.chatRead.label'),
      description: t('settings.api.scope.chatRead.description'),
    },
    'chat:write': {
      label: t('settings.api.scope.chatWrite.label'),
      description: t('settings.api.scope.chatWrite.description'),
    },
    'account:security': {
      label: t('settings.api.scope.accountSecurity.label'),
      description: t('settings.api.scope.accountSecurity.description'),
    },
  };
}

/** The one-time token modal — the plaintext is available here and never again. */
function TokenModal({ result, onClose }: { result: CreateApiKeyResponse; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      title={t('settings.api.keys.tokenModal.title')}
      description={t('settings.api.keys.tokenModal.description')}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-emerald-300 ring-1 ring-inset ring-neutral-700">
            {result.token}
          </code>
          <Button variant="secondary" onClick={copy}>
            {copied ? t('settings.api.copied') : t('settings.api.copy')}
          </Button>
        </div>
        <Alert tone="info">
          {t('settings.api.keys.tokenModal.storeWarning', { name: result.key.name })}
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>{t('settings.api.done')}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Create-key form: a name plus at least one scope. */
function CreateApiKeyForm({ onCreated }: { onCreated: (result: CreateApiKeyResponse) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const meta = scopeMeta(t);

  const mutation = useMutation({
    mutationFn: (input: { name: string; scopes: ApiKeyScope[] }) => createApiKey(input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: API_KEYS_KEY });
      setName('');
      setScopes(new Set());
      setError(null);
      onCreated(result);
    },
    onError: () => setError(t('settings.api.keys.createError')),
  });

  function toggle(scope: ApiKeyScope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        // A read implied by a still-selected write is locked on — leave it.
        const write = writeScopeForRead(scope);
        if (write && next.has(write)) return prev;
        next.delete(scope);
      } else {
        next.add(scope);
        // Write-implies-read (#371): selecting a write auto-selects its read.
        const read = impliedReadScope(scope);
        if (read) next.add(read);
      }
      return next;
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length === 0) {
      setError(t('settings.api.keys.nameRequired'));
      return;
    }
    if (scopes.size === 0) {
      setError(t('settings.api.scopeRequired'));
      return;
    }
    mutation.mutate({ name: name.trim(), scopes: withImpliedReadScopes([...scopes]) });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-neutral-100">
        {t('settings.api.keys.createTitle')}
      </h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label={t('settings.api.keys.nameLabel')}
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        placeholder={t('settings.api.keys.namePlaceholder')}
        required
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-300">
          {t('settings.api.scopesLegend')}
        </legend>
        {API_KEY_SCOPES.map((scope) => {
          // A read whose implying write is selected is auto-included and locked.
          const impliedByWrite = writeScopeForRead(scope);
          const locked = impliedByWrite !== undefined && scopes.has(impliedByWrite);
          return (
            <label
              key={scope}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
            >
              <input
                type="checkbox"
                checked={scopes.has(scope) || locked}
                disabled={locked}
                onChange={() => toggle(scope)}
                className="mt-1 h-4 w-4 accent-sky-500 disabled:opacity-60"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-neutral-100">{meta[scope].label}</span>
                <span className="text-xs text-neutral-500">{meta[scope].description}</span>
                {locked ? (
                  <span className="text-xs text-neutral-600">
                    {t('settings.api.scope.impliedByWrite')}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? t('settings.api.keys.creating') : t('settings.api.keys.create')}
        </Button>
      </div>
    </form>
  );
}

/** One key row with a two-step confirm before revoking. */
function ApiKeyRow({ apiKey }: { apiKey: ApiKeySummary }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);

  const mutation = useMutation({
    mutationFn: () => revokeApiKey(apiKey.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: API_KEYS_KEY });
    },
    onError: () => setError(true),
  });

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-100">{apiKey.name}</span>
        <span className="flex flex-wrap gap-1">
          {apiKey.scopes.map((scope) => (
            <span
              key={scope}
              className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[0.65rem] text-neutral-300"
            >
              {scope}
            </span>
          ))}
        </span>
        <span className="text-xs text-neutral-500">
          {apiKey.lastUsedAt
            ? t('settings.api.keys.createdLastUsed', {
                createdAt: formatDate(apiKey.createdAt),
                lastUsedAt: formatDate(apiKey.lastUsedAt),
              })
            : t('settings.api.keys.createdNeverUsed', { createdAt: formatDate(apiKey.createdAt) })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error ? (
          <span className="text-xs text-red-400">{t('settings.api.revokeFailed')}</span>
        ) : null}
        {confirming ? (
          <>
            <Button
              variant="secondary"
              className={cx('text-red-300 ring-red-900 hover:bg-red-950')}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? t('settings.api.revoking') : t('settings.api.confirmRevoke')}
            </Button>
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            {t('settings.api.keys.revoke')}
          </Button>
        )}
      </div>
    </li>
  );
}

// ─── OAuth apps (registered clients, part 2) ─────────────────────────────────

/**
 * The one-time credentials modal for a freshly-registered app. The `client_id`
 * is non-secret and always shown; a confidential client's `client_secret` is
 * shown here exactly once and never again (the #302 show-once pattern).
 */
function OAuthCredentialsModal({
  result,
  onClose,
}: {
  result: CreateOAuthClientResponse;
  onClose: () => void;
}) {
  const t = useT();
  const [copiedSecret, setCopiedSecret] = useState(false);

  async function copySecret() {
    if (result.clientSecret == null) return;
    try {
      await navigator.clipboard.writeText(result.clientSecret);
      setCopiedSecret(true);
    } catch {
      setCopiedSecret(false);
    }
  }

  return (
    <Dialog
      title={t('settings.api.oauth.credentialsModal.title')}
      description={
        result.clientSecret
          ? t('settings.api.oauth.credentialsModal.descriptionSecret')
          : t('settings.api.oauth.credentialsModal.descriptionPublic')
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('settings.api.oauth.clientIdLabel')}
          </span>
          <code className="overflow-x-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-200 ring-1 ring-inset ring-neutral-700">
            {result.client.clientId}
          </code>
        </div>
        {result.clientSecret ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">
              {t('settings.api.oauth.clientSecretLabel')}
            </span>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-emerald-300 ring-1 ring-inset ring-neutral-700">
                {result.clientSecret}
              </code>
              <Button variant="secondary" onClick={copySecret}>
                {copiedSecret ? t('settings.api.copied') : t('settings.api.copy')}
              </Button>
            </div>
          </div>
        ) : null}
        <Alert tone="info">
          {result.clientSecret
            ? t('settings.api.oauth.credentialsModal.secretWarning', { name: result.client.name })
            : t('settings.api.oauth.credentialsModal.publicClientNotice')}
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>{t('settings.api.done')}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Register-app form: a name, one or more redirect URIs, scopes, and a public toggle. */
function RegisterOAuthClientForm({
  onCreated,
}: {
  onCreated: (result: CreateOAuthClientResponse) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [redirectUris, setRedirectUris] = useState<string[]>(['']);
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set());
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: CreateOAuthClientRequest) => createOAuthClient(input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: OAUTH_CLIENTS_KEY });
      setName('');
      setRedirectUris(['']);
      setScopes(new Set());
      setIsPublic(false);
      setError(null);
      onCreated(result);
    },
    onError: () => setError(t('settings.api.oauth.registerError')),
  });

  function toggleScope(scope: ApiKeyScope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        // A read implied by a still-selected write is locked on — leave it.
        const write = writeScopeForRead(scope);
        if (write && next.has(write)) return prev;
        next.delete(scope);
      } else {
        next.add(scope);
        // Write-implies-read (#371): selecting a write auto-selects its read.
        const read = impliedReadScope(scope);
        if (read) next.add(read);
      }
      return next;
    });
  }

  function setUriAt(index: number, value: string) {
    setRedirectUris((prev) => prev.map((uri, i) => (i === index ? value : uri)));
  }

  function addUri() {
    setRedirectUris((prev) => (prev.length >= 10 ? prev : [...prev, '']));
  }

  function removeUriAt(index: number) {
    setRedirectUris((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length === 0) {
      setError(t('settings.api.oauth.nameRequired'));
      return;
    }
    const uris = redirectUris.map((uri) => uri.trim()).filter((uri) => uri.length > 0);
    if (uris.length === 0) {
      setError(t('settings.api.oauth.redirectUriRequired'));
      return;
    }
    if (scopes.size === 0) {
      setError(t('settings.api.scopeRequired'));
      return;
    }
    mutation.mutate({
      name: name.trim(),
      redirectUris: uris,
      scopes: withImpliedReadScopes([...scopes]),
      public: isPublic,
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-neutral-100">
        {t('settings.api.oauth.registerTitle')}
      </h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label={t('settings.api.oauth.appNameLabel')}
        name="oauth-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        placeholder={t('settings.api.oauth.appNamePlaceholder')}
        required
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-300">
          {t('settings.api.oauth.redirectUrisLegend')}
        </legend>
        <p className="text-xs text-neutral-500">
          {t('settings.api.oauth.redirectUrisHintBefore')}
          <code className="font-mono text-neutral-400">{'myapp://callback'}</code>
          {t('settings.api.oauth.redirectUrisHintAfter')}
        </p>
        {redirectUris.map((uri, index) => (
          // Index keys are acceptable: the inputs are controlled and the list is
          // only ever appended to / removed from, never reordered.
          <div key={index} className="flex items-center gap-2">
            <input
              type="text"
              value={uri}
              onChange={(e) => setUriAt(index, e.target.value)}
              placeholder={t('settings.api.oauth.redirectPlaceholder')}
              aria-label={t('settings.api.oauth.redirectUriAriaLabel', { index: index + 1 })}
              className="flex-1 rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
            {redirectUris.length > 1 ? (
              <Button
                variant="ghost"
                aria-label={t('settings.api.oauth.removeRedirectUriAriaLabel', {
                  index: index + 1,
                })}
                onClick={() => removeUriAt(index)}
              >
                {t('settings.api.oauth.removeUri')}
              </Button>
            ) : null}
          </div>
        ))}
        {redirectUris.length < 10 ? (
          <div>
            <Button variant="ghost" onClick={addUri}>
              {t('settings.api.oauth.addUri')}
            </Button>
          </div>
        ) : null}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-300">
          {t('settings.api.scopesLegend')}
        </legend>
        <p className="text-xs text-neutral-500">{t('settings.api.oauth.scopesHint')}</p>
        {API_KEY_SCOPES.map((scope) => {
          // A read whose implying write is selected is auto-included and locked.
          const impliedByWrite = writeScopeForRead(scope);
          const locked = impliedByWrite !== undefined && scopes.has(impliedByWrite);
          return (
            <label
              key={scope}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
            >
              <input
                type="checkbox"
                checked={scopes.has(scope) || locked}
                disabled={locked}
                onChange={() => toggleScope(scope)}
                className="mt-1 h-4 w-4 accent-sky-500 disabled:opacity-60"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-neutral-100">{OAUTH_SCOPE_LABELS[scope]}</span>
                {locked ? (
                  <span className="text-xs text-neutral-600">
                    {t('settings.api.scope.impliedByWrite')}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)}
          className="mt-1 h-4 w-4 accent-sky-500"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-neutral-100">
            {t('settings.api.oauth.publicClientLabel')}
          </span>
          <span className="text-xs text-neutral-500">
            {t('settings.api.oauth.publicClientDescription')}
          </span>
        </span>
      </label>
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? t('settings.api.oauth.registering')
            : t('settings.api.oauth.register')}
        </Button>
      </div>
    </form>
  );
}

/** One registered app with a two-step confirm before deletion (cascades its grants). */
function OAuthClientRow({ client }: { client: OAuthClientSummary }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);

  const mutation = useMutation({
    mutationFn: () => deleteOAuthClient(client.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OAUTH_CLIENTS_KEY });
      // Deleting an app cascades its grants — refresh the authorized-apps list too.
      void queryClient.invalidateQueries({ queryKey: OAUTH_GRANTS_KEY });
    },
    onError: () => setError(true),
  });

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-100">{client.name}</span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[0.65rem] text-neutral-300">
            {client.public ? t('settings.api.oauth.public') : t('settings.api.oauth.confidential')}
          </span>
        </span>
        <code className="font-mono text-xs text-neutral-400">{client.clientId}</code>
        <span className="flex flex-wrap gap-1">
          {client.scopes.map((scope) => (
            <span
              key={scope}
              className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[0.65rem] text-neutral-300"
            >
              {scope}
            </span>
          ))}
        </span>
        <span className="flex flex-col gap-0.5">
          {client.redirectUris.map((uri) => (
            <span key={uri} className="break-all font-mono text-[0.65rem] text-neutral-500">
              {uri}
            </span>
          ))}
        </span>
        <span className="text-xs text-neutral-500">
          {t('settings.api.oauth.registeredOn', { createdAt: formatDate(client.createdAt) })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error ? (
          <span className="text-xs text-red-400">{t('settings.api.oauth.deleteFailed')}</span>
        ) : null}
        {confirming ? (
          <>
            <Button
              variant="secondary"
              className={cx('text-red-300 ring-red-900 hover:bg-red-950')}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending
                ? t('settings.api.oauth.deleting')
                : t('settings.api.oauth.confirmDelete')}
            </Button>
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            {t('common.delete')}
          </Button>
        )}
      </div>
    </li>
  );
}

/** One authorized app (grant) with a two-step confirm before revoking access. */
function OAuthGrantRow({ grant }: { grant: OAuthGrantSummary }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);

  const mutation = useMutation({
    mutationFn: () => revokeOAuthGrant(grant.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OAUTH_GRANTS_KEY });
    },
    onError: () => setError(true),
  });

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-100">
          {t('settings.api.grants.canAccess', { appName: grant.appName })}
        </span>
        <ul className="flex flex-col gap-0.5">
          {grant.scopes.map((scope) => (
            <li key={scope} className="text-xs text-neutral-400">
              · {OAUTH_SCOPE_LABELS[scope]}
            </li>
          ))}
        </ul>
        <span className="text-xs text-neutral-500">
          {grant.lastUsedAt
            ? t('settings.api.grants.authorizedLastUsed', {
                createdAt: formatDate(grant.createdAt),
                lastUsedAt: formatDate(grant.lastUsedAt),
              })
            : t('settings.api.grants.authorizedNeverUsed', {
                createdAt: formatDate(grant.createdAt),
              })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error ? (
          <span className="text-xs text-red-400">{t('settings.api.revokeFailed')}</span>
        ) : null}
        {confirming ? (
          <>
            <Button
              variant="secondary"
              className={cx('text-red-300 ring-red-900 hover:bg-red-950')}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? t('settings.api.revoking') : t('settings.api.confirmRevoke')}
            </Button>
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            {t('settings.api.grants.revokeAccess')}
          </Button>
        )}
      </div>
    </li>
  );
}

/** "OAuth apps" — register + list the developer's own third-party apps. */
function OAuthAppsSection({
  onCreated,
}: {
  onCreated: (result: CreateOAuthClientResponse) => void;
}) {
  const t = useT();
  const query = useQuery({
    queryKey: OAUTH_CLIENTS_KEY,
    queryFn: ({ signal }) => listOAuthClients(signal),
    staleTime: 15_000,
  });
  const clients = query.data?.clients ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">
          {t('settings.api.oauth.sectionTitle')}
        </h2>
        <p className="text-sm text-neutral-500">{t('settings.api.oauth.sectionDescription')}</p>
      </div>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <RegisterOAuthClientForm onCreated={onCreated} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.api.oauth.yourApps')}
        </h3>
        {query.isPending ? (
          <Skeleton height="h-20" />
        ) : query.isError ? (
          <EmptyState
            title={t('settings.api.oauth.loadError.title')}
            description={t('settings.retryHint')}
          />
        ) : clients.length === 0 ? (
          <EmptyState
            icon="🧩"
            title={t('settings.api.oauth.empty.title')}
            description={t('settings.api.oauth.empty.description')}
          />
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800 bg-neutral-900">
            {clients.map((client) => (
              <OAuthClientRow key={client.id} client={client} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** "Authorized apps" — third-party apps the user has granted access to. */
function AuthorizedAppsSection() {
  const t = useT();
  const query = useQuery({
    queryKey: OAUTH_GRANTS_KEY,
    queryFn: ({ signal }) => listOAuthGrants(signal),
    staleTime: 15_000,
  });
  const grants = query.data?.grants ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">
          {t('settings.api.grants.sectionTitle')}
        </h2>
        <p className="text-sm text-neutral-500">{t('settings.api.grants.sectionDescription')}</p>
      </div>

      <section className="flex flex-col gap-3">
        {query.isPending ? (
          <Skeleton height="h-20" />
        ) : query.isError ? (
          <EmptyState
            title={t('settings.api.grants.loadError.title')}
            description={t('settings.retryHint')}
          />
        ) : grants.length === 0 ? (
          <EmptyState
            icon="🔒"
            title={t('settings.api.grants.empty.title')}
            description={t('settings.api.grants.empty.description')}
          />
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800 bg-neutral-900">
            {grants.map((grant) => (
              <OAuthGrantRow key={grant.id} grant={grant} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Settings → API Access (PROJECTPLAN.md §6.13, V2-P12). Mint scoped personal
 * API keys (bearer tokens shown once), list active keys, and revoke them. Part 2
 * adds OAuth apps: register third-party clients (developer surface) and manage
 * the apps you've authorized (grants). The public API docs live at `/docs`.
 */
export function ApiAccessPage() {
  const t = useT();
  const [minted, setMinted] = useState<CreateApiKeyResponse | null>(null);
  const [registered, setRegistered] = useState<CreateOAuthClientResponse | null>(null);
  const query = useQuery({
    queryKey: API_KEYS_KEY,
    queryFn: ({ signal }) => listApiKeys(signal),
    staleTime: 15_000,
  });

  const keys = query.data?.keys ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">{t('settings.api.title')}</h2>
        <p className="text-sm text-neutral-500">
          {t('settings.api.introBefore')}
          <code className="font-mono text-neutral-300">{'Authorization: Bearer …'}</code>
          {t('settings.api.introMiddle')}
          <code className="font-mono text-neutral-300">{'/docs'}</code>
          {t('settings.api.introAfter')}
        </p>
      </div>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <CreateApiKeyForm onCreated={setMinted} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.api.keys.sectionTitle')}
        </h3>
        {query.isPending ? (
          <Skeleton height="h-20" />
        ) : query.isError ? (
          <EmptyState
            title={t('settings.api.keys.loadError.title')}
            description={t('settings.retryHint')}
          />
        ) : keys.length === 0 ? (
          <EmptyState
            icon="🔑"
            title={t('settings.api.keys.empty.title')}
            description={t('settings.api.keys.empty.description')}
          />
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800 bg-neutral-900">
            {keys.map((apiKey) => (
              <ApiKeyRow key={apiKey.id} apiKey={apiKey} />
            ))}
          </ul>
        )}
      </section>

      <hr className="border-neutral-800" />

      <OAuthAppsSection onCreated={setRegistered} />

      <hr className="border-neutral-800" />

      <AuthorizedAppsSection />

      {minted ? <TokenModal result={minted} onClose={() => setMinted(null)} /> : null}
      {registered ? (
        <OAuthCredentialsModal result={registered} onClose={() => setRegistered(null)} />
      ) : null}
    </div>
  );
}
