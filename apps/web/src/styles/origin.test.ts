import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PHONE_SHELL_MAX_WIDTH } from '../user/hooks/useCompactShell';

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
  /** The `@media (max-width: 480px)` block, sliced off at the next top-level rule. */
  function phoneBlock(): string {
    const start = originCss.indexOf(`@media (max-width: ${PHONE_SHELL_MAX_WIDTH}px)`);
    if (start === -1) throw new Error('Missing the phone media block');
    const end = originCss.indexOf('/* One-pixel rule helpers', start);
    if (end === -1) throw new Error('Unterminated phone media block');
    return originCss.slice(start, end);
  }

  /** The later phone block dedicated to the portalled Control Center. */
  function controlPhoneBlock(): string {
    const controlStart = originCss.indexOf('/* ===== R2: control center ===== */');
    const start = originCss.indexOf(`@media (max-width: ${PHONE_SHELL_MAX_WIDTH}px)`, controlStart);
    if (start === -1) throw new Error('Missing the Control Center phone media block');
    const end = originCss.indexOf('/* ── Popup-native panel content', start);
    if (end === -1) throw new Error('Unterminated Control Center phone media block');
    return originCss.slice(start, end);
  }

  it('uses the gold edge only on the active mobile destination', () => {
    const activeEdge = tokenBlock('.bt-bottombar a.is-active::before');

    expect(activeEdge).toContain("content: ''");
    expect(activeEdge).toContain('background: var(--bt-gold)');
    expect(originCss).not.toContain('.bt-bottombar a::before {');
  });

  /**
   * The wrapped header row must come from wrapping alone. Flex `order` is
   * visual-only (Flexbox §5.4 — it changes paint order, never speech or
   * sequential navigation), so an `order`-reordered topbar sent Tab from the
   * second row back up to the first. The shell renders the switcher last at
   * this width instead (`usePhoneShell` / AppShell.test.tsx), and this keeps
   * the CSS from quietly reintroducing the divergence.
   */
  it('wraps the phone header without reordering any topbar child', () => {
    const phoneCss = phoneBlock();

    expect(phoneCss).toMatch(/\.bt-topbar > \.bt-portfolio-switcher \{[^}]*flex: 0 0 100%[^}]*\}/);
    expect(phoneCss).toContain('flex-wrap: wrap');
    expect(phoneCss).not.toMatch(/(^|[\s;{])order\s*:/);
  });

  /**
   * One breakpoint, two languages: the JS that MOVES the switcher and the CSS
   * that wraps it must flip at the same pixel, or the width band between them
   * has the DOM saying row one while the layout says row two.
   */
  it('declares the phone breakpoint the shell measures in JS', () => {
    expect(PHONE_SHELL_MAX_WIDTH).toBe(480);
    expect(originCss).toContain(`@media (max-width: ${PHONE_SHELL_MAX_WIDTH}px)`);
  });

  it('reserves safe areas and 44px targets at the phone breakpoint', () => {
    const phoneCss = phoneBlock();

    expect(indexHtml).toContain('viewport-fit=cover');
    for (const inset of ['top', 'right', 'bottom', 'left']) {
      expect(originCss).toContain(`env(safe-area-inset-${inset}, 0px)`);
    }
    expect(phoneCss).toContain('min-width: 44px');
    expect(phoneCss).toContain('min-height: 44px');
    expect(phoneCss).toContain('.bt-topbar .bt-popover :is(a, button, input, select, textarea)');
  });

  it('turns opted-in money dialogs into one-axis full-height phone sheets', () => {
    const phoneCss = phoneBlock();

    expect(phoneCss).toContain('.bt-dialog__panel.bt-dialog__panel--phone-sheet');
    expect(phoneCss).toContain('height: calc(100 * var(--bt-dvh))');
    expect(phoneCss).toContain('overflow-x: hidden');
    expect(phoneCss).toContain('overscroll-behavior: contain');
    expect(phoneCss).toContain('env(safe-area-inset-bottom, 0px)');
  });

  it('keeps Control Center header actions inside the phone sheet', () => {
    const phoneCss = controlPhoneBlock();

    expect(phoneCss).toMatch(/\.bt-cc-panel__head \{[^}]*flex-wrap: wrap[^}]*\}/);
    expect(phoneCss).toMatch(
      /\.bt-cc-panel__head \.bt-cc-row__control \{[^}]*width: auto[^}]*margin-left: auto[^}]*\}/,
    );
  });

  it('prevents iOS field zoom and contains dense money data at 390px', () => {
    const phoneCss = phoneBlock();

    expect(phoneCss).toContain('.bt-money-surface :is(input, select, textarea)');
    expect(phoneCss).toContain('font-size: 16px !important');
    expect(phoneCss).toContain('.bt-phone-scroll-table .bt-phone-scroll-table__lead');
    expect(phoneCss).toContain('position: sticky');
  });
});
