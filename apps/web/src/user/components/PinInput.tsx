import { useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';

import { cx } from './ui';

/** The mask glyph rendered in place of a typed PIN digit. */
const MASK_GLYPH = '•';

interface PinInputProps {
  label: string;
  length: number;
  value: string;
  onChange: (value: string) => void;
  /** Fired when the last box is filled (all `length` digits present) — used by
   *  the gate to auto-submit on the final digit (#288). */
  onComplete?: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  hint?: string;
}

/**
 * Segmented per-digit PIN entry (owner directive, issue #270): one box per
 * digit, auto-advance on input, backspace moves back, paste of a full PIN
 * distributes across boxes, and the DOM value is ALWAYS a mask glyph — never a
 * real digit, not even briefly (V4-P0 (a), supersedes the #288 in-value contract).
 *
 * The parent-controlled {@link PinInputProps.value} holds the real digits —
 * that is the source of truth for both {@link PinInputProps.onComplete} and any
 * form-level submit. Each box renders {@link MASK_GLYPH} when its digit is
 * present and an empty string otherwise, so the digit is never in the DOM at
 * any moment during entry; the pattern `[0-9]*` is intentionally absent so a
 * mask-glyph value does not fail native numeric validation on submit (the #288
 * failure mode kept the digit visible; V4-P0 flips the trade-off).
 */
export function PinInput({
  label,
  length,
  value,
  onChange,
  onComplete,
  autoFocus,
  disabled,
  hint,
}: PinInputProps) {
  const baseId = label.toLowerCase().replace(/\s+/g, '-');
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  function focusIndex(index: number) {
    inputsRef.current[index]?.focus();
  }

  function setDigitAt(index: number, digit: string) {
    const next = value.split('');
    next[index] = digit;
    onChange(next.join('').slice(0, length));
  }

  function handleChange(index: number, raw: string) {
    // The input's DOM value is `MASK_GLYPH` or empty; a keystroke may briefly
    // leave both the mask and the typed digit (`•4`) — strip the mask and any
    // other non-digit, then take the last digit typed.
    const digits = raw.replace(/\D/g, '');
    if (!digits) return;
    const next = value.split('');
    next[index] = digits.slice(-1) as string;
    const joined = next.join('').slice(0, length);
    onChange(joined);
    if (index < length - 1) focusIndex(index + 1);
    if (joined.length === length) onComplete?.(joined);
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (value[index]) {
        setDigitAt(index, '');
      } else if (index > 0) {
        setDigitAt(index - 1, '');
        focusIndex(index - 1);
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      focusIndex(index - 1);
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      e.preventDefault();
      focusIndex(index + 1);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!digits) return;
    onChange(digits);
    focusIndex(Math.min(digits.length, length - 1));
    if (digits.length === length) onComplete?.(digits);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${baseId}-0`} className="text-sm font-medium text-neutral-300">
        {label}
      </label>
      <div role="group" data-pin-input="true" className="flex flex-wrap gap-2">
        {Array.from({ length }, (_, index) => {
          const digit = value[index] ?? '';
          const displayed = digit ? MASK_GLYPH : '';
          return (
            <input
              key={index}
              ref={(el) => {
                inputsRef.current[index] = el;
              }}
              id={`${baseId}-${index}`}
              aria-label={index === 0 ? label : `${label} digit ${index + 1}`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={1}
              disabled={disabled}
              autoFocus={autoFocus && index === 0}
              // The DOM value is the mask glyph or empty — NEVER a raw digit,
              // not even briefly (V4-P0). Real digits live in parent state.
              value={displayed}
              data-filled={digit ? 'true' : undefined}
              onChange={(e) => handleChange(index, e.target.value)}
              onKeyDown={(e) => handleKeyDown(index, e)}
              onPaste={handlePaste}
              onFocus={(e) => e.target.select()}
              className={cx(
                'h-11 w-9 rounded-md text-center text-lg font-semibold text-neutral-100',
                'bg-neutral-950 ring-1 ring-inset ring-neutral-700',
                'focus:outline-none focus:ring-2 focus:ring-sky-500',
                'disabled:cursor-not-allowed disabled:text-neutral-500',
              )}
            />
          );
        })}
      </div>
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}
