import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');

function setServiceWorkerContainer(container: Partial<ServiceWorkerContainer>): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });
}

function setStorageManager(manager: Partial<StorageManager> | undefined): void {
  if (manager) {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: manager,
    });
  } else {
    Reflect.deleteProperty(navigator, 'storage');
  }
}

describe('app service worker registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalServiceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    } else {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
    if (originalStorage) {
      Object.defineProperty(navigator, 'storage', originalStorage);
    } else {
      Reflect.deleteProperty(navigator, 'storage');
    }
    document.head.querySelectorAll('link[rel="manifest"]').forEach((link) => link.remove());
    vi.restoreAllMocks();
  });

  it('coalesces app boot and push opt-in into one root registration', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    setServiceWorkerContainer({ register });
    const { registerAppServiceWorker } = await import('./appServiceWorker');

    const [first, second] = await Promise.all([
      registerAppServiceWorker(),
      registerAppServiceWorker(),
    ]);

    expect(first).toBe(registration);
    expect(second).toBe(registration);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(expect.stringMatching(/^\/service-worker\.js\?v=.+/), {
      scope: '/',
    });
  });

  it('reads the root registration without creating one', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const getRegistration = vi.fn().mockResolvedValue(registration);
    const register = vi.fn();
    setServiceWorkerContainer({ getRegistration, register });
    const { currentAppServiceWorkerRegistration } = await import('./appServiceWorker');

    await expect(currentAppServiceWorkerRegistration()).resolves.toBe(registration);
    expect(getRegistration).toHaveBeenCalledWith('/');
    expect(register).not.toHaveBeenCalled();
  });

  it('allows registration to be retried after a transient failure', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(registration);
    setServiceWorkerContainer({ register });
    const { registerAppServiceWorker } = await import('./appServiceWorker');

    await expect(registerAppServiceWorker()).rejects.toThrow('offline');
    await expect(registerAppServiceWorker()).resolves.toBe(registration);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('enables the manifest, persistent storage, and worker only for the user app', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    const persist = vi.fn().mockResolvedValue(false);
    setServiceWorkerContainer({ register });
    setStorageManager({ persist });
    const { initializeAppPwa } = await import('./appServiceWorker');

    await Promise.all([initializeAppPwa('user'), initializeAppPwa('user')]);

    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe(
      '/manifest.webmanifest',
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('keeps admin non-installable and removes a legacy root worker', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistration = vi
      .fn()
      .mockResolvedValue({ unregister } as unknown as ServiceWorkerRegistration);
    const register = vi.fn();
    const persist = vi.fn();
    setServiceWorkerContainer({ getRegistration, register });
    setStorageManager({ persist });
    const staleManifest = document.createElement('link');
    staleManifest.rel = 'manifest';
    staleManifest.href = '/manifest.webmanifest';
    document.head.append(staleManifest);
    const { initializeAppPwa } = await import('./appServiceWorker');

    await initializeAppPwa('admin');

    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull();
    expect(register).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(getRegistration).toHaveBeenCalledWith('/');
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('does not fail user boot when persistent storage is unavailable or denied', async () => {
    const register = vi.fn().mockResolvedValue({} as ServiceWorkerRegistration);
    setServiceWorkerContainer({ register });
    setStorageManager(undefined);
    const { initializeAppPwa } = await import('./appServiceWorker');
    await expect(initializeAppPwa('user')).resolves.toBeUndefined();

    vi.resetModules();
    const persist = vi.fn().mockRejectedValue(new Error('denied'));
    setStorageManager({ persist });
    const reloaded = await import('./appServiceWorker');
    await expect(reloaded.initializeAppPwa('user')).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledOnce();
  });
});
