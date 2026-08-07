import {
  VAULT2_BLOB_FORMAT_VERSION,
  VAULT2_HEADER_FORMAT_VERSION,
  type VaultPortfolioDoc,
} from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { bytesToBase64 } from '../bytes';
import { VaultCryptoError } from '../errors';
import { decodeVaultEnvelope, inspectVaultEnvelope } from '../envelope';

import {
  decryptVaultBlob,
  decodeVaultBlob,
  encryptVaultBlob,
  inspectVaultBlob,
} from './blobCrypto';
import {
  buildVaultHeader,
  changeVaultPassphrase,
  openVaultHeader,
  reviseVaultHeader,
  sealVaultHeader,
  verifyVaultHeaderSeal,
} from './headerCrypto';

import {
  deterministicBytes,
  entity,
  fastDeps,
  FIXTURE_DEVICE_ID,
  FIXTURE_OTHER_PASSPHRASE,
  FIXTURE_PASSPHRASE,
  FIXTURE_PORTFOLIO_A,
  FIXTURE_PORTFOLIO_B,
  FIXTURE_VAULT_ID,
  FIXTURE_WRITE_ID,
  FIXTURE_WRITTEN_AT,
} from './testSupport';

const WRITE = {
  deviceId: FIXTURE_DEVICE_ID,
  writeId: FIXTURE_WRITE_ID,
  writtenAt: FIXTURE_WRITTEN_AT,
};

function buildHeader(overrides: Partial<Parameters<typeof buildVaultHeader>[0]> = {}) {
  return buildVaultHeader({
    vaultId: FIXTURE_VAULT_ID,
    name: 'Drive vault',
    backends: ['drive'],
    passphrase: FIXTURE_PASSPHRASE,
    deviceId: FIXTURE_DEVICE_ID,
    writeId: FIXTURE_WRITE_ID,
    writtenAt: FIXTURE_WRITTEN_AT,
    randomBytes: deterministicBytes(7),
    deps: fastDeps,
    ...overrides,
  });
}

function portfolioDoc(portfolioId = FIXTURE_PORTFOLIO_A): VaultPortfolioDoc {
  return {
    schemaVersion: 1,
    docKind: 'portfolio',
    vaultId: FIXTURE_VAULT_ID,
    portfolioId,
    entities: {
      portfolio: [entity(portfolioId, { name: 'Tech', visibility: 'private' })],
      transaction: [entity('33333333-3333-4333-8333-333333333333', { portfolioId, side: 'buy' })],
    },
    mergeLog: [],
  };
}

describe('vault v2 header', () => {
  it('builds a sealed header and reopens it with the same 12 words', async () => {
    const built = await buildHeader();

    expect(built.header.formatVersion).toBe(VAULT2_HEADER_FORMAT_VERSION);
    expect(built.header.keySlots).toHaveLength(1);
    expect(built.header.keySlots[0]!.kind).toBe('passphrase');
    expect(built.header.seal).not.toBeNull();
    expect(built.contentKey).toHaveLength(32);

    const opened = await openVaultHeader(built.header, FIXTURE_PASSPHRASE, fastDeps);
    expect(bytesToBase64(opened.contentKey)).toBe(bytesToBase64(built.contentKey));
    expect(opened.seal).toBe('sealed');
    expect(opened.slotId).toBe(built.header.keySlots[0]!.slotId);
  });

  it('accepts the phrase in any casing and spacing', async () => {
    const built = await buildHeader();
    const opened = await openVaultHeader(
      built.header,
      `  ${FIXTURE_PASSPHRASE.toUpperCase().replace(/ /gu, '   ')}  `,
      fastDeps,
    );
    expect(bytesToBase64(opened.contentKey)).toBe(bytesToBase64(built.contentKey));
  });

  it('refuses a different valid phrase with an indistinguishable error', async () => {
    const built = await buildHeader();
    await expect(
      openVaultHeader(built.header, FIXTURE_OTHER_PASSPHRASE, fastDeps),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('rejects a phrase that is not 12 checksummed words before deriving anything', async () => {
    const built = await buildHeader();
    await expect(
      openVaultHeader(built.header, 'not a real phrase', fastDeps),
    ).rejects.toBeInstanceOf(VaultCryptoError);
  });

  it('fails the seal when the portfolio index is edited in the blob store', async () => {
    const built = await buildHeader();
    const tampered = {
      ...built.header,
      portfolios: [{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'injected' }],
    };
    await expect(verifyVaultHeaderSeal(tampered, built.contentKey)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
    await expect(openVaultHeader(tampered, FIXTURE_PASSPHRASE, fastDeps)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
  });

  it('fails the seal when the backend echo or the name is edited', async () => {
    const built = await buildHeader();
    await expect(
      verifyVaultHeaderSeal({ ...built.header, backends: ['server'] }, built.contentKey),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
    await expect(
      verifyVaultHeaderSeal({ ...built.header, name: 'Other vault' }, built.contentKey),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('fails the seal when the header version is rolled back in place', async () => {
    const built = await buildHeader();
    const revised = await reviseVaultHeader(
      built.header,
      built.contentKey,
      { name: 'Renamed vault' },
      WRITE,
    );
    expect(revised.headerVersion).toBe(built.header.headerVersion + 1);
    await expect(
      verifyVaultHeaderSeal(
        { ...revised, headerVersion: built.header.headerVersion },
        built.contentKey,
      ),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('reads a header written without a seal and reports it as unsealed', async () => {
    const built = await buildHeader();
    const legacy = { ...built.header, seal: null };
    const opened = await openVaultHeader(legacy, FIXTURE_PASSPHRASE, fastDeps);
    expect(opened.seal).toBe('unsealed');
  });

  it('re-seals after every revision so a revised header is never left unsealed', async () => {
    const built = await buildHeader();
    const revised = await reviseVaultHeader(
      built.header,
      built.contentKey,
      { portfolios: [{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' }] },
      WRITE,
    );
    expect(revised.seal).not.toBeNull();
    await expect(verifyVaultHeaderSeal(revised, built.contentKey)).resolves.toBe('sealed');
  });

  it('changes the passphrase without touching the content key or any blob', async () => {
    const built = await buildHeader();
    const blob = await encryptVaultBlob({
      document: portfolioDoc(),
      contentKey: built.contentKey,
      blobVersion: 1,
      ...WRITE,
      randomBytes: deterministicBytes(3),
    });

    const rotated = await changeVaultPassphrase(
      built.header,
      built.contentKey,
      FIXTURE_OTHER_PASSPHRASE,
      WRITE,
      deterministicBytes(50),
      fastDeps,
    );

    expect(rotated.kdfSalt).not.toBe(built.header.kdfSalt);
    expect(rotated.keySlots[0]!.slotId).not.toBe(built.header.keySlots[0]!.slotId);

    const reopened = await openVaultHeader(rotated, FIXTURE_OTHER_PASSPHRASE, fastDeps);
    expect(bytesToBase64(reopened.contentKey)).toBe(bytesToBase64(built.contentKey));

    // The untouched blob still opens under the same content key.
    const { document } = await decryptVaultBlob(blob.envelope, reopened.contentKey);
    expect(document.docKind).toBe('portfolio');

    await expect(openVaultHeader(rotated, FIXTURE_PASSPHRASE, fastDeps)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
  });

  it('runs the production Argon2id profile end to end', async () => {
    const built = await buildVaultHeader({
      vaultId: FIXTURE_VAULT_ID,
      name: 'Server vault',
      backends: ['server'],
      passphrase: FIXTURE_PASSPHRASE,
      deviceId: FIXTURE_DEVICE_ID,
      writeId: FIXTURE_WRITE_ID,
      writtenAt: FIXTURE_WRITTEN_AT,
    });
    expect(built.header.kdf).toMatchObject({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
    const opened = await openVaultHeader(built.header, FIXTURE_PASSPHRASE);
    expect(bytesToBase64(opened.contentKey)).toBe(bytesToBase64(built.contentKey));
  });
});

describe('vault v2 content blobs', () => {
  it('round-trips a portfolio document under the content key', async () => {
    const built = await buildHeader();
    const source = portfolioDoc();
    const encrypted = await encryptVaultBlob({
      document: source,
      contentKey: built.contentKey,
      blobVersion: 4,
      ...WRITE,
      randomBytes: deterministicBytes(11),
    });

    expect(encrypted.header.formatVersion).toBe(VAULT2_BLOB_FORMAT_VERSION);
    expect(encrypted.header.portfolioId).toBe(FIXTURE_PORTFOLIO_A);
    expect(encrypted.header.blobVersion).toBe(4);

    const { document, header } = await decryptVaultBlob(encrypted.envelope, built.contentKey);
    expect(document).toEqual(source);
    expect(header.vaultId).toBe(FIXTURE_VAULT_ID);
  });

  it('carries no wrapped keys, so a blob leaks nothing about the passphrase', async () => {
    const built = await buildHeader();
    const encrypted = await encryptVaultBlob({
      document: portfolioDoc(),
      contentKey: built.contentKey,
      blobVersion: 1,
      ...WRITE,
    });
    const header = inspectVaultBlob(encrypted.envelope) as Record<string, unknown>;
    expect(header).not.toHaveProperty('wrappedKeys');
    expect(header).not.toHaveProperty('kdf');
    expect(JSON.stringify(header)).not.toContain(built.header.kdfSalt);
  });

  it('refuses a blob replayed into a different portfolio', async () => {
    const built = await buildHeader();
    const encrypted = await encryptVaultBlob({
      document: portfolioDoc(FIXTURE_PORTFOLIO_A),
      contentKey: built.contentKey,
      blobVersion: 1,
      ...WRITE,
    });

    // Rewrite the cleartext header to claim another portfolio; the header bytes
    // are AAD, so the ciphertext no longer authenticates.
    const decoded = decodeVaultBlob(encrypted.envelope);
    const forgedHeader = { ...decoded.header, portfolioId: FIXTURE_PORTFOLIO_B };
    const forgedHeaderBytes = new TextEncoder().encode(JSON.stringify(forgedHeader));
    const forged = new Uint8Array(12 + forgedHeaderBytes.length + decoded.ciphertext.length);
    forged.set(encrypted.envelope.subarray(0, 8));
    new DataView(forged.buffer).setUint32(8, forgedHeaderBytes.length, false);
    forged.set(forgedHeaderBytes, 12);
    forged.set(decoded.ciphertext, 12 + forgedHeaderBytes.length);

    await expect(decryptVaultBlob(forged, built.contentKey)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
  });

  it('refuses a blob whose CAS version was edited in place', async () => {
    const built = await buildHeader();
    const encrypted = await encryptVaultBlob({
      document: portfolioDoc(),
      contentKey: built.contentKey,
      blobVersion: 9,
      ...WRITE,
    });
    const decoded = decodeVaultBlob(encrypted.envelope);
    const headerBytes = new TextEncoder().encode(
      JSON.stringify({ ...decoded.header, blobVersion: 2 }),
    );
    const forged = new Uint8Array(12 + headerBytes.length + decoded.ciphertext.length);
    forged.set(encrypted.envelope.subarray(0, 8));
    new DataView(forged.buffer).setUint32(8, headerBytes.length, false);
    forged.set(headerBytes, 12);
    forged.set(decoded.ciphertext, 12 + headerBytes.length);

    await expect(decryptVaultBlob(forged, built.contentKey)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
  });

  it('refuses the wrong content key', async () => {
    const built = await buildHeader();
    const other = await buildHeader({
      vaultId: '9f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a09',
      randomBytes: deterministicBytes(90),
    });
    const encrypted = await encryptVaultBlob({
      document: portfolioDoc(),
      contentKey: built.contentKey,
      blobVersion: 1,
      ...WRITE,
    });
    await expect(decryptVaultBlob(encrypted.envelope, other.contentKey)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
  });

  it('tells a v1 reader to update rather than reporting corruption', async () => {
    const built = await buildHeader();
    const encrypted = await encryptVaultBlob({
      document: portfolioDoc(),
      contentKey: built.contentKey,
      blobVersion: 1,
      ...WRITE,
    });
    // The v1 inspector shares the BTVAULT1 magic and reads the version fields
    // first, so a v2 blob reaches its documented update path rather than the
    // "corrupt bytes" branch a different magic would have triggered.
    expect(inspectVaultEnvelope(encrypted.envelope)).toMatchObject({
      status: 'update-required',
      formatVersion: VAULT2_BLOB_FORMAT_VERSION,
    });
    expect(() => decodeVaultEnvelope(encrypted.envelope)).toThrowError(
      expect.objectContaining({ code: 'update-required' }),
    );
  });

  it('rejects a blob written by a future format version', async () => {
    const built = await buildHeader();
    const encrypted = await encryptVaultBlob({
      document: portfolioDoc(),
      contentKey: built.contentKey,
      blobVersion: 1,
      ...WRITE,
    });
    const decoded = decodeVaultBlob(encrypted.envelope);
    const headerBytes = new TextEncoder().encode(
      JSON.stringify({ ...decoded.header, formatVersion: 99 }),
    );
    const future = new Uint8Array(12 + headerBytes.length + decoded.ciphertext.length);
    future.set(encrypted.envelope.subarray(0, 8));
    new DataView(future.buffer).setUint32(8, headerBytes.length, false);
    future.set(headerBytes, 12);
    future.set(decoded.ciphertext, 12 + headerBytes.length);

    expect(() => decodeVaultBlob(future)).toThrowError(
      expect.objectContaining({ code: 'update-required' }),
    );
  });

  it('rejects truncated and mis-magicked bytes', () => {
    expect(() => decodeVaultBlob(new Uint8Array(4))).toThrowError(VaultCryptoError);
    const wrongMagic = new Uint8Array(64);
    wrongMagic.set(new TextEncoder().encode('NOTAVLT1'));
    expect(() => decodeVaultBlob(wrongMagic)).toThrowError(VaultCryptoError);
  });

  it('seals the same header to the same bytes regardless of key insertion order', async () => {
    const built = await buildHeader();
    const shuffled = Object.fromEntries(
      Object.entries(built.header).reverse(),
    ) as typeof built.header;
    const resealed = await sealVaultHeader({ ...shuffled, seal: null }, built.contentKey);
    expect(resealed.seal).toBe(built.header.seal);
  });
});
