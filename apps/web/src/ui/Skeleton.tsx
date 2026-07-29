import { useT } from '../i18n';
import { cx } from '../lib/cx';

export interface SkeletonProps {
  /**
   * `'block'` (default) fills the available width; `'line'` is a narrower stub
   * suited to inline text placeholders.
   */
  variant?: 'block' | 'line';
  /** Tailwind width class, e.g. `'w-32'`. Defaults: `'w-full'` (block) / `'w-24'` (line). */
  width?: string;
  /** Tailwind height class, e.g. `'h-8'`. Defaults to `'h-4'`. */
  height?: string;
  className?: string;
}

/**
 * Animated placeholder shown while data loads (PROJECTPLAN.md §7.1 skeleton
 * loaders). Carries `role="status"` so assistive tech announces the pending
 * state rather than reading an empty box.
 *
 * Uses the Origin `bt-skeleton` surface — a soft token-coloured block with the
 * system's sweep shimmer (which honours `prefers-reduced-motion`) in place of
 * the old opacity pulse.
 */
export function Skeleton({ variant = 'block', width, height = 'h-4', className }: SkeletonProps) {
  const t = useT();
  return (
    <span
      role="status"
      aria-label={t('common.loadingLabel')}
      className={cx(
        'bt-skeleton inline-block',
        width ?? (variant === 'block' ? 'w-full' : 'w-24'),
        height,
        className,
      )}
    />
  );
}
