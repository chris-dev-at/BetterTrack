import { useLocation } from 'react-router-dom';

import { useT } from '../../i18n';
import { adminWorkspaceForTab } from '../adminWorkspaces';
import { NavTabs, type NavTabDefinition } from './ui';

/**
 * The tab strip of a folded workspace (#1406 W2).
 *
 * It reads the IA registry rather than taking a list of tabs, so adding a tab is
 * one edit in `adminWorkspaces.ts` and every page in the workspace picks it up.
 * A page hand-listing its siblings is a list that drifts the first time someone
 * adds a fifth tab.
 *
 * Selecting a tab NAVIGATES: each tab is a real route, so the browser's back
 * button, a bookmark and a ⌘K jump all behave the way they did before the fold.
 * That is also why this is a `nav` of links rather than an ARIA tablist —
 * announcing "tab 2 of 4" and then navigating the whole page away is a promise
 * the control does not keep. The in-page strip on People 360 IS a tablist.
 *
 * Counts are passed in by the page, keyed by route, because the page already
 * reads them — putting them in the shell would add requests to every admin page
 * load, which is exactly the trade W1 declined for the sidebar.
 */
export function WorkspaceTabs({ counts }: { counts?: Readonly<Record<string, number>> }) {
  const t = useT();
  const location = useLocation();

  const normalized =
    location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : location.pathname;
  const workspace = adminWorkspaceForTab(normalized);
  if (!workspace?.tabs) return null;

  const tabs: NavTabDefinition[] = workspace.tabs.map((tab) => {
    const count = counts?.[tab.to];
    // A coming-soon tab stays selectable and wears a "soon" chip. Its page says
    // what is planned and what is deliberately not built yet, which is worth
    // more to an operator than a tab that refuses to open.
    if (tab.comingSoon) {
      return {
        key: tab.to,
        to: tab.to,
        label: t(tab.labelKey),
        marker: t('admin.common.soon'),
        ...(tab.comingSoonKey ? { disabledReason: t(tab.comingSoonKey) } : {}),
      };
    }
    return {
      key: tab.to,
      to: tab.to,
      label: t(tab.labelKey),
      ...(count !== undefined ? { count } : {}),
    };
  });

  return <NavTabs label={t(workspace.labelKey)} tabs={tabs} activeTo={normalized} />;
}
