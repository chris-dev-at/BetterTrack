import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { ShareAudience, ShareKind, UpdateAlertSharingRequest } from '@bettertrack/contracts';

import { listMyShared } from '../../lib/socialApi';
import { ALERT_SHARING_QUERY_KEY, getAlertSharing, updateAlertSharing } from '../../lib/alertsApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { useT } from '../../i18n';
import { EmptyState } from '../../ui';
import {
  Badge,
  Button,
  PageHead,
  SectionHead,
  SkeletonBlock,
  Switch,
  type BadgeTone,
} from '../../ui/origin';
import { AudiencePicker } from '../components/AudiencePicker';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';

const MY_SHARED_STALE_MS = 30_000;
const MY_SHARED_KEY = ['social', 'my-shared'] as const;

interface PickerTarget {
  kind: ShareKind;
  subjectId: string;
  label: string;
  /**
   * V5-P7 M5 MIRRORCHAIN §10: true when the target is a synced-copy portfolio
   * of an active chain — the picker renders the co-member-visibility notice.
   */
  mirrorSyncedCopy?: boolean;
}

/**
 * The per-item "who can see this" summary (V3-P6) — the audience read straight off
 * the single audience model, so it never disagrees with what is actually shared.
 * A private item is dimmed (outline only); every shared tier is a tinted chip —
 * gold for the public link, analytical blue for the friend tiers — with the named
 * count for `specific_friends`.
 */
function WhoSeesThis({ audience, friendCount }: { audience: ShareAudience; friendCount: number }) {
  const t = useT();
  const label =
    audience === 'specific_friends' && friendCount > 0
      ? `${t('sharing.badge.specific_friends')} · ${friendCount}`
      : t(`sharing.badge.${audience}`);
  const tone: BadgeTone =
    audience === 'private' ? 'neutral' : audience === 'public_link' ? 'gold' : 'blue';
  return (
    <Badge outline={audience === 'private'} tone={tone}>
      {label}
    </Badge>
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
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="bt-row-title truncate">{name}</span>
        <div className="flex flex-wrap items-center gap-2">
          <WhoSeesThis audience={audience} friendCount={friendCount} />
          {detail ? <span className="bt-meta">{detail}</span> : null}
        </div>
      </div>
      <Button onClick={onShare} size="sm">
        {shareLabel}
      </Button>
    </li>
  );
}

/**
 * The owner's alert-visibility control (#455), rehomed into the Social "My items"
 * area (V4 rework): sharing your alerts is a social decision, so it lives beside
 * the rest of your shared stuff rather than in Settings. A switch exposing every
 * current and future alert to your FOLLOWERS. Alerts reveal watched assets +
 * price targets and anyone may follow, so enabling walks the §16 friction ladder
 * — a strong warning dialog whose confirm sends the explicit acknowledgment the
 * server requires. Disabling is immediate and stops follower delivery at once.
 */
function AlertSharingControl() {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data } = useQuery({
    queryKey: ALERT_SHARING_QUERY_KEY,
    queryFn: ({ signal }) => getAlertSharing(signal),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (body: UpdateAlertSharingRequest) => updateAlertSharing(body),
    onSuccess: (result) => {
      queryClient.setQueryData(ALERT_SHARING_QUERY_KEY, result);
      setConfirming(false);
    },
  });

  if (!data) return null;
  const on = data.visibleToFollowers;

  return (
    <section className="bt-section">
      <SectionHead title={t('social.alertSharing.heading')} />
      <div className="flex flex-col gap-2">
        <div
          className="bt-b-rule flex flex-wrap items-center justify-between gap-3"
          style={{ paddingBottom: 14 }}
        >
          <div className="min-w-0">
            <p className="bt-row-title">{t('social.alertSharing.title')}</p>
            <p className="bt-meta">
              {t(on ? 'social.alertSharing.onHint' : 'social.alertSharing.offHint')}
            </p>
          </div>
          <Switch
            aria-label={t('social.alertSharing.toggleAria')}
            checked={on}
            disabled={mutation.isPending}
            onChange={(next) =>
              next ? setConfirming(true) : mutation.mutate({ visibleToFollowers: false })
            }
          />
        </div>
        {mutation.isError ? <Alert tone="error">{t('social.alertSharing.error')}</Alert> : null}
      </div>
      {confirming ? (
        <Dialog title={t('social.alertSharing.confirmTitle')} onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-4">
            <p className="bt-gold">{t('social.alertSharing.confirmWarning')}</p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirming(false)} variant="quiet">
                {t('social.alertSharing.confirmCancel')}
              </Button>
              <Button
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({ visibleToFollowers: true, acknowledgeFollowers: true })
                }
                variant="primary"
              >
                {t('social.alertSharing.confirmEnable')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
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
  // MIRRORCHAIN §10 (V5-P7 M5): the shared-portfolios shape doesn't carry the
  // synced-copy flag, so we cross-reference the portfolios list to know which
  // portfolios are chain-attached — that flips the share notice on for those.
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });
  const mirrorSyncedPortfolios = useMemo(() => {
    const set = new Set<string>();
    for (const p of portfoliosQuery.data?.portfolios ?? []) {
      if (p.mirror) set.add(p.id);
    }
    return set;
  }, [portfoliosQuery.data]);

  const onChanged = () => {
    void queryClient.invalidateQueries({ queryKey: MY_SHARED_KEY });
  };

  if (isLoading) {
    return (
      <section className="flex flex-col gap-4">
        <SkeletonBlock height={28} width={210} />
        <SkeletonBlock height={92} />
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

  const shareLabel = t('sharing.shareButton');

  return (
    <div className="flex flex-col">
      <PageHead sub={t('social.myShared.subtitle')} title={t('social.myShared.title')} />
      {nothing ? (
        <EmptyState
          title={t('social.myShared.emptyTitle')}
          description={t('social.myShared.emptyBody')}
        />
      ) : null}
      {data.portfolios.length > 0 ? (
        <section className="bt-section">
          <SectionHead title={t('social.kind.portfolios')} />
          <ul className="bt-band flex flex-col">
            {data.portfolios.map((p) => (
              <SharedRow
                key={p.portfolioId}
                name={p.name}
                audience={p.audience}
                friendCount={p.friendCount}
                onShare={() =>
                  setPicker({
                    kind: 'portfolio',
                    subjectId: p.portfolioId,
                    label: p.name,
                    mirrorSyncedCopy: mirrorSyncedPortfolios.has(p.portfolioId),
                  })
                }
                shareLabel={shareLabel}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {data.conglomerates.length > 0 ? (
        <section className="bt-section">
          <SectionHead title={t('social.kind.conglomerates')} />
          <ul className="bt-band flex flex-col">
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
        <section className="bt-section">
          <SectionHead title={t('social.kind.watchlists')} />
          <ul className="bt-band flex flex-col">
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
        <section className="bt-section">
          <SectionHead title={t('social.kind.ideas')} />
          <ul className="bt-band flex flex-col">
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

      <AlertSharingControl />

      <div className="bt-section bt-t-rule" style={{ paddingTop: 18 }}>
        <Link className="bt-link inline-flex items-center gap-1.5" to="/people/profile">
          {t('social.myShared.publicProfileLink')}
          <span aria-hidden="true">→</span>
        </Link>
      </div>

      {picker ? (
        <AudiencePicker
          kind={picker.kind}
          subjectId={picker.subjectId}
          subjectLabel={picker.label}
          mirrorSyncedCopy={picker.mirrorSyncedCopy}
          onClose={() => setPicker(null)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}
