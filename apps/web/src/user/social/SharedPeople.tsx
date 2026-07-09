import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { FriendUser, ShareKind, SharedWithMeResponse } from '@bettertrack/contracts';

import { setActivityAlert } from '../../lib/socialApi';
import { useT, type TranslateFn } from '../../i18n';
import { cx } from '../components/ui';

/**
 * Shared building blocks for the person-centric social surfaces (V3-P6, #384):
 * the grouping of Shared-With-Me into people, the per-kind iconography and
 * read-only deep links, and the per-item activity-alert control. The standalone
 * "Shared with me" tab was retired (#384) — these now live inside the **Friends**
 * overview (a friend's shares with me), which is the single home for who-shares-what.
 */

// ── Grouping ─────────────────────────────────────────────────────────────────

export interface SharedPerson {
  owner: FriendUser;
  portfolios: SharedWithMeResponse['portfolios'];
  conglomerates: SharedWithMeResponse['conglomerates'];
  watchlists: SharedWithMeResponse['watchlists'];
  total: number;
}

/** Group a Shared-With-Me payload by the owner sharing each item, ordered by username. */
export function groupSharedByPerson(shared: SharedWithMeResponse): SharedPerson[] {
  const byId = new Map<string, SharedPerson>();
  const ensure = (owner: FriendUser): SharedPerson => {
    let p = byId.get(owner.id);
    if (!p) {
      p = { owner, portfolios: [], conglomerates: [], watchlists: [], total: 0 };
      byId.set(owner.id, p);
    }
    return p;
  };
  for (const p of shared.portfolios) ensure(p.owner).portfolios.push(p);
  for (const c of shared.conglomerates) ensure(c.owner).conglomerates.push(c);
  for (const w of shared.watchlists) ensure(w.owner).watchlists.push(w);
  const people = [...byId.values()];
  for (const person of people) {
    person.total =
      person.portfolios.length + person.conglomerates.length + person.watchlists.length;
  }
  return people.sort((a, b) => a.owner.username.localeCompare(b.owner.username));
}

/** The one shared person's items for a specific friend id, or `undefined` if nothing. */
export function personFor(
  shared: SharedWithMeResponse | undefined,
  friendId: string,
): SharedPerson | undefined {
  if (!shared) return undefined;
  return groupSharedByPerson(shared).find((p) => p.owner.id === friendId);
}

/** A localized "2 portfolios · 1 watchlist" kind-count summary. */
export function kindCountSummary(person: SharedPerson, t: TranslateFn): string {
  const parts: string[] = [];
  const add = (count: number, kind: 'portfolio' | 'conglomerate' | 'watchlist') => {
    if (count === 0) return;
    parts.push(t(`social.count.${kind}.${count === 1 ? 'one' : 'other'}`, { count }));
  };
  add(person.portfolios.length, 'portfolio');
  add(person.conglomerates.length, 'conglomerate');
  add(person.watchlists.length, 'watchlist');
  return parts.join(' · ');
}

// ── Per-kind chrome ──────────────────────────────────────────────────────────

export function KindIcon({ kind, className }: { kind: ShareKind; className?: string }) {
  const common = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'portfolio') {
    return (
      <svg {...common}>
        <path d="M12 3a9 9 0 1 0 9 9h-9z" />
        <path d="M12 3v9l6.5-6.5A9 9 0 0 0 12 3z" opacity="0.55" />
      </svg>
    );
  }
  if (kind === 'conglomerate') {
    return (
      <svg {...common}>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M3.5 16.5l5-5 3.5 3.5 6-6.5" />
      <path d="M18 8.5h2.5V11" />
    </svg>
  );
}

/** The read-only deep link for one item a friend shares with me. */
export function sharedItemHref(kind: ShareKind, subjectId: string): string {
  if (kind === 'portfolio') return `/social/shared-with-me/${subjectId}`;
  if (kind === 'conglomerate') return `/social/shared-with-me/conglomerates/${subjectId}`;
  return `/social/shared-with-me/watchlists/${subjectId}`;
}

/**
 * One shared item as a row: a read-only deep link (icon + name + secondary line),
 * with an optional `footer` slot beneath it (e.g. the activity-alert control),
 * kept OUTSIDE the link so it doesn't navigate.
 */
export function SharedItemRow({
  kind,
  subjectId,
  name,
  secondary,
  footer,
}: {
  kind: ShareKind;
  subjectId: string;
  name: string;
  secondary?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40 transition-colors hover:border-neutral-700">
      <Link
        to={sharedItemHref(kind, subjectId)}
        className="flex min-w-0 items-center gap-3 px-3 py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-400">
          <KindIcon kind={kind} className="h-5 w-5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-neutral-100">{name}</span>
          {secondary != null && secondary !== '' ? (
            <span className="truncate text-xs text-neutral-500">{secondary}</span>
          ) : null}
        </span>
      </Link>
      {footer != null ? (
        <div className="border-t border-neutral-800 px-3 py-2.5">{footer}</div>
      ) : null}
    </div>
  );
}

// ── Activity-alert control (preference only; delivery is #368) ────────────────

/**
 * The per-shared-item activity-alert opt-in (V3-P6, clarified in #384). A real
 * label + honest subtext ("Get notified when {friend} buys, sells, or updates
 * this" / "Activates when notifications go live") beside the switch, so the
 * control says what it does. Persists the viewer's preference immediately
 * (optimistic); the friend-activity events that light it up arrive with
 * Notifications-v2 (#368), so today it stores intent and nothing more.
 */
export function ActivityAlertToggle({
  kind,
  subjectId,
  enabled,
  friendName,
}: {
  kind: ShareKind;
  subjectId: string;
  enabled: boolean;
  friendName: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [on, setOn] = useState(enabled);

  const mutation = useMutation({
    mutationFn: (next: boolean) => setActivityAlert(kind, subjectId, next),
    onError: () => setOn((v) => !v), // revert the optimistic flip
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'shared-with-me'] });
    },
  });

  const toggle = () => {
    const next = !on;
    setOn(next);
    mutation.mutate(next);
  };

  const label = t('social.activity.notifyLabel', { username: friendName });

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-xs font-medium text-neutral-300">{label}</span>
        <span className="text-[11px] leading-tight text-neutral-500">
          {t('social.activity.dormantHint')}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={on ? t('social.activity.on') : t('social.activity.off')}
        onClick={toggle}
        className={cx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
          on ? 'bg-sky-600' : 'bg-neutral-700',
        )}
      >
        <span
          className={cx(
            'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
            on ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    </div>
  );
}
