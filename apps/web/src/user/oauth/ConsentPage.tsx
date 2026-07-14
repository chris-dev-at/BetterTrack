import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useMutation, useQuery } from '@tanstack/react-query';

import { Wordmark } from '../../components/Wordmark';
import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import {
  approveAuthorization,
  getAuthorizationDetails,
  type OAuthAuthorizeParams,
} from '../../lib/oauthApi';
import { Alert, Button, Spinner } from '../components/ui';

/**
 * OAuth consent screen (PROJECTPLAN.md §6.13 part 2). A third-party app sends the
 * browser here with a standard authorization-code request; the user reviews the
 * app and the requested scopes in plain language and Approves or Cancels.
 *
 * This route sits inside `RequireUser`, so the login-then-consent flow is free:
 * an anonymous visitor is bounced to `/login` with the full `/oauth/authorize?…`
 * URL (path **and** query) stashed in `state.from`, and after signing in the
 * login page returns them here with `state` + PKCE (`code_challenge`) intact. The
 * PIN gate (above routing) also applies with no special-casing.
 *
 * Security posture (§10): we NEVER navigate to `redirect_uri` on our own. An
 * invalid/unknown client or a bad redirect URI is a 400 from the details
 * endpoint and is rendered as an inline error — the browser only ever reaches
 * the redirect URI via the service-signed `redirectTo` returned by an explicit
 * Approve.
 */

/** Pull the OAuth authorize params off the URL, or null if a required one is absent. */
function readParams(sp: URLSearchParams): OAuthAuthorizeParams | null {
  const clientId = sp.get('client_id');
  const redirectUri = sp.get('redirect_uri');
  const scope = sp.get('scope');
  if (!clientId || !redirectUri || !scope) return null;

  const params: OAuthAuthorizeParams = {
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
  };
  const responseType = sp.get('response_type');
  if (responseType) params.response_type = responseType;
  const state = sp.get('state');
  if (state !== null) params.state = state;
  const codeChallenge = sp.get('code_challenge');
  if (codeChallenge) params.code_challenge = codeChallenge;
  const codeChallengeMethod = sp.get('code_challenge_method');
  if (codeChallengeMethod) params.code_challenge_method = codeChallengeMethod;
  return params;
}

/** Centered, standalone card scaffold (this screen sits outside the app chrome). */
function ConsentShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0b0e14] px-4 pb-12 pt-[10vh] sm:pt-[14vh]">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <Wordmark edition="Web" className="text-2xl" />
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The requesting app's identity on the consent screen: a first-party (official)
 * app shows the BetterTrack mark + an "Official app" badge; a third-party app
 * shows its own logo (when set) or a lettered placeholder.
 */
function AppIdentity({
  name,
  logoUrl,
  firstParty,
}: {
  name: string;
  logoUrl: string | null;
  firstParty: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      {firstParty ? (
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-sky-500/15 text-base font-bold text-sky-300 ring-1 ring-sky-500/40">
          {t('auth.oauthConsent.logoBadge')}
        </div>
      ) : logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="h-12 w-12 rounded-xl object-cover ring-1 ring-neutral-700"
        />
      ) : (
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-neutral-800 text-lg font-semibold text-neutral-300 ring-1 ring-neutral-700">
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate font-semibold text-neutral-100">{name}</div>
        {firstParty ? (
          <div className="text-xs font-medium text-sky-400">{t('auth.oauthConsent.firstParty')}</div>
        ) : (
          <div className="text-xs text-neutral-500">{t('auth.oauthConsent.thirdParty')}</div>
        )}
      </div>
    </div>
  );
}

export function ConsentPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [cancelled, setCancelled] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Memoized on the raw query string so PKCE/state are carried verbatim and the
  // details query isn't refetched on unrelated re-renders.
  const search = searchParams.toString();
  const params = useMemo(() => readParams(new URLSearchParams(search)), [search]);

  const query = useQuery({
    queryKey: ['oauth', 'authorization-details', search],
    queryFn: ({ signal }) => getAuthorizationDetails(params as OAuthAuthorizeParams, signal),
    enabled: params != null && !cancelled,
    retry: false,
  });

  const approve = useMutation({
    mutationFn: () => approveAuthorization(params as OAuthAuthorizeParams),
    onSuccess: (result) => {
      // Works for https and custom-scheme deep links (myapp://callback). The
      // service validated and signed this destination — never a raw redirect_uri.
      window.location.href = result.redirectTo;
    },
    onError: () => setApproveError(t('auth.oauthConsent.approveError')),
  });

  // A trusted first-party (official) app skips the scope-approval prompt: as soon
  // as the (validated) details load, auto-approve exactly once and redirect back.
  // The user is already authenticated here (RequireUser), so this is just the
  // "Login with BetterTrack" moment — no consent to click.
  const autoApproved = useRef(false);
  const isFirstParty = query.data?.client.firstParty ?? false;
  useEffect(() => {
    if (isFirstParty && !autoApproved.current && !cancelled && !approveError) {
      autoApproved.current = true;
      approve.mutate();
    }
  }, [isFirstParty, cancelled, approveError, approve]);

  // ── Malformed request: missing a required param, so we can't even ask. ──
  if (params == null) {
    return (
      <ConsentShell>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Alert tone="error">{t('auth.oauthConsent.invalidRequest')}</Alert>
        </div>
      </ConsentShell>
    );
  }

  // ── User declined: no code is issued; we do NOT touch redirect_uri. ──
  if (cancelled) {
    return (
      <ConsentShell>
        <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="text-lg font-semibold text-neutral-100">{t('auth.oauthConsent.cancelledTitle')}</h1>
          <p className="text-sm text-neutral-400">{t('auth.oauthConsent.cancelledBody')}</p>
          <Button onClick={() => navigate('/', { replace: true })}>
            {t('auth.oauthConsent.goToApp')}
          </Button>
        </div>
      </ConsentShell>
    );
  }

  if (query.isPending) {
    return (
      <ConsentShell>
        <div className="grid place-items-center rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Spinner label={t('auth.oauthConsent.loading')} />
        </div>
      </ConsentShell>
    );
  }

  // ── Bad request (unknown client / bad redirect_uri) or transient failure. ──
  if (query.isError) {
    const err = query.error;
    const message =
      err instanceof ApiError && err.status === 400
        ? t('auth.oauthConsent.badClient')
        : t('auth.oauthConsent.loadError');
    return (
      <ConsentShell>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <Alert tone="error">{message}</Alert>
        </div>
      </ConsentShell>
    );
  }

  const details = query.data;

  // ── First-party (official) app: trusted, no scope prompt — just sign in. ──
  if (details.client.firstParty) {
    return (
      <ConsentShell>
        <div className="flex flex-col gap-5 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          {approveError ? <Alert tone="error">{approveError}</Alert> : null}
          <AppIdentity name={details.client.name} logoUrl={null} firstParty />
          {approveError ? (
            <Button
              onClick={() => {
                setApproveError(null);
                autoApproved.current = true;
                approve.mutate();
              }}
            >
              {t('common.continue')}
            </Button>
          ) : (
            <div className="flex items-center gap-3 text-sm text-neutral-400">
              <Spinner label={t('auth.oauthConsent.signingIn', { name: details.client.name })} />
            </div>
          )}
        </div>
      </ConsentShell>
    );
  }

  // ── Third-party app: show who's asking + the scopes, and ask to approve. ──
  return (
    <ConsentShell>
      <div className="flex flex-col gap-5 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        {approveError ? <Alert tone="error">{approveError}</Alert> : null}
        <AppIdentity
          name={details.client.name}
          logoUrl={details.client.logoUrl}
          firstParty={false}
        />
        <p className="text-sm text-neutral-400">
          <span className="font-medium text-neutral-200">{details.client.name}</span>{' '}
          {t('auth.oauthConsent.wantsAccess')}
        </p>

        <ul className="flex flex-col gap-2">
          {details.scopes.map(({ scope, label }) => (
            <li
              key={scope}
              className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
            >
              <span aria-hidden="true" className="mt-0.5 text-sky-400">
                ✓
              </span>
              <span>{label}</span>
            </li>
          ))}
        </ul>

        <p className="break-all text-xs text-neutral-500">
          {t('auth.oauthConsent.returnedTo')}{' '}
          <code className="font-mono text-neutral-400">{details.redirectUri}</code>
          {t('auth.oauthConsent.revokeHint')}
        </p>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            className="sm:flex-1"
            disabled={approve.isPending}
            onClick={() => {
              setApproveError(null);
              approve.mutate();
            }}
          >
            {approve.isPending ? t('auth.oauthConsent.authorizing') : t('auth.oauthConsent.approve')}
          </Button>
          <Button
            variant="secondary"
            className="sm:flex-1"
            disabled={approve.isPending}
            onClick={() => setCancelled(true)}
          >
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </ConsentShell>
  );
}
