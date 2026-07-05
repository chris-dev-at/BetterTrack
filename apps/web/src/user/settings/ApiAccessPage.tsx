import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  API_KEY_SCOPES,
  type ApiKeyScope,
  type ApiKeySummary,
  type CreateApiKeyResponse,
} from '@bettertrack/contracts';

import { createApiKey, listApiKeys, revokeApiKey } from '../../lib/apiKeysApi';
import { formatDate } from '../../lib/format';
import { EmptyState, Skeleton } from '../../ui';
import { Dialog } from '../components/Dialog';
import { Alert, Button, TextField, cx } from '../components/ui';

const API_KEYS_KEY = ['settings', 'api-keys'] as const;

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

/**
 * Settings → API Access (PROJECTPLAN.md §6.13, V2-P12). Mint scoped personal
 * API keys (bearer tokens shown once), list active keys, and revoke them. The
 * public API docs live at `/docs`; OAuth apps are a later addition (part 2).
 */
export function ApiAccessPage() {
  const [minted, setMinted] = useState<CreateApiKeyResponse | null>(null);
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

      {minted ? <TokenModal result={minted} onClose={() => setMinted(null)} /> : null}
    </div>
  );
}
