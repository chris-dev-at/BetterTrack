import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PROFILE_BIO_MAX, type ProfileIconId } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getProfileSettings, updateProfileSettings } from '../../../lib/socialApi';
import { Button, SkeletonBlock, Switch, Textarea } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { PanelGroup, PanelHead, PanelNote, Row } from './panelKit';
import { ProfileIconPicker } from './ProfileIconPicker';

const PROFILE_KEY = ['social', 'profile'] as const;

/**
 * Control Center → Public profile (§6.9, §14, V3-P6; moved here from
 * `/people/profile` on owner order). The owner-facing settings for the opt-in
 * public page at `/u/<username>`.
 *
 * The §16 friction ladder is a PRIVACY BOUNDARY, not chrome: turning the page on
 * from an off state renders the strong warning and requires an explicit ticked
 * acknowledgment before Save unlocks — mirrored server-side by
 * `acknowledgePublic`. Editing the bio while already public does not re-gate.
 * Turning it off unpublishes instantly (the slug 404s).
 *
 * The curated icon picker stays inline and collapsed until opened, and saves
 * with the rest of the form — nothing extra to click.
 */
export function ProfilePanel() {
  const t = useT();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: ({ signal }) => getProfileSettings(signal),
  });

  const [draftPublic, setDraftPublic] = useState<boolean | null>(null);
  const [draftBio, setDraftBio] = useState<string | null>(null);
  // `undefined` = untouched (server value stays); `null` = clear the choice;
  // a valid id = the picked new avatar. Kept separate from the current value so
  // "save" only sends what actually changed.
  const [draftIcon, setDraftIcon] = useState<ProfileIconId | null | undefined>(undefined);
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
      <div className="bt-cc-panel">
        <PanelHead title={t('control.profile')} />
        <SkeletonBlock height={72} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bt-cc-panel">
        <PanelHead title={t('control.profile')} />
        <Alert tone="error">{t('profile.error')}</Alert>
        <Button onClick={() => void refetch()} size="sm">
          {t('common.retry')}
        </Button>
      </div>
    );
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
    <div className="bt-cc-panel">
      <PanelHead
        actions={
          /* The panel's single primary. */
          <Button disabled={!canSave} onClick={() => mutation.mutate()} size="sm" variant="primary">
            {mutation.isPending ? t('sharing.saving') : t('profile.save')}
          </Button>
        }
        title={t('control.profile')}
      />

      <PanelGroup label={t('profile.icon.title')}>
        <Row stack>
          <ProfileIconPicker
            gridId="profile-icon-grid"
            onChange={setDraftIcon}
            username={data.username}
            value={currentIcon}
          />
        </Row>
      </PanelGroup>

      <PanelGroup label={t('profile.groups.page')}>
        <Row
          hint={t('profile.publicItemCount', { count: data.publicItemCount })}
          label={t('profile.toggleLabel')}
        >
          <Switch
            aria-label={t('profile.toggleLabel')}
            checked={isPublic}
            onChange={() => {
              setDraftPublic(!isPublic);
              setAck(false);
            }}
          />
        </Row>

        {/* The §16 friction ladder: shown only while enabling from off, and Save
            stays locked until the acknowledgment is ticked. Server-mirrored. */}
        {enabling ? (
          <Row stack>
            <div
              className="flex flex-col gap-1.5"
              style={{
                background: 'var(--bt-gold-soft)',
                border: '1px solid var(--bt-border-accent)',
                borderRadius: 6,
                padding: 12,
              }}
            >
              <p className="bt-gold" style={{ fontSize: 12.5, fontWeight: 620 }}>
                {t('profile.warningTitle')}
              </p>
              <p className="bt-cc-note">{t('profile.warningBody')}</p>
              <label className="flex cursor-pointer items-start gap-2" style={{ fontSize: 12.5 }}>
                <input
                  checked={ack}
                  className="mt-0.5"
                  onChange={(e) => setAck(e.target.checked)}
                  style={{ accentColor: 'var(--bt-gold-graphic)' }}
                  type="checkbox"
                />
                <span>{t('profile.acknowledge')}</span>
              </label>
            </div>
          </Row>
        ) : null}

        <Row
          hint={t('profile.bioCount', { count: bio.length, max: PROFILE_BIO_MAX })}
          htmlFor="profile-bio"
          label={t('profile.bioLabel')}
          stack
        >
          <Textarea
            id="profile-bio"
            maxLength={PROFILE_BIO_MAX}
            onChange={(e) => setDraftBio(e.target.value)}
            placeholder={t('profile.bioPlaceholder')}
            rows={2}
            style={{ maxWidth: 420 }}
            value={bio}
          />
        </Row>

        {/* Only meaningful while public on the server. */}
        {serverPublic ? (
          <Row label={t('profile.liveTitle')} stack>
            <div className="flex flex-wrap items-center gap-2">
              <code className="bt-input bt-cc-mono min-w-0 flex-1" style={{ maxWidth: 300 }}>
                {profileUrl}
              </code>
              <Button onClick={copyUrl} size="sm">
                {copied ? t('sharing.copied') : t('sharing.copy')}
              </Button>
              <a
                className="bt-btn bt-btn--sm"
                href={`/u/${data.username}`}
                rel="noreferrer"
                target="_blank"
              >
                {t('profile.view')}
              </a>
            </div>
          </Row>
        ) : null}
      </PanelGroup>

      {mutation.isError ? <Alert tone="error">{t('profile.saveError')}</Alert> : null}
      {mutation.isSuccess && !dirty ? <PanelNote>{t('profile.saved')}</PanelNote> : null}
    </div>
  );
}
