/** Realtime gateway client (PROJECTPLAN.md §4.5, V3-P7a). */
export {
  RealtimeContext,
  RealtimeProvider,
  usePresence,
  useRealtime,
  useRealtimeEvent,
  type LiveWatchResult,
  type RealtimeContextValue,
  type RealtimeDisabledFeatures,
  type RealtimeServerEvent,
  type RealtimeSheddableFeature,
} from './RealtimeProvider';
export { createRealtimeSocket } from './socket';
export { framesToPoints, mergePoints, bucketSeconds, type LivePoint } from './liveSeries';
export { useLiveSeries, type LiveSeriesState } from './useLiveSeries';
