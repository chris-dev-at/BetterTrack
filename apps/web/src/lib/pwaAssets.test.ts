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
  lang: string;
  dir: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  orientation: string;
  categories: string[];
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

/** IHDR is fixed-offset in every PNG: width, height, bit depth, colour type. */
function pngHeader(path: string): { color: number; height: number; width: number } {
  const png = readFileSync(resolve(process.cwd(), `public${path}`));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), color: png[25]! };
}

function readIndexHtml(): string {
  return readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
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
      expect(pngHeader(icon.src)).toMatchObject({ height: size, width: size });
    }
  });

  /**
   * V5-P13b manifest polish. `lang`/`dir` decide how an install target renders
   * the app's own name; `orientation` and `categories` are what an installed
   * window and a store surface read. `display_override` degrades to `minimal-ui`
   * rather than all the way back to a browser tab.
   *
   * `shortcuts` is DELIBERATELY absent: a manifest carries exactly one language,
   * so every shortcut label would ship untranslated into a DE user's home
   * screen — a hardcoded string, which §7.1 makes a blocking finding. It returns
   * when (if) the app serves a per-locale manifest.
   */
  it('declares the language, orientation and install-target metadata', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8'),
    ) as WebManifest;

    expect(manifest).toMatchObject({
      lang: 'en',
      dir: 'ltr',
      orientation: 'any',
      display_override: ['standalone', 'minimal-ui'],
      categories: ['finance', 'productivity'],
    });
    expect(manifest).not.toHaveProperty('shortcuts');
  });

  /**
   * iOS masks the whole square into a squircle itself and ignores the maskable
   * safe zone, so the padded 192 rendered the mark small and inset. The idiom is
   * its own asset: 180×180, and OPAQUE (PNG colour type 2 — truecolour, no
   * alpha), because iOS composites a transparent touch icon onto black.
   */
  it('ships a dedicated 180x180 opaque apple-touch-icon, not the maskable 192', () => {
    expect(pngHeader('/icons/bettertrack-apple-touch-180.png')).toEqual({
      width: 180,
      height: 180,
      color: 2,
    });

    const index = readIndexHtml();
    expect(index).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/icons/bettertrack-apple-touch-180.png" />',
    );
    expect(index).not.toContain('rel="apple-touch-icon" sizes="192x192"');
  });

  it('keeps shared browser chrome metadata without advertising the user manifest', () => {
    const index = readIndexHtml();

    expect(index).not.toContain('rel="manifest"');
    expect(index).toContain('media="(prefers-color-scheme: dark)"');
    expect(index).toContain('media="(prefers-color-scheme: light)"');
    expect(index).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(index).toContain('rel="apple-touch-icon"');
  });

  /**
   * The two §7.1 clauses the install work must not have disturbed: the worker
   * never touches `/api`, and a failed navigation lands on the branded offline
   * page. Asserted against the worker source because it is a plain file served
   * from `public/`, outside the bundle and outside every component test.
   */
  it('keeps the service worker off /api and still serving the branded offline page', () => {
    const worker = readFileSync(resolve(process.cwd(), 'public/service-worker.js'), 'utf8');

    expect(worker).toContain("const OFFLINE_URL = '/offline.html';");
    expect(worker).toMatch(/function isApiPath\(pathname\)[\s\S]*?\/api\//u);
    // The guard runs inside the fetch handler and returns before any
    // respondWith, so API traffic is left entirely to the browser.
    expect(worker).toMatch(
      /if \(url\.origin !== self\.location\.origin \|\| isApiPath\(url\.pathname\)\) return;/u,
    );
    expect(worker).toContain('cache.match(OFFLINE_URL)');

    const offline = readFileSync(resolve(process.cwd(), 'public/offline.html'), 'utf8');
    expect(offline).toContain('BetterTrack');
  });
});
