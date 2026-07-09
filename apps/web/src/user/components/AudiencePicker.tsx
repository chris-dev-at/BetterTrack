import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SHARE_AUDIENCES, type ShareAudience, type ShareKind } from '@bettertrack/contracts';

import { getAudience, listFriends, setAudience } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { Alert, Button, cx } from './ui';

/**
 * The ONE reusable sharing control (PROJECTPLAN.md §13.3 V3-P5/P6, §16), used by
 * every shareable kind — each portfolio, conglomerate and watchlist. V3-P6 lifts
 * it from a plain radio-list + checkbox roster toward the mobile app's audience
 * sheet: a four-tier picker of rich cards, a **searchable, avatar'd** multi-select
 * for `specific_friends` (not a raw checkbox list), the light `all_friends`
 * confirm, and the strong `public_link` acknowledgment with a copy/share
 * affordance once the link is minted. It carries the §16 friction ladder:
 *
 *  - `public_link` → a STRONG explicit-acknowledgment warning; Save cannot submit
 *    until the acknowledgment is checked (mirrored server-side).
 *  - `all_friends` → a light confirm note.
 *  - `specific_friends` → the searchable friend multi-select, no confirm.
 *  - `private` → nothing.
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

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function AudiencePicker({
  kind,
  subjectId,
  subjectLabel,
  onClose,
  onChanged,
}: AudiencePickerProps) {
  const t = useT();
  const queryClient = useQueryClient();

  const audienceQuery = useQuery({
    queryKey: ['social', 'audience', kind, subjectId],
    queryFn: ({ signal }) => getAudience(kind, subjectId, signal),
  });
  const friendsQuery = useQuery({
    queryKey: ['social', 'friends'],
    queryFn: ({ signal }) => listFriends(signal),
  });

  const [selected, setSelected] = useState<ShareAudience | null>(null);
  const [friendIds, setFriendIds] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState(false);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');

  // Seed local state from the server once, on first load.
  const loaded = audienceQuery.data;
  const audience: ShareAudience = selected ?? loaded?.audience ?? 'private';
  if (selected === null && loaded && friendIds.size === 0 && loaded.friendIds.length > 0) {
    setFriendIds(new Set(loaded.friendIds));
  }

  const mutation = useMutation({
    mutationFn: () =>
      setAudience(kind, subjectId, {
        audience,
        friendIds: audience === 'specific_friends' ? [...friendIds] : undefined,
        acknowledgePublic: audience === 'public_link' ? acknowledged : undefined,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['social'] });
      void queryClient.invalidateQueries({ queryKey: ['workboard'] });
      onChanged?.(result.state.audience);
      if (result.link) {
        setMintedUrl(`${window.location.origin}/s/${result.link.token}`);
      } else {
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

  const canSubmit = !mutation.isPending && !(audience === 'public_link' && !acknowledged);

  // Once a link is minted we show it (hash-only storage → shown exactly once).
  if (mintedUrl) {
    const canNativeShare =
      typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    return (
      <Dialog title={t('sharing.title', { name: subjectLabel })} onClose={onClose}>
        <div className="flex flex-col gap-3">
          <Alert tone="success">{t('sharing.publicLinkReady')}</Alert>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200">
              {mintedUrl}
            </code>
            <Button variant="secondary" onClick={copyLink}>
              {copied ? t('sharing.copied') : t('sharing.copy')}
            </Button>
            {canNativeShare ? (
              <Button variant="secondary" onClick={shareLink}>
                {t('sharing.share')}
              </Button>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const selectedCount = friendIds.size;

  return (
    <Dialog
      title={t('sharing.title', { name: subjectLabel })}
      description={t('sharing.subtitle')}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {t('sharing.audienceLabel')}
          </legend>
          {SHARE_AUDIENCES.map((value) => {
            const active = audience === value;
            return (
              <label
                key={value}
                className={cx(
                  'group flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors',
                  active
                    ? 'border-sky-500 bg-sky-500/10 ring-1 ring-inset ring-sky-500/40'
                    : 'border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/40',
                )}
              >
                <input
                  type="radio"
                  name="audience"
                  className="sr-only"
                  value={value}
                  checked={active}
                  onChange={() => {
                    setSelected(value);
                    if (value !== 'public_link') setAcknowledged(false);
                  }}
                />
                <span
                  className={cx(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                    active
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'bg-neutral-800 text-neutral-400 group-hover:text-neutral-300',
                  )}
                >
                  <TierIcon audience={value} className="h-5 w-5" />
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="text-sm font-medium text-neutral-100">
                    {t(`sharing.options.${value}.label`)}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {t(`sharing.options.${value}.desc`)}
                  </span>
                </span>
                <span
                  className={cx(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    active
                      ? 'border-sky-400 bg-sky-500 text-white'
                      : 'border-neutral-700 text-transparent',
                  )}
                >
                  <CheckIcon className="h-3 w-3" />
                </span>
              </label>
            );
          })}
        </fieldset>

        {audience === 'specific_friends' ? (
          <div className="flex flex-col gap-2">
            {friends.length === 0 ? (
              <p className="text-sm text-neutral-500">{t('sharing.friendsNone')}</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('sharing.friendsSearchPlaceholder')}
                    aria-label={t('sharing.friendsSearchPlaceholder')}
                    className="min-w-0 flex-1 rounded-md bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                  <span className="shrink-0 text-xs text-neutral-500">
                    {t('sharing.friendsSelectedCount', { count: selectedCount })}
                  </span>
                </div>
                {filteredFriends.length === 0 ? (
                  <p className="px-1 py-2 text-sm text-neutral-500">
                    {t('sharing.friendsNoMatch', { query: search.trim() })}
                  </p>
                ) : (
                  <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
                    {filteredFriends.map((f) => {
                      const checked = friendIds.has(f.user.id);
                      return (
                        <li key={f.user.id}>
                          <label
                            className={cx(
                              'flex cursor-pointer items-center gap-3 rounded-lg border p-2 transition-colors',
                              checked
                                ? 'border-sky-500/60 bg-sky-500/10'
                                : 'border-transparent hover:bg-neutral-800',
                            )}
                          >
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={checked}
                              onChange={() => toggleFriend(f.user.id)}
                            />
                            <Avatar name={f.user.username} size="sm" />
                            <span className="flex-1 truncate text-sm text-neutral-200">
                              {f.user.username}
                            </span>
                            <span
                              className={cx(
                                'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                                checked
                                  ? 'border-sky-400 bg-sky-500 text-white'
                                  : 'border-neutral-600 text-transparent',
                              )}
                            >
                              <CheckIcon className="h-3 w-3" />
                            </span>
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

        {audience === 'all_friends' ? (
          <Alert tone="info">{t('sharing.allFriendsConfirm')}</Alert>
        ) : null}

        {audience === 'public_link' ? (
          <div className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-sm font-medium text-amber-200">{t('sharing.publicWarning')}</p>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-200">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>{t('sharing.publicAcknowledge')}</span>
            </label>
          </div>
        ) : null}

        {mutation.isError ? <Alert tone="error">{t('sharing.error')}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('sharing.cancel')}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>
            {mutation.isPending ? t('sharing.saving') : t('sharing.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
