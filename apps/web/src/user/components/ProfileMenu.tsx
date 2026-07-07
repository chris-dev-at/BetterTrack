import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { useAuth } from '../AuthContext';
import { cx } from './ui';

/**
 * Top-right profile dropdown (PROJECTPLAN.md §6.11, §7.2). Compact menu:
 * **My Portfolio · Settings · Invite Others [Coming Soon] · Share Profile
 * [Coming Soon] · Logout**. The two sharing entries are inert placeholders in
 * V1; Logout ends the session. Closes on outside-click and Escape.
 */
export function ProfileMenu() {
  const t = useT();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const itemClass =
    'block w-full rounded px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 focus:bg-neutral-800 focus:outline-none';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('nav.accountMenu')}
        className="grid h-9 w-9 place-items-center rounded-full bg-neutral-800 text-sm font-semibold text-neutral-200 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span aria-hidden="true">
          {(user?.username ?? user?.email ?? '?').charAt(0).toUpperCase()}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t('nav.account')}
          className="absolute right-0 z-40 mt-2 w-56 rounded-lg border border-neutral-800 bg-neutral-900 p-1 shadow-xl"
        >
          {user ? (
            <div className="border-b border-neutral-800 px-3 py-2">
              <p className="truncate text-sm font-medium text-neutral-100">{user.username}</p>
              <p className="truncate text-xs text-neutral-500">{user.email}</p>
            </div>
          ) : null}

          <div className="py-1">
            <Link
              to="/portfolio"
              role="menuitem"
              className={itemClass}
              onClick={() => setOpen(false)}
            >
              {t('nav.myPortfolio')}
            </Link>
            <Link
              to="/settings"
              role="menuitem"
              className={itemClass}
              onClick={() => setOpen(false)}
            >
              {t('nav.settings')}
            </Link>
            <button
              type="button"
              role="menuitem"
              disabled
              title={t('common.comingSoon')}
              className={cx(
                itemClass,
                'flex items-center justify-between disabled:cursor-not-allowed disabled:text-neutral-500 disabled:hover:bg-transparent',
              )}
            >
              {t('nav.inviteOthers')}
              <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-neutral-500">
                {t('common.soon')}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled
              title={t('common.comingSoon')}
              className={cx(
                itemClass,
                'flex items-center justify-between disabled:cursor-not-allowed disabled:text-neutral-500 disabled:hover:bg-transparent',
              )}
            >
              {t('nav.shareProfile')}
              <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-neutral-500">
                {t('common.soon')}
              </span>
            </button>
          </div>

          <div className="border-t border-neutral-800 py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void logout();
              }}
              className={cx(itemClass, 'text-neutral-300 hover:text-white')}
            >
              {t('nav.logout')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
