import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { Time } from 'lightweight-charts';

import type { ProfileIconId } from '@bettertrack/contracts';

import { resolveShareLink } from '../../lib/socialApi';
import { formatMoney, formatPercent } from '../../lib/format';
import { classifyApiError } from '../../lib/apiClient';
import { useT } from '../../i18n';
import { Wordmark } from '../../components/Wordmark';
import { PriceChart } from '../../ui/charts';
import { Avatar } from '../components/Avatar';
import { Button, Splash } from '../components/ui';

/**
 * The UNAUTHENTICATED public-link view (§14, §13.3 V3-P5): a logged-out visitor
 * opens `/s/:token`, which resolves the token to a live read-only view of the
 * shared item — and nothing else. A revoked/unknown token, or one whose owner
 * narrowed the audience, renders a friendly "no longer available" (the API 404s).
 *
 * It renders OUTSIDE the app shell, so it puts on the Origin frame itself:
 * `bt-app` supplies the graphite canvas, ivory type and focus ring, and a
 * single centered reading column (the shell's own narrow canvas width) carries
 * a compact wordmark header over the content.
 */

/** The shell's narrow content column, reproduced for the standalone pages. */
const COLUMN = {
  marginInline: 'auto',
  maxWidth: 880,
  paddingInline: 'clamp(16px, 3.4vw, 48px)',
  width: '100%',
} as const;

function Shell({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="bt-app">
      <header className="bt-b-rule">
        <div className="flex items-center justify-between gap-3 py-4" style={COLUMN}>
          <Wordmark edition="Web" className="text-lg" />
          <span className="bt-label">{t('publicShare.readOnly')}</span>
        </div>
      </header>
      <main className="py-10" style={COLUMN}>
        {children}
      </main>
    </div>
  );
}

/**
 * The item's title block, led by the owner's curated profile icon (§6.9: the
 * icon renders wherever a user appears — logged-out visitors included). It reads
 * `owner` straight off the resolved link payload, so the page still asks
 * `GET /social/links/:token` for nothing beyond what it already returned.
 */
function OwnerHead({
  name,
  owner,
}: {
  name: string;
  owner: { username: string; profileIcon?: ProfileIconId | null };
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      <Avatar iconId={owner.profileIcon ?? null} name={owner.username} size="lg" />
      <div className="min-w-0">
        <h1 className="bt-page-title">{name}</h1>
        <p className="bt-page-sub">{t('publicShare.ownerLabel', { username: owner.username })}</p>
      </div>
    </div>
  );
}

export function PublicSharePage() {
  const t = useT();
  const { token = '' } = useParams<{ token: string }>();
  const { data, error, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['public-share', token],
    queryFn: ({ signal }) => resolveShareLink(token, signal),
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) return <Splash label={t('publicShare.loading')} />;

  if (isError || !data) {
    if (classifyApiError(error, ['LINK_NOT_FOUND']) !== 'confirmed-domain-outcome') {
      return (
        <Shell>
          <div className="flex flex-col items-start gap-4">
            <p className="bt-soft">{t('publicShare.unavailable')}</p>
            <Button disabled={isFetching} onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        </Shell>
      );
    }
    return (
      <Shell>
        <p className="bt-soft">{t('publicShare.notFound')}</p>
      </Shell>
    );
  }

  if (data.kind === 'portfolio') {
    const p = data.portfolio;
    return (
      <Shell>
        <div className="flex flex-col gap-6">
          <OwnerHead name={p.name} owner={p.owner} />
          {/* The headline value leads the canvas rather than sitting in a box. */}
          <div>
            <p className="bt-label">{t('publicShare.netWorth')}</p>
            <p className="bt-hero-value" style={{ marginTop: 4 }}>
              {formatMoney(p.totals.totalValueEur, 'EUR')}
            </p>
          </div>
          {p.history.points.length > 0 ? (
            <section aria-label={t('publicShare.valueOverTime')}>
              <h2 className="bt-h3" style={{ marginBottom: 10 }}>
                {t('publicShare.valueOverTime')}
              </h2>
              <div className="bt-chart">
                <PriceChart
                  series={p.history.points.map((pt) => ({
                    time: pt.date as Time,
                    value: pt.valueEur,
                  }))}
                  mode="area"
                  showRangeToggle={false}
                  valueCurrency={p.baseCurrency}
                  ariaLabel={t('publicShare.valueOverTime')}
                />
              </div>
            </section>
          ) : null}
          <section>
            <h2 className="bt-h3" style={{ marginBottom: 6 }}>
              {t('publicShare.holdings')}
            </h2>
            <ul className="bt-band bt-t-rule bt-b-rule flex flex-col">
              {p.holdings.map((h) => (
                <li
                  key={h.asset.id}
                  className="flex items-center justify-between gap-3"
                  style={{ padding: '10px 0' }}
                >
                  <div className="min-w-0">
                    <p className="bt-row-title truncate">{h.asset.symbol}</p>
                    <p className="bt-row-sub truncate">{h.asset.name}</p>
                  </div>
                  <span className="bt-num bt-soft shrink-0">
                    {formatMoney(h.marketValueEur ?? 0, 'EUR')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </Shell>
    );
  }

  if (data.kind === 'conglomerate') {
    const c = data.conglomerate;
    return (
      <Shell>
        <div className="flex flex-col gap-6">
          <OwnerHead name={c.name} owner={c.owner} />
          <section>
            <h2 className="bt-h3" style={{ marginBottom: 6 }}>
              {t('publicShare.positions')}
            </h2>
            <ul className="bt-band bt-t-rule bt-b-rule flex flex-col">
              {c.positions.map((pos) => (
                <li
                  key={pos.kind === 'asset' ? pos.assetId : pos.childId}
                  className="flex items-center justify-between gap-3"
                  style={{ padding: '10px 0' }}
                >
                  <div className="min-w-0">
                    <p className="bt-row-title truncate">
                      {pos.kind === 'asset' ? pos.asset.symbol : pos.child.name}
                    </p>
                    <p className="bt-row-sub truncate">
                      {pos.kind === 'asset'
                        ? pos.asset.name
                        : t('workboard.conglomerates.nestedBadge')}
                    </p>
                  </div>
                  <span className="bt-num bt-soft shrink-0">{formatPercent(pos.weightPct)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </Shell>
    );
  }

  const w = data.watchlist;
  return (
    <Shell>
      <div className="flex flex-col gap-6">
        <OwnerHead name={w.name} owner={w.owner} />
        <section>
          <h2 className="bt-h3" style={{ marginBottom: 6 }}>
            {t('publicShare.watchedAssets')}
          </h2>
          <ul className="bt-band bt-t-rule bt-b-rule flex flex-col">
            {w.items.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3"
                style={{ padding: '10px 0' }}
              >
                <div className="min-w-0">
                  <p className="bt-row-title truncate">{item.asset.symbol}</p>
                  <p className="bt-row-sub truncate">{item.asset.name}</p>
                </div>
                {item.asset.exchange ? (
                  <span className="bt-meta shrink-0">{item.asset.exchange}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Shell>
  );
}
