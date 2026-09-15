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
  // 465 is implicit TLS: the socket is encrypted before the greeting, so there
  // is no plaintext phase to protect.
  const secure = port === 465;
  const transporter = nodemailer.createTransport({
    host: email.host,
    port,
    secure,
    // Every other port starts in the clear and upgrades. `smtp-connection` only
    // issues STARTTLS when the server ADVERTISES it in the EHLO capabilities,
    // so a hostile relay — or anyone on the path who can rewrite that plaintext
    // reply — strips the capability and the client walks on and sends
    // `AUTH PLAIN <base64 SMTP_USER NUL SMTP_PASS>` over the open socket.
    // `requireTLS` removes the server's vote: STARTTLS is sent regardless, and
    // a server that will not upgrade fails the send with ETLS before the
    // authentication phase is ever reached. Pinned on the wire in
    // `__tests__/smtpWire.test.ts`.
    requireTLS: !secure,
    // The composer resolves an `html`/`text` body supplied as `{ path }` or
    // `{ href }`, and `{ path }`/`{ href }` attachments, off the local
    // filesystem or over the network, as the process, at DATA time.
    // `OutgoingMail` is four plain strings today, so nothing reachable can ask
    // for either — but three of Nodemailer's published advisories are bypasses
    // of exactly these two flags, and the cost of a future caller widening
    // `OutgoingMail` is an arbitrary-file-read / SSRF primitive reachable from
    // whatever builds the mail. Closing both here makes that a rejected send
    // instead: the file is never opened and the URL is never fetched (§10
    // defence in depth).
    disableFileAccess: true,
    disableUrlAccess: true,
    auth: email.user ? { user: email.user, pass: email.pass } : undefined,
  });

  const from = email.from as string;
  return {
    async send(mail) {
      await transporter.sendMail({ from, ...mail });
    },
  };
}
