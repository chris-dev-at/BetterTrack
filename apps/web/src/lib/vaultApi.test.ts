import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVaultDocument, writeVaultDocument } from './vaultApi';

/**
 * The E1 HTTP CAS wire mapping (#1528 F2). These pins exist because the whole
 * anti-clobber property of the per-vault blind store hangs on four literal
 * header bytes sequences: `If-None-Match: *` guards the FIRST version of a doc
 * against a concurrent creator, `If-Match: "<n>"` guards every replacement
 * against a concurrent writer, and a 412 must surface as the one typed code the
 * E6 capture translates — a mutation dropping either header used to survive
 * the entire suite while silently turning every write into last-writer-wins.
 */

const VAULT_ID = '018f6a3e-1111-7000-8000-000000000021';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000021';
const ENVELOPE = new Uint8Array([1, 2, 3, 4, 5]);

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('writeVaultDocument', () => {
  it('creates with `If-None-Match: *` and NO If-Match — the first version must not clobber a concurrent creator', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await writeVaultDocument(VAULT_ID, DOC_ID, ENVELOPE, { ifVersion: null });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/vaults/${VAULT_ID}/docs/${DOC_ID}`);
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('include');
    const headers = init.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('*');
    expect(headers['If-Match']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/vnd.bettertrack.vault+octet-stream');
    expect(headers['X-Requested-With']).toBe('BetterTrack');
    // The body is the opaque envelope, byte for byte — and a defensive copy,
    // so a caller zeroizing its buffer afterwards cannot mutate the request.
    const body = init.body as Uint8Array;
    expect([...body]).toEqual([...ENVELOPE]);
    expect(body).not.toBe(ENVELOPE);
  });

  it('replaces with `If-Match: vaultEtag(n)` and NO If-None-Match — every update names its exact base version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await writeVaultDocument(VAULT_ID, DOC_ID, ENVELOPE, { ifVersion: 7 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('"7"');
    expect(headers['If-None-Match']).toBeUndefined();
  });

  it('surfaces a 412 as VAULT_DOCUMENT_CAS_CONFLICT with the current version parsed from the ETag', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 412, headers: { ETag: '"9"' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      writeVaultDocument(VAULT_ID, DOC_ID, ENVELOPE, { ifVersion: 7 }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 412,
      code: 'VAULT_DOCUMENT_CAS_CONFLICT',
      details: { currentVersion: 9 },
    });
  });

  it('keeps a non-CAS failure and a network drop on their own codes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(
      writeVaultDocument(VAULT_ID, DOC_ID, ENVELOPE, { ifVersion: 7 }),
    ).rejects.toMatchObject({ code: 'VAULT_DOCUMENT_WRITE_FAILED', status: 500 });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(
      writeVaultDocument(VAULT_ID, DOC_ID, ENVELOPE, { ifVersion: null }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
});

describe('createVaultDocument', () => {
  it('is exactly the ifVersion:null write — the create guard rides along', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createVaultDocument(VAULT_ID, DOC_ID, ENVELOPE);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('*');
    expect(headers['If-Match']).toBeUndefined();
  });
});
