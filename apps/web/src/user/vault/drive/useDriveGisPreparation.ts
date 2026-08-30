import { useCallback, useEffect, useRef, useState } from 'react';

import { isDriveNotConfiguredError } from './driveConfiguration';

export type DriveGisPreparationState =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'failed'
  /** The deployment has no Drive client id — terminal, retrying cannot help. */
  | 'unconfigured';

export interface DriveGisPreparationOptions {
  /**
   * Runs whenever preparation (re)starts or is switched off — the seam the
   * enable wizard needs to drop the Drive home it captured, so a surface can
   * never continue with a capability from a preparation that no longer holds.
   */
  onReset?: () => void;
}

/**
 * Loads Google Identity Services before a control can ask it to open a popup.
 * `authorize()` intentionally never waits for GIS itself: awaiting a script
 * load from a click handler loses the browser's transient user activation.
 */
export function useDriveGisPreparation(
  enabled: boolean,
  prepare: (() => Promise<void>) | null | undefined,
  options: DriveGisPreparationOptions = {},
): {
  state: DriveGisPreparationState;
  retry(): void;
} {
  const [state, setState] = useState<DriveGisPreparationState>('idle');
  const generation = useRef(0);
  // Referential-stability guard (#1519 F6): preparation restarts on the
  // ENABLED decision only. A caller whose `prepare`/`onReset` identity churns
  // between renders must not be able to re-run preparation — that would fire
  // `onReset` in a loop and silently discard a consent the user already gave.
  const prepareRef = useRef(prepare);
  const onResetRef = useRef(options.onReset);
  useEffect(() => {
    prepareRef.current = prepare;
    onResetRef.current = options.onReset;
  });
  const available = prepare != null;

  const start = useCallback(() => {
    const run = prepareRef.current;
    if (!enabled || run == null) return;
    const current = ++generation.current;
    onResetRef.current?.();
    setState('preparing');
    void run().then(
      () => {
        if (generation.current === current) setState('ready');
      },
      (cause: unknown) => {
        if (generation.current !== current) return;
        setState(isDriveNotConfiguredError(cause) ? 'unconfigured' : 'failed');
      },
    );
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !available) {
      generation.current += 1;
      onResetRef.current?.();
      setState('idle');
      return;
    }
    start();
    return () => {
      generation.current += 1;
    };
  }, [available, enabled, start]);

  return { state, retry: start };
}
