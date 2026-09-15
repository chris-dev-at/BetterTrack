import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A throwaway self-signed certificate for 127.0.0.1, generated at test time.
 *
 * `smtpWire.test.ts` drives the REAL Nodemailer SMTP transport, and since the
 * transport now sets `requireTLS`, the stub server has to complete an actual
 * STARTTLS upgrade or the happy path cannot run at all. That needs a key pair
 * AND a certificate; `node:crypto` generates the first but has no API for the
 * second (`X509Certificate` only parses), so the ~70 lines below encode the
 * minimal X.509 v3 structure by hand. No new dependency and no checked-in key
 * material — the certificate lives for the length of one test file, and is only
 * ever trusted through the narrow shim in that file.
 *
 * The subjectAltName is the IP 127.0.0.1 rather than a DNS name on purpose:
 * `smtp-connection` sets no SNI servername for an IP host, so Node's default
 * `checkServerIdentity` matches the connect host against the IP SANs. Anything
 * else and the handshake would fail verification — which is the property the
 * test wants kept on.
 */
export interface SelfSignedCert {
  /** PKCS#8 PEM private key for the stub server. */
  key: string;
  /** PEM certificate — the stub's identity and, for the client, its trust anchor. */
  cert: string;
}

// ── Minimal DER writer ──

function derLength(byteLength: number): Buffer {
  if (byteLength < 0x80) return Buffer.from([byteLength]);
  const bytes: number[] = [];
  for (let rest = byteLength; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tagged = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);

const sequence = (...items: Buffer[]): Buffer => tagged(0x30, Buffer.concat(items));
const setOf = (...items: Buffer[]): Buffer => tagged(0x31, Buffer.concat(items));
// DER INTEGER is signed: a leading byte with the high bit set needs a 0x00 pad.
const integer = (value: Buffer): Buffer =>
  tagged(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const boolean = (value: boolean): Buffer => tagged(0x01, Buffer.from([value ? 0xff : 0x00]));
const octetString = (value: Buffer): Buffer => tagged(0x04, value);
// The leading 0x00 is the "unused bits in the final byte" count.
const bitString = (value: Buffer): Buffer => tagged(0x03, Buffer.concat([Buffer.from([0]), value]));
const utf8String = (value: string): Buffer => tagged(0x0c, Buffer.from(value, 'utf8'));
const explicit = (index: number, body: Buffer): Buffer => tagged(0xa0 | index, body);
const NULL = Buffer.from([0x05, 0x00]);

function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const bytes = [40 * arcs[0]! + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const base128 = [arc % 128];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
      base128.unshift((rest % 128) | 0x80);
    }
    bytes.push(...base128);
  }
  return tagged(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tagged(0x17, Buffer.from(stamp, 'ascii'));
}

const extension = (oid: string, critical: boolean, value: Buffer): Buffer =>
  sequence(objectIdentifier(oid), ...(critical ? [boolean(true)] : []), octetString(value));

export function selfSignedLoopbackCert(): SelfSignedCert {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // `spki` is already a complete SubjectPublicKeyInfo, so it drops into the
  // TBSCertificate verbatim.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const sha256WithRsa = sequence(objectIdentifier('1.2.840.113549.1.1.11'), NULL);
  const name = sequence(
    setOf(sequence(objectIdentifier('2.5.4.3'), utf8String('bettertrack-smtp-stub'))),
  );
  const now = Date.now();
  // A day either side, not an hour: the notBefore has to absorb whatever clock
  // skew the host carries, or a slightly fast machine fails the handshake with
  // CERT_NOT_YET_VALID and turns the whole wire suite red for no reason.
  const day = 24 * 60 * 60 * 1000;

  const tbsCertificate = sequence(
    explicit(0, integer(Buffer.from([2]))), // version v3
    integer(randomBytes(8)), // serialNumber
    sha256WithRsa,
    name, // issuer == subject: self-signed
    sequence(utcTime(new Date(now - day)), utcTime(new Date(now + day))),
    name,
    spki,
    explicit(
      3,
      sequence(
        // basicConstraints CA:TRUE — the certificate is its own trust anchor, so
        // OpenSSL has to accept it as the root of the (one-element) chain.
        extension('2.5.29.19', true, sequence(boolean(true))),
        // keyUsage: digitalSignature | keyEncipherment | keyCertSign.
        extension('2.5.29.15', true, tagged(0x03, Buffer.from([2, 0xa4]))),
        // subjectAltName: iPAddress 127.0.0.1 (GeneralName [7] IMPLICIT).
        extension('2.5.29.17', false, sequence(tagged(0x87, Buffer.from([127, 0, 0, 1])))),
      ),
    ),
  );

  const certificate = sequence(
    tbsCertificate,
    sha256WithRsa,
    bitString(sign('sha256', tbsCertificate, privateKey)),
  );
  const base64 = certificate
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '');

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
  };
}
