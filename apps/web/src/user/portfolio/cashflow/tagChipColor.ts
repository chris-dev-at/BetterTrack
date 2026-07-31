import type { CSSProperties } from 'react';

/**
 * Contrast-safe tag-chip colouring (PROJECTPLAN.md §14 cash fusion). A tag
 * chip tints from the tag's OWN hex colour at low alpha for its background
 * (`.bt-tag-chip` in origin.css copies the `.bt-pf-chip` technique), with the
 * tag's hue at full strength for the text. Because a tag's colour is
 * user/engine-chosen (any `#RRGGBB`), "full strength" cannot be trusted to
 * clear the WCAG 3:1 non-text contrast floor against every chip background in
 * BOTH themes on its own — a light seed colour (`#eab308`) reads fine on the
 * dark canvas but nearly vanishes on the light one.
 *
 * So this module nudges the INK — never the background tint, which always
 * stays the pure tag colour — by the minimum lightness the WCAG
 * relative-luminance formula proves necessary, one theme at a time, and hands
 * both pre-computed inks to CSS as custom properties. The actual light/dark
 * switch stays entirely CSS-driven (`[data-bt-theme]`), matching every other
 * themed surface in origin.css — this module only guarantees both precomputed
 * values are individually legible.
 */

const DARK_CHIP_SURFACE = '#10151b'; // --bt-surface, dark theme
const LIGHT_CHIP_SURFACE = '#fafafa'; // --bt-surface, light theme
/** WCAG's floor for non-text / large-graphic contrast. */
const MIN_CONTRAST = 3;
/** Lightness step per search iteration; 50 steps covers the full 0–1 range. */
const LIGHTNESS_STEP = 0.02;
const MAX_STEPS = 50;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `#RRGGBB` → `{r,g,b}` (0–255 each), or `null` for anything else (a bad/legacy value). */
export function hexToRgb(hex: string): Rgb | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const int = parseInt(match[1]!, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const byte = (n: number) =>
    Math.round(clamp01(n / 255) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rN) h = (gN - bN) / d + (gN < bN ? 6 : 0);
  else if (max === gN) h = (bN - rN) / d + 2;
  else h = (rN - gN) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

function channelLuminance(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) – 1 (white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio, 1 (identical) – 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

/** An unparseable tag colour never crashes the chip — falls back to slate. */
const FALLBACK: Rgb = { r: 148, g: 163, b: 184 };

/**
 * The tag colour, or a lightness-adjusted twin of it, guaranteed to clear
 * {@link MIN_CONTRAST} against `backgroundHex`. Hue and saturation are never
 * touched — only lightness moves, and only as far as the contrast requires —
 * so the ink still reads as "that tag's colour", just legible.
 */
export function readableTagInk(tagHex: string, backgroundHex: string): string {
  const rgb = hexToRgb(tagHex) ?? FALLBACK;
  const bg = hexToRgb(backgroundHex) ?? FALLBACK;
  if (contrastRatio(rgb, bg) >= MIN_CONTRAST) return rgbToHex(rgb);

  // Push lightness AWAY from the background's own luminance: lighten the ink
  // on a dark chip, darken it on a light one.
  const lighten = relativeLuminance(bg) < 0.5;
  const hsl = rgbToHsl(rgb);
  let l = hsl.l;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    l = clamp01(l + (lighten ? LIGHTNESS_STEP : -LIGHTNESS_STEP));
    const candidate = hslToRgb(hsl.h, hsl.s, l);
    if (contrastRatio(candidate, bg) >= MIN_CONTRAST) return rgbToHex(candidate);
    if (l === 0 || l === 1) break;
  }
  // A hue whose full lightness sweep still fails (near-grey, isoluminant with
  // the background) — plain black/white always clears 3:1 here.
  return lighten ? '#ffffff' : '#000000';
}

/** Inline CSS custom properties one `.bt-tag-chip` needs — spread onto its `style`. */
export function tagChipStyle(color: string): CSSProperties {
  return {
    '--bt-tag-color': color,
    '--bt-tag-ink-dark': readableTagInk(color, DARK_CHIP_SURFACE),
    '--bt-tag-ink-light': readableTagInk(color, LIGHT_CHIP_SURFACE),
  } as CSSProperties;
}
