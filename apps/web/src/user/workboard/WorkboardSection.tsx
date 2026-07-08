import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Workboard section shell (PROJECTPLAN.md §6.4, §7.2). Subnav: Overview ·
 * Conglomerates · Watchlists · Alerts, plus the Coming-Soon experiments
 * (Backtests · Calculators · Comparisons · Saved Ideas).
 */
function workboardSubnav(t: TranslateFn): readonly SubNavItem[] {
  return [
    { to: '/workboard', label: t('workboard.section.subnav.overview'), end: true },
    { to: '/workboard/conglomerates', label: t('workboard.section.subnav.conglomerates') },
    { to: '/workboard/watchlist', label: t('workboard.section.subnav.watchlists') },
    { to: '/workboard/alerts', label: t('workboard.section.subnav.alerts') },
    {
      to: '/workboard/backtests',
      label: t('workboard.section.subnav.backtests'),
      comingSoon: true,
    },
    {
      to: '/workboard/calculators',
      label: t('workboard.section.subnav.calculators'),
      comingSoon: true,
    },
    {
      to: '/workboard/comparisons',
      label: t('workboard.section.subnav.comparisons'),
      comingSoon: true,
    },
    { to: '/workboard/ideas', label: t('workboard.section.subnav.savedIdeas'), comingSoon: true },
  ];
}

export function WorkboardLayout() {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <SubNav items={workboardSubnav(t)} />
      <Outlet />
    </div>
  );
}

// ─── Not-yet-built surfaces (own feature issues) ──────────────────────────────

/**
 * The dedicated watchlist view lands with the Workboard overview/watchlist split
 * (§7.3). Until then the working watchlist lives on the Workboard Overview.
 */
export function WatchlistPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('workboard.section.watchlist.title')}
      description={t('workboard.section.watchlist.description')}
    />
  );
}

export function BacktestsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('workboard.section.backtests.title')}
      description={t('workboard.section.backtests.description')}
    />
  );
}

export function CalculatorsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('workboard.section.calculators.title')}
      description={t('workboard.section.calculators.description')}
    />
  );
}

export function ComparisonsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('workboard.section.comparisons.title')}
      description={t('workboard.section.comparisons.description')}
    />
  );
}

export function SavedIdeasPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('workboard.section.savedIdeas.title')}
      description={t('workboard.section.savedIdeas.description')}
    />
  );
}
