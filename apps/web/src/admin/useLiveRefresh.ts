import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * The Operations cockpit's live refresh (#1406 W4).
 *
 * W1 wrote down a rule and meant it: *"an operator page that refetches on a
 * timer is a page that quietly hammers the box it is meant to watch. Refresh is
 * explicit."* That rule is kept — every other console page, the Overview
 * included, still refreshes only when asked. This hook is the narrow exception
 * the cockpit needs (queue depth and breaker state are worth nothing if they
 * are five minutes stale) and it is built so the objection behind the rule does
 * not apply:
 *
 *  - **The cadence is visible and chosen.** It is a control on the page, not a
 *    hidden timer; the caller renders the interval it is running at.
 *  - **It lives in the URL.** `?live=off` is a shareable, reload-surviving state
 *    like every other filter in this console, and it is how an operator turns
 *    the polling off for good rather than per visit.
 *  - **A hidden tab polls nothing.** A console left open on a second monitor
 *    overnight is exactly the "quietly hammers the box" case, so the interval
 *    stops on `visibilitychange` and fires once on return.
 *  - **A slow read cannot pile up.** This is a plain `setInterval`, so a tick
 *    can fire while the previous read is still in flight — but each tick bumps
 *    `useResource`'s reload nonce, and that hook aborts the in-flight request
 *    (`AbortController`) before starting the next. The guarantee is
 *    "at most one live request per resource", enforced there rather than here;
 *    the interval is not self-throttling and does not claim to be.
 */

/** The cadences offered, in seconds. `0` is off. */
export const LIVE_REFRESH_SECONDS = [0, 15, 30, 60] as const;
export type LiveRefreshSeconds = (typeof LIVE_REFRESH_SECONDS)[number];

/** The default cadence for a cockpit page. */
export const LIVE_REFRESH_DEFAULT: LiveRefreshSeconds = 30;

/** URL parameter carrying the cadence. `off` reads better in a shared link than `0`. */
export const LIVE_REFRESH_PARAM = 'live';

function parseCadence(raw: string | null): LiveRefreshSeconds {
  if (raw === null) return LIVE_REFRESH_DEFAULT;
  if (raw === 'off') return 0;
  const value = Number(raw);
  return (LIVE_REFRESH_SECONDS as readonly number[]).includes(value)
    ? (value as LiveRefreshSeconds)
    : LIVE_REFRESH_DEFAULT;
}

export interface LiveRefresh {
  /** Current cadence in seconds; `0` means the page refreshes only on demand. */
  seconds: LiveRefreshSeconds;
  /** Change the cadence. Writes the URL, so the choice survives reload and sharing. */
  setSeconds: (seconds: LiveRefreshSeconds) => void;
  /** True while polling is suspended because the tab is not visible. */
  paused: boolean;
  /** When the last automatic or manual refresh was recorded, for the cadence label. */
  lastRefreshedAt: Date | null;
  /** Refresh now and restart the interval — what the page's Refresh button calls. */
  refreshNow: () => void;
}

/**
 * @param reload  The `useResource().reload` (or a fan-out over several) to call.
 *                Must be stable — pass a `useCallback`'d function.
 */
export function useLiveRefresh(reload: () => void): LiveRefresh {
  const [params, setParams] = useSearchParams();
  const seconds = parseCadence(params.get(LIVE_REFRESH_PARAM));

  const [paused, setPaused] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  );
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  // The interval closes over `reload`; keeping it in a ref means changing the
  // callback identity never restarts the timer mid-cycle.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  const setSeconds = useCallback(
    (next: LiveRefreshSeconds) => {
      setParams(
        (current) => {
          const url = new URLSearchParams(current);
          // The default is never written: a shared link carries the cadence only
          // when the operator deliberately changed it.
          if (next === LIVE_REFRESH_DEFAULT) url.delete(LIVE_REFRESH_PARAM);
          else url.set(LIVE_REFRESH_PARAM, next === 0 ? 'off' : String(next));
          return url;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Bumped by every explicit refresh so the interval effect tears down and
  // starts again: a manual read is a read, and the next automatic one is a full
  // cadence away from it (#1848). Without this, hitting Refresh at t=29 s of a
  // 30 s cadence fired a second full cockpit refetch one second later.
  const [phase, setPhase] = useState(0);

  const refreshNow = useCallback(() => {
    setLastRefreshedAt(new Date());
    setPhase((n) => n + 1);
    reloadRef.current();
  }, []);

  // Suspend while the tab is hidden, and take one fresh reading on return so the
  // operator never reads a screen that went stale while they were away.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      const hidden = document.visibilityState === 'hidden';
      setPaused(hidden);
      if (!hidden && seconds > 0) {
        setLastRefreshedAt(new Date());
        reloadRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [seconds]);

  useEffect(() => {
    if (seconds === 0 || paused) return;
    const id = setInterval(() => {
      setLastRefreshedAt(new Date());
      reloadRef.current();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [seconds, paused, phase]);

  return { seconds, setSeconds, paused, lastRefreshedAt, refreshNow };
}
