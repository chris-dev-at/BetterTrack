import type { AnnouncementSeverity } from '@bettertrack/contracts';

import { localizedMessage, useT, type LocaleCode } from '../../i18n';

import { Badge, cx } from './ui';
import { EDGE, PAD_PANEL, SURFACE_WELL, TEXT_MICRO, TONE_PANEL, type Tone } from './tokens';

/**
 * What every account will receive, in every language, before it is sent
 * (ADMIN-W7a, #1909).
 *
 * An announcement is the one operator action with a 100 % blast radius: there
 * is no audience selector, no cohort, no undo once the inbox rows are written.
 * The composer therefore has to show the finished thing, in both locales at
 * once, because the operator writing it reads only one of them.
 *
 * ── Why this is a faithful re-render and not the banner component ───────────
 *
 * The issue asks for `user/components/AnnouncementBanner.tsx`'s presentation to
 * be reused "if it can be done without dragging user-app state into the
 * console". It cannot, on two counts:
 *
 *  1. The banner IS its data source. It is a `useQuery` over
 *     `/notifications/announcements` plus a `useMutation` dismissal — a
 *     user-session endpoint the console's admin session gets 404 from — so
 *     rendering it here would mean a QueryClientProvider and a request the
 *     admin origin cannot make, to show copy that is already in local state.
 *  2. Its skin is Origin's, not the console's: `bt-badge`, `bt-row-title` and
 *     `var(--bt-gold-soft)` are the user app's warm theme variables, stamped
 *     onto the document by the user app's theme boot. The console never stamps
 *     a theme, so those custom properties resolve to nothing here and the band
 *     would render as an untinted grey box — a preview that lies about colour
 *     is worse than one that admits it is a rendering.
 *
 * So this re-renders the banner's STRUCTURE — severity badge, title, body,
 * dismiss affordance, in that order — in the console's own token layer, and it
 * reuses the two things that actually have to match: the user-facing severity
 * labels and the "Dismiss" wording, read out of the SAME `announcements.*`
 * catalog keys the real banner renders, per locale. The words a user reads are
 * identical; the surrounding paint is the console's.
 *
 * The dismiss control is an inert `<span>`, not a disabled button: a preview
 * must not put a focusable, tappable control on the page that does nothing, and
 * the console's 44 px tap-target floor only measures things an operator can
 * actually press.
 */

/**
 * Severity → console tone, carrying the same MEANING as the banner's Origin
 * palette: informational, resting-attention, and genuinely negative.
 */
const SEVERITY_TONE: Record<AnnouncementSeverity, Tone> = {
  info: 'sky',
  warning: 'amber',
  critical: 'red',
};

export interface AnnouncementPreviewProps {
  severity: AnnouncementSeverity;
  titleEn: string;
  bodyEn: string;
  titleDe: string;
  bodyDe: string;
}

/** The locales a preview renders, in catalog order. EN first: it is the source. */
const PREVIEW_LOCALES: readonly LocaleCode[] = ['en', 'de'];

export function AnnouncementPreview({
  severity,
  titleEn,
  bodyEn,
  titleDe,
  bodyDe,
}: AnnouncementPreviewProps) {
  const t = useT();
  const copy: Record<LocaleCode, { title: string; body: string }> = {
    en: { title: titleEn.trim(), body: bodyEn.trim() },
    de: { title: titleDe.trim(), body: bodyDe.trim() },
  };

  const anything = PREVIEW_LOCALES.some((code) => copy[code].title || copy[code].body);
  if (!anything) {
    return <p className="text-[12px] text-neutral-500">{t('admin.announcements.preview.empty')}</p>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {PREVIEW_LOCALES.map((code) => (
        <div key={code} className="flex min-w-0 flex-col gap-1.5">
          <span className={TEXT_MICRO}>{t(`admin.announcements.preview.locale.${code}`)}</span>
          <div
            data-testid={`announcement-preview-${code}`}
            className={cx(
              'flex flex-col gap-2 border border-l-[3px] sm:flex-row sm:items-start sm:justify-between sm:gap-5',
              PAD_PANEL,
              TONE_PANEL[SEVERITY_TONE[severity]],
            )}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                {/* The user's own severity word, in the user's own language. */}
                <Badge tone={SEVERITY_TONE[severity]}>
                  {localizedMessage(code, `announcements.severity.${severity}`)}
                </Badge>
                <span className="text-[13px] font-medium text-neutral-100">{copy[code].title}</span>
              </div>
              <p className="whitespace-pre-line text-[13px] leading-relaxed text-neutral-300">
                {copy[code].body}
              </p>
            </div>
            {/* Inert on purpose — see the docblock. */}
            <span
              aria-hidden="true"
              className={cx(
                'shrink-0 self-start px-2 py-1 text-[12px] text-neutral-400',
                EDGE,
                SURFACE_WELL,
              )}
            >
              {localizedMessage(code, 'announcements.dismiss')}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
