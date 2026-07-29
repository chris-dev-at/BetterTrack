import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { StandingOrder } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDate } from '../../lib/format';
import { listNotifications } from '../../lib/notificationsApi';
import { getPortfolio, listPortfolios } from '../../lib/portfolioApi';
import { listStandingOrders, STANDING_ORDERS_QUERY_KEY } from '../../lib/standingOrdersApi';
import { MoneyText } from '../../ui';
import {
  Badge,
  Icon,
  PageHead,
  SkeletonBlock,
  Stat,
  StatStrip,
  type IconName,
} from '../../ui/origin';
import { useAuth } from '../AuthContext';

/**
 * Home — the scoped command center (PRODUCT_BLUEPRINT.md §5), in the required
 * order: total value first, then what changed, what needs attention, what is
 * upcoming, and where to go next. Aggregates the active portfolios client-side
 * (no all-wealth endpoint yet); attention = unread notifications until the
 * Review inbox backend lands; upcoming = standing-order next runs.
 */
export function HomePage() {
  const t = useT();
  const { user } = useAuth();

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });
  const portfolios = portfoliosQuery.data?.portfolios ?? [];

  // Client-side all-wealth roll-up: one summary fetch per active portfolio.
  const totalsQuery = useQuery({
    queryKey: ['home', 'totals', portfolios.map((p) => p.id)],
    enabled: portfolios.length > 0,
    queryFn: async ({ signal }) => {
      const summaries = await Promise.all(portfolios.map((p) => getPortfolio(p.id, signal)));
      return portfolios.map((portfolio, index) => ({ portfolio, summary: summaries[index]! }));
    },
    staleTime: 60_000,
  });

  const notificationsQuery = useQuery({
    queryKey: ['notifications', 'home'],
    queryFn: ({ signal }) => listNotifications({}, signal),
    staleTime: 30_000,
  });

  const ordersQuery = useQuery({
    queryKey: [...STANDING_ORDERS_QUERY_KEY, 'home'],
    queryFn: ({ signal }) => listStandingOrders(undefined, signal),
    staleTime: 60_000,
  });

  const rows = totalsQuery.data ?? [];
  const netWorth = rows.reduce((sum, row) => sum + row.summary.totals.totalValueEur, 0);
  const invested = rows.reduce((sum, row) => sum + row.summary.totals.investedEur, 0);
  const cash = rows.reduce((sum, row) => sum + row.summary.totals.cashEur, 0);
  const dayChange = rows.reduce((sum, row) => sum + row.summary.totals.dayChangeEur, 0);
  const loading = portfoliosQuery.isLoading || (portfolios.length > 0 && totalsQuery.isLoading);

  const attention = (notificationsQuery.data?.items ?? [])
    .filter((item) => item.readAt === null && item.archivedAt === null)
    .slice(0, 4);
  const upcoming = (ordersQuery.data?.orders ?? [])
    .filter(
      (order): order is StandingOrder & { nextRunDate: string } =>
        order.status === 'active' && order.nextRunDate !== null,
    )
    .sort((a, b) => a.nextRunDate.localeCompare(b.nextRunDate))
    .slice(0, 4);

  const shortcuts: ReadonlyArray<{ to: string; icon: IconName; labelKey: string; subKey: string }> =
    [
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

  return (
    <div>
      <PageHead
        sub={t('home.subtitle')}
        title={user?.username ? `${t('home.greeting')}, ${user.username}` : t('home.greeting')}
      />

      <section aria-label={t('home.netWorth')}>
        <p className="bt-label">{t('home.netWorth')}</p>
        {loading ? (
          <SkeletonBlock height={44} width={280} />
        ) : (
          <p className="bt-hero-value">
            <MoneyText amount={netWorth} />
          </p>
        )}
        <div style={{ marginTop: 18 }}>
          <StatStrip>
            <Stat
              delta={
                rows.length ? t('home.acrossPortfolios', { count: String(rows.length) }) : undefined
              }
              label={t('home.invested')}
              value={loading ? '…' : <MoneyText amount={invested} />}
            />
            <Stat label={t('home.cash')} value={loading ? '…' : <MoneyText amount={cash} />} />
            <Stat
              delta={t('home.today')}
              deltaTone={dayChange >= 0 ? 'pos' : 'neg'}
              label={t('home.dayChange')}
              value={loading ? '…' : <MoneyText amount={dayChange} signed />}
            />
            <Stat label={t('home.portfolios')} value={loading ? '…' : String(rows.length)} />
          </StatStrip>
        </div>
      </section>

      {rows.length > 1 ? (
        <section aria-label={t('home.portfolios')} className="bt-section">
          <h2 className="bt-h2" style={{ marginBottom: 12 }}>
            {t('home.portfolios')}
          </h2>
          <div className="bt-band" style={{ borderBlock: '1px solid var(--bt-border)' }}>
            {rows.map(({ portfolio, summary }) => (
              <Link
                className="bt-band__row"
                key={portfolio.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  paddingInline: 4,
                  color: 'inherit',
                  textDecoration: 'none',
                }}
                to={`/portfolio?portfolio=${portfolio.id}`}
              >
                <span
                  style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span className="bt-row-title">{portfolio.name}</span>
                  {portfolio.isDefault ? <Badge>{t('home.defaultPortfolio')}</Badge> : null}
                </span>
                <span className="bt-num">
                  <MoneyText amount={summary.totals.totalValueEur} />
                </span>
                <span className="bt-num" style={{ width: 110, textAlign: 'right' }}>
                  <MoneyText amount={summary.totals.dayChangeEur} signed />
                </span>
                <Icon name="chevron-right" size={15} style={{ color: 'var(--bt-faint)' }} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div
        className="bt-section"
        style={{
          display: 'grid',
          gap: 26,
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        }}
      >
        <section aria-label={t('home.attention.title')}>
          <div className="bt-section__head" style={{ marginBottom: 10 }}>
            <h2 className="bt-h2">{t('home.attention.title')}</h2>
            <Link className="bt-link" style={{ fontSize: 12.5 }} to="/review">
              {t('home.attention.review')}
            </Link>
          </div>
          {attention.length === 0 ? (
            <p className="bt-meta" style={{ padding: '14px 0' }}>
              <Icon
                name="check"
                size={14}
                style={{ verticalAlign: -2, marginRight: 6, color: 'var(--bt-pos)' }}
              />
              {t('home.attention.clear')}
            </p>
          ) : (
            <div className="bt-band" style={{ borderBlock: '1px solid var(--bt-border)' }}>
              {attention.map((item) => (
                <div className="bt-band__row" key={item.id} style={{ paddingInline: 4 }}>
                  <p className="bt-row-title">{item.title}</p>
                  <p className="bt-row-sub">{item.body}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-label={t('home.upcoming.title')}>
          <div className="bt-section__head" style={{ marginBottom: 10 }}>
            <h2 className="bt-h2">{t('home.upcoming.title')}</h2>
            <Link className="bt-link" style={{ fontSize: 12.5 }} to="/workbench/forecasts">
              {t('home.upcoming.manage')}
            </Link>
          </div>
          {upcoming.length === 0 ? (
            <p className="bt-meta" style={{ padding: '14px 0' }}>
              {t('home.upcoming.empty')}
            </p>
          ) : (
            <div className="bt-band" style={{ borderBlock: '1px solid var(--bt-border)' }}>
              {upcoming.map((order) => (
                <div
                  className="bt-band__row"
                  key={order.id}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingInline: 4 }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="bt-row-title">
                      {order.label ?? order.assetSymbol ?? t('home.upcoming.order')}
                    </span>
                    <span className="bt-row-sub" style={{ display: 'block' }}>
                      {formatDate(order.nextRunDate)}
                    </span>
                  </span>
                  <span className="bt-num">
                    {order.kind === 'buy-asset' ? (
                      `${order.amount} ×`
                    ) : (
                      <MoneyText amount={order.amount} currency={order.currency} />
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="bt-section" aria-label={t('home.go.title')}>
        <h2 className="bt-h2" style={{ marginBottom: 14 }}>
          {t('home.go.title')}
        </h2>
        <div
          style={{
            display: 'grid',
            gap: 10,
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          }}
        >
          {shortcuts.map((shortcut) => (
            <Link
              className="bt-panel bt-panel--pad"
              key={shortcut.to}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                textDecoration: 'none',
                color: 'inherit',
              }}
              to={shortcut.to}
            >
              <Icon name={shortcut.icon} size={19} style={{ color: 'var(--bt-gold)' }} />
              <span>
                <span className="bt-row-title">{t(shortcut.labelKey)}</span>
                <span className="bt-row-sub" style={{ display: 'block' }}>
                  {t(shortcut.subKey)}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
