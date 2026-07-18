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
  watchlistShared: { subject: string; heading: string; body: string; button: string };
  conglomerateShared: { subject: string; heading: string; body: string; button: string };
  chatMessage: { subject: string; heading: string; body: string; button: string };
  /** Alert body sentence is supplied by the caller (the same phrasing as the bell). */
  alertTriggered: { subject: string; heading: string; button: string };
  /**
   * Opt-in earnings reminder (§13.5 V5-P5). The body is built from copy here
   * (not caller-supplied) so it localizes: `{name}`/`{symbol}`/`{date}` fill in,
   * with a distinct sentence for a confirmed vs an estimated report date.
   */
  earningsReminder: {
    subject: string;
    heading: string;
    bodyConfirmed: string;
    bodyEstimated: string;
    button: string;
  };
  /** Friend-activity body sentence is supplied by the caller (same as the bell). */
  friendActivity: { subject: string; heading: string; button: string };
  /** Follow-published body sentence is supplied by the caller (same as the bell, #438). */
  followPublished: { subject: string; heading: string; button: string };
  /** Dividend-event body sentence is supplied by the caller (same as the bell, V5-P5). */
  dividendEvent: { subject: string; heading: string; button: string };
  /** Alert-follow bodies are supplied by the caller (same as the bell, #455). */
  followAlertCreated: { subject: string; heading: string; button: string };
  followAlertFired: { subject: string; heading: string; button: string };
  /** Approval-queue decision emails (§6.12, §13.4 V4-P4a). Approved bolds `{username}`. */
  registrationApproved: { subject: string; heading: string; body: string; button: string };
  registrationRejected: { subject: string; heading: string; body: string };
  /**
   * Digest summary email + push (V5-P3). One send per period bundles a day's /
   * week's deferred notifications; `intro` introduces the list, the push copy is
   * a compact "{count} new notifications" summary.
   */
  digest: {
    subjectDaily: string;
    subjectWeekly: string;
    headingDaily: string;
    headingWeekly: string;
    intro: string;
    button: string;
    pushTitleDaily: string;
    pushTitleWeekly: string;
    pushBody: string;
  };
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
    watchlistShared: {
      subject: '{actor} shared a watchlist with you',
      heading: 'Watchlist shared with you',
      body: '{actor} shared a watchlist with you on BetterTrack. It is now visible to you under Shared With Me.',
      button: 'View shared watchlist',
    },
    conglomerateShared: {
      subject: '{actor} shared a conglomerate with you',
      heading: 'Conglomerate shared with you',
      body: '{actor} shared a conglomerate with you on BetterTrack. It is now visible to you under Shared With Me.',
      button: 'View shared conglomerate',
    },
    chatMessage: {
      subject: 'New message from {actor}',
      heading: 'New message',
      body: '{actor} sent you a new message on BetterTrack.',
      button: 'Open chat',
    },
    alertTriggered: {
      subject: 'Price alert: {symbol}',
      heading: 'Price alert: {symbol}',
      button: 'Open BetterTrack',
    },
    earningsReminder: {
      subject: 'Earnings coming up: {symbol}',
      heading: 'Upcoming earnings: {symbol}',
      bodyConfirmed: '{name} ({symbol}) reports earnings on {date}.',
      bodyEstimated: '{name} ({symbol}) is expected to report earnings around {date}.',
      button: 'Open BetterTrack',
    },
    friendActivity: {
      subject: 'Friend activity on BetterTrack',
      heading: 'Friend activity',
      button: 'Open BetterTrack',
    },
    followPublished: {
      subject: 'New from someone you follow on BetterTrack',
      heading: 'New from someone you follow',
      button: 'Open BetterTrack',
    },
    dividendEvent: {
      subject: 'Upcoming dividend on BetterTrack',
      heading: 'Upcoming dividend',
      button: 'Open BetterTrack',
    },
    followAlertCreated: {
      subject: 'New price alert from someone you follow',
      heading: 'New price alert from someone you follow',
      button: 'Open BetterTrack',
    },
    followAlertFired: {
      subject: 'A price alert from someone you follow fired',
      heading: 'A price alert from someone you follow fired',
      button: 'Open BetterTrack',
    },
    registrationApproved: {
      subject: 'Your BetterTrack account has been approved',
      heading: 'Your account is ready',
      body: 'Your BetterTrack registration was approved, {username}. You can now sign in with the password you chose when you signed up.',
      button: 'Sign in',
    },
    registrationRejected: {
      subject: 'Your BetterTrack registration',
      heading: 'Registration not approved',
      body: 'Thanks for your interest in BetterTrack. Your registration request was not approved, so no account was created. If you think this was a mistake, please contact the administrator.',
    },
    digest: {
      subjectDaily: 'Your daily BetterTrack summary',
      subjectWeekly: 'Your weekly BetterTrack summary',
      headingDaily: 'Your daily summary',
      headingWeekly: 'Your weekly summary',
      intro: "Here's what happened on BetterTrack since your last summary.",
      button: 'Open BetterTrack',
      pushTitleDaily: 'Your daily BetterTrack summary',
      pushTitleWeekly: 'Your weekly BetterTrack summary',
      pushBody: '{count} new notifications',
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
    watchlistShared: {
      subject: '{actor} hat eine Watchlist mit dir geteilt',
      heading: 'Watchlist mit dir geteilt',
      body: '{actor} hat eine Watchlist auf BetterTrack mit dir geteilt. Sie ist jetzt unter „Mit mir geteilt“ sichtbar.',
      button: 'Geteilte Watchlist ansehen',
    },
    conglomerateShared: {
      subject: '{actor} hat ein Konglomerat mit dir geteilt',
      heading: 'Konglomerat mit dir geteilt',
      body: '{actor} hat ein Konglomerat auf BetterTrack mit dir geteilt. Es ist jetzt unter „Mit mir geteilt“ sichtbar.',
      button: 'Geteiltes Konglomerat ansehen',
    },
    chatMessage: {
      subject: 'Neue Nachricht von {actor}',
      heading: 'Neue Nachricht',
      body: '{actor} hat dir eine neue Nachricht auf BetterTrack gesendet.',
      button: 'Chat öffnen',
    },
    alertTriggered: {
      subject: 'Preisalarm: {symbol}',
      heading: 'Preisalarm: {symbol}',
      button: 'BetterTrack öffnen',
    },
    earningsReminder: {
      subject: 'Bald Quartalszahlen: {symbol}',
      heading: 'Anstehende Quartalszahlen: {symbol}',
      bodyConfirmed: '{name} ({symbol}) legt am {date} Quartalszahlen vor.',
      bodyEstimated:
        '{name} ({symbol}) wird voraussichtlich um den {date} Quartalszahlen vorlegen.',
      button: 'BetterTrack öffnen',
    },
    friendActivity: {
      subject: 'Aktivität von Freunden auf BetterTrack',
      heading: 'Aktivität von Freunden',
      button: 'BetterTrack öffnen',
    },
    followPublished: {
      subject: 'Neues von einer Person, der du folgst — auf BetterTrack',
      heading: 'Neues von einer Person, der du folgst',
      button: 'BetterTrack öffnen',
    },
    dividendEvent: {
      subject: 'Bevorstehende Dividende auf BetterTrack',
      heading: 'Bevorstehende Dividende',
      button: 'BetterTrack öffnen',
    },
    followAlertCreated: {
      subject: 'Neuer Preisalarm von jemandem, dem du folgst',
      heading: 'Neuer Preisalarm von jemandem, dem du folgst',
      button: 'BetterTrack öffnen',
    },
    followAlertFired: {
      subject: 'Ein Preisalarm von jemandem, dem du folgst, wurde ausgelöst',
      heading: 'Preisalarm ausgelöst',
      button: 'BetterTrack öffnen',
    },
    registrationApproved: {
      subject: 'Dein BetterTrack-Konto wurde freigegeben',
      heading: 'Dein Konto ist bereit',
      body: 'Deine BetterTrack-Registrierung wurde freigegeben, {username}. Du kannst dich jetzt mit dem Passwort anmelden, das du bei der Registrierung gewählt hast.',
      button: 'Anmelden',
    },
    registrationRejected: {
      subject: 'Deine BetterTrack-Registrierung',
      heading: 'Registrierung nicht freigegeben',
      body: 'Danke für dein Interesse an BetterTrack. Deine Registrierungsanfrage wurde nicht freigegeben, daher wurde kein Konto erstellt. Falls du das für einen Irrtum hältst, wende dich bitte an die Administration.',
    },
    digest: {
      subjectDaily: 'Deine tägliche BetterTrack-Zusammenfassung',
      subjectWeekly: 'Deine wöchentliche BetterTrack-Zusammenfassung',
      headingDaily: 'Deine tägliche Zusammenfassung',
      headingWeekly: 'Deine wöchentliche Zusammenfassung',
      intro: 'Das ist seit deiner letzten Zusammenfassung auf BetterTrack passiert.',
      button: 'BetterTrack öffnen',
      pushTitleDaily: 'Deine tägliche BetterTrack-Zusammenfassung',
      pushTitleWeekly: 'Deine wöchentliche BetterTrack-Zusammenfassung',
      pushBody: '{count} neue Benachrichtigungen',
    },
  },
};

/** The copy block for a resolved locale. */
export function notificationCopy(locale: EmailLocale): NotificationEmailCopy {
  return NOTIFICATION_EMAIL_COPY[locale];
}
