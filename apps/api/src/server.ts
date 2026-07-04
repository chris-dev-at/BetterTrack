import { createApp } from './app';
import { loadConfig } from './config/env';
import { createDatabase } from './data/db';
import { buildContext } from './http/context';
import { createLogger } from './logger';
import { createRedis } from './redis';

const config = loadConfig();
const logger = createLogger(config);

const { db, client } = createDatabase(config.databaseUrl);
const redis = createRedis(config.redisUrl);

const ctx = buildContext({ config, db, redis, logger });
const app = createApp(ctx);

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'BetterTrack API listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'API shutting down');
  try {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Let in-flight background cache revalidations write their results before
    // their Redis connection goes away.
    await ctx.marketData.settled();
    await ctx.events.close();
    await redis.quit();
    await client.end();
  } catch (err) {
    logger.error({ err }, 'error during API shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
