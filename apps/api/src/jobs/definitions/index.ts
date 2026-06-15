import type { JobDefinition } from '../types';

import { heartbeatJob } from './heartbeat';

/**
 * Every job the worker process runs. Today only the heartbeat smoke-test has a
 * body; the §9 market-data and notification jobs are appended here as later
 * issues land their handlers, and the worker picks them up automatically.
 */
export const ALL_JOB_DEFINITIONS: readonly JobDefinition[] = [heartbeatJob];

export {
  heartbeatJob,
  HEARTBEAT_SCHEDULER_ID,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_ASSET_ID,
} from './heartbeat';
