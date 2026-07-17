import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { PROFILE_ICON_IDS } from '@bettertrack/contracts';

import { Avatar } from './Avatar';
import { defaultProfileIconIdFor } from './profileIcons';

/**
 * V5-P0c — the curated profile-icon Avatar. Two contract-level invariants
 * matter more than any pixel: (1) a user who never picked an icon still shows
 * an avatar, deterministic from their name so it never flickers between reloads;
 * (2) an unknown / stale id from an older client falls back to that same
 * deterministic default rather than rendering broken.
 */

function firstSvgPathData(container: HTMLElement): string {
  const svg = container.querySelector('svg[viewBox="0 0 64 64"]');
  if (!svg) throw new Error('expected the profile-icon SVG to render');
  return svg.innerHTML;
}

describe('Avatar (§13.5 V5-P0c)', () => {
  test('renders the picked curated icon when `iconId` is set', () => {
    const { container } = render(<Avatar name="alice" iconId="fox" />);
    const { container: expected } = render(<Avatar name="different" iconId="fox" />);
    // Same id → identical SVG regardless of name.
    expect(firstSvgPathData(container)).toBe(firstSvgPathData(expected));
  });

  test('renders a deterministic default when `iconId` is null (existing users)', () => {
    const { container: first } = render(<Avatar name="alice" iconId={null} />);
    const { container: second } = render(<Avatar name="alice" iconId={null} />);
    // Two independent renders for the same name → same avatar (no per-render randomness).
    expect(firstSvgPathData(first)).toBe(firstSvgPathData(second));

    // And a different name maps to a different avatar id from the curated set.
    const forAlice = defaultProfileIconIdFor('alice');
    const forBob = defaultProfileIconIdFor('bob-with-a-clearly-distinct-name');
    expect(forAlice).not.toBe(forBob);
    expect(PROFILE_ICON_IDS).toContain(forAlice);
    expect(PROFILE_ICON_IDS).toContain(forBob);
  });

  test('an unknown / stale icon id from an older client falls back to the default', () => {
    const { container: unknown } = render(<Avatar name="alice" iconId="not-a-real-id" />);
    const { container: fallback } = render(<Avatar name="alice" iconId={null} />);
    // The stale id must map to the same deterministic default — never a broken tile.
    expect(firstSvgPathData(unknown)).toBe(firstSvgPathData(fallback));
  });

  test('renders one curated tile for every id in the finite allow-list', () => {
    for (const id of PROFILE_ICON_IDS) {
      const { container } = render(<Avatar name="pick" iconId={id} />);
      expect(container.querySelector('svg[viewBox="0 0 64 64"]')).not.toBeNull();
    }
  });
});
