/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Git commit the web bundle was built from — baked in at build time by the
   * Docker build (the `VITE_BUILD_SHA` build arg). `undefined` in dev/test,
   * where the admin-login footer falls back to `"unknown"`.
   */
  readonly VITE_BUILD_SHA?: string;
  /**
   * Sentry DSN for the SPA (§13.4 V4-P5a). Unset ⇒ the Sentry SDK never
   * initializes and the app boots exactly as before.
   */
  readonly VITE_SENTRY_DSN?: string;
  /** 0..1 fraction of transactions traced; defaults to 0 when unset. */
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
  /**
   * Public SPA OAuth client id for the browser-only Drive appdata token flow.
   * No Drive secret or access token is configured on the API.
   */
  readonly VITE_GOOGLE_DRIVE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Release tag injected at build time by `vite.config.ts` (§13.4 V4-P5a) — the
 * `name@version` the SPA stamps on every Sentry event.
 */
declare const __APP_RELEASE__: string;

interface Window {
  google?: {
    accounts?: {
      oauth2?: import('./user/vault/drive/gisTokenClient').GoogleOauth2;
    };
  };
}
