import type {
  NotificationMessage,
  NotificationMessageKey,
  NotificationMessageParams,
} from '@bettertrack/contracts';

import { resolveEmailLocale, type EmailLocale } from '../email/emailI18n';

/** One localized title/body template pair for a dispatcher message key. */
interface NotificationCopyPair {
  title: string;
  body: string;
}

/**
 * Server-side notification copy (#1138).
 *
 * The API uses this catalog for persisted fallback strings, push, digest and
 * email bodies. The web catalog carries the same stable keys so an inbox row can
 * re-render when the active UI language changes. Keeping every branch explicit
 * prevents already-English fragments (notably alert rules and order fallbacks)
 * from leaking through interpolation parameters.
 *
 * **Keep in sync with `apps/web/src/i18n/messages/{en,de}.json` →
 * `notificationContent.*`** — the same pairs, rendered by the SPA inbox. A
 * one-sided edit would make the bell disagree with the push for one event;
 * `__tests__/notificationLocalization.test.ts` asserts the two catalogs match
 * string for string, so edit both together.
 */
export const NOTIFICATION_COPY: Record<
  EmailLocale,
  Record<NotificationMessageKey, NotificationCopyPair>
> = {
  en: {
    friendRequest: {
      title: 'New friend request',
      body: '{{actor}} sent you a friend request.',
    },
    friendAccepted: {
      title: 'Friend request accepted',
      body: '{{actor}} accepted your friend request.',
    },
    portfolioShared: {
      title: 'Portfolio shared',
      body: '{{actor}} shared their portfolio with friends.',
    },
    watchlistShared: {
      title: 'Watchlist shared',
      body: '{{actor}} shared a watchlist with you.',
    },
    conglomerateShared: {
      title: 'Conglomerate shared',
      body: '{{actor}} shared a conglomerate with you.',
    },
    friendActivityBuy: {
      title: 'Friend activity',
      body: '{{actor}} bought {{symbol}}.',
    },
    friendActivitySell: {
      title: 'Friend activity',
      body: '{{actor}} sold {{symbol}}.',
    },
    friendActivityWatchlistAdd: {
      title: 'Friend activity',
      body: '{{actor}} added {{symbol}} to a shared watchlist.',
    },
    followPublishedPortfolio: {
      title: 'New portfolio from {{actor}}',
      body: '{{actor}} published a new portfolio: {{item}}.',
    },
    followPublishedWatchlist: {
      title: 'New watchlist from {{actor}}',
      body: '{{actor}} published a new watchlist: {{item}}.',
    },
    followPublishedConglomerate: {
      title: 'New conglomerate from {{actor}}',
      body: '{{actor}} published a new conglomerate: {{item}}.',
    },
    followPublishedIdea: {
      title: 'New idea from {{actor}}',
      body: '{{actor}} published a new idea: {{item}}.',
    },
    followAlertCreatedPriceAbove: {
      title: 'New alert from {{actor}}',
      body: '{{actor}} created a price alert: {{symbol}} above {{threshold}} {{currency}}.',
    },
    followAlertCreatedPriceBelow: {
      title: 'New alert from {{actor}}',
      body: '{{actor}} created a price alert: {{symbol}} below {{threshold}} {{currency}}.',
    },
    followAlertCreatedPercentUpReference: {
      title: 'New alert from {{actor}}',
      body: '{{actor}} created a price alert: {{symbol}} up {{threshold}}% from the reference price.',
    },
    followAlertCreatedPercentDownReference: {
      title: 'New alert from {{actor}}',
      body: '{{actor}} created a price alert: {{symbol}} down {{threshold}}% from the reference price.',
    },
    followAlertCreatedPercentDayUp: {
      title: 'New alert from {{actor}}',
      body: '{{actor}} created a price alert: {{symbol}} up {{threshold}}% on the day.',
    },
    followAlertCreatedPercentDayDown: {
      title: 'New alert from {{actor}}',
      body: '{{actor}} created a price alert: {{symbol}} down {{threshold}}% on the day.',
    },
    followAlertFiredPriceAbove: {
      title: "{{actor}}'s alert fired",
      body: "{{actor}}'s price alert fired: {{symbol}} above {{threshold}} {{currency}}.",
    },
    followAlertFiredPriceBelow: {
      title: "{{actor}}'s alert fired",
      body: "{{actor}}'s price alert fired: {{symbol}} below {{threshold}} {{currency}}.",
    },
    followAlertFiredPercentUpReference: {
      title: "{{actor}}'s alert fired",
      body: "{{actor}}'s price alert fired: {{symbol}} up {{threshold}}% from the reference price.",
    },
    followAlertFiredPercentDownReference: {
      title: "{{actor}}'s alert fired",
      body: "{{actor}}'s price alert fired: {{symbol}} down {{threshold}}% from the reference price.",
    },
    followAlertFiredPercentDayUp: {
      title: "{{actor}}'s alert fired",
      body: "{{actor}}'s price alert fired: {{symbol}} up {{threshold}}% on the day.",
    },
    followAlertFiredPercentDayDown: {
      title: "{{actor}}'s alert fired",
      body: "{{actor}}'s price alert fired: {{symbol}} down {{threshold}}% on the day.",
    },
    accountTempPassword: {
      title: 'Password was reset',
      body: 'An administrator reset your password. Check your email for the temporary password.',
    },
    accountDataExport: {
      title: 'Your data export is ready',
      body: 'Your account data export has finished. Open Settings → Account to download it.',
    },
    alertTriggeredPriceAbove: {
      title: 'Price alert: {{symbol}}',
      body: '{{symbol}} rose above {{threshold}} {{currency}}.',
    },
    alertTriggeredPriceBelow: {
      title: 'Price alert: {{symbol}}',
      body: '{{symbol}} dropped below {{threshold}} {{currency}}.',
    },
    alertTriggeredPercentUpReference: {
      title: 'Price alert: {{symbol}}',
      body: '{{symbol}} is up {{threshold}}% from your reference price.',
    },
    alertTriggeredPercentDownReference: {
      title: 'Price alert: {{symbol}}',
      body: '{{symbol}} is down {{threshold}}% from your reference price.',
    },
    alertTriggeredPercentDayUp: {
      title: 'Price alert: {{symbol}}',
      body: '{{symbol}} is up {{threshold}}% on the day.',
    },
    alertTriggeredPercentDayDown: {
      title: 'Price alert: {{symbol}}',
      body: '{{symbol}} is down {{threshold}}% on the day.',
    },
    earningsReminderConfirmed: {
      title: 'Earnings coming up: {{symbol}}',
      body: '{{name}} ({{symbol}}) reports earnings on {{date}}.',
    },
    earningsReminderEstimated: {
      title: 'Earnings coming up: {{symbol}}',
      body: '{{name}} ({{symbol}}) is expected to report earnings around {{date}}.',
    },
    chatMessagePreview: {
      title: 'New message',
      body: '{{sender}}: {{preview}}',
    },
    chatMessageSharedItem: {
      title: 'New message',
      body: '{{sender}} shared an item with you.',
    },
    chatMessagePlain: {
      title: 'New message',
      body: '{{sender}} sent you a message.',
    },
    dividendEvent: {
      title: '{{symbol}} ex-dividend {{date}}',
      body: '{{symbol}} goes ex-dividend on {{date}}.',
    },
    dividendEventWithAmount: {
      title: '{{symbol}} ex-dividend {{date}}',
      body: '{{symbol}} goes ex-dividend on {{date}} ({{amount}} {{currency}} per share).',
    },
    budgetExceeded: {
      title: 'Budget exceeded: {{category}}',
      body: 'You spent {{spent}} {{currency}} on {{category}} this month — over your {{target}} {{currency}} budget.',
    },
    standingOrderDeferredNamed: {
      title: 'Standing order deferred',
      body: 'The {{period}} occurrence for “{{order}}” could not be booked. BetterTrack will retry it.',
    },
    standingOrderDeferredUnnamed: {
      title: 'Standing order deferred',
      body: 'The {{period}} occurrence for this standing order could not be booked. BetterTrack will retry it.',
    },
    standingOrderDroppedNamed: {
      title: 'Standing order period skipped',
      body: 'The {{period}} occurrence for “{{order}}” was not recorded before the next period became due.',
    },
    standingOrderDroppedUnnamed: {
      title: 'Standing order period skipped',
      body: 'The {{period}} occurrence for this standing order was not recorded before the next period became due.',
    },
    standingOrderDroppedManyNamed: {
      title: '{{count}} standing order periods skipped',
      body: '{{count}} scheduled occurrences for “{{order}}”, through {{period}}, were not recorded before the newest period became due.',
    },
    standingOrderDroppedManyUnnamed: {
      title: '{{count}} standing order periods skipped',
      body: '{{count}} scheduled occurrences for this standing order, through {{period}}, were not recorded before the newest period became due.',
    },
    standingOrderBookingFailedNamed: {
      title: 'Standing order booking failed',
      body: 'The {{period}} occurrence for “{{order}}” could not be recorded and will not be retried.',
    },
    standingOrderBookingFailedUnnamed: {
      title: 'Standing order booking failed',
      body: 'The {{period}} occurrence for this standing order could not be recorded and will not be retried.',
    },
    mirrorInvite: {
      title: 'Group portfolio invite',
      body: '{{actor}} invited you to join the group portfolio {{chain}}.',
    },
    mirrorMemberJoined: {
      title: 'New member in {{chain}}',
      body: '{{actor}} joined the group portfolio {{chain}}.',
    },
    mirrorMemberLeft: {
      title: 'A member left {{chain}}',
      body: '{{actor}} left the group portfolio {{chain}}.',
    },
    mirrorMemberRemoved: {
      title: 'A member was removed from {{chain}}',
      body: '{{actor}} was removed from the group portfolio {{chain}}.',
    },
    mirrorRemoved: {
      title: 'Removed from {{chain}}',
      body: 'You were removed from the group portfolio {{chain}}. You keep your copy — it just stops syncing.',
    },
    mirrorOwnershipTransferred: {
      title: 'Ownership of {{chain}} changed',
      body: '{{actor}} is now the owner of the group portfolio {{chain}}.',
    },
    mirrorChainDissolved: {
      title: '{{chain}} was dissolved',
      body: 'The group portfolio {{chain}} was dissolved. You keep your copy — it just stops syncing.',
    },
    mirrorSyncStalled: {
      title: 'Syncing {{chain}} is stuck',
      body: 'The group portfolio {{chain}} could not finish syncing. Open it and choose Retry sync.',
    },
    feedbackStatusNew: {
      title: 'Feedback reopened',
      body: 'Your feedback submission is back in the inbox.',
    },
    // Titles stay distinct per lifecycle event: a push banner often shows the
    // title alone, where a shared "Feedback update" would make "being reviewed"
    // and "declined" indistinguishable.
    feedbackStatusTriaged: {
      title: 'Feedback under review',
      body: 'Your feedback submission is being reviewed.',
    },
    feedbackStatusWorkingOnIt: {
      title: 'Feedback in progress',
      body: 'Work has started on your feedback submission.',
    },
    feedbackStatusSavedAsFutureIdea: {
      title: 'Feedback saved for later',
      body: 'Your feedback submission has been saved as a future idea.',
    },
    feedbackStatusDeclined: {
      title: 'Feedback declined',
      body: 'Your feedback submission was declined. Open it for details.',
    },
    feedbackStatusShipped: {
      title: 'Feedback shipped',
      body: 'Your feedback submission was shipped.',
    },
    feedbackReplyCreated: {
      title: 'New feedback reply',
      body: 'There is a new reply to your feedback submission.',
    },
  },
  de: {
    friendRequest: {
      title: 'Neue Freundschaftsanfrage',
      body: '{{actor}} hat dir eine Freundschaftsanfrage gesendet.',
    },
    friendAccepted: {
      title: 'Freundschaftsanfrage angenommen',
      body: '{{actor}} hat deine Freundschaftsanfrage angenommen.',
    },
    portfolioShared: {
      title: 'Portfolio geteilt',
      body: '{{actor}} hat das eigene Portfolio mit Freunden geteilt.',
    },
    watchlistShared: {
      title: 'Watchlist geteilt',
      body: '{{actor}} hat eine Watchlist mit dir geteilt.',
    },
    conglomerateShared: {
      title: 'Konglomerat geteilt',
      body: '{{actor}} hat ein Konglomerat mit dir geteilt.',
    },
    friendActivityBuy: {
      title: 'Aktivität von Freunden',
      body: '{{actor}} hat {{symbol}} gekauft.',
    },
    friendActivitySell: {
      title: 'Aktivität von Freunden',
      body: '{{actor}} hat {{symbol}} verkauft.',
    },
    friendActivityWatchlistAdd: {
      title: 'Aktivität von Freunden',
      body: '{{actor}} hat {{symbol}} zu einer geteilten Watchlist hinzugefügt.',
    },
    followPublishedPortfolio: {
      title: 'Neues Portfolio von {{actor}}',
      body: '{{actor}} hat ein neues Portfolio veröffentlicht: {{item}}.',
    },
    followPublishedWatchlist: {
      title: 'Neue Watchlist von {{actor}}',
      body: '{{actor}} hat eine neue Watchlist veröffentlicht: {{item}}.',
    },
    followPublishedConglomerate: {
      title: 'Neues Konglomerat von {{actor}}',
      body: '{{actor}} hat ein neues Konglomerat veröffentlicht: {{item}}.',
    },
    followPublishedIdea: {
      title: 'Neue Idee von {{actor}}',
      body: '{{actor}} hat eine neue Idee veröffentlicht: {{item}}.',
    },
    followAlertCreatedPriceAbove: {
      title: 'Neuer Preisalarm von {{actor}}',
      body: '{{actor}} hat einen Preisalarm erstellt: {{symbol}} über {{threshold}} {{currency}}.',
    },
    followAlertCreatedPriceBelow: {
      title: 'Neuer Preisalarm von {{actor}}',
      body: '{{actor}} hat einen Preisalarm erstellt: {{symbol}} unter {{threshold}} {{currency}}.',
    },
    followAlertCreatedPercentUpReference: {
      title: 'Neuer Preisalarm von {{actor}}',
      body: '{{actor}} hat einen Preisalarm erstellt: {{symbol}} {{threshold}} % über dem Referenzpreis.',
    },
    followAlertCreatedPercentDownReference: {
      title: 'Neuer Preisalarm von {{actor}}',
      body: '{{actor}} hat einen Preisalarm erstellt: {{symbol}} {{threshold}} % unter dem Referenzpreis.',
    },
    followAlertCreatedPercentDayUp: {
      title: 'Neuer Preisalarm von {{actor}}',
      body: '{{actor}} hat einen Preisalarm erstellt: {{symbol}} heute {{threshold}} % im Plus.',
    },
    followAlertCreatedPercentDayDown: {
      title: 'Neuer Preisalarm von {{actor}}',
      body: '{{actor}} hat einen Preisalarm erstellt: {{symbol}} heute {{threshold}} % im Minus.',
    },
    followAlertFiredPriceAbove: {
      title: 'Preisalarm von {{actor}} ausgelöst',
      body: 'Der Preisalarm von {{actor}} wurde ausgelöst: {{symbol}} über {{threshold}} {{currency}}.',
    },
    followAlertFiredPriceBelow: {
      title: 'Preisalarm von {{actor}} ausgelöst',
      body: 'Der Preisalarm von {{actor}} wurde ausgelöst: {{symbol}} unter {{threshold}} {{currency}}.',
    },
    followAlertFiredPercentUpReference: {
      title: 'Preisalarm von {{actor}} ausgelöst',
      body: 'Der Preisalarm von {{actor}} wurde ausgelöst: {{symbol}} {{threshold}} % über dem Referenzpreis.',
    },
    followAlertFiredPercentDownReference: {
      title: 'Preisalarm von {{actor}} ausgelöst',
      body: 'Der Preisalarm von {{actor}} wurde ausgelöst: {{symbol}} {{threshold}} % unter dem Referenzpreis.',
    },
    followAlertFiredPercentDayUp: {
      title: 'Preisalarm von {{actor}} ausgelöst',
      body: 'Der Preisalarm von {{actor}} wurde ausgelöst: {{symbol}} heute {{threshold}} % im Plus.',
    },
    followAlertFiredPercentDayDown: {
      title: 'Preisalarm von {{actor}} ausgelöst',
      body: 'Der Preisalarm von {{actor}} wurde ausgelöst: {{symbol}} heute {{threshold}} % im Minus.',
    },
    accountTempPassword: {
      title: 'Passwort zurückgesetzt',
      body: 'Die Administration hat dein Passwort zurückgesetzt. Das vorläufige Passwort findest du in deiner E-Mail.',
    },
    accountDataExport: {
      title: 'Dein Datenexport ist bereit',
      body: 'Der Export deiner Kontodaten ist abgeschlossen. Öffne Einstellungen → Konto, um ihn herunterzuladen.',
    },
    alertTriggeredPriceAbove: {
      title: 'Preisalarm: {{symbol}}',
      body: '{{symbol}} ist über {{threshold}} {{currency}} gestiegen.',
    },
    alertTriggeredPriceBelow: {
      title: 'Preisalarm: {{symbol}}',
      body: '{{symbol}} ist unter {{threshold}} {{currency}} gefallen.',
    },
    alertTriggeredPercentUpReference: {
      title: 'Preisalarm: {{symbol}}',
      body: '{{symbol}} liegt {{threshold}} % über deinem Referenzpreis.',
    },
    alertTriggeredPercentDownReference: {
      title: 'Preisalarm: {{symbol}}',
      body: '{{symbol}} liegt {{threshold}} % unter deinem Referenzpreis.',
    },
    alertTriggeredPercentDayUp: {
      title: 'Preisalarm: {{symbol}}',
      body: '{{symbol}} liegt heute {{threshold}} % im Plus.',
    },
    alertTriggeredPercentDayDown: {
      title: 'Preisalarm: {{symbol}}',
      body: '{{symbol}} liegt heute {{threshold}} % im Minus.',
    },
    earningsReminderConfirmed: {
      title: 'Bald Quartalszahlen: {{symbol}}',
      body: '{{name}} ({{symbol}}) legt am {{date}} Quartalszahlen vor.',
    },
    earningsReminderEstimated: {
      title: 'Bald Quartalszahlen: {{symbol}}',
      body: '{{name}} ({{symbol}}) wird voraussichtlich um den {{date}} Quartalszahlen vorlegen.',
    },
    chatMessagePreview: {
      title: 'Neue Nachricht',
      body: '{{sender}}: {{preview}}',
    },
    chatMessageSharedItem: {
      title: 'Neue Nachricht',
      body: '{{sender}} hat einen Inhalt mit dir geteilt.',
    },
    chatMessagePlain: {
      title: 'Neue Nachricht',
      body: '{{sender}} hat dir eine Nachricht gesendet.',
    },
    dividendEvent: {
      title: '{{symbol}}: Ex-Dividende am {{date}}',
      body: '{{symbol}} wird am {{date}} ex Dividende gehandelt.',
    },
    dividendEventWithAmount: {
      title: '{{symbol}}: Ex-Dividende am {{date}}',
      body: '{{symbol}} wird am {{date}} ex Dividende gehandelt ({{amount}} {{currency}} je Aktie).',
    },
    budgetExceeded: {
      title: 'Budget überschritten: {{category}}',
      body: 'Du hast diesen Monat {{spent}} {{currency}} für {{category}} ausgegeben — mehr als dein Budget von {{target}} {{currency}}.',
    },
    standingOrderDeferredNamed: {
      title: 'Dauerauftrag zurückgestellt',
      body: 'Die Ausführung von „{{order}}“ am {{period}} konnte nicht gebucht werden. BetterTrack versucht es erneut.',
    },
    standingOrderDeferredUnnamed: {
      title: 'Dauerauftrag zurückgestellt',
      body: 'Die Ausführung dieses Dauerauftrags am {{period}} konnte nicht gebucht werden. BetterTrack versucht es erneut.',
    },
    standingOrderDroppedNamed: {
      title: 'Dauerauftrags-Ausführung übersprungen',
      body: 'Die Ausführung von „{{order}}“ am {{period}} wurde nicht erfasst, bevor der nächste Termin fällig wurde.',
    },
    standingOrderDroppedUnnamed: {
      title: 'Dauerauftrags-Ausführung übersprungen',
      body: 'Die Ausführung dieses Dauerauftrags am {{period}} wurde nicht erfasst, bevor der nächste Termin fällig wurde.',
    },
    standingOrderDroppedManyNamed: {
      title: '{{count}} Dauerauftrags-Ausführungen übersprungen',
      body: '{{count}} geplante Ausführungen von „{{order}}“ bis einschließlich {{period}} wurden nicht erfasst, bevor der neueste Termin fällig wurde.',
    },
    standingOrderDroppedManyUnnamed: {
      title: '{{count}} Dauerauftrags-Ausführungen übersprungen',
      body: '{{count}} geplante Ausführungen dieses Dauerauftrags bis einschließlich {{period}} wurden nicht erfasst, bevor der neueste Termin fällig wurde.',
    },
    standingOrderBookingFailedNamed: {
      title: 'Dauerauftrags-Buchung fehlgeschlagen',
      body: 'Die Ausführung von „{{order}}“ am {{period}} konnte nicht erfasst werden und wird nicht erneut versucht.',
    },
    standingOrderBookingFailedUnnamed: {
      title: 'Dauerauftrags-Buchung fehlgeschlagen',
      body: 'Die Ausführung dieses Dauerauftrags am {{period}} konnte nicht erfasst werden und wird nicht erneut versucht.',
    },
    mirrorInvite: {
      title: 'Einladung zu einem Gruppen-Portfolio',
      body: '{{actor}} hat dich eingeladen, dem Gruppen-Portfolio {{chain}} beizutreten.',
    },
    mirrorMemberJoined: {
      title: 'Neues Mitglied in {{chain}}',
      body: '{{actor}} ist dem Gruppen-Portfolio {{chain}} beigetreten.',
    },
    mirrorMemberLeft: {
      title: 'Ein Mitglied hat {{chain}} verlassen',
      body: '{{actor}} hat das Gruppen-Portfolio {{chain}} verlassen.',
    },
    mirrorMemberRemoved: {
      title: 'Ein Mitglied wurde aus {{chain}} entfernt',
      body: '{{actor}} wurde aus dem Gruppen-Portfolio {{chain}} entfernt.',
    },
    mirrorRemoved: {
      title: 'Aus {{chain}} entfernt',
      body: 'Du wurdest aus dem Gruppen-Portfolio {{chain}} entfernt. Deine Kopie bleibt erhalten — sie wird nur nicht mehr synchronisiert.',
    },
    mirrorOwnershipTransferred: {
      title: 'Eigentümerschaft von {{chain}} geändert',
      body: '{{actor}} ist jetzt Eigentümer:in des Gruppen-Portfolios {{chain}}.',
    },
    mirrorChainDissolved: {
      title: '{{chain}} wurde aufgelöst',
      body: 'Das Gruppen-Portfolio {{chain}} wurde aufgelöst. Deine Kopie bleibt erhalten — sie wird nur nicht mehr synchronisiert.',
    },
    mirrorSyncStalled: {
      title: 'Synchronisierung von {{chain}} hängt',
      body: 'Das Gruppen-Portfolio {{chain}} konnte nicht fertig synchronisiert werden. Öffne es und wähle „Synchronisierung wiederholen“.',
    },
    feedbackStatusNew: {
      title: 'Feedback wieder geöffnet',
      body: 'Dein Feedback ist wieder im Posteingang.',
    },
    feedbackStatusTriaged: {
      title: 'Feedback wird geprüft',
      body: 'Dein Feedback wird geprüft.',
    },
    feedbackStatusWorkingOnIt: {
      title: 'Feedback in Bearbeitung',
      body: 'Die Arbeit an deinem Feedback hat begonnen.',
    },
    feedbackStatusSavedAsFutureIdea: {
      title: 'Feedback für später gespeichert',
      body: 'Dein Feedback wurde als zukünftige Idee gespeichert.',
    },
    feedbackStatusDeclined: {
      title: 'Feedback abgelehnt',
      body: 'Dein Feedback wurde abgelehnt. Öffne es für Details.',
    },
    feedbackStatusShipped: {
      title: 'Feedback umgesetzt',
      body: 'Dein Feedback wurde umgesetzt.',
    },
    feedbackReplyCreated: {
      title: 'Neue Antwort auf dein Feedback',
      body: 'Es gibt eine neue Antwort auf dein Feedback.',
    },
  },
};

/** Build the wire descriptor attached to a notification payload. */
export function notificationMessage(
  key: NotificationMessageKey,
  params: NotificationMessageParams = {},
): NotificationMessage {
  return { key, params };
}

/** Render one descriptor for persisted fallback strings and outbound channels. */
export function renderNotificationMessage(
  message: NotificationMessage,
  locale: string | null | undefined,
): NotificationCopyPair {
  const template = NOTIFICATION_COPY[resolveEmailLocale(locale)][message.key];
  return {
    title: interpolate(template.title, message.params),
    body: interpolate(template.body, message.params),
  };
}

function interpolate(template: string, params: NotificationMessageParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}
