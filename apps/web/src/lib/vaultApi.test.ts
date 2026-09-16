import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VaultStrictDocumentV1 } from '@bettertrack/contracts';

import { ApiError, setAuthResponsePolicy } from './apiClient';
import {
  createVaultDocument,
  deleteVault,
  listVaults,
  movePortfolioIntoVault,
  movePortfolioOutOfVault,
  purgeVaultRetiredServer,
  requestPortfolioMoveOutChallenge,
  requestVaultRetiredPurgeChallenge,
  writeVaultDocument,
} from './vaultApi';

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

/**
 * The per-vault half of the §16 (2026-07-28) retired-bytes ruling (#1520). The
 * server surface shipped with E1; without these wrappers the product promised
 * an explicit purge that no user action could reach, so what is pinned here is
 * the wire: the per-VAULT paths (not the account-level `/vault/…` ones), the
 * signed transcript travelling verbatim, and a response that must parse.
 */
const VERSION_SET_HASH = 'A'.repeat(43);
const CHALLENGE = 'C'.repeat(64);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('per-vault retired-server purge', () => {
  it('exchanges the retirement identity for a nonce on the per-vault challenge path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        vaultId: VAULT_ID,
        generation: 3,
        versionSetHash: VERSION_SET_HASH,
        challenge: CHALLENGE,
        expiresAt: '2026-08-29T12:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const challenge = await requestVaultRetiredPurgeChallenge(VAULT_ID, {
      vaultId: VAULT_ID,
      generation: 3,
      versionSetHash: VERSION_SET_HASH,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/vaults/${VAULT_ID}/media/retired/purge/challenge`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({
      vaultId: VAULT_ID,
      generation: 3,
      versionSetHash: VERSION_SET_HASH,
    });
    expect(challenge.challenge).toBe(CHALLENGE);
  });

  it('posts the signed proof to the per-vault purge path and parses the receipt', async () => {
    const request = {
      vaultId: VAULT_ID,
      generation: 3,
      versionSetHash: VERSION_SET_HASH,
      observedDocs: [
        { docId: DOC_ID, docVersion: 7, writeId: '018f6a3e-4444-7000-8000-00000000ffff' },
      ],
      challenge: CHALLENGE,
      signature: 'S'.repeat(86),
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        purged: true,
        vaultId: VAULT_ID,
        generation: 3,
        versionSetHash: VERSION_SET_HASH,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await purgeVaultRetiredServer(VAULT_ID, request);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/vaults/${VAULT_ID}/media/retired/purge`);
    expect(url).not.toContain('/challenge');
    expect(init.method).toBe('POST');
    // The transcript the Ed25519 signature covers must reach the server byte
    // for byte; a wrapper that reshaped it would fail verification server-side.
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(receipt.purged).toBe(true);
  });

  it('refuses a receipt that does not match the published contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ purged: false })));

    await expect(
      purgeVaultRetiredServer(VAULT_ID, {
        vaultId: VAULT_ID,
        generation: 3,
        versionSetHash: VERSION_SET_HASH,
        observedDocs: [],
        challenge: CHALLENGE,
        signature: 'S'.repeat(86),
      }),
    ).rejects.toThrow();
  });
});

/**
 * #2000 — a wrong §15 step-up credential is an IN-FORM error, never a logout.
 *
 * Every gated operation sends its credential in the request body and the server
 * refuses it generically: `401 INVALID_CREDENTIALS`, the same status an expired
 * session produces. The app-wide auth policy cannot tell those apart, so before
 * this fix a typo in the delete-vault dialog or either move wizard tore the
 * session down client-side and bounced the owner to the login screen — with the
 * half-finished ceremony gone. #1632/#1999 fixed exactly one of the four calls
 * (the acknowledged Drive disconnect); these are the other three.
 *
 * What is pinned here is deliberately narrow: whether the ONE global policy hook
 * fires. Recall alone would pass on a module that suppressed everything, so the
 * ungated challenge call below is asserted to still fire it — the credential is
 * what earns the opt-out, not the URL prefix.
 */
const MOVE_PORTFOLIO_ID = '018f6a3e-3333-7000-8000-000000000031';
const MOVE_DIGEST = 'D'.repeat(43);
const MOVE_SET_HASH = 'E'.repeat(43);
const STEP_UP = { password: 'the-owners-account-password' } as const;

const RESTORE_DOCUMENT: VaultStrictDocumentV1 = {
  schemaVersion: 1,
  entities: [],
  mergeLog: [],
  mirrorProvenance: [],
};

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'INVALID_CREDENTIALS', message: 'Re-authentication failed.' },
    }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Every §15 gated call this module owns, each with a credential in its body. */
const GATED_CALLS: readonly { name: string; call: () => Promise<unknown> }[] = [
  {
    name: 'deleteVault',
    call: () => deleteVault(VAULT_ID, { stepUp: STEP_UP }),
  },
  {
    name: 'movePortfolioIntoVault',
    call: () =>
      movePortfolioIntoVault(MOVE_PORTFOLIO_ID, {
        vaultId: VAULT_ID,
        docVersion: 4,
        portfolioDataRevision: 'rev-1',
        stepUp: STEP_UP,
      }),
  },
  {
    name: 'movePortfolioOutOfVault',
    call: () =>
      movePortfolioOutOfVault(MOVE_PORTFOLIO_ID, {
        vaultId: VAULT_ID,
        moveOutId: '018f6a3e-5555-7000-8000-000000000031',
        lifecycleGeneration: 1,
        documentSetHash: MOVE_SET_HASH,
        document: RESTORE_DOCUMENT,
        vaultProof: { challenge: CHALLENGE, signature: 'S'.repeat(86) },
        stepUp: STEP_UP,
      }),
  },
];

describe('§15 gated calls and the app-wide auth policy', () => {
  for (const gated of GATED_CALLS) {
    it(`${gated.name}: a refused credential stays an in-form error — no session teardown`, async () => {
      const onUnauthorized = vi.fn();
      const dispose = setAuthResponsePolicy({ onUnauthorized });
      try {
        const fetchMock = vi.fn().mockResolvedValue(unauthorizedResponse());
        vi.stubGlobal('fetch', fetchMock);

        await expect(gated.call()).rejects.toBeInstanceOf(ApiError);

        // The request really went out — without this the assertion below would
        // also pass on a wrapper that never called the server at all.
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(onUnauthorized).not.toHaveBeenCalled();
      } finally {
        dispose();
      }
    });

    it(`${gated.name}: the §15 throttle's 429 is the dialog's to report, not the app banner's`, async () => {
      const onRateLimited = vi.fn();
      const dispose = setAuthResponsePolicy({ onRateLimited });
      try {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow' } }), {
              status: 429,
              headers: { 'Content-Type': 'application/json', 'Retry-After': '20' },
            }),
          ),
        );

        await expect(gated.call()).rejects.toBeInstanceOf(ApiError);

        // The per-account step-up throttle and the route limiter both answer
        // 429 here and the surface cannot tell them apart; naming one in a
        // global banner would leak whether the credential path was reached.
        expect(onRateLimited).not.toHaveBeenCalled();
      } finally {
        dispose();
      }
    });
  }

  it('the move-out CHALLENGE carries no credential, so its 401 still clears the session', async () => {
    const onUnauthorized = vi.fn();
    const dispose = setAuthResponsePolicy({ onUnauthorized });
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorizedResponse()));

      await expect(
        requestPortfolioMoveOutChallenge(MOVE_PORTFOLIO_ID, {
          vaultId: VAULT_ID,
          lifecycleGeneration: 1,
          documentDigest: MOVE_DIGEST,
          documentSetHash: MOVE_SET_HASH,
        }),
      ).rejects.toBeInstanceOf(ApiError);

      expect(onUnauthorized).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });

  it('an ordinary vault read still clears the session on 401', async () => {
    const onUnauthorized = vi.fn();
    const dispose = setAuthResponsePolicy({ onUnauthorized });
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorizedResponse()));

      await expect(listVaults()).rejects.toBeInstanceOf(ApiError);

      expect(onUnauthorized).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });
});
