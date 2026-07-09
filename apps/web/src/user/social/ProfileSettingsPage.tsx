import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PROFILE_BIO_MAX } from '@bettertrack/contracts';

import { getProfileSettings, updateProfileSettings } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { Skeleton } from '../../ui';
import { Alert, Button, cx } from '../components/ui';

const PROFILE_KEY = ['social', 'profile'] as const;

/**
 * My Public Profile (§6.9, §14, V3-P6) — the owner-facing settings for the opt-in
 * public page at `/u/<username>`. Enabling passes the §16 friction ladder (a
 * strong warning + explicit acknowledgment, mirrored server-side); disabling
 * unpublishes the page instantly (the slug 404s). The page composes ONLY the
 * user's `public_link` items — this screen makes that plain and links to the live
 * page.
 */
export function ProfileSettingsPage() {
  const t = useT();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: ({ signal }) => getProfileSettings(signal),
  });

  const [draftPublic, setDraftPublic] = useState<boolean | null>(null);
  const [draftBio, setDraftBio] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [copied, setCopied] = useState(false);

  const serverPublic = data?.isPublic ?? false;
  const isPublic = draftPublic ?? serverPublic;
  const bio = draftBio ?? data?.bio ?? '';
  // Enabling from an off state is the only path that needs the acknowledgment;
  // editing the bio while already public does not re-gate.
  const enabling = isPublic && !serverPublic;

  const mutation = useMutation({
    mutationFn: () =>
      updateProfileSettings({
        isPublic,
        bio: bio.trim().length > 0 ? bio.trim() : null,
        acknowledgePublic: isPublic ? true : undefined,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(PROFILE_KEY, result);
      setDraftPublic(null);
      setDraftBio(null);
      setAck(false);
    },
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-6" width="w-48" />
        <Skeleton height="h-24" />
      </section>
    );
  }

  if (isError || !data) {
    return <Alert tone="error">{t('profile.error')}</Alert>;
  }

  const profileUrl = `${window.location.origin}/u/${data.username}`;
  const dirty = draftPublic !== null || draftBio !== null;
  const canSave = !mutation.isPending && dirty && (!enabling || ack);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
    } catch {
      // Clipboard unavailable — the URL is on screen to copy manually.
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          {t('profile.title')}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">{t('profile.subtitle')}</p>
      </div>

      {/* Opt-in toggle */}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-100">{t('profile.toggleLabel')}</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {t('profile.publicItemCount', { count: data.publicItemCount })}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isPublic}
          aria-label={t('profile.toggleLabel')}
          onClick={() => {
            setDraftPublic(!isPublic);
            setAck(false);
          }}
          className={cx(
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
            isPublic ? 'bg-sky-600' : 'bg-neutral-700',
          )}
        >
          <span
            className={cx(
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
              isPublic ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {/* Strong friction warning shown only while enabling from off */}
      {enabling ? (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-amber-200">{t('profile.warningTitle')}</p>
          <p className="text-sm text-neutral-300">{t('profile.warningBody')}</p>
          <label className="mt-1 flex cursor-pointer items-start gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>{t('profile.acknowledge')}</span>
          </label>
        </div>
      ) : null}

      {/* Bio */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="profile-bio" className="text-sm font-medium text-neutral-300">
          {t('profile.bioLabel')}
        </label>
        <textarea
          id="profile-bio"
          value={bio}
          maxLength={PROFILE_BIO_MAX}
          onChange={(e) => setDraftBio(e.target.value)}
          rows={3}
          placeholder={t('profile.bioPlaceholder')}
          className="rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
        />
        <p className="text-xs text-neutral-500">
          {t('profile.bioCount', { count: bio.length, max: PROFILE_BIO_MAX })}
        </p>
      </div>

      {/* Live URL (only meaningful while public on the server) */}
      {serverPublic ? (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
          <p className="text-sm font-medium text-neutral-100">{t('profile.liveTitle')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200">
              {profileUrl}
            </code>
            <Button variant="secondary" onClick={copyUrl}>
              {copied ? t('sharing.copied') : t('sharing.copy')}
            </Button>
            <a
              href={`/u/${data.username}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-md bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-100 ring-1 ring-inset ring-neutral-700 transition-colors hover:bg-neutral-700"
            >
              {t('profile.view')}
            </a>
          </div>
        </div>
      ) : null}

      {mutation.isError ? <Alert tone="error">{t('profile.saveError')}</Alert> : null}
      {mutation.isSuccess && !dirty ? <Alert tone="success">{t('profile.saved')}</Alert> : null}

      <div className="flex justify-end">
        <Button onClick={() => mutation.mutate()} disabled={!canSave}>
          {mutation.isPending ? t('sharing.saving') : t('profile.save')}
        </Button>
      </div>
    </div>
  );
}
