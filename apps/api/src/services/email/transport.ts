import nodemailer from 'nodemailer';

import type { AppConfig } from '../../config/env';

/**
 * Minimal transport seam over Nodemailer (PROJECTPLAN.md §6.11). Keeping the
 * surface this small lets tests inject a fake that records or throws without
 * pulling in a real SMTP connection.
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>;
}

/**
 * Builds a real SMTP transport from validated config. Only called when the
 * email channel is enabled (SMTP_HOST + SMTP_FROM present), so `from` and
 * `host` are guaranteed here.
 */
export function createSmtpTransport(email: AppConfig['email']): MailTransport {
  const port = email.port ?? 587;
  const transporter = nodemailer.createTransport({
    host: email.host,
    port,
    // 465 is implicit TLS; everything else negotiates STARTTLS.
    secure: port === 465,
    auth: email.user ? { user: email.user, pass: email.pass } : undefined,
  });

  const from = email.from as string;
  return {
    async send(mail) {
      await transporter.sendMail({ from, ...mail });
    },
  };
}
