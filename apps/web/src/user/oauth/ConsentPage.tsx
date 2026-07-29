import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useMutation, useQuery } from '@tanstack/react-query';

import { Wordmark } from '../../components/Wordmark';
import { useT } from '../../i18n';
import { ApiError, apiAssetUrl } from '../../lib/apiClient';
import {
  approveAuthorization,
  getAuthorizationDetails,
  type OAuthAuthorizeParams,
} from '../../lib/oauthApi';
import { ScopeSummary } from '../../ui';
import { useAuth } from '../AuthContext';
import { Alert, Button, Spinner } from '../components/ui';

/**
 * OAuth consent screen (PROJECTPLAN.md §6.13 part 2, V4-P2b). A third-party app
 * sends the browser here with a standard authorization-code request; the user
 * confirms which account they're signed in as and — for third-party clients —
 * reviews the requested scopes in plain language before Approving or Cancelling.
 *
 * V4-P2b account-chooser interpose (owner directive 2026-07-07): the authorize
 * page ALWAYS interposes "signed in as X — Continue / Use another account",
 * including first-party auto-approve clients. Android Custom Tabs share the
 * browser session, so silently reusing whoever is signed in the browser would
 * open the mobile app as an account the user never picked. Auto-approve still
 * skips the scope prompt for first-party clients — it never skips this
 * confirmation.
 *
 * This route sits inside `RequireUser`, so the login-then-consent flow is free:
 * an anonymous visitor is bounced to `/login` with the full `/oauth/authorize?…`
 * URL (path **and** query) stashed in `state.from`, and after signing in the
 * login page returns them here with `state` + PKCE (`code_challenge`) intact.
 * "Use another account" is logout → the same login round-trip, so the untouched
 * authorize query survives the switch. The PIN gate (above routing) also
 * applies with no special-casing.
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

/**
 * Centered, standalone card scaffold (this screen sits outside the app chrome),
 * built on the Origin gate. Widened past the 400px auth default because consent
 * carries an app identity, a scope list and a redirect URI.
 */
function ConsentShell({ children }: { children: ReactNode }) {
  return (
    <div className="bt-app bt-gate">
      <div className="bt-gate__card" style={{ width: 'min(480px, 100%)' }}>
        <div className="bt-gate__brand text-center">
          <Wordmark edition="Web" />
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The requesting app's identity on the consent screen: a first-party (official)
 * app shows the BetterTrack mark + an "Official app" badge; a third-party app
 * shows its server-cached logo (when set) or a lettered placeholder.
 */
function AppIdentity({
  name,
  logoPath,
  firstParty,
}: {
  name: string;
  logoPath: string | null;
  firstParty: boolean;
}) {
  const t = useT();
  const [logoFailed, setLogoFailed] = useState(false);
  const logoUrl = logoPath && !logoFailed ? apiAssetUrl(logoPath) : null;
  return (
    <div className="flex items-center gap-3">
      {firstParty ? (
        <div
          className="grid h-12 w-12 shrink-0 place-items-center rounded-lg text-base font-bold"
          style={{
            background: 'var(--bt-gold-soft)',
            border: '1px solid var(--bt-border-accent)',
            color: 'var(--bt-gold)',
          }}
        >
          {t('auth.oauthConsent.logoBadge')}
        </div>
      ) : logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="h-12 w-12 shrink-0 rounded-lg object-cover"
          style={{ border: '1px solid var(--bt-border-strong)' }}
          onError={() => setLogoFailed(true)}
        />
      ) : (
        <div
          className="bt-soft grid h-12 w-12 shrink-0 place-items-center rounded-lg text-lg font-semibold"
          style={{
            background: 'var(--bt-surface-strong)',
            border: '1px solid var(--bt-border-strong)',
          }}
        >
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="bt-h3 truncate">{name}</div>
        {firstParty ? (
          <div className="bt-gold text-xs font-medium">{t('auth.oauthConsent.firstParty')}</div>
        ) : (
          <div className="bt-row-sub">{t('auth.oauthConsent.thirdParty')}</div>
        )}
      </div>
    </div>
  );
}

export function ConsentPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const [cancelled, setCancelled] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

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

  // "Use another account" — end this session, then land on /login carrying the
  // ORIGINAL untouched authorize URL as the return target so the #419 chooser
  // ladder picks up from there and, on a successful login, comes right back
  // to this same authorize request (PKCE + state intact).
  async function handleUseAnotherAccount() {
    if (switching) return;
    setSwitching(true);
    const returnTo = `${location.pathname}${location.search}`;
    try {
      await logout();
    } catch {
      // logout() already clears the local session on any error path — proceed.
    }
    navigate('/login', { state: { from: returnTo }, replace: true });
  }

  // ── Malformed request: missing a required param, so we can't even ask. ──
  if (params == null) {
    return (
      <ConsentShell>
        <div>
          <Alert tone="error">{t('auth.oauthConsent.invalidRequest')}</Alert>
        </div>
      </ConsentShell>
    );
  }

  // ── User declined: no code is issued; we do NOT touch redirect_uri. ──
  if (cancelled) {
    return (
      <ConsentShell>
        <div className="flex flex-col gap-4">
          <h1 className="bt-h2">{t('auth.oauthConsent.cancelledTitle')}</h1>
          <p className="bt-muted text-sm">{t('auth.oauthConsent.cancelledBody')}</p>
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
        <div className="grid place-items-center py-6">
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
        <div>
          <Alert tone="error">{message}</Alert>
        </div>
      </ConsentShell>
    );
  }

  const details = query.data;
  // The signed-in username is the identity the app is about to be authorized as
  // — this component only ever renders under RequireUser, so `user` is set. The
  // fallback keeps TypeScript happy without leaking anything if it ever wasn't.
  const username = user?.username ?? '';
  const signedInAs = t('auth.oauthConsent.signedInAs', { username });

  // ── First-party (official) app: trusted, no scope prompt — but the account
  // confirmation is still interposed (V4-P2b, owner 2026-07-07). ──
  if (details.client.firstParty) {
    return (
      <ConsentShell>
        <div className="flex flex-col gap-5">
          {approveError ? <Alert tone="error">{approveError}</Alert> : null}
          <AppIdentity name={details.client.name} logoPath={null} firstParty />
          <p className="bt-muted text-sm">{signedInAs}</p>
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button
              className="sm:flex-1"
              disabled={approve.isPending || switching}
              onClick={() => {
                setApproveError(null);
                approve.mutate();
              }}
            >
              {approve.isPending
                ? t('auth.oauthConsent.authorizing')
                : t('auth.oauthConsent.continue')}
            </Button>
            <Button
              variant="secondary"
              className="sm:flex-1"
              disabled={approve.isPending || switching}
              onClick={() => void handleUseAnotherAccount()}
            >
              {t('auth.oauthConsent.useAnotherAccount')}
            </Button>
          </div>
        </div>
      </ConsentShell>
    );
  }

  // ── Third-party app: show who's asking, the signed-in account, and the
  // scopes; Approve doubles as Continue and Cancel/Use another account sit
  // alongside (V4-P2b). ──
  return (
    <ConsentShell>
      <div className="flex flex-col gap-5">
        {approveError ? <Alert tone="error">{approveError}</Alert> : null}
        <AppIdentity
          name={details.client.name}
          logoPath={details.client.logoPath}
          firstParty={false}
        />
        <p className="bt-muted text-sm">{signedInAs}</p>
        <p className="bt-muted text-sm">
          <span className="bt-soft font-medium">{details.client.name}</span>{' '}
          {t('auth.oauthConsent.wantsAccess')}
        </p>

        {/* V5-P0b: grouped by module so a user reads permissions as coherent
            groups (Portfolio, Social, …) instead of a flat run of lines. */}
        <ScopeSummary items={details.scopes} />

        <p className="bt-muted break-all text-xs">
          {t('auth.oauthConsent.returnedTo')}{' '}
          <code className="bt-soft font-mono">{details.redirectUri}</code>
          {t('auth.oauthConsent.revokeHint')}
        </p>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            className="sm:flex-1"
            disabled={approve.isPending || switching}
            onClick={() => {
              setApproveError(null);
              approve.mutate();
            }}
          >
            {approve.isPending
              ? t('auth.oauthConsent.authorizing')
              : t('auth.oauthConsent.approve')}
          </Button>
          <Button
            variant="secondary"
            className="sm:flex-1"
            disabled={approve.isPending || switching}
            onClick={() => setCancelled(true)}
          >
            {t('common.cancel')}
          </Button>
        </div>
        <button
          type="button"
          className="bt-btn bt-btn--quiet"
          disabled={approve.isPending || switching}
          onClick={() => void handleUseAnotherAccount()}
        >
          {t('auth.oauthConsent.useAnotherAccount')}
        </button>
      </div>
    </ConsentShell>
  );
}
