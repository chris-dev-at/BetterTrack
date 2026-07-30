import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/settingsApi');

import { getHomeLayout, putHomeLayout } from '../../lib/settingsApi';
import { DEFAULT_LAYOUT, type HomeConfig } from './config';
import {
  clearHomeBoard,
  homeCacheKey,
  HOME_LEGACY_STORAGE_KEY,
  HOME_PUSH_DEBOUNCE_MS,
  readHomeCache,
  useHomeBoard,
  type HomeCache,
} from './homeSync';

/**
 * The Home board following the ACCOUNT rather than the browser.
 *
 * The properties that matter here are the ones a user notices when they go
 * wrong: the board is never shared between two accounts on one browser, a stale
 * device never overwrites a newer board, a failed save never blanks or reverts
 * the screen, and the board the owner already had is carried up rather than
 * thrown away.
 */

const ALICE = 'acc-alice';
const BOB = 'acc-bob';

function board(...ids: string[]): HomeConfig {
  return {
    version: 1,
    widgets: ids.map((id) => ({ id, type: 'news', size: 'm', settings: {} })),
  };
}

function seedCache(accountId: string, cache: HomeCache): void {
  localStorage.setItem(homeCacheKey(accountId), JSON.stringify({ account: accountId, ...cache }));
}

function cached(accountId: string): HomeCache | null {
  return readHomeCache(accountId);
}

/** The board ids currently in the cache, or null when there is no cache. */
function cachedIds(accountId: string): string[] | null {
  const layout = cached(accountId)?.layout as HomeConfig | undefined;
  return layout ? layout.widgets.map((w) => w.id) : null;
}

const server = vi.mocked(getHomeLayout);
const push = vi.mocked(putHomeLayout);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.mockResolvedValue({ layout: null, updatedAt: null });
  push.mockImplementation((layout) =>
    Promise.resolve({ layout, updatedAt: '2026-07-30T10:00:00.000Z' }),
  );
});

// The mocks are deliberately NOT reset here: testing-library's auto-cleanup
// unmounts after this hook, and an unmount flushes a pending edit — which would
// call a `putHomeLayout` with no implementation left.
afterEach(() => {
  vi.useRealTimers();
});

/** Run the debounce out and let the resulting PUT settle. */
async function settlePush(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(HOME_PUSH_DEBOUNCE_MS);
    await Promise.resolve();
  });
}

describe('the cache is per account', () => {
  test('two accounts on one browser never read each other’s board', async () => {
    seedCache(ALICE, {
      layout: board('alice-1'),
      syncedAt: '2026-07-01T00:00:00.000Z',
      dirty: false,
    });
    server.mockResolvedValue({ layout: null, updatedAt: null });

    const bob = renderHook(() => useHomeBoard(BOB));

    // Bob has no board of his own, so he gets the defaults — never Alice's.
    expect(bob.result.current.config).toEqual(DEFAULT_LAYOUT);
    await act(async () => {
      await Promise.resolve();
    });
    expect(bob.result.current.config).toEqual(DEFAULT_LAYOUT);

    // Bob composing a board leaves Alice's cache untouched.
    act(() => bob.result.current.update(board('bob-1')));
    expect(cachedIds(BOB)).toEqual(['bob-1']);
    expect(cachedIds(ALICE)).toEqual(['alice-1']);
  });

  test('a record stamped with another account reads as empty', () => {
    localStorage.setItem(
      homeCacheKey(ALICE),
      JSON.stringify({ account: BOB, layout: board('bob-1'), syncedAt: null, dirty: false }),
    );

    expect(readHomeCache(ALICE)).toBeNull();
  });

  test('an anonymous render touches neither storage nor the network', async () => {
    seedCache(ALICE, { layout: board('alice-1'), syncedAt: null, dirty: false });

    const { result } = renderHook(() => useHomeBoard(null));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.config).toEqual(DEFAULT_LAYOUT);
    expect(server).not.toHaveBeenCalled();

    act(() => result.current.update(board('nope')));
    await settlePush();
    expect(push).not.toHaveBeenCalled();
    // Alice's cache is the only entry, unchanged.
    expect(cachedIds(ALICE)).toEqual(['alice-1']);
  });
});

describe('a paranoid account keeps its board on the device', () => {
  // The layout names portfolio ids and plain tickers — the inference paranoid
  // mode is bought to prevent (owner decision, PROJECTPLAN §16 2026-07-30).
  test('never fetches and never pushes when sync is off', async () => {
    seedCache(ALICE, { layout: board('alice-1'), syncedAt: null, dirty: false });

    const { result } = renderHook(() => useHomeBoard(ALICE, { sync: false }));
    await act(async () => {
      await Promise.resolve();
    });

    // The board still works — it is local, not disabled.
    expect(cachedIds(ALICE)).toEqual(['alice-1']);
    expect(server).not.toHaveBeenCalled();

    act(() => result.current.update(board('alice-2')));
    await settlePush();

    expect(push).not.toHaveBeenCalled();
    expect(cachedIds(ALICE)).toEqual(['alice-2']);
  });

  test('a queued edit is dropped rather than flushed when the mode resolves to paranoid', async () => {
    server.mockResolvedValue({ layout: null, updatedAt: null });
    const view = renderHook(({ sync }) => useHomeBoard(ALICE, { sync }), {
      initialProps: { sync: true },
    });
    await waitFor(() => expect(server).toHaveBeenCalled());

    act(() => view.result.current.update(board('alice-3')));
    // Resolving to paranoid before the debounce fires must not leak the edit.
    view.rerender({ sync: false });
    await settlePush();

    expect(push).not.toHaveBeenCalled();
    expect(cachedIds(ALICE)).toEqual(['alice-3']);
  });
});

describe('the pre-account board is carried up, once', () => {
  test('migrates the device-wide payload into the signed-in account and publishes it', async () => {
    localStorage.setItem(HOME_LEGACY_STORAGE_KEY, JSON.stringify(board('legacy-1')));

    const { result } = renderHook(() => useHomeBoard(ALICE));

    // Painted from the migrated board on the very first render — no request first.
    expect(result.current.config.widgets.map((w) => w.id)).toEqual(['legacy-1']);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect((push.mock.calls[0]?.[0] as HomeConfig).widgets[0]?.id).toBe('legacy-1');

    // The old key is retired, so the next account to sign in here does not inherit it.
    expect(localStorage.getItem(HOME_LEGACY_STORAGE_KEY)).toBeNull();
    expect(readHomeCache(BOB)).toBeNull();
  });

  test('yields to a board the account already saved elsewhere', async () => {
    localStorage.setItem(HOME_LEGACY_STORAGE_KEY, JSON.stringify(board('legacy-1')));
    server.mockResolvedValue({
      layout: board('from-work'),
      updatedAt: '2026-07-29T09:00:00.000Z',
    });

    const { result } = renderHook(() => useHomeBoard(ALICE));

    await waitFor(() =>
      expect(result.current.config.widgets.map((w) => w.id)).toEqual(['from-work']),
    );
    // The never-synced local board is not pushed over the account's own copy.
    expect(push).not.toHaveBeenCalled();
    expect(cached(ALICE)?.syncedAt).toBe('2026-07-29T09:00:00.000Z');
  });
});

describe('reconciling with the account copy', () => {
  test('adopts a newer server board on load', async () => {
    seedCache(ALICE, {
      layout: board('old-1'),
      syncedAt: '2026-07-01T00:00:00.000Z',
      dirty: false,
    });
    server.mockResolvedValue({
      layout: board('new-1', 'new-2'),
      updatedAt: '2026-07-29T09:00:00.000Z',
    });

    const { result } = renderHook(() => useHomeBoard(ALICE));

    // First paint is still the cached board — Home never waits on the request.
    expect(result.current.config.widgets.map((w) => w.id)).toEqual(['old-1']);
    await waitFor(() =>
      expect(result.current.config.widgets.map((w) => w.id)).toEqual(['new-1', 'new-2']),
    );
    expect(cached(ALICE)).toEqual({
      layout: board('new-1', 'new-2'),
      syncedAt: '2026-07-29T09:00:00.000Z',
      dirty: false,
    });
    expect(push).not.toHaveBeenCalled();
  });

  test('a stale local copy never overwrites a newer server copy', async () => {
    // A device that saved at 10:00 and has been closed since; the account moved
    // on at 12:00 from somewhere else. The local board is old, not unsaved.
    seedCache(ALICE, {
      layout: board('stale-1'),
      syncedAt: '2026-07-29T10:00:00.000Z',
      dirty: false,
    });
    server.mockResolvedValue({
      layout: board('fresh-1'),
      updatedAt: '2026-07-29T12:00:00.000Z',
    });

    const { result } = renderHook(() => useHomeBoard(ALICE));
    await waitFor(() =>
      expect(result.current.config.widgets.map((w) => w.id)).toEqual(['fresh-1']),
    );

    await settlePush();
    expect(push).not.toHaveBeenCalled();
    expect(cachedIds(ALICE)).toEqual(['fresh-1']);
  });

  test('leaves an in-step cache alone', async () => {
    seedCache(ALICE, {
      layout: board('same-1'),
      syncedAt: '2026-07-29T10:00:00.000Z',
      dirty: false,
    });
    server.mockResolvedValue({ layout: board('same-1'), updatedAt: '2026-07-29T10:00:00.000Z' });

    const { result } = renderHook(() => useHomeBoard(ALICE));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.config.widgets.map((w) => w.id)).toEqual(['same-1']);
    expect(push).not.toHaveBeenCalled();
  });

  test('follows a clear made on another device instead of resurrecting the board', async () => {
    seedCache(ALICE, {
      layout: board('deleted-1'),
      syncedAt: '2026-07-29T10:00:00.000Z',
      dirty: false,
    });
    // The account was cleared elsewhere: no board, but a revision that says so.
    server.mockResolvedValue({ layout: null, updatedAt: '2026-07-29T12:00:00.000Z' });

    const { result } = renderHook(() => useHomeBoard(ALICE));
    await waitFor(() => expect(result.current.config).toEqual(DEFAULT_LAYOUT));

    await settlePush();
    expect(push).not.toHaveBeenCalled();
    expect(readHomeCache(ALICE)).toBeNull();
  });

  test('an unreachable server leaves the cached board on screen', async () => {
    seedCache(ALICE, {
      layout: board('offline-1'),
      syncedAt: '2026-07-29T10:00:00.000Z',
      dirty: false,
    });
    server.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useHomeBoard(ALICE));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.config.widgets.map((w) => w.id)).toEqual(['offline-1']);
    expect(cachedIds(ALICE)).toEqual(['offline-1']);
  });
});

describe('pushing edits', () => {
  test('caches immediately, PUTs on the debounce, and records the revision', async () => {
    const { result } = renderHook(() => useHomeBoard(ALICE));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.update(board('w-1')));

    // The cache is written on the spot and marked unsaved.
    expect(cachedIds(ALICE)).toEqual(['w-1']);
    expect(cached(ALICE)?.dirty).toBe(true);
    expect(push).not.toHaveBeenCalled();

    await settlePush();
    expect(push).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cached(ALICE)?.dirty).toBe(false));
    expect(cached(ALICE)?.syncedAt).toBe('2026-07-30T10:00:00.000Z');
  });

  test('collapses a burst of edits into one PUT of the final board', async () => {
    const { result } = renderHook(() => useHomeBoard(ALICE));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.update(board('w-1')));
    act(() => vi.advanceTimersByTime(HOME_PUSH_DEBOUNCE_MS / 2));
    act(() => result.current.update(board('w-1', 'w-2')));
    await settlePush();

    expect(push).toHaveBeenCalledTimes(1);
    expect((push.mock.calls[0]?.[0] as HomeConfig).widgets.map((w) => w.id)).toEqual([
      'w-1',
      'w-2',
    ]);
  });

  test('flushes a pending edit on unmount so a fast tab close keeps it', async () => {
    const { result, unmount } = renderHook(() => useHomeBoard(ALICE));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.update(board('last-edit')));
    expect(push).not.toHaveBeenCalled();

    unmount();

    expect(push).toHaveBeenCalledTimes(1);
    expect((push.mock.calls[0]?.[0] as HomeConfig).widgets[0]?.id).toBe('last-edit');
  });

  test('flushes on pagehide with keepalive', async () => {
    const { result } = renderHook(() => useHomeBoard(ALICE));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.update(board('closing')));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[1]).toEqual({ keepalive: true });
  });

  test('a failed PUT keeps the board, stays dirty, and retries on the next edit', async () => {
    const { result } = renderHook(() => useHomeBoard(ALICE));
    await act(async () => {
      await Promise.resolve();
    });

    push.mockRejectedValueOnce(new Error('500'));
    act(() => result.current.update(board('w-1')));
    await settlePush();

    // The screen still shows what the user built, and the cache still holds it.
    expect(result.current.config.widgets.map((w) => w.id)).toEqual(['w-1']);
    expect(cachedIds(ALICE)).toEqual(['w-1']);
    expect(cached(ALICE)?.dirty).toBe(true);

    // The next edit retries — and succeeding clears the flag.
    act(() => result.current.update(board('w-1', 'w-2')));
    await settlePush();
    expect(push).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(cached(ALICE)?.dirty).toBe(false));
    expect(cachedIds(ALICE)).toEqual(['w-1', 'w-2']);
  });

  test('a dirty cache is re-pushed on the next mount and outranks the server copy', async () => {
    seedCache(ALICE, {
      layout: board('unsaved-1'),
      syncedAt: '2026-07-29T10:00:00.000Z',
      dirty: true,
    });
    server.mockResolvedValue({ layout: board('older-1'), updatedAt: '2026-07-29T11:00:00.000Z' });

    const { result } = renderHook(() => useHomeBoard(ALICE));

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect((push.mock.calls[0]?.[0] as HomeConfig).widgets[0]?.id).toBe('unsaved-1');
    // The unsaved local edit is never replaced by the server copy on screen.
    expect(result.current.config.widgets.map((w) => w.id)).toEqual(['unsaved-1']);
    await waitFor(() => expect(cached(ALICE)?.dirty).toBe(false));
  });

  test('a slow PUT never marks a newer edit as saved', async () => {
    const { result } = renderHook(() => useHomeBoard(ALICE));
    await act(async () => {
      await Promise.resolve();
    });

    let releaseFirst: (() => void) | undefined;
    push.mockImplementationOnce(
      (layout) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ layout, updatedAt: '2026-07-30T10:00:00.000Z' });
        }),
    );

    act(() => result.current.update(board('w-1')));
    await settlePush();
    expect(push).toHaveBeenCalledTimes(1);

    // A second edit lands while the first PUT is still open.
    act(() => result.current.update(board('w-1', 'w-2')));
    await act(async () => {
      releaseFirst?.();
      await Promise.resolve();
    });

    // The stale response must not mark the newer board saved — losing it if the
    // tab closed now.
    expect(cached(ALICE)?.dirty).toBe(true);
    expect(cachedIds(ALICE)).toEqual(['w-1', 'w-2']);
  });
});

describe('clearing the board', () => {
  test('clears both sides so the next device does not push it back', async () => {
    seedCache(ALICE, { layout: board('w-1'), syncedAt: '2026-07-29T10:00:00.000Z', dirty: false });

    await clearHomeBoard(ALICE);

    expect(readHomeCache(ALICE)).toBeNull();
    expect(push).toHaveBeenCalledWith(null);
  });
});
