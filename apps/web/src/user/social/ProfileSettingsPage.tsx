import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PROFILE_BIO_MAX, PROFILE_ICON_IDS, type ProfileIconId } from '@bettertrack/contracts';

import { getProfileSettings, updateProfileSettings } from '../../lib/socialApi';
import { useT } from '../../i18n';
import { Skeleton } from '../../ui';
import { Alert, Button, cx } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { ProfileIconSvg } from '../components/profileIcons';

const PROFILE_KEY = ['social', 'profile'] as const;

/**
 * My Public Profile (§6.9, §14, V3-P6) — the owner-facing settings for the opt-in
 * public page at `/u/<username>`. Enabling passes the §16 friction ladder (a
 * strong warning + explicit acknowledgment, mirrored server-side); disabling
 * unpublishes the page instantly (the slug 404s). The page composes ONLY the
 * user's `public_link` items — this screen makes that plain and links to the live
 * page.
 *
 * The curated profile-icon picker (§13.5 V5-P0c) lives inline in this same card
 * — a compact grid the user can leave collapsed until they want to change avatar
 * — so the profile-settings surface never gains a second page. Icon changes save
 * with the rest of the form; nothing extra to click.
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
  // `undefined` = untouched (server value stays); `null` = clear the choice;
  // a valid id = the picked new avatar. Kept separate from the current value so
  // "save" only sends what actually changed.
  const [draftIcon, setDraftIcon] = useState<ProfileIconId | null | undefined>(undefined);
  const [iconOpen, setIconOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [copied, setCopied] = useState(false);

  const serverPublic = data?.isPublic ?? false;
  const isPublic = draftPublic ?? serverPublic;
  const bio = draftBio ?? data?.bio ?? '';
  const currentIcon: ProfileIconId | null =
    draftIcon !== undefined ? draftIcon : (data?.profileIcon ?? null);
  // Enabling from an off state is the only path that needs the acknowledgment;
  // editing the bio while already public does not re-gate.
  const enabling = isPublic && !serverPublic;

  const mutation = useMutation({
    mutationFn: () =>
      updateProfileSettings({
        isPublic,
        bio: bio.trim().length > 0 ? bio.trim() : null,
        acknowledgePublic: isPublic ? true : undefined,
        profileIcon: draftIcon,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(PROFILE_KEY, result);
      setDraftPublic(null);
      setDraftBio(null);
      setDraftIcon(undefined);
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
  const dirty = draftPublic !== null || draftBio !== null || draftIcon !== undefined;
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

      {/* Profile-icon picker (§13.5 V5-P0c). Compact grid inside the existing
          card, collapsed by default so the surface never feels heavier. */}
      <div className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
        <button
          type="button"
          onClick={() => setIconOpen((v) => !v)}
          aria-expanded={iconOpen}
          aria-controls="profile-icon-grid"
          className="flex items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <Avatar name={data.username} iconId={currentIcon} size="md" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium text-neutral-100">{t('profile.icon.title')}</span>
            <span className="text-xs text-neutral-500">
              {currentIcon
                ? t('profile.icon.picked', { name: t(`profile.icon.name.${currentIcon}`) })
                : t('profile.icon.defaultHint')}
            </span>
          </span>
          <svg
            className={cx(
              'h-4 w-4 shrink-0 text-neutral-500 transition-transform',
              iconOpen && 'rotate-90',
            )}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
        {iconOpen ? (
          <div id="profile-icon-grid" role="radiogroup" aria-label={t('profile.icon.title')}>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
              {PROFILE_ICON_IDS.map((id) => {
                const active = currentIcon === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={t(`profile.icon.name.${id}`)}
                    onClick={() => setDraftIcon(id)}
                    className={cx(
                      'flex aspect-square items-center justify-center rounded-lg ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                      active ? 'ring-sky-500 ring-2' : 'ring-neutral-700 hover:ring-neutral-500',
                    )}
                    data-icon-id={id}
                  >
                    <ProfileIconSvg id={id} className="h-full w-full" />
                  </button>
                );
              })}
            </div>
            {currentIcon !== null ? (
              <button
                type="button"
                onClick={() => setDraftIcon(null)}
                className="mt-2 text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
              >
                {t('profile.icon.clear')}
              </button>
            ) : null}
          </div>
        ) : null}
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
