import { Link } from 'react-router-dom';

import { useT } from '../../../i18n';
import { Icon, type IconName } from '../../../ui/origin';

/**
 * Where to go next. Ported from the pre-widget Home; the destinations are the
 * four section roots the command center has always pointed at.
 */

const SHORTCUTS: ReadonlyArray<{
  to: string;
  icon: IconName;
  labelKey: string;
  subKey: string;
}> = [
  {
    to: '/portfolio',
    icon: 'portfolios',
    labelKey: 'home.go.portfolio',
    subKey: 'home.go.portfolioSub',
  },
  {
    to: '/workbench',
    icon: 'workbench',
    labelKey: 'home.go.workbench',
    subKey: 'home.go.workbenchSub',
  },
  {
    to: '/assets/search',
    icon: 'search',
    labelKey: 'home.go.research',
    subKey: 'home.go.researchSub',
  },
  { to: '/people', icon: 'people', labelKey: 'home.go.people', subKey: 'home.go.peopleSub' },
];

export function ShortcutsWidget() {
  const t = useT();
  return (
    <div className="bt-home-shortcuts">
      {SHORTCUTS.map((shortcut) => (
        <Link
          className="bt-panel bt-panel--pad bt-home-shortcut"
          key={shortcut.to}
          to={shortcut.to}
        >
          <Icon className="bt-home-shortcut__icon" name={shortcut.icon} size={19} />
          <span>
            <span className="bt-row-title">{t(shortcut.labelKey)}</span>
            <span className="bt-row-sub bt-home-shortcut__sub">{t(shortcut.subKey)}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
