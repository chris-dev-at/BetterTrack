/** Right-side chat dock (R2): the topbar trigger and the dock it opens. */
export { CHAT_DOCK_ID, ChatDock } from './ChatDock';
export { ChatDockToggle } from './ChatDockToggle';
export {
  resetChatDockCache,
  setChatDockOpen,
  setChatDockTab,
  toggleChatDock,
  useChatDockState,
  type ChatDockTab,
} from './chatDockStore';
export { DOCK_MIN_WIDTH } from './useDockEligible';
