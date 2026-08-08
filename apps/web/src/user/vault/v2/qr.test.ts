import { VAULT2_QR_TTL_MS } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildVaultQrPayload,
  generateQrPin,
  isValidQrPin,
  parseVaultQrPayload,
  unwrapVaultQrPayload,
  VAULT2_QR_PREFIX,
} from './qr';
import { deterministicBytes, fastDeps, FIXTURE_PASSPHRASE, FIXTURE_VAULT_ID } from './testSupport';

const PIN = '042195';

function build(overrides: Partial<Parameters<typeof buildVaultQrPayload>[0]> = {}) {
  return buildVaultQrPayload({
    vaultId: FIXTURE_VAULT_ID,
    name: 'Drive vault',
    passphrase: FIXTURE_PASSPHRASE,
    pin: PIN,
    randomBytes: deterministicBytes(5),
    deps: fastDeps,
    ...overrides,
  });
}

describe('vault QR payload (r2 §10)', () => {
  it('emits exactly the contract member order and prefix', async () => {
    const payload = await build();

    expect(payload.startsWith(`${VAULT2_QR_PREFIX}{"qr":1,`)).toBe(true);
    expect(payload.indexOf('"qr":1')).toBeLessThan(payload.indexOf('"vaultId"'));
    expect(payload.indexOf('"vaultId"')).toBeLessThan(payload.indexOf('"name"'));
    expect(payload.indexOf('"name"')).toBeLessThan(payload.indexOf('"w"'));
    expect(payload).toContain(`"vaultId":"${FIXTURE_VAULT_ID}"`);
    expect(payload).toContain('"name":"Drive vault"');
    // The version member is `qr`, never `v` (r2 §9).
    expect(payload).not.toContain('"v":');
  });

  it('NEVER contains the passphrase — a photo of the code is useless', async () => {
    const payload = await build();
    expect(payload).not.toContain(FIXTURE_PASSPHRASE);
    for (const word of FIXTURE_PASSPHRASE.split(' ')) {
      expect(payload).not.toContain(`"${word}`);
    }
    expect(payload).not.toContain(PIN);
  });

  it('round-trips only with the right PIN', async () => {
    const payload = await build();
    const parsed = parseVaultQrPayload(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    await expect(unwrapVaultQrPayload(parsed.payload, PIN, fastDeps)).resolves.toEqual({
      ok: true,
      passphrase: FIXTURE_PASSPHRASE,
    });
    await expect(unwrapVaultQrPayload(parsed.payload, '000000', fastDeps)).resolves.toEqual({
      ok: false,
      reason: 'pin-wrong',
    });
  });

  it('binds the wrap to its vault id, so `w` cannot be spliced onto another code', async () => {
    const payload = await build();
    const parsed = parseVaultQrPayload(payload);
    if (!parsed.ok) throw new Error('expected a parsable payload');

    const spliced = { ...parsed.payload, vaultId: '9f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a09' };
    await expect(unwrapVaultQrPayload(spliced, PIN, fastDeps)).resolves.toEqual({
      ok: false,
      reason: 'pin-wrong',
    });
  });

  it('normalizes the phrase so a scan and a manual unlock derive the same key', async () => {
    const payload = await build({
      name: '  Drive vault  ',
      passphrase: `  ${FIXTURE_PASSPHRASE.toUpperCase().replace(/ /gu, '  ')} `,
    });
    expect(payload).toContain('"name":"Drive vault"');
    const parsed = parseVaultQrPayload(payload);
    if (!parsed.ok) throw new Error('expected a parsable payload');
    await expect(unwrapVaultQrPayload(parsed.payload, PIN, fastDeps)).resolves.toEqual({
      ok: true,
      passphrase: FIXTURE_PASSPHRASE,
    });
  });

  it('escapes a name that would otherwise break the payload', async () => {
    const payload = await build({ name: 'He said "hi"\\' });
    expect(parseVaultQrPayload(payload)).toMatchObject({
      ok: true,
      payload: { name: 'He said "hi"\\' },
    });
  });

  it('never throws on hostile scanner input and names each failure', () => {
    expect(parseVaultQrPayload('https://example.com')).toEqual({ ok: false, reason: 'prefix' });
    expect(parseVaultQrPayload('btvault1:{oops')).toEqual({ ok: false, reason: 'json' });
    expect(parseVaultQrPayload('btvault1:{"qr":2,"vaultId":"x"}')).toEqual({
      ok: false,
      reason: 'shape',
    });
    expect(parseVaultQrPayload('')).toEqual({ ok: false, reason: 'prefix' });
    // A v1-shaped payload (the pre-r2 `v`/`p` members) is refused outright.
    expect(
      parseVaultQrPayload(
        `btvault1:{"v":2,"vaultId":"${FIXTURE_VAULT_ID}","name":"n","p":"${FIXTURE_PASSPHRASE}"}`,
      ),
    ).toEqual({ ok: false, reason: 'shape' });
  });

  it('rejects a truncated wrap before asking for a PIN', () => {
    expect(
      parseVaultQrPayload(
        `btvault1:{"qr":1,"vaultId":"${FIXTURE_VAULT_ID}","name":"n","w":"AAAA"}`,
      ),
    ).toEqual({ ok: false, reason: 'wrapped' });
  });

  it('rejects an extra member rather than ignoring it', async () => {
    const payload = await build();
    const injected = `${payload.slice(0, -1)},"exfil":"x"}`;
    expect(parseVaultQrPayload(injected)).toEqual({ ok: false, reason: 'shape' });
  });

  it('accepts a case-variant prefix from a lax encoder', async () => {
    const payload = await build();
    expect(parseVaultQrPayload(payload.replace('btvault1:', 'BTVAULT1:')).ok).toBe(true);
  });
});

describe('handoff PIN', () => {
  it('only accepts six digits', () => {
    expect(isValidQrPin('042195')).toBe(true);
    expect(isValidQrPin(' 042195 ')).toBe(true);
    expect(isValidQrPin('12345')).toBe(false);
    expect(isValidQrPin('1234567')).toBe(false);
    expect(isValidQrPin('12345a')).toBe(false);
  });

  it('refuses to build or unwrap with a malformed PIN', async () => {
    await expect(build({ pin: '123' })).rejects.toMatchObject({ code: 'kdf-failed' });
    const payload = await build();
    const parsed = parseVaultQrPayload(payload);
    if (!parsed.ok) throw new Error('expected a parsable payload');
    await expect(unwrapVaultQrPayload(parsed.payload, '123', fastDeps)).resolves.toEqual({
      ok: false,
      reason: 'pin-format',
    });
  });

  it('generates six digits, keeps leading zeros, and draws without modulo bias', () => {
    // A source that always returns the smallest rejectable value proves the
    // rejection branch is reached rather than folded with a biased modulo.
    let call = 0;
    const source = (length: number) => {
      call += 1;
      const bytes = new Uint8Array(length);
      // First draw lands in the unfair tail (>= floor(2^32/10^6)*10^6).
      new DataView(bytes.buffer).setUint32(0, call === 1 ? 0xfffffff0 : 7, false);
      return bytes;
    };
    expect(generateQrPin(source)).toBe('000007');
    expect(call).toBe(2);

    const real = generateQrPin();
    expect(real).toMatch(/^\d{6}$/u);
  });

  it('keeps the whole handoff inside the contract TTL', () => {
    expect(VAULT2_QR_TTL_MS).toBe(120_000);
  });
});
