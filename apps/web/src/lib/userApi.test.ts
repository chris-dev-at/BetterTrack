import { afterEach, expect, test, vi } from 'vitest';

import { ApiError, setAuthResponsePolicy } from './apiClient';
import {
  deleteDriveConnection,
  disableParanoidMode,
  downloadDataExport,
  listRememberedDevices,
  revokeAllRememberedDevices,
  revokeRememberedDevice,
} from './userApi';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('exchanges an export token in a POST body and downloads the binary response', async () => {
  vi.useFakeTimers();
  const responseBlob = new Blob(['zip-bytes'], { type: 'application/zip' });
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-disposition'
          ? 'attachment; filename="bettertrack-export-2026-07-29.zip"'
          : null,
    },
    blob: () => Promise.resolve(responseBlob),
  } as Response);
  const createObjectURL = vi.fn(() => 'blob:bettertrack-export');
  const revokeObjectURL = vi.fn();
  let clicked: { href: string; download: string } | null = null;

  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked = { href: this.href, download: this.download };
  });

  await downloadDataExport({ token: 'raw-token-that-must-not-enter-a-url' });

  expect(fetchMock).toHaveBeenCalledWith('/api/v1/account/export/download', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'BetterTrack',
    },
    body: JSON.stringify({ token: 'raw-token-that-must-not-enter-a-url' }),
    credentials: 'include',
  });
  expect(fetchMock.mock.calls[0]?.[0]).not.toContain('?');
  expect(createObjectURL).toHaveBeenCalledWith(responseBlob);
  expect(clicked).toEqual({
    href: 'blob:bettertrack-export',
    download: 'bettertrack-export-2026-07-29.zip',
  });
  expect(revokeObjectURL).not.toHaveBeenCalled();
  expect(document.querySelector('a[href="blob:bettertrack-export"]')).toBeNull();

  vi.runOnlyPendingTimers();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:bettertrack-export');
});

test('lists and revokes trusted-device bindings through the live auth routes', async () => {
  const devices = [
    {
      handle: 'safe-handle',
      createdAt: '2026-07-01T08:00:00.000Z',
      lastSeenAt: null,
      expiresAt: '2026-08-01T08:00:00.000Z',
    },
  ];
  const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ devices }))
    .mockResolvedValueOnce(jsonResponse({ ok: true }))
    .mockResolvedValueOnce(jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(listRememberedDevices()).resolves.toEqual(devices);
  await revokeRememberedDevice('safe/handle');
  await revokeAllRememberedDevices();

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    '/api/v1/auth/remembered-devices',
    expect.objectContaining({ method: 'GET', credentials: 'include' }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/v1/auth/remembered-devices/safe%2Fhandle',
    expect.objectContaining({
      method: 'DELETE',
      headers: { 'X-Requested-With': 'BetterTrack' },
      credentials: 'include',
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    '/api/v1/auth/remembered-devices',
    expect.objectContaining({
      method: 'DELETE',
      headers: { 'X-Requested-With': 'BetterTrack' },
      credentials: 'include',
    }),
  );
});

test('sends the §15 disconnect credential in the body, never the query, and only the gated call opts out of the auth policy', async () => {
  const onUnauthorized = vi.fn();
  const dispose = setAuthResponsePolicy({ onUnauthorized });
  try {
    const noContent = () => new Response(null, { status: 204 });
    const fetchMock = vi.fn().mockResolvedValueOnce(noContent()).mockResolvedValueOnce(noContent());
    vi.stubGlobal('fetch', fetchMock);

    // The unacknowledged probe DISCOVERS the binding: no credential, no body,
    // and no acknowledgement in the query.
    await deleteDriveConnection('conn-1');
    const [probeUrl, probeInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(probeUrl).toBe('/api/v1/drive-connections/conn-1');
    expect(probeUrl).not.toContain('acknowledgeBound');
    expect(probeInit.body).toBeUndefined();
    expect(probeInit.headers).not.toHaveProperty('Content-Type');

    // The acknowledged form is the §15 gated one: the acknowledgement rides the
    // QUERY and the credential rides the BODY. A credential in a URL would land
    // in access logs, referrers and browser history — it must never appear there.
    await deleteDriveConnection('conn-1', true, { password: 'super-secret-passphrase' });
    const [gatedUrl, gatedInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(gatedUrl).toBe('/api/v1/drive-connections/conn-1?acknowledgeBound=true');
    expect(gatedUrl).not.toMatch(/super-secret-passphrase|stepUp|password|code|recoveryCode/);
    expect(JSON.parse(gatedInit.body as string)).toEqual({
      stepUp: { password: 'super-secret-passphrase' },
    });

    // `suppressAuthRedirect` is set on the gated call ONLY: a refused credential
    // is an in-form error there, while a 401 on the ungated probe really does
    // mean the session is gone and must still clear it.
    const unauthorized = () =>
      new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'no' } }), {
        status: 401,
      });
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(unauthorized());

    await expect(
      deleteDriveConnection('conn-1', true, { password: 'wrong' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();

    await expect(deleteDriveConnection('conn-1')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  } finally {
    dispose();
  }
});

/**
 * #2000 — the locked-vault "start fresh" exit is the fifth credential-carrying
 * destructive call (`docs/paranoid-design.md` §15/§17). Its `discard: true` form
 * carries the `DELETE /account` rung — the typed username plus a server-verified
 * password / TOTP code / recovery code — so a wrong one comes back as the same
 * generic 401 every §15 refusal uses, and must leave the owner standing in the
 * stuck-unlock dialog rather than signing them out of the session they still
 * hold. The RESTORING disable carries no credential, so its 401 is a real
 * expiry and must still clear the session: that is the negative half below,
 * without which this pin would pass on a module that suppressed everything.
 */
const STRICT_RESTORE_DOCUMENT = {
  schemaVersion: 1 as const,
  entities: [],
  mergeLog: [],
  mirrorProvenance: [],
};

test('§15 discard refuses in-form, while the restoring disable still clears an expired session', async () => {
  const onUnauthorized = vi.fn();
  const dispose = setAuthResponsePolicy({ onUnauthorized });
  try {
    const unauthorized = () =>
      new Response(
        JSON.stringify({
          error: { code: 'INVALID_CREDENTIALS', message: 'Re-authentication failed.' },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    const fetchMock = vi.fn().mockResolvedValue(unauthorized());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      disableParanoidMode({
        rehydrationId: '018f6a3e-7777-7000-8000-000000000041',
        document: STRICT_RESTORE_DOCUMENT,
        confirm: true,
        discard: true,
        confirmUsername: 'ada',
        password: 'mistyped-account-password',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    // The credential rides the body, never the URL: it would otherwise land in
    // access logs, referrers and history.
    const [discardUrl, discardInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(discardUrl).toBe('/api/v1/account/paranoid/disable');
    expect(discardUrl).not.toMatch(/mistyped-account-password|password|recoveryCode/);
    expect(JSON.parse(discardInit.body as string)).toMatchObject({
      discard: true,
      password: 'mistyped-account-password',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();

    await expect(
      disableParanoidMode({
        rehydrationId: '018f6a3e-7777-7000-8000-000000000042',
        document: STRICT_RESTORE_DOCUMENT,
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  } finally {
    dispose();
  }
});
