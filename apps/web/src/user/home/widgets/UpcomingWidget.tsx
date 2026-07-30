import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { StandingOrder } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDate } from '../../../lib/format';
import { listStandingOrders, STANDING_ORDERS_QUERY_KEY } from '../../../lib/standingOrdersApi';
import { MoneyText } from '../../../ui';
import { SkeletonBlock } from '../../../ui/origin';
import type { WidgetProps } from './types';

/**
 * What is scheduled next: active standing orders by next run date. Ported
 * unchanged from the pre-widget Home (same query, same key).
 */

const LIMIT = 4;

export function UpcomingWidget({ size }: WidgetProps) {
  const t = useT();
  const ordersQuery = useQuery({
    queryKey: [...STANDING_ORDERS_QUERY_KEY, 'home'],
    queryFn: ({ signal }) => listStandingOrders(undefined, signal),
    staleTime: 60_000,
  });

  if (ordersQuery.isLoading) return <SkeletonBlock height={92} />;

  const orders = (ordersQuery.data?.orders ?? [])
    .filter(
      (order): order is StandingOrder & { nextRunDate: string } =>
        order.status === 'active' && order.nextRunDate !== null,
    )
    .sort((a, b) => a.nextRunDate.localeCompare(b.nextRunDate))
    .slice(0, size === 's' ? 2 : LIMIT);

  if (orders.length === 0)
    return <p className="bt-meta bt-home-clear">{t('home.upcoming.empty')}</p>;

  return (
    <div>
      <div className="bt-band">
        {orders.map((order) => (
          <div className="bt-home-row bt-home-row--split" key={order.id}>
            <span className="bt-home-row__main">
              <span className="bt-row-title">
                {order.label ?? order.assetSymbol ?? t('home.upcoming.order')}
              </span>
              <span className="bt-row-sub bt-home-row__sub">{formatDate(order.nextRunDate)}</span>
            </span>
            <span className="bt-num">
              {order.kind === 'buy-asset' ? (
                t('home.widgets.upcoming.units', { count: order.amount })
              ) : (
                <MoneyText amount={order.amount} currency={order.currency} />
              )}
            </span>
          </div>
        ))}
      </div>
      <Link className="bt-link bt-home-more" to="/workbench/forecasts">
        {t('home.upcoming.manage')}
      </Link>
    </div>
  );
}
