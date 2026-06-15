/**
 * Account-email templates (PROJECTPLAN.md §6.11). Minimal, clean HTML with a
 * plain-text fallback — no images, no tracking, inline styles only so they
 * render the same in every client. These cover the v1 account flows; the full
 * notification template set (alert.triggered, etc.) lands with P5.
 */

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const BRAND = 'BetterTrack';

/** Shared shell so every account email looks the same. `body` is trusted HTML. */
function layout(heading: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;">',
    `<tr><td style="font-size:18px;font-weight:600;padding-bottom:16px;">${BRAND}</td></tr>`,
    `<tr><td style="font-size:20px;font-weight:600;padding-bottom:12px;">${heading}</td></tr>`,
    `<tr><td style="font-size:14px;line-height:1.6;color:#333;">${body}</td></tr>`,
    '<tr><td style="font-size:12px;color:#8a9099;padding-top:24px;border-top:1px solid #eceef1;margin-top:24px;">',
    'You received this email because someone manages a BetterTrack account for this address.',
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
