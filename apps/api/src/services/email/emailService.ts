import type { AppConfig } from '../../config/env';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import {
  inviteEmail,
  tempPasswordEmail,
  testEmail,
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
  sendWelcome(params: {
    to: string;
    username: string;
    audit: EmailAuditTarget;
  }): Promise<EmailSendResult>;
  /** Admin diagnostic (PROJECTPLAN.md §6.12): a throwaway "does SMTP work" mail. */
  sendTest(params: { to: string; audit: EmailAuditTarget }): Promise<EmailSendResult>;
}

export interface EmailServiceDeps {
  config: AppConfig;
  logger: Logger;
  audit: AuditService;
  /** Present iff the email channel is wired; null keeps the channel disabled. */
  transport: MailTransport | null;
}

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
  const { config, logger, audit, transport } = deps;
  const enabled = Boolean(config.email.enabled && transport);

  async function deliver(
    kind: 'invite' | 'temp_password' | 'welcome' | 'test',
    to: string,
    content: EmailContent,
    target: EmailAuditTarget,
  ): Promise<EmailSendResult> {
    if (!enabled || !transport) {
      // Channel disabled — the admin-facing response carries the credential.
      logger.debug({ kind, to }, 'email channel disabled; skipping account email');
      return { status: 'skipped' };
    }
    try {
      await transport.send({
        to,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      logger.info({ kind, to }, 'account email sent');
      return { status: 'sent' };
    } catch (err) {
      const code = errorCode(err);
      // Log + audit the failure without the body or any secret material. The
      // flow has already committed; this never throws back to the caller.
      logger.warn({ kind, to, code }, 'account email failed to send');
      await audit.record({
        actorId: target.actorId ?? null,
        action: AuditAction.EmailSendFailed,
        targetType: target.targetType,
        targetId: target.targetId,
        ip: target.ip ?? null,
        meta: { kind, code },
      });
      return { status: 'failed', code };
    }
  }

  return {
    enabled,

    sendInvite: ({ to, inviteUrl, audit: target }) =>
      deliver('invite', to, inviteEmail({ inviteUrl }), target),

    sendTempPassword: ({ to, username, tempPassword, reason, audit: target }) =>
      deliver(
        'temp_password',
        to,
        tempPasswordEmail({ username, tempPassword, reason, loginUrl: config.appOrigin }),
        target,
      ),

    sendWelcome: ({ to, username, audit: target }) =>
      deliver('welcome', to, welcomeEmail({ username, appUrl: config.appOrigin }), target),

    sendTest: ({ to, audit: target }) =>
      deliver('test', to, testEmail({ appUrl: config.appOrigin }), target),
  };
}
