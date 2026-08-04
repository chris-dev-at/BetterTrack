import type { AppKind } from './runtimeConfig';

export const APP_MANIFEST_URL = '/manifest.webmanifest';
export const APP_SERVICE_WORKER_URL = `/service-worker.js?v=${encodeURIComponent(__APP_RELEASE__)}`;
export const APP_SERVICE_WORKER_SCOPE = '/';

let registrationPromise: Promise<ServiceWorkerRegistration> | undefined;
let persistencePromise: Promise<boolean> | undefined;

export function isAppServiceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Register BetterTrack's one root-scoped worker. The shared promise coalesces
 * app boot and an immediate push opt-in into one browser registration call.
 */
export function registerAppServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!isAppServiceWorkerSupported()) return Promise.resolve(undefined);

  registrationPromise ??= navigator.serviceWorker
    .register(APP_SERVICE_WORKER_URL, { scope: APP_SERVICE_WORKER_SCOPE })
    .catch((error: unknown) => {
      // A transient failure must be retryable from the explicit push control.
      registrationPromise = undefined;
      throw error;
    });
  return registrationPromise;
}

function setManifestEnabled(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  const existing = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!enabled) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = APP_MANIFEST_URL;
  document.head.append(manifest);
}

function requestPersistentStorage(): Promise<boolean | undefined> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
    return Promise.resolve(undefined);
  }

  const persist = navigator.storage.persist.bind(navigator.storage);
  // Persistence is a best-effort eviction hint. A rejection or `false` result
  // must never prevent the app or service worker from starting.
  persistencePromise ??= Promise.resolve()
    .then(() => persist())
    .catch(() => false);
  return persistencePromise;
}

/** Apply the per-origin PWA policy after runtime config has selected an app. */
export async function initializeAppPwa(app: AppKind): Promise<void> {
  const isUserApp = app === 'user';
  setManifestEnabled(isUserApp);

  if (!isUserApp) {
    // Clean up registrations created before the admin-origin gate shipped.
    const registration = await currentAppServiceWorkerRegistration().catch(() => undefined);
    await registration?.unregister().catch(() => false);
    return;
  }

  await Promise.all([requestPersistentStorage(), registerAppServiceWorker()]);
}

/** Read the root registration without prompting or creating one. */
export async function currentAppServiceWorkerRegistration(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (!isAppServiceWorkerSupported()) return undefined;
  return navigator.serviceWorker.getRegistration(APP_SERVICE_WORKER_SCOPE);
}
