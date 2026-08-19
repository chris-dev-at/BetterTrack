import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHUNK_RECOVERY_SESSION_KEY,
  installVitePreloadErrorRecovery,
  isChunkLoadError,
  recoverFromChunkLoadError,
  reloadForChunkRecovery,
  type ChunkRecoveryEnvironment,
} from './chunkRecovery';

function recoveryEnvironment(reload = vi.fn()): ChunkRecoveryEnvironment {
  return {
    release: 'deploy-a',
    reload,
    storage: sessionStorage,
  };
}

afterEach(() => {
  sessionStorage.removeItem(CHUNK_RECOVERY_SESSION_KEY);
  vi.restoreAllMocks();
});

describe('chunk recovery', () => {
  it.each([
    new TypeError('Failed to fetch dynamically imported module: /assets/page-old.js'),
    new TypeError('error loading dynamically imported module: /assets/page-old.js'),
    new TypeError('Importing a module script failed.'),
    Object.assign(new Error('Loading chunk route-12 failed.'), { name: 'ChunkLoadError' }),
  ])('recognizes browser module-fetch failures', (error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it('does not reload for an ordinary render failure', () => {
    const reload = vi.fn();

    expect(recoverFromChunkLoadError(new Error('render failed'), recoveryEnvironment(reload))).toBe(
      false,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RECOVERY_SESSION_KEY)).toBeNull();
  });

  it('falls through when the browser refuses the reload', () => {
    const reload = vi.fn(() => {
      throw new Error('navigation blocked');
    });

    expect(
      recoverFromChunkLoadError(
        new TypeError('Failed to fetch dynamically imported module'),
        recoveryEnvironment(reload),
      ),
    ).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(CHUNK_RECOVERY_SESSION_KEY)).toBe('deploy-a');
  });

  it('leaves a chunk failure in place offline, then recovers after reconnecting', () => {
    const reload = vi.fn();
    const online = vi.spyOn(navigator, 'onLine', 'get');

    online.mockReturnValue(false);
    expect(reloadForChunkRecovery(recoveryEnvironment(reload))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RECOVERY_SESSION_KEY)).toBeNull();

    online.mockReturnValue(true);
    expect(reloadForChunkRecovery(recoveryEnvironment(reload))).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(CHUNK_RECOVERY_SESSION_KEY)).toBe('deploy-a');
  });

  it('prevents Vite from rethrowing only for the first reload attempt in a release', () => {
    const reload = vi.fn();
    const target = new EventTarget();
    const uninstall = installVitePreloadErrorRecovery(recoveryEnvironment(reload), target);

    const firstFailure = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(firstFailure);
    const repeatedFailure = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(repeatedFailure);

    expect(reload).toHaveBeenCalledOnce();
    expect(firstFailure.defaultPrevented).toBe(true);
    expect(repeatedFailure.defaultPrevented).toBe(false);

    uninstall();
  });

  it('allows a later deploy to recover in the same session', () => {
    const reload = vi.fn();
    const firstDeploy = recoveryEnvironment(reload);
    const secondDeploy = { ...firstDeploy, release: 'deploy-b' };
    const chunkError = new TypeError('Failed to fetch dynamically imported module');

    expect(recoverFromChunkLoadError(chunkError, firstDeploy)).toBe(true);
    expect(recoverFromChunkLoadError(chunkError, firstDeploy)).toBe(false);
    expect(recoverFromChunkLoadError(chunkError, secondDeploy)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
