import { describe, expect, test } from 'vitest';

import { CASH_SYSTEM_TAGS } from '@bettertrack/contracts';

import { contrastRatio, hexToRgb, readableTagInk } from './tagChipColor';

/**
 * The one non-negotiable in the tag-chip design (owner instruction): every
 * chip's text must clear 3:1 against its own chip in BOTH themes, for ANY
 * tag colour — a hex a user (or the system-tag seed set) can pick freely, not
 * a fixed palette this module controls. Direct contrast-math tests rather
 * than a visual check, because a wrong lightening/darkening direction still
 * *renders* — it just silently fails accessibility.
 */

const DARK_SURFACE = '#10151b';
const LIGHT_SURFACE = '#fafafa';

function ratio(inkHex: string, backgroundHex: string): number {
  return contrastRatio(hexToRgb(inkHex)!, hexToRgb(backgroundHex)!);
}

// The seeded system-tag palette (packages/contracts/src/cash.ts) plus a
// battery of edge cases: a light hue close to the brand gold, pure white/black
// (already at the lightness extremes — the search must not run past them),
// mid-grey (near-zero saturation, so hue-based nudging can't help at all) and
// a fully saturated primary.
const COLORS = [
  ...CASH_SYSTEM_TAGS.map((tag) => tag.color),
  '#eab308',
  '#ffffff',
  '#000000',
  '#808080',
  '#ff0000',
  '#0000ff',
];

describe('readableTagInk', () => {
  test.each(COLORS)('clears 3:1 against the dark chip surface for %s', (color) => {
    const ink = readableTagInk(color, DARK_SURFACE);
    expect(ratio(ink, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
  });

  test.each(COLORS)('clears 3:1 against the light chip surface for %s', (color) => {
    const ink = readableTagInk(color, LIGHT_SURFACE);
    expect(ratio(ink, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
  });

  test('leaves a colour that already clears the floor untouched', () => {
    // Pure black already reads at >3:1 on the light surface — no need to nudge it.
    expect(readableTagInk('#000000', LIGHT_SURFACE)).toBe('#000000');
  });

  test('nudges lighter on a dark background and darker on a light one', () => {
    // The brand-gold-adjacent yellow needs help in both directions, but the
    // DIRECTION differs: lighter on dark, darker on light.
    const onDark = hexToRgb(readableTagInk('#eab308', DARK_SURFACE))!;
    const onLight = hexToRgb(readableTagInk('#eab308', LIGHT_SURFACE))!;
    const original = hexToRgb('#eab308')!;
    const luminanceOf = (rgb: { r: number; g: number; b: number }) =>
      0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b; // relative order only — no gamma needed here
    expect(luminanceOf(onDark)).toBeGreaterThanOrEqual(luminanceOf(original) - 1);
    expect(luminanceOf(onLight)).toBeLessThanOrEqual(luminanceOf(original) + 1);
  });

  test('falls back to slate for an unparseable colour rather than throwing', () => {
    expect(() => readableTagInk('not-a-color', DARK_SURFACE)).not.toThrow();
    expect(
      ratio(readableTagInk('not-a-color', LIGHT_SURFACE), LIGHT_SURFACE),
    ).toBeGreaterThanOrEqual(3);
  });
});
