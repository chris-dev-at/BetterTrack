import type { ProfileIconId } from '@bettertrack/contracts';

import { cx } from './ui';
import { ProfileIconSvg, defaultProfileIconIdFor, isProfileIconId } from './profileIcons';

/**
 * The visual anchor for a person across every social surface (friend rows,
 * requests, chat header + list, public profiles, shared-with-me groups, the
 * audience picker's friend multi-select). Renders one of the curated bundled
 * SVGs (§13.5 V5-P0c) — file uploads are deliberately deferred, so `iconId` is
 * the ONLY visual identity a user carries here. A user without a stored choice
 * (`iconId` is `null` or `undefined`) renders a deterministic id/username-derived
 * default from the same curated set, so no surface renders empty.
 *
 * Presentational only: same person = same avatar on every surface.
 */

const SIZES = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-14 w-14',
} as const;

export type AvatarSize = keyof typeof SIZES;

export function Avatar({
  name,
  iconId,
  size = 'md',
  className,
}: {
  /** Display name used to derive the deterministic default (also the accessible label). */
  name: string;
  /** The user's stored curated icon id, or `null`/`undefined` to fall back to the default. */
  iconId?: ProfileIconId | string | null;
  size?: AvatarSize;
  className?: string;
}) {
  // An unknown id (older client, hand-edited row) reads as "no choice" and
  // falls back to the deterministic default — never a broken tile.
  const resolvedId: ProfileIconId =
    iconId != null && isProfileIconId(iconId) ? iconId : defaultProfileIconIdFor(name || '?');
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full ring-1 ring-inset ring-white/10',
        SIZES[size],
        className,
      )}
    >
      <ProfileIconSvg id={resolvedId} className="h-full w-full" />
    </span>
  );
}
