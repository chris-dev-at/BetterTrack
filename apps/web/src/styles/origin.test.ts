import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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

/**
 * The pixel below the admin drawer's `md` handoff (#1756). Spelled here rather
 * than imported: `AdminLayout` is a React module and this is a text assertion
 * over a stylesheet, so the test asserts the 768px source of truth separately
 * instead of pulling the console shell into a CSS test.
 */
const ADMIN_DRAWER_MAX_WIDTH = '767.98';

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

  /**
   * The admin console's own floor block. It is keyed to the console drawer's
   * `md` handoff (767.98px), not the 480px phone width above, so it is sliced
   * separately — see the test that asserts it.
   */
  function adminTapTargetBlock(): string {
    const start = originCss.indexOf(`@media (max-width: ${ADMIN_DRAWER_MAX_WIDTH}px)`);
    if (start === -1) throw new Error('Missing the admin tap-target media block');
    const end = originCss.indexOf('}\n}', start);
    if (end === -1) throw new Error('Unterminated admin tap-target media block');
    return originCss.slice(start, end);
  }

  /**
   * The palette's own phone block — the one declared AFTER the base
   * `.bt-palette__row` rule. Sliced from the base rule forward precisely so a
   * floor that drifted back into an earlier block cannot satisfy the assertion:
   * both selectors are (0,1,0), `@media` adds no specificity, and the cascade
   * therefore falls to source order.
   */
  function palettePhoneBlock(): { start: number; block: string } {
    const base = originCss.indexOf('.bt-palette__row {');
    if (base === -1) throw new Error('Missing the base palette row rule');
    const start = originCss.indexOf(`@media (max-width: ${PHONE_SHELL_MAX_WIDTH}px)`, base);
    if (start === -1) throw new Error('Missing the palette phone media block');
    const end = originCss.indexOf('}\n}', start);
    if (end === -1) throw new Error('Unterminated palette phone media block');
    return { start, block: originCss.slice(start, end) };
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
   * The rows INSIDE the overlays the phone gate opens (#1834). The topbar rule
   * asserted above stops at `.bt-topbar`, so a menu the page owns kept the
   * 32px `.bt-menu-item` row and the command palette — primary navigation on a
   * phone — kept its 38px row, neither declared nor measured. Both halves are
   * asserted here as text and in `e2e/mobile-overflow.spec.ts` as geometry.
   *
   * Presence is not enough for either half. Both floors reuse the very selector
   * they are overriding, so they carry the same (0,1,0) specificity as the base
   * rule and `@media` adds none — the winner is decided by SOURCE ORDER alone.
   * A floor declared before its base rule computes to the compact height at
   * every phone width while still reading, in the file and to a presence-only
   * test, as though it applied. So each half asserts the order too.
   */
  it('gives content-owned menu rows and palette rows the same 44px floor', () => {
    const phoneCss = phoneBlock();
    const phoneStart = originCss.indexOf(`@media (max-width: ${PHONE_SHELL_MAX_WIDTH}px)`);

    expect(phoneCss).toMatch(
      /\.bt-menu-item,\s*\.bt-popover :is\(\[role='menuitem'\], \[role='menuitemcheckbox'\], \[role='menuitemradio'\]\) \{[^}]*min-height: 44px;/,
    );
    // `.bt-menu-item`'s base rule is declared BEFORE this phone block, so the
    // floor above wins. Moving the base below the block would silently undo it.
    const menuItemBase = originCss.indexOf('.bt-menu-item {');
    expect(menuItemBase, 'the base .bt-menu-item rule must exist').toBeGreaterThan(-1);
    expect(
      menuItemBase,
      'the 32px base must stay ABOVE the phone block, or the 44px floor loses the cascade',
    ).toBeLessThan(phoneStart);

    // The palette's base rule is the other way round — declared far below this
    // block — so its floor lives in the palette section's own phone block, and
    // must not be (re)declared up here where it would be dead.
    expect(
      phoneCss,
      'a palette floor in the first phone block is overridden by the base rule below it',
    ).not.toContain('.bt-palette__row');
    const palettePhone = palettePhoneBlock();
    expect(palettePhone.block).toMatch(/\.bt-palette__row \{[^}]*min-height: 44px;/);
    expect(
      palettePhone.start,
      'the palette floor must be declared after the 38px base rule it overrides',
    ).toBeGreaterThan(originCss.indexOf('.bt-palette__row {'));

    // The rules the rows above override must stay the compact desktop density,
    // or this floor would be silently redundant — and the console, which is
    // Tailwind-only, must remain out of their reach (#1057 owns that half).
    expect(originCss).toMatch(/\.bt-menu-item \{[^}]*min-height: 32px;/);
    expect(originCss).toMatch(/\.bt-palette__row \{[^}]*min-height: 38px;/);
  });

  /**
   * The admin console's half of the same contract (#1756). The console is
   * Tailwind-utility-only, so the `.bt-*` rule above cannot reach it and its
   * controls carry density utilities (`min-h-[30px]`, `h-9 w-9`) that are all
   * below 44px on a phone. Its floor is keyed on the single marker class
   * `admin/components/tokens.ts` composes.
   *
   * Its breakpoint is NOT this file's 480px phone width but 767.98px, the pixel
   * below Tailwind's `md`: the console's sidebar is `md:block` and its drawer
   * `md:hidden`, so the burger and the drawer rows are the only navigation the
   * console has all the way up to 768px. Asserting the query text as well as
   * the declaration is what keeps that from silently sliding back to 480px and
   * leaving 481–767px with a 36px burger.
   *
   * Both directions are asserted: the rule is declared, and the class stays
   * console-only — a rule in this stylesheet that started matching Origin
   * elements would be exactly the leak the console's token module refuses. The
   * measuring half is the admin matrix in `e2e/mobile-overflow.spec.ts`.
   */
  it('gives the admin console a 44px floor of its own, reaching nothing in Origin', () => {
    expect(adminTapTargetBlock()).toMatch(
      /\.admin-tap-target \{[^}]*min-width: 44px;[^}]*min-height: 44px;/,
    );
    // The console's own drawer breakpoint, not the user app's phone width.
    expect(phoneBlock()).not.toContain('.admin-tap-target');
    expect(
      readFileSync(resolve(process.cwd(), 'src/admin/components/tokens.ts'), 'utf8'),
    ).toContain("export const TAP_TARGET = 'admin-tap-target'");
    expect(
      readFileSync(resolve(process.cwd(), 'src/admin/components/AdminLayout.tsx'), 'utf8'),
      'The drawer the floor exists for must still retire at the same 768px handoff.',
    ).toContain('ADMIN_DESKTOP_MIN_WIDTH_PX = 768');

    const webRoot = process.cwd();
    const leaks = ['src/user', 'src/ui', 'src/components']
      .flatMap((directory) => sourceFilesBelow(resolve(webRoot, directory)))
      .filter((file) => readFileSync(file, 'utf8').includes('admin-tap-target'))
      .map((file) => relative(webRoot, file));
    expect(
      leaks,
      'admin-tap-target scopes the rule to the console; nothing in Origin may wear it.',
    ).toEqual([]);
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

  /**
   * `.bt-table-wrap` is the only scroll container the table styles offer — a
   * `.bt-table` declares no `overflow-x` of its own — so a table outside one has
   * nowhere to scroll and, with `nowrap` headers and a width that is a minimum
   * rather than a maximum, no way to compress either (#1878). The home board's
   * own table takes the container for that scroll alone: the `--bare` modifier
   * drops the wrap's rules, which would otherwise box an un-boxed widget.
   */
  it('keeps every table inside the one scroll container the table styles offer', () => {
    expect(originCss).toMatch(/\.bt-table-wrap \{[^}]*overflow-x: auto;/);
    // The wrap holds that role only while no table rule grows its own scroll:
    // a `.bt-table*` selector declaring overflow-x would make the container
    // optional, and the assertion below stop meaning anything.
    const tableRulesWithScroll = [...originCss.matchAll(/\n(\.bt-table[^,{]*)[^{]*\{([^}]*)\}/g)]
      .filter(([, , body]) => body!.includes('overflow-x'))
      .map(([, selector]) => selector!.trim());
    expect(
      tableRulesWithScroll,
      'only .bt-table-wrap may declare a table scroll axis, or the wrap stops being load-bearing',
    ).toEqual(['.bt-table-wrap']);
    const bare = originCss.indexOf('.bt-table-wrap--bare {');
    expect(bare, 'Missing the borderless scroll-container modifier').toBeGreaterThan(-1);
    expect(originCss.slice(bare)).toMatch(/\.bt-table-wrap--bare \{[^}]*border-block: 0;/);
    expect(
      bare,
      'the modifier must be declared after the rule it overrides — equal specificity, source order decides',
    ).toBeGreaterThan(originCss.indexOf('.bt-table-wrap {'));

    const homeTable = readFileSync(
      resolve(process.cwd(), 'src/user/home/widgets/PortfolioCardsWidget.tsx'),
      'utf8',
    );
    expect(
      homeTable,
      'the home board table must sit in the scroll container like every other .bt-table',
    ).toContain('<div className="bt-table-wrap bt-table-wrap--bare">');
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

  /**
   * The card and the AskDock claim the same corner and the same layer, and the
   * dock — rendered deeper in the tree — wins the paint. Without this rule the
   * card, dismiss button included, is unreachable while the dock is open.
   */
  it('yields the corner to the AskDock, which shares it and paints above', () => {
    expect(originCss).toMatch(/\.bt-askdock \{[^}]*right: 16px;[^}]*z-index: 45;/);
    expect(originCss).toMatch(
      /html\[data-bt-askdock='open'\] \.bt-install-prompt \{\s*display: none;\s*\}/,
    );
  });

  /**
   * The card's own tap-target floor (#1878). Its actions are `size="sm"`, and
   * the phone block lifts only `.bt-btn--icon`, `.bt-iconbtn`, `.bt-tab` and
   * `.bt-topbar .bt-btn` to 44px — so the dismiss X cleared the floor as an
   * icon button while the INSTALL action, the only install path left once
   * `beforeinstallprompt` is preventDefault-ed, rendered 58×28 at every phone
   * profile. Source order is asserted as well as presence: `.bt-btn--sm` is
   * declared far above and `@media` adds no specificity, so a floor that
   * drifted above it would read as applied while computing to 28px. The
   * measuring half is the install-affordance step in
   * `e2e/mobile-overflow.spec.ts`.
   */
  it('gives the install card its own 44px floor, below the base sm button rule', () => {
    const cardPhoneStart = originCss.indexOf(
      '@media (max-width: 760px)',
      originCss.indexOf('.bt-install-prompt {'),
    );
    expect(cardPhoneStart, 'Missing the install card phone media block').toBeGreaterThan(-1);
    const cardPhoneBlock = originCss.slice(
      cardPhoneStart,
      originCss.indexOf('}\n}', cardPhoneStart),
    );

    expect(cardPhoneBlock).toMatch(
      /\.bt-install-prompt \.bt-btn \{[^}]*min-height: 44px;[^}]*min-width: 44px;/,
    );
    const smallButtonBase = originCss.indexOf('.bt-btn--sm {');
    expect(smallButtonBase, 'the base .bt-btn--sm rule must exist').toBeGreaterThan(-1);
    expect(
      cardPhoneStart,
      'the floor must stay BELOW the 28px .bt-btn--sm rule it overrides',
    ).toBeGreaterThan(smallButtonBase);
    // The rule it overrides stays the compact desktop density, or the floor
    // above would be silently redundant.
    expect(originCss).toMatch(/\.bt-btn--sm \{[^}]*min-height: 28px;/);
  });

  it('compensates the translucent status bar in a standalone window, both ways', () => {
    // The media query is the standard; the attribute is what pwaDisplayMode.ts
    // stamps from `navigator.standalone`, the only signal iOS below 16.4 gives.
    expect(originCss).toMatch(
      /@media \(display-mode: standalone\) \{[\s\S]*?\.bt-topbar \{[^}]*padding-top: calc\(6px \+ env\(safe-area-inset-top, 0px\)\);/,
    );
    expect(originCss).toMatch(
      /:root\[data-bt-display-mode='standalone'\] \.bt-topbar \{[^}]*padding-top: calc\(6px \+ env\(safe-area-inset-top, 0px\)\);/,
    );
    // The standalone longhand overrides the phone rule's shorthand at equal
    // specificity, so its base must stay that rule's own 6px: anything else
    // silently re-tunes the phone topbar while claiming to add only the inset.
    expect(originCss).toMatch(
      /@media \(max-width: 480px\) \{[\s\S]*?\.bt-topbar \{[^}]*padding: calc\(6px \+ env\(safe-area-inset-top, 0px\)\)/,
    );
    expect(originCss).toMatch(
      /:root\[data-bt-display-mode='standalone'\] body \{[^}]*overscroll-behavior-y: none;/,
    );
  });
});

/** Every `.ts`/`.tsx` source below a directory, for the scope assertions above. */
function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
