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
    // The edge is a MARK, not text, so it rides the graphic half of the gold
    // split (THEME2) — which is what keeps it visible on the white phone bar.
    expect(activeEdge).toContain('background: var(--bt-gold-graphic)');
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

  /**
   * Half one of two. This asserts the 44px rule is DECLARED for the contracted
   * selectors; it cannot see whether the rendered box survives layout. The
   * measuring half runs in `e2e/mobile-overflow.spec.ts` (#1663), which takes a
   * real `boundingBox()` for these exact selectors on every swept phone surface
   * — so this stays as the fast text guard rather than being narrowed away.
   */
  it('reserves safe areas and 44px targets at the phone breakpoint', () => {
    const phoneCss = phoneBlock();

    expect(indexHtml).toContain('viewport-fit=cover');
    for (const inset of ['top', 'right', 'bottom', 'left']) {
      expect(originCss).toContain(`env(safe-area-inset-${inset}, 0px)`);
    }
    expect(phoneCss).toContain('min-width: 44px');
    expect(phoneCss).toContain('min-height: 44px');
    expect(phoneCss).toMatch(
      /\.bt-btn--icon,\s*\.bt-iconbtn,\s*\.bt-tab \{[^}]*min-width: 44px;[^}]*min-height: 44px;/,
    );
    expect(phoneCss).toContain('.bt-topbar .bt-popover :is(a, button, input, select, textarea)');
  });

  /**
   * The topbar menus position themselves with inline `right: 0`, which is only
   * safe while the containing block is the header itself — anchored to their
   * own trigger instead, a menu wider than the gap to the right gutter runs off
   * the left edge of a 360px screen (#1663). The measuring half is the overlay
   * sweep in `e2e/mobile-overflow.spec.ts`; this is the fast text guard that
   * the re-anchor is still declared, and that every menu still opts in.
   *
   * The file list is exactly the components that render a direct child of
   * `.bt-topbar__actions` — the only container the CSS rule targets, so a
   * popover anywhere else neither needs the opt-in nor is helped by it. Add a
   * file here when a new chip or menu joins that row.
   */
  it('re-anchors phone topbar menus to the header instead of their trigger', () => {
    const phoneCss = phoneBlock();

    expect(phoneCss).toMatch(
      /\.bt-topbar__actions > \.bt-menu-anchor \{[^}]*position: static;[^}]*\}/,
    );

    const topbarActionSources = [
      'src/user/components/OriginShell.tsx',
      'src/user/components/NotificationBell.tsx',
      'src/user/vault/ui/VaultSyncChip.tsx',
    ] as const;
    for (const source of topbarActionSources) {
      const tsx = readFileSync(resolve(process.cwd(), source), 'utf8');
      // Count the class where it is APPLIED, so a mention in a comment cannot
      // stand in for a wrapper that actually opts in.
      const anchors = tsx.match(/className="bt-menu-anchor/g) ?? [];
      const popovers = tsx.match(/className="bt-popover/g) ?? [];
      expect(popovers.length, `${source} should still render a popover`).toBeGreaterThan(0);
      expect(anchors.length, `${source} must anchor every popover it renders`).toBe(
        popovers.length,
      );
    }
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

    expect(phoneCss).toMatch(
      /\n\s*:is\(input, select, textarea\) \{\s*font-size: 16px !important;/,
    );
    expect(phoneCss).toContain('.bt-money-surface :is(input, select, textarea)');
    expect(phoneCss).toContain('font-size: 16px !important');
    expect(phoneCss).toContain('.bt-phone-scroll-table .bt-phone-scroll-table__lead');
    expect(phoneCss).toContain('position: sticky');
  });

  it('prevents iOS field zoom for coarse pointers beyond the phone breakpoint', () => {
    expect(originCss).toMatch(
      /@media \(pointer: coarse\) \{\s*:is\(input, select, textarea\) \{\s*font-size: 16px !important;/,
    );
  });
});

describe('Origin accessibility safety nets', () => {
  it('styles component-rendered required markers instead of generated label content', () => {
    expect(originCss).toMatch(
      /\.bt-field__label \{[^}]*display: flex;[^}]*column-gap: 2px;[^}]*\}/,
    );
    expect(originCss).toMatch(/\.bt-field__required-marker \{[^}]*color: var\(--bt-neg\);/);
    expect(originCss).not.toContain('label::after');
    expect(originCss).not.toContain("content: ' *'");
  });

  it('limits any unhandled motion while preserving component-specific rules', () => {
    expect(originCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{[^}]*animation-duration: 0\.01ms !important;[^}]*animation-iteration-count: 1 !important;[^}]*scroll-behavior: auto !important;[^}]*transition-duration: 0\.01ms !important;/,
    );
    expect(originCss).toContain('.bt-skeleton::after');
  });
});

/**
 * The installable-PWA rules (§7.1, V5-P13b). Both halves are stylesheet-only
 * behaviour that no component test can observe: jsdom applies no CSS, so the
 * fixed positioning and the standalone block are asserted against the source.
 */
describe('Installable PWA', () => {
  it('floats the install affordance out of the document flow (anti-bloat)', () => {
    // Binding owner rule: no shipped feature may make the app feel more
    // bloated. `position: fixed` is what keeps this card from taking a single
    // pixel of any page's layout.
    expect(originCss).toMatch(/\.bt-install-prompt \{[^}]*position: fixed;[^}]*\}/);
    expect(originCss).toMatch(/\.bt-install-prompt \{[^}]*env\(safe-area-inset-bottom, 0px\)/);
    // Clear of the bottom bar, which owns the foot of a phone screen.
    expect(originCss).toMatch(
      /\.bt-install-prompt \{\s*right: calc\(12px[^}]*bottom: calc\(72px[^}]*\}/,
    );
  });

  it('compensates the translucent status bar in a standalone window, both ways', () => {
    // The media query is the standard; the attribute is what pwaDisplayMode.ts
    // stamps from `navigator.standalone`, the only signal iOS below 16.4 gives.
    expect(originCss).toMatch(
      /@media \(display-mode: standalone\) \{[\s\S]*?\.bt-topbar \{[^}]*padding-top: calc\(10px \+ env\(safe-area-inset-top, 0px\)\);/,
    );
    expect(originCss).toMatch(
      /:root\[data-bt-display-mode='standalone'\] \.bt-topbar \{[^}]*padding-top: calc\(10px \+ env\(safe-area-inset-top, 0px\)\);/,
    );
    expect(originCss).toMatch(
      /:root\[data-bt-display-mode='standalone'\] body \{[^}]*overscroll-behavior-y: none;/,
    );
  });
});
