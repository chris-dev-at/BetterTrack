/** Legacy envelope-v1 appdata scope; retained until its retirement train. */
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
/** Per-vault visible-folder access used by envelope-v2 Drive connections. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const TOKEN_EXPIRY_SKEW_MS = 30_000;

export type DriveAuthorizationState =
  | 'consent-required'
  | 'connected'
  | 'token-expired'
  | 'gesture-required';

export type DriveAccessTokenResult =
  | { status: 'ok'; accessToken: string; expiresAt: number }
  | {
      status: Exclude<DriveAuthorizationState, 'connected'>;
      message: string;
    };

export interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface GoogleTokenClient {
  requestAccessToken(options?: {
    prompt?: string;
    scope?: string;
    include_granted_scopes?: boolean;
  }): void;
}

export interface GoogleOauth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    include_granted_scopes: boolean;
    /** GIS names the OAuth login_hint field `hint` in its web API. */
    hint?: string;
    login_hint?: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): GoogleTokenClient;
}

export interface GoogleDriveTokenClientOptions {
  clientId: string;
  /** Defaults to the legacy appdata scope; per-vault readers pass drive.file. */
  scope?: string;
  /** Stable Google principal and local-only label for one bound connection. */
  loginHint?: string;
  identityLabel?: string;
  loadOauth2?: () => Promise<GoogleOauth2>;
  now?: () => number;
}

export interface GoogleDriveTokenClient {
  readonly state: DriveAuthorizationState;
  /** Synchronous and side-effect free; never opens a popup on its own. */
  getAccessToken(): DriveAccessTokenResult;
  /** Observe authorization transitions, including browser-memory token expiry. */
  subscribe(listener: () => void): () => void;
  /** Must be called from a user gesture. Tokens remain only in this closure. */
  authorize(): Promise<DriveAccessTokenResult>;
  /** Drop the in-memory capability immediately. */
  clear(): void;
  markExpired(): void;
}

/**
 * Google Identity Services token client for Drive appdata. It deliberately has
 * no storage adapter: access tokens and expiry live only in this closure and
 * are never serialized, logged, analyzed, or sent to the BetterTrack API.
 */
export function createGoogleDriveTokenClient(
  options: GoogleDriveTokenClientOptions,
): GoogleDriveTokenClient {
  const scope = options.scope ?? DRIVE_APPDATA_SCOPE;
  const now = options.now ?? Date.now;
  const loadOauth2 = options.loadOauth2 ?? loadGoogleOauth2;
  let state: DriveAuthorizationState = 'consent-required';
  let token: { accessToken: string; expiresAt: number } | null = null;
  let oauth2ClientPromise: Promise<GoogleOauth2> | null = null;
  let authorizationGeneration = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: {
    generation: number;
    promise: Promise<DriveAccessTokenResult>;
    resolve: (result: DriveAccessTokenResult) => void;
  } | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function clearExpiryTimer(): void {
    if (expiryTimer == null) return;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  function replaceState(next: DriveAuthorizationState): void {
    const changed = state !== next;
    state = next;
    if (changed) notify();
  }

  function expireToken(): void {
    const changed = token != null || state !== 'token-expired';
    token = null;
    clearExpiryTimer();
    state = 'token-expired';
    if (changed) notify();
  }

  function scheduleExpiry(expiresAt: number): void {
    clearExpiryTimer();
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        if (token?.expiresAt === expiresAt) expireToken();
      },
      Math.max(0, expiresAt - TOKEN_EXPIRY_SKEW_MS - now()),
    );
  }

  function currentToken(): DriveAccessTokenResult {
    if (token && token.expiresAt - TOKEN_EXPIRY_SKEW_MS > now()) {
      return { status: 'ok', ...token };
    }
    if (token) expireToken();
    const identity = options.identityLabel?.trim();
    return {
      status: state === 'connected' ? 'token-expired' : state,
      message:
        state === 'consent-required'
          ? 'Google Drive consent is required.'
          : identity
            ? `Sign in to Google (${identity}) to continue Drive synchronization.`
            : 'Sign in to Google to continue Drive synchronization.',
    };
  }

  function finish(generation: number, result: DriveAccessTokenResult): void {
    if (pending?.generation !== generation) return;
    const resolve = pending.resolve;
    pending = null;
    resolve(result);
  }

  function cancelPending(result: DriveAccessTokenResult): void {
    authorizationGeneration += 1;
    const active = pending;
    pending = null;
    active?.resolve(result);
  }

  function handleResponse(generation: number, response: GoogleTokenResponse): void {
    if (pending?.generation !== generation) return;
    if (
      typeof response.access_token === 'string' &&
      response.access_token.length > 0 &&
      typeof response.expires_in === 'number' &&
      response.expires_in > 0
    ) {
      token = {
        accessToken: response.access_token,
        expiresAt: now() + response.expires_in * 1_000,
      };
      replaceState('connected');
      scheduleExpiry(token.expiresAt);
      finish(generation, { status: 'ok', ...token });
      return;
    }

    token = null;
    clearExpiryTimer();
    const nextState =
      response.error === 'access_denied' || response.error === 'consent_required'
        ? 'consent-required'
        : 'gesture-required';
    replaceState(nextState);
    finish(generation, {
      status: nextState,
      message:
        response.error_description ??
        (nextState === 'consent-required'
          ? 'Google Drive consent is required.'
          : 'A user gesture is required to sign in to Google Drive.'),
    });
  }

  function handlePopupError(generation: number, error: { type?: string; message?: string }): void {
    if (pending?.generation !== generation) return;
    token = null;
    clearExpiryTimer();
    replaceState('gesture-required');
    finish(generation, {
      status: 'gesture-required',
      message: error.message ?? 'Google sign-in needs a new user gesture.',
    });
  }

  return {
    get state() {
      if (token && token.expiresAt - TOKEN_EXPIRY_SKEW_MS <= now()) return 'token-expired';
      return state === 'connected' && token == null ? 'token-expired' : state;
    },

    getAccessToken: currentToken,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async authorize() {
      const existing = currentToken();
      if (existing.status === 'ok') return existing;
      if (pending) return pending.promise;

      const generation = ++authorizationGeneration;
      let resolvePending!: (result: DriveAccessTokenResult) => void;
      const promise = new Promise<DriveAccessTokenResult>((resolve) => {
        resolvePending = resolve;
      });
      pending = { generation, promise, resolve: resolvePending };

      let oauth2: GoogleOauth2;
      try {
        oauth2ClientPromise ??= loadOauth2();
        oauth2 = await oauth2ClientPromise;
      } catch {
        oauth2ClientPromise = null;
        if (pending?.generation !== generation) return promise;
        replaceState('gesture-required');
        finish(generation, {
          status: 'gesture-required',
          message: 'Google sign-in could not be loaded. Try again.',
        });
        return promise;
      }

      if (pending?.generation !== generation) return promise;

      try {
        const client: GoogleTokenClient = oauth2.initTokenClient({
          client_id: options.clientId,
          scope,
          include_granted_scopes: false,
          ...(options.loginHint ? { hint: options.loginHint, login_hint: options.loginHint } : {}),
          callback: (response) => handleResponse(generation, response),
          error_callback: (error) => handlePopupError(generation, error),
        });
        client.requestAccessToken({
          prompt: state === 'consent-required' ? 'consent' : '',
          scope,
          include_granted_scopes: false,
        });
      } catch (cause) {
        if (pending?.generation !== generation) return promise;
        replaceState('gesture-required');
        finish(generation, {
          status: 'gesture-required',
          message:
            cause instanceof Error ? cause.message : 'Google sign-in needs a new user gesture.',
        });
      }
      return promise;
    },

    clear() {
      token = null;
      clearExpiryTimer();
      replaceState('consent-required');
      cancelPending({
        status: 'gesture-required',
        message: 'Google sign-in was cancelled.',
      });
    },

    markExpired() {
      cancelPending({
        status: 'token-expired',
        message: 'Sign in to Google to continue Drive synchronization.',
      });
      expireToken();
    },
  };
}

let oauth2Promise: Promise<GoogleOauth2> | null = null;

async function loadGoogleOauth2(): Promise<GoogleOauth2> {
  const existing = window.google?.accounts?.oauth2;
  if (existing) return existing;

  if (oauth2Promise) return oauth2Promise;

  const attempt = new Promise<GoogleOauth2>((resolve, reject) => {
    const loaded = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_SRC}"]`);
    const script = loaded ?? document.createElement('script');
    const cleanup = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else reject(new Error('Google Identity Services did not expose the OAuth token client.'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('Google Identity Services could not be loaded.'));
    };
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
    if (!loaded) {
      script.src = GIS_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  });
  const recoverable = attempt.catch((cause) => {
    if (oauth2Promise === recoverable) oauth2Promise = null;
    document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_SRC}"]`)?.remove();
    throw cause;
  });
  oauth2Promise = recoverable;
  return oauth2Promise;
}
