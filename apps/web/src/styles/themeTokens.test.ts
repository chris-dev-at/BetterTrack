import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { THEME_CANVAS, THEME_STORAGE_KEY } from '../lib/theme';

/**
 * The two-theme gate (board #68).
 *
 * Four jobs, in the order they matter:
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
 *  3. GOLD IS THE ONE DOCUMENTED EXCEPTION, and it lives in its own block
 *     (`gold — owner final word`) rather than as a hole punched in job 2. The
 *     owner decided on 2026-08-07 that brand gold stays bright on light and the
 *     legibility budget is paid in geometry; that block pins the exact values,
 *     records the ratios it is knowingly accepting, and asserts the geometry
 *     that pays for them. Job 2's floor is NOT relaxed for anything else.
 *  4. NEW LITERALS MUST NOT APPEAR. A colour written into a component is a
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

/** A geometry token (`2px`), as a number, so themes can be compared. */
function pxToken(block: string, name: string): number {
  const value = token(block, name);
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (!match) throw new Error(`--bt-${name} is not a px length: ${value}`);
  return Number(match[1]);
}

/** The alpha of an `rgba(...)` token. */
function alphaOf(value: string): number {
  const parts = /rgba?\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+[,/\s]+([\d.]+)\s*\)/.exec(value);
  if (!parts) throw new Error(`Not an rgba value: ${value}`);
  return Number(parts[1]);
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

/**
 * Every opaque surface a piece of TEXT can land on.
 *
 * `--bt-recess` is deliberately absent: it is the empty half of a ratio bar,
 * the one surface in the system that carries no text, and it is darker than
 * anything here. Sweeping inks across it would force the whole ramp darker to
 * satisfy a ground nothing reads on. `keeps --bt-recess off the text grounds`
 * below pins that reasoning so the omission stays a decision, not an oversight.
 */
const OPAQUE_SURFACES = [
  'bg',
  'bg-raised',
  'nav',
  'surface',
  'surface-soft',
  'surface-strong',
  'surface-hover',
  'selected',
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
  // The gold split (THEME2). Dark had ONE gold doing all three jobs, so all
  // three tokens carry that same value here and the split moves no dark pixel.
  'gold-ink': '#f6b82e',
  'gold-graphic': '#f6b82e',
  'gold-fill': '#f6b82e',
  'gold-on': '#171105',
  // Selection and recess were both drawn in `--bt-surface-strong` in dark.
  selected: '#171e27',
  recess: '#171e27',
  'surface-quiet': '#121820',
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
 * two clients.
 *
 * `pos` is here now: the THEME1 deviation is settled — mobile adopted this
 * theme's #0F7853 rather than the reverse, so the two clients agree on gain
 * again and the old "minimal darkening" guard has nothing left to guard.
 */
const CROSS_CLIENT_LIGHT_PALETTE: Readonly<Record<string, string>> = {
  // Gold is cross-client too, but it answers to a different floor and lives in
  // its own block below — see `gold — owner final word`.
  pos: '#0f7853',
  neg: '#b23a4e',
  text: '#131820',
  'text-soft': '#3e4650',
  muted: '#56616d',
  faint: '#5d6773',
  'chart-1': '#1f6ac4', // blue
  'chart-2': '#b8431a', // orange
  'chart-3': '#12805b', // green
  'chart-4': '#96600a', // yellow
  'chart-5': '#b93a68', // magenta
  'chart-6': '#6154c6', // violet
  'chart-7': '#00887a', // teal
  'chart-8': '#a03832', // red-brown
  'chart-9': '#6b8a1a', // lime
  'chart-10': '#8e46ad', // purple
  'chart-flat': '#6e7276', // "rest"
  'chart-cash': '#7a828b',
};

describe('cross-client light palette (mobile B2 §1.4)', () => {
  it('keeps every adopted value exactly as the mobile client ships it', () => {
    const drifted = Object.entries(CROSS_CLIENT_LIGHT_PALETTE)
      .map(([name, expected]) => ({ name, expected, actual: hexToken(LIGHT, name) }))
      .filter((entry) => entry.actual !== entry.expected);

    expect(drifted).toEqual([]);
  });
});

describe('light theme contrast', () => {
  /**
   * Every ink that is held to AA. `gold-ink` is deliberately absent — and ONLY
   * gold-ink: the owner's 2026-08-07 override is a decision about the brand
   * colour, not a licence to loosen this sweep. It is enforced instead by the
   * gold block below, which pins its value and the geometry that carries it.
   */
  const INKS = ['text', 'text-soft', 'muted', 'faint', 'pos', 'neg', 'blue'] as const;

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
  // Ink → the tint it is painted on. `gold-ink`/`gold-soft` is the one pair
  // that is not here, for the same reason gold is out of INKS.
  const TINTED_PAIRS: ReadonlyArray<readonly [ink: string, tint: string]> = [
    ['pos', 'pos-soft'],
    ['neg', 'neg-soft'],
    ['blue', 'blue-soft'],
  ];

  for (const [inkToken, tintToken] of TINTED_PAIRS) {
    const pair = inkToken;
    it(`keeps --bt-${inkToken} at AA on its own --bt-${tintToken}`, () => {
      const ink = hexToken(LIGHT, inkToken);
      const tint = token(LIGHT, tintToken);
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

  /**
   * Clean white is only legible because the hairlines do the separating. If a
   * structural surface ever drifts back off #FFFFFF the tonal ramp is creeping
   * back in, which is exactly what the owner rejected.
   */
  it('keeps every structural surface white, with only the two functional tints', () => {
    const white = ['bg', 'bg-raised', 'nav', 'surface', 'surface-strong', 'surface-quiet'] as const;
    for (const surface of white) {
      expect(hexToken(LIGHT, surface), `--bt-${surface} must stay white`).toBe('#ffffff');
    }
    for (const tint of ['surface-soft', 'surface-hover', 'selected'] as const) {
      expect(hexToken(LIGHT, tint), `--bt-${tint} is the one functional tint`).toBe('#e9edf2');
    }
    expect(hexToken(LIGHT, 'recess')).toBe('#dae1e9');
  });

  /**
   * `--bt-recess` is the one surface excluded from the ink sweep, so the reason
   * is pinned here: it is darker than every text ground, and `--bt-faint` does
   * NOT clear AA on it. Anything that puts text on a recess has to prove it.
   */
  it('keeps --bt-recess off the text grounds', () => {
    const recess = hexToken(LIGHT, 'recess');
    const tint = hexToken(LIGHT, 'selected');
    expect(contrastRatio('#ffffff', recess)).toBeGreaterThan(contrastRatio('#ffffff', tint));
    expect(contrastRatio(hexToken(LIGHT, 'faint'), recess)).toBeLessThan(4.5);
    expect((OPAQUE_SURFACES as readonly string[]).includes('recess')).toBe(false);
  });

  /**
   * Chart marks are graphical, so the floor is the 3:1 non-text one — but axis
   * text is text, and gets the full 4.5:1.
   *
   * `chart-flag` is the one slot missing, and only because it is gold: it is
   * pinned to brand gold in the block below, under the same owner override.
   */
  it('keeps every chart series above the 3:1 graphical floor', () => {
    const slots = [
      ...Array.from({ length: 10 }, (_, i) => `chart-${i + 1}`),
      'chart-main',
      'chart-pos',
      'chart-neg',
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
   * rail item and nothing else. The COLOUR half of this used to be asserted
   * here (gold ≥ 3:1 on the rail); since 2026-08-07 the colour is fixed by
   * owner decision and the mass is the variable, so what survives here is the
   * structural half — one marker, on the active row, and nowhere else.
   */
  it('draws the active-rail gold edge on the active row and nowhere else', () => {
    expect(originCss).toContain('background: var(--bt-gold-graphic);');
    expect(originCss).toContain('.bt-rail-item.is-active::before');
    expect(originCss).not.toContain('.bt-rail-item::before {');
    // Its width is a token, which is what lets light thicken it — see below.
    expect(originCss).toContain('width: var(--bt-gold-edge);');
  });
});

// ── 3. Gold — owner final word (2026-08-07) ─────────────────────────────────

/**
 * ── THE OWNER OVERRIDE ──────────────────────────────────────────────────────
 *
 * Decision: 2026-08-07, by the owner, on-device with the mobile team, shipped
 * there as "bright brand yellow everywhere (owner final word)". It retires the
 * darkened light golds of THEME2 (#866419 ink, #A77D1F graphic) — which passed
 * their contrast floors and which the owner rejected as not the brand.
 *
 *   Brand gold stays BRIGHT on light. The legibility budget is paid in
 *   GEOMETRY: heavier gold strokes and doubled edge alphas, mirroring the
 *   mobile client's 3dp-on-light / 2dp-on-dark rule.
 *
 * What that knowingly buys, measured, on this theme's own surfaces:
 *
 *   --bt-gold-graphic #F6B82E   1.78:1 on white, 1.51:1 on the binding ground
 *                               — under the 3:1 graphical floor
 *   --bt-gold-ink     #D49E28   2.41:1 on white, 2.05:1 on the binding ground,
 *                               2.15:1 on --bt-gold-soft — all under 4.5:1
 *
 * These are ACCEPTED, not overlooked. This block exists so the acceptance is
 * explicit, bounded and dated: the values are pinned, the ratios are asserted
 * to be what we think they are, and the compensation is asserted to exist. It
 * covers gold and nothing else — every other ink is still swept at AA above.
 *
 * The one accessibility floor that did NOT move is text sitting ON gold
 * (`--bt-gold-on`), and the safety valve: reading text that used to be gold
 * letters now draws `--bt-gold-ink-safe`, which is the page ink on light.
 */
describe('gold — owner final word (2026-08-07)', () => {
  /** Pinned exactly. Changing one of these is re-litigating an owner decision. */
  const GOLD_LIGHT: Readonly<Record<string, string>> = {
    'gold-ink': '#d49e28', // mobile goldInk — gold as an accent/number/badge
    'gold-graphic': '#f6b82e', // brand gold — every gold MARK
    'gold-fill': '#f6b82e', // brand gold — a gold background
    'gold-on': '#171105', // mobile onGold — text on that background
    'gold-bright': '#ffd26b', // primary :hover
    'gold-soft': '#fcf1db', // mobile goldSurface — the wash
    'chart-flag': '#f6b82e', // a chart's gold mark is a graphic
  };

  it('pins every light gold at the value the owner signed off', () => {
    const drifted = Object.entries(GOLD_LIGHT)
      .map(([name, expected]) => ({ name, expected, actual: hexToken(LIGHT, name) }))
      .filter((entry) => entry.actual !== entry.expected);

    expect(drifted).toEqual([]);
  });

  /**
   * The guard that SURVIVES the override, and the reason the earlier rusty gold
   * was rejected in the first place: a gold that satisfies a contrast floor by
   * dropping its blue channel to zero is no longer the brand's gold. Every gold
   * token has to stay on the brand ray — same hue, only lightness moving.
   */
  it('keeps every gold on the brand ray rather than rusting off it', () => {
    const BRAND = [0xf6, 0xb8, 0x2e]; // #F6B82E
    const channels = (hex: string) =>
      [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));

    for (const name of ['gold-ink', 'gold-graphic', 'gold-fill', 'chart-flag'] as const) {
      const rgb = channels(hexToken(LIGHT, name));
      // Every channel scaled by the same factor => same hue, lower lightness.
      const ratios = rgb.map((value, index) => value / BRAND[index]!);
      const spread = Math.max(...ratios) - Math.min(...ratios);
      expect(spread, `--bt-${name} is off the brand ray`).toBeLessThan(0.06);
      // …and specifically: the blue channel may not be zeroed.
      expect(rgb[2], `--bt-${name} zeroed its blue channel`).toBeGreaterThan(0);
    }
  });

  /**
   * The accepted cost, written down as a number rather than as an absence.
   *
   * Asserting a CEILING as well as a floor is the point: it fails just as loudly
   * if someone quietly darkens gold back toward AA (which would be reversing the
   * owner) as if someone brightens it into invisibility.
   */
  it('records the sub-AA ratios it is knowingly accepting', () => {
    const white = hexToken(LIGHT, 'bg');
    const ground = hexToken(LIGHT, 'surface-hover'); // the binding ground
    const wash = hexToken(LIGHT, 'gold-soft');
    const ink = hexToken(LIGHT, 'gold-ink');
    const graphic = hexToken(LIGHT, 'gold-graphic');

    const near = (actual: number, expected: number) =>
      expect(actual, `expected ~${expected}, got ${actual.toFixed(2)}`).toBeCloseTo(expected, 1);

    near(contrastRatio(ink, white), 2.41);
    near(contrastRatio(ink, ground), 2.05);
    near(contrastRatio(ink, wash), 2.15);
    near(contrastRatio(graphic, white), 1.78);
    near(contrastRatio(graphic, ground), 1.51);
  });

  /**
   * Text ON gold never moved, and must not: a primary button's label, the
   * switch knob, the step mark. This is the floor that stayed at AA.
   */
  it('keeps --bt-gold-on at AA on both gold fills', () => {
    const on = hexToken(LIGHT, 'gold-on');
    expect(contrastRatio(on, hexToken(LIGHT, 'gold-fill'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(on, hexToken(LIGHT, 'gold-bright'))).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * GEOMETRY COMPENSATION — the half of the decision that pays for the other.
   *
   * Mobile went 3dp on light where dark uses 2dp. Each of these three tokens is
   * one step heavier in light, and every gold stroke in the sheet is sized from
   * one of them, so this is the whole compensation rather than a sample of it.
   */
  it('makes every gold stroke heavier in light than in dark', () => {
    for (const name of ['gold-hair', 'gold-ring', 'gold-edge'] as const) {
      expect(pxToken(LIGHT, name), `--bt-${name} must gain mass in light`).toBeGreaterThan(
        pxToken(DARK, name),
      );
    }
    // The dark side is a transcription of the literals these replaced, so the
    // compensation could not move a dark pixel: 1px ring, 2px tab underline and
    // focus outline, 3px active-rail dash.
    expect(pxToken(DARK, 'gold-hair')).toBe(1);
    expect(pxToken(DARK, 'gold-ring')).toBe(2);
    expect(pxToken(DARK, 'gold-edge')).toBe(3);
    expect(pxToken(LIGHT, 'gold-hair')).toBe(2);
    expect(pxToken(LIGHT, 'gold-ring')).toBe(3);
    expect(pxToken(LIGHT, 'gold-edge')).toBe(4);
  });

  /** …and that the strokes actually consume the tokens rather than literals. */
  it('sizes the gold strokes from the geometry tokens', () => {
    for (const rule of [
      'outline: var(--bt-gold-ring) solid var(--bt-gold-graphic);', // :focus-visible
      'width: var(--bt-gold-edge);', // the active-rail dash
      'height: var(--bt-gold-edge);', // the bottom-bar dash
      'border-bottom: var(--bt-gold-ring) solid transparent;', // the active tab
      'box-shadow: 0 0 0 var(--bt-gold-hair) var(--bt-gold-graphic);', // field focus
      'border: var(--bt-gold-hair) solid var(--bt-gold-graphic);', // the ⊕ pill
    ]) {
      expect(originCss, rule).toContain(rule);
    }
  });

  /**
   * The alpha half of mobile's compensation: the gold EDGE alpha doubles. It was
   * the darkened gold at 30 %; it is brand gold at 60 %, so a gold-framed callout
   * keeps its edge even though the hue stopped doing the work.
   */
  it('doubles the gold edge alphas in light', () => {
    const accent = token(LIGHT, 'border-accent');
    expect(accent).toContain('246, 184, 46'); // brand gold, not a darkened one
    expect(alphaOf(accent)).toBeCloseTo(0.6, 5);
    expect(alphaOf(accent)).toBeGreaterThanOrEqual(2 * 0.3); // the THEME2 value
    expect(alphaOf(token(LIGHT, 'glow-warm'))).toBeCloseTo(0.08, 5);
  });

  /**
   * THE SAFETY VALVE. Gold ink is fine for a number you glance at and wrong for
   * a sentence you have to read, so the sites that carried real reading text in
   * gold draw `--bt-gold-ink-safe`: the page ink on light, and the gold itself
   * in dark, which is why none of those conversions moved a dark pixel.
   */
  it('routes critical reading text away from the sub-AA gold', () => {
    // Dark: a pure alias, so every converted site paints what it always did.
    expect(token(DARK, 'gold-ink-safe')).toBe('var(--bt-gold-ink)');
    // Light: the page ink, which the AA sweep above already proves legible.
    expect(token(LIGHT, 'gold-ink-safe')).toBe('var(--bt-text)');

    // Both escape-hatch classes exist and take that token…
    expect(originCss).toContain(
      '.bt-gold-safe,\n.bt-gold-note {\n  color: var(--bt-gold-ink-safe);',
    );
    // …and the note variant replaces the gold letters with a gold MARK.
    expect(originCss).toContain(":root[data-bt-theme='light'] .bt-gold-note::before");
  });
});

// ── 4. The boot script cannot drift from the module ─────────────────────────

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

// ── 5. No new colour literals ───────────────────────────────────────────────

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
  'src/lib/theme.ts': 'Owns THEME_CANVAS, the browser-chrome colour CSS cannot reach.',
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
