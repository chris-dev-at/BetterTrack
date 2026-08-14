import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../../config/env';
import type { EmailLogRepository } from '../../../data/repositories/emailLogRepository';
import type { Logger } from '../../../logger';
import type { AuditService } from '../../audit/auditService';
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
});
