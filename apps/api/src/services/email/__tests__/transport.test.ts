import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../../config/env';
import { testEmail } from '../templates';
import { createSmtpTransport } from '../transport';

const SMTP_CONFIG: AppConfig['email'] = {
  enabled: true,
  host: 'smtp.test.local',
  port: 587,
  user: 'mailer',
  pass: 'smtp-test-password',
  from: 'BetterTrack <no-reply@test.local>',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSmtpTransport', () => {
  it('constructs an authenticated STARTTLS transport and sends a rendered email envelope', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const createTransport = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const rendered = testEmail({ appUrl: 'https://bettertrack.test' });

    const transport = createSmtpTransport(SMTP_CONFIG);
    await transport.send({ to: 'admin@bettertrack.test', ...rendered });

    expect(createTransport).toHaveBeenCalledOnce();
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.test.local',
      port: 587,
      secure: false,
      auth: { user: 'mailer', pass: 'smtp-test-password' },
    });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledWith({
      from: 'BetterTrack <no-reply@test.local>',
      to: 'admin@bettertrack.test',
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  });

  it('uses implicit TLS for port 465 and leaves authentication unset without credentials', () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const createTransport = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);

    createSmtpTransport({ ...SMTP_CONFIG, port: 465, user: undefined, pass: undefined });

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.test.local',
      port: 465,
      secure: true,
      auth: undefined,
    });
  });
});
