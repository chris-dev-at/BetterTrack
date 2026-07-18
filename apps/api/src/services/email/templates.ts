/**
 * Account-email templates (PROJECTPLAN.md §6.11). Minimal, clean HTML with a
 * plain-text fallback — no images, no tracking, inline styles only so they
 * render the same in every client. These cover the v1 account flows; the full
 * notification template set (alert.triggered, etc.) lands with P5.
 *
 * Notification emails (friend request/accepted, portfolio shared, price alert)
 * render in the recipient's locale via {@link notificationCopy} (§13.3 V3-P1);
 * account/admin emails stay EN.
 */

import { notificationCopy, resolveEmailLocale } from './emailI18n';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const BRAND = 'BetterTrack';

/** The default (account-email) footer line; notification emails pass their own. */
const DEFAULT_FOOTER =
  'You received this email because someone manages a BetterTrack account for this address.';

/**
 * Shared shell so every email looks the same. `body` is trusted HTML. `lang`
 * sets the document language (localized notification emails pass the recipient's
 * locale); `footer` overrides the default account-email footer line.
 */
function layout(
  heading: string,
  body: string,
  opts: { lang?: string; footer?: string } = {},
): string {
  const { lang = 'en', footer = DEFAULT_FOOTER } = opts;
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(lang)}">`,
    '<body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;">',
    `<tr><td style="font-size:18px;font-weight:600;padding-bottom:16px;">${BRAND}</td></tr>`,
    `<tr><td style="font-size:20px;font-weight:600;padding-bottom:12px;">${heading}</td></tr>`,
    `<tr><td style="font-size:14px;line-height:1.6;color:#333;">${body}</td></tr>`,
    '<tr><td style="font-size:12px;color:#8a9099;padding-top:24px;border-top:1px solid #eceef1;margin-top:24px;">',
    escapeHtml(footer),
    '</td></tr>',
    '</table></td></tr></table>',
    '</body></html>',
  ].join('');
}

/** Escapes the few characters that could break out of an HTML text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:#1a1d21;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;">${label}</a>`;
}

/**
 * Fill a localized copy string's `{actor}`/`{symbol}` tokens. `html` bolds and
 * HTML-escapes the value; `text` inlines it raw. One template string serves both.
 */
function fillHtml(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined ? `{${key}}` : `<strong>${escapeHtml(value)}</strong>`;
  });
}
function fillText(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined ? `{${key}}` : value;
  });
}

export function inviteEmail(params: { inviteUrl: string }): EmailContent {
  const { inviteUrl } = params;
  return {
    subject: `You're invited to ${BRAND}`,
    html: layout(
      `You're invited to ${BRAND}`,
      [
        '<p>An administrator has invited you to create a BetterTrack account. ',
        'Use the link below to pick a username and password.</p>',
        `<p style="padding:8px 0 16px;">${button(inviteUrl, 'Accept invitation')}</p>`,
        '<p>This invitation expires in 7 days. If the button does not work, copy this link into your browser:</p>',
        `<p style="word-break:break-all;color:#5b6470;">${escapeHtml(inviteUrl)}</p>`,
      ].join(''),
    ),
    text: [
      `You're invited to ${BRAND}.`,
      '',
      'An administrator has invited you to create a BetterTrack account.',
      'Open this link to pick a username and password (expires in 7 days):',
      '',
      inviteUrl,
    ].join('\n'),
  };
}

export function tempPasswordEmail(params: {
  username: string;
  tempPassword: string;
  loginUrl: string;
  reason: 'created' | 'reset';
}): EmailContent {
  const { username, tempPassword, loginUrl, reason } = params;
  const heading = reason === 'reset' ? 'Your password was reset' : `Your ${BRAND} account is ready`;
  const intro =
    reason === 'reset'
      ? 'An administrator reset your password. Sign in with the temporary password below — you will be asked to choose a new one right away.'
      : 'An administrator created a BetterTrack account for you. Sign in with the temporary password below — you will be asked to choose a new one right away.';
  return {
    subject:
      reason === 'reset' ? `Your ${BRAND} password was reset` : `Your ${BRAND} account is ready`,
    html: layout(
      heading,
      [
        `<p>${intro}</p>`,
        `<p style="font-size:14px;">Username: <strong>${escapeHtml(username)}</strong></p>`,
        '<p style="font-size:14px;">Temporary password:</p>',
        `<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;background:#f5f6f8;border-radius:8px;padding:12px 16px;letter-spacing:0.5px;">${escapeHtml(tempPassword)}</p>`,
        `<p style="padding:8px 0 0;">${button(loginUrl, 'Sign in')}</p>`,
      ].join(''),
    ),
    text: [
      heading + '.',
      '',
      intro,
      '',
      `Username: ${username}`,
      `Temporary password: ${tempPassword}`,
      '',
      `Sign in: ${loginUrl}`,
      '',
      'You will be asked to choose a new password on first sign-in.',
    ].join('\n'),
  };
}

/**
 * Self-service password-reset email (PROJECTPLAN.md §6.1, §14). Carries the
 * single-use, short-lived tokenized link — no credential, no account data. The
 * user follows it to choose a new password; the link expires within the hour.
 */
export function passwordResetEmail(params: { resetUrl: string }): EmailContent {
  const { resetUrl } = params;
  return {
    subject: `Reset your ${BRAND} password`,
    html: layout(
      'Reset your password',
      [
        '<p>We received a request to reset the password for your BetterTrack account. ',
        'Use the link below to choose a new one.</p>',
        `<p style="padding:8px 0 16px;">${button(resetUrl, 'Reset password')}</p>`,
        '<p>This link expires in 1 hour and can be used once. If you did not request this, ',
        'you can safely ignore this email — your password will not change.</p>',
        `<p style="word-break:break-all;color:#5b6470;">${escapeHtml(resetUrl)}</p>`,
      ].join(''),
    ),
    text: [
      `Reset your ${BRAND} password.`,
      '',
      'We received a request to reset the password for your BetterTrack account.',
      'Open this link to choose a new one (expires in 1 hour, single use):',
      '',
      resetUrl,
      '',
      'If you did not request this, you can safely ignore this email.',
    ].join('\n'),
  };
}

/**
 * Diagnostic email triggered from the admin console (PROJECTPLAN.md §6.12) to
 * confirm SMTP is wired. Carries no account data — it just has to arrive.
 */
export function testEmail(params: { appUrl: string }): EmailContent {
  const { appUrl } = params;
  return {
    subject: `${BRAND} SMTP test`,
    html: layout(
      'SMTP test successful',
      [
        '<p>This is a test email sent from your BetterTrack admin console. ',
        'If it reached you, outbound email is configured correctly.</p>',
        `<p style="padding:8px 0 0;">${button(appUrl, 'Open BetterTrack')}</p>`,
      ].join(''),
    ),
    text: [
      `${BRAND} SMTP test`,
      '',
      'This is a test email sent from your BetterTrack admin console.',
      'If it reached you, outbound email is configured correctly.',
      '',
      `Open BetterTrack: ${appUrl}`,
    ].join('\n'),
  };
}

/**
 * Notification emails (PROJECTPLAN.md §6.10). Sent by the dispatcher when the
 * recipient's email channel is enabled. Same minimal shell as the account
 * templates — no images, no tracking, inline styles only.
 */
export function friendRequestEmail(params: {
  actorUsername: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { actorUsername, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.friendRequest;
  return {
    subject: c.subject,
    html: layout(
      c.heading,
      [
        `<p>${fillHtml(c.body, { actor: actorUsername })}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [fillText(c.body, { actor: actorUsername }), '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

export function friendAcceptedEmail(params: {
  actorUsername: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { actorUsername, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.friendAccepted;
  return {
    subject: fillText(c.subject, { actor: actorUsername }),
    html: layout(
      c.heading,
      [
        `<p>${fillHtml(c.body, { actor: actorUsername })}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [fillText(c.body, { actor: actorUsername }), '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

export function portfolioSharedEmail(params: {
  actorUsername: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { actorUsername, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.portfolioShared;
  return {
    subject: fillText(c.subject, { actor: actorUsername }),
    html: layout(
      c.heading,
      [
        `<p>${fillHtml(c.body, { actor: actorUsername })}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [fillText(c.body, { actor: actorUsername }), '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/**
 * New chat-message notification email (PROJECTPLAN.md §13.3 V3-P8). Sent by the
 * dispatcher when the recipient routes `chat.message` to email. Carries no
 * message content by design (privacy) — just that a new message is waiting and a
 * link into the app.
 */
export function chatMessageEmail(params: {
  actorUsername: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { actorUsername, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.chatMessage;
  return {
    subject: fillText(c.subject, { actor: actorUsername }),
    html: layout(
      c.heading,
      [
        `<p>${fillHtml(c.body, { actor: actorUsername })}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [fillText(c.body, { actor: actorUsername }), '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/**
 * Digest summary email (V5-P3): one send bundling a day's / week's deferred
 * notifications into a single list, each row the same title + body the instant
 * email would have carried. Rendered in the recipient's locale like every other
 * notification email.
 */
export function digestEmail(params: {
  cadence: 'daily' | 'weekly';
  items: readonly { title: string; body: string }[];
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { cadence, items, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.digest;
  const subject = cadence === 'daily' ? c.subjectDaily : c.subjectWeekly;
  const heading = cadence === 'daily' ? c.headingDaily : c.headingWeekly;
  const listHtml = items
    .map(
      (item) =>
        `<li style="margin-bottom:12px;"><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.body)}</li>`,
    )
    .join('');
  const listText = items.map((item) => `• ${item.title}\n  ${item.body}`).join('\n');
  return {
    subject,
    html: layout(
      heading,
      [
        `<p>${escapeHtml(c.intro)}</p>`,
        `<ul style="padding-left:18px;margin:16px 0;list-style:disc;">${listHtml}</ul>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [c.intro, '', listText, '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/**
 * Quiet-hours deferred notification email (§13.5 V5-P3). Sent at the user's
 * quiet-window end for a single instant notification (or a quiet-blocked digest
 * summary) that was held back. The content is the already-rendered title + body
 * — English like every inbox row and the digest list — wrapped in the localized
 * chrome (footer + app button), mirroring how {@link digestEmail} presents its
 * deferred items. Multi-line bodies (a deferred digest summary) keep their line
 * breaks in both HTML and text.
 */
export function deferredNotificationEmail(params: {
  title: string;
  body: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { title, body, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const bodyHtml = escapeHtml(body).replace(/\n/g, '<br>');
  return {
    subject: title,
    html: layout(
      title,
      [
        `<p>${bodyHtml}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, copy.openApp)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [body, '', `${copy.openApp}: ${appUrl}`].join('\n'),
  };
}

/** `watchlist.shared` notification email (#368) — mirrors the portfolio one. */
export function watchlistSharedEmail(params: {
  actorUsername: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { actorUsername, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.watchlistShared;
  return {
    subject: fillText(c.subject, { actor: actorUsername }),
    html: layout(
      c.heading,
      [
        `<p>${fillHtml(c.body, { actor: actorUsername })}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [fillText(c.body, { actor: actorUsername }), '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/** `conglomerate.shared` notification email (#368) — mirrors the portfolio one. */
export function conglomerateSharedEmail(params: {
  actorUsername: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { actorUsername, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.conglomerateShared;
  return {
    subject: fillText(c.subject, { actor: actorUsername }),
    html: layout(
      c.heading,
      [
        `<p>${fillHtml(c.body, { actor: actorUsername })}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [fillText(c.body, { actor: actorUsername }), '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/**
 * `friend.activity` notification email (#368). `body` is the same one-sentence
 * phrasing the in-app bell item carries ("X bought AAPL."), like the alert one.
 */
export function friendActivityEmail(params: {
  body: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { body, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.friendActivity;
  return {
    subject: c.subject,
    html: layout(
      c.heading,
      [
        `<p>${escapeHtml(body)}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [body, '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/**
 * Follow-published notification email (#438). The body sentence is pre-rendered
 * by the dispatcher (identical to the bell copy), so this only wraps it with the
 * localized subject/heading/button chrome — mirroring {@link friendActivityEmail}.
 */
export function followPublishedEmail(params: {
  body: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { body, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.followPublished;
  return {
    subject: c.subject,
    html: layout(
      c.heading,
      [
        `<p>${escapeHtml(body)}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [body, '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/**
 * Alert-follow notification emails (#455): a followed person created a price
 * alert (`variant: 'created'`) or one of their alerts fired (`variant:
 * 'fired'`). The body sentence is pre-rendered by the dispatcher (identical to
 * the bell copy), so this only wraps it with the localized
 * subject/heading/button chrome — mirroring {@link followPublishedEmail}.
 */
export function followAlertEmail(params: {
  variant: 'created' | 'fired';
  body: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { variant, body, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = variant === 'created' ? copy.followAlertCreated : copy.followAlertFired;
  return {
    subject: c.subject,
    html: layout(
      c.heading,
      [
        `<p>${escapeHtml(body)}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [body, '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/**
 * Login 2FA email-code (PROJECTPLAN.md §6.1, §13.2 V2-P5). One of the two second-
 * factor channels: a short-lived, single-use numeric code the user enters at the
 * login challenge. Carries no link and no account data beyond the code itself.
 */
export function twoFactorCodeEmail(params: { code: string; minutes: number }): EmailContent {
  const { code, minutes } = params;
  return {
    subject: `Your ${BRAND} sign-in code`,
    html: layout(
      'Your sign-in code',
      [
        '<p>Use this code to finish signing in to your BetterTrack account:</p>',
        `<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:28px;font-weight:700;background:#f5f6f8;border-radius:8px;padding:12px 16px;letter-spacing:4px;text-align:center;">${escapeHtml(code)}</p>`,
        `<p>This code expires in ${minutes} minutes and can be used once. `,
        'If you did not try to sign in, you can safely ignore this email.</p>',
      ].join(''),
    ),
    text: [
      `Your ${BRAND} sign-in code: ${code}`,
      '',
      `This code expires in ${minutes} minutes and can be used once.`,
      'If you did not try to sign in, you can safely ignore this email.',
    ].join('\n'),
  };
}

/**
 * Price-alert notification email (PROJECTPLAN.md §14, V3-P10). Sent by the
 * dispatcher when the recipient routes `alert.triggered` to email. `body` is the
 * same one-sentence phrasing the in-app bell item carries.
 */
export function alertTriggeredEmail(params: {
  symbol: string;
  body: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { symbol, body, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.alertTriggered;
  return {
    subject: fillText(c.subject, { symbol }),
    html: layout(
      c.heading.replace('{symbol}', escapeHtml(symbol)),
      [
        `<p>${escapeHtml(body)}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [fillText(c.subject, { symbol }), '', body, '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

/**
 * Approval-queue decision emails (PROJECTPLAN.md §6.12, §13.4 V4-P4a). Sent when
 * an admin approves or rejects a pending registration in `approval` mode; both
 * render in the language the registrant used on the register form (EN fallback).
 * Approved links to sign-in; rejected carries no link and no credential.
 */
export function registrationApprovedEmail(params: {
  username: string;
  appUrl: string;
  locale?: string;
}): EmailContent {
  const { username, appUrl, locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.registrationApproved;
  return {
    subject: c.subject,
    html: layout(
      c.heading,
      [
        `<p>${fillHtml(c.body, { username })}</p>`,
        `<p style="padding:8px 0 0;">${button(appUrl, c.button)}</p>`,
      ].join(''),
      { lang: loc, footer: copy.footer },
    ),
    text: [fillText(c.body, { username }), '', `${c.button}: ${appUrl}`].join('\n'),
  };
}

export function registrationRejectedEmail(params: { locale?: string }): EmailContent {
  const { locale } = params;
  const loc = resolveEmailLocale(locale);
  const copy = notificationCopy(loc);
  const c = copy.registrationRejected;
  return {
    subject: c.subject,
    html: layout(c.heading, `<p>${escapeHtml(c.body)}</p>`, { lang: loc, footer: copy.footer }),
    text: c.body,
  };
}

export function welcomeEmail(params: { username: string; appUrl: string }): EmailContent {
  const { username, appUrl } = params;
  return {
    subject: `Welcome to ${BRAND}`,
    html: layout(
      `Welcome to ${BRAND}`,
      [
        `<p>Your account is all set, <strong>${escapeHtml(username)}</strong>. `,
        'Track assets, build conglomerates, and watch your portfolio in one place.</p>',
        `<p style="padding:8px 0 0;">${button(appUrl, 'Open BetterTrack')}</p>`,
      ].join(''),
    ),
    text: [
      `Welcome to ${BRAND}, ${username}.`,
      '',
      'Your account is all set. Track assets, build conglomerates, and watch your portfolio in one place.',
      '',
      `Open BetterTrack: ${appUrl}`,
    ].join('\n'),
  };
}
