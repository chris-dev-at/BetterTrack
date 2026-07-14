import type { AppConfig } from '../../config/env';
import type { EmailLogRepository } from '../../data/repositories/emailLogRepository';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import {
  alertTriggeredEmail,
  chatMessageEmail,
  followAlertEmail,
  conglomerateSharedEmail,
  friendAcceptedEmail,
  followPublishedEmail,
  friendActivityEmail,
  friendRequestEmail,
  inviteEmail,
  passwordResetEmail,
  portfolioSharedEmail,
  registrationApprovedEmail,
  registrationRejectedEmail,
  tempPasswordEmail,
  testEmail,
  twoFactorCodeEmail,
  watchlistSharedEmail,
  welcomeEmail,
  type EmailContent,
} from './templates';
import type { MailTransport } from './transport';

/**
 * Account-email channel (PROJECTPLAN.md §6.1, §6.11). This is the P0 slice:
 * invite / temp-password / welcome mails only — not the full notification
 * dispatcher (P5). Three rules drive the design:
 *
 *  1. The channel is optional. With no SMTP config the app runs and every
 *     account flow still works; admins copy the temp password / invite URL
 *     straight from the API response (PROJECTPLAN.md §11).
 *  2. Sending is best-effort and happens *after* the DB writes commit, so a
 *     mail failure can never roll back account creation/reset/invite state.
 *  3. Failures are logged and audited (`email.send_failed`) with a coarse error
 *     code only — never the SMTP credentials or the message body.
 */

export interface EmailAuditTarget {
  actorId?: string | null;
  targetType: 'user' | 'invite';
  targetId: string;
  ip?: string | null;
}

export type EmailSendResult =
  | { status: 'sent' }
  | { status: 'skipped' }
  | { status: 'failed'; code: string };

export interface EmailService {
  /** True when SMTP is configured; false ⇒ every send is a no-op. */
  readonly enabled: boolean;
  sendInvite(params: {
    to: string;
    inviteUrl: string;
    audit: EmailAuditTarget;
  }): Promise<EmailSendResult>;
  sendTempPassword(params: {
    to: string;
    username: string;
    tempPassword: string;
    reason: 'created' | 'reset';
    audit: EmailAuditTarget;
  }): Promise<EmailSendResult>;
  /** Self-service reset (§6.1, §14): the tokenized link to choose a new password. */
  sendPasswordReset(params: {
    to: string;
    resetUrl: string;
    audit: EmailAuditTarget;
  }): Promise<EmailSendResult>;
  /**
   * Login 2FA email-code channel (§6.1, §13.2 V2-P5): a short-lived numeric code
   * the user enters at the login challenge. Best-effort like every send — with no
   * SMTP it logs `suppressed` and never throws.
   */
  sendTwoFactorCode(params: {
    to: string;
    userId: string;
    code: string;
    expiresInMinutes: number;
    audit: EmailAuditTarget;
  }): Promise<EmailSendResult>;
  sendWelcome(params: {
    to: string;
    username: string;
    audit: EmailAuditTarget;
  }): Promise<EmailSendResult>;
  /**
   * Approval-queue decision emails (§6.12, §13.4 V4-P4a), localized to the
   * registrant's chosen language. Approved carries the new user's id for the log;
   * rejected has no account (userId null). Best-effort like every send.
   */
  sendRegistrationApproved(params: {
    to: string;
    userId: string;
    username: string;
    locale?: string;
    audit: EmailAuditTarget;
  }): Promise<EmailSendResult>;
  sendRegistrationRejected(params: {
    to: string;
    locale?: string;
    audit: EmailAuditTarget;
  }): Promise<EmailSendResult>;
  /** Admin diagnostic (PROJECTPLAN.md §6.12): a throwaway "does SMTP work" mail. */
  sendTest(params: { to: string; audit: EmailAuditTarget }): Promise<EmailSendResult>;
  /** Notification email: someone sent `userId` a friend request. `locale` = recipient's UI language (§13.3 V3-P1). */
  sendFriendRequest(params: {
    to: string;
    userId: string;
    actorUsername: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: `userId`'s pending friend request was accepted. */
  sendFriendAccepted(params: {
    to: string;
    userId: string;
    actorUsername: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: a portfolio was shared with `userId`. */
  sendPortfolioShared(params: {
    to: string;
    userId: string;
    actorUsername: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: a watchlist was shared with `userId` (#368). */
  sendWatchlistShared(params: {
    to: string;
    userId: string;
    actorUsername: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: a conglomerate was shared with `userId` (#368). */
  sendConglomerateShared(params: {
    to: string;
    userId: string;
    actorUsername: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: friend activity on a shared item `userId` follows (#368). */
  sendFriendActivity(params: {
    to: string;
    userId: string;
    body: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: a user `userId` follows published a newly-visible item (#438). */
  sendFollowPublished(params: {
    to: string;
    userId: string;
    body: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: someone `userId` follows created a price alert (#455). */
  sendFollowAlertCreated(params: {
    to: string;
    userId: string;
    body: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: a price alert of someone `userId` follows fired (#455). */
  sendFollowAlertFired(params: {
    to: string;
    userId: string;
    body: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: a price alert `userId` set fired (§14). */
  sendAlertTriggered(params: {
    to: string;
    userId: string;
    symbol: string;
    body: string;
    locale?: string;
  }): Promise<EmailSendResult>;
  /** Notification email: a friend sent `userId` a chat message (§13.3 V3-P8). No message content. */
  sendChatMessage(params: {
    to: string;
    userId: string;
    actorUsername: string;
    locale?: string;
  }): Promise<EmailSendResult>;
}

export interface EmailServiceDeps {
  config: AppConfig;
  logger: Logger;
  audit: AuditService;
  /** Per-send log (§6.10): every attempt writes exactly one row here. */
  emailLog: EmailLogRepository;
  /** Present iff the email channel is wired; null keeps the channel disabled. */
  transport: MailTransport | null;
}

/** Every send-attempt outcome maps to one `email_log` status (§6.10). */
type EmailTemplateKind =
  | 'invite'
  | 'temp_password'
  | 'password_reset'
  | 'two_factor_code'
  | 'welcome'
  | 'registration_approved'
  | 'registration_rejected'
  | 'test'
  | 'friend_request'
  | 'friend_accepted'
  | 'portfolio_shared'
  | 'watchlist_shared'
  | 'conglomerate_shared'
  | 'friend_activity'
  | 'follow_published'
  | 'follow_alert_created'
  | 'follow_alert_fired'
  | 'alert_triggered'
  | 'chat_message';

/** Coarse, secret-free error tag for logs/audit. Never the raw SMTP response. */
function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    if (err instanceof Error && err.name) return err.name;
  }
  return 'UNKNOWN';
}

export function createEmailService(deps: EmailServiceDeps): EmailService {
  const { config, logger, audit, emailLog, transport } = deps;
  const enabled = Boolean(config.email.enabled && transport);

  /** Best-effort log write — a logging hiccup must never break a send. */
  async function logSend(row: {
    userId: string | null;
    recipient: string;
    template: EmailTemplateKind;
    subject: string;
    status: 'sent' | 'failed' | 'suppressed';
    errorCode?: string | null;
  }): Promise<void> {
    try {
      await emailLog.insert(row);
    } catch (err) {
      logger.warn({ template: row.template, err }, 'failed to write email_log row');
    }
  }

  async function deliver(
    kind: EmailTemplateKind,
    to: string,
    content: EmailContent,
    opts: { userId?: string | null; audit?: EmailAuditTarget },
  ): Promise<EmailSendResult> {
    // For account emails the recipient user is the audit target; notification
    // emails pass `userId` directly. Invites have no account yet ⇒ null.
    const userId = opts.userId ?? (opts.audit?.targetType === 'user' ? opts.audit.targetId : null);

    if (!enabled || !transport) {
      // Channel unconfigured/disabled ⇒ suppressed (§6.10). The admin-facing
      // account response still carries the credential.
      logger.debug({ kind, to }, 'email channel disabled; suppressing send');
      await logSend({
        userId,
        recipient: to,
        template: kind,
        subject: content.subject,
        status: 'suppressed',
      });
      return { status: 'skipped' };
    }
    try {
      await transport.send({
        to,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      logger.info({ kind, to }, 'email sent');
      await logSend({
        userId,
        recipient: to,
        template: kind,
        subject: content.subject,
        status: 'sent',
      });
      return { status: 'sent' };
    } catch (err) {
      const code = errorCode(err);
      // Log + audit the failure without the body or any secret material. The
      // flow has already committed; this never throws back to the caller.
      logger.warn({ kind, to, code }, 'email failed to send');
      await logSend({
        userId,
        recipient: to,
        template: kind,
        subject: content.subject,
        status: 'failed',
        errorCode: code,
      });
      if (opts.audit) {
        await audit.record({
          actorId: opts.audit.actorId ?? null,
          action: AuditAction.EmailSendFailed,
          targetType: opts.audit.targetType,
          targetId: opts.audit.targetId,
          ip: opts.audit.ip ?? null,
          meta: { kind, code },
        });
      }
      return { status: 'failed', code };
    }
  }

  return {
    enabled,

    sendInvite: ({ to, inviteUrl, audit: target }) =>
      deliver('invite', to, inviteEmail({ inviteUrl }), { audit: target }),

    sendTempPassword: ({ to, username, tempPassword, reason, audit: target }) =>
      deliver(
        'temp_password',
        to,
        tempPasswordEmail({ username, tempPassword, reason, loginUrl: config.appOrigin }),
        { audit: target },
      ),

    sendPasswordReset: ({ to, resetUrl, audit: target }) =>
      deliver('password_reset', to, passwordResetEmail({ resetUrl }), { audit: target }),

    sendTwoFactorCode: ({ to, userId, code, expiresInMinutes, audit: target }) =>
      deliver('two_factor_code', to, twoFactorCodeEmail({ code, minutes: expiresInMinutes }), {
        userId,
        audit: target,
      }),

    sendWelcome: ({ to, username, audit: target }) =>
      deliver('welcome', to, welcomeEmail({ username, appUrl: config.appOrigin }), {
        audit: target,
      }),

    sendRegistrationApproved: ({ to, userId, username, locale, audit: target }) =>
      deliver(
        'registration_approved',
        to,
        registrationApprovedEmail({ username, appUrl: config.appOrigin, locale }),
        { userId, audit: target },
      ),

    sendRegistrationRejected: ({ to, locale, audit: target }) =>
      deliver('registration_rejected', to, registrationRejectedEmail({ locale }), {
        userId: null,
        audit: target,
      }),

    sendTest: ({ to, audit: target }) =>
      deliver('test', to, testEmail({ appUrl: config.appOrigin }), { audit: target }),

    sendFriendRequest: ({ to, userId, actorUsername, locale }) =>
      deliver(
        'friend_request',
        to,
        friendRequestEmail({ actorUsername, appUrl: config.appOrigin, locale }),
        {
          userId,
        },
      ),

    sendFriendAccepted: ({ to, userId, actorUsername, locale }) =>
      deliver(
        'friend_accepted',
        to,
        friendAcceptedEmail({ actorUsername, appUrl: config.appOrigin, locale }),
        { userId },
      ),

    sendPortfolioShared: ({ to, userId, actorUsername, locale }) =>
      deliver(
        'portfolio_shared',
        to,
        portfolioSharedEmail({ actorUsername, appUrl: config.appOrigin, locale }),
        { userId },
      ),

    sendWatchlistShared: ({ to, userId, actorUsername, locale }) =>
      deliver(
        'watchlist_shared',
        to,
        watchlistSharedEmail({ actorUsername, appUrl: config.appOrigin, locale }),
        { userId },
      ),

    sendConglomerateShared: ({ to, userId, actorUsername, locale }) =>
      deliver(
        'conglomerate_shared',
        to,
        conglomerateSharedEmail({ actorUsername, appUrl: config.appOrigin, locale }),
        { userId },
      ),

    sendFriendActivity: ({ to, userId, body, locale }) =>
      deliver(
        'friend_activity',
        to,
        friendActivityEmail({ body, appUrl: config.appOrigin, locale }),
        { userId },
      ),

    sendFollowPublished: ({ to, userId, body, locale }) =>
      deliver(
        'follow_published',
        to,
        followPublishedEmail({ body, appUrl: config.appOrigin, locale }),
        { userId },
      ),

    sendFollowAlertCreated: ({ to, userId, body, locale }) =>
      deliver(
        'follow_alert_created',
        to,
        followAlertEmail({ variant: 'created', body, appUrl: config.appOrigin, locale }),
        { userId },
      ),

    sendFollowAlertFired: ({ to, userId, body, locale }) =>
      deliver(
        'follow_alert_fired',
        to,
        followAlertEmail({ variant: 'fired', body, appUrl: config.appOrigin, locale }),
        { userId },
      ),

    sendAlertTriggered: ({ to, userId, symbol, body, locale }) =>
      deliver(
        'alert_triggered',
        to,
        alertTriggeredEmail({ symbol, body, appUrl: config.appOrigin, locale }),
        {
          userId,
        },
      ),

    sendChatMessage: ({ to, userId, actorUsername, locale }) =>
      deliver(
        'chat_message',
        to,
        chatMessageEmail({ actorUsername, appUrl: config.appOrigin, locale }),
        { userId },
      ),
  };
}
