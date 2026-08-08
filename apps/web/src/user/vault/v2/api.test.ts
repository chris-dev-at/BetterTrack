import { vaultEtag } from '@bettertrack/contracts';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { base64ToBytes, bytesToBase64 } from '../bytes';

import {
  createVault,
  decodeHeaderDoc,
  deleteVault,
  encodeHeaderDoc,
  joinPortfolioToVault,
  leavePortfolioVault,
  listVaults,
  readVaultDoc,
  readVaultHeaderDoc,
  reauthenticate,
  setPortfolioAlias,
  updateVaultBackends,
  VAULT2_ROUTES,
  writeVaultDoc,
  writeVaultHeaderDoc,
} from './api';
import { buildVaultHeader } from './headerCrypto';
import {
  deterministicBytes,
  fastDeps,
  FIXTURE_DEVICE_ID,
  FIXTURE_PASSPHRASE,
  FIXTURE_PORTFOLIO_A,
  FIXTURE_VAULT_ID,
  FIXTURE_WRITE_ID,
  FIXTURE_WRITTEN_AT,
} from './testSupport';

/**
 * Integration tests for the §3 route surface. The server PR is being built in
 * parallel, so these run against MSW handlers written straight from the design
 * doc: they pin the request the client SENDS (method, path, body, CAS headers)
 * as much as the response it accepts.
 */

const API = '*/api/v1';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function use(...handlers: HttpHandler[]): void {
  server.use(...handlers);
}

const RESTORE_ID = '5f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a05';

const SUMMARY = {
  id: FIXTURE_VAULT_ID,
  name: 'Drive vault',
  backends: 'drive' as const,
  portfolioIds: [FIXTURE_PORTFOLIO_A],
  portfolioCount: 1,
  createdAt: '2026-08-08T09:00:00.000Z',
  updatedAt: '2026-08-08T09:00:00.000Z',
};

const BLOB_META = {
  vaultId: FIXTURE_VAULT_ID,
  docKind: 'portfolio' as const,
  portfolioId: FIXTURE_PORTFOLIO_A,
  version: 1,
  sizeBytes: 4,
  updatedAt: '2026-08-08T09:00:00.000Z',
};

async function fixtureHeader() {
  const built = await buildVaultHeader({
    vaultId: FIXTURE_VAULT_ID,
    name: 'Drive vault',
    backends: 'drive',
    passphrase: FIXTURE_PASSPHRASE,
    deviceId: FIXTURE_DEVICE_ID,
    writeId: FIXTURE_WRITE_ID,
    writtenAt: FIXTURE_WRITTEN_AT,
    randomBytes: deterministicBytes(7),
    deps: fastDeps,
  });
  return built.header;
}

describe('vault CRUD (session routes)', () => {
  it('lists vaults from the shipped {vaults: [...]} envelope', async () => {
    use(http.get(`${API}/vaults`, () => HttpResponse.json({ vaults: [SUMMARY] })));
    await expect(listVaults()).resolves.toEqual([SUMMARY]);
  });

  it('refuses a malformed vault rather than rendering a half-parsed one', async () => {
    // The shipped DTO is `.strict()`. A response that drifts from it is a bug
    // worth surfacing, not something to paper over with defaults.
    use(
      http.get(`${API}/vaults`, () =>
        HttpResponse.json({ vaults: [{ ...SUMMARY, futureField: 'unexpected' }] }),
      ),
    );
    await expect(listVaults()).rejects.toThrow();
  });

  it('creates a vault by posting the client-built header, id included', async () => {
    const header = await fixtureHeader();
    let received: Record<string, unknown> | null = null;
    use(
      http.post(`${API}/vaults`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        expect(request.headers.get('X-Requested-With')).toBe('BetterTrack');
        return HttpResponse.json({ vault: SUMMARY, header: null }, { status: 201 });
      }),
    );

    await expect(
      createVault({
        id: FIXTURE_VAULT_ID,
        name: 'Drive vault',
        backends: 'both',
        header,
      }),
    ).resolves.toEqual({ vault: SUMMARY, header: null });

    expect(received).toMatchObject({
      id: FIXTURE_VAULT_ID,
      name: 'Drive vault',
      backends: 'both',
    });
    // The header travels as opaque base64 and survives the round trip byte for byte.
    const decoded = decodeHeaderDoc(base64ToBytes(received!.header as string, 'envelope-invalid'));
    expect(decoded).toEqual(header);
    expect(decoded.seal).toBe(header.seal);
  });

  it('changes the backend set', async () => {
    let body: unknown = null;
    use(
      http.patch(`${API}/vaults/${FIXTURE_VAULT_ID}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...SUMMARY, backends: 'both' });
      }),
    );
    const updated = await updateVaultBackends(FIXTURE_VAULT_ID, 'both');
    expect(body).toEqual({ backends: 'both' });
    expect(updated.backends).toBe('both');
  });

  it('deletes a vault', async () => {
    let called = false;
    use(
      http.delete(`${API}/vaults/${FIXTURE_VAULT_ID}`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await deleteVault(FIXTURE_VAULT_ID);
    expect(called).toBe(true);
  });

  it('percent-encodes ids so a hostile id cannot escape its path segment', async () => {
    use(
      http.delete(`${API}/vaults/:id`, ({ params }) => {
        expect(params.id).toBe('a/../b');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await deleteVault('a/../b');
    expect(VAULT2_ROUTES.vault('a/../b')).toBe('/vaults/a%2F..%2Fb');
  });
});

describe('portfolio alias', () => {
  it('publishes the cleartext display alias through PATCH /portfolios/{id}/alias', async () => {
    let body: unknown = null;
    use(
      http.patch(`${API}/portfolios/${FIXTURE_PORTFOLIO_A}/alias`, async ({ request }) => {
        body = await request.json();
        expect(request.headers.get('X-Requested-With')).toBe('BetterTrack');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await setPortfolioAlias(FIXTURE_PORTFOLIO_A, 'Vault portfolio 1');
    expect(body).toEqual({ alias: 'Vault portfolio 1' });
  });
});

describe('join and leave', () => {
  it('posts finished ciphertext to POST /portfolios/{id}/vault', async () => {
    const blob = new Uint8Array([1, 2, 3, 4]);
    let body: Record<string, unknown> | null = null;
    use(
      http.post(`${API}/portfolios/${FIXTURE_PORTFOLIO_A}/vault`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          state: {
            portfolioId: FIXTURE_PORTFOLIO_A,
            vaultId: FIXTURE_VAULT_ID,
            vaultName: 'Drive vault',
            backends: 'drive',
            alias: 'Tech',
          },
          blob: BLOB_META,
        });
      }),
    );

    await expect(
      joinPortfolioToVault({
        portfolioId: FIXTURE_PORTFOLIO_A,
        vaultId: FIXTURE_VAULT_ID,
        blob,
      }),
    ).resolves.toMatchObject({ blob: { version: 1 }, state: { vaultId: FIXTURE_VAULT_ID } });
    expect(body).toEqual({ vaultId: FIXTURE_VAULT_ID, blob: bytesToBase64(blob) });
  });

  it('sends the plaintext rows back on leave with the client-minted restore id', async () => {
    let body: Record<string, unknown> | null = null;
    use(
      http.delete(`${API}/portfolios/${FIXTURE_PORTFOLIO_A}/vault`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          state: {
            portfolioId: FIXTURE_PORTFOLIO_A,
            vaultId: null,
            vaultName: null,
            backends: null,
            alias: null,
          },
          restoreId: RESTORE_ID,
          idempotent: false,
        });
      }),
    );

    const document = { schemaVersion: 1 as const, entities: [] };
    await expect(
      leavePortfolioVault({ portfolioId: FIXTURE_PORTFOLIO_A, restoreId: RESTORE_ID, document }),
    ).resolves.toMatchObject({ restoreId: RESTORE_ID, idempotent: false });
    expect(body).toEqual({ restoreId: RESTORE_ID, document });
  });

  it('replays the SAME restore id so a retried leave is receipt-recognized', async () => {
    // The server keeps `vault_leave_receipts` keyed by restoreId. A client that
    // minted a fresh id on retry would restore the portfolio twice, so the id
    // must be an input the caller persists — this asserts the adapter sends
    // exactly what it was given, both times.
    const seen: string[] = [];
    use(
      http.delete(`${API}/portfolios/${FIXTURE_PORTFOLIO_A}/vault`, async ({ request }) => {
        const body = (await request.json()) as { restoreId: string };
        seen.push(body.restoreId);
        return HttpResponse.json({
          state: {
            portfolioId: FIXTURE_PORTFOLIO_A,
            vaultId: null,
            vaultName: null,
            backends: null,
            alias: null,
          },
          restoreId: body.restoreId,
          idempotent: seen.length > 1,
        });
      }),
    );

    const document = { schemaVersion: 1 as const, entities: [] };
    const first = await leavePortfolioVault({
      portfolioId: FIXTURE_PORTFOLIO_A,
      restoreId: RESTORE_ID,
      document,
    });
    const retry = await leavePortfolioVault({
      portfolioId: FIXTURE_PORTFOLIO_A,
      restoreId: RESTORE_ID,
      document,
    });

    expect(seen).toEqual([RESTORE_ID, RESTORE_ID]);
    expect(first.idempotent).toBe(false);
    expect(retry.idempotent).toBe(true);
  });
});

describe('doc transport (CAS)', () => {
  const path = VAULT2_ROUTES.headerDoc(FIXTURE_VAULT_ID);

  it('talks to the shipped server paths, with no `/docs/` segment', () => {
    expect(path).toBe(`/vaults/${FIXTURE_VAULT_ID}/header`);
  });

  it('reports an absent doc rather than throwing', async () => {
    use(http.get(`${API}${path}`, () => new HttpResponse(null, { status: 404 })));
    await expect(readVaultDoc(path)).resolves.toEqual({ status: 'absent' });
    await expect(readVaultHeaderDoc(FIXTURE_VAULT_ID)).resolves.toBeNull();
  });

  it('reads bytes plus the ETag version', async () => {
    const header = await fixtureHeader();
    use(
      http.get(`${API}${path}`, () =>
        HttpResponse.arrayBuffer(encodeHeaderDoc(header).buffer as ArrayBuffer, {
          headers: { ETag: vaultEtag(3) },
        }),
      ),
    );
    const result = await readVaultHeaderDoc(FIXTURE_VAULT_ID);
    expect(result).toMatchObject({ version: 3 });
    expect(result!.header).toEqual(header);
  });

  it('refuses bytes served without a version', async () => {
    use(http.get(`${API}${path}`, () => HttpResponse.arrayBuffer(new ArrayBuffer(8))));
    await expect(readVaultDoc(path)).rejects.toMatchObject({ code: 'VAULT_DOC_MISSING_ETAG' });
  });

  it('creates with If-None-Match and replaces with If-Match', async () => {
    const seen: (string | null)[] = [];
    use(
      http.put(`${API}${path}`, ({ request }) => {
        seen.push(request.headers.get('If-None-Match') ?? request.headers.get('If-Match'));
        return new HttpResponse(null, { status: 204, headers: { ETag: vaultEtag(2) } });
      }),
    );

    await expect(writeVaultDoc(path, new Uint8Array([1]), null)).resolves.toEqual({
      status: 'ok',
      version: 2,
    });
    await expect(writeVaultDoc(path, new Uint8Array([1]), 1)).resolves.toEqual({
      status: 'ok',
      version: 2,
    });
    expect(seen).toEqual(['*', '"1"']);
  });

  it('turns a lost CAS race into a conflict, never an overwrite', async () => {
    use(
      http.put(
        `${API}${path}`,
        () => new HttpResponse(null, { status: 412, headers: { ETag: vaultEtag(9) } }),
      ),
    );
    await expect(writeVaultDoc(path, new Uint8Array([1]), 4)).resolves.toEqual({
      status: 'conflict',
      currentVersion: 9,
    });
  });

  it('sends the CSRF header and the opaque content type on every doc write', async () => {
    const header = await fixtureHeader();
    let contentType: string | null = null;
    let csrf: string | null = null;
    use(
      http.put(`${API}${path}`, ({ request }) => {
        contentType = request.headers.get('Content-Type');
        csrf = request.headers.get('X-Requested-With');
        return new HttpResponse(null, { status: 204, headers: { ETag: vaultEtag(1) } });
      }),
    );
    await writeVaultHeaderDoc(FIXTURE_VAULT_ID, header, null);
    expect(contentType).toBe('application/octet-stream');
    expect(csrf).toBe('BetterTrack');
  });

  it('addresses portfolio and common docs on their own paths', () => {
    // These are the server PR's shapes (#1176) — no `/docs/` segment.
    expect(VAULT2_ROUTES.headerDoc(FIXTURE_VAULT_ID)).toBe(`/vaults/${FIXTURE_VAULT_ID}/header`);
    expect(VAULT2_ROUTES.portfolioDoc(FIXTURE_VAULT_ID, FIXTURE_PORTFOLIO_A)).toBe(
      `/vaults/${FIXTURE_VAULT_ID}/portfolios/${FIXTURE_PORTFOLIO_A}`,
    );
    expect(VAULT2_ROUTES.commonDoc(FIXTURE_VAULT_ID)).toBe(`/vaults/${FIXTURE_VAULT_ID}/common`);
  });

  it('round-trips a portfolio blob through a CAS-enforcing fake server', async () => {
    const docPath = VAULT2_ROUTES.portfolioDoc(FIXTURE_VAULT_ID, FIXTURE_PORTFOLIO_A);
    let stored: { bytes: Uint8Array; version: number } | null = null;
    use(
      http.get(`${API}${docPath}`, () =>
        stored == null
          ? new HttpResponse(null, { status: 404 })
          : HttpResponse.arrayBuffer(stored.bytes.buffer as ArrayBuffer, {
              headers: { ETag: vaultEtag(stored.version) },
            }),
      ),
      http.put(`${API}${docPath}`, async ({ request }) => {
        const ifMatch = request.headers.get('If-Match');
        const ifNone = request.headers.get('If-None-Match');
        if (ifNone === '*' && stored != null) {
          return new HttpResponse(null, {
            status: 412,
            headers: { ETag: vaultEtag(stored.version) },
          });
        }
        if (ifMatch != null && stored?.version !== Number(ifMatch.replaceAll('"', ''))) {
          return new HttpResponse(null, {
            status: 412,
            headers: stored == null ? undefined : { ETag: vaultEtag(stored.version) },
          });
        }
        stored = {
          bytes: new Uint8Array(await request.arrayBuffer()),
          version: (stored?.version ?? 0) + 1,
        };
        return new HttpResponse(null, {
          status: 204,
          headers: { ETag: vaultEtag(stored.version) },
        });
      }),
    );

    await expect(readVaultDoc(docPath)).resolves.toEqual({ status: 'absent' });
    await expect(writeVaultDoc(docPath, new Uint8Array([7, 7]), null)).resolves.toEqual({
      status: 'ok',
      version: 1,
    });
    // A second create loses the race instead of clobbering.
    await expect(writeVaultDoc(docPath, new Uint8Array([8]), null)).resolves.toEqual({
      status: 'conflict',
      currentVersion: 1,
    });
    // A stale replace loses too.
    await expect(writeVaultDoc(docPath, new Uint8Array([9]), 0)).resolves.toEqual({
      status: 'conflict',
      currentVersion: 1,
    });
    await expect(writeVaultDoc(docPath, new Uint8Array([9]), 1)).resolves.toEqual({
      status: 'ok',
      version: 2,
    });
    const read = await readVaultDoc(docPath);
    expect(read).toMatchObject({ status: 'ok', version: 2 });
  });
});

describe('re-authentication for the QR reveal', () => {
  it('accepts a correct password', async () => {
    use(http.post(`${API}/auth/reauth`, () => new HttpResponse(null, { status: 204 })));
    await expect(reauthenticate('hunter2')).resolves.toEqual({ status: 'ok' });
  });

  it('reports an invalid password without leaking which part was wrong', async () => {
    use(
      http.post(`${API}/auth/reauth`, () =>
        HttpResponse.json(
          { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' } },
          { status: 401 },
        ),
      ),
    );
    await expect(reauthenticate('nope')).resolves.toEqual({ status: 'invalid' });
  });

  it('surfaces a rate limit with its retry hint', async () => {
    use(
      http.post(`${API}/auth/reauth`, () =>
        HttpResponse.json(
          { error: { code: 'RATE_LIMITED', message: 'Too fast.' } },
          { status: 429, headers: { 'Retry-After': '30' } },
        ),
      ),
    );
    await expect(reauthenticate('hunter2')).resolves.toEqual({
      status: 'rate-limited',
      retryAfterSeconds: 30,
    });
  });

  it('fails CLOSED when the server has no re-auth route', async () => {
    use(
      http.post(`${API}/auth/reauth`, () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
      ),
    );
    // `unavailable` is a refusal, not permission to skip the gate — the QR
    // dialog test asserts the dialog stays closed on this result.
    await expect(reauthenticate('hunter2')).resolves.toEqual({ status: 'unavailable' });
  });
});
