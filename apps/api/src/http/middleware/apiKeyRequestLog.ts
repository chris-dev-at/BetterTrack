import type { RequestHandler } from 'express';

import type { ApiKeyService } from '../../services/apiKeys/apiKeyService';
import {
  isVaultSensitiveUnattributedAssetRequest,
  vaultedPortfolioTargetForRequest,
} from '../../services/account/vaultedPortfolioEnforcement';

/**
 * Per-key request-log capture (§13.5 V5-P10, issue 2/2). Plain middleware — it
 * adds NO route. For a normal account's personal-API-key request it folds one
 * bounded audit line (method, mount-relative path, response status) into the
 * request log on `finish`, so even a denied (403/429) request is recorded.
 * Paranoid capture is suppressed at the locked repository boundary, and so is a
 * vault owner's traffic on the custody segments — see the `suppressIfAnyVault`
 * comment below, which prices what that costs the audit trail. Cookie sessions
 * and OAuth grants are ignored (OAuth carries its own audit).
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
      const target = vaultedPortfolioTargetForRequest({
        method,
        path: req.originalUrl,
        params: req.params,
        query: req.query,
        body: req.body,
        valid: req.valid,
      });
      // THE AUDIT-TRAIL COST, stated where it is paid (#1952). This flag does
      // not redact the line — `apiKeyRequestLogRepository.record` drops the
      // whole `api_key_request_log` ROW when the account owns any vault. So a
      // vault owner's personal-key request under `/assets/…` or
      // `/custom-assets/:id…` leaves no audit line at all, and that includes
      // the NON-GET ones: `PATCH`/`DELETE /custom-assets/:id` mutate a private
      // object and are recorded nowhere (the predicate is method-independent
      // since #1896). Deliberate — this table stores `path` verbatim, so a
      // retained line would carry the same private uuid the usage suppression
      // exists to keep out — but it means a missing line for such an account is
      // evidence of the vault boundary, never of a dropped write, and the
      // per-key trail an operator reads for a vault owner is incomplete by
      // design. `apiKeyGovernance.test.ts` pins both the GET and the non-GET
      // case so this is a decision rather than a discovery.
      const suppressIfAnyVault = isVaultSensitiveUnattributedAssetRequest(req.originalUrl);
      res.on('finish', () => {
        void apiKeys.recordRequest({
          keyId,
          userId,
          method,
          path,
          status: res.statusCode,
          targetPortfolioId: target?.portfolioId,
          suppressIfAnyVault,
        });
      });
    }
    next();
  };
}
