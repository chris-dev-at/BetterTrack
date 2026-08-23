import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PortfolioKind, PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { Icon } from '../../ui/origin';
import { useOverlayEscape } from '../../ui/overlayStack';
import { restoreFocusTo } from '../../ui/useFocusTrap';
import { AsyncReadState } from '../components/AsyncReadState';
import { cx } from '../components/ui';
import { useCreateIntent } from '../components/useCreateIntent';
import { ACTIVE_PORTFOLIO_PARAM, CREATE_INTENT } from '../routeParams';
import { CreateChainDialog, MirrorInviteStepDialog } from './MirrorchainPanel';
import { PortfolioIconChip } from './PortfolioIconChip';
import {
  DEFAULT_PORTFOLIO_KIND,
  isGroupPortfolio,
  portfolioIconName,
  portfolioIconTint,
  portfolioKindsFor,
} from './portfolioKinds';
import { PortfolioWizard } from './wizard/PortfolioWizard';
import { usePortfolioStore } from './PortfolioStoreProvider';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';
import { VaultStateAction } from '../vault/ui/VaultStateAction';
import { useVaultEndpointState } from '../vault/ui/useVaultEndpointState';
import {
  isVaultedPortfolio,
  lockedPortfolioCount,
  portfolioDisplayName,
  type PortfolioVaultStub,
} from './lockedPortfolio';

/**
 * Portfolio switcher (PROJECTPLAN.md §6.8, §13.2 V2-P8). A **selector, not a
 * management menu**: it lists the user's active portfolios behind their tinted
 * icon chip (see `portfolioKinds.ts` + `PortfolioIconChip`), switches the active
 * one via the `?portfolio=` routing param (so every scoped view below the layout
 * follows), filters by name, and offers exactly one way to make another:
 * "Add portfolio", which opens the wizard (`wizard/PortfolioWizard.tsx`). The
 * group-portfolio flow lives inside that wizard now, as its "shared book"
 * branch, rather than as a second menu item nobody could tell apart from the
 * first.
 *
 * The trigger is the topbar's one stated fact: a bordered, surfaced control
 * carrying the current portfolio's chip, its name and its default badge. Which
 * portfolio you are looking at is never something the user has to go find.
 *
 * **Disclosure, not an ARIA menu (#977).** The popover carries a filter field,
 * and `role="menu"` admits only `menuitem*` / `group` / `separator` / `none`
 * children — a textbox is not a legal descendant at any focus state, and the
 * roving single-tab-stop model a menu implies fights the very field this list
 * needs. So this one widget takes ordinary disclosure semantics: a labelled
 * `role="group"` popover, plain buttons in natural tab order, and the selected
 * portfolio marked with `aria-current`. The shared behaviours a menu would have
 * brought are kept explicitly — `useOverlayEscape` closes only the innermost
 * open overlay, and every close path lands focus back on the trigger through
 * {@link restoreFocusTo}. The app's real menus (the account and create menus,
 * the watchlist pickers) have item-only contents and stay on `useMenuKeyboard`.
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

/**
 * The `?portfolio=<id>` search-param key that names the active portfolio. It
 * lives in the leaf `routeParams.ts` (so the command registry can read it
 * without pulling this component's wizard into its module graph) and is
 * re-exported here, where every existing importer already looks for it.
 */
export { ACTIVE_PORTFOLIO_PARAM };

/**
 * Above this many portfolios the dropdown's search field takes focus on open.
 * The field itself shows from the second portfolio on (below that there is
 * nothing to filter); it only takes the caret once the list outgrows the eye,
 * so switching between two portfolios stays a single click. Either way it is
 * the popover's first tab stop, with the rows following it in document order.
 */
const SEARCH_THRESHOLD = 6;

/** sessionStorage key for the last active portfolio — session-scoped on purpose. */
const LAST_ACTIVE_STORAGE_KEY = 'bt.portfolio.last';

/** Ties the trigger to the popover it discloses via `aria-controls`. */
const POPOVER_ID = 'bt-portfolio-switcher-popover';

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
  lockedFallback: string,
): string | null {
  if (!deleting.isDefault) return null;
  const remaining = portfolios
    .filter((p) => p.id !== deleting.id && p.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return remaining[0] ? portfolioDisplayName(remaining[0], lockedFallback) : null;
}

/** The `?portfolio=<id>` search string that pins one portfolio onto a link. */
export function portfolioSearch(portfolioId: string | null | undefined): string {
  return portfolioId ? `?${ACTIVE_PORTFOLIO_PARAM}=${encodeURIComponent(portfolioId)}` : '';
}

export function PortfolioSwitcher() {
  const t = useT();
  const queryClient = useQueryClient();
  const store = usePortfolioStore();
  const privacyMode = useResolvedPrivacyMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  // The footer's one create action: the wizard owns the name, the icon and the
  // POST; this component only activates whatever comes back (see PortfolioWizard).
  const [wizardOpen, setWizardOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Create-group-portfolio flow (V5-P7 §11), unchanged — it is now reached
  // through the wizard's "shared book" branch instead of its own menu item:
  // CreateChainDialog, then straight into the friend-picker invite step
  // (§4/§11 zero-config AC).
  const [createChainOpen, setCreateChainOpen] = useState(false);
  const [chainSeedName, setChainSeedName] = useState('');
  const [inviteChainId, setInviteChainId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // The one control that outlives every overlay this menu opens — the wizard,
  // the group-create dialog and the invite step that replaces it. Focus comes
  // back here however that chain ends.
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Global create links (command palette, shell and empty states) converge on
  // this query flag. Note this component is mounted on EVERY `/portfolio*`
  // surface, so the value it claims is off-limits to the pages below it — see
  // the namespace table in `routeParams.ts`.
  useCreateIntent(CREATE_INTENT.portfolio, () => setWizardOpen(true));

  // Every close path — Escape, an outside click, picking a portfolio, opening
  // the wizard — hands focus back deliberately instead of dropping it on the
  // `<body>` with the popover that held it. The ladder covers the case where
  // the trigger itself is gone by then.
  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    restoreFocusTo([triggerRef.current], { exclude: popoverRef.current });
  }, []);

  // Escape is arbitrated globally so it still fires when focus sits on a
  // non-focusable part of the popover, yet only ever closes the innermost open
  // overlay — the wizard above this popover closes without discarding it.
  useOverlayEscape(open, closeAndRestoreFocus, popoverRef);

  // Every open starts unfiltered — a filter left over from last time would hide
  // the portfolio the user came to pick.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const activeQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
  });
  const portfolios = useMemo(() => activeQuery.data?.portfolios ?? [], [activeQuery.data]);
  const lockedCount = lockedPortfolioCount(portfolios);
  const lockedFallback = t('vault.lockedStub.fallbackAlias');
  const displayName = useCallback(
    (portfolio: PortfolioSummary) => portfolioDisplayName(portfolio, lockedFallback),
    [lockedFallback],
  );
  const param = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const active = resolveActivePortfolio(portfolios, param);
  // Kinds come off the rows this list already carries (board #69) — no second
  // query, so this widget's one AsyncReadState still covers everything it shows.
  const kinds = useMemo(() => portfolioKindsFor(portfolios), [portfolios]);

  const showSearch = portfolios.length > 1;
  const autoFocusSearch = portfolios.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      needle === ''
        ? portfolios
        : portfolios.filter((p) => displayName(p).toLocaleLowerCase().includes(needle)),
    [displayName, portfolios, needle],
  );

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeAndRestoreFocus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [closeAndRestoreFocus, open]);

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

  // Until a portfolio resolves (first load) the trigger shows the generic glyph
  // on an untinted chip — it states nothing it cannot yet know.
  const activeKind = active ? (kinds[active.id] ?? DEFAULT_PORTFOLIO_KIND) : null;

  return (
    <div ref={rootRef} className="bt-portfolio-switcher relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? POPOVER_ID : undefined}
        aria-label={t('portfolio.switcher.triggerAriaLabel')}
        className={cx('bt-btn bt-portfolio-trigger', open && 'is-open')}
      >
        <PortfolioIconChip
          group={active ? isGroupPortfolio(active) : false}
          icon={active && activeKind ? portfolioIconName(active, activeKind) : 'portfolios'}
          size="lg"
          tint={active && activeKind ? portfolioIconTint(active, activeKind) : undefined}
        />
        <span className="bt-portfolio-trigger__name truncate">
          {active ? displayName(active) : t('portfolio.switcher.fallbackName')}
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
          ref={popoverRef}
          id={POPOVER_ID}
          role="group"
          aria-label={t('portfolio.switcher.menuAriaLabel')}
          className="bt-popover bt-portfolio-menu"
          style={{ left: 0, top: 'calc(100% + 6px)' }}
        >
          {showSearch ? (
            <div className="bt-portfolio-search">
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

          <AsyncReadState
            loading={activeQuery.isLoading}
            error={activeQuery.error}
            onRetry={() => void activeQuery.refetch()}
          />

          {activeQuery.data ? (
            <div className="bt-portfolio-list">
              {visible.length === 0 ? (
                <p className="bt-portfolio-empty">{t('portfolio.switcher.noMatches')}</p>
              ) : (
                visible.map((p) => {
                  const selected = p.id === active?.id;
                  const kind = kinds[p.id] ?? DEFAULT_PORTFOLIO_KIND;
                  if (isVaultedPortfolio(p)) {
                    return (
                      <LockedSwitcherRow
                        key={p.id}
                        kind={kind}
                        name={displayName(p)}
                        onSelect={() => {
                          setActive(p.id);
                          closeAndRestoreFocus();
                        }}
                        portfolio={p}
                        selected={selected}
                      />
                    );
                  }
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => {
                        setActive(p.id);
                        closeAndRestoreFocus();
                      }}
                      className="bt-menu-item bt-portfolio-option"
                    >
                      <PortfolioIconChip
                        group={isGroupPortfolio(p)}
                        icon={portfolioIconName(p, kind)}
                        tint={portfolioIconTint(p, kind)}
                      />
                      <span className="bt-portfolio-option__name truncate">{displayName(p)}</span>
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
          ) : null}

          {lockedCount > 0 ? (
            <p className="bt-meta px-3 py-2">
              {t(lockedCount === 1 ? 'vault.lockedStub.countOne' : 'vault.lockedStub.count', {
                count: lockedCount,
              })}
            </p>
          ) : null}

          <div className="bt-menu-rule" />
          <div className="bt-portfolio-actions">
            <button
              type="button"
              onClick={() => {
                setWizardOpen(true);
                // Focus goes back to the trigger before the wizard mounts, so
                // the whole create chain below has a live opener to return to
                // however it ends.
                closeAndRestoreFocus();
              }}
              className="bt-menu-item"
            >
              <Icon name="plus" size={15} />
              {t('portfolio.switcher.addPortfolio')}
            </button>
            <Link
              to={
                active && isVaultedPortfolio(active)
                  ? `/control/privacy?vault=${encodeURIComponent(active.vaultId)}`
                  : { pathname: '/portfolio/settings', search: portfolioSearch(active?.id) }
              }
              onClick={closeAndRestoreFocus}
              className="bt-menu-item"
            >
              <Icon name="settings" size={15} />
              {t('portfolio.switcher.settingsMenuItem')}
            </Link>
          </div>
        </div>
      ) : null}

      {wizardOpen ? (
        <PortfolioWizard
          allowShared={privacyMode !== 'paranoid'}
          onClose={() => setWizardOpen(false)}
          onCreated={(portfolio) => {
            refetchLists();
            setActive(portfolio.id); // jump straight to the new portfolio
          }}
          onSharedBook={(name) => {
            // Straight into the untouched §11 group-create flow below, carrying
            // the name from the wizard's first step.
            setChainSeedName(name);
            setWizardOpen(false);
            setCreateChainOpen(true);
          }}
        />
      ) : null}

      {createChainOpen ? (
        <CreateChainDialog
          initialName={chainSeedName}
          restoreFocusRef={triggerRef}
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
          restoreFocusRef={triggerRef}
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

function LockedSwitcherRow({
  kind,
  name,
  onSelect,
  portfolio,
  selected,
}: {
  kind: PortfolioKind;
  name: string;
  onSelect(): void;
  portfolio: PortfolioVaultStub;
  selected: boolean;
}) {
  const t = useT();
  const state = useVaultEndpointState(portfolio.vaultId);
  return (
    <div className="bt-menu-item bt-portfolio-option flex-wrap" data-vault-stub="true">
      <button
        aria-current={selected ? 'true' : undefined}
        aria-label={name}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onSelect}
        type="button"
      >
        <PortfolioIconChip
          group={false}
          icon={portfolioIconName(portfolio, kind)}
          tint={portfolioIconTint(portfolio, kind)}
        />
        <span className="bt-portfolio-option__name truncate">{name}</span>
        <span className="bt-badge">{t('vault.lockedStub.badge')}</span>
        {selected ? <Icon className="bt-gold" name="check" size={15} /> : null}
      </button>
      {state.data ? (
        <VaultStateAction state={state.data} vaultId={portfolio.vaultId} />
      ) : (
        <button
          className="bt-link text-sm"
          disabled={state.isPending}
          onClick={() => void state.refetch()}
          type="button"
        >
          {state.isError ? t('common.retry') : t('common.loading')}
        </button>
      )}
    </div>
  );
}
