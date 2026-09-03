import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';

import type {
  MySharedResponse,
  ShareAudience,
  ShareKind,
  UpdateAlertSharingRequest,
} from '@bettertrack/contracts';

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
import { AsyncReadState } from '../components/AsyncReadState';
import { Dialog } from '../components/Dialog';
import { Alert, Spinner } from '../components/ui';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
import { CommentThread } from './CommentThread';

const MY_SHARED_STALE_MS = 30_000;
const MY_SHARED_KEY = ['social', 'my-shared'] as const;

interface PickerTarget {
  kind: ShareKind;
  subjectId: string;
  label: string;
}

/** The circle a `group` share reaches, or `null` when it reaches nobody. */
type ShareGroup = { id: string; name: string; memberCount: number } | null;

const SHARE_KINDS = ['portfolio', 'conglomerate', 'watchlist', 'idea'] as const;

/**
 * Parse the `#thread-<kind>-<subjectId>` anchor a `comment.created` notification
 * deep-links to (written by `NotificationBell`) back into its target. Unknown or
 * garbled hashes resolve to `null` — a stale deep link opens the page, never a
 * dialog on nothing.
 */
function threadFromHash(hash: string): { kind: ShareKind; subjectId: string } | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('thread-')) return null;
  const rest = raw.slice('thread-'.length);
  const kind = SHARE_KINDS.find((candidate) => rest.startsWith(`${candidate}-`));
  if (!kind) return null;
  const subjectId = rest.slice(kind.length + 1);
  return subjectId.length > 0 ? { kind, subjectId } : null;
}

/** Resolve a deep-linked target to the item's own name, or `null` if it is gone. */
function labelForTarget(
  data: MySharedResponse,
  target: { kind: ShareKind; subjectId: string },
): string | null {
  const row =
    target.kind === 'portfolio'
      ? data.portfolios.find((p) => p.portfolioId === target.subjectId)
      : target.kind === 'conglomerate'
        ? data.conglomerates.find((c) => c.conglomerateId === target.subjectId)
        : target.kind === 'watchlist'
          ? data.watchlists.find((w) => w.watchlistId === target.subjectId)
          : data.ideas.find((i) => i.ideaId === target.subjectId);
  return row?.name ?? null;
}

/**
 * The per-item "who can see this" summary (V3-P6) — the audience read straight off
 * the single audience model, so it never disagrees with what is actually shared.
 * A private item is dimmed (outline only); every shared tier is a tinted chip —
 * gold for the public link, analytical blue for the friend tiers — with the named
 * count for `specific_friends`.
 *
 * A `group` share names the CIRCLE and its live roster size (§13.5 V5-P8): a flat
 * "Friend group" made a share seen by two people look exactly like one seen by
 * eighteen. A group that reaches nobody — deleted, or emptied — takes the dimmed
 * private treatment, because that is precisely what its reach now is. The friction
 * ladder assumes the owner knows their own reach; this badge is where they read it.
 */
function WhoSeesThis({
  audience,
  friendCount,
  group,
}: {
  audience: ShareAudience;
  friendCount: number;
  group: ShareGroup;
}) {
  const t = useT();
  if (audience === 'group') {
    // `group` is null for a share whose circle was deleted: `group_id` nulls out
    // and the enforcement layer then admits nobody (fail-closed).
    const reachesNobody = group === null || group.memberCount === 0;
    const label =
      group === null
        ? t('sharing.badge.groupDeleted')
        : group.memberCount === 0
          ? t('sharing.badge.groupEmpty', { name: group.name })
          : `${group.name} · ${group.memberCount}`;
    return (
      <Badge
        data-testid="who-sees-this"
        data-reach={reachesNobody ? 'nobody' : 'group'}
        outline={reachesNobody}
        tone={reachesNobody ? 'neutral' : 'blue'}
      >
        {label}
      </Badge>
    );
  }
  const label =
    audience === 'specific_friends' && friendCount > 0
      ? `${t('sharing.badge.specific_friends')} · ${friendCount}`
      : t(`sharing.badge.${audience}`);
  const tone: BadgeTone =
    audience === 'private' ? 'neutral' : audience === 'public_link' ? 'gold' : 'blue';
  return (
    <Badge data-testid="who-sees-this" outline={audience === 'private'} tone={tone}>
      {label}
    </Badge>
  );
}

interface SharedRowProps {
  name: string;
  audience: ShareAudience;
  friendCount: number;
  group: ShareGroup;
  detail?: string;
  onShare: () => void;
  shareLabel: string;
  shareDisabled?: boolean;
  onComments: () => void;
  commentsLabel: string;
}

function SharedRow({
  name,
  audience,
  friendCount,
  group,
  detail,
  onShare,
  shareLabel,
  shareDisabled = false,
  onComments,
  commentsLabel,
}: SharedRowProps) {
  return (
    <li className="bt-shared-item-row flex flex-col items-stretch justify-between gap-3 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="bt-row-title truncate">{name}</span>
        <div className="flex flex-wrap items-center gap-2">
          <WhoSeesThis audience={audience} friendCount={friendCount} group={group} />
          {detail ? <span className="bt-meta">{detail}</span> : null}
        </div>
      </div>
      <div className="flex flex-none flex-wrap items-center gap-2">
        {/* The owner's way into the thread they moderate. Always present, even
            on a private item: a comment posted while the item was shared must
            not become unreachable when the audience narrows. */}
        <Button onClick={onComments} size="sm" variant="quiet">
          <span aria-hidden="true">💬</span>
          {commentsLabel}
        </Button>
        <Button disabled={shareDisabled} onClick={onShare} size="sm">
          {shareLabel}
        </Button>
      </div>
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
  const feedback = useMutationFeedback();
  const [confirming, setConfirming] = useState(false);

  const query = useQuery({
    queryKey: ALERT_SHARING_QUERY_KEY,
    queryFn: ({ signal }) => getAlertSharing(signal),
    staleTime: 30_000,
  });
  const data = query.data;
  const mutation = useMutation({
    mutationFn: (body: UpdateAlertSharingRequest) => updateAlertSharing(body),
    onSuccess: (result) => {
      queryClient.setQueryData(ALERT_SHARING_QUERY_KEY, result);
      setConfirming(false);
      feedback.success(
        t(
          result.visibleToFollowers
            ? 'mutationFeedback.alertSharingEnabled'
            : 'mutationFeedback.alertSharingDisabled',
        ),
      );
    },
    onError: (error, input) => {
      if (!input.visibleToFollowers) feedback.error(t('social.alertSharing.error'), error);
    },
  });

  const closeConfirm = () => {
    setConfirming(false);
    mutation.reset();
  };

  if (query.isLoading || query.error) {
    return (
      <AsyncReadState
        loading={query.isLoading}
        error={query.error}
        errorLabel={t('social.myShared.error')}
        onRetry={() => void query.refetch()}
      />
    );
  }
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
      </div>
      {confirming ? (
        <Dialog phoneSheet title={t('social.alertSharing.confirmTitle')} onClose={closeConfirm}>
          <div className="flex flex-col gap-4">
            <p className="bt-gold-note">{t('social.alertSharing.confirmWarning')}</p>
            {mutation.isError ? <Alert tone="error">{t('social.alertSharing.error')}</Alert> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={closeConfirm} variant="quiet">
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
  const { hash } = useLocation();
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [thread, setThread] = useState<PickerTarget | null>(null);
  const appliedHash = useRef<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
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
    enabled: (data?.portfolios.length ?? 0) > 0,
    staleTime: 60_000,
  });
  const portfolioMetadataReady = portfoliosQuery.isSuccess && !portfoliosQuery.isFetching;
  const mirrorSyncedPortfolios = useMemo(() => {
    const set = new Set<string>();
    if (!portfolioMetadataReady) return set;
    for (const p of portfoliosQuery.data?.portfolios ?? []) {
      if (p.mirror) set.add(p.id);
    }
    return set;
  }, [portfolioMetadataReady, portfoliosQuery.data]);
  const vaultedPortfolioIds = useMemo(() => {
    const set = new Set<string>();
    if (!portfolioMetadataReady) return set;
    for (const portfolio of portfoliosQuery.data?.portfolios ?? []) {
      if (portfolio.vaultId != null) set.add(portfolio.id);
    }
    return set;
  }, [portfolioMetadataReady, portfoliosQuery.data]);
  // A vaulted portfolio is not a disabled sharing row. It is absent from every
  // audience/public-profile affordance while its plain sibling stays present.
  // Names are never masked here: this list only ever holds the caller's own
  // shareable portfolios, a plain one has no name to protect, and a vaulted
  // one's shares are revoked at move-in. Masking every row while the metadata
  // read settles would rename the whole list on each background refetch.
  const shareablePortfolios = portfolioMetadataReady
    ? (data?.portfolios.filter((portfolio) => !vaultedPortfolioIds.has(portfolio.portfolioId)) ??
      [])
    : (data?.portfolios ?? []);

  // A background rejection invalidates the metadata that justified an open
  // portfolio picker. Close it instead of letting a stale false flag remove the
  // MIRRORCHAIN co-member disclosure from an already-open dialog.
  useEffect(() => {
    if (picker?.kind === 'portfolio' && !portfolioMetadataReady) setPicker(null);
  }, [picker?.kind, portfolioMetadataReady]);

  // `comment.created` deep-links here as `#thread-<kind>-<subjectId>` (V5-P8).
  // Applied once per hash so closing the dialog doesn't immediately reopen it,
  // and only once the list has loaded — the item's own name titles the dialog.
  useEffect(() => {
    if (appliedHash.current === hash) return;
    const target = threadFromHash(hash);
    if (!target || !data) return;
    const label = labelForTarget(data, target);
    appliedHash.current = hash;
    if (label !== null) setThread({ ...target, label });
  }, [hash, data]);

  const onChanged = () => {
    void queryClient.invalidateQueries({ queryKey: MY_SHARED_KEY });
  };

  if (isLoading) {
    return (
      <section className="bt-phone-surface bt-my-shared-page flex flex-col gap-4">
        <SkeletonBlock height={28} width={210} />
        <SkeletonBlock height={92} />
      </section>
    );
  }

  if (isError || !data) {
    return (
      <div className="bt-phone-surface bt-my-shared-page flex flex-col items-start gap-3">
        <Alert tone="error">{t('social.myShared.error')}</Alert>
        <Button onClick={() => void refetch()}>{t('common.retry')}</Button>
      </div>
    );
  }

  const nothing =
    shareablePortfolios.length === 0 &&
    data.conglomerates.length === 0 &&
    data.watchlists.length === 0 &&
    data.ideas.length === 0;

  const shareLabel = t('sharing.shareButton');
  const commentsLabel = t('social.myShared.comments');

  return (
    <div className="bt-phone-surface bt-my-shared-page flex flex-col">
      <PageHead sub={t('social.myShared.subtitle')} title={t('social.myShared.title')} />
      {data.portfolios.length > 0 && !portfolioMetadataReady && !portfoliosQuery.isError ? (
        <div className="mb-4" data-testid="portfolio-share-metadata-loading">
          <Spinner label={t('social.myShared.portfolioMetadataLoading')} />
        </div>
      ) : data.portfolios.length > 0 && portfoliosQuery.isError ? (
        <div className="mb-4 flex flex-col items-start gap-2">
          <Alert tone="error">{t('social.myShared.portfolioMetadataError')}</Alert>
          <Button onClick={() => void portfoliosQuery.refetch()} size="sm">
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {nothing ? (
        <EmptyState
          title={t('social.myShared.emptyTitle')}
          description={t('social.myShared.emptyBody')}
        />
      ) : null}
      {shareablePortfolios.length > 0 ? (
        <section className="bt-section">
          <SectionHead title={t('social.kind.portfolios')} />
          <ul className="bt-band flex flex-col">
            {shareablePortfolios.map((p) => (
              <SharedRow
                key={p.portfolioId}
                name={p.name}
                audience={p.audience}
                friendCount={p.friendCount}
                group={p.group}
                onShare={() =>
                  setPicker({
                    kind: 'portfolio',
                    subjectId: p.portfolioId,
                    label: p.name,
                  })
                }
                shareLabel={shareLabel}
                shareDisabled={!portfolioMetadataReady}
                onComments={() =>
                  setThread({ kind: 'portfolio', subjectId: p.portfolioId, label: p.name })
                }
                commentsLabel={commentsLabel}
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
                group={c.group}
                detail={t('social.item.positions', { count: c.positionCount })}
                onShare={() =>
                  setPicker({ kind: 'conglomerate', subjectId: c.conglomerateId, label: c.name })
                }
                shareLabel={shareLabel}
                onComments={() =>
                  setThread({ kind: 'conglomerate', subjectId: c.conglomerateId, label: c.name })
                }
                commentsLabel={commentsLabel}
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
                group={w.group}
                detail={t('social.item.assets', { count: w.itemCount })}
                onShare={() =>
                  setPicker({ kind: 'watchlist', subjectId: w.watchlistId, label: w.name })
                }
                shareLabel={shareLabel}
                onComments={() =>
                  setThread({ kind: 'watchlist', subjectId: w.watchlistId, label: w.name })
                }
                commentsLabel={commentsLabel}
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
                group={i.group}
                detail={i.hasThesis ? t('social.item.ideaThesis') : undefined}
                onShare={() => setPicker({ kind: 'idea', subjectId: i.ideaId, label: i.name })}
                shareLabel={shareLabel}
                onComments={() => setThread({ kind: 'idea', subjectId: i.ideaId, label: i.name })}
                commentsLabel={commentsLabel}
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

      {/* The owner's moderation surface (§13.5 V5-P8): the SAME thread the
          audience sees, opened on the owner's own item. `canDelete` arrives
          from the server, which grants the item owner every comment — so the
          delete affordance simply appears on all of them here. One dialog at a
          time keeps this compact and costs one thread read, not one per row. */}
      {thread ? (
        <Dialog
          phoneSheet
          title={t('social.myShared.commentsTitle', { name: thread.label })}
          onClose={() => setThread(null)}
        >
          <CommentThread defaultExpanded kind={thread.kind} subjectId={thread.subjectId} />
        </Dialog>
      ) : null}

      {picker && (picker.kind !== 'portfolio' || portfolioMetadataReady) ? (
        <AudiencePicker
          kind={picker.kind}
          subjectId={picker.subjectId}
          subjectLabel={picker.label}
          mirrorSyncedCopy={
            picker.kind === 'portfolio' && mirrorSyncedPortfolios.has(picker.subjectId)
          }
          onClose={() => setPicker(null)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}
