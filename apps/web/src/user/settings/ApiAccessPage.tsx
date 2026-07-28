import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  OAUTH_SCOPE_LABELS,
  withImpliedReadScopes,
  type ApiKeyScope,
  type ApiKeySummary,
  type CreateApiKeyResponse,
  type CreateOAuthClientRequest,
  type CreateOAuthClientResponse,
  type OAuthClientSummary,
  type OAuthGrantSummary,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { createApiKey, listApiKeys, revokeApiKey } from '../../lib/apiKeysApi';
import {
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  listOAuthGrants,
  revokeOAuthGrant,
} from '../../lib/oauthApi';
import { formatDate } from '../../lib/format';
import { EmptyState, ScopePicker, Skeleton } from '../../ui';
import { Badge, Button, Field, Input, SectionHead } from '../../ui/origin';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { WebhooksSection } from './WebhooksSection';

const API_KEYS_KEY = ['settings', 'api-keys'] as const;
const OAUTH_CLIENTS_KEY = ['settings', 'oauth-clients'] as const;
const OAUTH_GRANTS_KEY = ['settings', 'oauth-grants'] as const;

/** Monospace secret/identifier surface — the show-once tokens and client ids. */
const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** One scope token, rendered as a quiet monospace chip. */
function ScopeChip({ scope }: { scope: string }) {
  return (
    <Badge outline style={{ fontFamily: MONO_FONT, fontSize: 11, minHeight: 18 }}>
      {scope}
    </Badge>
  );
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
          <code
            className="bt-panel bt-panel--soft bt-num flex-1 overflow-x-auto"
            style={{ fontFamily: MONO_FONT, padding: '8px 11px', color: 'var(--bt-pos)' }}
          >
            {result.token}
          </code>
          <Button onClick={copy}>{copied ? t('settings.api.copied') : t('settings.api.copy')}</Button>
        </div>
        <Alert tone="info">
          {t('settings.api.keys.tokenModal.storeWarning', { name: result.key.name })}
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose} variant="primary">
            {t('settings.api.done')}
          </Button>
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
      <h3 className="bt-h3">{t('settings.api.keys.createTitle')}</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field className="max-w-sm" htmlFor="name" label={t('settings.api.keys.nameLabel')}>
        <Input
          id="name"
          maxLength={80}
          name="name"
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.api.keys.namePlaceholder')}
          required
          value={name}
        />
      </Field>
      {/* V5-P0b: one row per module, collapsed by default so an unrelated key
          form doesn't hog vertical space above the OAuth registration. */}
      <ScopePicker
        scopes={scopes}
        onChange={setScopes}
        collapsible
        legend={t('settings.api.scopesLegend')}
      />
      <div>
        {/* The page's single primary action (§ Origin controls: one loud action). */}
        <Button disabled={mutation.isPending} type="submit" variant="primary">
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
    <li className="bt-band__row flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="bt-row-title">{apiKey.name}</span>
        <span className="flex flex-wrap gap-1">
          {apiKey.scopes.map((scope) => (
            <ScopeChip key={scope} scope={scope} />
          ))}
        </span>
        <span className="bt-row-sub">
          {apiKey.lastUsedAt
            ? t('settings.api.keys.createdLastUsed', {
                createdAt: formatDate(apiKey.createdAt),
                lastUsedAt: formatDate(apiKey.lastUsedAt),
              })
            : t('settings.api.keys.createdNeverUsed', { createdAt: formatDate(apiKey.createdAt) })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error ? <span className="bt-field__error">{t('settings.api.revokeFailed')}</span> : null}
        {confirming ? (
          <>
            <Button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              size="sm"
              variant="danger"
            >
              {mutation.isPending ? t('settings.api.revoking') : t('settings.api.confirmRevoke')}
            </Button>
            <Button disabled={mutation.isPending} onClick={() => setConfirming(false)} size="sm" variant="quiet">
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
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
          <span className="bt-label">{t('settings.api.oauth.clientIdLabel')}</span>
          <code
            className="bt-panel bt-panel--soft bt-num overflow-x-auto"
            style={{ fontFamily: MONO_FONT, padding: '8px 11px', color: 'var(--bt-text-soft)' }}
          >
            {result.client.clientId}
          </code>
        </div>
        {result.clientSecret ? (
          <div className="flex flex-col gap-1.5">
            <span className="bt-label">{t('settings.api.oauth.clientSecretLabel')}</span>
            <div className="flex items-center gap-2">
              <code
                className="bt-panel bt-panel--soft bt-num flex-1 overflow-x-auto"
                style={{ fontFamily: MONO_FONT, padding: '8px 11px', color: 'var(--bt-pos)' }}
              >
                {result.clientSecret}
              </code>
              <Button onClick={copySecret}>
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
          <Button onClick={onClose} variant="primary">
            {t('settings.api.done')}
          </Button>
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
      <h3 className="bt-h3">{t('settings.api.oauth.registerTitle')}</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        className="max-w-sm"
        htmlFor="oauth-name"
        label={t('settings.api.oauth.appNameLabel')}
      >
        <Input
          id="oauth-name"
          maxLength={80}
          name="oauth-name"
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.api.oauth.appNamePlaceholder')}
          required
          value={name}
        />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="bt-label">{t('settings.api.oauth.redirectUrisLegend')}</legend>
        <p className="bt-meta">
          {t('settings.api.oauth.redirectUrisHintBefore')}
          <code style={{ fontFamily: MONO_FONT }}>{'myapp://callback'}</code>
          {t('settings.api.oauth.redirectUrisHintAfter')}
        </p>
        {redirectUris.map((uri, index) => (
          // Index keys are acceptable: the inputs are controlled and the list is
          // only ever appended to / removed from, never reordered.
          <div key={index} className="flex max-w-xl items-center gap-2">
            <Input
              aria-label={t('settings.api.oauth.redirectUriAriaLabel', { index: index + 1 })}
              onChange={(e) => setUriAt(index, e.target.value)}
              placeholder={t('settings.api.oauth.redirectPlaceholder')}
              type="text"
              value={uri}
            />
            {redirectUris.length > 1 ? (
              <Button
                aria-label={t('settings.api.oauth.removeRedirectUriAriaLabel', {
                  index: index + 1,
                })}
                onClick={() => removeUriAt(index)}
                size="sm"
                variant="quiet"
              >
                {t('settings.api.oauth.removeUri')}
              </Button>
            ) : null}
          </div>
        ))}
        {redirectUris.length < 10 ? (
          <div>
            <Button onClick={addUri} size="sm" variant="quiet">
              {t('settings.api.oauth.addUri')}
            </Button>
          </div>
        ) : null}
      </fieldset>
      {/* V5-P0b: shared ScopePicker (one row per module, write implies read).
          Collapsed by default per the anti-bloat rule so registering an app
          doesn't scroll past every module tick to reach the public toggle. */}
      <div className="flex flex-col gap-1.5">
        <p className="bt-meta">{t('settings.api.oauth.scopesHint')}</p>
        <ScopePicker
          scopes={scopes}
          onChange={setScopes}
          collapsible
          legend={t('settings.api.scopesLegend')}
        />
      </div>
      <label
        className="bt-panel bt-panel--soft flex cursor-pointer items-start gap-3"
        style={{ padding: '9px 13px' }}
      >
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)}
          className="mt-1 h-4 w-4"
          style={{ accentColor: 'var(--bt-gold)' }}
        />
        <span className="flex flex-col gap-0.5">
          <span className="bt-row-title">{t('settings.api.oauth.publicClientLabel')}</span>
          <span className="bt-row-sub">{t('settings.api.oauth.publicClientDescription')}</span>
        </span>
      </label>
      <div>
        <Button disabled={mutation.isPending} type="submit">
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
    <li className="bt-band__row flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="bt-row-title">{client.name}</span>
          <Badge tone={client.public ? 'blue' : 'neutral'}>
            {client.public ? t('settings.api.oauth.public') : t('settings.api.oauth.confidential')}
          </Badge>
        </span>
        <code className="bt-meta" style={{ fontFamily: MONO_FONT }}>
          {client.clientId}
        </code>
        <span className="flex flex-wrap gap-1">
          {client.scopes.map((scope) => (
            <ScopeChip key={scope} scope={scope} />
          ))}
        </span>
        <span className="flex flex-col gap-0.5">
          {client.redirectUris.map((uri) => (
            <span
              key={uri}
              className="bt-row-sub break-all"
              style={{ fontFamily: MONO_FONT, fontSize: 11 }}
            >
              {uri}
            </span>
          ))}
        </span>
        <span className="bt-row-sub">
          {t('settings.api.oauth.registeredOn', { createdAt: formatDate(client.createdAt) })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error ? (
          <span className="bt-field__error">{t('settings.api.oauth.deleteFailed')}</span>
        ) : null}
        {confirming ? (
          <>
            <Button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              size="sm"
              variant="danger"
            >
              {mutation.isPending
                ? t('settings.api.oauth.deleting')
                : t('settings.api.oauth.confirmDelete')}
            </Button>
            <Button disabled={mutation.isPending} onClick={() => setConfirming(false)} size="sm" variant="quiet">
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
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
    <li className="bt-band__row flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="bt-row-title">
          {t('settings.api.grants.canAccess', { appName: grant.appName })}
        </span>
        <ul className="flex flex-col gap-0.5">
          {grant.scopes.map((scope) => (
            <li key={scope} className="bt-row-sub">
              · {OAUTH_SCOPE_LABELS[scope]}
            </li>
          ))}
        </ul>
        <span className="bt-row-sub">
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
        {error ? <span className="bt-field__error">{t('settings.api.revokeFailed')}</span> : null}
        {confirming ? (
          <>
            <Button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              size="sm"
              variant="danger"
            >
              {mutation.isPending ? t('settings.api.revoking') : t('settings.api.confirmRevoke')}
            </Button>
            <Button disabled={mutation.isPending} onClick={() => setConfirming(false)} size="sm" variant="quiet">
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
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
    <div className="flex flex-col gap-5">
      <SectionHead
        sub={t('settings.api.oauth.sectionDescription')}
        title={t('settings.api.oauth.sectionTitle')}
      />

      <section className="bt-panel bt-panel--pad">
        <RegisterOAuthClientForm onCreated={onCreated} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="bt-h3">{t('settings.api.oauth.yourApps')}</h3>
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
          <ul className="bt-panel bt-band">
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
    <div className="flex flex-col gap-5">
      <SectionHead
        sub={t('settings.api.grants.sectionDescription')}
        title={t('settings.api.grants.sectionTitle')}
      />

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
          <ul className="bt-panel bt-band">
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
    <div className="flex flex-col gap-6">
      <SectionHead
        sub={
          <>
            {t('settings.api.introBefore')}
            <code className="bt-soft" style={{ fontFamily: MONO_FONT }}>
              {'Authorization: Bearer …'}
            </code>
            {t('settings.api.introMiddle')}
            <code className="bt-soft" style={{ fontFamily: MONO_FONT }}>
              {'/docs'}
            </code>
            {t('settings.api.introAfter')}
          </>
        }
        title={t('settings.api.title')}
      />

      <section className="bt-panel bt-panel--pad">
        <CreateApiKeyForm onCreated={setMinted} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="bt-h3">{t('settings.api.keys.sectionTitle')}</h3>
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
          <ul className="bt-panel bt-band">
            {keys.map((apiKey) => (
              <ApiKeyRow key={apiKey.id} apiKey={apiKey} />
            ))}
          </ul>
        )}
      </section>

      <hr className="bt-rule" />

      <WebhooksSection />

      <hr className="bt-rule" />

      <OAuthAppsSection onCreated={setRegistered} />

      <hr className="bt-rule" />

      <AuthorizedAppsSection />

      {minted ? <TokenModal result={minted} onClose={() => setMinted(null)} /> : null}
      {registered ? (
        <OAuthCredentialsModal result={registered} onClose={() => setRegistered(null)} />
      ) : null}
    </div>
  );
}
