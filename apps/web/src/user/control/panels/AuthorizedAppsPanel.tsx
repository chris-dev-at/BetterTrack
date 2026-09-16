import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { OAUTH_SCOPE_LABELS, type OAuthGrantSummary } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDate } from '../../../lib/format';
import { localizedOAuthScopeDescription } from '../../../lib/oauthScopeCopy';
import { listOAuthGrants, revokeOAuthGrant } from '../../../lib/oauthApi';
import { Skeleton } from '../../../ui';
import { isParanoidBlockedScope } from '../../../ui/ScopePicker';
import { Badge, Button } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { useResolvedPrivacyMode } from '../../vault/usePrivacyMode';
import { PanelGroup, PanelHead, PanelList, PanelListItem, PanelNote, Row } from './panelKit';

const OAUTH_GRANTS_KEY = ['settings', 'oauth-grants'] as const;

/** One authorized app (grant) with a two-step confirm before revoking access. */
function OAuthGrantRow({ grant }: { grant: OAuthGrantSummary }) {
  const t = useT();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
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
              {t('settings.api.grants.revokeAccess')}
            </Button>
          )}
        </>
      }
      main={
        <>
          <span className="bt-cc-row__label">
            <span>{grant.appName}</span>
            {grant.firstParty ? (
              <Badge className="ml-2" tone="blue">
                {t('settings.api.grants.firstPartyBadge')}
              </Badge>
            ) : null}
            {/* The separating space is emitted HERE, not carried as a leading
                space inside the catalog value (#1473): an invisible significant
                space in JSON is a plausible casualty of a translator tool or a
                "trim the strings" edit, which would render "Charting Buddycan:". */}{' '}
            <span>{t('settings.api.grants.canAccess')}</span>
          </span>
          {/* The plain-language scope descriptions, not the raw scope strings —
              this is a privacy control, so it reads in the user's words. A
              scope this privacy mode refuses is MARKED, never dropped (the
              `ApiKeysPanel.ScopeChip` rule): the grant really does carry it and
              it goes live again the moment paranoid mode is disabled, so a
              shortened list would understate what the app was allowed. */}
          <ul className="flex flex-col">
            {grant.scopes.map((scope) => {
              const inactive = paranoid && isParanoidBlockedScope(scope);
              return (
                <li className="bt-cc-row__hint" key={scope}>
                  ·{' '}
                  <span className={inactive ? 'line-through opacity-70' : undefined}>
                    {localizedOAuthScopeDescription(t, scope, OAUTH_SCOPE_LABELS[scope])}
                  </span>
                  {inactive ? <span> ({t('settings.api.keys.scopeInactive')})</span> : null}
                </li>
              );
            })}
          </ul>
          <span className="bt-cc-row__hint">
            {grant.lastUsedAt
              ? t('settings.api.grants.authorizedLastUsed', {
                  createdAt: formatDate(grant.createdAt),
                  lastUsedAt: formatDate(grant.lastUsedAt),
                })
              : t('settings.api.grants.authorizedNeverUsed', {
                  createdAt: formatDate(grant.createdAt),
                })}
          </span>
        </>
      }
    />
  );
}

/**
 * Control Center → Authorized apps (PROJECTPLAN.md §6.13, V2-P12; R2 split).
 * The PRIVACY half of the retired API-access page: which apps can reach YOUR
 * account, what each may do (in the words the consent screen used),
 * and one two-step revoke that kills its tokens immediately.
 *
 * The group label would only restate the panel head ("Authorized apps"), so the
 * list is an unlabelled ruled run — `PanelGroup` without a `label`.
 */
export function AuthorizedAppsPanel() {
  const t = useT();
  const query = useQuery({
    queryKey: OAUTH_GRANTS_KEY,
    queryFn: ({ signal }) => listOAuthGrants(signal),
    staleTime: 15_000,
  });

  const grants = query.data?.grants ?? [];

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.authorizedApps')} />
      {/* Kept prose: revoking is immediate and the app must be re-authorized. */}
      <PanelNote>{t('settings.api.grants.sectionDescription')}</PanelNote>

      <PanelGroup>
        {query.isPending ? (
          <Row stack>
            <Skeleton height="h-16" />
          </Row>
        ) : query.isError ? (
          <Row stack>
            <Alert tone="error">{t('settings.api.grants.loadError.title')}</Alert>
            <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>
          </Row>
        ) : grants.length === 0 ? (
          <Row stack>
            <PanelNote>{t('settings.api.grants.empty.title')}</PanelNote>
          </Row>
        ) : (
          <PanelList>
            {grants.map((grant) => (
              <OAuthGrantRow grant={grant} key={grant.id} />
            ))}
          </PanelList>
        )}
      </PanelGroup>
    </div>
  );
}
