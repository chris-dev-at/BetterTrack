import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../../config/env';
import { inviteEmail } from '../templates';
import { createSmtpTransport, type MailTransport, type OutgoingMail } from '../transport';

import { selfSignedLoopbackCert } from './selfSignedCert';

/**
 * Wire-level regression for the Nodemailer 10 upgrade (issue #1889) and for the
 * transport hardening in #1931.
 *
 * Every other email test mocks `nodemailer`, so all of them would stay green if
 * a major bump changed what actually goes onto the socket. This one drives the
 * REAL `smtp-transport` against a stub SMTP server built on `node:net` — no new
 * dependency, and no network beyond a loopback listener — and pins what a
 * mocked test cannot see:
 *
 *  - the SMTP envelope (`MAIL FROM` / `RCPT TO`, the addresses Nodemailer
 *    derives from `from`/`to` through its address parser) and the headers its
 *    composer emits. The advisories that forced 10.0.9 (GHSA-prgh-xp8r-p3m5,
 *    GHSA-g57g-f23g-4646) are both address-parser bugs whose damage shows up in
 *    exactly this envelope;
 *  - that the session is upgraded to TLS BEFORE the credentials are sent, and
 *    that a server which will not upgrade never sees them at all (`requireTLS`);
 *  - that a `path` attachment is never read off disk and an `href` attachment is
 *    never fetched (`disableFileAccess` / `disableUrlAccess`).
 *
 * The stub completes a real STARTTLS upgrade with a certificate generated in
 * `selfSignedCert.ts`. The client is made to trust it by `withStubCaTrusted`,
 * which is the only thing about the handshake the test changes — Node still
 * verifies the chain and the 127.0.0.1 SAN, and the shim asserts the transport
 * never asked for `rejectUnauthorized: false`.
 */

const STUB_CERT = selfSignedLoopbackCert();

/** One command line as the stub saw it, with the channel it arrived on. */
interface WireCommand {
  line: string;
  /** True once the session has been upgraded — i.e. this line was encrypted. */
  secure: boolean;
}

type StubMode = 'accept' | 'refuse' | 'no-starttls';

interface StubSmtp {
  port: number;
  /** Every command line the client sent, in order, excluding the DATA payload. */
  readonly commands: readonly WireCommand[];
  readonly envelope: { mailFrom: string | null; rcptTo: string[] };
  /** The DATA payload, dot-unstuffed, exactly as it arrived (may be partial). */
  readonly message: string;
  /** True once the server has answered the terminating `.` with a 250. */
  readonly accepted: boolean;
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
 * capability list, a STARTTLS upgrade, PLAIN auth, envelope commands, and DATA.
 *
 * `mode`:
 *  - `accept` advertises STARTTLS and upgrades the socket, then accepts;
 *  - `no-starttls` advertises AUTH PLAIN but no STARTTLS, and answers the
 *    STARTTLS verb with a 502 — the downgrade a hostile relay or an on-path
 *    attacker offers, since the capability list is plaintext and unauthenticated;
 *  - `refuse` is a server that is up but will not serve this session.
 */
async function startStubSmtp(mode: StubMode = 'accept'): Promise<StubSmtp> {
  const state = {
    commands: [] as WireCommand[],
    envelope: { mailFrom: null as string | null, rcptTo: [] as string[] },
    message: '',
    accepted: false,
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
    if (mode === 'refuse') {
      // Refusing in the greeting keeps the listener bound for the whole test, so
      // nothing here ever dials a just-closed port that another parallel worker
      // could have picked up in the meantime.
      socket.write(`421 4.7.0 Service not available${CRLF}`);
      socket.end();
      return;
    }

    let secure = false;

    /**
     * Drives the dialog on one channel. Called again with the TLS socket after
     * the upgrade, which gives the encrypted session a fresh line buffer —
     * RFC 3207 section 4.2: the server discards anything buffered before the
     * handshake rather than carrying it across.
     */
    const serve = (channel: net.Socket): void => {
      let buffer = '';
      let inData = false;
      channel.setEncoding('utf8');
      channel.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf(CRLF);
          if (end === -1) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + CRLF.length);

          if (inData) {
            if (line === '.') {
              inData = false;
              state.accepted = true;
              channel.write(`250 2.0.0 Ok: queued as STUB${CRLF}`);
              resolveFinished();
              continue;
            }
            // RFC 5321 section 4.5.2 dot-stuffing: the client doubled a leading dot.
            state.message += `${line.startsWith('..') ? line.slice(1) : line}${CRLF}`;
            continue;
          }

          state.commands.push({ line, secure });
          switch (line.split(' ')[0]?.toUpperCase()) {
            case 'EHLO': {
              // Only PLAIN is advertised, so the AUTH exchange is a single
              // deterministic command rather than a LOGIN challenge pair.
              const startTls = mode === 'accept' && !secure ? `250-STARTTLS${CRLF}` : '';
              channel.write(
                `250-stub.bettertrack.test${CRLF}${startTls}250-AUTH PLAIN${CRLF}250 8BITMIME${CRLF}`,
              );
              break;
            }
            case 'HELO':
              channel.write(`250 stub.bettertrack.test${CRLF}`);
              break;
            case 'STARTTLS': {
              if (mode !== 'accept') {
                // What a server without the extension answers. The client asked
                // anyway, which is the whole point of `requireTLS`.
                channel.write(`502 5.5.1 Command not implemented${CRLF}`);
                break;
              }
              channel.write(`220 2.0.0 Ready to start TLS${CRLF}`);
              channel.removeAllListeners('data');
              secure = true;
              const upgraded = new tls.TLSSocket(channel, {
                isServer: true,
                key: STUB_CERT.key,
                cert: STUB_CERT.cert,
              });
              // A client that walks away mid-handshake must not crash the listener.
              upgraded.on('error', () => {});
              serve(upgraded);
              break;
            }
            case 'AUTH':
              channel.write(`235 2.7.0 Authentication successful${CRLF}`);
              break;
            case 'MAIL':
              state.envelope.mailFrom = addressOf(line);
              channel.write(`250 2.1.0 Ok${CRLF}`);
              break;
            case 'RCPT': {
              const rcpt = addressOf(line);
              if (rcpt !== null) state.envelope.rcptTo.push(rcpt);
              channel.write(`250 2.1.5 Ok${CRLF}`);
              break;
            }
            case 'DATA':
              inData = true;
              channel.write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`);
              break;
            case 'QUIT':
              // Not reached today: after a successful send `smtp-transport` calls
              // `connection.close()`, not `.quit()` — the same in 9.x and 10.x.
              // Answering it anyway keeps the stub a correct SMTP server.
              channel.write(`221 2.0.0 Bye${CRLF}`);
              channel.end();
              break;
            default:
              channel.write(`502 5.5.1 Command not implemented${CRLF}`);
              break;
          }
        }
      });
    };

    socket.write(`220 stub.bettertrack.test ESMTP stub${CRLF}`);
    serve(socket);
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
    get accepted() {
      return state.accepted;
    },
    finished,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

type TlsConnect = (options: tls.ConnectionOptions, listener?: () => void) => tls.TLSSocket;

/**
 * Runs `body` with the stub's throwaway certificate added as a trust anchor.
 *
 * The transport deliberately exposes no TLS knobs, so there is no supported way
 * to hand it a CA — and adding one for a test would put a production seam where
 * none should be. Instead the CA is injected at the single call Nodemailer makes
 * (`smtp-connection` upgrades with `tls.connect(opts, cb)`), and nothing else
 * about the options is touched: Node still verifies the signature, the validity
 * window and the 127.0.0.1 SAN. The shim also records the options, so the test
 * can assert the transport never turned verification off itself.
 */
async function withStubCaTrusted<T>(
  body: (seen: tls.ConnectionOptions[]) => Promise<T>,
): Promise<T> {
  const target = tls as unknown as { connect: TlsConnect };
  const real = target.connect;
  const seen: tls.ConnectionOptions[] = [];
  target.connect = (options, listener) => {
    seen.push(options);
    return real({ ...options, ca: [STUB_CERT.cert] }, listener);
  };
  try {
    return await body(seen);
  } finally {
    target.connect = real;
  }
}

/**
 * Enough quoted-printable to read an ASCII body back: soft line breaks and the
 * `=` escape are the only transformations the composer applies to this content.
 */
function decodeQuotedPrintable(body: string): string {
  return body.replace(/=\r\n/g, '').replace(/=3D/gi, '=');
}

function transportFor(port: number, auth = true): MailTransport {
  const email: AppConfig['email'] = {
    enabled: true,
    host: '127.0.0.1',
    port,
    user: auth ? 'smtp-user' : undefined,
    pass: auth ? 'smtp-password' : undefined,
    from: 'BetterTrack <mail@bettertrack.test>',
  };
  return createSmtpTransport(email);
}

/**
 * `OutgoingMail` is four plain strings, so no caller can ask the composer for a
 * file or a URL today — which is exactly why the guarantee has to be pinned
 * rather than assumed. This is the future caller that widens the seam: `send`
 * spreads whatever it is handed straight into `sendMail`.
 */
function mailWithAttachment(attachment: Record<string, string>): OutgoingMail {
  const mail: OutgoingMail & { attachments: Record<string, string>[] } = {
    to: 'recipient@example.test',
    subject: 'attachment probe',
    html: '<p>h</p>',
    text: 't',
    attachments: [attachment],
  };
  return mail;
}

/** The AUTH PLAIN payload, decoded: authzid, authcid, password joined by NUL (RFC 4616). */
const PLAIN_AUTH_SECRET = ['', 'smtp-user', 'smtp-password'].join('\u0000');

let stub: StubSmtp | null = null;
let scratchDir: string | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = null;
});

describe('SMTP transport over a real socket', () => {
  it('upgrades to TLS before authenticating, then puts the expected envelope and headers on the wire', async () => {
    stub = await startStubSmtp();
    const inviteUrl = 'https://app.bettertrack.test/invites/accept?token=test-token';
    const content = inviteEmail({ inviteUrl });

    const tlsOptions = await withStubCaTrusted(async (seen) => {
      const transport = transportFor(stub!.port);
      await transport.send({
        to: 'recipient@example.test',
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      await stub!.finished;
      return seen;
    });

    // The exact command sequence: handshake, STARTTLS, a second EHLO inside the
    // tunnel, auth, envelope, data — and no QUIT, because `smtp-transport`
    // closes the socket rather than quitting after a successful send. Pinning it
    // exactly is the point of this test: a future upgrade that changes what goes
    // on the wire has to be looked at.
    expect(stub.commands.map((cmd) => cmd.line.split(' ')[0]?.toUpperCase())).toEqual([
      'EHLO',
      'STARTTLS',
      'EHLO',
      'AUTH',
      'MAIL',
      'RCPT',
      'DATA',
    ]);

    // …and the half of it that matters for #1931: everything from the second
    // EHLO onwards arrived encrypted. Only the pre-upgrade handshake is
    // plaintext, and it carries no secret.
    expect(stub.commands.map((cmd) => cmd.secure)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);

    // The configured credentials still reach the wire as PLAIN auth — but now
    // only inside the tunnel. The stub is a deliberately naive server: it
    // advertises AUTH PLAIN before the upgrade too, and a transport without
    // `requireTLS` would take it.
    const auth = stub.commands.find((cmd) => cmd.line.startsWith('AUTH '));
    expect(auth).toBeDefined();
    expect(auth!.secure).toBe(true);
    const decodedAuth = Buffer.from(auth!.line.split(' ')[2]!, 'base64').toString('utf8');
    expect(decodedAuth).toBe(PLAIN_AUTH_SECRET);

    // The transport hands Node a plain verified handshake: the shim adds a CA
    // and nothing else, so a transport that had switched verification off would
    // show up here rather than quietly passing.
    expect(tlsOptions).toHaveLength(1);
    expect(tlsOptions[0]!.rejectUnauthorized).toBeUndefined();

    // Envelope: the addresses the SMTP server is actually told to deliver to.
    expect(stub.envelope.mailFrom).toBe('mail@bettertrack.test');
    expect(stub.envelope.rcptTo).toEqual(['recipient@example.test']);

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

  it('never sends the credentials to a server that will not start TLS', async () => {
    // The downgrade `requireTLS` exists to refuse: the EHLO capability list is
    // plaintext and unauthenticated, so a relay — or anyone on the path — can
    // simply drop STARTTLS from it. Without the flag `smtp-connection` takes the
    // server's word for it and sends `AUTH PLAIN <base64 user NUL pass>` in the
    // clear; with it the client asks for the upgrade regardless and gives up
    // when it is refused, before the authentication phase.
    stub = await startStubSmtp('no-starttls');

    await expect(
      transportFor(stub.port).send({
        to: 'recipient@example.test',
        subject: 's',
        html: '<p>h</p>',
        text: 't',
      }),
    ).rejects.toMatchObject({ code: 'ETLS' });

    const verbs = stub.commands.map((cmd) => cmd.line.split(' ')[0]?.toUpperCase());
    expect(verbs).toEqual(['EHLO', 'STARTTLS']);
    expect(verbs).not.toContain('AUTH');
    // Nothing that reached this server carries the password, in any encoding.
    const wire = stub.commands.map((cmd) => cmd.line).join('\n');
    expect(wire).not.toContain('smtp-password');
    expect(wire).not.toContain(Buffer.from(PLAIN_AUTH_SECRET, 'utf8').toString('base64'));
    expect(stub.accepted).toBe(false);
  });

  it('rejects with a coded error when the server refuses the session', async () => {
    // The seam's contract for `emailService.deliver`: a transport failure is a
    // rejected promise carrying a string `code`, which is the ONLY thing the
    // coarse audit tag (`errorCode`, §6.10) is allowed to keep. Nodemailer 10
    // still classifies a refused greeting as EPROTOCOL, so the tag stays a
    // stable symbol rather than degrading to the Error name.
    stub = await startStubSmtp('refuse');

    await expect(
      transportFor(stub.port, false).send({
        to: 'recipient@example.test',
        subject: 's',
        html: '<p>h</p>',
        text: 't',
      }),
    ).rejects.toMatchObject({ code: 'EPROTOCOL' });
  });

  it('refuses a filesystem attachment and never opens the file', async () => {
    // The issue's example is `{ path: '/etc/hostname' }`; a scratch file with a
    // marker is used instead so the test can prove the stronger half — that the
    // bytes never travelled. On a host without /etc/hostname (macOS) "not read"
    // would be vacuously true, and the red run would show ENOENT rather than the
    // exfiltration the flag exists to stop.
    scratchDir = mkdtempSync(path.join(tmpdir(), 'bt-smtp-wire-'));
    const secretPath = path.join(scratchDir, 'secret.txt');
    const marker = `BT-FILE-MARKER-${randomBytes(8).toString('hex')}`;
    writeFileSync(secretPath, `${marker}\n`);

    stub = await startStubSmtp();
    await withStubCaTrusted(async () => {
      await expect(
        transportFor(stub!.port).send(mailWithAttachment({ path: secretPath })),
      ).rejects.toMatchObject({
        code: 'ESTREAM',
        message: `File access rejected for ${secretPath}`,
      });
    });

    // Nodemailer resolves attachment content lazily, while streaming DATA, so
    // the refusal lands mid-payload rather than before the dial — see the PR for
    // why "nothing dialled" is not what the flag buys. What it does buy is the
    // part that matters: the file is never opened, the message is never
    // completed, and the server never accepts it.
    expect(stub.accepted).toBe(false);
    expect(stub.message).not.toContain(marker);
    expect(stub.message).not.toContain(Buffer.from(`${marker}\n`, 'utf8').toString('base64'));
  });

  it('refuses a URL attachment and never dials it', async () => {
    // The issue's example is `http://127.0.0.1:1/x`, which cannot tell "refused
    // by the flag" apart from "connection refused". A real listener can: it
    // counts the requests that reach it, and with the flag off it serves one.
    const requests: string[] = [];
    const marker = `BT-URL-MARKER-${randomBytes(8).toString('hex')}`;
    const origin = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end(marker);
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const href = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/x`;

    try {
      stub = await startStubSmtp();
      await withStubCaTrusted(async () => {
        await expect(
          transportFor(stub!.port).send(mailWithAttachment({ href })),
        ).rejects.toMatchObject({ code: 'ESTREAM', message: `Url access rejected for ${href}` });
      });

      // The SSRF primitive this closes: without the flag the composer fetches
      // the URL as the API process — behind whatever the API can reach — and
      // mails the answer out.
      expect(requests).toEqual([]);
      expect(stub.accepted).toBe(false);
      expect(stub.message).not.toContain(Buffer.from(marker, 'utf8').toString('base64'));
    } finally {
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });
});
