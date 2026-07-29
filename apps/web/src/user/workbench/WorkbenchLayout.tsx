import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { LocalNav, type LocalNavItem } from '../components/LocalNav';

/**
 * Workbench (PRODUCT_BLUEPRINT.md §4): the possibility space — everything here
 * is a draft or a tool until explicitly applied to a portfolio. Blueprints are
 * the renamed Conglomerates; Studio is the parked visual scenario builder.
 */
export function WorkbenchLayout() {
  const t = useT();

  const items: LocalNavItem[] = [
    { to: '/workbench', label: t('workbench.tabs.overview'), end: true },
    { to: '/workbench/studio', label: t('workbench.tabs.studio'), parked: true },
    { to: '/workbench/forecasts', label: t('workbench.tabs.forecasts') },
    { to: '/workbench/blueprints', label: t('workbench.tabs.blueprints') },
    { to: '/workbench/backtests', label: t('workbench.tabs.backtests') },
    { to: '/workbench/compare', label: t('workbench.tabs.compare') },
    { to: '/workbench/ideas', label: t('workbench.tabs.ideas') },
    { to: '/workbench/calculators', label: t('workbench.tabs.calculators') },
    { to: '/workbench/alerts', label: t('workbench.tabs.alerts') },
  ];

  return (
    <div>
      <LocalNav ariaLabel={t('workbench.aria')} items={items} />
      <Outlet />
    </div>
  );
}
