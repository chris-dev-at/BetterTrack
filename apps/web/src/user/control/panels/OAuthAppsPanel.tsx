import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  withImpliedReadScopes,
  type ApiKeyScope,
  type CreateOAuthClientRequest,
  type CreateOAuthClientResponse,
  type OAuthClientSummary,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDate } from '../../../lib/format';
import { createOAuthClient, deleteOAuthClient, listOAuthClients } from '../../../lib/oauthApi';
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

const OAUTH_CLIENTS_KEY = ['settings', 'oauth-clients'] as const;
const OAUTH_GRANTS_KEY = ['settings', 'oauth-grants'] as const;

/** One scope token, rendered as a quiet monospace chip. */
/**
 * One scope token. A scope this account's privacy mode refuses is shown
 * MARKED, never dropped — same rule as `ApiKeysPanel.ScopeChip`: the client is
 * really registered with it (and it goes live again the moment paranoid mode is
 * disabled), so a shortened list would understate what the app may ask for.
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
 * The one-time credentials modal for a freshly-registered app. The `client_id`
 * is non-secret and always shown; a confidential client's `client_secret` is
 * shown here exactly once and never again (the #302 show-once pattern).
 *
 * Stays a {@link Dialog} (`role="dialog" aria-modal="true"`) — the Control
 * Center's Escape handler defers to nested modals via exactly that selector.
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
  const [acknowledged, setAcknowledged] = useState(result.clientSecret == null);

  async function copySecret() {
    if (result.clientSecret == null) return;
    try {
      await navigator.clipboard.writeText(result.clientSecret);
      setCopiedSecret(true);
      setAcknowledged(true);
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
      dismissable={acknowledged}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="bt-label">{t('settings.api.oauth.clientIdLabel')}</span>
          <code
            className="bt-panel bt-panel--soft bt-cc-mono"
            style={{ padding: '8px 11px', color: 'var(--bt-text-soft)' }}
          >
            {result.client.clientId}
          </code>
        </div>
        {result.clientSecret ? (
          <div className="flex flex-col gap-1.5">
            <span className="bt-label">{t('settings.api.oauth.clientSecretLabel')}</span>
            <div className="flex items-center gap-2">
              <code
                className="bt-panel bt-panel--soft bt-cc-mono flex-1"
                style={{ padding: '8px 11px', color: 'var(--bt-pos)' }}
              >
                {result.clientSecret}
              </code>
              <Button onClick={copySecret} size="sm">
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
          <Button
            onClick={() => {
              setAcknowledged(true);
              onClose();
            }}
            size="sm"
            variant="primary"
          >
            {result.clientSecret ? t('common.savedOneTimeSecret') : t('settings.api.done')}
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
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
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
    <PanelForm onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field htmlFor="oauth-name" label={t('settings.api.oauth.appNameLabel')}>
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
      <fieldset className="flex flex-col gap-1.5">
        <legend className="bt-label">{t('settings.api.oauth.redirectUrisLegend')}</legend>
        {/* A real constraint: which URI forms the server accepts. */}
        <PanelNote>
          {t('settings.api.oauth.redirectUrisHintBefore')}
          <code className="bt-cc-mono">{'myapp://callback'}</code>
          {t('settings.api.oauth.redirectUrisHintAfter')}
        </PanelNote>
        {redirectUris.map((uri, index) => (
          // Index keys are acceptable: the inputs are controlled and the list is
          // only ever appended to / removed from, never reordered.
          <div className="flex items-center gap-2" key={index}>
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
          <Button className="self-start" onClick={addUri} size="sm" variant="quiet">
            {t('settings.api.oauth.addUri')}
          </Button>
        ) : null}
      </fieldset>
      {/* V5-P0b: shared ScopePicker (one row per module, write implies read),
          collapsed by default — already the right popup pattern. The hint is a
          real constraint: these are the words the consent screen shows users.
          `paranoid` drops the module this account can never grant, so a client
          cannot be registered with a scope that would only show up struck
          through in its own row. */}
      <div className="flex flex-col gap-1.5">
        <PanelNote>{t('settings.api.oauth.scopesHint')}</PanelNote>
        <ScopePicker
          collapsible
          legend={t('settings.api.scopesLegend')}
          onChange={setScopes}
          paranoid={paranoid}
          scopes={scopes}
        />
      </div>
      {/* Both lines stay INSIDE the <label>: they are the checkbox's accessible
          name, and the description states the real constraint (no secret is
          issued to a public client). Only the card wrapper is gone. */}
      <label className="flex cursor-pointer items-start gap-2">
        <input
          checked={isPublic}
          className="mt-0.5 h-4 w-4"
          onChange={(e) => setIsPublic(e.target.checked)}
          style={{ accentColor: 'var(--bt-gold)' }}
          type="checkbox"
        />
        <span className="flex flex-col">
          <span className="bt-cc-row__label">{t('settings.api.oauth.publicClientLabel')}</span>
          <span className="bt-cc-row__hint">{t('settings.api.oauth.publicClientDescription')}</span>
        </span>
      </label>
      {/* The panel's single primary action. */}
      <Button
        className="self-start"
        disabled={mutation.isPending}
        size="sm"
        type="submit"
        variant="primary"
      >
        {mutation.isPending
          ? t('settings.api.oauth.registering')
          : t('settings.api.oauth.register')}
      </Button>
    </PanelForm>
  );
}

/** One registered app with a two-step confirm before deletion (cascades its grants). */
function OAuthClientRow({ client }: { client: OAuthClientSummary }) {
  const t = useT();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
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
    <PanelListItem
      actions={
        <>
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
              {t('common.delete')}
            </Button>
          )}
        </>
      }
      main={
        <>
          <span className="flex items-center gap-2">
            <span className="bt-cc-row__label">{client.name}</span>
            <Badge tone={client.public ? 'blue' : 'neutral'}>
              {client.public
                ? t('settings.api.oauth.public')
                : t('settings.api.oauth.confidential')}
            </Badge>
          </span>
          <code className="bt-cc-mono" style={{ color: 'var(--bt-muted)' }}>
            {client.clientId}
          </code>
          <span className="flex flex-wrap gap-1">
            {client.scopes.map((scope) => (
              <ScopeChip
                inactive={paranoid && isParanoidBlockedScope(scope)}
                key={scope}
                scope={scope}
              />
            ))}
          </span>
          {client.redirectUris.map((uri) => (
            <span className="bt-cc-mono" key={uri} style={{ color: 'var(--bt-muted)' }}>
              {uri}
            </span>
          ))}
          <span className="bt-cc-row__hint">
            {t('settings.api.oauth.registeredOn', { createdAt: formatDate(client.createdAt) })}
          </span>
        </>
      }
    />
  );
}

/**
 * Control Center → OAuth apps (PROJECTPLAN.md §6.13, V2-P12; R2 split). The
 * DEVELOPER half of the retired API-access page: register your own third-party
 * clients (`client_secret` shown ONCE), list them, delete them. Deleting an app
 * cascades its grants, so the delete invalidates BOTH the client list and the
 * authorized-apps list that `AuthorizedAppsPanel` reads.
 */
export function OAuthAppsPanel() {
  const t = useT();
  const [registered, setRegistered] = useState<CreateOAuthClientResponse | null>(null);
  const query = useQuery({
    queryKey: OAUTH_CLIENTS_KEY,
    queryFn: ({ signal }) => listOAuthClients(signal),
    staleTime: 15_000,
  });

  const clients = query.data?.clients ?? [];

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.oauthApps')} />

      <PanelGroup label={t('settings.api.oauth.registerTitle')}>
        <Row stack>
          <RegisterOAuthClientForm onCreated={setRegistered} />
        </Row>
      </PanelGroup>

      <PanelGroup label={t('settings.api.oauth.yourApps')}>
        {query.isPending ? (
          <Row stack>
            <Skeleton height="h-16" />
          </Row>
        ) : query.isError ? (
          <Row stack>
            <Alert tone="error">{t('settings.api.oauth.loadError.title')}</Alert>
            <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>
          </Row>
        ) : clients.length === 0 ? (
          <Row stack>
            <PanelNote>{t('settings.api.oauth.empty.title')}</PanelNote>
          </Row>
        ) : (
          <PanelList>
            {clients.map((client) => (
              <OAuthClientRow client={client} key={client.id} />
            ))}
          </PanelList>
        )}
      </PanelGroup>

      {registered ? (
        <OAuthCredentialsModal onClose={() => setRegistered(null)} result={registered} />
      ) : null}
    </div>
  );
}
