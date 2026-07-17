import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { Time } from 'lightweight-charts';

import type { ShareKind } from '@bettertrack/contracts';

import { getPublicProfile, getPublicProfileItem } from '../../lib/socialApi';
import { formatMoney, formatPercent } from '../../lib/format';
import { useT } from '../../i18n';
import { Wordmark } from '../../components/Wordmark';
import { PriceChart } from '../../ui/charts';
import { Avatar } from '../components/Avatar';
import { Splash } from '../components/ui';
import { AlertFollowToggle, AutoFollowToggle, FollowButton } from './FollowButton';
import { ItemFollowButton } from './ItemFollowButton';
import { KindIcon } from './SharedPeople';

/**
 * The UNAUTHENTICATED public-profile view (§14, V3-P6): a logged-out visitor opens
 * `/u/:username` and sees a page composed from the user's `public_link` items +
 * their bio — and nothing else. A profile that is not opted-in (or an unknown /
 * inactive user) renders a friendly "not available" (the API 404s), so disabling a
 * profile takes it offline instantly and a non-public item can never appear.
 */
function Shell({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <Wordmark edition="Web" className="text-lg" />
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {t('profile.publicBadge')}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** A read-only public item that expands in place to its holdings/positions/assets. */
function ProfileItemCard({
  username,
  ownerId,
  kind,
  subjectId,
  name,
  headline,
}: {
  username: string;
  /** The profile owner — hides the item-follow button on one's own profile. */
  ownerId: string;
  kind: ShareKind;
  subjectId: string;
  name: string;
  headline: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ['public-profile-item', username, kind, subjectId],
    queryFn: ({ signal }) => getPublicProfileItem(username, kind, subjectId, signal),
    enabled: open,
    retry: false,
    staleTime: 30_000,
  });

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
      <div className="flex items-center gap-3 pr-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-400">
            <KindIcon kind={kind} className="h-5 w-5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-neutral-100">{name}</span>
            <span className="truncate text-xs text-neutral-500">{headline}</span>
          </span>
          <Chevron open={open} />
        </button>
        <ItemFollowButton kind={kind} subjectId={subjectId} ownerId={ownerId} />
      </div>

      {open ? (
        <div className="border-t border-neutral-800 p-4">
          {detail.isLoading ? (
            <p className="text-sm text-neutral-500">{t('publicShare.loading')}</p>
          ) : detail.isError || !detail.data ? (
            <p className="text-sm text-neutral-500">{t('publicShare.notFound')}</p>
          ) : detail.data.kind === 'portfolio' ? (
            <div className="flex flex-col gap-4">
              {detail.data.portfolio.history.points.length > 0 ? (
                <section aria-label={t('publicShare.valueOverTime')}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    {t('publicShare.valueOverTime')}
                  </h3>
                  <PriceChart
                    series={detail.data.portfolio.history.points.map((pt) => ({
                      time: pt.date as Time,
                      value: pt.valueEur,
                    }))}
                    mode="area"
                    showRangeToggle={false}
                    height={240}
                    ariaLabel={t('publicShare.valueOverTime')}
                  />
                </section>
              ) : null}
              <ul className="divide-y divide-neutral-800">
                {detail.data.portfolio.holdings.map((h) => (
                  <li key={h.asset.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{h.asset.symbol}</p>
                      <p className="truncate text-xs text-neutral-500">{h.asset.name}</p>
                    </div>
                    <span className="shrink-0 text-sm text-neutral-300">
                      {formatMoney(h.marketValueEur ?? 0, 'EUR')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : detail.data.kind === 'conglomerate' ? (
            <ul className="divide-y divide-neutral-800">
              {detail.data.conglomerate.positions.map((p) => (
                <li key={p.assetId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.asset.symbol}</p>
                    <p className="truncate text-xs text-neutral-500">{p.asset.name}</p>
                  </div>
                  <span className="shrink-0 text-sm text-neutral-300">
                    {formatPercent(p.weightPct)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-neutral-800">
              {detail.data.watchlist.items.map((item) => (
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
          )}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export function PublicProfileViewPage() {
  const t = useT();
  const { username = '' } = useParams<{ username: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-profile', username],
    queryFn: ({ signal }) => getPublicProfile(username, signal),
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) return <Splash label={t('publicShare.loading')} />;

  if (isError || !data) {
    return (
      <Shell>
        <p className="text-sm text-neutral-400">{t('profile.notAvailable')}</p>
      </Shell>
    );
  }

  const empty =
    data.portfolios.length === 0 && data.conglomerates.length === 0 && data.watchlists.length === 0;

  return (
    <Shell>
      <div className="flex flex-col gap-8">
        <div className="flex items-center gap-4">
          <Avatar name={data.username} iconId={data.profileIcon} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold">@{data.username}</h1>
            <p className="mt-0.5 text-sm text-neutral-500">
              {t(`social.follow.followers.${data.followerCount === 1 ? 'one' : 'other'}`, {
                count: data.followerCount,
              })}
            </p>
            {data.bio ? (
              <p className="mt-1 break-words text-sm text-neutral-400">{data.bio}</p>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-2">
            <FollowButton userId={data.userId} username={data.username} />
            <AutoFollowToggle userId={data.userId} username={data.username} />
            <AlertFollowToggle userId={data.userId} username={data.username} />
          </div>
        </div>

        {empty ? (
          <p className="text-sm text-neutral-500">{t('profile.emptyPublic')}</p>
        ) : (
          <div className="flex flex-col gap-6">
            {data.portfolios.length > 0 ? (
              <Section title={t('social.kind.portfolios')}>
                {data.portfolios.map((p) => (
                  <ProfileItemCard
                    key={p.portfolioId}
                    username={data.username}
                    ownerId={data.userId}
                    kind="portfolio"
                    subjectId={p.portfolioId}
                    name={p.name}
                    headline={formatMoney(p.totalValueEur, 'EUR')}
                  />
                ))}
              </Section>
            ) : null}
            {data.conglomerates.length > 0 ? (
              <Section title={t('social.kind.conglomerates')}>
                {data.conglomerates.map((c) => (
                  <ProfileItemCard
                    key={c.conglomerateId}
                    username={data.username}
                    ownerId={data.userId}
                    kind="conglomerate"
                    subjectId={c.conglomerateId}
                    name={c.name}
                    headline={t('social.item.positions', { count: c.positionCount })}
                  />
                ))}
              </Section>
            ) : null}
            {data.watchlists.length > 0 ? (
              <Section title={t('social.kind.watchlists')}>
                {data.watchlists.map((w) => (
                  <ProfileItemCard
                    key={w.watchlistId}
                    username={data.username}
                    ownerId={data.userId}
                    kind="watchlist"
                    subjectId={w.watchlistId}
                    name={w.name}
                    headline={t('social.item.assets', { count: w.itemCount })}
                  />
                ))}
              </Section>
            ) : null}
          </div>
        )}
      </div>
    </Shell>
  );
}
