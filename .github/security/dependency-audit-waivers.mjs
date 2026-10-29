/**
 * Temporary, reviewed production-dependency audit waivers.
 *
 * Every entry needs a specific GHSA, audited package name, short expiry, and
 * reason. The audit verifier rejects unknown, expired, malformed, package
 * mismatched, and no-longer-needed waivers. See docs/SECURITY_CI_POLICY.md
 * before adding or renewing one.
 *
 * Empty is the goal state, and reaching it removed the only record of two
 * hand-tracked supply-chain decisions (the drizzle 0.x-minor Dependabot fence
 * and the `shell-quote` production pin). Both now live in
 * docs/SECURITY_CI_POLICY.md, "tracked by hand" — read that before assuming an
 * override or an ignore rule is stale.
 */
export const dependencyAuditWaivers = {
  // Direct runtime package whose only fix is a deliberate major migration.
  'GHSA-mrhx-c7xc-m3w5': {
    expires: '2026-11-12',
    moduleName: 'zod',
    reason:
      'Added 2026-10-29 as a 14-day bridge; REACHABLE, and mitigated in our own code rather than unreachable. The advisory (zod parses every array element even after .max() failed and keeps one issue per failing element, per missing field) is fixed only in zod 4.6.6; the 3.x line ends at 3.25.76 with no backport, and the v3 -> v4 + zod-to-openapi 7 -> 9 move is the migration parked behind #1031 (Dependabot ignores the zod major on purpose). yahoo-finance2 / @modelcontextprotocol/sdk already carry zod 4.6.7 here, so only our zod 3.25.76 (apps/api, packages/contracts, zod-to-openapi 7) is reported. Exposure: every JSON body is capped at 100 KiB (GLOBAL_JSON_BODY_LIMIT) before any schema runs, CSV uploads by csvUploadLimits, except TWO wide-body routes that parse up to 8x the encrypted vault cap (paranoidRestoreJsonLimitBytes): POST /api/v1/portfolios/:id/vault/move-out (64 MiB by default) and POST /api/v1/account/paranoid/disable (128 MiB). Unmitigated, one 1 MiB move-out body from ANY logged-in account built 349,520 issues (+382 MiB heap) and ~10 MiB would OOM the single API process. Mitigations (same PR): (1) authorize before parse: move-out reads an owner-scoped admission BEFORE its parser, so anonymous callers get 401 and other accounts 404 without the body being read, the owner of a plain portfolio gets only the 100 KiB bound, and only a vaulted portfolio (or one holding a move-out receipt, for the idempotent retry) gets the wide bound; disable already picks the wide parser only for a paranoid account; (2) a raw-shape pre-check with no zod (packages/contracts vault.ts, precheckVaultStrictDocumentShape) refuses entities / mirrorProvenance longer than one per 160 body bytes, a mergeLog longer than one per 96 bytes, and the nested arrays at their documented maxima, then entities, mergeLog and mirrorProvenance are validated one element at a time with early exit, so a malformed document yields at most one element worth of issues; (3) every VALIDATION_ERROR ships at most 20 issues plus issueCount (validate.ts), so the 100 KiB routes no longer return multi-MiB error bodies. Residual risk: on the 100 KiB routes zod still builds its full issue list internally before the cap applies (bounded by the body: the review probe peaked at ~171k issues / +37 MiB transient heap per request), and an authorized vault owner or paranoid account can still spend bounded CPU (one extra linear pass over a document up to the route cap) on their own malformed document, metered by the per-account vault rate limit. Bridge: land #1031 by 2026-11-12, when this entry expires and the verifier fails closed; renewing it needs a fresh review.',
  },
};
