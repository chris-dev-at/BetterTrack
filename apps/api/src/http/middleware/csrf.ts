import type { RequestHandler } from 'express';

import { forbidden } from '../../errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF belt-and-suspenders (PROJECTPLAN.md §10): state-changing requests must
 * carry `X-Requested-With: BetterTrack`. Combined with SameSite=Lax cookies and
 * no cross-site embeds, this blocks forged cross-site mutations cheaply.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.get('x-requested-with') !== 'BetterTrack') {
    next(forbidden('Missing or invalid X-Requested-With header.', 'CSRF_HEADER_REQUIRED'));
    return;
  }
  next();
};
