import { useEffect } from 'react';

let activeLocks = 0;
let overflowBeforeFirstLock: string | undefined;

function acquireBodyScrollLock() {
  if (activeLocks === 0) {
    overflowBeforeFirstLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  activeLocks += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLocks -= 1;

    if (activeLocks === 0) {
      document.body.style.overflow = overflowBeforeFirstLock ?? '';
      overflowBeforeFirstLock = undefined;
    }
  };
}

/** Keeps body scrolling locked until every active overlay releases its hold. */
export function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    return acquireBodyScrollLock();
  }, [active]);
}
