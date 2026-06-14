import express from 'express';
import helmet from 'helmet';

import { healthRouter } from './http/healthRouter';

/**
 * Builds the Express application. Kept separate from `server.ts` so tests can
 * mount the app without binding a port (see `app.test.ts`).
 */
export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(express.json());

  app.use('/api/v1', healthRouter);

  return app;
}
