/** Floating Ask BetterTrack panel (R2): the panel and its rail-row trigger state. */
export { ASK_DOCK_ATTRIBUTE, ASK_DOCK_ID, AskDock } from './AskDock';
export {
  resetAskDockCache,
  setAskDockOpen,
  toggleAskDock,
  toggleAskDockMaximized,
  toggleAskDockPinned,
  useAskDockState,
  type AskDockState,
} from './askDockStore';
export { ASK_DOCK_MIN_WIDTH, useAskDockAvailable, useAskDockEligible } from './useAskDockEligible';
