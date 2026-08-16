import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../../config/env';
import type { EmailLogRepository } from '../../../data/repositories/emailLogRepository';
import type { Logger } from '../../../logger';
import { AuditAction, type AuditService } from '../../audit/auditService';
import { createEmailService } from '../emailService';
import { inviteEmail } from '../templates';
import { createSmtpTransport } from '../transport';

const smtp = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: smtp.createTransport,
  },
}));

const emailConfig: AppConfig['email'] = {
  enabled: true,
  host: 'smtp.bettertrack.test',
  port: 465,
  user: 'smtp-user',
  pass: 'smtp-password',
  from: 'BetterTrack <mail@bettertrack.test>',
};

const config = {
  appOrigin: 'https://app.bettertrack.test',
  email: emailConfig,
} as AppConfig;

const emailLogInsert = vi.fn();
const auditRecord = vi.fn();
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;
const emailLog = { insert: emailLogInsert } as unknown as EmailLogRepository;
const audit = { record: auditRecord } as unknown as AuditService;

describe('SMTP transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    smtp.sendMail.mockResolvedValue({ messageId: 'smtp-message-id' });
    smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
    emailLogInsert.mockResolvedValue(undefined);
    auditRecord.mockResolvedValue(undefined);
  });

  it('builds the configured SMTP client and sends invite template content to its recipient', async () => {
    const transport = createSmtpTransport(emailConfig);
    const service = createEmailService({ config, logger, audit, emailLog, transport });
    const inviteUrl = 'https://app.bettertrack.test/invites/accept?token=test-token';
    const content = inviteEmail({ inviteUrl });

    await expect(
      service.sendInvite({
        to: 'recipient@example.test',
        inviteUrl,
        audit: { targetType: 'invite', targetId: 'invite-1' },
      }),
    ).resolves.toEqual({ status: 'sent' });

    expect(smtp.createTransport).toHaveBeenCalledOnce();
    expect(smtp.createTransport).toHaveBeenCalledWith({
      host: 'smtp.bettertrack.test',
      port: 465,
      secure: true,
      auth: { user: 'smtp-user', pass: 'smtp-password' },
    });
    expect(smtp.sendMail).toHaveBeenCalledOnce();
    expect(smtp.sendMail).toHaveBeenCalledWith({
      from: 'BetterTrack <mail@bettertrack.test>',
      to: 'recipient@example.test',
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  });

  it('uses the default STARTTLS port when no SMTP port is configured', () => {
    createSmtpTransport({ ...emailConfig, port: undefined });

    expect(smtp.createTransport).toHaveBeenCalledOnce();
    expect(smtp.createTransport).toHaveBeenCalledWith({
      host: 'smtp.bettertrack.test',
      port: 587,
      secure: false,
      auth: { user: 'smtp-user', pass: 'smtp-password' },
    });
  });

  it('omits SMTP auth when no SMTP user is configured', () => {
    createSmtpTransport({ ...emailConfig, user: undefined });

    expect(smtp.createTransport).toHaveBeenCalledOnce();
    expect(smtp.createTransport).toHaveBeenCalledWith({
      host: 'smtp.bettertrack.test',
      port: 465,
      secure: true,
      auth: undefined,
    });
  });

  it('records and audits an SMTP send failure without throwing to the caller', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    smtp.sendMail.mockRejectedValue(error);
    const transport = createSmtpTransport(emailConfig);
    const service = createEmailService({ config, logger, audit, emailLog, transport });
    const inviteUrl = 'https://app.bettertrack.test/invites/accept?token=test-token';
    const content = inviteEmail({ inviteUrl });

    await expect(
      service.sendInvite({
        to: 'recipient@example.test',
        inviteUrl,
        audit: { targetType: 'invite', targetId: 'invite-1' },
      }),
    ).resolves.toEqual({ status: 'failed', code: 'ECONNREFUSED' });

    expect(emailLogInsert).toHaveBeenCalledOnce();
    expect(emailLogInsert).toHaveBeenCalledWith({
      userId: null,
      recipient: 'recipient@example.test',
      template: 'invite',
      subject: content.subject,
      status: 'failed',
      errorCode: 'ECONNREFUSED',
    });
    expect(auditRecord).toHaveBeenCalledOnce();
    expect(auditRecord).toHaveBeenCalledWith({
      actorId: null,
      action: AuditAction.EmailSendFailed,
      targetType: 'invite',
      targetId: 'invite-1',
      ip: null,
      meta: { kind: 'invite', code: 'ECONNREFUSED' },
    });
  });

  it('uses an Error name when an SMTP send failure has no code', async () => {
    const error = new TypeError('SMTP connection failed');
    smtp.sendMail.mockRejectedValue(error);
    const transport = createSmtpTransport(emailConfig);
    const service = createEmailService({ config, logger, audit, emailLog, transport });
    const inviteUrl = 'https://app.bettertrack.test/invites/accept?token=test-token';
    const content = inviteEmail({ inviteUrl });

    await expect(
      service.sendInvite({
        to: 'recipient@example.test',
        inviteUrl,
        audit: { targetType: 'invite', targetId: 'invite-1' },
      }),
    ).resolves.toEqual({ status: 'failed', code: error.name });

    expect(emailLogInsert).toHaveBeenCalledOnce();
    expect(emailLogInsert).toHaveBeenCalledWith({
      userId: null,
      recipient: 'recipient@example.test',
      template: 'invite',
      subject: content.subject,
      status: 'failed',
      errorCode: error.name,
    });
    expect(auditRecord).toHaveBeenCalledOnce();
    expect(auditRecord).toHaveBeenCalledWith({
      actorId: null,
      action: AuditAction.EmailSendFailed,
      targetType: 'invite',
      targetId: 'invite-1',
      ip: null,
      meta: { kind: 'invite', code: error.name },
    });
  });

  it('uses UNKNOWN when an SMTP send failure has no code or usable name', async () => {
    smtp.sendMail.mockRejectedValue({});
    const transport = createSmtpTransport(emailConfig);
    const service = createEmailService({ config, logger, audit, emailLog, transport });
    const inviteUrl = 'https://app.bettertrack.test/invites/accept?token=test-token';
    const content = inviteEmail({ inviteUrl });

    await expect(
      service.sendInvite({
        to: 'recipient@example.test',
        inviteUrl,
        audit: { targetType: 'invite', targetId: 'invite-1' },
      }),
    ).resolves.toEqual({ status: 'failed', code: 'UNKNOWN' });

    expect(emailLogInsert).toHaveBeenCalledOnce();
    expect(emailLogInsert).toHaveBeenCalledWith({
      userId: null,
      recipient: 'recipient@example.test',
      template: 'invite',
      subject: content.subject,
      status: 'failed',
      errorCode: 'UNKNOWN',
    });
    expect(auditRecord).toHaveBeenCalledOnce();
    expect(auditRecord).toHaveBeenCalledWith({
      actorId: null,
      action: AuditAction.EmailSendFailed,
      targetType: 'invite',
      targetId: 'invite-1',
      ip: null,
      meta: { kind: 'invite', code: 'UNKNOWN' },
    });
  });
});
