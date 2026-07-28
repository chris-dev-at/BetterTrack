import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { getPortfolio, listPortfolios } from '../../lib/portfolioApi';
import { MoneyText } from '../../ui';
import { Icon, PageHead, SkeletonBlock, Stat, StatStrip, type IconName } from '../../ui/origin';
import { useAuth } from '../AuthContext';

/**
 * Home — the scoped command center (PRODUCT_BLUEPRINT.md §5): total wealth
 * first, then what changed, what needs attention, what is upcoming, and where
 * to go next. V1 aggregates the active portfolios client-side; the deeper
 * change/attention feeds arrive with their backends.
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

  const rows = totalsQuery.data ?? [];
  const netWorth = rows.reduce((sum, row) => sum + row.summary.totals.totalValueEur, 0);
  const invested = rows.reduce((sum, row) => sum + row.summary.totals.investedEur, 0);
  const cash = rows.reduce((sum, row) => sum + row.summary.totals.cashEur, 0);
  const dayChange = rows.reduce((sum, row) => sum + row.summary.totals.dayChangeEur, 0);
  const loading = portfoliosQuery.isLoading || (portfolios.length > 0 && totalsQuery.isLoading);

  const shortcuts: ReadonlyArray<{ to: string; icon: IconName; labelKey: string; subKey: string }> = [
    { to: '/portfolio', icon: 'portfolios', labelKey: 'home.go.portfolio', subKey: 'home.go.portfolioSub' },
    { to: '/workbench', icon: 'workbench', labelKey: 'home.go.workbench', subKey: 'home.go.workbenchSub' },
    { to: '/assets/search', icon: 'search', labelKey: 'home.go.research', subKey: 'home.go.researchSub' },
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
                rows.length
                  ? t('home.acrossPortfolios', { count: String(rows.length) })
                  : undefined
              }
              label={t('home.invested')}
              value={loading ? '…' : <MoneyText amount={invested} />}
            />
            <Stat
              label={t('home.cash')}
              value={loading ? '…' : <MoneyText amount={cash} />}
            />
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
              style={{ display: 'flex', alignItems: 'flex-start', gap: 12, textDecoration: 'none', color: 'inherit' }}
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
