import { useCallback, useEffect, useRef, useState } from 'react';

import { getHomeLayout, putHomeLayout } from '../../lib/settingsApi';
import { parseHomeLayout, type HomeConfig } from './config';

/**
 * Where the Home board lives: on the ACCOUNT, cached locally so it paints
 * instantly (R2 home-widgets; owner request — "if i set this certain homescreen
 * up and i login somewhere else … i want the same home widget design").
 *
 * The server copy (`GET/PUT /settings/home`) is the source of truth. The
 * `localStorage` copy is a **paint cache** in front of it: Home never waits on a
 * request before it draws, so a slow or offline session still opens on the board
 * the user built. The cache is therefore allowed to be stale, and reconciliation
 * decides who wins.
 *
 * ## Scoping
 *
 * The cache key carries the account id and the record repeats it, so two
 * accounts on one browser can never read each other's board — the bug class
 * already fixed for the first-run record (`firstrun/firstRunStorage.ts`). The
 * key scoping is what keeps a *failed* write belonging to one account from being
 * overwritten by the other; the stamp inside is the second check, so a copied or
 * hand-edited key still reads as empty rather than as somebody else's board.
 *
 * The pre-account, device-wide payload is migrated into the signed-in account's
 * slot exactly once (and the old key removed) rather than discarded — the owner's
 * existing board is the one thing this change must not throw away.
 *
 * ## Reconciliation
 *
 * On mount the server copy is fetched and, in order:
 *
 *  - a **dirty** cache (a local edit the server has not accepted) wins and is
 *    re-pushed. A failed PUT must never revert the screen or lose the board;
 *  - a cache already at the server's revision is left alone;
 *  - otherwise the server copy is adopted — a stale local copy never overwrites
 *    a newer server one;
 *  - a server with no board yet adopts the local one, but only if that local
 *    board has never been synced (a fresh migration, or a board composed
 *    offline). A local copy that HAS been synced and now finds the server empty
 *    follows the clear instead, so a board wiped on one device is not
 *    resurrected by the next one.
 *
 * Every edit writes the cache immediately and PUTs on a debounce, flushed on
 * unmount and on `pagehide` so closing the tab straight after a change does not
 * lose it. Anonymous rendering never fetches and never PUTs.
 */

/** The device-wide key every board lived under before it followed the account. */
export const HOME_LEGACY_STORAGE_KEY = 'bt.home.v1';

/** The per-account cache key. The account is in the key AND in the record. */
export function homeCacheKey(accountId: string): string {
  return `${HOME_LEGACY_STORAGE_KEY}.${accountId}`;
}

/** How long a burst of board edits collapses into one PUT. */
export const HOME_PUSH_DEBOUNCE_MS = 800;

export interface HomeCache {
  /**
   * The board document as last agreed — the server's copy verbatim, or the
   * local board after an edit. Deliberately `unknown`: a document written by a
   * newer build keeps its unknown widgets here, so a rollback that cannot
   * render them does not destroy them on this device either.
   */
  layout: unknown;
  /** The server revision this cache matches. `null` = never synced. */
  syncedAt: string | null;
  /** A local edit the server has not accepted yet. */
  dirty: boolean;
}

interface StoredCache extends HomeCache {
  account: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readKey(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    // Storage unavailable (private mode) or a half-written record — read as empty.
    return null;
  }
}

/**
 * Adopt the pre-account payload into `accountId`'s slot and retire the old key,
 * so the migration happens once and the next account to sign in on this browser
 * does not inherit it. Returns the migrated cache, or null when there was none.
 *
 * The board is marked never-synced rather than dirty: it predates the server
 * model entirely, so it publishes itself only when the account has no board yet
 * — an account that already saved one somewhere else keeps that one.
 */
function migrateLegacyCache(accountId: string): HomeCache | null {
  const legacy = readKey(HOME_LEGACY_STORAGE_KEY);
  if (!isRecord(legacy) || !Array.isArray(legacy.widgets)) return null;
  const cache: HomeCache = { layout: legacy, syncedAt: null, dirty: false };
  writeHomeCache(accountId, cache);
  try {
    window.localStorage.removeItem(HOME_LEGACY_STORAGE_KEY);
  } catch {
    // Non-fatal: the record is already in the account slot, which now wins.
  }
  return cache;
}

/** The signed-in account's cached board, or null when there is nothing usable. */
export function readHomeCache(accountId: string | null | undefined): HomeCache | null {
  if (!accountId) return null;
  const stored = readKey(homeCacheKey(accountId));
  if (!isRecord(stored)) return migrateLegacyCache(accountId);
  // Somebody else's board (a copied key, a hand edit): not this account's business.
  if (stored.account !== accountId) return null;
  return {
    layout: stored.layout,
    syncedAt: typeof stored.syncedAt === 'string' ? stored.syncedAt : null,
    dirty: stored.dirty === true,
  };
}

/** Persist the cache. A storage failure is non-fatal — the session keeps its board. */
export function writeHomeCache(accountId: string | null | undefined, cache: HomeCache): void {
  if (!accountId) return;
  const record: StoredCache = { account: accountId, ...cache };
  try {
    window.localStorage.setItem(homeCacheKey(accountId), JSON.stringify(record));
  } catch {
    // Ignored on purpose — the cache is a convenience, the server holds the board.
  }
}

/** Drop the cached board. The board itself still lives on the account. */
export function clearHomeCache(accountId: string | null | undefined): void {
  if (!accountId) return;
  try {
    window.localStorage.removeItem(homeCacheKey(accountId));
  } catch {
    // Ignored — see writeHomeCache.
  }
}

/**
 * Forget the board on BOTH sides. Local-only would leave the account copy
 * standing and the next device would push it straight back.
 */
export async function clearHomeBoard(accountId: string | null | undefined): Promise<void> {
  clearHomeCache(accountId);
  if (!accountId) return;
  await putHomeLayout(null);
}

export interface HomeBoard {
  /** The board to render — the cache on first paint, reconciled shortly after. */
  config: HomeConfig;
  /** Persist an edited board: cache now, server on a debounce. */
  update: (next: HomeConfig) => void;
}

/**
 * The Home board, kept in step with the account.
 *
 * `accountId` null (anonymous, or the session still resolving) renders the
 * defaults and touches neither storage nor the network.
 */
export function useHomeBoard(accountId: string | null | undefined): HomeBoard {
  // Everything the debounce and the in-flight PUT need, held in refs so the
  // callbacks below stay stable: a `flush` that changed identity every render
  // would re-run its effect and defeat the debounce it exists to close out.
  const accountRef = useRef(accountId);
  const loadedAccountRef = useRef(accountId);
  const cacheRef = useRef<HomeCache | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<unknown>(undefined);
  /** Bumped by every local edit; an in-flight PUT older than this must not commit. */
  const revisionRef = useRef(0);

  // First paint comes straight from the cache — Home never waits on a request.
  const [config, setConfig] = useState<HomeConfig>(() => {
    const cached = readHomeCache(accountId);
    cacheRef.current = cached;
    return parseHomeLayout(cached?.layout);
  });

  const store = useCallback((cache: HomeCache) => {
    cacheRef.current = cache;
    writeHomeCache(accountRef.current, cache);
  }, []);

  const push = useCallback(
    (layout: unknown, keepalive = false) => {
      const account = accountRef.current;
      if (!account) return;
      const revision = revisionRef.current;
      // Recorded as dirty BEFORE the request so a tab that dies mid-flight
      // retries on the next mount rather than believing itself in sync.
      store({ layout, syncedAt: cacheRef.current?.syncedAt ?? null, dirty: true });
      void putHomeLayout(layout, { keepalive })
        .then((saved) => {
          // A newer edit landed while this was in flight; its own PUT owns the
          // revision. Committing here would clear that edit's dirty flag.
          if (revisionRef.current !== revision || accountRef.current !== account) return;
          store({ layout, syncedAt: saved.updatedAt, dirty: false });
        })
        .catch(() => {
          // Stays dirty: retried on the next edit and on the next mount. The
          // board on screen is untouched — a failed save never reverts it.
        });
    },
    [store],
  );

  const flush = useCallback(
    (keepalive: boolean) => {
      if (timerRef.current === null) return;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = undefined;
      if (pending !== undefined) push(pending, keepalive);
    },
    [push],
  );

  const update = useCallback(
    (next: HomeConfig) => {
      setConfig(next);
      revisionRef.current += 1;
      // The cache is written on the spot; only the network call waits.
      store({ layout: next, syncedAt: cacheRef.current?.syncedAt ?? null, dirty: true });
      pendingRef.current = next;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = undefined;
        if (pending !== undefined) push(pending);
      }, HOME_PUSH_DEBOUNCE_MS);
    },
    [push, store],
  );

  // Reconcile with the account copy. Re-runs when the account changes so a
  // second sign-in in the same tab never keeps the first one's board on screen.
  useEffect(() => {
    accountRef.current = accountId;
    if (loadedAccountRef.current !== accountId) {
      loadedAccountRef.current = accountId;
      // Anything queued belongs to the previous account and must not be pushed
      // under this one; bumping the revision also strands any in-flight PUT.
      revisionRef.current += 1;
      pendingRef.current = undefined;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      const cached = readHomeCache(accountId);
      cacheRef.current = cached;
      setConfig(parseHomeLayout(cached?.layout));
    }
    if (!accountId) return;

    const controller = new AbortController();
    let live = true;
    // Reconciliation is best-effort as a whole, not just its request: offline,
    // rate-limited, session gone, or a response this build cannot make sense of
    // all land in the same place — the cached board stays on screen and any
    // dirty edit stays dirty for the next attempt. Home must not be takeable
    // down by the shape of one response.
    void (async () => {
      try {
        const server = await getHomeLayout(controller.signal);
        if (!live) return;

        const local = cacheRef.current;
        if (local?.dirty) {
          push(local.layout);
          return;
        }
        // Only a real revision proves we are in step. `null === null` would also
        // match a never-synced board against an account that has none — which is
        // precisely the case that still has work to do.
        if (local?.syncedAt != null && local.syncedAt === server.updatedAt) return;

        if (server.layout !== null && server.layout !== undefined) {
          setConfig(parseHomeLayout(server.layout));
          store({ layout: server.layout, syncedAt: server.updatedAt, dirty: false });
          return;
        }
        // The account has no board.
        if (local === null) return; // …and neither has this device: the defaults stand.
        if (local.syncedAt === null) {
          // A board that predates the account copy (the migrated one, or one
          // composed while the account had none) — publish it.
          push(local.layout);
          return;
        }
        // It was cleared on another device. Follow the clear rather than pushing
        // the board the user just deleted back up.
        cacheRef.current = null;
        clearHomeCache(accountId);
        setConfig(parseHomeLayout(null));
      } catch {
        // Deliberately silent — see above.
      }
    })();

    return () => {
      live = false;
      controller.abort();
    };
  }, [accountId, push, store]);

  // A fast tab close must not lose the last edit: `pagehide` fires where
  // `beforeunload` does not (bfcache, mobile), and the flush goes out with
  // `keepalive` so the browser finishes it after the page is gone.
  useEffect(() => {
    const onPageHide = () => flush(true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      flush(false);
    };
  }, [flush]);

  return { config, update };
}
