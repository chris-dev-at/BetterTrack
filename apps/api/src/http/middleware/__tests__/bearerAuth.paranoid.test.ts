import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { AppContext } from '../../context';
import type { AuthUser } from '../../types';
import {
  createParanoidRouteGuard,
  isParanoidKilledScope,
  PARANOID_MODE_ERROR_CODE,
} from '../../../services/account/paranoidEnforcement';
import { enforceApiKeyScope } from '../bearerAuth';

type PrivacyMode = AuthUser['privacyMode'];

function installErrorResponse(app: Application): void {
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const apiError = error as { code?: string; statusCode?: number };
    res.status(apiError.statusCode ?? 500).json({ code: apiError.code ?? 'UNKNOWN' });
  });
}

function scopeOnlyApp(privacyMode: PrivacyMode): Application {
  const app = express();
  app.use('/api/v1', (req, _res, next) => {
    req.authUser = { privacyMode } as AuthUser;
    req.apiKey = {
      id: `${privacyMode}-key`,
      scopes: ['cash:read', 'mirrorchain:read', 'vault:sync'],
      kind: 'personal',
      securityGeneration: 0,
    };
    next();
  });
  app.use('/api/v1', enforceApiKeyScope({} as AppContext));
  app.get('/api/v1/cash/tags', (_req, res) => res.sendStatus(204));
  app.get('/api/v1/mirrorchain/chains', (_req, res) => res.sendStatus(204));
  app.get('/api/v1/vault', (_req, res) => res.sendStatus(204));
  installErrorResponse(app);
  return app;
}

function routeOnlyApp(): Application {
  const app = express();
  app.use('/api/v1', (req, _res, next) => {
    req.authUser = { privacyMode: 'paranoid' } as AuthUser;
    next();
  });
  app.use('/api/v1', createParanoidRouteGuard());
  app.get('/api/v1/cash/tags', (_req, res) => res.sendStatus(204));
  app.get('/api/v1/settings/taxes', (_req, res) => res.sendStatus(204));
  installErrorResponse(app);
  return app;
}

describe('paranoid bearer and route guards', () => {
  it('classifies cash and mirrorchain scopes as killed but keeps vault sync', () => {
    for (const scope of ['cash:read', 'cash:write', 'mirrorchain:read', 'mirrorchain:write']) {
      expect(isParanoidKilledScope(scope), scope).toBe(true);
    }
    expect(isParanoidKilledScope('vault:sync')).toBe(false);
  });

  it('denies cash and mirrorchain at the scope layer only for paranoid accounts', async () => {
    const paranoid = scopeOnlyApp('paranoid');
    const normal = scopeOnlyApp('normal');

    for (const path of ['/api/v1/cash/tags', '/api/v1/mirrorchain/chains']) {
      const denied = await request(paranoid).get(path).set('Authorization', 'Bearer resolved-test');
      expect(denied.status, path).toBe(403);
      expect(denied.body.code, path).toBe(PARANOID_MODE_ERROR_CODE);

      await request(normal).get(path).set('Authorization', 'Bearer resolved-test').expect(204);
    }

    await request(paranoid)
      .get('/api/v1/vault')
      .set('Authorization', 'Bearer resolved-test')
      .expect(204);
  });

  it('normalizes a variant-cased path before the paranoid route lookup', async () => {
    const denied = await request(routeOnlyApp()).get('/api/v1/Cash/tags');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe(PARANOID_MODE_ERROR_CODE);
  });

  it('normalizes a trailing slash before matching an exact paranoid kill rule', async () => {
    const denied = await request(routeOnlyApp()).get('/api/v1/Settings/Taxes/');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe(PARANOID_MODE_ERROR_CODE);
  });
});
