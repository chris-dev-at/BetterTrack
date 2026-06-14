import { createApp } from './app';
import { loadConfig } from './config/env';
import { createDatabase } from './data/db';
import { buildContext } from './http/context';
import { createLogger } from './logger';
import { createRedis } from './redis';

const config = loadConfig();
const logger = createLogger(config);

const { db } = createDatabase(config.databaseUrl);
const redis = createRedis(config.redisUrl);

const ctx = buildContext({ config, db, redis, logger });
const app = createApp(ctx);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'BetterTrack API listening');
});
