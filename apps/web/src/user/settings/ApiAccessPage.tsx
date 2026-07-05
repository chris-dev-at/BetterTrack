import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  API_KEY_SCOPES,
  OAUTH_SCOPE_LABELS,
  type ApiKeyScope,
  type ApiKeySummary,
  type CreateApiKeyResponse,
  type CreateOAuthClientRequest,
  type CreateOAuthClientResponse,
  type OAuthClientSummary,
  type OAuthGrantSummary,
} from '@bettertrack/contracts';

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
const SCOPE_META: Record<ApiKeyScope, { label: string; description: string }> = {
  'portfolio:read': {
    label: 'Portfolio · read',
    description: 'Read portfolios, holdings and cash.',
  },
  'portfolio:write': {
    label: 'Portfolio · write',
    description: 'Create/edit portfolios, transactions and cash movements.',
  },
  'workboard:read': {
    label: 'Workboard · read',
    description: 'Read watchlists, conglomerates and backtests.',
  },
  'workboard:write': {
    label: 'Workboard · write',
    description: 'Edit watchlists, conglomerates and run backtests.',
  },
  'market:read': { label: 'Market · read', description: 'Search assets and read quotes/history.' },
  'social:read': { label: 'Social · read', description: 'Read friends, shares and notifications.' },
};

/** The one-time token modal — the plaintext is available here and never again. */
function TokenModal({ result, onClose }: { result: CreateApiKeyResponse; onClose: () => void }) {
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
      title="Your new API key"
      description="Copy it now — for your security, it won't be shown again."
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-emerald-300 ring-1 ring-inset ring-neutral-700">
            {result.token}
          </code>
          <Button variant="secondary" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <Alert tone="info">
          Store this token somewhere safe. Anyone with it can use the “{result.key.name}” key with
          its scopes. You won't be able to see it again — revoke and create a new key if you lose
          it.
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Create-key form: a name plus at least one scope. */
function CreateApiKeyForm({ onCreated }: { onCreated: (result: CreateApiKeyResponse) => void }) {
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
    onError: () => setError('Could not create the key. Please try again.'),
  });

  function toggle(scope: ApiKeyScope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length === 0) {
      setError('Give the key a name.');
      return;
    }
    if (scopes.size === 0) {
      setError('Select at least one scope.');
      return;
    }
    mutation.mutate({ name: name.trim(), scopes: [...scopes] });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-neutral-100">Create a key</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label="Name"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        placeholder="e.g. Portfolio sync script"
        required
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-300">Scopes</legend>
        {API_KEY_SCOPES.map((scope) => (
          <label
            key={scope}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
          >
            <input
              type="checkbox"
              checked={scopes.has(scope)}
              onChange={() => toggle(scope)}
              className="mt-1 h-4 w-4 accent-sky-500"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-neutral-100">
                {SCOPE_META[scope].label}
              </span>
              <span className="text-xs text-neutral-500">{SCOPE_META[scope].description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Creating…' : 'Create key'}
        </Button>
      </div>
    </form>
  );
}

/** One key row with a two-step confirm before revoking. */
function ApiKeyRow({ apiKey }: { apiKey: ApiKeySummary }) {
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
          Created {formatDate(apiKey.createdAt)} ·{' '}
          {apiKey.lastUsedAt ? `last used ${formatDate(apiKey.lastUsedAt)}` : 'never used'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error ? <span className="text-xs text-red-400">Couldn't revoke.</span> : null}
        {confirming ? (
          <>
            <Button
              variant="secondary"
              className={cx('text-red-300 ring-red-900 hover:bg-red-950')}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? 'Revoking…' : 'Confirm revoke'}
            </Button>
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
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
      title="Your new OAuth app"
      description={
        result.clientSecret
          ? "Copy the client secret now — for your security, it won't be shown again."
          : 'This is a public client — it holds no secret and must use PKCE.'
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">Client ID</span>
          <code className="overflow-x-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-200 ring-1 ring-inset ring-neutral-700">
            {result.client.clientId}
          </code>
        </div>
        {result.clientSecret ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">Client secret</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-emerald-300 ring-1 ring-inset ring-neutral-700">
                {result.clientSecret}
              </code>
              <Button variant="secondary" onClick={copySecret}>
                {copiedSecret ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        ) : null}
        <Alert tone="info">
          {result.clientSecret
            ? `Store this secret somewhere safe. Anyone with it can act as the “${result.client.name}” app. You won't be able to see it again — delete this app and register a new one if you lose it.`
            : `Public clients (mobile/SPA) authenticate with PKCE instead of a secret. Use the client ID above with a code challenge.`}
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
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
    onError: () => setError('Could not register the app. Check the redirect URIs and try again.'),
  });

  function toggleScope(scope: ApiKeyScope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
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
      setError('Give the app a name.');
      return;
    }
    const uris = redirectUris.map((uri) => uri.trim()).filter((uri) => uri.length > 0);
    if (uris.length === 0) {
      setError('Add at least one redirect URI.');
      return;
    }
    if (scopes.size === 0) {
      setError('Select at least one scope.');
      return;
    }
    mutation.mutate({
      name: name.trim(),
      redirectUris: uris,
      scopes: [...scopes],
      public: isPublic,
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-neutral-100">Register an app</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label="App name"
        name="oauth-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        placeholder="e.g. My mobile app"
        required
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-300">Redirect URIs</legend>
        <p className="text-xs text-neutral-500">
          Where we send users after they approve. Use https, http loopback, or a custom-scheme deep
          link (e.g. <code className="font-mono text-neutral-400">myapp://callback</code>).
        </p>
        {redirectUris.map((uri, index) => (
          // Index keys are acceptable: the inputs are controlled and the list is
          // only ever appended to / removed from, never reordered.
          <div key={index} className="flex items-center gap-2">
            <input
              type="text"
              value={uri}
              onChange={(e) => setUriAt(index, e.target.value)}
              placeholder="https://example.com/callback"
              aria-label={`Redirect URI ${index + 1}`}
              className="flex-1 rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
            {redirectUris.length > 1 ? (
              <Button
                variant="ghost"
                aria-label={`Remove redirect URI ${index + 1}`}
                onClick={() => removeUriAt(index)}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        {redirectUris.length < 10 ? (
          <div>
            <Button variant="ghost" onClick={addUri}>
              + Add another URI
            </Button>
          </div>
        ) : null}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-300">Scopes</legend>
        <p className="text-xs text-neutral-500">
          What the app may request on the consent screen, in the words users will see.
        </p>
        {API_KEY_SCOPES.map((scope) => (
          <label
            key={scope}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
          >
            <input
              type="checkbox"
              checked={scopes.has(scope)}
              onChange={() => toggleScope(scope)}
              className="mt-1 h-4 w-4 accent-sky-500"
            />
            <span className="text-sm text-neutral-100">{OAUTH_SCOPE_LABELS[scope]}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)}
          className="mt-1 h-4 w-4 accent-sky-500"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-neutral-100">Public client</span>
          <span className="text-xs text-neutral-500">
            Mobile / SPA apps that can't keep a secret. Uses PKCE, no client secret is issued.
          </span>
        </span>
      </label>
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Registering…' : 'Register app'}
        </Button>
      </div>
    </form>
  );
}

/** One registered app with a two-step confirm before deletion (cascades its grants). */
function OAuthClientRow({ client }: { client: OAuthClientSummary }) {
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
            {client.public ? 'Public' : 'Confidential'}
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
        <span className="text-xs text-neutral-500">Registered {formatDate(client.createdAt)}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error ? <span className="text-xs text-red-400">Couldn't delete.</span> : null}
        {confirming ? (
          <>
            <Button
              variant="secondary"
              className={cx('text-red-300 ring-red-900 hover:bg-red-950')}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? 'Deleting…' : 'Confirm delete'}
            </Button>
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

/** One authorized app (grant) with a two-step confirm before revoking access. */
function OAuthGrantRow({ grant }: { grant: OAuthGrantSummary }) {
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
        <span className="text-sm font-medium text-neutral-100">{grant.appName} can:</span>
        <ul className="flex flex-col gap-0.5">
          {grant.scopes.map((scope) => (
            <li key={scope} className="text-xs text-neutral-400">
              · {OAUTH_SCOPE_LABELS[scope]}
            </li>
          ))}
        </ul>
        <span className="text-xs text-neutral-500">
          Authorized {formatDate(grant.createdAt)} ·{' '}
          {grant.lastUsedAt ? `last used ${formatDate(grant.lastUsedAt)}` : 'never used'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {error ? <span className="text-xs text-red-400">Couldn't revoke.</span> : null}
        {confirming ? (
          <>
            <Button
              variant="secondary"
              className={cx('text-red-300 ring-red-900 hover:bg-red-950')}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? 'Revoking…' : 'Confirm revoke'}
            </Button>
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Revoke access
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
  const query = useQuery({
    queryKey: OAUTH_CLIENTS_KEY,
    queryFn: ({ signal }) => listOAuthClients(signal),
    staleTime: 15_000,
  });
  const clients = query.data?.clients ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">OAuth apps</h2>
        <p className="text-sm text-neutral-500">
          Register a third-party app to request scoped, revocable access to BetterTrack accounts via
          OAuth 2.0 (authorization code + PKCE). Users approve it on a consent screen and never
          share their password.
        </p>
      </div>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <RegisterOAuthClientForm onCreated={onCreated} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-neutral-100">Your apps</h3>
        {query.isPending ? (
          <Skeleton height="h-20" />
        ) : query.isError ? (
          <EmptyState title="Couldn't load your apps" description="Please try again in a moment." />
        ) : clients.length === 0 ? (
          <EmptyState
            icon="🧩"
            title="No OAuth apps yet"
            description="Register an app above to integrate with the OAuth flow."
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
  const query = useQuery({
    queryKey: OAUTH_GRANTS_KEY,
    queryFn: ({ signal }) => listOAuthGrants(signal),
    staleTime: 15_000,
  });
  const grants = query.data?.grants ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">Authorized apps</h2>
        <p className="text-sm text-neutral-500">
          Third-party apps you've allowed to access your account. Revoking an app immediately kills
          its tokens — it must be re-authorized to regain access.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        {query.isPending ? (
          <Skeleton height="h-20" />
        ) : query.isError ? (
          <EmptyState
            title="Couldn't load your authorized apps"
            description="Please try again in a moment."
          />
        ) : grants.length === 0 ? (
          <EmptyState
            icon="🔒"
            title="No authorized apps"
            description="Apps you approve on the OAuth consent screen appear here."
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
        <h2 className="text-lg font-semibold text-neutral-100">API Access</h2>
        <p className="text-sm text-neutral-500">
          Personal API keys authenticate scripts and integrations as you, scoped to what they may
          read or change. Send a key as{' '}
          <code className="font-mono text-neutral-300">Authorization: Bearer …</code>. See the API
          docs at <code className="font-mono text-neutral-300">/docs</code>.
        </p>
      </div>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <CreateApiKeyForm onCreated={setMinted} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-neutral-100">Your keys</h3>
        {query.isPending ? (
          <Skeleton height="h-20" />
        ) : query.isError ? (
          <EmptyState
            title="Couldn't load your API keys"
            description="Please try again in a moment."
          />
        ) : keys.length === 0 ? (
          <EmptyState
            icon="🔑"
            title="No API keys yet"
            description="Create a key above to start using the API."
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
