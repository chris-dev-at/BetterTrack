import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useLiveRefresh, type LiveRefreshSeconds } from './useLiveRefresh';

/**
 * The cockpit's live refresh (#1406 W4).
 *
 * W1's rule — "an operator page that refetches on a timer is a page that quietly
 * hammers the box it is meant to watch" — is why these tests exist. Each one
 * pins one of the properties that make the exception to that rule defensible:
 * the cadence is in the URL, a hidden tab polls nothing, and turning it off
 * really stops it.
 */

function Probe({ onReload }: { onReload: () => void }) {
  const live = useLiveRefresh(onReload);
  const location = useLocation();
  return (
    <div>
      <span data-testid="seconds">{live.seconds}</span>
      <span data-testid="paused">{String(live.paused)}</span>
      <span data-testid="search">{location.search}</span>
      <button onClick={() => live.setSeconds(0)} type="button">
        off
      </button>
      <button onClick={() => live.setSeconds(15 as LiveRefreshSeconds)} type="button">
        fifteen
      </button>
      <button onClick={live.refreshNow} type="button">
        now
      </button>
    </div>
  );
}

function renderProbe(entry = '/admin/health') {
  const onReload = vi.fn();
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Probe onReload={onReload} />
    </MemoryRouter>,
  );
  return onReload;
}

let visibility: 'visible' | 'hidden' = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('defaults to 30 s and does not write the default into the URL', () => {
  renderProbe();

  expect(screen.getByTestId('seconds')).toHaveTextContent('30');
  // A shared link carries the cadence only when it was deliberately changed.
  expect(screen.getByTestId('search')).toHaveTextContent('');
});

test('polls on the cadence', () => {
  const onReload = renderProbe();

  act(() => {
    vi.advanceTimersByTime(30_000);
  });
  expect(onReload).toHaveBeenCalledTimes(1);

  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(onReload).toHaveBeenCalledTimes(3);
});

test('reads the cadence out of the URL, so it survives reload and sharing', () => {
  const onReload = renderProbe('/admin/health?live=15');

  expect(screen.getByTestId('seconds')).toHaveTextContent('15');
  act(() => {
    vi.advanceTimersByTime(15_000);
  });
  expect(onReload).toHaveBeenCalledTimes(1);
});

test('`off` in the URL stops polling entirely', () => {
  const onReload = renderProbe('/admin/health?live=off');

  expect(screen.getByTestId('seconds')).toHaveTextContent('0');
  act(() => {
    vi.advanceTimersByTime(10 * 60_000);
  });
  expect(onReload).not.toHaveBeenCalled();
});

test('turning it off writes `off` to the URL and halts the timer', () => {
  const onReload = renderProbe();

  act(() => {
    screen.getByRole('button', { name: 'off' }).click();
  });
  expect(screen.getByTestId('search')).toHaveTextContent('live=off');

  act(() => {
    vi.advanceTimersByTime(5 * 60_000);
  });
  expect(onReload).not.toHaveBeenCalled();
});

test('an unknown cadence falls back to the default instead of polling wildly', () => {
  renderProbe('/admin/health?live=1');
  expect(screen.getByTestId('seconds')).toHaveTextContent('30');
});

// The exact case W1's no-polling rule was written about: a console left open on
// a second monitor must not keep hitting the box it is meant to watch.
test('a hidden tab polls nothing, and takes one fresh reading on return', () => {
  const onReload = renderProbe();

  act(() => {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(screen.getByTestId('paused')).toHaveTextContent('true');

  act(() => {
    vi.advanceTimersByTime(10 * 60_000);
  });
  expect(onReload).not.toHaveBeenCalled();

  act(() => {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // One read on return, so the operator never studies a screen that went stale.
  expect(onReload).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('paused')).toHaveTextContent('false');
});

test('a hidden tab with polling off does not refetch on return either', () => {
  const onReload = renderProbe('/admin/health?live=off');

  act(() => {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  act(() => {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(onReload).not.toHaveBeenCalled();
});

/**
 * #1848: `refreshNow`'s doc promises "refresh now AND restart the interval",
 * but the interval effect only depended on `[seconds, paused]`, so it never
 * re-phased. Pressing Refresh at t=29 s of a 30 s cadence fired a second full
 * cockpit refetch one second later — the exact hammering W1's rule forbids.
 */
test('a manual refresh re-phases the interval instead of stacking a second read', () => {
  const onReload = renderProbe();

  act(() => {
    vi.advanceTimersByTime(29_000);
  });
  expect(onReload).not.toHaveBeenCalled();

  act(() => {
    screen.getByRole('button', { name: 'now' }).click();
  });
  expect(onReload).toHaveBeenCalledTimes(1);

  // The old phase's tick would have landed here, one second after the manual
  // read. It must not.
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  expect(onReload).toHaveBeenCalledTimes(1);

  // A full cadence after the manual read, and not before, the timer fires again.
  act(() => {
    vi.advanceTimersByTime(28_999);
  });
  expect(onReload).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(onReload).toHaveBeenCalledTimes(2);
});

test('the manual refresh still works with polling switched off', () => {
  const onReload = renderProbe('/admin/health?live=off');

  act(() => {
    screen.getByRole('button', { name: 'now' }).click();
  });
  expect(onReload).toHaveBeenCalledTimes(1);
});

test('stops the timer on unmount', () => {
  const onReload = vi.fn();
  const { unmount } = render(
    <MemoryRouter initialEntries={['/admin/health']}>
      <Probe onReload={onReload} />
    </MemoryRouter>,
  );

  unmount();
  act(() => {
    vi.advanceTimersByTime(5 * 60_000);
  });
  expect(onReload).not.toHaveBeenCalled();
});
