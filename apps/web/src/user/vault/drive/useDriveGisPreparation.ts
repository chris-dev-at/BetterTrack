import { useCallback, useEffect, useRef, useState } from 'react';

export type DriveGisPreparationState = 'idle' | 'preparing' | 'ready' | 'failed';

/**
 * Loads Google Identity Services before a control can ask it to open a popup.
 * `authorize()` intentionally never waits for GIS itself: awaiting a script
 * load from a click handler loses the browser's transient user activation.
 */
export function useDriveGisPreparation(
  enabled: boolean,
  prepare: (() => Promise<void>) | null | undefined,
): {
  state: DriveGisPreparationState;
  retry(): void;
} {
  const [state, setState] = useState<DriveGisPreparationState>('idle');
  const generation = useRef(0);

  const start = useCallback(() => {
    if (!enabled || prepare == null) return;
    const current = ++generation.current;
    setState('preparing');
    void prepare().then(
      () => {
        if (generation.current === current) setState('ready');
      },
      () => {
        if (generation.current === current) setState('failed');
      },
    );
  }, [enabled, prepare]);

  useEffect(() => {
    if (!enabled || prepare == null) {
      generation.current += 1;
      setState('idle');
      return;
    }
    start();
    return () => {
      generation.current += 1;
    };
  }, [enabled, prepare, start]);

  return { state, retry: start };
}
