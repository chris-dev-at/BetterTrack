import {
  VAULT_DOC_FORMAT_VERSION,
  VAULT_DOC_SCHEMA_VERSION,
  encodeVaultDocEnvelope,
  encodeVaultEnvelope,
  type VaultConfig,
  type VaultDocEnvelopeHeader,
} from '@bettertrack/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiVaultDocEnvelopeReader, listVaults, readVaultDoc } from './vaultsApi';

const VAULT_ID = '018f6a3e-1111-7000-8000-000000000001';
const OTHER_VAULT_ID = '018f6a3e-1111-7000-8000-000000000002';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const OTHER_DOC_ID = '018f6a3e-2222-7000-8000-000000000002';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';

/** TEST VECTOR: deterministic server-visible config; no portfolio datum is present. */
const VAULT: VaultConfig = {
  id: VAULT_ID,
  name: 'Long term',
  headerDocId: '018f6a3e-2222-7000-8000-000000000010',
  commonDocId: '018f6a3e-2222-7000-8000-000000000011',
  media: ['server'],
  driveConnectionId: null,
  keyFingerprint: 'AAAAAAAAAAAAAAAA',
  retirementProofPublicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  retirementGeneration: 0,
  mediaAttestedAt: '2026-08-20T12:00:00.000Z',
  mediaAttestedDriveConnectionId: null,
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
};

/** TEST VECTOR: supported v2 portfolio address at CAS version seven. */
function header(overrides: Partial<VaultDocEnvelopeHeader> = {}): VaultDocEnvelopeHeader {
  return {
    formatVersion: VAULT_DOC_FORMAT_VERSION,
    cipher: 'A256GCM',
    iv: 'AAAAAAAAAAAAAAAA',
    keyId: KEY_ID,
    keySlots: [{ keyId: KEY_ID, slot: 'seed-v1', wrappedKc: 'wrapped-content-key' }],
    vaultId: VAULT_ID,
    docId: DOC_ID,
    docKind: 'portfolio',
    accountBinding: 'A'.repeat(43),
    docVersion: 7,
    schemaVersion: VAULT_DOC_SCHEMA_VERSION,
    deviceId: '018f6a3e-4444-7000-8000-000000000001',
    writeId: '018f6a3e-5555-7000-8000-000000000001',
    writtenAt: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
}

function supportedEnvelope(overrides: Partial<VaultDocEnvelopeHeader> = {}): Uint8Array {
  return encodeVaultDocEnvelope(header(overrides), new Uint8Array([9, 8, 7, 6]));
}

function binaryResponse(envelope: Uint8Array, etag: string | null = '"7"', status = 200): Response {
  const headers = etag === null ? undefined : { ETag: etag };
  return new Response(envelope.slice().buffer as ArrayBuffer, { status, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('listVaults', () => {
  it('GETs /vaults with credentials and validates the shared response contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ vaults: [VAULT] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listVaults()).resolves.toEqual({ vaults: [VAULT] });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/vaults', {
      method: 'GET',
      headers: {},
      credentials: 'include',
      body: undefined,
      signal: undefined,
      keepalive: undefined,
    });
  });

  it('rejects a malformed list with a typed contract error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ vaults: [{ id: VAULT_ID }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(listVaults()).rejects.toMatchObject({
      name: 'VaultsApiError',
      kind: 'invalid-response',
      code: 'VAULT_LIST_RESPONSE_INVALID',
    });
  });
});

describe('readVaultDoc', () => {
  it('rejects an invalid address without issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(readVaultDoc('not-a-vault', DOC_ID)).rejects.toMatchObject({
      kind: 'invalid-request',
      code: 'VAULT_DOC_ADDRESS_INVALID',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns supported bytes only when path, header and ETag version agree exactly', async () => {
    const envelope = supportedEnvelope();
    const fetchMock = vi.fn().mockResolvedValue(binaryResponse(envelope));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiVaultDocEnvelopeReader.read(VAULT_ID, DOC_ID)).resolves.toEqual({
      envelope,
      header: header(),
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/vaults/${VAULT_ID}/docs/${DOC_ID}`, {
      method: 'GET',
      credentials: 'include',
      signal: undefined,
    });
  });

  it.each([
    {
      label: 'vault id',
      envelope: supportedEnvelope({ vaultId: OTHER_VAULT_ID }),
    },
    {
      label: 'doc id',
      envelope: supportedEnvelope({ docId: OTHER_DOC_ID }),
    },
  ])('rejects a swapped $label before exposing bytes', async ({ envelope }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(binaryResponse(envelope)));

    await expect(readVaultDoc(VAULT_ID, DOC_ID)).rejects.toMatchObject({
      kind: 'address-mismatch',
      code: 'VAULT_DOC_ADDRESS_MISMATCH',
    });
  });

  it.each([null, 'not-an-etag', '*', '"7", "8"'])('rejects invalid ETag %s', async (etag) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(binaryResponse(supportedEnvelope(), etag)));

    await expect(readVaultDoc(VAULT_ID, DOC_ID)).rejects.toMatchObject({
      kind: 'invalid-etag',
      code: 'VAULT_DOC_ETAG_INVALID',
    });
  });

  it('rejects an ETag that does not equal the envelope docVersion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(binaryResponse(supportedEnvelope(), '"8"')));

    await expect(readVaultDoc(VAULT_ID, DOC_ID)).rejects.toMatchObject({
      kind: 'version-mismatch',
      code: 'VAULT_DOC_VERSION_MISMATCH',
      details: { etagVersion: 8, envelopeVersion: 7 },
    });
  });

  it('rejects a future envelope as update-required without best-effort parsing it', async () => {
    const future = encodeVaultEnvelope(
      { ...header(), formatVersion: VAULT_DOC_FORMAT_VERSION + 1, unknownFutureField: true },
      new Uint8Array([1, 2, 3]),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(binaryResponse(future)));

    await expect(readVaultDoc(VAULT_ID, DOC_ID)).rejects.toMatchObject({
      kind: 'update-required',
      code: 'VAULT_DOC_UPDATE_REQUIRED',
      details: { formatVersion: VAULT_DOC_FORMAT_VERSION + 1 },
    });
  });

  it('rejects malformed envelope bytes with a typed integrity error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(binaryResponse(new Uint8Array([1, 2, 3]))));

    await expect(readVaultDoc(VAULT_ID, DOC_ID)).rejects.toMatchObject({
      kind: 'malformed-envelope',
      code: 'VAULT_DOC_ENVELOPE_MALFORMED',
    });
  });

  it('preserves a server API failure in the typed read error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'VAULT_NOT_FOUND', message: 'Vault document not found.' },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(readVaultDoc(VAULT_ID, DOC_ID)).rejects.toMatchObject({
      kind: 'http',
      status: 404,
      code: 'VAULT_NOT_FOUND',
    });
  });

  it('rejects transport failure as a typed network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    await expect(readVaultDoc(VAULT_ID, DOC_ID)).rejects.toMatchObject({
      kind: 'network',
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  it('preserves abort identity instead of reporting a network failure', async () => {
    const aborted = new DOMException('TEST VECTOR cancellation', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));

    await expect(readVaultDoc(VAULT_ID, DOC_ID)).rejects.toBe(aborted);
  });
});
