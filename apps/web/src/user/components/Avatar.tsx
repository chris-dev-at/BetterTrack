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

/**
 * Origin avatar ramp (styles/origin.css `bt-avatar`): the 28px base used in
 * dense rows, its 40px `--lg` step for object headers, and a 56px hero size for
 * profile/thread openers. Pixel values rather than Tailwind boxes so the three
 * steps stay locked to the design system's own scale.
 */
const SIZES = {
  sm: 28,
  md: 40,
  lg: 56,
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
      className={cx('bt-avatar select-none overflow-hidden', className)}
      style={{ width: SIZES[size], height: SIZES[size] }}
    >
      <ProfileIconSvg id={resolvedId} className="h-full w-full" />
    </span>
  );
}
