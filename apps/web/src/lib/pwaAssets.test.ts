import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface WebManifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

function pngDimensions(path: string): { height: number; width: number } {
  const png = readFileSync(resolve(process.cwd(), `public${path}`));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('installable PWA assets', () => {
  it('publishes a standalone root manifest with real 192px and 512px maskable icons', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8'),
    ) as WebManifest;

    expect(manifest).toMatchObject({
      name: 'BetterTrack Wealth Workspace',
      short_name: 'BetterTrack',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#090c10',
      theme_color: '#090c10',
    });
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512']);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.purpose.split(' ')).toContain('maskable');
      const size = Number(icon.sizes.split('x')[0]);
      expect(pngDimensions(icon.src)).toEqual({ height: size, width: size });
    }
  });

  it('keeps shared browser chrome metadata without advertising the user manifest', () => {
    const index = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

    expect(index).not.toContain('rel="manifest"');
    expect(index).toContain('media="(prefers-color-scheme: dark)"');
    expect(index).toContain('media="(prefers-color-scheme: light)"');
    expect(index).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(index).toContain('rel="apple-touch-icon"');
  });
});
