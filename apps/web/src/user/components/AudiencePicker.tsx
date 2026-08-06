import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  SHARE_AUDIENCES,
  audienceTransitionRequiresConfirmation,
  type ShareAudience,
  type ShareKind,
} from '@bettertrack/contracts';

import { getAudience, listFriends, listGroups, setAudience } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { Button, Icon, Input } from '../../ui/origin';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { Alert, Spinner } from './ui';

/**
 * The ONE reusable sharing control (PROJECTPLAN.md §13.3 V3-P5/P6, §16), used by
 * every shareable kind — each portfolio, conglomerate and watchlist. V3-P6 lifts
 * it from a plain radio-list + checkbox roster toward the mobile app's audience
 * sheet: a five-tier picker of rich cards, a **searchable, avatar'd** multi-select
 * for `specific_friends` (not a raw checkbox list), the light `all_friends`
 * confirmation gate, and the strong `public_link` acknowledgment with a copy/share
 * affordance once the link is minted. It carries the §16 friction ladder:
 *
 *  - `public_link` → a STRONG explicit-acknowledgment warning; Save cannot submit
 *    until the acknowledgment is checked (mirrored server-side).
 *  - every genuine widening (including newly named recipients) → an explicit
 *    confirmation; narrowing and exact re-saves stay friction-free.
 *
 * Backend authorization is a separate single enforcement layer; this component
 * only expresses intent through `PUT /social/audience/:kind/:subjectId`.
 */
export interface AudiencePickerProps {
  kind: ShareKind;
  subjectId: string;
  /** The subject's display name, shown in the dialog title. */
  subjectLabel: string;
  onClose: () => void;
  /** Called after a successful save with the new audience value. */
  onChanged?: (audience: ShareAudience) => void;
  /**
   * MIRRORCHAIN §10 share notice (V5-P7 M5): true when this subject is a
   * synced copy of an active chain (i.e. `portfolio.mirror` is present). The
   * dialog then carries a one-line notice that co-members remain visible to
   * the caller but their names are hidden from anyone the portfolio is shared
   * with who is not also a chain member. Absent → normal share dialog.
   */
  mirrorSyncedCopy?: boolean;
}

// ── Tier iconography (inline SVG, dependency-free — matches the app house style) ─
function TierIcon({ audience, className }: { audience: ShareAudience; className?: string }) {
  const common = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (audience) {
    case 'private':
      return (
        <svg {...common}>
          <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
      );
    case 'specific_friends':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
          <path d="M16 11.2a3 3 0 0 0 0-6" />
          <path d="M17 20a5.5 5.5 0 0 0-2.5-4.6" />
        </svg>
      );
    case 'group':
      return (
        <svg {...common}>
          <circle cx="8" cy="9" r="2.6" />
          <circle cx="16" cy="9" r="2.6" />
          <path d="M3.5 19a4.5 4.5 0 0 1 9 0" />
          <path d="M11.5 19a4.5 4.5 0 0 1 9 0" />
        </svg>
      );
    case 'all_friends':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.2" />
          <path d="M6 20a6 6 0 0 1 12 0" />
        </svg>
      );
    case 'public_link':
      return (
        <svg {...common}>
          <path d="M9.5 14.5l5-5" />
          <path d="M8 11l-2 2a3.5 3.5 0 0 0 5 5l2-2" />
          <path d="M16 13l2-2a3.5 3.5 0 0 0-5-5l-2 2" />
        </svg>
      );
  }
}

/**
 * Selection chrome, Origin-style. This dialog is the one place gold carries a
 * *decision*: the chosen tier (and each chosen friend/group) takes the accent
 * rule plus its soft wash, everything else stays on quiet neutral borders. That
 * keeps the privacy choice unmistakable without flooding the sheet with gold.
 */
function selectedSurface(active: boolean): CSSProperties {
  return {
    background: active ? 'var(--bt-gold-soft)' : 'none',
    border: `1px solid ${active ? 'var(--bt-gold)' : 'var(--bt-border)'}`,
    borderRadius: 8,
    transition: 'background var(--bt-t-fast), border-color var(--bt-t-fast)',
  };
}

/** The round/square "chosen" marker at the end of each selectable row. */
function CheckMark({ active, square = false }: { active: boolean; square?: boolean }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{
        background: active ? 'var(--bt-gold)' : 'none',
        border: `1px solid ${active ? 'var(--bt-gold)' : 'var(--bt-border-strong)'}`,
        borderRadius: square ? 5 : '50%',
        color: active ? 'var(--bt-gold-ink)' : 'transparent',
        height: 20,
        width: 20,
      }}
    >
      <Icon name="check" size={12} />
    </span>
  );
}

export function AudiencePicker({
  kind,
  subjectId,
  subjectLabel,
  onClose,
  onChanged,
  mirrorSyncedCopy = false,
}: AudiencePickerProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const feedback = useMutationFeedback();

  const audienceQuery = useQuery({
    queryKey: ['social', 'audience', kind, subjectId],
    queryFn: ({ signal }) => getAudience(kind, subjectId, signal),
  });
  const friendsQuery = useQuery({
    queryKey: ['social', 'friends'],
    queryFn: ({ signal }) => listFriends(signal),
  });
  const groupsQuery = useQuery({
    queryKey: ['social', 'groups'],
    queryFn: ({ signal }) => listGroups(signal),
  });

  const [selected, setSelected] = useState<ShareAudience | null>(null);
  const [friendIds, setFriendIds] = useState<Set<string>>(new Set());
  const [groupId, setGroupId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [widenConfirmed, setWidenConfirmed] = useState(false);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [publicLinkKept, setPublicLinkKept] = useState(false);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [snapshotKey, setSnapshotKey] = useState<string | null>(null);

  const readsFetching =
    audienceQuery.isFetching || friendsQuery.isFetching || groupsQuery.isFetching;
  const authoritativeKey =
    audienceQuery.isSuccess && friendsQuery.isSuccess && groupsQuery.isSuccess && !readsFetching
      ? `${audienceQuery.dataUpdatedAt}:${friendsQuery.dataUpdatedAt}:${groupsQuery.dataUpdatedAt}`
      : null;

  // A cached query mounts as successful while TanStack refreshes it. Do not seed
  // editable privacy state from that stale payload: wait for all three active
  // reads to settle, then take one coherent snapshot. A later focus refresh
  // temporarily gates the form and reconciles it again before Save reappears.
  useEffect(() => {
    const loaded = audienceQuery.data;
    if (!authoritativeKey || snapshotKey === authoritativeKey || !loaded) return;
    setSelected(loaded.audience);
    setFriendIds(new Set(loaded.friendIds));
    setGroupId(loaded.groupId);
    setAcknowledged(false);
    setWidenConfirmed(false);
    setSnapshotKey(authoritativeKey);
  }, [audienceQuery.data, authoritativeKey, snapshotKey]);

  const snapshotReady = authoritativeKey !== null && snapshotKey === authoritativeKey;
  const audience: ShareAudience = selected ?? 'private';
  const initialAudience = audienceQuery.data?.audience;
  const hasActivePublicLink = audienceQuery.data?.link.active === true;
  const nextSelection = {
    audience,
    friendIds: audience === 'specific_friends' ? [...friendIds] : undefined,
    groupId: audience === 'group' ? groupId : null,
  };
  const requiresWidenConfirmation =
    snapshotReady && audienceQuery.data
      ? audienceTransitionRequiresConfirmation(audienceQuery.data, nextSelection)
      : false;
  const wideningConfirmed = audience === 'public_link' ? acknowledged : widenConfirmed;

  const mutation = useMutation({
    mutationFn: () =>
      setAudience(kind, subjectId, {
        audience,
        friendIds: nextSelection.friendIds,
        groupId: audience === 'group' ? (groupId ?? undefined) : undefined,
        acknowledgePublic: audience === 'public_link' ? acknowledged : undefined,
        confirmWiden: requiresWidenConfirmation ? wideningConfirmed : undefined,
      }),
    onMutate: () => setPublicLinkKept(false),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['social'] });
      void queryClient.invalidateQueries({ queryKey: ['workboard'] });
      onChanged?.(result.state.audience);
      if (result.link) {
        setMintedUrl(`${window.location.origin}/s/${result.link.token}`);
      } else if (result.state.audience === 'public_link' && result.state.link.active) {
        // The server stores only the token hash, so saving an already-active
        // public audience cannot reveal the URL again. Keep the sheet open and
        // make that successful no-change outcome explicit instead of silently
        // closing it.
        setPublicLinkKept(true);
      } else {
        feedback.success(t('mutationFeedback.sharingSaved'));
        onClose();
      }
    },
  });

  const friends = friendsQuery.data?.friends ?? [];
  const filteredFriends = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter((f) => f.user.username.toLowerCase().includes(q));
  }, [friends, search]);

  function toggleFriend(id: string) {
    setWidenConfirmed(false);
    setFriendIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyLink() {
    if (!mintedUrl) return;
    try {
      await navigator.clipboard.writeText(mintedUrl);
      setCopied(true);
    } catch {
      // Clipboard unavailable — the URL is on screen to copy manually.
    }
  }

  async function shareLink() {
    if (!mintedUrl) return;
    try {
      await navigator.share?.({ title: subjectLabel, url: mintedUrl });
    } catch {
      // User dismissed the share sheet, or it is unavailable — no-op.
    }
  }

  const groups = groupsQuery.data?.groups ?? [];
  const readsPending =
    audienceQuery.isPending ||
    friendsQuery.isPending ||
    groupsQuery.isPending ||
    readsFetching ||
    !snapshotReady;
  const readsFailed = audienceQuery.isError || friendsQuery.isError || groupsQuery.isError;
  const canSubmit =
    snapshotReady &&
    !mutation.isPending &&
    !(audience === 'public_link' && !acknowledged) &&
    !(requiresWidenConfirmation && !wideningConfirmed) &&
    // The group tier's friction: a group must actually be chosen to share.
    !(audience === 'group' && !groupId);

  // Once a link is minted we show it (hash-only storage → shown exactly once).
  if (mintedUrl) {
    const canNativeShare =
      typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    return (
      <Dialog phoneSheet title={t('sharing.title', { name: subjectLabel })} onClose={onClose}>
        <div className="flex flex-col gap-3">
          <Alert tone="success">{t('sharing.publicLinkReady')}</Alert>
          <div className="flex items-center gap-2">
            <code className="bt-input min-w-0 flex-1 overflow-x-auto">{mintedUrl}</code>
            {/* Copying the freshly minted link is the whole point of this
                state — it takes the gold; Close stays quiet. */}
            <Button onClick={copyLink} variant="primary">
              {copied ? t('sharing.copied') : t('sharing.copy')}
            </Button>
            {canNativeShare ? <Button onClick={shareLink}>{t('sharing.share')}</Button> : null}
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose} variant="quiet">
              {t('common.close')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (readsPending && !readsFailed) {
    return (
      <Dialog
        phoneSheet
        title={t('sharing.title', { name: subjectLabel })}
        description={t('sharing.subtitle')}
        onClose={onClose}
      >
        <div className="flex flex-col gap-4">
          <Spinner label={t('sharing.loading')} />
          <div className="flex justify-end">
            <Button onClick={onClose} variant="quiet">
              {t('sharing.cancel')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (readsFailed) {
    return (
      <Dialog
        phoneSheet
        title={t('sharing.title', { name: subjectLabel })}
        description={t('sharing.subtitle')}
        onClose={onClose}
      >
        <div className="flex flex-col gap-4">
          <Alert tone="error">{t('sharing.loadError')}</Alert>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} variant="quiet">
              {t('sharing.cancel')}
            </Button>
            <Button
              onClick={() => {
                void audienceQuery.refetch();
                void friendsQuery.refetch();
                void groupsQuery.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const selectedCount = friendIds.size;

  return (
    <Dialog
      phoneSheet
      title={t('sharing.title', { name: subjectLabel })}
      description={t('sharing.subtitle')}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {mirrorSyncedCopy ? <Alert tone="info">{t('mirrorchain.share.syncedNotice')}</Alert> : null}
        {hasActivePublicLink ? <Alert tone="info">{t('sharing.publicActive')}</Alert> : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="bt-label" style={{ marginBottom: 4 }}>
            {t('sharing.audienceLabel')}
          </legend>
          {SHARE_AUDIENCES.map((value) => {
            const active = audience === value;
            return (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-3"
                style={{ ...selectedSurface(active), padding: 12 }}
              >
                <input
                  type="radio"
                  name="audience"
                  className="sr-only"
                  value={value}
                  checked={active}
                  onChange={() => {
                    setSelected(value);
                    setPublicLinkKept(false);
                    setWidenConfirmed(false);
                    if (value !== 'public_link') setAcknowledged(false);
                  }}
                />
                <span
                  className="flex shrink-0 items-center justify-center"
                  style={{
                    background: active ? 'none' : 'var(--bt-surface-strong)',
                    borderRadius: 6,
                    color: active ? 'var(--bt-gold)' : 'var(--bt-muted)',
                    height: 34,
                    width: 34,
                  }}
                >
                  <TierIcon audience={value} className="h-5 w-5" />
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="bt-row-title">{t(`sharing.options.${value}.label`)}</span>
                  <span className="bt-row-sub">{t(`sharing.options.${value}.desc`)}</span>
                </span>
                <CheckMark active={active} />
              </label>
            );
          })}
        </fieldset>

        {audience === 'specific_friends' ? (
          <div className="flex flex-col gap-2">
            {friends.length === 0 ? (
              <p className="bt-meta">{t('sharing.friendsNone')}</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <Input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('sharing.friendsSearchPlaceholder')}
                    aria-label={t('sharing.friendsSearchPlaceholder')}
                    className="min-w-0 flex-1"
                  />
                  <span className="bt-meta shrink-0">
                    {t('sharing.friendsSelectedCount', { count: selectedCount })}
                  </span>
                </div>
                {filteredFriends.length === 0 ? (
                  <p className="bt-meta" style={{ padding: '8px 4px' }}>
                    {t('sharing.friendsNoMatch', { query: search.trim() })}
                  </p>
                ) : (
                  <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
                    {filteredFriends.map((f) => {
                      const checked = friendIds.has(f.user.id);
                      return (
                        <li key={f.user.id}>
                          <label
                            className="flex cursor-pointer items-center gap-3"
                            style={{ ...selectedSurface(checked), padding: 8 }}
                          >
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={checked}
                              onChange={() => toggleFriend(f.user.id)}
                            />
                            <Avatar name={f.user.username} iconId={f.user.profileIcon} size="sm" />
                            <span className="bt-soft flex-1 truncate">{f.user.username}</span>
                            <CheckMark active={checked} square />
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        ) : null}

        {audience === 'group' ? (
          <div className="flex flex-col gap-2">
            {groups.length === 0 ? (
              <p className="bt-meta">{t('sharing.groupsNone')}</p>
            ) : (
              <>
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
                  {groups.map((g) => {
                    const checked = groupId === g.id;
                    return (
                      <li key={g.id}>
                        <label
                          className="flex cursor-pointer items-center gap-3"
                          style={{ ...selectedSurface(checked), padding: 8 }}
                        >
                          <input
                            type="radio"
                            name="group"
                            className="sr-only"
                            checked={checked}
                            onChange={() => {
                              setGroupId(g.id);
                              setWidenConfirmed(false);
                            }}
                          />
                          <span className="bt-soft flex-1 truncate">{g.name}</span>
                          <span className="bt-meta shrink-0">
                            {t('sharing.groupMemberCount', { count: g.memberCount })}
                          </span>
                          <CheckMark active={checked} />
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <Alert tone="info">{t('sharing.groupConfirm')}</Alert>
              </>
            )}
          </div>
        ) : null}

        {requiresWidenConfirmation && audience !== 'public_link' && initialAudience ? (
          <Alert tone="info">
            <div className="flex flex-col gap-2">
              <p>
                {t('sharing.audienceChangeConfirm', {
                  from: t(`sharing.badge.${initialAudience}`),
                  to: t(`sharing.badge.${audience}`),
                })}
              </p>
              <label className="bt-soft flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={widenConfirmed}
                  onChange={(event) => setWidenConfirmed(event.target.checked)}
                  style={{ accentColor: 'var(--bt-gold)' }}
                />
                <span>{t('sharing.audienceWidenAcknowledge')}</span>
              </label>
            </div>
          </Alert>
        ) : null}

        {audience === 'public_link' ? (
          // §16 friction ladder, top rung: the strongest emphasis this dialog
          // has — the accent rule and its wash, with the warning line in gold.
          <div
            className="flex flex-col gap-2"
            style={{
              background: 'var(--bt-gold-soft)',
              border: '1px solid var(--bt-border-accent)',
              borderRadius: 8,
              padding: 12,
            }}
          >
            <p className="bt-gold" style={{ fontWeight: 600 }}>
              {t('sharing.publicWarning')}
            </p>
            <label className="bt-soft flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                style={{ accentColor: 'var(--bt-gold)' }}
              />
              <span>{t('sharing.publicAcknowledge')}</span>
            </label>
          </div>
        ) : null}

        {publicLinkKept && audience === 'public_link' ? (
          <Alert tone="success">{t('sharing.publicLinkKept')}</Alert>
        ) : null}
        {mutation.isError ? <Alert tone="error">{t('sharing.error')}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="quiet">
            {t('sharing.cancel')}
          </Button>
          <Button disabled={!canSubmit} onClick={() => mutation.mutate()} variant="primary">
            {mutation.isPending ? t('sharing.saving') : t('sharing.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
