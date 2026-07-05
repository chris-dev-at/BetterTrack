import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';

import { cx } from './ui';

const REVEAL_MS = 500;

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
 * distributes across boxes, and digits are masked shortly after entry — never
 * `type="password"`, which is what makes browsers offer a saved site password
 * as autofill on a PIN field.
 *
 * Masking is purely visual: the input `value` is ALWAYS the real digit (or
 * empty), and a mask is drawn over it with CSS (`-webkit-text-security`). Writing
 * a mask glyph into the value was the #288 bug — a non-digit `•` in a box whose
 * `pattern="[0-9]*"` demands digits fails native numeric validation and blocks
 * submit.
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
  const [revealedIndexes, setRevealedIndexes] = useState<ReadonlySet<number>>(new Set());
  const revealTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(
    () => () => {
      for (const timer of revealTimers.current.values()) clearTimeout(timer);
    },
    [],
  );

  // Each digit reveals independently so typing into a later box doesn't mask
  // an earlier one before its own timeout elapses.
  function revealBriefly(index: number) {
    const existing = revealTimers.current.get(index);
    if (existing) clearTimeout(existing);
    setRevealedIndexes((prev) => new Set(prev).add(index));
    revealTimers.current.set(
      index,
      setTimeout(() => {
        setRevealedIndexes((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
        revealTimers.current.delete(index);
      }, REVEAL_MS),
    );
  }

  function focusIndex(index: number) {
    inputsRef.current[index]?.focus();
  }

  function setDigitAt(index: number, digit: string) {
    const next = value.split('');
    next[index] = digit;
    onChange(next.join('').slice(0, length));
  }

  function handleChange(index: number, raw: string) {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return;
    const next = value.split('');
    next[index] = digits.slice(-1);
    const joined = next.join('').slice(0, length);
    onChange(joined);
    revealBriefly(index);
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
    for (let i = 0; i < digits.length; i++) revealBriefly(i);
    focusIndex(Math.min(digits.length, length - 1));
    if (digits.length === length) onComplete?.(digits);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${baseId}-0`} className="text-sm font-medium text-neutral-300">
        {label}
      </label>
      <div role="group" className="flex flex-wrap gap-2">
        {Array.from({ length }, (_, index) => {
          const digit = value[index] ?? '';
          const masked = digit !== '' && !revealedIndexes.has(index);
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
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={1}
              disabled={disabled}
              autoFocus={autoFocus && index === 0}
              // The value is ALWAYS the real digit (or empty) so numeric
              // validation never sees a mask glyph (#288); the dot is CSS-only.
              value={digit}
              data-masked={masked ? 'true' : undefined}
              onChange={(e) => handleChange(index, e.target.value)}
              onKeyDown={(e) => handleKeyDown(index, e)}
              onPaste={handlePaste}
              onFocus={(e) => e.target.select()}
              className={cx(
                'h-11 w-9 rounded-md text-center text-lg font-semibold text-neutral-100',
                'bg-neutral-950 ring-1 ring-inset ring-neutral-700',
                'focus:outline-none focus:ring-2 focus:ring-sky-500',
                'disabled:cursor-not-allowed disabled:text-neutral-500',
                masked && '[-webkit-text-security:disc]',
              )}
            />
          );
        })}
      </div>
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}
