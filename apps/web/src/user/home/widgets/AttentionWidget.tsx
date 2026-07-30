import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { useT } from '../../../i18n';
import { listNotifications } from '../../../lib/notificationsApi';
import { Icon, SkeletonBlock } from '../../../ui/origin';
import type { WidgetProps } from './types';

/**
 * What needs the user: unread, unarchived notifications. Ported unchanged from
 * the pre-widget Home (same query, same key) — it stands in for the Review inbox
 * until that backend lands.
 */

const LIMIT = 4;

export function AttentionWidget({ size }: WidgetProps) {
  const t = useT();
  const notificationsQuery = useQuery({
    queryKey: ['notifications', 'home'],
    queryFn: ({ signal }) => listNotifications({}, signal),
    staleTime: 30_000,
  });

  if (notificationsQuery.isLoading) return <SkeletonBlock height={92} />;

  const items = (notificationsQuery.data?.items ?? [])
    .filter((item) => item.readAt === null && item.archivedAt === null)
    .slice(0, size === 's' ? 2 : LIMIT);

  if (items.length === 0) {
    return (
      <p className="bt-meta bt-home-clear">
        <Icon className="bt-home-clear__icon" name="check" size={14} />
        {t('home.attention.clear')}
      </p>
    );
  }

  return (
    <div>
      <div className="bt-band">
        {items.map((item) => (
          <div className="bt-home-row" key={item.id}>
            <p className="bt-row-title">{item.title}</p>
            <p className="bt-row-sub">{item.body}</p>
          </div>
        ))}
      </div>
      <Link className="bt-link bt-home-more" to="/review">
        {t('home.attention.review')}
      </Link>
    </div>
  );
}
