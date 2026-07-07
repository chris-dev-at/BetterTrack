/** Realtime gateway client (PROJECTPLAN.md §4.5, V3-P7a). */
export {
  RealtimeContext,
  RealtimeProvider,
  useRealtime,
  useRealtimeEvent,
  type RealtimeContextValue,
  type RealtimeServerEvent,
} from './RealtimeProvider';
export { createRealtimeSocket } from './socket';
