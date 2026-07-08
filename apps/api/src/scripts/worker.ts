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
import { createDatabase } from '../data/db';
import { createEventBus } from '../events';
import {
  createDeadLetter,
  createJobDefinitions,
  createJobWorkers,
  createQueueRegistry,
  jobConnectionFactory,
  registerSchedules,
  type JobContext,
} from '../jobs';
import { createLogger } from '../logger';
import { createMarketData } from '../providers';

const config = loadConfig();
const logger = createLogger(config);
const createConnection = jobConnectionFactory(config.redisUrl);

// Dedicated connections per role: pub/sub subscriber must be its own; the
// dead-letter list, queue registry and market-data cache get ordinary
// (non-blocking) connections.
const events = createEventBus({
  publisher: createConnection(),
  subscriber: createConnection(),
  logger,
});
const deadLetterConnection = createConnection();
const deadLetter = createDeadLetter(deadLetterConnection);
const registry = createQueueRegistry(createConnection());

// The market-data jobs read/write Postgres and reach providers through the same
// caching/resilience service the API uses.
const { db, client } = createDatabase(config.databaseUrl);
const marketDataConnection = createConnection();
const { registry: providerRegistry, service: marketData } = createMarketData({
  db,
  redis: marketDataConnection,
  queueOptions: {
    concurrency: config.providers.maxConcurrency,
    minSpacingMs: config.providers.minSpacingMs,
  },
  options: {
    // Failed background revalidations never surface to callers (§5.3 — they
    // already got the stale copy), so the log line is their only trace.
    onBackgroundError: (key, err) =>
      logger.warn({ key, err }, 'market-data background refresh failed'),
  },
});
const definitions = createJobDefinitions({
  db,
  marketData,
  // Custom assets (the `manual` provider) are durable in our own DB; the price
  // jobs must not fetch them (see MarketDataJobDeps.isLocalProvider).
  isLocalProvider: (providerId) =>
    providerRegistry.has(providerId) && providerRegistry.get(providerId).local === true,
});

const ctx: JobContext = { events, deadLetter, redis: deadLetterConnection, logger };

const running = createJobWorkers({
  createConnection,
  definitions,
  ctx,
  logger,
});

// Notification fan-out (§9, §6.10) is owned by the API process — its dispatcher
// subscribes to the same Redis pub/sub bus, so the worker no longer runs one (a
// single owner avoids double-dispatch; see server.ts / http/context.ts).

const scheduled = await registerSchedules(registry, definitions);
logger.info({ queues: definitions.map((d) => d.name), scheduled }, 'BetterTrack worker started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  try {
    await running.close();
    // Let in-flight background cache revalidations write their results before
    // their Redis connection goes away.
    await marketData.settled();
    await registry.close();
    await events.close();
    await deadLetterConnection.quit();
    await marketDataConnection.quit();
    await client.end();
  } catch (err) {
    logger.error({ err }, 'error during worker shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
