import { useT } from '../../i18n';
import { ComingSoon } from '../../ui';

/**
 * Assets overview stub (PROJECTPLAN.md §6.3, §7.2). The Origin redesign mounts
 * this as the Assets destination's index; the legacy category browser stubs
 * folded into the parked Discover surface (their routes redirect there).
 */
export function AssetsOverviewPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('assets.comingSoon.overview.title')}
      description={t('assets.comingSoon.overview.description')}
      icon="🔍"
    />
  );
}
