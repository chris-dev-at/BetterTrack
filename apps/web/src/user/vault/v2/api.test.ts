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

const SUMMARY = {
  id: FIXTURE_VAULT_ID,
  name: 'Drive vault',
  backends: ['drive'],
  createdAt: '2026-08-08T09:00:00.000Z',
  portfolioIds: [FIXTURE_PORTFOLIO_A],
};

async function fixtureHeader() {
  const built = await buildVaultHeader({
    vaultId: FIXTURE_VAULT_ID,
    name: 'Drive vault',
    backends: ['drive'],
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
  it('lists vaults and tolerates extra server fields', async () => {
    use(
      http.get(`${API}/vaults`, () =>
        HttpResponse.json({ items: [{ ...SUMMARY, futureField: 'ignored' }] }),
      ),
    );
    await expect(listVaults()).resolves.toEqual([SUMMARY]);
  });

  it('defaults portfolioIds when the server omits them', async () => {
    use(
      http.get(`${API}/vaults`, () =>
        HttpResponse.json({ items: [{ ...SUMMARY, portfolioIds: undefined }] }),
      ),
    );
    const vaults = await listVaults();
    expect(vaults[0]!.portfolioIds).toEqual([]);
  });

  it('creates a vault by posting the client-built header, id included', async () => {
    const header = await fixtureHeader();
    let received: Record<string, unknown> | null = null;
    use(
      http.post(`${API}/vaults`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        expect(request.headers.get('X-Requested-With')).toBe('BetterTrack');
        return HttpResponse.json(SUMMARY, { status: 201 });
      }),
    );

    await expect(
      createVault({
        id: FIXTURE_VAULT_ID,
        name: 'Drive vault',
        backends: ['drive'],
        header,
      }),
    ).resolves.toEqual(SUMMARY);

    expect(received).toMatchObject({
      id: FIXTURE_VAULT_ID,
      name: 'Drive vault',
      backends: ['drive'],
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
        return HttpResponse.json({ ...SUMMARY, backends: ['server', 'drive'] });
      }),
    );
    const updated = await updateVaultBackends(FIXTURE_VAULT_ID, ['server', 'drive']);
    expect(body).toEqual({ backends: ['server', 'drive'] });
    expect(updated.backends).toEqual(['server', 'drive']);
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

describe('join and leave', () => {
  it('posts finished ciphertext to POST /portfolios/{id}/vault', async () => {
    const blob = new Uint8Array([1, 2, 3, 4]);
    let body: Record<string, unknown> | null = null;
    use(
      http.post(`${API}/portfolios/${FIXTURE_PORTFOLIO_A}/vault`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          portfolioId: FIXTURE_PORTFOLIO_A,
          vaultId: FIXTURE_VAULT_ID,
          blobVersion: 1,
        });
      }),
    );

    await expect(
      joinPortfolioToVault({
        portfolioId: FIXTURE_PORTFOLIO_A,
        vaultId: FIXTURE_VAULT_ID,
        blob,
      }),
    ).resolves.toEqual({
      portfolioId: FIXTURE_PORTFOLIO_A,
      vaultId: FIXTURE_VAULT_ID,
      blobVersion: 1,
    });
    expect(body).toEqual({ vaultId: FIXTURE_VAULT_ID, blob: bytesToBase64(blob) });
  });

  it('sends the plaintext rows back on leave', async () => {
    let body: Record<string, unknown> | null = null;
    use(
      http.delete(`${API}/portfolios/${FIXTURE_PORTFOLIO_A}/vault`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          portfolioId: FIXTURE_PORTFOLIO_A,
          restoredAt: '2026-08-08T10:00:00.000Z',
        });
      }),
    );

    const document = { schemaVersion: 1, entities: [] };
    await expect(
      leavePortfolioVault({ portfolioId: FIXTURE_PORTFOLIO_A, document }),
    ).resolves.toMatchObject({ portfolioId: FIXTURE_PORTFOLIO_A });
    expect(body).toEqual({ document });
  });
});

describe('doc transport (CAS)', () => {
  const path = VAULT2_ROUTES.headerDoc(FIXTURE_VAULT_ID);

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
    expect(VAULT2_ROUTES.portfolioDoc(FIXTURE_VAULT_ID, FIXTURE_PORTFOLIO_A)).toBe(
      `/vaults/${FIXTURE_VAULT_ID}/docs/portfolio/${FIXTURE_PORTFOLIO_A}`,
    );
    expect(VAULT2_ROUTES.commonDoc(FIXTURE_VAULT_ID)).toBe(
      `/vaults/${FIXTURE_VAULT_ID}/docs/common`,
    );
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
