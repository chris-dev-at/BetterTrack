import { afterEach, expect, test, vi } from 'vitest';

import {
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
