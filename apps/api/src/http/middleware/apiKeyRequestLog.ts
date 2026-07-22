import type { RequestHandler } from 'express';

import type { ApiKeyService } from '../../services/apiKeys/apiKeyService';

/**
 * Per-key request-log capture (§13.5 V5-P10, issue 2/2). Plain middleware — it
 * adds NO route. For a personal-API-key request it folds one bounded audit line
 * (method, mount-relative path, response status) into the request log on
 * `finish`, so even a denied (403/429) request is recorded. Cookie sessions and
 * OAuth grants are ignored (OAuth carries its own audit).
 *
 * Capture is fire-and-forget and best-effort: `recordRequest` scrubs the path
 * and swallows any write failure, so the audit trail can NEVER add a failure
 * mode to request handling (the log write can't 5xx the request).
 */
export function createApiKeyRequestLogMiddleware(apiKeys: ApiKeyService): RequestHandler {
  return (req, res, next) => {
    const key = req.apiKey;
    if (key && key.kind === 'personal' && req.authUser) {
      const keyId = key.id;
      const userId = req.authUser.id;
      // Snapshot method/path now; by `finish` the path is still mount-relative
      // (`/api/v1` stripped) and stable for the matched request.
      const method = req.method;
      const path = req.path;
      res.on('finish', () => {
        void apiKeys.recordRequest({ keyId, userId, method, path, status: res.statusCode });
      });
    }
    next();
  };
}
