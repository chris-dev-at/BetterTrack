import { mergeConfig, type Plugin } from 'vite';

import base from './vite.config';

const apiOrigin = process.env.BT_E2E_API_ORIGIN;
if (!apiOrigin) throw new Error('BT_E2E_API_ORIGIN is required by the e2e web server.');

const runtimeConfig = `window.__BT__ = ${JSON.stringify({
  app: 'user',
  apiOrigin,
  googleDriveClientId: process.env.VITE_GOOGLE_DRIVE_CLIENT_ID ?? '',
})};\n`;

/**
 * Give the browser the real API origin in e2e instead of sending its JSON and
 * Socket.IO traffic through Vite's development proxy.
 *
 * Playwright destroys a browser context at the end of every isolated flow.
 * That necessarily tears down its sockets without waiting for Vite's proxy,
 * whose generic error listener reports each ordinary client disconnect as
 * ECONNRESET/EPIPE. Hundreds of those messages looked like an app crash even
 * though the API, worker, Postgres and Redis stayed healthy for the full shard.
 *
 * BetterTrack supports the absolute-origin topology in production, including
 * credentialed CORS and realtime. Driving that topology here removes the
 * diagnostic intermediary without disabling realtime or hiding server logs.
 * The dev proxy remains configured: the fake Google IdP deliberately returns
 * through the web origin, and that callback still exercises `/api` via Vite.
 */
function e2eRuntimeConfig(): Plugin {
  return {
    name: 'bettertrack-e2e-runtime-config',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/config.js') return next();
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(runtimeConfig);
      });
    },
  };
}

export default mergeConfig(base, { plugins: [e2eRuntimeConfig()] });
