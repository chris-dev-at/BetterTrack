import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A submission failure together with the control it belongs to, when one can be
 * blamed. `field: null` marks a failure that belongs to the whole submission —
 * a network outage, a rate limit, or a deliberately generic "invalid
 * credentials" that must NOT point at a field (§6.1: no user enumeration).
 */
export interface AttributedError<F extends string = string> {
  field: F | null;
  message: string;
}

/**
 * Field-level error semantics for a form (review finding FRONTEND-09).
 *
 * The `TextField` / `Field` primitives already generate the error id, wire
 * `aria-describedby` and set `aria-invalid` (#979) — what was missing is a form
 * telling them WHICH field a failure belongs to, plus the "focus the first
 * invalid field" half of the recommendation.
 *
 * Usage: attach {@link formRef} to the `<form>` and {@link alertRef} to the
 * wrapper of the form-level `Alert`, feed `fieldError('email')` to that field's
 * `error` prop, render the alert only for `formError`, and call `fail(field,
 * message)` in the catch block. On every failure focus moves to the first
 * control the browser now considers invalid, or to the form-level alert when no
 * field is blamed. The DOM is queried rather than a ref threaded through every
 * primitive: `aria-invalid` is exactly the "first invalid field" marker, and the
 * shared primitives do not forward refs to their controls.
 *
 * Attribution is fail-safe: if the blamed control is not on screen when the
 * failure lands (a conditionally rendered field, a mode that flipped under the
 * form), the message is demoted to the form-level alert instead of rendering
 * nowhere.
 */
export function useFieldErrors<F extends string = string>() {
  // Wrapped in a fresh object per failure so two identical errors in a row
  // still re-run the focus effect.
  const [failure, setFailure] = useState<{ error: AttributedError<F> } | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const alertRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!failure) return;
    // Invariant this query depends on (review nit): within one form, `aria-invalid`
    // is set ONLY by `fieldError`, and a failure blames at most one field — so the
    // first invalid control IS the blamed one, and "no invalid control" means the
    // blamed field is unmounted. A control carrying a static `aria-invalid="true"`
    // would break both halves (stealing focus, and suppressing the demote below),
    // so keep validity in this hook rather than hardcoding it on a field.
    const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? null;
    if (invalid === null && failure.error.field !== null) {
      // The blamed control is not rendered (or sits outside the form), so its
      // message would be invisible: `fieldError` feeds a field nobody shows and
      // `formError` stays null. Demote to form-level rather than dropping the
      // failure — a submission that fails must always say so somewhere. The
      // demoted failure carries `field: null`, so this cannot re-enter.
      setFailure({ error: { field: null, message: failure.error.message } });
      return;
    }
    // Guarded: jsdom gives every element a `focus`, but a caller may render the
    // alert conditionally and unmount it before the effect runs.
    (invalid ?? alertRef.current)?.focus?.();
  }, [failure]);

  const fail = useCallback((field: F | null, message: string) => {
    setFailure({ error: { field, message } });
  }, []);

  const clear = useCallback(() => setFailure(null), []);

  const error = failure?.error ?? null;

  return {
    formRef,
    alertRef,
    /** The message owned by `field`, or `undefined` — feed to its `error` prop. */
    fieldError: (field: F) => (error?.field === field ? error.message : undefined),
    /** The message no field can own, or `null` — the form-level `Alert`. */
    formError: error !== null && error.field === null ? error.message : null,
    fail,
    clear,
  };
}
