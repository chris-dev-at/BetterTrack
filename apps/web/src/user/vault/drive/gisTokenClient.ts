/** The only Google Drive permission BetterTrack may ever request. */
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
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
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): GoogleTokenClient;
}

export interface GoogleDriveTokenClientOptions {
  clientId: string;
  loadOauth2?: () => Promise<GoogleOauth2>;
  now?: () => number;
}

export interface GoogleDriveTokenClient {
  readonly state: DriveAuthorizationState;
  /** Synchronous and side-effect free; never attempts a popup on its own. */
  getAccessToken(): DriveAccessTokenResult;
  /** Must be called from a user gesture. Tokens remain only in this closure. */
  authorize(): Promise<DriveAccessTokenResult>;
  /** Drop the in-memory capability immediately. */
  clear(): void;
  markExpired(): void;
}

/**
 * Google Identity Services token client for Drive appdata. It deliberately has
 * no storage adapter: access tokens and expiry live only in this closure and
 * are never serialized, logged, analyzed or sent to the BetterTrack API.
 */
export function createGoogleDriveTokenClient(
  options: GoogleDriveTokenClientOptions,
): GoogleDriveTokenClient {
  const now = options.now ?? Date.now;
  const loadOauth2 = options.loadOauth2 ?? loadGoogleOauth2;
  let state: DriveAuthorizationState = 'consent-required';
  let token: { accessToken: string; expiresAt: number } | null = null;
  let clientPromise: Promise<GoogleTokenClient> | null = null;
  let pending:
    | {
        resolve: (result: DriveAccessTokenResult) => void;
      }
    | undefined;

  async function client(): Promise<GoogleTokenClient> {
    clientPromise ??= loadOauth2().then((oauth2) =>
      oauth2.initTokenClient({
        client_id: options.clientId,
        scope: DRIVE_APPDATA_SCOPE,
        include_granted_scopes: false,
        callback: handleResponse,
        error_callback: handlePopupError,
      }),
    );
    return clientPromise;
  }

  function finish(result: DriveAccessTokenResult): void {
    const waiting = pending;
    pending = undefined;
    waiting?.resolve(result);
  }

  function handleResponse(response: GoogleTokenResponse): void {
    if (
      typeof response.access_token === 'string' &&
      response.access_token.length > 0 &&
      typeof response.expires_in === 'number' &&
      response.expires_in > 0
    ) {
      token = {
        accessToken: response.access_token,
        expiresAt: now() + response.expires_in * 1000,
      };
      state = 'connected';
      finish({ status: 'ok', ...token });
      return;
    }

    token = null;
    state =
      response.error === 'access_denied' || response.error === 'consent_required'
        ? 'consent-required'
        : 'gesture-required';
    finish({
      status: state,
      message:
        response.error_description ??
        (state === 'consent-required'
          ? 'Google Drive consent is required.'
          : 'A user gesture is required to sign in to Google Drive.'),
    });
  }

  function handlePopupError(error: { type?: string; message?: string }): void {
    token = null;
    state = 'gesture-required';
    finish({
      status: 'gesture-required',
      message: error.message ?? 'Google sign-in needs a new user gesture.',
    });
  }

  return {
    get state() {
      if (token && token.expiresAt - TOKEN_EXPIRY_SKEW_MS <= now()) {
        token = null;
        state = 'token-expired';
      }
      return state;
    },

    getAccessToken() {
      if (token && token.expiresAt - TOKEN_EXPIRY_SKEW_MS > now()) {
        return { status: 'ok', ...token };
      }
      if (token) {
        token = null;
        state = 'token-expired';
      }
      return {
        status: state === 'connected' ? 'token-expired' : state,
        message:
          state === 'consent-required'
            ? 'Google Drive consent is required.'
            : 'Sign in to Google to continue Drive synchronization.',
      };
    },

    async authorize() {
      if (pending) {
        return {
          status: 'gesture-required',
          message: 'Google sign-in is already in progress.',
        };
      }
      const tokenClient = await client();
      const result = new Promise<DriveAccessTokenResult>((resolve) => {
        pending = { resolve };
      });
      tokenClient.requestAccessToken({
        prompt: state === 'consent-required' ? 'consent' : '',
        scope: DRIVE_APPDATA_SCOPE,
        include_granted_scopes: false,
      });
      return result;
    },

    clear() {
      token = null;
      state = 'consent-required';
    },

    markExpired() {
      token = null;
      state = 'token-expired';
    },
  };
}

let oauth2Promise: Promise<GoogleOauth2> | null = null;

async function loadGoogleOauth2(): Promise<GoogleOauth2> {
  const existing = window.google?.accounts?.oauth2;
  if (existing) return existing;
  oauth2Promise ??= new Promise<GoogleOauth2>((resolve, reject) => {
    const loaded = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_SRC}"]`);
    const script = loaded ?? document.createElement('script');
    const onLoad = () => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else reject(new Error('Google Identity Services did not expose the OAuth token client.'));
    };
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Google Identity Services could not be loaded.')),
      { once: true },
    );
    if (!loaded) {
      script.src = GIS_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  });
  return oauth2Promise;
}
