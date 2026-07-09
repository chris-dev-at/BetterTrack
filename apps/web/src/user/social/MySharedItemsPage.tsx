import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ShareAudience, ShareKind } from '@bettertrack/contracts';

import { listMyShared } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { EmptyState, Skeleton } from '../../ui';
import { AudiencePicker } from '../components/AudiencePicker';
import { Alert, Button } from '../components/ui';

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

/** A localized audience badge. */
function AudienceBadge({ audience }: { audience: ShareAudience }) {
  const t = useT();
  return (
    <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
      {t(`sharing.badge.${audience}`)}
    </span>
  );
}

/**
 * My Shared Items (§6.9, §13.3 V3-P5) — everything the caller currently shares
 * (portfolios, conglomerates, named watchlists), each with the reusable
 * AudiencePicker to change or stop the share.
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
    return <Alert tone="error">Could not load your shared items. Please refresh the page.</Alert>;
  }

  const nothing =
    data.portfolios.length === 0 && data.conglomerates.length === 0 && data.watchlists.length === 0;

  if (nothing) {
    return (
      <EmptyState
        title="You're not sharing anything"
        description="Share a portfolio, conglomerate or watchlist to have it appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {data.portfolios.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Portfolios</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            {data.portfolios.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <span className="text-sm font-medium text-neutral-100">{p.name}</span>
                <Button
                  variant="secondary"
                  onClick={() => setPicker({ kind: 'portfolio', subjectId: p.id, label: p.name })}
                >
                  {t('sharing.shareButton')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.conglomerates.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Conglomerates</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            {data.conglomerates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                <span className="text-sm font-medium text-neutral-100">{c.name}</span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setPicker({ kind: 'conglomerate', subjectId: c.id, label: c.name })
                  }
                >
                  {t('sharing.shareButton')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.watchlists.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>Watchlists</SectionHeading>
          <ul className="divide-y divide-neutral-800">
            {data.watchlists.map((w) => (
              <li key={w.watchlistId} className="flex items-center justify-between gap-3 py-3">
                <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                  {w.name}
                  <AudienceBadge audience={w.audience} />
                </span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setPicker({ kind: 'watchlist', subjectId: w.watchlistId, label: w.name })
                  }
                >
                  {t('sharing.shareButton')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
