import type { ReactElement } from 'react';

import type { ProfileIconId } from '@bettertrack/contracts';
import { PROFILE_ICON_IDS } from '@bettertrack/contracts';

/**
 * The curated profile-icon set (§13.5 V5-P0c) — one bundled SVG per id from
 * {@link PROFILE_ICON_IDS}. Old-Xbox-style avatars: bold shapes, two-tone
 * palette per icon, no fine detail. Rendered inline (no `<img>` fetch) so the
 * picker + every render site paints in the same paint as the surface, and no
 * `Content-Security-Policy` image source ever has to be widened.
 *
 * The palette lives per icon so every avatar reads distinct at a glance — an
 * app-wide gradient would collapse them all into the same silhouette. Colours
 * pass AA contrast against both light and dark tiles at every size.
 */

interface IconPaint {
  bg: string;
  fg: string;
  accent: string;
}

const PALETTES: Record<ProfileIconId, IconPaint> = {
  astronaut: { bg: '#1f2a52', fg: '#e5edff', accent: '#89b4ff' },
  fox: { bg: '#3a1a10', fg: '#ff924d', accent: '#ffe1cf' },
  panda: { bg: '#1a1a1a', fg: '#f4f4f4', accent: '#3a3a3a' },
  robot: { bg: '#1a3a2a', fg: '#8ee6b0', accent: '#d2fce0' },
  star: { bg: '#3a2b0d', fg: '#ffd23f', accent: '#fff2b8' },
  wave: { bg: '#0d2a3a', fg: '#5cc9ff', accent: '#c9f0ff' },
  mountain: { bg: '#2b2033', fg: '#b399ff', accent: '#f0e6ff' },
  leaf: { bg: '#0f2f1c', fg: '#6fdc8c', accent: '#c9f7d5' },
  flame: { bg: '#3a0f16', fg: '#ff7a59', accent: '#ffd6cc' },
  bolt: { bg: '#332a08', fg: '#ffd93b', accent: '#fff4b3' },
  moon: { bg: '#161a2e', fg: '#c3c8ff', accent: '#eef0ff' },
  planet: { bg: '#132139', fg: '#7bbcff', accent: '#ff9f6b' },
  ghost: { bg: '#231636', fg: '#e9e2ff', accent: '#a58cff' },
  crown: { bg: '#3a1b06', fg: '#ffc857', accent: '#ffe8b3' },
  compass: { bg: '#0f2a34', fg: '#8cd6d1', accent: '#e8fbf9' },
  anchor: { bg: '#12233d', fg: '#9cc4ff', accent: '#eaf1ff' },
};

type IconRenderer = (paint: IconPaint) => ReactElement;

const RENDERERS: Record<ProfileIconId, IconRenderer> = {
  astronaut: ({ fg, accent }) => (
    <g>
      <circle cx="32" cy="32" r="18" fill={fg} />
      <ellipse cx="32" cy="30" rx="12" ry="10" fill={accent} opacity="0.85" />
      <path d="M20 26h24v10h-24z" fill={fg} opacity="0.55" />
      <circle cx="32" cy="32" r="4" fill={fg} />
    </g>
  ),
  fox: ({ fg, accent }) => (
    <g>
      <path d="M32 14l14 14v14a10 10 0 01-20 0V28z" fill={fg} />
      <path d="M20 20l8 12h-4z M44 20l-8 12h4z" fill={fg} />
      <circle cx="26" cy="34" r="2" fill={accent} />
      <circle cx="38" cy="34" r="2" fill={accent} />
      <path d="M32 42l-4 4h8z" fill={accent} />
    </g>
  ),
  panda: ({ fg, accent, bg }) => (
    <g>
      <circle cx="32" cy="34" r="18" fill={fg} />
      <ellipse cx="20" cy="22" rx="6" ry="7" fill={bg} />
      <ellipse cx="44" cy="22" rx="6" ry="7" fill={bg} />
      <ellipse cx="26" cy="34" rx="4" ry="5" fill={bg} />
      <ellipse cx="38" cy="34" rx="4" ry="5" fill={bg} />
      <circle cx="26" cy="34" r="1.5" fill={accent} />
      <circle cx="38" cy="34" r="1.5" fill={accent} />
      <ellipse cx="32" cy="42" rx="3" ry="2" fill={bg} />
    </g>
  ),
  robot: ({ fg, accent }) => (
    <g>
      <rect x="16" y="20" width="32" height="26" rx="4" fill={fg} />
      <rect x="22" y="26" width="8" height="6" rx="1" fill={accent} />
      <rect x="34" y="26" width="8" height="6" rx="1" fill={accent} />
      <rect x="26" y="38" width="12" height="3" rx="1" fill={accent} />
      <line x1="32" y1="14" x2="32" y2="20" stroke={fg} strokeWidth="3" />
      <circle cx="32" cy="12" r="3" fill={accent} />
    </g>
  ),
  star: ({ fg, accent }) => (
    <g>
      <path
        d="M32 14l6 12 14 2-10 9 2 14-12-6-12 6 2-14-10-9 14-2z"
        fill={fg}
        stroke={accent}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </g>
  ),
  wave: ({ fg, accent }) => (
    <g>
      <path
        d="M8 40c6-8 12-8 18 0s12 8 18 0 12-8 18 0"
        stroke={fg}
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M8 30c6-8 12-8 18 0s12 8 18 0 12-8 18 0"
        stroke={accent}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
        opacity="0.85"
      />
    </g>
  ),
  mountain: ({ fg, accent }) => (
    <g>
      <path d="M8 48l14-20 8 12 6-8 20 16z" fill={fg} />
      <path d="M20 34l4-6 6 8-4 4z" fill={accent} opacity="0.85" />
      <circle cx="46" cy="18" r="4" fill={accent} />
    </g>
  ),
  leaf: ({ fg, accent }) => (
    <g>
      <path d="M14 50c0-22 14-36 36-36-2 22-14 36-36 36z" fill={fg} />
      <path d="M18 46c8-16 18-24 30-28" stroke={accent} strokeWidth="2" fill="none" />
    </g>
  ),
  flame: ({ fg, accent }) => (
    <g>
      <path d="M32 12c4 8 12 12 12 22a12 12 0 01-24 0c0-4 3-6 6-6-2-4-2-10 6-16z" fill={fg} />
      <path d="M32 22c2 4 6 6 6 12a6 6 0 01-12 0c0-4 2-6 6-12z" fill={accent} />
    </g>
  ),
  bolt: ({ fg, accent }) => (
    <g>
      <path
        d="M34 12l-14 22h10l-4 18 18-24H34z"
        fill={fg}
        stroke={accent}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </g>
  ),
  moon: ({ fg, accent }) => (
    <g>
      <path d="M42 40a18 18 0 11-18-28 14 14 0 0018 28z" fill={fg} />
      <circle cx="34" cy="26" r="2" fill={accent} />
      <circle cx="42" cy="34" r="1.5" fill={accent} />
      <circle cx="30" cy="34" r="1" fill={accent} />
    </g>
  ),
  planet: ({ fg, accent }) => (
    <g>
      <circle cx="32" cy="32" r="12" fill={fg} />
      <ellipse
        cx="32"
        cy="32"
        rx="22"
        ry="6"
        fill="none"
        stroke={accent}
        strokeWidth="3"
        transform="rotate(-20 32 32)"
      />
      <circle cx="26" cy="30" r="2" fill={accent} opacity="0.7" />
    </g>
  ),
  ghost: ({ fg, accent, bg }) => (
    <g>
      <path d="M18 30c0-8 6-14 14-14s14 6 14 14v18l-4-3-4 3-3-3-3 3-3-3-4 3-4-3-3 3z" fill={fg} />
      <circle cx="27" cy="30" r="2.5" fill={bg} />
      <circle cx="37" cy="30" r="2.5" fill={bg} />
      <path d="M27 38c2 3 8 3 10 0" stroke={accent} strokeWidth="1.5" fill="none" />
    </g>
  ),
  crown: ({ fg, accent }) => (
    <g>
      <path d="M12 42V22l10 8 10-14 10 14 10-8v20z" fill={fg} />
      <rect x="12" y="42" width="40" height="6" fill={accent} />
      <circle cx="22" cy="24" r="2" fill={accent} />
      <circle cx="32" cy="18" r="2" fill={accent} />
      <circle cx="42" cy="24" r="2" fill={accent} />
    </g>
  ),
  compass: ({ fg, accent }) => (
    <g>
      <circle cx="32" cy="32" r="18" fill={fg} />
      <path
        d="M32 16l6 16-6 16-6-16z"
        fill={accent}
        stroke={accent}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="32" r="3" fill={fg} />
    </g>
  ),
  anchor: ({ fg, accent }) => (
    <g>
      <circle cx="32" cy="16" r="4" fill={fg} />
      <path d="M32 20v26" stroke={fg} strokeWidth="4" strokeLinecap="round" />
      <path
        d="M18 40c4 6 10 8 14 8s10-2 14-8"
        stroke={fg}
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
      <line x1="26" y1="26" x2="38" y2="26" stroke={accent} strokeWidth="3" strokeLinecap="round" />
    </g>
  ),
};

/**
 * Whether an id is one of the curated set — used by the picker to defensively
 * ignore an unknown id stored on an older client (never crashes, falls to the
 * default avatar). The zod schema in contracts is the authoritative allow-list.
 */
export function isProfileIconId(value: string): value is ProfileIconId {
  return (PROFILE_ICON_IDS as readonly string[]).includes(value);
}

/**
 * Resolve a stable-per-name curated icon id — the deterministic default the
 * SPA renders for a user who hasn't picked one (existing users, follows that
 * predate the picker). The hash is bounded by the id list length so the same
 * user always maps to the same icon.
 */
export function defaultProfileIconIdFor(seed: string): ProfileIconId {
  const source = seed.length > 0 ? seed : 'user';
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) % PROFILE_ICON_IDS.length;
  }
  return PROFILE_ICON_IDS[hash]!;
}

/** Render one curated avatar's SVG contents for the given id. */
export function ProfileIconSvg({ id, className }: { id: ProfileIconId; className?: string }) {
  const paint = PALETTES[id];
  const renderer = RENDERERS[id];
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="64" height="64" fill={paint.bg} rx="12" />
      {renderer(paint)}
    </svg>
  );
}
