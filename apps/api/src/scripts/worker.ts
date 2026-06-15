/**
 * BullMQ worker process (PROJECTPLAN.md §9).
 *
 * A separate process from the API, sharing its env/Redis config. Run it with:
 *   - dev:  `pnpm --filter @bettertrack/api worker`
 *   - prod: `pnpm --filter @bettertrack/api start:worker` (after `pnpm build`)
 *
 * It boots the typed event bus, the dead-letter list and the queue registry,
 * starts a worker per job definition, registers the repeatable schedules from
 * code, and shuts everything down cleanly on SIGINT/SIGTERM.
 */
import { loadConfig } from '../config/env';
import { createEventBus } from '../events';
import {
  ALL_JOB_DEFINITIONS,
  createDeadLetter,
  createJobWorkers,
  createQueueRegistry,
  jobConnectionFactory,
  registerSchedules,
  type JobContext,
} from '../jobs';
import { createLogger } from '../logger';

const config = loadConfig();
const logger = createLogger(config);
const createConnection = jobConnectionFactory(config.redisUrl);

// Dedicated connections per role: pub/sub subscriber must be its own; the
// dead-letter list and queue registry get ordinary shared-style connections.
const events = createEventBus({
  publisher: createConnection(),
  subscriber: createConnection(),
  logger,
});
const deadLetterConnection = createConnection();
const deadLetter = createDeadLetter(deadLetterConnection);
const registry = createQueueRegistry(createConnection());

const ctx: JobContext = { events, deadLetter, redis: deadLetterConnection, logger };

const running = createJobWorkers({
  createConnection,
  definitions: ALL_JOB_DEFINITIONS,
  ctx,
  logger,
});

const scheduled = await registerSchedules(registry, ALL_JOB_DEFINITIONS);
logger.info(
  { queues: ALL_JOB_DEFINITIONS.map((d) => d.name), scheduled },
  'BetterTrack worker started',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  try {
    await running.close();
    await registry.close();
    await events.close();
    await deadLetterConnection.quit();
  } catch (err) {
    logger.error({ err }, 'error during worker shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
