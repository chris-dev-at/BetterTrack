import { useEffect, useState } from 'react';

import { useT } from '../i18n';

const DISMISS_KEY = 'bt.iosInstallHint.dismissed';

/**
 * True on iOS Safari (iPhone/iPad, not the in-app browsers). Detected by
 * user-agent because iOS has no reliable capability check for
 * `beforeinstallprompt` (Safari never fires it — see §13.5 V5-P13b). The extra
 * clauses exclude non-Safari browsers on iOS (which share the WebKit engine
 * but still expose their own share sheet), because "Add to Home Screen"
 * routes through Safari's share sheet only. DuckDuckGo (`DuckDuckGo/…`) and
 * Brave (`Brave/…`) are included alongside the Chrome/Firefox/Edge/Opera
 * tokens — they don't send WebKit's install path either.
 */
function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as Mac; the touch check disambiguates it from a desktop.
  const isIos =
    /iPhone|iPod|iPad/.test(ua) ||
    (ua.includes('Macintosh') && typeof document !== 'undefined' && 'ontouchend' in document);
  if (!isIos) return false;
  // WebKit is a substring on every iOS browser, but only Safari lacks the
  // vendor tokens below. Screening them out leaves iOS Safari alone.
  return !/CriOS|FxiOS|EdgiOS|OPT|DuckDuckGo|Brave|Chrome|Firefox/.test(ua);
}

/** True when the SPA is running as an installed PWA (standalone display mode). */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS Safari sets `navigator.standalone` on the added-to-home-screen shell.
  // The display-mode media query covers Android/Chrome PWAs.
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(display-mode: standalone)').matches;
  }
  return false;
}

/**
 * "Add to Home Screen" hint for iOS Safari (§13.5 V5-P13b). Safari has no
 * `beforeinstallprompt` event — the install path is a manual share-sheet step,
 * which most users never discover. The hint appears exactly for iOS Safari
 * visitors running in a normal browser tab (never inside a standalone-mode
 * shell, never on non-iOS browsers), and stays dismissed permanently for a
 * given device via `localStorage`. Anti-bloat: renders nothing whenever it
 * shouldn't show — no reserved space, no toast portal.
 */
export function IosInstallHint() {
  const t = useT();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isStandalone()) return;
    if (!isIosSafari()) return;
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      // Private mode / storage disabled — treat as not dismissed. The hint
      // just re-renders each visit for that (rare) case.
    }
    if (dismissed) return;
    setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Best-effort — hiding in state still dismisses this session's render.
    }
    setVisible(false);
  };

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={t('ui.iosInstall.title')}
      className="safe-pb-3 safe-px-3 fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-sm items-start gap-3 rounded-xl border border-neutral-700 bg-neutral-900/95 pt-3 text-sm text-neutral-100 shadow-2xl backdrop-blur"
    >
      <div className="flex-1">
        <p className="font-medium">{t('ui.iosInstall.title')}</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          {t('ui.iosInstall.description')}
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('ui.iosInstall.dismiss')}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="6" y1="18" x2="18" y2="6" />
        </svg>
      </button>
    </div>
  );
}
