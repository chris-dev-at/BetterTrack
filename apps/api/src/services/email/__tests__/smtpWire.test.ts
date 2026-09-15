import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../../config/env';
import { inviteEmail } from '../templates';
import { createSmtpTransport } from '../transport';

/**
 * Wire-level regression for the Nodemailer 10 upgrade (issue #1889).
 *
 * Every other email test mocks `nodemailer`, so all of them would stay green if
 * a major bump changed what actually goes onto the socket. This one drives the
 * REAL `smtp-transport` against a stub SMTP server built on `node:net` — no new
 * dependency, and no network beyond a loopback listener — and pins the two
 * things a mocked test cannot see: the SMTP envelope (`MAIL FROM` / `RCPT TO`,
 * the addresses Nodemailer derives from `from`/`to` through its address parser)
 * and the message headers its composer emits.
 *
 * The advisories that forced 10.0.9 (GHSA-prgh-xp8r-p3m5, GHSA-g57g-f23g-4646)
 * are both address-parser bugs whose damage shows up in exactly this envelope,
 * which is why the envelope is asserted rather than just "sendMail resolved".
 */

interface StubSmtp {
  port: number;
  /** Every command line the client sent, in order, excluding the DATA payload. */
  readonly commands: string[];
  readonly envelope: { mailFrom: string | null; rcptTo: string[] };
  /** The DATA payload, dot-unstuffed, exactly as it arrived. */
  readonly message: string;
  /** Resolves once the server has accepted the DATA payload. */
  finished: Promise<void>;
  close: () => Promise<void>;
}

/** `MAIL FROM:<a@b>` / `RCPT TO:<a@b> ...` to `a@b` (null when the form is odd). */
function addressOf(line: string): string | null {
  return /<([^>]*)>/.exec(line)?.[1] ?? null;
}

/**
 * The smallest ESMTP dialog that gets a message accepted: a greeting, an EHLO
 * capability list, PLAIN auth, envelope commands, and DATA. STARTTLS is
 * deliberately NOT advertised, so the session stays plaintext on loopback.
 */
async function startStubSmtp(mode: 'accept' | 'refuse' = 'accept'): Promise<StubSmtp> {
  const state = {
    commands: [] as string[],
    envelope: { mailFrom: null as string | null, rcptTo: [] as string[] },
    message: '',
  };
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const CRLF = '\r\n';

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    socket.setEncoding('utf8');
    if (mode === 'refuse') {
      // A server that is up but will not serve this session. Refusing in the
      // greeting keeps the listener bound for the whole test, so nothing here
      // ever dials a just-closed port that another parallel worker could have
      // picked up in the meantime.
      socket.write(`421 4.7.0 Service not available${CRLF}`);
      socket.end();
      return;
    }
    socket.write(`220 stub.bettertrack.test ESMTP stub${CRLF}`);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf(CRLF);
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + CRLF.length);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write(`250 2.0.0 Ok: queued as STUB${CRLF}`);
            resolveFinished();
            continue;
          }
          // RFC 5321 section 4.5.2 dot-stuffing: the client doubled a leading dot.
          state.message += `${line.startsWith('..') ? line.slice(1) : line}${CRLF}`;
          continue;
        }

        state.commands.push(line);
        switch (line.split(' ')[0]?.toUpperCase()) {
          case 'EHLO':
            // Only PLAIN is advertised, so the AUTH exchange is a single
            // deterministic command rather than a LOGIN challenge pair.
            socket.write(
              `250-stub.bettertrack.test${CRLF}250-AUTH PLAIN${CRLF}250 8BITMIME${CRLF}`,
            );
            break;
          case 'HELO':
            socket.write(`250 stub.bettertrack.test${CRLF}`);
            break;
          case 'AUTH':
            socket.write(`235 2.7.0 Authentication successful${CRLF}`);
            break;
          case 'MAIL':
            state.envelope.mailFrom = addressOf(line);
            socket.write(`250 2.1.0 Ok${CRLF}`);
            break;
          case 'RCPT': {
            const rcpt = addressOf(line);
            if (rcpt !== null) state.envelope.rcptTo.push(rcpt);
            socket.write(`250 2.1.5 Ok${CRLF}`);
            break;
          }
          case 'DATA':
            inData = true;
            socket.write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`);
            break;
          case 'QUIT':
            // Not reached today: after a successful send `smtp-transport` calls
            // `connection.close()`, not `.quit()` — the same in 9.x and 10.x.
            // Answering it anyway keeps the stub a correct SMTP server.
            socket.write(`221 2.0.0 Bye${CRLF}`);
            socket.end();
            break;
          default:
            socket.write(`502 5.5.1 Command not implemented${CRLF}`);
            break;
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    get commands() {
      return state.commands;
    },
    get envelope() {
      return state.envelope;
    },
    get message() {
      return state.message;
    },
    finished,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Enough quoted-printable to read an ASCII body back: soft line breaks and the
 * `=` escape are the only transformations the composer applies to this content.
 */
function decodeQuotedPrintable(body: string): string {
  return body.replace(/=\r\n/g, '').replace(/=3D/gi, '=');
}

let stub: StubSmtp | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

describe('SMTP transport over a real socket', () => {
  it('puts the expected envelope and headers on the wire', async () => {
    stub = await startStubSmtp();
    const email: AppConfig['email'] = {
      enabled: true,
      host: '127.0.0.1',
      port: stub.port,
      user: 'smtp-user',
      pass: 'smtp-password',
      from: 'BetterTrack <mail@bettertrack.test>',
    };
    const inviteUrl = 'https://app.bettertrack.test/invites/accept?token=test-token';
    const content = inviteEmail({ inviteUrl });

    const transport = createSmtpTransport(email);
    await transport.send({
      to: 'recipient@example.test',
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
    await stub.finished;

    // Envelope: the addresses the SMTP server is actually told to deliver to.
    expect(stub.envelope.mailFrom).toBe('mail@bettertrack.test');
    expect(stub.envelope.rcptTo).toEqual(['recipient@example.test']);

    // The exact command sequence: handshake, auth, envelope, data — and no
    // QUIT, because `smtp-transport` closes the socket rather than quitting
    // after a successful send. Pinning it exactly is the point of this test: a
    // future upgrade that changes what goes on the wire has to be looked at.
    expect(stub.commands.map((line) => line.split(' ')[0]?.toUpperCase())).toEqual([
      'EHLO',
      'AUTH',
      'MAIL',
      'RCPT',
      'DATA',
    ]);

    // The configured credentials still reach the wire as PLAIN auth
    // (authzid, authcid, password joined by NUL — RFC 4616).
    const auth = stub.commands.find((line) => line.startsWith('AUTH '));
    expect(auth).toBeDefined();
    const decodedAuth = Buffer.from(auth!.split(' ')[2]!, 'base64').toString('utf8');
    expect(decodedAuth.split('\u0000')).toEqual(['', 'smtp-user', 'smtp-password']);

    // Headers: identity, subject and the alternative-body structure.
    expect(stub.message).toContain('From: BetterTrack <mail@bettertrack.test>');
    expect(stub.message).toContain('To: recipient@example.test');
    expect(stub.message).toContain(`Subject: ${content.subject}`);
    expect(stub.message).toContain('MIME-Version: 1.0');
    expect(stub.message).toMatch(/^Message-ID: <[^>]+>\r?$/m);
    expect(stub.message).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(stub.message).toMatch(/^Content-Type: text\/plain; charset=utf-8\r?$/m);
    expect(stub.message).toMatch(/^Content-Type: text\/html; charset=utf-8\r?$/m);

    // Both alternatives carry the invite link the template built, so neither
    // body was dropped or swapped by the composer.
    const decoded = decodeQuotedPrintable(stub.message);
    expect(decoded.split(inviteUrl).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('rejects with a coded error when the server refuses the session', async () => {
    // The seam's contract for `emailService.deliver`: a transport failure is a
    // rejected promise carrying a string `code`, which is the ONLY thing the
    // coarse audit tag (`errorCode`, §6.10) is allowed to keep. Nodemailer 10
    // still classifies a refused greeting as EPROTOCOL, so the tag stays a
    // stable symbol rather than degrading to the Error name.
    stub = await startStubSmtp('refuse');

    const transport = createSmtpTransport({
      enabled: true,
      host: '127.0.0.1',
      port: stub.port,
      user: undefined,
      pass: undefined,
      from: 'BetterTrack <mail@bettertrack.test>',
    });

    await expect(
      transport.send({ to: 'recipient@example.test', subject: 's', html: '<p>h</p>', text: 't' }),
    ).rejects.toMatchObject({ code: 'EPROTOCOL' });
  });
});
