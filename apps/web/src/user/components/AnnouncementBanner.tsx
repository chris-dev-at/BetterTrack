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

const SEVERITY_STYLES: Record<ActiveAnnouncementSeverity, { container: string; badge: string }> = {
  info: {
    container: 'border-sky-800 bg-sky-950/60 text-sky-100',
    badge: 'bg-sky-800/70 text-sky-100',
  },
  warning: {
    container: 'border-amber-700 bg-amber-950/60 text-amber-100',
    badge: 'bg-amber-800/70 text-amber-100',
  },
  critical: {
    container: 'border-red-700 bg-red-950/70 text-red-100',
    badge: 'bg-red-800/80 text-red-100',
  },
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
    <div
      aria-label={t('announcements.aria.list')}
      className="mx-auto flex max-w-6xl flex-col gap-2 px-4 pt-3"
    >
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
      className={cx(
        'flex flex-col gap-2 rounded-md border px-4 py-3 text-sm shadow-sm sm:flex-row sm:items-start sm:justify-between',
        styles.container,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className={cx(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
              styles.badge,
            )}
          >
            {t(`announcements.severity.${announcement.severity}`)}
          </span>
          <span className="font-semibold">{announcement.title}</span>
        </div>
        <p className="whitespace-pre-line text-sm/relaxed">{announcement.body}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        disabled={dismissing}
        aria-label={t('announcements.dismiss')}
        className={cx(
          'shrink-0 rounded-md px-3 py-1.5 text-xs font-medium',
          'bg-white/10 hover:bg-white/20 disabled:opacity-60',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
        )}
      >
        {dismissing ? t('announcements.dismissing') : t('announcements.dismiss')}
      </button>
    </div>
  );
}
