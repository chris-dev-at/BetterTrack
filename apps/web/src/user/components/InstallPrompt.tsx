import { useCallback, useEffect, useState } from 'react';

import { useT } from '../../i18n';
import {
  isInstalledDisplay,
  subscribeDisplayMode,
  supportsHomeScreenCoachMark,
} from '../../lib/pwaDisplayMode';
import { Button, Icon } from '../../ui/origin';

/**
 * The install affordance (PROJECTPLAN §7.1, V5-P13b).
 *
 * Two browsers, two truths, one component:
 *   • Chromium fires `beforeinstallprompt`. We stash the event and let the
 *     user's own click call `prompt()` — the gesture requirement means the
 *     native sheet CANNOT be shown without an affordance like this one.
 *   • iOS Safari never fires it and exposes no install API, so the affordance
 *     is a coach mark that names the two taps ("Share → Add to Home Screen")
 *     and nothing more. Since this row IS the iOS app until a native one
 *     exists, that coach mark is not a fallback — it is the primary path.
 *
 * ANTI-BLOAT (owner, binding — §7.1). The card is `position: fixed` in the
 * bottom corner: it is out of the document flow, so it occupies no primary
 * layout on any surface and pushes nothing. It is dismissible with one tap, the
 * dismissal is persisted, and it never returns — an install prompt that comes
 * back is exactly the kind of nagging the rule exists to forbid. It is silent
 * by default: a browser that offers no install path renders NOTHING.
 */

/** One key, two terminal states — both mean "never show this again". */
const STORAGE_KEY = 'bt.pwa.install';
const DISMISSED = 'dismissed';
const INSTALLED = 'installed';

/**
 * The `beforeinstallprompt` event, which no lib.dom.d.ts declares because it is
 * not in any standard — Chromium-only, and typed here from its actual shape.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function readSettled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === DISMISSED || stored === INSTALLED;
  } catch {
    // Private mode / storage disabled: treat as "not settled" and let the user
    // dismiss again. Storage is a convenience here, never a correctness input.
    return false;
  }
}

function writeSettled(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* Nothing to do — the in-memory state already hid the card. */
  }
}

export function InstallPrompt() {
  const t = useT();
  const [settled, setSettled] = useState(readSettled);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installedDisplay, setInstalledDisplay] = useState(isInstalledDisplay);
  const [coachMark, setCoachMark] = useState(false);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event): void => {
      // Chromium's own mini-infobar would otherwise appear beside this card.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => {
      // Permanent, per the acceptance line: an installed app never asks again,
      // including in the browser tab the user installed it from.
      writeSettled(INSTALLED);
      setSettled(true);
      setDeferred(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Resolved after mount, not during render: `supportsHomeScreenCoachMark`
  // reads the user agent, and the display mode can flip without a reload.
  useEffect(() => {
    setCoachMark(supportsHomeScreenCoachMark());
    const sync = (): void => setInstalledDisplay(isInstalledDisplay());
    sync();
    return subscribeDisplayMode(sync);
  }, []);

  const dismiss = useCallback(() => {
    writeSettled(DISMISSED);
    setSettled(true);
  }, []);

  const install = useCallback(() => {
    const event = deferred;
    if (!event) return;
    // Hide immediately: the native sheet owns the interaction from here. But
    // stepping aside is not an answer — only an ACCEPTED install settles this
    // permanently. Cancelling Chromium's sheet is the user declining that sheet,
    // not declining the app forever, and Chromium keeps firing
    // `beforeinstallprompt` on later loads; the card comes back with that fresh
    // event (never with this one — `prompt()` may only be called once). The
    // permanent "no" stays where the user actually gives it: the dismiss button.
    setDeferred(null);
    void (async () => {
      try {
        await event.prompt();
        const choice = await event.userChoice;
        if (choice?.outcome !== 'accepted') return;
      } catch {
        // The sheet could not be shown (already consumed, gesture expired).
        // Nothing was answered, so nothing is persisted.
        return;
      }
      // `appinstalled` normally lands this too; writing it here means an
      // acceptance is respected even where that event never fires.
      writeSettled(INSTALLED);
      setSettled(true);
    })();
  }, [deferred]);

  // Already an app ⇒ nothing to install; settled ⇒ the user has answered.
  if (settled || installedDisplay) return null;
  const mode = deferred ? 'prompt' : coachMark ? 'coach' : null;
  if (mode === null) return null;

  return (
    <div
      aria-labelledby="bt-install-prompt-title"
      className="bt-install-prompt"
      data-testid="pwa-install-prompt"
      role="complementary"
    >
      <div className="bt-install-prompt__text">
        <span className="bt-row-title" id="bt-install-prompt-title">
          {t('pwa.install.title')}
        </span>
        <p className="bt-soft text-sm/relaxed">
          {mode === 'coach' ? t('pwa.install.iosBody') : t('pwa.install.body')}
        </p>
      </div>
      <div className="bt-install-prompt__actions">
        {mode === 'prompt' ? (
          <Button onClick={install} size="sm" variant="primary">
            {t('pwa.install.action')}
          </Button>
        ) : null}
        <button
          aria-label={t('pwa.install.dismiss')}
          className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon"
          data-testid="pwa-install-dismiss"
          onClick={dismiss}
          title={t('pwa.install.dismiss')}
          type="button"
        >
          <Icon name="x" size={15} />
        </button>
      </div>
    </div>
  );
}
