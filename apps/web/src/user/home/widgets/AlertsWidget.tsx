import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { Alert } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { ALERTS_QUERY_KEY, listAlerts } from '../../../lib/alertsApi';
import { cx } from '../../../lib/cx';
import { formatDateTime } from '../../../lib/format';
import { Empty, SkeletonBlock } from '../../../ui/origin';
import type { WidgetProps } from './types';

/**
 * How many alerts are armed, how many have fired, and the last few that did.
 *
 * Reads the alerts CRUD surface under its own `['alerts']` key, so the widget and
 * the alerts page share one entry. Unscoped: an alert is attached to an asset,
 * not to a portfolio.
 *
 * The counts block is itself the link to `/workbench/alerts` — a large target
 * covering most of the widget, which is as close to "the whole widget links
 * there" as valid markup allows once the triggered rows carry their own asset
 * links (an anchor cannot nest anchors, and a click-handler div would take the
 * keyboard and screen-reader affordances away from both).
 */

/** Fired alerts listed at most; the page has the rest. */
const MAX_ROWS = 3;

/** Newest fire first. An alert with no timestamp sorts last — it cannot be "recent". */
function byMostRecentFire(a: Alert, b: Alert): number {
  if (a.lastTriggeredAt === null) return b.lastTriggeredAt === null ? 0 : 1;
  if (b.lastTriggeredAt === null) return -1;
  return b.lastTriggeredAt.localeCompare(a.lastTriggeredAt);
}

export function AlertsWidget({ size }: WidgetProps) {
  const t = useT();
  const alertsQuery = useQuery({
    queryKey: ALERTS_QUERY_KEY,
    queryFn: ({ signal }) => listAlerts(signal),
    staleTime: 60_000,
  });

  if (alertsQuery.isLoading) return <SkeletonBlock height={86} />;

  const alerts = alertsQuery.data?.items ?? [];
  if (alerts.length === 0) return <Empty title={t('home.widgets.alerts.empty')} />;

  const armed = alerts.filter((alert) => alert.status === 'active').length;
  const fired = alerts.filter((alert) => alert.status === 'triggered');
  const recent = [...fired].sort(byMostRecentFire).slice(0, size === 's' ? 2 : MAX_ROWS);

  return (
    <div>
      <Link className="bt-home-alerts" to="/workbench/alerts">
        <span className="bt-home-alerts__stat">
          <span className="bt-home-alerts__value">{armed}</span>
          <span className="bt-label">{t('home.widgets.alerts.armed')}</span>
        </span>
        <span className="bt-home-alerts__stat">
          {/*
            Gold, not the negative palette: a fired alert is something to look at,
            not a loss. pos/neg ink stays reserved for actual gain/loss polarity.
          */}
          <span className={cx('bt-home-alerts__value', fired.length > 0 && 'is-hot')}>
            {fired.length}
          </span>
          <span className="bt-label">{t('home.widgets.alerts.triggered')}</span>
        </span>
      </Link>
      {recent.length > 0 ? (
        <ul className="bt-band bt-home-alerts__list">
          {recent.map((alert) => (
            <li className="bt-home-row bt-home-row--split" key={alert.id}>
              <span className="bt-home-row__main">
                <Link className="bt-row-title bt-home-txn__link" to={`/assets/${alert.asset.id}`}>
                  {alert.asset.symbol}
                </Link>
              </span>
              {alert.lastTriggeredAt !== null ? (
                <span className="bt-meta">{formatDateTime(alert.lastTriggeredAt)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
