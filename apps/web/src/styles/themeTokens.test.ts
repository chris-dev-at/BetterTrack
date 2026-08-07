import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { THEME_CANVAS, THEME_STORAGE_KEY } from '../user/theme';

/**
 * The two-theme gate (board #68).
 *
 * Three jobs, in the order they matter:
 *
 *  1. DARK MUST NOT MOVE. Adding a light theme meant lifting three dozen colour
 *     literals out of components and rules into tokens. Every one of those was
 *     supposed to be a pure re-housing, and "supposed to" is not a review
 *     standard — so the dark values are pinned here against the literals they
 *     replaced. A typo'd digit fails as a named diff instead of as a slightly
 *     wrong shade nobody notices for a month.
 *  2. LIGHT MUST BE LEGIBLE. Every light ink is checked against every opaque
 *     light surface, and against its own tinted background where it is used on
 *     one, at the WCAG AA 4.5:1 floor.
 *  3. NEW LITERALS MUST NOT APPEAR. A colour written into a component is a
 *     component that only has one theme. The scan below fails on new ones.
 */

const webRoot = resolve(process.cwd());
const originCss = readFileSync(join(webRoot, 'src/styles/origin.css'), 'utf8');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');

function tokenBlock(selector: string): string {
  const start = originCss.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing ${selector} token block`);
  const end = originCss.indexOf('\n}', start);
  if (end === -1) throw new Error(`Unclosed ${selector} token block`);
  return originCss.slice(start, end);
}

const DARK = tokenBlock(':root');
const LIGHT = tokenBlock(":root[data-bt-theme='light']");

function token(block: string, name: string): string {
  const match = new RegExp(`--bt-${name}:\\s*([^;]+);`).exec(block);
  if (!match) throw new Error(`Missing --bt-${name}`);
  return match[1]!.trim();
}

function hexToken(block: string, name: string): string {
  const value = token(block, name);
  if (!/^#[0-9a-fA-F]{6}$/.test(value))
    throw new Error(`--bt-${name} is not a plain hex: ${value}`);
  return value;
}

// ── Contrast ────────────────────────────────────────────────────────────────

function relativeLuminance(hex: string): number {
  const channel = (index: number) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return channel(1) * 0.2126 + channel(3) * 0.7152 + channel(5) * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Composite a tint over an opaque hex, the way the browser does.
 *
 * A tint may be either form: dark washes its hue over the surface at low alpha
 * (`rgba(...)`), light uses an opaque pale hex — an alpha wash on a near-white
 * surface darkens it toward the ink instead of away from it, which is the
 * opposite of what the dark theme gets for free. An opaque tint composites to
 * itself.
 */
function flatten(tint: string, background: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(tint)) return tint;

  const parts = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)[,/\s]+([\d.]+)\s*\)/.exec(tint);
  if (!parts) throw new Error(`Not an rgba tint: ${tint}`);
  const [r, g, b, alpha] = parts.slice(1, 5).map(Number) as [number, number, number, number];
  const base = [1, 3, 5].map((index) => Number.parseInt(background.slice(index, index + 2), 16));
  const channel = (value: number, index: number) =>
    Math.round(value * alpha + base[index]! * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r, 0)}${channel(g, 1)}${channel(b, 2)}`;
}

const OPAQUE_SURFACES = [
  'bg',
  'bg-raised',
  'nav',
  'surface',
  'surface-soft',
  'surface-strong',
  'surface-hover',
] as const;

function weakestOnSurfaces(block: string, ink: string): { ratio: number; surface: string } {
  return OPAQUE_SURFACES.map((surface) => ({
    surface,
    ratio: contrastRatio(ink, hexToken(block, surface)),
  })).reduce((low, next) => (next.ratio < low.ratio ? next : low));
}

// ── 1. Dark must not move ───────────────────────────────────────────────────

/**
 * Every token the light-theme work introduced, mapped to the literal it lifted
 * out of a rule or a component. These are transcriptions, not choices: if one
 * of them ever needs to change, the dark theme is being redesigned and that is
 * a different pull request.
 */
const DARK_VALUES_LIFTED_VERBATIM: Readonly<Record<string, string>> = {
  // .bt-app canvas glows
  'glow-cool': 'rgba(56, 189, 248, 0.05)',
  'glow-warm': 'rgba(246, 184, 46, 0.035)',
  // Incidental chrome
  selection: 'rgba(246, 184, 46, 0.28)',
  scrollbar: 'rgba(139, 148, 159, 0.28)',
  sheen: 'rgba(222, 230, 239, 0.05)',
  'sheen-strong': 'rgb(255 255 255 / 4.5%)',
  // Shadows that were written inline
  'shadow-lift': '0 30px 80px -30px rgb(0 0 0 / 45%)',
  'shadow-ring': '0 0 0 1px rgb(0 0 0 / 22%)',
  'shadow-card': '0 18px 38px -26px rgb(0 0 0 / 62%)',
  // Transparent in dark: a fully transparent shadow paints nothing, so adding
  // the light-mode segment edge could not move a dark pixel.
  'raised-edge': 'transparent',
  // .bt-pf-chip__mark's undefined-variable fallback
  'pf-group-ink': '#9085e9',
  // ui/charts/palette.ts
  'chart-main': '#38bdf8',
  'chart-main-top': 'rgba(56, 189, 248, 0.22)',
  'chart-main-bottom': 'rgba(56, 189, 248, 0.02)',
  'chart-grid': 'rgba(222, 230, 239, 0.06)',
  'chart-text': '#77818d',
  'chart-pos': '#34d399',
  'chart-pos-top': 'rgba(52, 211, 153, 0.22)',
  'chart-pos-bottom': 'rgba(52, 211, 153, 0.02)',
  'chart-neg': '#fb7185',
  'chart-neg-top': 'rgba(251, 113, 133, 0.02)',
  'chart-neg-bottom': 'rgba(251, 113, 133, 0.22)',
  // Sparkline's own pre-Origin trend inks
  'chart-flat': '#71717a',
  'chart-trend-down': '#f87171',
  'chart-flag': '#f6b82e',
  'chart-benchmark': '#9085e9',
  // The validated categorical ramp, in palette order
  'chart-1': '#3987e5',
  'chart-2': '#d95926',
  'chart-3': '#199e70',
  'chart-4': '#c98500',
  'chart-5': '#d55181',
  'chart-6': '#9085e9',
  'chart-7': '#0d9488',
  'chart-8': '#c0453f',
  'chart-9': '#7a9e2b',
  'chart-10': '#b06fc9',
};

describe('dark theme is untouched by the light-theme work', () => {
  it('keeps every lifted literal at its original value', () => {
    const moved = Object.entries(DARK_VALUES_LIFTED_VERBATIM)
      .map(([name, expected]) => ({ name, expected, actual: token(DARK, name) }))
      .filter((entry) => entry.actual !== entry.expected);

    expect(moved).toEqual([]);
  });

  /**
   * The portfolio-kind chips used to spell six hues out twice — once dark, once
   * under `[data-bt-theme='light']`. They now reference the chart tokens, which
   * is only safe while the two lists actually agree.
   */
  it('routes the portfolio-kind chips at the chart ramp they duplicated', () => {
    const kinds: ReadonlyArray<[string, string]> = [
      ['private', '1'],
      ['property', '2'],
      ['family', '5'],
      ['group', '6'],
      ['savings', '9'],
      ['business', '10'],
    ];

    for (const [kind, slot] of kinds) {
      expect(originCss, `.bt-pf-chip--${kind}`).toContain(
        `.bt-pf-chip--${kind} {\n  --bt-pf-ink: var(--bt-chart-${slot});`,
      );
    }
    // …and the hand-kept light copies are gone rather than silently shadowing.
    expect(originCss).not.toContain('.bt-pf-chip--private {\n  --bt-pf-ink: #');
    expect(originCss).not.toContain("data-bt-theme='light'] .bt-pf-chip--");
  });

  it('never assumes an unstamped root — dark is the value set of :root', () => {
    expect(DARK).toContain('color-scheme: dark');
    expect(LIGHT).toContain('color-scheme: light');
    // Light is expressed ONLY as an override; nothing keys off `='dark'`, so an
    // attribute that failed to stamp still paints the app's default theme.
    expect(originCss).not.toContain("data-bt-theme='dark'");
  });
});

// ── 2. Light must be legible ────────────────────────────────────────────────

/**
 * The values adopted verbatim from the mobile client's shipped B2 light theme
 * (spec §1.4), pinned so a later web-side tweak cannot silently un-converge the
 * two clients. `--bt-pos` is deliberately ABSENT: mobile's #0F7A55 fails this
 * theme's surface ramp at 4.42:1 and carries its own documented deviation in
 * `origin.css`. When mobile settles that, add it here.
 */
const CROSS_CLIENT_LIGHT_PALETTE: Readonly<Record<string, string>> = {
  gold: '#8f5f00',
  neg: '#b23a4e',
  'chart-4': '#96600a', // yellow
  'chart-7': '#00887a', // teal
  'chart-9': '#6b8a1a', // lime
};

describe('cross-client light palette (mobile B2 §1.4)', () => {
  it('keeps every adopted value exactly as the mobile client ships it', () => {
    const drifted = Object.entries(CROSS_CLIENT_LIGHT_PALETTE)
      .map(([name, expected]) => ({ name, expected, actual: hexToken(LIGHT, name) }))
      .filter((entry) => entry.actual !== entry.expected);

    expect(drifted).toEqual([]);
  });

  /**
   * The deviation is allowed to exist, but not to be forgotten: it must stay
   * the minimum darkening of mobile's hue rather than drift into a third
   * colour, and it must actually clear the floor mobile's basis did not test.
   */
  it('holds --bt-pos as the minimal AA-clearing darkening of mobile #0F7A55', () => {
    const pos = hexToken(LIGHT, 'pos');
    const mobile = '#0f7a55';

    const channels = (hex: string) =>
      [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    const drift = channels(mobile).map((value, index) => value - channels(pos)[index]!);

    expect(drift.every((delta) => delta >= 0 && delta <= 3)).toBe(true);
    expect(weakestOnSurfaces(LIGHT, mobile).ratio).toBeLessThan(4.5);
    expect(weakestOnSurfaces(LIGHT, pos).ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe('light theme contrast', () => {
  const INKS = ['text', 'text-soft', 'muted', 'faint', 'gold', 'pos', 'neg', 'blue'] as const;

  for (const ink of INKS) {
    it(`keeps --bt-${ink} at AA on every opaque light surface`, () => {
      const weakest = weakestOnSurfaces(LIGHT, hexToken(LIGHT, ink));
      expect(weakest.ratio, `--bt-${ink} on --bt-${weakest.surface}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  /**
   * A badge paints `--bt-x` on `--bt-x-soft`, so the ink has to clear AA
   * against its own tint composited over the surface underneath — the case a
   * plain ink-on-surface check misses entirely, and the one that actually
   * decides whether a change pill is readable.
   */
  for (const pair of ['gold', 'pos', 'neg', 'blue'] as const) {
    it(`keeps --bt-${pair} at AA on its own --bt-${pair}-soft tint`, () => {
      const ink = hexToken(LIGHT, pair);
      const tint = token(LIGHT, `${pair}-soft`);
      const weakest = OPAQUE_SURFACES.map((surface) => ({
        surface,
        ratio: contrastRatio(ink, flatten(tint, hexToken(LIGHT, surface))),
      })).reduce((low, next) => (next.ratio < low.ratio ? next : low));

      expect(
        weakest.ratio,
        `--bt-${pair} on tint over --bt-${weakest.surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  /** Text on a gold fill — the primary button, the switch knob, the step mark. */
  it('keeps --bt-gold-ink at AA on both gold fills', () => {
    const ink = hexToken(LIGHT, 'gold-ink');
    expect(contrastRatio(ink, hexToken(LIGHT, 'gold'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink, hexToken(LIGHT, 'gold-bright'))).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * Chart marks are graphical, so the floor is the 3:1 non-text one — but axis
   * text is text, and gets the full 4.5:1.
   */
  it('keeps every chart series above the 3:1 graphical floor', () => {
    const slots = [
      ...Array.from({ length: 10 }, (_, i) => `chart-${i + 1}`),
      'chart-main',
      'chart-pos',
      'chart-neg',
      'chart-flag',
      'chart-benchmark',
      'chart-trend-down',
      'chart-flat',
    ];

    for (const slot of slots) {
      const weakest = weakestOnSurfaces(LIGHT, hexToken(LIGHT, slot));
      expect(weakest.ratio, `--bt-${slot} on --bt-${weakest.surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps chart axis text at AA', () => {
    const weakest = weakestOnSurfaces(LIGHT, hexToken(LIGHT, 'chart-text'));
    expect(weakest.ratio).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * The owner's standing nav rule: the gold edge line marks the active MAIN
   * rail item and nothing else. In light mode that 3px dash sits on `--bt-nav`,
   * which is the palest surface in the app — if gold ever brightens back toward
   * `#f6b82e`, the marker disappears and the rule is silently repealed.
   */
  it('keeps the active-rail gold edge visible against the rail', () => {
    expect(contrastRatio(hexToken(LIGHT, 'gold'), hexToken(LIGHT, 'nav'))).toBeGreaterThanOrEqual(
      3,
    );
    expect(originCss).toContain('.bt-rail-item.is-active::before');
    expect(originCss).not.toContain('.bt-rail-item::before {');
  });
});

// ── 3. The boot script cannot drift from the module ─────────────────────────

describe('pre-hydration stamp', () => {
  it('agrees with theme.ts on the storage key and both canvas colours', () => {
    expect(indexHtml).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
    expect(indexHtml).toContain(`'${THEME_CANVAS.light}' : '${THEME_CANVAS.dark}'`);
    expect(indexHtml).toContain("matchMedia('(prefers-color-scheme: light)')");
  });

  it('agrees with origin.css on what each canvas colour is', () => {
    expect(THEME_CANVAS.dark).toBe(hexToken(DARK, 'bg'));
    expect(THEME_CANVAS.light).toBe(hexToken(LIGHT, 'bg'));
  });

  /**
   * It has to run BEFORE the app bundle (or the first paint is the wrong
   * theme) and AFTER `/config.js` (or it cannot tell it is on the admin origin,
   * whose separate visual system no token flip reaches).
   */
  it('runs after the runtime config and before the bundle, and skips admin', () => {
    const config = indexHtml.indexOf('src="/config.js"');
    const stamp = indexHtml.indexOf('data-bt-theme');
    const bundle = indexHtml.indexOf('src="/src/main.tsx"');

    expect(config).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(config);
    expect(bundle).toBeGreaterThan(stamp);
    expect(indexHtml).toContain("window.__BT__.app === 'admin'");
  });
});

// ── 4. No new colour literals ───────────────────────────────────────────────

/**
 * Where a raw colour is still legitimate. Each entry is a REASON, not a
 * shrug — a file earns a place here by being one of:
 *
 *   • artwork that carries its own two-tone palette and composites against
 *     neither theme's surface,
 *   • another party's brand mark, which is not ours to re-tone,
 *   • a standalone document (print/export) that is not painted by the app,
 *   • the theme machinery itself, which necessarily names concrete colours.
 *
 * `admin/**` is exempt wholesale and deliberately: the admin console is a
 * separate visual system built on ~500 dark-tuned Tailwind utilities that no
 * token flip reaches, and it never stamps `data-bt-theme`. Theming it is a
 * project, not a line item in this one.
 */
const LITERAL_ALLOWLIST: Readonly<Record<string, string>> = {
  'src/user/components/profileIcons.tsx':
    'Curated avatar artwork: each icon ships its own bg/fg/accent trio and is legible on either theme.',
  'src/user/auth/GoogleButton.tsx': "Google's brand mark — fixed by their brand guidelines.",
  'src/user/vault/export/taxPrint.ts':
    'Builds a standalone print document, not an app surface; print is light by definition.',
  'src/user/portfolio/cashflow/tagChipColor.ts':
    'The tag-chip contrast solver itself: it must name both theme surfaces to precompute an ink for each.',
  'src/user/portfolio/cashflow/CashTagDialog.tsx':
    'Seed colour for a NEW user-owned tag — stored data, not chrome.',
  'src/ui/charts/palette.ts':
    'Dark fallbacks for the canvas resolver, used when no stylesheet has been applied.',
  'src/user/theme.ts': 'Owns THEME_CANVAS, the browser-chrome colour CSS cannot reach.',
};

/** A colour literal, not a hash-prefixed id or a percentage in a gradient. */
const COLOR_LITERAL =
  /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])|\brgba?\(\s*\d[\d\s,./%]*\)|\bhsla?\(\s*\d[\d\s,./%deg]*\)/g;

/**
 * Blank out comments before scanning.
 *
 * Not cosmetic: this codebase cites issues as `#362` and documents palettes in
 * hex ("green (#199e70) reads as the positive semantic pair"), and a scanner
 * that cannot tell prose from paint either fails on every design note or gets
 * watered down until it stops catching anything. Replacing with spaces keeps
 * offsets intact so a future line-number report stays honest. `//` is only a
 * comment when it does not follow a colon, so `https://…` survives.
 */
function withoutComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, lead: string) => lead + blank(match.slice(lead.length)),
    );
}

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('no hardcoded colours outside the token layer', () => {
  it('routes every colour in the user app and the shared UI through a token', () => {
    const roots = ['src/user', 'src/ui', 'src/components', 'src/lib'].map((dir) =>
      join(webRoot, dir),
    );

    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of sourceFilesBelow(root)) {
        const path = relative(webRoot, file);
        // Tests describe colours as often as they set them, and a test cannot
        // ship a dark-only surface to a user.
        if (/\.test\.tsx?$/.test(path)) continue;
        if (LITERAL_ALLOWLIST[path]) continue;

        const source = withoutComments(readFileSync(file, 'utf8'));
        for (const match of source.match(COLOR_LITERAL) ?? []) {
          offenders.push(`${path}: ${match}`);
        }
      }
    }

    expect(
      offenders,
      'Use a --bt-* token (styles/origin.css) so the value has a light counterpart, ' +
        'or add the file to LITERAL_ALLOWLIST with the reason it is theme-independent.',
    ).toEqual([]);
  });

  /**
   * An allowlist that outlives its reason is how a gate quietly stops gating.
   * Every entry has to still name a file that still contains a literal.
   */
  it('keeps the allowlist honest — every entry still exists and still needs it', () => {
    for (const [path, reason] of Object.entries(LITERAL_ALLOWLIST)) {
      const source = withoutComments(readFileSync(join(webRoot, path), 'utf8'));
      expect(reason.length, `${path} needs a real reason`).toBeGreaterThan(20);
      expect(COLOR_LITERAL.test(source), `${path} no longer has literals — drop it`).toBe(true);
      COLOR_LITERAL.lastIndex = 0;
    }
  });

  /** The stylesheet is the token layer, so only its print block may be literal. */
  it('leaves no colour literal in origin.css outside the token blocks and print', () => {
    const stripped = withoutComments(originCss);
    const afterTokens = stripped.slice(
      stripped.indexOf('\n}', stripped.indexOf("data-bt-theme='light'")),
    );
    const printStart = afterTokens.indexOf('@media print');
    const printEnd = afterTokens.indexOf('\n}\n', printStart);
    const withoutPrint = afterTokens.slice(0, printStart) + afterTokens.slice(printEnd);

    expect(withoutPrint.match(COLOR_LITERAL) ?? []).toEqual([]);
  });
});
