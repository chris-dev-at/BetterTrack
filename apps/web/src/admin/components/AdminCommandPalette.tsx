import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import { FEATURE_FLAG_KEYS } from '@bettertrack/contracts';

import { useI18n, useT } from '../../i18n';
import { useOverlayEscape } from '../../ui/overlayStack';
import { useFocusTrap } from '../../ui/useFocusTrap';
import * as api from '../../lib/adminApi';
import { ADMIN_DESTINATIONS, adminWorkspaceLabelKey } from '../adminWorkspaces';
import { useResource } from '../useResource';
import { Badge, cx } from './ui';
import { TAP_TARGET } from './tokens';

/** Per-section caps: enough to be useful, few enough to keep every section visible. */
const DESTINATION_LIMIT = 6;
const USER_LIMIT = 6;
const PROBLEM_LIMIT = 5;
const ANNOUNCEMENT_LIMIT = 5;
const FLAG_LIMIT = 5;
const INVITE_LIMIT = 5;
/** How many open problems are pulled once per palette session to match against. */
const PROBLEM_FETCH_LIMIT = 50;
/**
 * How many invites / registration tokens are pulled once per palette session.
 * Both lists are admin-paged reads with no `search` parameter, so the palette
 * matches client-side over a bounded recent window — the same shape the problems
 * section has used since W1. A window, not the table: an operator who cannot
 * find an invite in the most recent 50 is looking for an old one, and the
 * Invites page (which this row navigates to) is where that search belongs.
 */
const INVITE_FETCH_LIMIT = 50;

/** Same debounce as the Users page, so a fast typist issues one search. */
const SEARCH_DEBOUNCE_MS = 300;

interface PaletteRow {
  id: string;
  to: string;
  label: string;
  meta?: string;
  /** Trailing verb ("Page", "User") or status word — quiet, never an action. */
  verb?: string;
  tone?: 'amber' | 'red';
}

interface PaletteSection {
  key: string;
  labelKey: string;
  rows: PaletteRow[];
  /** Row-shaped, non-interactive note: searching, failed, or nothing found. */
  note?: string;
}

/**
 * The admin console's ⌘K palette (#1406 W1).
 *
 * Navigation only — the decision on #1406 explicitly keeps mutations out of v1,
 * so every row is a destination and Enter is always "go there". Six layers:
 * console destinations from the local workspace registry (instant), feature
 * flags from the contract registry (also instant), users from the existing
 * `GET /admin/users?search=`, and open problems, announcements and invites +
 * registration tokens filtered client-side off their existing admin lists.
 *
 * **Nothing here reads a surface the operator could not already open from the
 * sidebar, and nothing here reads MORE than that surface shows** (#1910). Every
 * remote section calls an endpoint the console already calls from its own page,
 * behind the same `requireAdmin` + admin-2FA fence, and renders the same fields
 * that page renders. The palette removes a navigation step; it is not a new
 * read scope, and a section that needed one would belong on a page instead.
 */
export function AdminCommandPalette({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const { containerRef, onKeyDown: onTrapKeyDown } = useFocusTrap<HTMLDivElement>({
    active: isOpen,
    inertBackground: true,
    initialFocusRef: inputRef,
  });

  useOverlayEscape(isOpen, onClose, containerRef);

  // A fresh open starts empty and at the top of the list.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setDebounced('');
    setActiveIndex(0);
  }, [isOpen]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const trimmed = query.trim();
  // Remote reads only once the palette is open AND a query exists: an empty
  // palette is a destination list, and must not cost an admin-users round trip.
  const remoteQuery = isOpen && debounced.length > 0 ? debounced : null;
  const users = useResource(
    (signal) =>
      remoteQuery === null
        ? Promise.resolve(null)
        : // The list read is paged as of W2; the palette wants the first
          // handful of matches, not the account table.
          api.listUsers({ search: remoteQuery, limit: USER_LIMIT }, signal),
    [remoteQuery],
  );
  // Problems, announcements, invites and registration tokens are all matched
  // client-side, so each list is fetched ONCE per palette session rather than
  // once per query — none of these endpoints takes a search argument, and
  // refetching them on every keystroke batch would be pure waste. The users
  // search stays per-query because `GET /admin/users` does search server-side
  // and the account table is the one list too large to hold.
  //
  // Every one of these is a read the operator can already make from the rail:
  // the palette adds no endpoint and widens no scope, it only removes the step
  // of remembering which page a thing lives on.
  const remoteWanted = remoteQuery !== null;
  const problems = useResource(
    (signal) =>
      remoteWanted
        ? api.listProblems({ status: 'open', limit: PROBLEM_FETCH_LIMIT }, signal)
        : Promise.resolve(null),
    [remoteWanted],
  );
  const announcements = useResource(
    (signal) => (remoteWanted ? api.listAnnouncements(signal) : Promise.resolve(null)),
    [remoteWanted],
  );
  const invites = useResource(
    (signal) =>
      remoteWanted ? api.listInvites({ limit: INVITE_FETCH_LIMIT }, signal) : Promise.resolve(null),
    [remoteWanted],
  );
  const tokens = useResource(
    (signal) =>
      remoteWanted
        ? api.listRegistrationTokens({ limit: INVITE_FETCH_LIMIT }, signal)
        : Promise.resolve(null),
    [remoteWanted],
  );

  const sections = useMemo<PaletteSection[]>(() => {
    // Destinations are local, so they filter on the raw query — waiting 300 ms to
    // reorder a list we already hold would make the palette feel broken. Only the
    // two remote sections wait for the debounced value.
    const local = trimmed.toLowerCase();
    const needle = debounced.toLowerCase();
    const destinations = ADMIN_DESTINATIONS.map((destination) => ({
      destination,
      label: t(destination.labelKey),
      // A folded workspace's landing is ONE row that answers to two names: the
      // page's ("Settings") and the workspace's ("Product & Comms"). The extra
      // names are matched, never rendered — the workspace already shows as the
      // row's `meta` below (#1406 W7c).
      haystack: [destination.labelKey, ...(destination.matchKeys ?? [])].map((key) =>
        t(key).toLowerCase(),
      ),
    }))
      .filter(({ haystack }) => local.length === 0 || haystack.some((name) => name.includes(local)))
      .slice(0, DESTINATION_LIMIT)
      .map(({ destination, label }, index) => {
        const workspaceKey = adminWorkspaceLabelKey(destination.to);
        return {
          id: `admin-palette-p-${index}`,
          to: destination.to,
          label,
          meta: workspaceKey && workspaceKey !== destination.labelKey ? t(workspaceKey) : undefined,
          verb: t('admin.palette.verb.page'),
        } satisfies PaletteRow;
      });

    const built: PaletteSection[] = [
      { key: 'pages', labelKey: 'admin.palette.groups.pages', rows: destinations },
    ];

    if (needle.length === 0) return built;

    const userRows = (users.data?.users ?? []).slice(0, USER_LIMIT).map((user) => {
      const disabled = user.status === 'disabled';
      return {
        id: `admin-palette-u-${user.id}`,
        to: `/admin/users/${user.id}`,
        label: user.username,
        meta: user.email,
        verb: disabled ? t('admin.palette.verb.disabled') : t('admin.palette.verb.user'),
        tone: disabled ? ('red' as const) : undefined,
      } satisfies PaletteRow;
    });
    built.push({
      key: 'users',
      labelKey: 'admin.palette.groups.people',
      rows: userRows,
      note: users.loading
        ? t('admin.palette.searching')
        : users.error
          ? t('admin.palette.usersError')
          : userRows.length === 0
            ? t('admin.palette.noUsers')
            : undefined,
    });

    const problemRows = (problems.data?.problems ?? [])
      .filter((problem) =>
        [problem.title, problem.message, problem.kind].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      )
      .slice(0, PROBLEM_LIMIT)
      .map((problem) => ({
        id: `admin-palette-x-${problem.id}`,
        to: '/admin/problems',
        label: problem.title,
        meta: problem.message,
        verb: t(`admin.problems.kind.${problem.kind}`),
        tone: 'amber' as const,
      }));
    built.push({
      key: 'problems',
      labelKey: 'admin.palette.groups.problems',
      rows: problemRows,
      note: problems.loading
        ? t('admin.palette.searching')
        : problems.error
          ? t('admin.palette.problemsError')
          : problemRows.length === 0
            ? t('admin.palette.noProblems')
            : undefined,
    });

    // Announcements match on EITHER language's title (#1910). An operator who
    // composed the German copy remembers the German words, and a console that
    // only searched the English half would be unfindable to exactly the person
    // who wrote it.
    const announcementRows = (announcements.data?.announcements ?? [])
      .filter((announcement) =>
        [announcement.titleEn, announcement.titleDe].some((title) =>
          title.toLowerCase().includes(needle),
        ),
      )
      .slice(0, ANNOUNCEMENT_LIMIT)
      .map((announcement) => ({
        id: `admin-palette-a-${announcement.id}`,
        to: '/admin/announcements',
        // The operator's own locale decides which title is shown; the match ran
        // over both.
        label: locale === 'de' ? announcement.titleDe : announcement.titleEn,
        meta: locale === 'de' ? announcement.titleEn : announcement.titleDe,
        verb: t(`announcements.severity.${announcement.severity}`),
      }));
    built.push({
      key: 'announcements',
      labelKey: 'admin.palette.groups.announcements',
      rows: announcementRows,
      note: announcements.loading
        ? t('admin.palette.searching')
        : announcements.error
          ? t('admin.palette.announcementsError')
          : announcementRows.length === 0
            ? t('admin.palette.noAnnouncements')
            : undefined,
    });

    // Feature flags are the ONE new section with no fetch at all: the registry is
    // a contract constant and the names are catalog copy, so an operator who
    // types "live" reaches the switch without the palette reading anything. The
    // flags' STATE is deliberately not shown here — the palette navigates, and a
    // stale "On" badge on a kill switch would be worse than no badge.
    const flagRows = FEATURE_FLAG_KEYS.map((key) => ({
      key,
      label: t(`admin.featureFlags.flag.${key}.name`),
    }))
      .filter(
        ({ key, label }) =>
          label.toLowerCase().includes(needle) || key.toLowerCase().includes(needle),
      )
      .slice(0, FLAG_LIMIT)
      .map(({ key, label }) => ({
        id: `admin-palette-f-${key}`,
        to: '/admin/feature-flags',
        label,
        meta: key,
        verb: t('admin.palette.verb.flag'),
      }));
    if (flagRows.length > 0) {
      built.push({
        key: 'flags',
        labelKey: 'admin.palette.groups.flags',
        rows: flagRows,
      });
    }

    // Invites (by e-mail) and registration tokens (by label) share one section:
    // they are the same operator question — "who did we let in, and how" — and
    // they live on two different pages, which is exactly the navigation problem
    // this palette exists to remove. Each row carries the page it belongs to.
    const inviteRows = (invites.data?.invites ?? [])
      .filter((invite) => invite.email.toLowerCase().includes(needle))
      .slice(0, INVITE_LIMIT)
      .map((invite) => ({
        id: `admin-palette-i-${invite.id}`,
        to: '/admin/invites',
        label: invite.email,
        meta: t('admin.nav.invites'),
        verb: t(`admin.invites.status.${invite.status}`),
      }));
    const tokenRows = (tokens.data?.tokens ?? [])
      .filter((token) => (token.label ?? '').toLowerCase().includes(needle))
      .slice(0, INVITE_LIMIT)
      .map((token) => ({
        id: `admin-palette-t-${token.id}`,
        to: '/admin/registration',
        label: token.label ?? '',
        meta: t('admin.nav.registration'),
        verb: t(`admin.settings.tokens.status.${token.status}`),
      }));
    const accessRows = [...inviteRows, ...tokenRows];
    built.push({
      key: 'access',
      labelKey: 'admin.palette.groups.access',
      rows: accessRows,
      note:
        invites.loading || tokens.loading
          ? t('admin.palette.searching')
          : invites.error || tokens.error
            ? t('admin.palette.accessError')
            : accessRows.length === 0
              ? t('admin.palette.noAccess')
              : undefined,
    });

    return built;
  }, [
    announcements.data,
    announcements.error,
    announcements.loading,
    debounced,
    invites.data,
    invites.error,
    invites.loading,
    locale,
    problems.data,
    problems.error,
    problems.loading,
    t,
    tokens.data,
    tokens.error,
    tokens.loading,
    trimmed,
    users.data,
    users.error,
    users.loading,
  ]);

  // "Nothing matches" must never be said about a result that has not arrived, so
  // it is suppressed while ANY section is still in flight — one flag, so adding a
  // section cannot quietly leave it out.
  const anyLoading =
    users.loading || problems.loading || announcements.loading || invites.loading || tokens.loading;

  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const active = rows.length === 0 ? -1 : Math.min(activeIndex, rows.length - 1);
  const activeId = active >= 0 ? rows[active]!.id : undefined;

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed]);

  if (!isOpen) return null;

  const open = (row: PaletteRow) => {
    navigate(row.to);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (Math.min(i, rows.length - 1) + 1) % rows.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (Math.min(i, rows.length - 1) + rows.length - 1) % rows.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(rows.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active];
      if (row) open(row);
    }
  };

  const visible = sections.filter((section) => section.rows.length > 0 || section.note);

  return createPortal(
    <div
      aria-label={t('admin.palette.title')}
      aria-modal="true"
      className="fixed inset-0 z-50 flex justify-center bg-black/60 px-4 pt-16"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={onTrapKeyDown}
      ref={containerRef}
      role="dialog"
      tabIndex={-1}
    >
      {/* Arrow/Enter are caught above the input: the input keeps DOM focus and
          points at the active row through aria-activedescendant. */}
      <div
        className="flex h-fit max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
          <input
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-controls="admin-palette-list"
            aria-expanded="true"
            aria-label={t('admin.palette.inputAria')}
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('admin.palette.placeholder')}
            ref={inputRef}
            role="combobox"
            type="text"
            value={query}
          />
          <kbd className="rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-sans text-[10px] text-neutral-400">
            {t('common.escKey')}
          </kbd>
        </div>

        <ul
          aria-busy={anyLoading || undefined}
          aria-label={t('admin.palette.resultsAria')}
          className="flex-1 overflow-y-auto p-2"
          id="admin-palette-list"
          role="listbox"
        >
          {visible.map((section) => (
            <li key={section.key} role="none">
              <p
                className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500"
                id={`admin-palette-h-${section.key}`}
              >
                {t(section.labelKey)}
              </p>
              <ul
                aria-labelledby={`admin-palette-h-${section.key}`}
                className="flex flex-col"
                role="group"
              >
                {section.rows.map((row) => (
                  <Row
                    key={row.id}
                    onActivate={() => open(row)}
                    onHover={() => setActiveIndex(rows.indexOf(row))}
                    row={row}
                    selected={row.id === activeId}
                  />
                ))}
                {section.note ? (
                  <li
                    aria-disabled="true"
                    className="px-3 py-2 text-xs text-neutral-500"
                    role="option"
                  >
                    {section.note}
                  </li>
                ) : null}
              </ul>
            </li>
          ))}
        </ul>

        {/* Reachable when the query matched nothing ANYWHERE. Keyed on rows, not
            on sections: once a query exists the remote sections always carry a
            note, so a section-count test could never fire. Suppressed while a
            search is still running, so "nothing matches" is never shown about a
            result that has not arrived. */}
        {trimmed.length > 0 && rows.length === 0 && !anyLoading ? (
          <p className="px-4 py-6 text-center text-sm text-neutral-400" role="status">
            {t('admin.palette.noResults', { query: trimmed })}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-500">
          <span>{t('admin.palette.navigateHint')}</span>
          <span>{t('admin.palette.openHint')}</span>
          <span className="ml-auto">{t('admin.palette.scopeNote')}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({
  onActivate,
  onHover,
  row,
  selected,
}: {
  onActivate: () => void;
  onHover: () => void;
  row: PaletteRow;
  selected: boolean;
}) {
  // A listbox option owns no keys of its own — the combobox input does.
  return (
    <li
      aria-selected={selected}
      className={cx(
        'flex min-h-[42px] cursor-pointer items-center gap-3 rounded-md px-3 py-2',
        // 42px is the console's deliberate desktop density and stays; below the
        // drawer handoff these rows ARE the console's destinations, so they take
        // the same 44px floor every other one does (§13.5 V5-P13b, #1891). Same
        // shape as `AdminLayout`'s `NAV_LINK_BASE`: a density utility plus the
        // marker `styles/origin.css` declares the floor for. The phone gate
        // measures the row structurally (`#admin-palette-list [role='option']`),
        // so dropping this class fails the measurement rather than removing the
        // row from it.
        TAP_TARGET,
        selected ? 'bg-neutral-800' : 'hover:bg-neutral-800/60',
      )}
      id={row.id}
      onClick={onActivate}
      onMouseMove={onHover}
      role="option"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-neutral-100">{row.label}</span>
        {row.meta ? <span className="truncate text-xs text-neutral-500">{row.meta}</span> : null}
      </span>
      {row.verb ? (
        <span className="ml-auto shrink-0">
          {row.tone ? (
            <Badge tone={row.tone}>{row.verb}</Badge>
          ) : (
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">{row.verb}</span>
          )}
        </span>
      ) : null}
    </li>
  );
}
