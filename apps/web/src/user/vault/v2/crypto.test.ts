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
  keySlotAad,
  openVaultHeader,
  reviseVaultHeader,
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
    backends: 'drive',
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
    expect(built.contentKey).toHaveLength(32);
    // r3 §21: every written header carries the HMAC integrity tag (the r2-era
    // fixed-nonce GMAC `seal` stays withdrawn — this is its safe replacement).
    expect(built.header.mac).toMatchObject({ v: 1 });
    expect(built.header).not.toHaveProperty('seal');

    const opened = await openVaultHeader(built.header, FIXTURE_PASSPHRASE, fastDeps);
    expect(bytesToBase64(opened.contentKey)).toBe(bytesToBase64(built.contentKey));
    expect(opened.slotId).toBe(built.header.keySlots[0]!.slotId);
    expect(opened.sealState).toBe('verified');
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

  it('binds each key slot to the vault id and its slot index (r2 §9)', async () => {
    const built = await buildHeader();
    const slot = built.header.keySlots[0]!;

    // The AAD is the whole defence against a blob store moving a wrapped key
    // between vaults or reordering keySlots[] once shared vaults add members.
    const aad = new TextDecoder().decode(keySlotAad(built.header.vaultId, 0));
    expect(aad).toContain(built.header.vaultId);
    expect(aad).toContain('"bettertrack.vault2-key-slot.v1"');
    expect(keySlotAad(built.header.vaultId, 0)).not.toEqual(keySlotAad(built.header.vaultId, 1));
    expect(keySlotAad(built.header.vaultId, 0)).not.toEqual(
      keySlotAad('9f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a09', 0),
    );

    // A slot lifted into another vault's header no longer authenticates.
    const stolen = { ...built.header, vaultId: '9f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a09' };
    await expect(openVaultHeader(stolen, FIXTURE_PASSPHRASE, fastDeps)).rejects.toMatchObject({
      code: 'authentication-failed',
    });

    // Moving the real slot from index 0 to index 1 breaks it: its AAD names
    // index 0, so at any other position it no longer authenticates. This is
    // exactly the reordering a blob store could otherwise perform unnoticed.
    const decoy = {
      ...slot,
      slotId: '1f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a11',
      wrappedKey: btoa(String.fromCharCode(...new Uint8Array(60))),
    };
    await expect(
      openVaultHeader({ ...built.header, keySlots: [decoy, slot] }, FIXTURE_PASSPHRASE, fastDeps),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('refuses a wrapped key whose bytes were edited', async () => {
    const built = await buildHeader();
    const slot = built.header.keySlots[0]!;
    const bytes = [...atob(slot.wrappedKey)].map((char) => char.charCodeAt(0));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
    const tampered = {
      ...built.header,
      keySlots: [{ ...slot, wrappedKey: btoa(String.fromCharCode(...bytes)) }],
    };
    await expect(openVaultHeader(tampered, FIXTURE_PASSPHRASE, fastDeps)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
  });

  it('authenticates the portfolio index: relabel, add and drop are all detected (r3 §21)', async () => {
    // The r2-era known-gap test asserted the OPPOSITE — that a blob store could
    // relabel the index unnoticed. The header MAC closes it: every written
    // header carries `mac`, and any index edit fails verification.
    const built = await buildVaultHeader({
      vaultId: FIXTURE_VAULT_ID,
      name: 'Drive vault',
      backends: 'drive',
      passphrase: FIXTURE_PASSPHRASE,
      portfolios: [{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'Tech' }],
      deviceId: FIXTURE_DEVICE_ID,
      writeId: FIXTURE_WRITE_ID,
      writtenAt: FIXTURE_WRITTEN_AT,
      randomBytes: deterministicBytes(7),
      deps: fastDeps,
    });
    expect(built.header.mac).toMatchObject({ v: 1 });

    const opened = await openVaultHeader(built.header, FIXTURE_PASSPHRASE, fastDeps);
    expect(opened.sealState).toBe('verified');

    const tampered: Array<Partial<typeof built.header>> = [
      // relabel
      { portfolios: [{ portfolioId: FIXTURE_PORTFOLIO_A, alias: 'injected' }] },
      // add
      {
        portfolios: [
          ...built.header.portfolios,
          { portfolioId: FIXTURE_PORTFOLIO_B, alias: 'smuggled' },
        ],
      },
      // drop
      { portfolios: [] },
      // cleartext metadata edits are covered too
      { name: 'Renamed by the blob store' },
      { backends: 'both' as const },
    ];
    for (const patch of tampered) {
      await expect(
        openVaultHeader({ ...built.header, ...patch }, FIXTURE_PASSPHRASE, fastDeps),
      ).rejects.toMatchObject({ code: 'authentication-failed' });
    }

    // A wrong tag over the ORIGINAL content is tampering too, not tolerance.
    await expect(
      openVaultHeader(
        { ...built.header, mac: { v: 1, tag: bytesToBase64(new Uint8Array(32)) } },
        FIXTURE_PASSPHRASE,
        fastDeps,
      ),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('tolerates an ABSENT tag as unsealed and upgrades it on the next write', async () => {
    const built = await buildHeader();
    // A pre-r3 header: strip the tag entirely. It still opens — the tolerance
    // exists exactly so shipped headers do not brick — but the state says so.
    const { mac: _mac, ...pre } = built.header;
    const opened = await openVaultHeader(pre, FIXTURE_PASSPHRASE, fastDeps);
    expect(opened.sealState).toBe('unsealed');
    expect(bytesToBase64(opened.contentKey)).toBe(bytesToBase64(built.contentKey));

    // Upgrade-on-write: the first revision attaches the tag.
    const revised = await reviseVaultHeader(pre, { name: 'Now sealed' }, WRITE, built.contentKey);
    expect(revised.mac).toMatchObject({ v: 1 });
    const reopened = await openVaultHeader(revised, FIXTURE_PASSPHRASE, fastDeps);
    expect(reopened.sealState).toBe('verified');
  });

  it('covers unknown header members with the tag — preserved means authenticated', async () => {
    const built = await buildHeader();

    // A newer client seals a header CONTAINING a member we do not know. We
    // preserve it, and the tag still verifies because the canonical bytes
    // include it.
    const { mac: _mac, ...unsealed } = built.header;
    const withUnknown = await reviseVaultHeader(
      { ...unsealed, forwardField: 'from-a-newer-client' } as typeof built.header,
      {},
      WRITE,
      built.contentKey,
    );
    const opened = await openVaultHeader(withUnknown, FIXTURE_PASSPHRASE, fastDeps);
    expect(opened.sealState).toBe('verified');
    expect(opened.header).toMatchObject({ forwardField: 'from-a-newer-client' });

    // But a member INJECTED after sealing breaks verification: preservation is
    // not a laundering channel.
    await expect(
      openVaultHeader(
        { ...built.header, injected: 'by-the-blob-store' } as typeof built.header,
        FIXTURE_PASSPHRASE,
        fastDeps,
      ),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
  });

  it('advances the header version on every revision and re-seals it', async () => {
    const built = await buildHeader();
    const revised = await reviseVaultHeader(
      built.header,
      { name: 'Renamed vault' },
      WRITE,
      built.contentKey,
    );
    expect(revised.headerVersion).toBe(built.header.headerVersion + 1);
    expect(revised.name).toBe('Renamed vault');
    expect(revised.keySlots).toEqual(built.header.keySlots);
    expect(revised.mac).not.toEqual(built.header.mac);
    const reopened = await openVaultHeader(revised, FIXTURE_PASSPHRASE, fastDeps);
    expect(reopened.sealState).toBe('verified');
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
      backends: 'server',
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
});
