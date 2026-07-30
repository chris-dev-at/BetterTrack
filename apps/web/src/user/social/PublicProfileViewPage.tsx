import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { Time } from 'lightweight-charts';

import type { ShareKind } from '@bettertrack/contracts';

import { getPublicProfile, getPublicProfileItem } from '../../lib/socialApi';
import { formatMoney, formatPercent } from '../../lib/format';
import { classifyApiError } from '../../lib/apiClient';
import { useT } from '../../i18n';
import { Wordmark } from '../../components/Wordmark';
import { PriceChart } from '../../ui/charts';
import { Avatar } from '../components/Avatar';
import { Icon } from '../../ui/origin';
import { Button, Splash } from '../components/ui';
import { AlertFollowToggle, AutoFollowToggle, FollowButton } from './FollowButton';
import { ItemFollowButton } from './ItemFollowButton';
import { KindTile } from './SharedPeople';

/**
 * The UNAUTHENTICATED public-profile view (§14, V3-P6): a logged-out visitor opens
 * `/u/:username` and sees a page composed from the user's `public_link` items +
 * their bio — and nothing else. A profile that is not opted-in (or an unknown /
 * inactive user) renders a friendly "not available" (the API 404s), so disabling a
 * profile takes it offline instantly and a non-public item can never appear.
 *
 * It renders OUTSIDE the app shell, so it puts on the Origin frame itself:
 * `bt-app` supplies the graphite canvas, ivory type and focus ring, and a single
 * centered reading column (the shell's own narrow canvas width) carries a
 * compact wordmark header over the profile.
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
          <span className="bt-label">{t('profile.publicBadge')}</span>
        </div>
      </header>
      <main className="py-10" style={COLUMN}>
        {children}
      </main>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="chevron-right"
      size={16}
      style={{
        color: 'var(--bt-faint)',
        flex: 'none',
        transform: open ? 'rotate(90deg)' : undefined,
        transition: 'transform var(--bt-t-fast)',
      }}
    />
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
    <div className="bt-panel overflow-hidden">
      <div className="flex items-center gap-2 pr-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="bt-band__row flex min-w-0 flex-1 items-center gap-3 text-left"
          style={{
            background: 'none',
            border: 0,
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          <KindTile kind={kind} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="bt-row-title truncate">{name}</span>
            <span className="bt-row-sub truncate">{headline}</span>
          </span>
          <Chevron open={open} />
        </button>
        <ItemFollowButton kind={kind} subjectId={subjectId} ownerId={ownerId} />
      </div>

      {open ? (
        <div className="bt-t-rule" style={{ padding: 16 }}>
          {detail.isLoading ? (
            <p className="bt-meta">{t('publicShare.loading')}</p>
          ) : detail.isError || !detail.data ? (
            classifyApiError(detail.error, ['PROFILE_NOT_FOUND', 'NOT_FOUND']) ===
            'confirmed-domain-outcome' ? (
              <p className="bt-meta">{t('publicShare.notFound')}</p>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <p className="bt-meta">{t('profile.itemTemporarilyUnavailable')}</p>
                <Button disabled={detail.isFetching} onClick={() => void detail.refetch()}>
                  {t('common.retry')}
                </Button>
              </div>
            )
          ) : detail.data.kind === 'portfolio' ? (
            <div className="flex flex-col gap-4">
              {detail.data.portfolio.history.points.length > 0 ? (
                <section aria-label={t('publicShare.valueOverTime')}>
                  <h3 className="bt-label" style={{ marginBottom: 8 }}>
                    {t('publicShare.valueOverTime')}
                  </h3>
                  <div className="bt-chart">
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
                  </div>
                </section>
              ) : null}
              <ul className="bt-band flex flex-col">
                {detail.data.portfolio.holdings.map((h) => (
                  <li
                    key={h.asset.id}
                    className="flex items-center justify-between gap-3"
                    style={{ padding: '9px 0' }}
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
            </div>
          ) : detail.data.kind === 'conglomerate' ? (
            <ul className="bt-band flex flex-col">
              {detail.data.conglomerate.positions.map((p) => (
                <li
                  key={p.kind === 'asset' ? p.assetId : p.childId}
                  className="flex items-center justify-between gap-3"
                  style={{ padding: '9px 0' }}
                >
                  <div className="min-w-0">
                    <p className="bt-row-title truncate">
                      {p.kind === 'asset' ? p.asset.symbol : p.child.name}
                    </p>
                    <p className="bt-row-sub truncate">
                      {p.kind === 'asset' ? p.asset.name : t('workboard.conglomerates.nestedBadge')}
                    </p>
                  </div>
                  <span className="bt-num bt-soft shrink-0">{formatPercent(p.weightPct)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="bt-band flex flex-col">
              {detail.data.watchlist.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3"
                  style={{ padding: '9px 0' }}
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
          )}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="bt-label">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export function PublicProfileViewPage() {
  const t = useT();
  const { username = '' } = useParams<{ username: string }>();
  const { data, error, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['public-profile', username],
    queryFn: ({ signal }) => getPublicProfile(username, signal),
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) return <Splash label={t('publicShare.loading')} />;

  if (isError || !data) {
    if (classifyApiError(error, ['PROFILE_NOT_FOUND']) !== 'confirmed-domain-outcome') {
      return (
        <Shell>
          <div className="flex flex-col items-start gap-4">
            <p className="bt-soft">{t('profile.temporarilyUnavailable')}</p>
            <Button disabled={isFetching} onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        </Shell>
      );
    }
    return (
      <Shell>
        <p className="bt-soft">{t('profile.notAvailable')}</p>
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
            <h1 className="bt-page-title truncate">@{data.username}</h1>
            <p className="bt-page-sub">
              {t(`social.follow.followers.${data.followerCount === 1 ? 'one' : 'other'}`, {
                count: data.followerCount,
              })}
            </p>
            {data.bio ? (
              <p className="bt-soft break-words" style={{ marginTop: 6 }}>
                {data.bio}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-2">
            <FollowButton userId={data.userId} username={data.username} />
            <AutoFollowToggle userId={data.userId} username={data.username} />
            <AlertFollowToggle userId={data.userId} username={data.username} />
          </div>
        </div>

        {empty ? (
          <p className="bt-meta">{t('profile.emptyPublic')}</p>
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
