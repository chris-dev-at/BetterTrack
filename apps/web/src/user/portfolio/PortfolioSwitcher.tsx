import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { createPortfolio, listPortfolios } from '../../lib/portfolioApi';
import { Icon } from '../../ui/origin';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';
import { CreateChainDialog, MirrorInviteStepDialog } from './MirrorchainPanel';
import { PortfolioIconChip } from './PortfolioIconChip';
import {
  DEFAULT_PORTFOLIO_KIND,
  portfolioIconName,
  portfolioIconTint,
  usePortfolioKinds,
} from './portfolioKinds';

/**
 * Portfolio switcher (PROJECTPLAN.md §6.8, §13.2 V2-P8). A **selector, not a
 * management menu**: it lists the user's active portfolios behind their tinted
 * icon chip (see `portfolioKinds.ts` + `PortfolioIconChip`), switches the active
 * one via the `?portfolio=` routing param (so every scoped view below the layout
 * follows), filters by name, and creates portfolios — plain or group.
 *
 * The trigger is the topbar's one stated fact: a bordered, surfaced control
 * carrying the current portfolio's chip, its name and its default badge. Which
 * portfolio you are looking at is never something the user has to go find.
 *
 * Rename / Archive / Delete / Archived live on `PortfolioSettingsPage`
 * (`/portfolio/settings`), reachable from this menu's footer: changing or
 * destroying a portfolio is a deliberate trip to its settings tab, never a slip
 * in a dropdown you opened to switch.
 *
 * The active portfolio lives in the URL, not in component state, so it survives
 * navigation across the section subnav and is shared with {@link PortfolioPage}
 * through {@link resolveActivePortfolio} reading the same param. On top of the
 * URL, the last selection is remembered per browser session, so leaving the
 * portfolio area (Home, Workbench, …) and coming back without a param restores
 * the portfolio the user was on instead of snapping back to the default.
 */

/** The `?portfolio=<id>` search-param key that names the active portfolio. */
export const ACTIVE_PORTFOLIO_PARAM = 'portfolio';

/**
 * Above this many portfolios the dropdown's search field takes focus on open.
 * The field itself shows from the second portfolio on (below that there is
 * nothing to filter); it only hijacks the keyboard once the list outgrows the
 * eye, so switching between two portfolios stays a single click.
 */
const SEARCH_THRESHOLD = 6;

/** sessionStorage key for the last active portfolio — session-scoped on purpose. */
const LAST_ACTIVE_STORAGE_KEY = 'bt.portfolio.last';

/** Remember (or with null, forget) the last active portfolio for this session. */
export function rememberActivePortfolio(id: string | null) {
  try {
    if (id === null) sessionStorage.removeItem(LAST_ACTIVE_STORAGE_KEY);
    else sessionStorage.setItem(LAST_ACTIVE_STORAGE_KEY, id);
  } catch {
    // Best-effort convenience; without it the view falls back to the default.
  }
}

function recallActivePortfolio(): string | null {
  try {
    return sessionStorage.getItem(LAST_ACTIVE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Resolve which portfolio is active from the routing param and the active list:
 * the param'd portfolio when it is still active, else the one remembered for
 * this session, else the default, else the first, else null. Kept here so the
 * switcher and every scoped page agree exactly.
 */
export function resolveActivePortfolio(
  portfolios: readonly PortfolioSummary[],
  param: string | null,
): PortfolioSummary | null {
  const wanted = param ?? recallActivePortfolio();
  return (
    (wanted ? portfolios.find((p) => p.id === wanted) : undefined) ??
    portfolios.find((p) => p.isDefault) ??
    portfolios[0] ??
    null
  );
}

/**
 * When the portfolio about to be deleted is the current default, the name of the
 * active portfolio that will auto-promote to default in its place: the oldest
 * remaining active row (lowest `sortOrder`, then oldest id), mirroring the API's
 * derived-default rule (§6.8) so the dialog can name it. Null when the target is
 * not the default (nothing promotes) or nothing remains.
 */
export function promotedDefaultName(
  portfolios: readonly PortfolioSummary[],
  deleting: PortfolioSummary,
): string | null {
  if (!deleting.isDefault) return null;
  const remaining = portfolios
    .filter((p) => p.id !== deleting.id && p.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return remaining[0]?.name ?? null;
}

/** The `?portfolio=<id>` search string that pins one portfolio onto a link. */
export function portfolioSearch(portfolioId: string | null | undefined): string {
  return portfolioId ? `?${ACTIVE_PORTFOLIO_PARAM}=${encodeURIComponent(portfolioId)}` : '';
}

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

export function PortfolioSwitcher() {
  const t = useT();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  // Create-group-portfolio flow (V5-P7 §11): the "New group portfolio" menu
  // item opens CreateChainDialog; on success we chain straight into the
  // friend-picker invite step (§4/§11 zero-config AC).
  const [createChainOpen, setCreateChainOpen] = useState(false);
  const [inviteChainId, setInviteChainId] = useState<string | null>(null);
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

  // Every open starts unfiltered — a filter left over from last time would hide
  // the portfolio the user came to pick.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const activeQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });
  const portfolios = useMemo(() => activeQuery.data?.portfolios ?? [], [activeQuery.data]);
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const active = resolveActivePortfolio(portfolios, param);
  const kinds = usePortfolioKinds();

  const showSearch = portfolios.length > 1;
  const autoFocusSearch = portfolios.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      needle === ''
        ? portfolios
        : portfolios.filter((p) => p.name.toLocaleLowerCase().includes(needle)),
    [portfolios, needle],
  );

  // Any explicit selection — a click here or a param'd deep link (⌘K, Home
  // shortcuts) — becomes the session's remembered portfolio, so coming back to
  // the portfolio area without a param lands where the user left off.
  useEffect(() => {
    if (param && active?.id === param) rememberActivePortfolio(param);
  }, [param, active?.id]);

  function setActive(id: string) {
    rememberActivePortfolio(id);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(ACTIVE_PORTFOLIO_PARAM, id);
        return next;
      },
      { replace: true },
    );
  }

  const refetchLists = () => {
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => createPortfolio(name),
    onSuccess: (created) => {
      setActionError(null);
      setCreateOpen(false);
      refetchLists();
      setActive(created.id); // jump straight to the new portfolio
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.code === 'PORTFOLIO_NAME_TAKEN'
          ? t('portfolio.switcher.nameTakenError')
          : t('portfolio.switcher.createError'),
      ),
  });

  // Until a portfolio resolves (first load) the trigger shows the generic glyph
  // on an untinted chip — it states nothing it cannot yet know.
  const activeKind = active ? (kinds[active.id] ?? DEFAULT_PORTFOLIO_KIND) : null;

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('portfolio.switcher.triggerAriaLabel')}
        className={cx('bt-btn bt-portfolio-trigger', open && 'is-open')}
      >
        <PortfolioIconChip
          icon={active && activeKind ? portfolioIconName(active, activeKind) : 'portfolios'}
          size="lg"
          tint={active && activeKind ? portfolioIconTint(active, activeKind) : undefined}
        />
        <span className="bt-portfolio-trigger__name truncate">
          {active?.name ?? t('portfolio.switcher.fallbackName')}
        </span>
        {active?.isDefault ? (
          <span className="bt-badge bt-portfolio-default">
            {t('portfolio.switcher.defaultBadge')}
          </span>
        ) : null}
        <Icon className="bt-portfolio-trigger__chevron" name="chevron-down" size={14} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t('portfolio.switcher.menuAriaLabel')}
          className="bt-popover bt-portfolio-menu"
          style={{ left: 0, top: 'calc(100% + 6px)' }}
        >
          {showSearch ? (
            <div className="bt-portfolio-search" role="none">
              <Icon name="search" size={14} />
              <input
                type="search"
                value={query}
                autoFocus={autoFocusSearch}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('portfolio.switcher.searchAriaLabel')}
                placeholder={t('portfolio.switcher.searchPlaceholder')}
              />
            </div>
          ) : null}

          <div className="bt-portfolio-list">
            {visible.length === 0 ? (
              <p className="bt-portfolio-empty">{t('portfolio.switcher.noMatches')}</p>
            ) : (
              visible.map((p) => {
                const selected = p.id === active?.id;
                const kind = kinds[p.id] ?? DEFAULT_PORTFOLIO_KIND;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => {
                      setActive(p.id);
                      setOpen(false);
                    }}
                    className="bt-menu-item bt-portfolio-option"
                  >
                    <PortfolioIconChip
                      icon={portfolioIconName(p, kind)}
                      tint={portfolioIconTint(p, kind)}
                    />
                    <span className="bt-portfolio-option__name truncate">{p.name}</span>
                    {p.isDefault ? (
                      <span className="bt-badge bt-portfolio-default">
                        {t('portfolio.switcher.defaultBadge')}
                      </span>
                    ) : null}
                    {selected ? (
                      <Icon className="bt-gold bt-portfolio-check" name="check" size={15} />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          <div className="bt-menu-rule" />
          <div className="bt-portfolio-actions">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setActionError(null);
                setCreateOpen(true);
                setOpen(false);
              }}
              className="bt-menu-item"
            >
              <Icon name="plus" size={15} />
              {t('portfolio.switcher.newPortfolio')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setActionError(null);
                setCreateChainOpen(true);
                setOpen(false);
              }}
              className="bt-menu-item"
            >
              <Icon name="users" size={15} />
              {t('portfolio.switcher.newGroupPortfolio')}
            </button>
            <Link
              role="menuitem"
              to={{ pathname: '/portfolio/settings', search: portfolioSearch(active?.id) }}
              onClick={() => setOpen(false)}
              className="bt-menu-item"
            >
              <Icon name="settings" size={15} />
              {t('portfolio.switcher.settingsMenuItem')}
            </Link>
          </div>
        </div>
      ) : null}

      {actionError && !createOpen ? (
        <div className="absolute left-0 top-full z-30 mt-2 w-64">
          <Alert tone="error">{actionError}</Alert>
        </div>
      ) : null}

      {createOpen ? (
        <NewPortfolioDialog
          submitting={createMutation.isPending}
          error={actionError}
          onClose={() => {
            setCreateOpen(false);
            setActionError(null);
          }}
          onSubmit={(name) => createMutation.mutate(name)}
        />
      ) : null}

      {createChainOpen ? (
        <CreateChainDialog
          onClose={() => setCreateChainOpen(false)}
          onCreated={(chainId) => {
            setCreateChainOpen(false);
            refetchLists();
            setInviteChainId(chainId);
          }}
        />
      ) : null}

      {inviteChainId ? (
        <MirrorInviteStepDialog
          chainId={inviteChainId}
          onClose={() => setInviteChainId(null)}
          onDone={() => {
            setInviteChainId(null);
            refetchLists();
          }}
        />
      ) : null}
    </div>
  );
}

/** New-portfolio dialog — a single trimmed-name text field. */
function NewPortfolioDialog({
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 120;

  return (
    <Dialog title={t('portfolio.switcher.createTitle')} onClose={onClose} widthClassName="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(trimmed);
        }}
        className="flex flex-col gap-4"
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('portfolio.switcher.nameLabel')}
          </span>
          <input
            type="text"
            value={name}
            maxLength={120}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            aria-label={t('portfolio.switcher.nameAriaLabel')}
            placeholder={t('portfolio.switcher.namePlaceholder')}
            className={inputClass}
          />
        </label>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!valid || submitting}>
            {submitting ? t('common.saving') : t('portfolio.switcher.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
