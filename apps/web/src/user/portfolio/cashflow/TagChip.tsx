import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import { tagChipStyle } from './tagChipColor';

export interface TagChipProps {
  name: string;
  color: string;
  className?: string;
  /** Present ⇒ renders a small remove control inside the chip (the tag editor). */
  onRemove?: () => void;
}

/**
 * One flat tag, rendered as a tinted pill: the tag's own colour at low alpha
 * for the fill, the same hue (contrast-nudged where needed — see
 * `tagChipColor.ts`) for the text. Copies the `.bt-pf-chip` technique
 * (origin.css) — tint the background, keep the ink strong — applied to a text
 * label instead of a glyph.
 */
export function TagChip({ name, color, className, onRemove }: TagChipProps) {
  const t = useT();
  return (
    <span className={cx('bt-tag-chip', className)} style={tagChipStyle(color)}>
      <span className="bt-tag-chip__label" title={name}>
        {name}
      </span>
      {onRemove ? (
        <button
          aria-label={t('cashflow.tags.removeFromMovement', { name })}
          className="bt-tag-chip__remove"
          onClick={onRemove}
          type="button"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
