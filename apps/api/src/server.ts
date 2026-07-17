import { createApp } from './app';
import { loadConfig } from './config/env';
import { createDatabase } from './data/db';
import { buildContext } from './http/context';
import { ALL_QUEUE_NAMES } from './jobs';
import { createLogger } from './logger';
import {
  createMetricsServer,
  setQueueDepthCollector,
  setWebsocketGauge,
  type QueueDepthSample,
} from './metrics';
import { createRedis } from './redis';

const config = loadConfig();
const logger = createLogger(config);

const { db, client } = createDatabase(config.databaseUrl);
const redis = createRedis(config.redisUrl);

const ctx = buildContext({ config, db, redis, logger });
const app = createApp(ctx);

// Notification delivery is owned by the WORKER's durable `notifications.dispatch`
// job (#368) — the API only ENQUEUES through the center. Nothing to start here:
// the queue holds events until a worker picks them up, so no notification is
// ever lost to a restart on either side (#367's hard requirement).

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'BetterTrack API listening');
});

// Attach the realtime gateway to the API's HTTP server (§4.5, V3-P7a). A no-op
// when REALTIME_ENABLED=false — no socket server exists, zero behavior change.
await ctx.realtime.attach(server);

// Prometheus scrape listener (§13.5 V5-P2): its OWN localhost/LAN-bound HTTP
// server, never on the public /api/v1 surface. `null` when disabled (binds no
// port). The queue-depth and websocket gauges are sampled lazily on each scrape
// off the live registry and gateway, so no background timer is needed.
setWebsocketGauge(() => ctx.realtime.connectionCount());
if (ctx.queues) {
  const queues = ctx.queues;
  setQueueDepthCollector(async () => {
    const samples: QueueDepthSample[] = [];
    for (const name of ALL_QUEUE_NAMES) {
      const counts = await queues.get(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, value] of Object.entries(counts)) {
        samples.push({ queue: name, state, value });
      }
    }
    return samples;
  });
}
const metricsServer = createMetricsServer(config, logger);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'API shutting down');
  try {
    // Disconnect live websockets first — they are never "idle", so a plain
    // server.close() would wait on them forever. Also drops the gateway's bus
    // subscriptions before the bus itself closes below.
    await ctx.realtime.close();
    // Gateway disconnects release every live watch; this stops any loop a
    // still-in-flight tick might otherwise reschedule (§6.3, V3-P7b).
    ctx.liveMode.close();
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Close the metrics scrape listener alongside the main server.
    if (metricsServer) {
      metricsServer.closeIdleConnections();
      await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    }
    // Let in-flight background cache revalidations write their results before
    // their Redis connection goes away.
    await ctx.marketData.settled();
    await ctx.events.close();
    await redis.quit();
    await client.end();
    // Flush any buffered Sentry events before the process exits (§13.4 V4-P5a).
    await ctx.observability.close();
  } catch (err) {
    logger.error({ err }, 'error during API shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
