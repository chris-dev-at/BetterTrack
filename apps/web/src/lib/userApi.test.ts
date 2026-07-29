import { afterEach, expect, test, vi } from 'vitest';

import { downloadDataExport } from './userApi';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('exchanges an export token in a POST body and downloads the binary response', async () => {
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
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:bettertrack-export');
  expect(document.querySelector('a[href="blob:bettertrack-export"]')).toBeNull();
});
