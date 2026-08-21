import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { AppContext } from '../../context';
import type { AuthUser } from '../../types';
import {
  isLegacyParanoidRefusedScope,
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
      scopes: ['cash:read', 'mirrorchain:read', 'portfolio:read', 'vault:sync'],
      kind: 'personal',
      firstParty: false,
      securityGeneration: 0,
    };
    next();
  });
  app.use('/api/v1', enforceApiKeyScope({} as AppContext));
  app.get('/api/v1/cash/tags', (_req, res) => res.sendStatus(204));
  app.get('/api/v1/mirrorchain/chains', (_req, res) => res.sendStatus(204));
  app.get('/api/v1/portfolios', (_req, res) => res.sendStatus(204));
  app.get('/api/v1/vault', (_req, res) => res.sendStatus(204));
  installErrorResponse(app);
  return app;
}

describe('legacy-v1 paranoid bearer refusal', () => {
  it('keeps the pre-E9 scope set explicit and leaves vault sync open', () => {
    for (const scope of [
      'portfolio:read',
      'portfolio:write',
      'cash:read',
      'cash:write',
      'mirrorchain:read',
      'mirrorchain:write',
    ]) {
      expect(isLegacyParanoidRefusedScope(scope), scope).toBe(true);
    }
    expect(isLegacyParanoidRefusedScope('vault:sync')).toBe(false);
    expect(isLegacyParanoidRefusedScope('market:read')).toBe(false);
  });

  it('does not emit the account-wide refusal for a normal/new-model principal', async () => {
    const normal = scopeOnlyApp('normal');

    for (const path of ['/api/v1/cash/tags', '/api/v1/mirrorchain/chains', '/api/v1/portfolios']) {
      await request(normal).get(path).set('Authorization', 'Bearer resolved-test').expect(204);
    }
  });

  it('temporarily refuses old portfolio scopes only for a live v1 paranoid account', async () => {
    const legacy = scopeOnlyApp('paranoid');

    for (const path of ['/api/v1/cash/tags', '/api/v1/mirrorchain/chains', '/api/v1/portfolios']) {
      const denied = await request(legacy).get(path).set('Authorization', 'Bearer resolved-test');
      expect(denied.status, path).toBe(403);
      expect(denied.body.code, path).toBe(PARANOID_MODE_ERROR_CODE);
    }

    await request(legacy)
      .get('/api/v1/vault')
      .set('Authorization', 'Bearer resolved-test')
      .expect(204);
  });
});
