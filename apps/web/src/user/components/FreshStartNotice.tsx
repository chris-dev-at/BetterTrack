import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { useAuth } from '../AuthContext';

/**
 * The one-time fresh-start notice — `docs/paranoid-design.md` §17 step 3
 * (PARANOID E9), ruled (C) "backup + wipe" on 2026-08-20.
 *
 *   "Notice: affected accounts get a one-time in-app notice at next login —
 *    'Paranoid mode has a new shape; the old paranoid data was retired with the
 *    old system' — with the create-a-vault CTA. No conversion ceremony, no
 *    legacy passphrase prompt."
 *
 * Three things it deliberately is NOT: a conversion wizard, a legacy-passphrase
 * prompt, and an alarm. §17 retired the old data behind an owner-run verified
 * backup, the account is whole and feature-complete again, and the calm framing is
 * what §21 Q4 asks of this feature's copy generally ("stated calmly … no alarm
 * banners, no bloat").
 *
 * It reads `paranoidFreshStartPending` off the session payload rather than
 * fetching for itself. §17 words the notice as arriving "at next login", which is
 * precisely when the SPA already has a `MeResponse` in hand — so there is no
 * request, no loading flash above the app chrome for the overwhelming majority of
 * accounts that were never wiped, and no second source of truth. The server stays
 * the only authority: acknowledging on one device settles it on every device.
 *
 * Silence-by-default: an account that was never wiped has no wipe receipt, the
 * flag is false, and this renders NOTHING — no chrome, no wrapper.
 */
export function FreshStartNotice() {
  const t = useT();
  const { user, acknowledgeFreshStartNotice } = useAuth();

  // `undefined` means an older server that does not send the field at all. The
  // contract's doctrine is to read that as "unknown", never as "owed" — showing a
  // retirement notice to an account that was never wiped would be far worse than
  // not showing it.
  if (user?.paranoidFreshStartPending !== true) return null;

  return (
    <div
      role="alert"
      data-testid="paranoid-fresh-start-notice"
      className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-5 sm:px-6"
      style={{
        background: 'var(--bt-gold-soft)',
        borderBottom: '1px solid var(--bt-border)',
        color: 'var(--bt-text)',
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="bt-row-title">{t('paranoidFreshStart.title')}</span>
        <p className="bt-soft whitespace-pre-line text-sm/relaxed">
          {t('paranoidFreshStart.body')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link className="bt-btn bt-btn--sm" to="/control/privacy">
          {t('paranoidFreshStart.cta')}
        </Link>
        <button
          type="button"
          onClick={() => void acknowledgeFreshStartNotice()}
          className="bt-btn bt-btn--quiet bt-btn--sm"
        >
          {t('paranoidFreshStart.dismiss')}
        </button>
      </div>
    </div>
  );
}
