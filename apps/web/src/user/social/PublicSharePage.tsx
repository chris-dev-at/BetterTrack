import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';

import { resolveShareLink } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { Splash } from '../components/ui';

/**
 * The UNAUTHENTICATED public-link view (§14, §13.3 V3-P5): a logged-out visitor
 * opens `/s/:token`, which resolves the token to a live read-only view of the
 * shared item — and nothing else. A revoked/unknown token, or one whose owner
 * narrowed the audience, renders a friendly "no longer available" (the API 404s).
 */
function eur(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value);
}

function Shell({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <span className="text-lg font-semibold">{t('publicShare.brand')}</span>
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {t('publicShare.readOnly')}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>
    </div>
  );
}

export function PublicSharePage() {
  const t = useT();
  const { token = '' } = useParams<{ token: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-share', token],
    queryFn: ({ signal }) => resolveShareLink(token, signal),
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) return <Splash label={t('publicShare.loading')} />;

  if (isError || !data) {
    return (
      <Shell>
        <p className="text-sm text-neutral-400">{t('publicShare.notFound')}</p>
      </Shell>
    );
  }

  if (data.kind === 'portfolio') {
    const p = data.portfolio;
    return (
      <Shell>
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold">{p.name}</h1>
            <p className="text-sm text-neutral-500">
              {t('publicShare.ownerLabel', { username: p.owner.username })}
            </p>
          </div>
          <div className="rounded-lg border border-neutral-800 p-4">
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              {t('publicShare.netWorth')}
            </p>
            <p className="text-3xl font-semibold">{eur(p.totals.totalValueEur)}</p>
          </div>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-300">
              {t('publicShare.holdings')}
            </h2>
            <ul className="divide-y divide-neutral-800">
              {p.holdings.map((h) => (
                <li key={h.asset.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{h.asset.symbol}</p>
                    <p className="truncate text-xs text-neutral-500">{h.asset.name}</p>
                  </div>
                  <span className="shrink-0 text-sm text-neutral-300">
                    {eur(h.marketValueEur ?? 0)}
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
          <div>
            <h1 className="text-2xl font-semibold">{c.name}</h1>
            <p className="text-sm text-neutral-500">
              {t('publicShare.ownerLabel', { username: c.owner.username })}
            </p>
          </div>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-300">
              {t('publicShare.positions')}
            </h2>
            <ul className="divide-y divide-neutral-800">
              {c.positions.map((pos) => (
                <li key={pos.assetId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{pos.asset.symbol}</p>
                    <p className="truncate text-xs text-neutral-500">{pos.asset.name}</p>
                  </div>
                  <span className="shrink-0 text-sm text-neutral-300">{pos.weightPct}%</span>
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
        <div>
          <h1 className="text-2xl font-semibold">{w.name}</h1>
          <p className="text-sm text-neutral-500">
            {t('publicShare.ownerLabel', { username: w.owner.username })}
          </p>
        </div>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-neutral-300">
            {t('publicShare.watchedAssets')}
          </h2>
          <ul className="divide-y divide-neutral-800">
            {w.items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.asset.symbol}</p>
                  <p className="truncate text-xs text-neutral-500">{item.asset.name}</p>
                </div>
                {item.asset.exchange ? (
                  <span className="shrink-0 text-xs text-neutral-500">{item.asset.exchange}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Shell>
  );
}
