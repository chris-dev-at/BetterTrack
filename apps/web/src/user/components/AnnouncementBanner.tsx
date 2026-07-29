import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ActiveAnnouncement, ActiveAnnouncementSeverity } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { dismissAnnouncement, listActiveAnnouncements } from '../../lib/notificationsApi';
import { cx } from './ui';

/**
 * Currently-active announcements rendered as a stacked, dismissible banner
 * above the app chrome (§13.4 V4-P5b). Server-computed for the caller:
 * currently in the window, flagged `active`, and NOT dismissed by them — so no
 * client-side gating is needed. Content is delivered in the viewer's stored
 * locale (`resolveEmailLocale`); only the "Dismiss" affordance runs through
 * the SPA message catalog.
 *
 * Silence-by-default: an authenticated session that has no active-for-me row
 * renders NOTHING (no chrome, no wrapper) — the banner is invisible until an
 * admin publishes something the caller has not dismissed.
 */

/**
 * Origin treatment: a quiet full-width band with a 1px bottom rule, tinted by
 * the severity token rather than boxed as a card. Gold is the resting attention
 * tone (`warning`); `critical` keeps the negative hue because it carries real
 * negative meaning, and `info` takes the calm analytical blue.
 */
const SEVERITY_STYLES: Record<ActiveAnnouncementSeverity, { band: string; badge: string }> = {
  info: { band: 'var(--bt-blue-soft)', badge: 'bt-badge--blue' },
  warning: { band: 'var(--bt-gold-soft)', badge: 'bt-badge--gold' },
  critical: { band: 'var(--bt-neg-soft)', badge: 'bt-badge--neg' },
};

const ANNOUNCEMENTS_QUERY_KEY = ['announcements', 'active'];
// Same cadence the bell uses — cheap, and the banner reflects a fresh publish
// within one poll window without a hard refresh.
const POLL_INTERVAL_MS = 30_000;

interface BannerProps {
  /**
   * When the caller is anonymous / not-yet-authenticated we skip both fetch
   * and render — the endpoint requires a session.
   */
  enabled: boolean;
}

export function AnnouncementBanner({ enabled }: BannerProps) {
  const t = useT();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ANNOUNCEMENTS_QUERY_KEY,
    queryFn: ({ signal }) => listActiveAnnouncements(signal),
    enabled,
    refetchInterval: enabled ? POLL_INTERVAL_MS : false,
    // Any error here is benign — silence is fine, no toast.
    staleTime: 5_000,
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissAnnouncement(id),
    onSuccess: () => {
      // Refetch instead of a client-side splice: the banner state is the API
      // truth (someone can dismiss on another device), and the next poll will
      // re-derive it anyway. This just makes it feel instant.
      void queryClient.invalidateQueries({ queryKey: ANNOUNCEMENTS_QUERY_KEY });
    },
  });

  const announcements = data?.announcements ?? [];
  if (!enabled || announcements.length === 0) return null;

  return (
    <div aria-label={t('announcements.aria.list')} className="flex flex-col">
      {announcements.map((a) => (
        <AnnouncementRow
          key={a.id}
          announcement={a}
          onDismiss={() => dismiss.mutate(a.id)}
          dismissing={dismiss.isPending && dismiss.variables === a.id}
        />
      ))}
    </div>
  );
}

interface RowProps {
  announcement: ActiveAnnouncement;
  onDismiss: () => void;
  dismissing: boolean;
}

function AnnouncementRow({ announcement, onDismiss, dismissing }: RowProps) {
  const t = useT();
  const styles = SEVERITY_STYLES[announcement.severity];
  return (
    <div
      role="alert"
      data-testid={`announcement-${announcement.id}`}
      className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-5 sm:px-6"
      style={{
        background: styles.band,
        borderBottom: '1px solid var(--bt-border)',
        color: 'var(--bt-text)',
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cx('bt-badge', styles.badge)}>
            {t(`announcements.severity.${announcement.severity}`)}
          </span>
          <span className="bt-row-title">{announcement.title}</span>
        </div>
        <p className="bt-soft whitespace-pre-line text-sm/relaxed">{announcement.body}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        disabled={dismissing}
        aria-label={t('announcements.dismiss')}
        className="bt-btn bt-btn--quiet bt-btn--sm shrink-0"
      >
        {dismissing ? t('announcements.dismissing') : t('announcements.dismiss')}
      </button>
    </div>
  );
}
