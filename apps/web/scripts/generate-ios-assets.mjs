#!/usr/bin/env node
// Generate the iOS installable-PWA asset pack from a single source icon.
//
// Every raster is derived from `apps/web/public/BT_AppIcon.png` composited on
// the app background (`#0b0e14`, neutral-950). Re-running this script with the
// same source + ImageMagick 6 recreates each PNG byte-for-comparable — no
// bespoke splash art is required (V6 beauty work is out of scope for #697).
//
// Requires: ImageMagick 6 `convert` on PATH.
// Run from repo root or apps/web:  node apps/web/scripts/generate-ios-assets.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '..', 'public');
const SOURCE = resolve(PUBLIC_DIR, 'BT_AppIcon.png');
const BACKGROUND = '#0b0e14';

// Home-screen icons — the sizes iOS Safari + PWA install criteria require.
// Icon fills ~80% of the frame so a maskable crop keeps the mark intact.
const ICONS = [
  { size: 180, out: 'apple-touch-icon-180.png' },
  { size: 192, out: 'icon-192.png' },
  { size: 512, out: 'icon-512.png' },
];

// iOS splash screens — one per portrait iPhone class currently supported.
// Physical-pixel PNGs; media queries in index.html match on CSS device-width /
// device-height / device-pixel-ratio.
const SPLASHES = [
  { width: 640, height: 1136, deviceWidth: 320, deviceHeight: 568, dpr: 2 },
  { width: 750, height: 1334, deviceWidth: 375, deviceHeight: 667, dpr: 2 },
  { width: 828, height: 1792, deviceWidth: 414, deviceHeight: 896, dpr: 2 },
  { width: 1125, height: 2436, deviceWidth: 375, deviceHeight: 812, dpr: 3 },
  { width: 1170, height: 2532, deviceWidth: 390, deviceHeight: 844, dpr: 3 },
  { width: 1179, height: 2556, deviceWidth: 393, deviceHeight: 852, dpr: 3 },
  { width: 1242, height: 2208, deviceWidth: 414, deviceHeight: 736, dpr: 3 },
  { width: 1242, height: 2688, deviceWidth: 414, deviceHeight: 896, dpr: 3 },
  { width: 1284, height: 2778, deviceWidth: 428, deviceHeight: 926, dpr: 3 },
  { width: 1290, height: 2796, deviceWidth: 430, deviceHeight: 932, dpr: 3 },
];

function assertConvert() {
  const check = spawnSync('convert', ['-version'], { encoding: 'utf8' });
  if (check.status !== 0) {
    throw new Error(
      'ImageMagick `convert` not found on PATH. Install it (Debian: apt install imagemagick) and re-run.',
    );
  }
}

function run(args) {
  const res = spawnSync('convert', args, { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`convert ${args.join(' ')} exited ${res.status}`);
  }
}

// Determinism guards — strip embedded timestamps / metadata so re-runs across
// hosts produce comparable PNGs.
const DETERMINISM = [
  '-strip',
  '-define',
  'png:exclude-chunks=date,time,tIME',
  '-define',
  'png:compression-level=9',
  '-define',
  'png:compression-filter=5',
  '-define',
  'png:compression-strategy=1',
];

function generateIcon({ size, out }) {
  const icon = Math.round(size * 0.8);
  const outPath = resolve(PUBLIC_DIR, out);
  run([
    '-size',
    `${size}x${size}`,
    `xc:${BACKGROUND}`,
    '(',
    SOURCE,
    '-resize',
    `${icon}x${icon}`,
    ')',
    '-gravity',
    'center',
    '-composite',
    ...DETERMINISM,
    outPath,
  ]);
  console.log(`icon  ${size}x${size} -> public/${out}`);
}

function generateSplash({ width, height }) {
  // Icon at ~30% of the shorter dimension keeps proportions on both narrow
  // iPhones (640×1136) and the largest 15 Pro Max (1290×2796).
  const iconSize = Math.round(Math.min(width, height) * 0.3);
  const name = `splash-${width}x${height}.png`;
  const outPath = resolve(PUBLIC_DIR, 'ios', name);
  run([
    '-size',
    `${width}x${height}`,
    `xc:${BACKGROUND}`,
    '(',
    SOURCE,
    '-resize',
    `${iconSize}x${iconSize}`,
    ')',
    '-gravity',
    'center',
    '-composite',
    ...DETERMINISM,
    outPath,
  ]);
  console.log(`splash ${width}x${height} -> public/ios/${name}`);
}

function main() {
  if (!existsSync(SOURCE)) {
    throw new Error(`Source icon missing: ${SOURCE}`);
  }
  assertConvert();
  mkdirSync(resolve(PUBLIC_DIR, 'ios'), { recursive: true });
  for (const icon of ICONS) generateIcon(icon);
  for (const splash of SPLASHES) generateSplash(splash);
  console.log(`\nGenerated ${ICONS.length} icons + ${SPLASHES.length} splashes.`);
}

main();
