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
 */
export function Skeleton({ variant = 'block', width, height = 'h-4', className }: SkeletonProps) {
  const t = useT();
  return (
    <span
      role="status"
      aria-label={t('common.loadingLabel')}
      className={cx(
        'inline-block animate-pulse rounded bg-neutral-800',
        width ?? (variant === 'block' ? 'w-full' : 'w-24'),
        height,
        className,
      )}
    />
  );
}
