import { Suspense, useMemo } from 'react';
import { Outlet, useLocation, useSearchParams } from 'react-router-dom';

import { useQuery } from '@tanstack/react-query';

import { useT } from '../../i18n';
import { Skeleton } from '../../ui';
import { LocalNav, usePreservedSearch } from '../components/LocalNav';
import { SECTION_NAV, useSectionNavItems } from '../components/sectionNav';
import { Button, SubTabLink } from '../../ui/origin';
import { isParanoidKilledPath } from '../vault/ui/ParanoidSurfaceGate';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from './PortfolioSwitcher';
import { useVaultedPortfolioStores } from '../vault/useVaultedPortfolioStores';
import type { UnlockedVaultPortfolioAccess } from '../vault/resolvedPortfolioStore';
import { LockedPortfolioStub } from './LockedPortfolioStub';
import { isVaultedPortfolio } from './lockedPortfolio';
import { usePortfolioStore } from './PortfolioStoreProvider';
import { UnlockedVaultPortfolio } from './UnlockedVaultPortfolio';

/**
 * The portfolio workspace (PRODUCT_BLUEPRINT.md §4 "Portfolio-local
 * navigation"): one portfolio, every job around it as local tabs. Live tabs
 * mount the real feature pages; parked tabs (gold dot) render their designed
 * parking surface until their build lands. The active portfolio rides in
 * `?portfolio=<id>` and is preserved across every tab (#322).
 *
 * The tab set itself lives in `components/sectionNav.ts` — the rail's
 * Portfolios group renders the very same children, and this strip only shows
 * where the rail is hidden (≤760px).
 */
export function PortfolioWorkspace() {
  const t = useT();
  const store = usePortfolioStore();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const items = useSectionNavItems('portfolio');
  const portfolios = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: 60_000,
  });
  const active = useMemo(
    () =>
      resolveActivePortfolio(
        portfolios.data?.portfolios ?? [],
        searchParams.get(ACTIVE_PORTFOLIO_PARAM),
      ),
    [portfolios.data, searchParams],
  );
  const roster = useMemo(() => portfolios.data?.portfolios ?? [], [portfolios.data]);
  const { unlocked } = useVaultedPortfolioStores(roster);
  // Membership alone no longer decides the fork (#1416). A vaulted portfolio is
  // LOCKED unless this device holds a live resolution for it — the currency
  // check is synchronous and re-asked on every render, so the moment the vault
  // locks the very next paint is the stub again, with no decrypted name or
  // figure surviving into it.
  const vaulted = isVaultedPortfolio(active);
  const opened = vaulted ? currentAccess(unlocked.get(active.id)) : null;
  const locked = vaulted && opened === null;
  // A locked stub has one job: lead to its state action. Portfolio operations,
  // including Import, never remain as tempting dead-end tabs around it.
  //
  // Only a KNOWN-locked portfolio collapses the strip. Collapsing it while the
  // list is still in flight would blank the local nav down to Overview on every
  // cold load of the hot path — the page body below already refuses to render
  // anything but a skeleton until the same read resolves, so nothing leaks.
  //
  // An UNLOCKED vaulted portfolio keeps the strip collapsed too (#1416), but
  // the reason has narrowed since #1532 and is worth stating exactly, because
  // the old one ("every row read refuses") is no longer true.
  //
  // The resolver-backed store now serves the full row projection set out of the
  // authenticated document, which is what the Overview's recent-transactions
  // list and cash-source picker read. What the other tabs need is not that
  // store: Activity is still a Coming-Soon placeholder, Cash/Analysis/Tax/Import
  // call the server API modules directly rather than through
  // `usePortfolioStore`, and for a sealed portfolio the server has nothing to
  // answer with. Routing those surfaces at the store seam is its own piece of
  // work; until then, offering a tab that can only report unavailability is
  // worse than not offering it — and the collapse is what today's LOCKED
  // behaviour already is, so nothing regresses on the way in or out of the vault.
  const visibleItems = vaulted ? items.filter((item) => item.to === '/portfolio') : items;
  // The one route the client store can answer. Deep-linking to any other
  // portfolio tab while unlocked lands on the strip alone rather than on a page
  // whose every read refuses — the same "nothing broken on screen" the locked
  // stub gives that URL today.
  const onOverview = location.pathname === '/portfolio';

  return (
    <div>
      <LocalNav
        ariaLabel={t(SECTION_NAV.portfolio.ariaLabelKey)}
        items={visibleItems}
        preserveParams={SECTION_NAV.portfolio.preserveParams}
      />
      {/* Skeleton, not `null` (§7.1): the layout and its LocalNav stay put and
          only the page area waits, so a cold page still says it is loading. */}
      <Suspense fallback={<Skeleton className="rounded-md" height="h-64" />}>
        {portfolios.isPending ? (
          <Skeleton className="rounded-md" height="h-64" />
        ) : portfolios.isError ? (
          <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
            <span>{t('common.unavailable')}</span>
            <Button onClick={() => void portfolios.refetch()} size="sm" type="button">
              {t('common.retry')}
            </Button>
          </div>
        ) : locked ? (
          <LockedPortfolioStub portfolio={active} />
        ) : opened && isVaultedPortfolio(active) ? (
          <UnlockedVaultPortfolio access={opened} portfolio={active}>
            {onOverview ? <Outlet /> : null}
          </UnlockedVaultPortfolio>
        ) : (
          <Outlet />
        )}
      </Suspense>
    </div>
  );
}

/**
 * An access object only counts while it says it is current, and a currency
 * check that THROWS is a revoked session — never a live one. Both readings
 * collapse to "render the stub", which is the safe direction.
 */
function currentAccess(
  access: UnlockedVaultPortfolioAccess | undefined,
): UnlockedVaultPortfolioAccess | null {
  if (access === undefined) return null;
  try {
    return access.isCurrent() ? access : null;
  } catch {
    return null;
  }
}

/**
 * CASH, inside the portfolio workspace (V5 cash fusion; restructured on the
 * owner's call, 2026-07-31).
 *
 * THREE TABS, because only three of these are questions about money:
 *
 *   Overview   how much do I have, and where?
 *   Movements  where did it go?
 *   Budgets    am I on track?
 *
 * It had SEVEN. Tags, Rules, Cash accounts and the parked importer are all
 * SETUP — each visited once and then never again — and putting them beside the
 * three real questions made the area read as a pile of settings rather than a
 * place to look at your money. They did not go away: accounts hang off the
 * balance strip on Overview, tags and rules merged into one "Labels" page
 * (a tag is the label, a rule is how it gets applied — two halves of one idea)
 * linked from Movements, and the parked importer keeps its URL but leaves the
 * navigation until there is something behind it.
 *
 * Every tab is scoped to the SAME active portfolio, so `?portfolio=<id>` is
 * preserved across them exactly like every other section's local nav (#322).
 *
 * The i18n keys stay under the legacy `cashflow.*` namespace: they are internal
 * identifiers, and renaming ~110 of them during a redesign buys nothing a
 * reader can see while risking a raw key on screen.
 */
export function CashLayout() {
  const t = useT();
  const location = useLocation();
  const search = usePreservedSearch([ACTIVE_PORTFOLIO_PARAM]);
  const paranoid = useResolvedPrivacyMode() === 'paranoid';

  const subtabs = [
    { to: '/portfolio/cash', label: t('cashflow.tabs.overview'), end: true },
    { to: '/portfolio/cash/movements', label: t('cashflow.tabs.movements') },
    { to: '/portfolio/cash/budgets', label: t('cashflow.tabs.budgets') },
  ];

  return (
    <div>
      <nav aria-label={t('cashflow.aria')} className="bt-subtabs" style={{ marginBottom: 20 }}>
        {subtabs
          .filter((tab) => !paranoid || !isParanoidKilledPath(tab.to))
          .map((tab) => (
            <SubTabLink
              end={tab.end}
              key={tab.to}
              to={search ? { pathname: tab.to, search } : tab.to}
            >
              {tab.label}
            </SubTabLink>
          ))}
      </nav>
      {/* Skeleton, not `null` (§7.1): the layout and its LocalNav stay put and
          only the page area waits, so a cold page still says it is loading. */}
      <Suspense fallback={<Skeleton className="rounded-md" height="h-64" />}>
        <Outlet key={location.pathname} />
      </Suspense>
    </div>
  );
}
