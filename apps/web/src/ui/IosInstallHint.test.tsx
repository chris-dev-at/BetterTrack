import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { IosInstallHint } from './IosInstallHint';

/**
 * V5-P13b — the iOS "Add to Home Screen" nudge must fire ONLY on iOS Safari
 * running in a normal tab (never inside standalone, never on non-iOS browsers,
 * never a second time once dismissed). These tests pin down each self-gate so
 * a future UA-string regression is caught.
 */

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0 Mobile/15E148 Safari/604.1';
const IPHONE_DUCKDUCKGO_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 DuckDuckGo/7 Safari/605.1.15';
const IPHONE_BRAVE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1 Brave/1.60';
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const STORAGE_KEY = 'bt.iosInstallHint.dismissed';

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

function setStandalone(value: boolean): void {
  Object.defineProperty(navigator, 'standalone', { value, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  setStandalone(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('IosInstallHint', () => {
  test('shows the hint on iOS Safari in a normal browser tab', () => {
    setUserAgent(IPHONE_SAFARI_UA);
    render(<IosInstallHint />);
    expect(screen.getByRole('region')).toHaveTextContent(/Install BetterTrack/i);
  });

  test('does not render on iOS Chrome (Add to Home Screen lives in Safari)', () => {
    setUserAgent(IPHONE_CHROME_UA);
    render(<IosInstallHint />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  test('does not render on iOS DuckDuckGo (own share sheet, no Safari install path)', () => {
    setUserAgent(IPHONE_DUCKDUCKGO_UA);
    render(<IosInstallHint />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  test('does not render on iOS Brave (own share sheet, no Safari install path)', () => {
    setUserAgent(IPHONE_BRAVE_UA);
    render(<IosInstallHint />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  test('does not render on desktop Chrome', () => {
    setUserAgent(DESKTOP_CHROME_UA);
    render(<IosInstallHint />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  test('does not render inside iOS standalone mode', () => {
    setUserAgent(IPHONE_SAFARI_UA);
    setStandalone(true);
    render(<IosInstallHint />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  test('dismissing hides the hint and persists across renders', async () => {
    const user = userEvent.setup();
    setUserAgent(IPHONE_SAFARI_UA);
    const first = render(<IosInstallHint />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');

    // A fresh mount reads the persisted dismissal and stays hidden.
    first.unmount();
    render(<IosInstallHint />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  test('a pre-existing dismissal keeps the hint hidden on first render', () => {
    setUserAgent(IPHONE_SAFARI_UA);
    window.localStorage.setItem(STORAGE_KEY, '1');
    render(<IosInstallHint />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});
