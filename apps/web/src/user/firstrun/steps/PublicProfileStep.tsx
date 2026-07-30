import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useT } from '../../../i18n';
import { getProfileSettings, updateProfileSettings } from '../../../lib/socialApi';
import { Badge, Switch } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { Avatar } from '../../components/Avatar';
import { Alert, CHECKBOX_STYLE } from '../../components/ui';
import type { FirstRunStepProps } from '../types';

const PROFILE_KEY = ['social', 'profile'] as const;

/**
 * Step 6 — your public face.
 *
 * The visibility toggle is REAL (`PUT /social/profile`) and keeps the §16
 * friction ladder intact: turning the profile public requires the explicit
 * acknowledgement checkbox, mirrored server-side. Shortening that for the sake
 * of a slim wizard would weaken a privacy boundary, so it stays — a public
 * profile shows strangers everything you have made public.
 *
 * The picture is parked: there is no upload route anywhere in the API (only CSV
 * multipart), so the preview shows the account's real avatar — the curated icon,
 * or the deterministic default derived from the name — and says plainly that
 * choosing one lands on the profile page.
 */
export function PublicProfileStep({ report }: FirstRunStepProps) {
  const t = useT();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [acknowledged, setAcknowledged] = useState(false);

  const profile = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: ({ signal }) => getProfileSettings(signal),
    staleTime: 30_000,
  });

  const isPublic = profile.data?.isPublic === true;

  const save = useMutation({
    mutationFn: (nextPublic: boolean) =>
      updateProfileSettings({
        isPublic: nextPublic,
        // Passed through verbatim: `bio` is optional on the request, and this
        // step has no business rewriting a line it never showed.
        bio: profile.data?.bio ?? null,
        acknowledgePublic: nextPublic ? true : undefined,
      }),
    onSuccess: (res) => queryClient.setQueryData(PROFILE_KEY, res),
  });

  // A private profile is the default, so "still private" cannot be told apart
  // from "walked past" — only an actual save counts as a decision made here.
  const decided = save.isSuccess;
  const busy = save.isPending;
  useEffect(() => {
    report({ status: decided ? 'complete' : 'skipped', busy });
  }, [report, decided, busy]);

  const name = user?.username ?? '';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3.5">
        <Avatar name={name} iconId={user?.profileIcon ?? null} size="lg" />
        <div>
          <div className="bt-fr__rowlabel">{name}</div>
          <div className="mt-1 flex items-center gap-2">
            <Badge outline>{t('firstrun.parkedFlag')}</Badge>
            <span className="bt-muted text-xs">{t('firstrun.publicProfile.pictureParked')}</span>
          </div>
        </div>
      </div>

      <div>
        <div className="bt-fr__row">
          <div>
            <div className="bt-fr__rowlabel">{t('firstrun.publicProfile.toggleLabel')}</div>
            <p className="bt-fr__rowsub">{t('firstrun.publicProfile.toggleHint')}</p>
          </div>
          <Switch
            aria-label={t('firstrun.publicProfile.toggleLabel')}
            checked={isPublic}
            disabled={busy || !profile.isSuccess}
            onChange={(next) => {
              // Turning it OFF is instant (unpublishing is never gated); turning
              // it ON waits for the acknowledgement below.
              if (!next) {
                setAcknowledged(false);
                save.mutate(false);
                return;
              }
              if (acknowledged) save.mutate(true);
            }}
          />
        </div>
        {!isPublic ? (
          <label className="mt-3.5 flex items-start gap-2.5">
            <input
              type="checkbox"
              name="acknowledgePublic"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-4 w-4"
              style={CHECKBOX_STYLE}
            />
            <span className="bt-soft text-sm">{t('firstrun.publicProfile.acknowledge')}</span>
          </label>
        ) : null}
      </div>

      {save.isError ? <Alert tone="error">{t('common.genericError')}</Alert> : null}
    </div>
  );
}
