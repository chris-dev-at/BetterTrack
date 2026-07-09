import { cx } from './ui';

/**
 * A small, deterministic initials avatar (V3-P6) — the visual anchor for a
 * person across every social surface (friend cards, the friend overview, the
 * audience picker's friend multi-select, shared-with-me groups, public
 * profiles). No image upload exists yet, so identity reads from the username:
 * one/two initials over a hue derived deterministically from the name, so the
 * same person is always the same colour. Purely presentational.
 */

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-lg',
} as const;

export type AvatarSize = keyof typeof SIZES;

/** First one/two "word" initials of a display name, uppercased. */
function initialsOf(name: string): string {
  const parts = name
    .replace(/^@/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Stable hue [0,360) from a string — same name → same colour every render. */
function hueOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return hash;
}

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: AvatarSize;
  className?: string;
}) {
  const hue = hueOf(name || '?');
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white ring-1 ring-inset ring-white/10',
        SIZES[size],
        className,
      )}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 55% 32%))`,
      }}
    >
      {initialsOf(name || '?')}
    </span>
  );
}
