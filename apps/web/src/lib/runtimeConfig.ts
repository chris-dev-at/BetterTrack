/**
 * SPA runtime configuration (PROJECTPLAN.md §7.1). The same built web image is
 * served from every origin (user + admin); each nginx server block writes a
 * per-origin `config.js` that assigns `window.__BT__` BEFORE the app bundle
 * loads. That decouples the image from the deployment topology — no rebuild to
 * move between subdomains and ports mode.
 *
 *   window.__BT__ = {
 *     app: "user" | "admin",
 *     apiOrigin: "https://api.example",
 *     googleDriveClientId: "…apps.googleusercontent.com"
 *   }
 *
 * `apiOrigin` empty (the dev/default stub) means "same origin" — the Vite proxy
 * (dev) or a co-located nginx (single-origin fallback) forwards `/api`.
 */
export type AppKind = 'user' | 'admin';

export interface RuntimeConfig {
  app: AppKind;
  /** Absolute API origin, or '' for same-origin (relative /api/v1). */
  apiOrigin: string;
  /** Public GIS SPA client id; blank keeps the Drive medium unavailable. */
  googleDriveClientId: string;
}

declare global {
  interface Window {
    __BT__?: Partial<RuntimeConfig>;
  }
}

const DEFAULTS: RuntimeConfig = { app: 'user', apiOrigin: '', googleDriveClientId: '' };

export function getRuntimeConfig(): RuntimeConfig {
  const injected = typeof window !== 'undefined' ? window.__BT__ : undefined;
  const app: AppKind = injected?.app === 'admin' ? 'admin' : 'user';
  const apiOrigin =
    typeof injected?.apiOrigin === 'string'
      ? injected.apiOrigin.replace(/\/$/, '')
      : DEFAULTS.apiOrigin;
  const googleDriveClientId =
    typeof injected?.googleDriveClientId === 'string'
      ? injected.googleDriveClientId.trim()
      : DEFAULTS.googleDriveClientId;
  return { app, apiOrigin, googleDriveClientId };
}

/** Base URL for the JSON API: `${apiOrigin}/api/v1`, or relative `/api/v1`. */
export function apiBaseUrl(): string {
  return `${getRuntimeConfig().apiOrigin}/api/v1`;
}
