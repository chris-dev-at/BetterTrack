import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  withImpliedReadScopes,
  type ApiKeyScope,
  type ApiKeySummary,
  type CreateApiKeyResponse,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { createApiKey, listApiKeys, revokeApiKey } from '../../../lib/apiKeysApi';
import { formatDate } from '../../../lib/format';
import { ScopePicker, Skeleton } from '../../../ui';
import { isParanoidBlockedScope } from '../../../ui/ScopePicker';
import { Badge, Button, Field, Input } from '../../../ui/origin';
import { Dialog } from '../../components/Dialog';
import { Alert } from '../../components/ui';
import { useResolvedPrivacyMode } from '../../vault/usePrivacyMode';
import {
  PanelForm,
  PanelGroup,
  PanelHead,
  PanelList,
  PanelListItem,
  PanelNote,
  Row,
} from './panelKit';

const API_KEYS_KEY = ['settings', 'api-keys'] as const;

/**
 * One scope token, rendered as a quiet monospace chip. A scope this account's
 * privacy mode refuses is shown MARKED, never dropped: the key really does
 * carry it (and it goes live again the moment paranoid mode is disabled), so a
 * shortened list would understate the credential in the user's own security
 * review.
 */
function ScopeChip({ scope, inactive = false }: { scope: string; inactive?: boolean }) {
  const t = useT();
  const label = inactive ? t('settings.api.keys.scopeInactive') : undefined;
  return (
    <Badge className="bt-cc-mono" outline title={label}>
      <span className={inactive ? 'line-through opacity-70' : undefined}>{scope}</span>
      {inactive ? <span className="bt-cc-row__hint ml-1 no-underline">({label})</span> : null}
    </Badge>
  );
}

/**
 * The one-time token modal — the plaintext is available here and never again.
 * Stays a {@link Dialog} (`role="dialog" aria-modal="true"`): the Control
 * Center's Escape handler defers to nested modals via exactly that selector.
 * The token is the modal's FIRST `<code>`; `e2e/bearer-scopes.spec.ts` reads it
 * from there.
 */
function TokenModal({ result, onClose }: { result: CreateApiKeyResponse; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setAcknowledged(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      phoneSheet
      title={t('settings.api.keys.tokenModal.title')}
      description={t('settings.api.keys.tokenModal.description')}
      onClose={onClose}
      dismissable={acknowledged}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <code
            className="bt-panel bt-panel--soft bt-cc-mono flex-1 break-all"
            style={{ padding: '8px 11px', color: 'var(--bt-pos)' }}
          >
            {result.token}
          </code>
          <Button className="w-full sm:w-auto" onClick={copy} size="sm">
            {copied ? t('settings.api.copied') : t('settings.api.copy')}
          </Button>
        </div>
        <Alert tone="info">
          {t('settings.api.keys.tokenModal.storeWarning', { name: result.key.name })}
        </Alert>
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setAcknowledged(true);
              onClose();
            }}
            size="sm"
            variant="primary"
          >
            {t('common.savedOneTimeSecret')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Create-key form: a name plus at least one scope. */
function CreateApiKeyForm({ onCreated }: { onCreated: (result: CreateApiKeyResponse) => void }) {
  const t = useT();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
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
    <PanelForm onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field htmlFor="name" label={t('settings.api.keys.nameLabel')}>
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
      {/* V5-P0b: one row per module, collapsed by default — already the right
          popup pattern, so it stays exactly as it was. */}
      <ScopePicker
        collapsible
        legend={t('settings.api.scopesLegend')}
        onChange={setScopes}
        paranoid={paranoid}
        scopes={scopes}
      />
      {/* The panel's single primary action. */}
      <Button
        className="self-start"
        disabled={mutation.isPending}
        size="sm"
        type="submit"
        variant="primary"
      >
        {mutation.isPending ? t('settings.api.keys.creating') : t('settings.api.keys.create')}
      </Button>
    </PanelForm>
  );
}

/** One key row with a two-step confirm before revoking. */
function ApiKeyRow({ apiKey }: { apiKey: ApiKeySummary }) {
  const t = useT();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
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
    <PanelListItem
      actions={
        <>
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
              <Button
                disabled={mutation.isPending}
                onClick={() => setConfirming(false)}
                size="sm"
                variant="quiet"
              >
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
              {t('settings.api.keys.revoke')}
            </Button>
          )}
        </>
      }
      main={
        <>
          <span className="bt-cc-row__label">{apiKey.name}</span>
          <span className="flex flex-wrap gap-1">
            {apiKey.scopes.map((scope) => (
              <ScopeChip
                inactive={paranoid && isParanoidBlockedScope(scope)}
                key={scope}
                scope={scope}
              />
            ))}
          </span>
          <span className="bt-cc-row__hint">
            {apiKey.lastUsedAt
              ? t('settings.api.keys.createdLastUsed', {
                  createdAt: formatDate(apiKey.createdAt),
                  lastUsedAt: formatDate(apiKey.lastUsedAt),
                })
              : t('settings.api.keys.createdNeverUsed', {
                  createdAt: formatDate(apiKey.createdAt),
                })}
          </span>
        </>
      }
    />
  );
}

/**
 * Control Center → API keys (PROJECTPLAN.md §6.13, V2-P12; R2 split). Mint
 * scoped personal bearer tokens (shown ONCE), list the active ones, revoke
 * them. The three-sentence `/docs` intro is retired down to the one line that
 * states a real constraint: how a key is sent and where the reference lives.
 *
 * Registering your own OAuth clients (`OAuthAppsPanel`) and auditing the
 * third-party grants on your account (`AuthorizedAppsPanel`) were three topics
 * in one page; they are three panels now.
 */
export function ApiKeysPanel() {
  const t = useT();
  const [minted, setMinted] = useState<CreateApiKeyResponse | null>(null);
  const query = useQuery({
    queryKey: API_KEYS_KEY,
    queryFn: ({ signal }) => listApiKeys(signal),
    staleTime: 15_000,
  });

  const keys = query.data?.keys ?? [];

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.apiKeys')} />
      <PanelNote>{t('settings.api.hint')}</PanelNote>

      <PanelGroup label={t('settings.api.keys.createTitle')}>
        <Row stack>
          <CreateApiKeyForm onCreated={setMinted} />
        </Row>
      </PanelGroup>

      <PanelGroup label={t('settings.api.keys.sectionTitle')}>
        {query.isPending ? (
          <Row stack>
            <Skeleton height="h-16" />
          </Row>
        ) : query.isError ? (
          <Row stack>
            <Alert tone="error">{t('settings.api.keys.loadError.title')}</Alert>
            <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>
          </Row>
        ) : keys.length === 0 ? (
          <Row stack>
            <PanelNote>{t('settings.api.keys.empty.title')}</PanelNote>
          </Row>
        ) : (
          <PanelList>
            {keys.map((apiKey) => (
              <ApiKeyRow apiKey={apiKey} key={apiKey.id} />
            ))}
          </PanelList>
        )}
      </PanelGroup>

      {minted ? <TokenModal onClose={() => setMinted(null)} result={minted} /> : null}
    </div>
  );
}
