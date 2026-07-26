/** The only Google permission BetterTrack's paranoid Drive medium ever asks for. */
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const EXPIRY_SKEW_MS = 30_000;

export type DriveTokenUnavailableReason =
  | 'consent-required'
  | 'token-expired'
  | 'gesture-required'
  | 'offline'
  | 'authorization-failed';

export type DriveAccessTokenResult =
  | { status: 'ok'; accessToken: string; expiresAt: number }
  | { status: 'unavailable'; reason: DriveTokenUnavailableReason; message: string };

export type DriveTokenStatus =
  | { status: 'ready'; expiresAt: number }
  | { status: DriveTokenUnavailableReason };

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(options?: { prompt?: string }): void;
}

interface GisOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback(response: GisTokenResponse): void;
    error_callback?(error: { type?: string }): void;
  }): GisTokenClient;
  revoke(accessToken: string, done?: () => void): void;
}

export interface GoogleIdentityServices {
  accounts: { oauth2: GisOAuth2 };
}

export interface GoogleDriveTokenClientOptions {
  clientId: string;
  google?: GoogleIdentityServices;
  loadGoogle?: () => Promise<GoogleIdentityServices>;
  now?: () => number;
  online?: () => boolean;
}

export interface GoogleDriveTokenClient {
  /** Preload GIS before a later user gesture. No token is requested here. */
  prepare(): Promise<void>;
  /** Return a still-live in-memory token without opening browser UI. */
  token(): Promise<DriveAccessTokenResult>;
  /** Mint a token from an explicit click/tap. */
  authorize(): Promise<DriveAccessTokenResult>;
  /** Forget/revoke the in-memory token. No refresh credential exists. */
  disconnect(): Promise<void>;
  /** Clear a token rejected by Drive without exposing it to callers or logs. */
  invalidate(): void;
  status(): DriveTokenStatus;
}

/**
 * Browser-only Google Identity Services token client. Access tokens exist only
 * inside this closure; no storage API, analytics hook, logger or BetterTrack API
 * is reachable from this module.
 */
export function createGoogleDriveTokenClient(
  options: GoogleDriveTokenClientOptions,
): GoogleDriveTokenClient {
  const now = options.now ?? Date.now;
  const online = options.online ?? (() => globalThis.navigator?.onLine !== false);
  let google = options.google;
  let prepared: Promise<GoogleIdentityServices> | null = null;
  let client: GisTokenClient | null = null;
  let accessToken: string | null = null;
  let expiresAt = 0;
  let everGranted = false;
  let lastUnavailable: DriveTokenUnavailableReason = 'consent-required';
  let pending:
    | {
        resolve: (result: DriveAccessTokenResult) => void;
      }
    | undefined;

  function clear(reason: DriveTokenUnavailableReason): void {
    accessToken = null;
    expiresAt = 0;
    lastUnavailable = reason;
  }

  async function prepareGoogle(): Promise<GoogleIdentityServices> {
    if (google) return google;
    prepared ??= (options.loadGoogle ?? loadGoogleIdentityServices)();
    google = await prepared;
    return google;
  }

  async function prepareClient(): Promise<void> {
    if (client) return;
    const gis = await prepareGoogle();
    client = gis.accounts.oauth2.initTokenClient({
      client_id: options.clientId,
      scope: DRIVE_APPDATA_SCOPE,
      callback(response) {
        const request = pending;
        pending = undefined;
        const ttlSeconds = Number(response.expires_in);
        if (
          response.error ||
          typeof response.access_token !== 'string' ||
          response.access_token.length === 0 ||
          !Number.isFinite(ttlSeconds) ||
          ttlSeconds <= 0
        ) {
          const reason: DriveTokenUnavailableReason =
            response.error === 'access_denied' ? 'consent-required' : 'authorization-failed';
          clear(reason);
          if (reason === 'consent-required') everGranted = false;
          request?.resolve({
            status: 'unavailable',
            reason,
            message: response.error_description ?? 'Google authorization did not complete.',
          });
          return;
        }
        accessToken = response.access_token;
        expiresAt = now() + ttlSeconds * 1000;
        everGranted = true;
        lastUnavailable = 'token-expired';
        request?.resolve({ status: 'ok', accessToken, expiresAt });
      },
      error_callback(error) {
        const request = pending;
        pending = undefined;
        clear('gesture-required');
        request?.resolve({
          status: 'unavailable',
          reason: 'gesture-required',
          message:
            error.type === 'popup_closed'
              ? 'Google authorization was closed.'
              : 'Google authorization needs a user gesture.',
        });
      },
    });
  }

  function liveToken(): Extract<DriveAccessTokenResult, { status: 'ok' }> | null {
    if (accessToken !== null && expiresAt - EXPIRY_SKEW_MS > now()) {
      return { status: 'ok', accessToken, expiresAt };
    }
    if (accessToken !== null) clear('token-expired');
    return null;
  }

  return {
    async prepare() {
      await prepareClient();
    },

    async token() {
      if (!online()) {
        return {
          status: 'unavailable',
          reason: 'offline',
          message: 'Google Drive is unavailable while offline.',
        };
      }
      const current = liveToken();
      if (current) return current;
      const reason: DriveTokenUnavailableReason = everGranted ? 'token-expired' : lastUnavailable;
      return {
        status: 'unavailable',
        reason,
        message:
          reason === 'token-expired'
            ? 'The Google Drive access token expired.'
            : 'Google Drive consent is required.',
      };
    },

    async authorize() {
      if (!online()) {
        return {
          status: 'unavailable',
          reason: 'offline',
          message: 'Google Drive is unavailable while offline.',
        };
      }
      const current = liveToken();
      if (current) return current;
      await prepareClient();
      if (pending) {
        return {
          status: 'unavailable',
          reason: 'gesture-required',
          message: 'Google authorization is already waiting for a user gesture.',
        };
      }
      return new Promise<DriveAccessTokenResult>((resolve) => {
        pending = { resolve };
        client!.requestAccessToken({ prompt: everGranted ? '' : 'consent' });
      });
    },

    async disconnect() {
      const token = accessToken;
      clear('consent-required');
      everGranted = false;
      if (!token || !google) return;
      await new Promise<void>((resolve) => google!.accounts.oauth2.revoke(token, resolve));
    },

    invalidate() {
      clear('token-expired');
      everGranted = true;
    },

    status() {
      const current = liveToken();
      return current
        ? { status: 'ready', expiresAt: current.expiresAt }
        : { status: everGranted ? 'token-expired' : lastUnavailable };
    },
  };
}

export function googleDriveClientId(): string | null {
  const value = import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID?.trim();
  return value ? value : null;
}

let scriptPromise: Promise<GoogleIdentityServices> | null = null;

function loadGoogleIdentityServices(): Promise<GoogleIdentityServices> {
  const existing = googleFromWindow();
  if (existing) return Promise.resolve(existing);
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Google Identity Services requires a browser.'));
  }
  scriptPromise ??= new Promise((resolve, reject) => {
    const prior = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_URL}"]`);
    const script = prior ?? document.createElement('script');
    const loaded = () => {
      const gis = googleFromWindow();
      if (gis) resolve(gis);
      else reject(new Error('Google Identity Services did not initialize.'));
    };
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Google Identity Services could not load.')),
      { once: true },
    );
    if (!prior) {
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  });
  return scriptPromise;
}

function googleFromWindow(): GoogleIdentityServices | null {
  const candidate = (globalThis as { google?: GoogleIdentityServices }).google;
  return candidate?.accounts?.oauth2 ? candidate : null;
}
