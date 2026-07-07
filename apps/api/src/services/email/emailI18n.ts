/**
 * Localized copy for the **notification** emails (PROJECTPLAN.md §6.10, §13.3
 * V3-P1). The dispatcher renders each notification email in the recipient's
 * stored locale ({@link resolveEmailLocale} falls back to EN for any code we
 * don't translate). Sentences carry `{actor}` / `{symbol}` / `{body}` tokens the
 * template fills in — for HTML the actor is bolded and escaped, for text it's
 * inlined raw — so one string serves both parts.
 *
 * Adding a language here is a small, self-contained edit: add its entry to
 * {@link NOTIFICATION_EMAIL_COPY} and its code to {@link EMAIL_LOCALES}. This is
 * intentionally separate from the SPA locale files (a different runtime); see
 * `docs/i18n.md`. Account/admin emails (invite, temp password, reset, welcome,
 * 2FA code, test) stay EN — their recipients often have no stored locale yet.
 */

/** Locales the notification-email layer renders; anything else resolves to EN. */
export const EMAIL_LOCALES = ['en', 'de'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

/** Resolve any stored locale code to a renderable email locale (EN fallback). */
export function resolveEmailLocale(code: string | null | undefined): EmailLocale {
  if (!code) return 'en';
  const primary = code.toLowerCase().split('-')[0] ?? '';
  return (EMAIL_LOCALES as readonly string[]).includes(primary) ? (primary as EmailLocale) : 'en';
}

export interface NotificationEmailCopy {
  /** Generic footer line for notification emails + the primary "open the app" button. */
  footer: string;
  openApp: string;
  friendRequest: { subject: string; heading: string; body: string; button: string };
  friendAccepted: { subject: string; heading: string; body: string; button: string };
  portfolioShared: { subject: string; heading: string; body: string; button: string };
  /** Alert body sentence is supplied by the caller (the same phrasing as the bell). */
  alertTriggered: { subject: string; heading: string; button: string };
}

export const NOTIFICATION_EMAIL_COPY: Record<EmailLocale, NotificationEmailCopy> = {
  en: {
    footer:
      'You received this email because you have notifications enabled on your BetterTrack account.',
    openApp: 'Open BetterTrack',
    friendRequest: {
      subject: 'New friend request on BetterTrack',
      heading: 'New friend request',
      body: '{actor} sent you a friend request on BetterTrack.',
      button: 'View request',
    },
    friendAccepted: {
      subject: '{actor} accepted your friend request',
      heading: 'Friend request accepted',
      body: '{actor} accepted your friend request on BetterTrack. You can now see the portfolios they share with friends.',
      button: 'Open BetterTrack',
    },
    portfolioShared: {
      subject: '{actor} shared a portfolio with you',
      heading: 'Portfolio shared with you',
      body: '{actor} shared a portfolio with friends on BetterTrack. It is now visible to you under Shared With Me.',
      button: 'View shared portfolio',
    },
    alertTriggered: {
      subject: 'Price alert: {symbol}',
      heading: 'Price alert: {symbol}',
      button: 'Open BetterTrack',
    },
  },
  de: {
    footer:
      'Du erhältst diese E-Mail, weil du Benachrichtigungen für dein BetterTrack-Konto aktiviert hast.',
    openApp: 'BetterTrack öffnen',
    friendRequest: {
      subject: 'Neue Freundschaftsanfrage auf BetterTrack',
      heading: 'Neue Freundschaftsanfrage',
      body: '{actor} hat dir eine Freundschaftsanfrage auf BetterTrack gesendet.',
      button: 'Anfrage ansehen',
    },
    friendAccepted: {
      subject: '{actor} hat deine Freundschaftsanfrage angenommen',
      heading: 'Freundschaftsanfrage angenommen',
      body: '{actor} hat deine Freundschaftsanfrage auf BetterTrack angenommen. Du kannst jetzt die Portfolios sehen, die {actor} mit Freunden teilt.',
      button: 'BetterTrack öffnen',
    },
    portfolioShared: {
      subject: '{actor} hat ein Portfolio mit dir geteilt',
      heading: 'Portfolio mit dir geteilt',
      body: '{actor} hat ein Portfolio mit Freunden auf BetterTrack geteilt. Es ist jetzt unter „Mit mir geteilt“ sichtbar.',
      button: 'Geteiltes Portfolio ansehen',
    },
    alertTriggered: {
      subject: 'Preisalarm: {symbol}',
      heading: 'Preisalarm: {symbol}',
      button: 'BetterTrack öffnen',
    },
  },
};

/** The copy block for a resolved locale. */
export function notificationCopy(locale: EmailLocale): NotificationEmailCopy {
  return NOTIFICATION_EMAIL_COPY[locale];
}
