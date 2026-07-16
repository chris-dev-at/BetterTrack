import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { ShareAudience, ShareKind } from '@bettertrack/contracts';

import { listMyShared } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { AudiencePicker } from '../components/AudiencePicker';
import { Alert, Button, cx } from '../components/ui';

const MY_SHARED_STALE_MS = 30_000;
const MY_SHARED_KEY = ['social', 'my-shared'] as const;

interface PickerTarget {
  kind: ShareKind;
  subjectId: string;
  label: string;
}

function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{children}</h3>
  );
}

/**
 * The per-item "who can see this" summary (V3-P6) — the audience read straight off
 * the single audience model, so it never disagrees with what is actually shared.
 * A private item is dimmed; every shared tier is a tinted chip, with the named
 * count for `specific_friends`.
 */
function WhoSeesThis({ audience, friendCount }: { audience: ShareAudience; friendCount: number }) {
  const t = useT();
  const label =
    audience === 'specific_friends' && friendCount > 0
      ? `${t('sharing.badge.specific_friends')} · ${friendCount}`
      : t(`sharing.badge.${audience}`);
  const tone =
    audience === 'private'
      ? 'border-neutral-700 text-neutral-400'
      : audience === 'public_link'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
        : 'border-sky-500/40 bg-sky-500/10 text-sky-200';
  return (
    <span className={cx('rounded-full border px-2 py-0.5 text-xs font-medium', tone)}>{label}</span>
  );
}

interface SharedRowProps {
  name: string;
  audience: ShareAudience;
  friendCount: number;
  detail?: string;
  onShare: () => void;
  shareLabel: string;
}

function SharedRow({ name, audience, friendCount, detail, onShare, shareLabel }: SharedRowProps) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium text-neutral-100">{name}</span>
        <div className="flex flex-wrap items-center gap-2">
          <WhoSeesThis audience={audience} friendCount={friendCount} />
          {detail ? <span className="text-xs text-neutral-500">{detail}</span> : null}
        </div>
      </div>
      <Button variant="secondary" onClick={onShare}>
        {shareLabel}
      </Button>
    </li>
  );
}

/**
 * My items (§6.9, §13.3 V3-P5/P6; #384) — the caller's ONE unified
 * sharing-management surface. EVERY shareable item the caller owns is listed here:
 * all portfolios, conglomerates and watchlists, shared OR not, each with its own
 * entry point to the reusable AudiencePicker. Everything is private by default —
 * a never-shared item is simply shown dimmed until shared. Each row carries a
 * per-item "who can see this" summary; every control here is wired to
 * `PUT /social/audience/:kind/:subjectId`.
 */
export function MySharedItemsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [picker, setPicker] = useState<PickerTarget | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: MY_SHARED_KEY,
    queryFn: ({ signal }) => listMyShared(signal),
    staleTime: MY_SHARED_STALE_MS,
  });

  const onChanged = () => {
    void queryClient.invalidateQueries({ queryKey: MY_SHARED_KEY });
  };

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-6" width="w-48" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (isError || !data) {
    return <Alert tone="error">{t('social.myShared.error')}</Alert>;
  }

  const nothing =
    data.portfolios.length === 0 &&
    data.conglomerates.length === 0 &&
    data.watchlists.length === 0 &&
    data.ideas.length === 0;

  if (nothing) {
    return (
      <EmptyState
        title={t('social.myShared.emptyTitle')}
        description={t('social.myShared.emptyBody')}
      />
    );
  }

  const shareLabel = t('sharing.shareButton');

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">{t('social.myShared.title')}</h2>
        <p className="text-sm text-neutral-500">{t('social.myShared.subtitle')}</p>
      </div>
      {data.portfolios.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>{t('social.kind.portfolios')}</SectionHeading>
          <ul className="flex flex-col gap-2">
            {data.portfolios.map((p) => (
              <SharedRow
                key={p.portfolioId}
                name={p.name}
                audience={p.audience}
                friendCount={p.friendCount}
                onShare={() =>
                  setPicker({ kind: 'portfolio', subjectId: p.portfolioId, label: p.name })
                }
                shareLabel={shareLabel}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {data.conglomerates.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>{t('social.kind.conglomerates')}</SectionHeading>
          <ul className="flex flex-col gap-2">
            {data.conglomerates.map((c) => (
              <SharedRow
                key={c.conglomerateId}
                name={c.name}
                audience={c.audience}
                friendCount={c.friendCount}
                detail={t('social.item.positions', { count: c.positionCount })}
                onShare={() =>
                  setPicker({ kind: 'conglomerate', subjectId: c.conglomerateId, label: c.name })
                }
                shareLabel={shareLabel}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {data.watchlists.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>{t('social.kind.watchlists')}</SectionHeading>
          <ul className="flex flex-col gap-2">
            {data.watchlists.map((w) => (
              <SharedRow
                key={w.watchlistId}
                name={w.name}
                audience={w.audience}
                friendCount={w.friendCount}
                detail={t('social.item.assets', { count: w.itemCount })}
                onShare={() =>
                  setPicker({ kind: 'watchlist', subjectId: w.watchlistId, label: w.name })
                }
                shareLabel={shareLabel}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {data.ideas.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>{t('social.kind.ideas')}</SectionHeading>
          <ul className="flex flex-col gap-2">
            {data.ideas.map((i) => (
              <SharedRow
                key={i.ideaId}
                name={i.name}
                audience={i.audience}
                friendCount={i.friendCount}
                detail={i.hasThesis ? t('social.item.ideaThesis') : undefined}
                onShare={() => setPicker({ kind: 'idea', subjectId: i.ideaId, label: i.name })}
                shareLabel={shareLabel}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <div className="border-t border-neutral-800 pt-5">
        <Link
          to="/social/profile"
          className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-sky-400 transition-colors hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          {t('social.myShared.publicProfileLink')}
          <span aria-hidden="true">→</span>
        </Link>
      </div>

      {picker ? (
        <AudiencePicker
          kind={picker.kind}
          subjectId={picker.subjectId}
          subjectLabel={picker.label}
          onClose={() => setPicker(null)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}
