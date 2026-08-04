export const APP_SERVICE_WORKER_URL = '/service-worker.js';
export const APP_SERVICE_WORKER_SCOPE = '/';

let registrationPromise: Promise<ServiceWorkerRegistration> | undefined;

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

/** Read the root registration without prompting or creating one. */
export async function currentAppServiceWorkerRegistration(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (!isAppServiceWorkerSupported()) return undefined;
  return navigator.serviceWorker.getRegistration(APP_SERVICE_WORKER_SCOPE);
}
