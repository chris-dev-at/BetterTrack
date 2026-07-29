import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PROFILE_BIO_MAX, PROFILE_ICON_IDS, type ProfileIconId } from '@bettertrack/contracts';

import { getProfileSettings, updateProfileSettings } from '../../lib/socialApi';
import { useT } from '../../i18n';
import {
  Button,
  Field,
  Icon,
  PageHead,
  Panel,
  SkeletonBlock,
  Switch,
  Textarea,
} from '../../ui/origin';
import { Alert } from '../components/ui';
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
        <SkeletonBlock height={24} width={192} />
        <SkeletonBlock height={96} />
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
    <div className="flex max-w-2xl flex-col">
      <PageHead sub={t('profile.subtitle')} title={t('profile.title')} />

      <div className="flex flex-col gap-6">
        {/* Profile-icon picker (§13.5 V5-P0c). Compact grid inside the existing
            card, collapsed by default so the surface never feels heavier. */}
        <Panel className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setIconOpen((v) => !v)}
            aria-expanded={iconOpen}
            aria-controls="profile-icon-grid"
            className="flex items-center gap-3 text-left"
            style={{
              background: 'none',
              border: 0,
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
              padding: 0,
            }}
          >
            <Avatar name={data.username} iconId={currentIcon} size="md" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="bt-row-title">{t('profile.icon.title')}</span>
              <span className="bt-row-sub">
                {currentIcon
                  ? t('profile.icon.picked', { name: t(`profile.icon.name.${currentIcon}`) })
                  : t('profile.icon.defaultHint')}
              </span>
            </span>
            <Icon
              name="chevron-right"
              size={16}
              style={{
                color: 'var(--bt-faint)',
                flex: 'none',
                transform: iconOpen ? 'rotate(90deg)' : undefined,
                transition: 'transform var(--bt-t-fast)',
              }}
            />
          </button>
          {iconOpen ? (
            <div id="profile-icon-grid" role="radiogroup" aria-label={t('profile.icon.title')}>
              <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
                {PROFILE_ICON_IDS.map((id) => {
                  const active = currentIcon === id;
                  return (
                    // Selection is the one thing gold is for here: the picked
                    // tile takes the accent rule + its soft wash, the rest stay
                    // on the quiet neutral border.
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={t(`profile.icon.name.${id}`)}
                      onClick={() => setDraftIcon(id)}
                      className="flex aspect-square items-center justify-center"
                      style={{
                        background: active ? 'var(--bt-gold-soft)' : 'none',
                        border: `1px solid ${active ? 'var(--bt-gold)' : 'var(--bt-border-strong)'}`,
                        borderRadius: 6,
                        cursor: 'pointer',
                        padding: 0,
                        transition: 'border-color var(--bt-t-fast), background var(--bt-t-fast)',
                      }}
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
                  className="bt-link"
                  style={{
                    background: 'none',
                    border: 0,
                    cursor: 'pointer',
                    fontSize: 12.5,
                    marginTop: 10,
                    padding: 0,
                  }}
                >
                  {t('profile.icon.clear')}
                </button>
              ) : null}
            </div>
          ) : null}
        </Panel>

        {/* Opt-in toggle */}
        <Panel className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="bt-row-title">{t('profile.toggleLabel')}</p>
            <p className="bt-row-sub">
              {t('profile.publicItemCount', { count: data.publicItemCount })}
            </p>
          </div>
          <Switch
            aria-label={t('profile.toggleLabel')}
            checked={isPublic}
            onChange={() => {
              setDraftPublic(!isPublic);
              setAck(false);
            }}
          />
        </Panel>

        {/* Strong friction warning shown only while enabling from off */}
        {enabling ? (
          <div
            className="flex flex-col gap-2"
            style={{
              background: 'var(--bt-gold-soft)',
              border: '1px solid var(--bt-border-accent)',
              borderRadius: 8,
              padding: 16,
            }}
          >
            <p className="bt-gold" style={{ fontWeight: 620 }}>
              {t('profile.warningTitle')}
            </p>
            <p className="bt-soft">{t('profile.warningBody')}</p>
            <label className="flex cursor-pointer items-start gap-2" style={{ marginTop: 4 }}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                style={{ accentColor: 'var(--bt-gold)' }}
              />
              <span>{t('profile.acknowledge')}</span>
            </label>
          </div>
        ) : null}

        {/* Bio */}
        <Field
          hint={t('profile.bioCount', { count: bio.length, max: PROFILE_BIO_MAX })}
          htmlFor="profile-bio"
          label={t('profile.bioLabel')}
        >
          <Textarea
            id="profile-bio"
            value={bio}
            maxLength={PROFILE_BIO_MAX}
            onChange={(e) => setDraftBio(e.target.value)}
            rows={3}
            placeholder={t('profile.bioPlaceholder')}
          />
        </Field>

        {/* Live URL (only meaningful while public on the server) */}
        {serverPublic ? (
          <Panel className="flex flex-col gap-2">
            <p className="bt-row-title">{t('profile.liveTitle')}</p>
            <div className="flex items-center gap-2">
              <code className="bt-input min-w-0 flex-1 overflow-x-auto">{profileUrl}</code>
              <Button onClick={copyUrl}>{copied ? t('sharing.copied') : t('sharing.copy')}</Button>
              <a className="bt-btn" href={`/u/${data.username}`} target="_blank" rel="noreferrer">
                {t('profile.view')}
              </a>
            </div>
          </Panel>
        ) : null}

        {mutation.isError ? <Alert tone="error">{t('profile.saveError')}</Alert> : null}
        {mutation.isSuccess && !dirty ? <Alert tone="success">{t('profile.saved')}</Alert> : null}

        <div className="flex justify-end">
          {/* Save is this screen's single primary. */}
          <Button disabled={!canSave} onClick={() => mutation.mutate()} variant="primary">
            {mutation.isPending ? t('sharing.saving') : t('profile.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
