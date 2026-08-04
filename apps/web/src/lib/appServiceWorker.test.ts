import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

function setServiceWorkerContainer(container: Partial<ServiceWorkerContainer>): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });
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
    expect(register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
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
});
