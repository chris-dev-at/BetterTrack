import { apiRequest } from './apiClient';
import { currentAppServiceWorkerRegistration, registerAppServiceWorker } from './appServiceWorker';

/**
 * Browser-push client (#368/#350): registers the push service worker,
 * subscribes this browser with the server's VAPID public key, and mirrors the
 * subscription to the API. The permission prompt is ONLY ever triggered from
 * the explicit opt-in control in notification settings — never on page load.
 */

export type WebPushState = 'enabled' | 'disabled' | 'denied' | 'unsupported';

export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await registerAppServiceWorker();
  if (!registration) throw new Error('Service workers are unavailable');
  return registration;
}

/** Standard VAPID key conversion: base64url → the BufferSource subscribe() wants. */
function applicationServerKey(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** This browser's current opt-in state (no prompt, no side effects). */
export async function webPushState(): Promise<WebPushState> {
  if (!isWebPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await currentAppServiceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'enabled' : 'disabled';
}

/**
 * Opt this browser in: request permission (user gesture required), subscribe,
 * and store the subscription server-side. Returns the resulting state.
 */
export async function enableWebPush(vapidPublicKey: string): Promise<WebPushState> {
  if (!isWebPushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'disabled';
  const registration = await pushRegistration();
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(vapidPublicKey) as BufferSource,
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('Push subscription is missing its transport keys');
  }
  await apiRequest('/notifications/web-push', {
    method: 'POST',
    body: {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    },
  });
  return 'enabled';
}

/** Opt this browser out: drop the local subscription and the server row. */
export async function disableWebPush(): Promise<WebPushState> {
  if (!isWebPushSupported()) return 'unsupported';
  const registration = await currentAppServiceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await apiRequest('/notifications/web-push', { method: 'DELETE', body: { endpoint } });
  }
  return 'disabled';
}
