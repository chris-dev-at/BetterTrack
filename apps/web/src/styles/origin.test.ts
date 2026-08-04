import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const originCss = readFileSync(resolve(process.cwd(), 'src/styles/origin.css'), 'utf8');
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

const OPAQUE_SURFACES = [
  '--bt-bg',
  '--bt-bg-raised',
  '--bt-nav',
  '--bt-surface',
  '--bt-surface-soft',
  '--bt-surface-strong',
  '--bt-surface-hover',
] as const;

const INFORMATIONAL_TEXT_TOKENS = ['--bt-muted', '--bt-faint'] as const;

type SurfaceToken = (typeof OPAQUE_SURFACES)[number];
type TextToken = (typeof INFORMATIONAL_TEXT_TOKENS)[number];

function tokenBlock(selector: string): string {
  const start = originCss.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing ${selector} token block`);

  const end = originCss.indexOf('\n}', start);
  if (end === -1) throw new Error(`Unclosed ${selector} token block`);

  return originCss.slice(start, end);
}

function declaredColor(block: string, token: SurfaceToken | TextToken): string {
  const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
  const color = match?.[1];
  if (!color) throw new Error(`Missing ${token} token`);
  return color;
}

function relativeLuminance(hex: string): number {
  const channel = (index: number) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };

  return channel(1) * 0.2126 + channel(3) * 0.7152 + channel(5) * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

describe('Origin informational text contrast', () => {
  const themes = [
    { name: 'dark', block: tokenBlock(':root') },
    { name: 'light', block: tokenBlock(":root[data-bt-theme='light']") },
  ] as const;

  for (const theme of themes) {
    for (const textToken of INFORMATIONAL_TEXT_TOKENS) {
      it(`keeps ${textToken} AA on every opaque ${theme.name} surface`, () => {
        const foreground = declaredColor(theme.block, textToken);
        const ratios = OPAQUE_SURFACES.map((surface) => ({
          surface,
          ratio: contrastRatio(foreground, declaredColor(theme.block, surface)),
        }));
        const weakest = ratios.reduce((lowest, ratio) =>
          ratio.ratio < lowest.ratio ? ratio : lowest,
        );

        expect(weakest.ratio, `${textToken} on ${weakest.surface}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('Origin phone chrome', () => {
  it('uses the gold edge only on the active mobile destination', () => {
    const activeEdge = tokenBlock('.bt-bottombar a.is-active::before');

    expect(activeEdge).toContain("content: ''");
    expect(activeEdge).toContain('background: var(--bt-gold)');
    expect(originCss).not.toContain('.bt-bottombar a::before {');
  });

  it('reserves safe areas and 44px targets at the phone breakpoint', () => {
    const phoneStart = originCss.indexOf('@media (max-width: 480px)');
    const phoneEnd = originCss.indexOf('/* One-pixel rule helpers', phoneStart);
    const phoneCss = originCss.slice(phoneStart, phoneEnd);

    expect(phoneStart).toBeGreaterThan(-1);
    expect(indexHtml).toContain('viewport-fit=cover');
    for (const inset of ['top', 'right', 'bottom', 'left']) {
      expect(originCss).toContain(`env(safe-area-inset-${inset}, 0px)`);
    }
    expect(phoneCss).toContain('min-width: 44px');
    expect(phoneCss).toContain('min-height: 44px');
  });
});
