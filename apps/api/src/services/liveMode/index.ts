/** Live Mode — hot-asset registry, shared poll loops, ring buffer (§6.3, V3-P7b). */
export {
  LIVE_POLL_INTERVAL_MS,
  LIVE_POLL_MAX_INTERVAL_MS,
  LIVE_RING_RETENTION_MS,
  LIVE_SEED_MIN_GAP_MS,
  createLiveModeService,
  type LiveModeService,
  type LiveModeServiceDeps,
  type LiveModeServiceOptions,
} from './liveModeService';
export {
  createLiveRingBuffer,
  liveRingKey,
  type CreateLiveRingBufferOptions,
  type LiveRingBuffer,
} from './ringBuffer';
