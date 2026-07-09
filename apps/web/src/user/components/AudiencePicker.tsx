import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SHARE_AUDIENCES, type ShareAudience, type ShareKind } from '@bettertrack/contracts';

import { getAudience, listFriends, setAudience } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { Dialog } from './Dialog';
import { Alert, Button, cx } from './ui';

/**
 * The ONE reusable sharing control (PROJECTPLAN.md §13.3 V3-P5, §16). Used by
 * every shareable kind — each portfolio, each conglomerate, each watchlist — it
 * renders the single audience ladder and the friction ladder that ships with it:
 *
 *  - `public_link` → a STRONG explicit-acknowledgment warning ("anyone with the
 *    link sees your holdings and net worth"); Save cannot submit until the
 *    acknowledgment is checked (mirrored server-side).
 *  - `all_friends` → a light confirm note.
 *  - `specific_friends` → a friend multi-select, no confirm.
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

  const canSubmit = !mutation.isPending && !(audience === 'public_link' && !acknowledged);

  // Once a link is minted we show it (hash-only storage → shown exactly once).
  if (mintedUrl) {
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
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>
      </Dialog>
    );
  }

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
          {SHARE_AUDIENCES.map((value) => (
            <label
              key={value}
              className={cx(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3',
                audience === value
                  ? 'border-sky-500 bg-sky-500/10'
                  : 'border-neutral-800 hover:border-neutral-700',
              )}
            >
              <input
                type="radio"
                name="audience"
                className="mt-1"
                value={value}
                checked={audience === value}
                onChange={() => {
                  setSelected(value);
                  if (value !== 'public_link') setAcknowledged(false);
                }}
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium text-neutral-100">
                  {t(`sharing.options.${value}.label`)}
                </span>
                <span className="text-xs text-neutral-500">
                  {t(`sharing.options.${value}.desc`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {audience === 'specific_friends' ? (
          <div className="flex flex-col gap-2">
            {(friendsQuery.data?.friends.length ?? 0) === 0 ? (
              <p className="text-sm text-neutral-500">{t('sharing.friendsNone')}</p>
            ) : (
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                {friendsQuery.data?.friends.map((f) => (
                  <li key={f.user.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-neutral-800">
                      <input
                        type="checkbox"
                        checked={friendIds.has(f.user.id)}
                        onChange={() => toggleFriend(f.user.id)}
                      />
                      <span className="text-sm text-neutral-200">{f.user.username}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {audience === 'all_friends' ? (
          <Alert tone="info">{t('sharing.allFriendsConfirm')}</Alert>
        ) : null}

        {audience === 'public_link' ? (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
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
