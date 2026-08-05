import { useT } from '../../i18n';
import { ComingSoon } from '../../ui';
import { WatchlistsPage } from './WatchlistsPage';

/**
 * Workbench stub pages (PROJECTPLAN.md §6.4, §7.2). The Origin redesign mounts
 * these under the WorkbenchLayout tabs; Backtests and Calculators run inside
 * each Blueprint's detail page today, so their tabs render designed
 * placeholders until the standalone workspaces build.
 */

/** Named watchlists — create/rename/delete + per-list audience (§13.3 V3-P5). */
export function WatchlistPage() {
  return <WatchlistsPage />;
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
