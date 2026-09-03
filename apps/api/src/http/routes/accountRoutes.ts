import { json, Router, type RequestHandler } from 'express';

import {
  deleteAccountRequestSchema,
  exportDownloadRequestSchema,
  exportRequestSchema,
  paranoidDisableRequestSchema,
  paranoidEnableRequestSchema,
  type DeleteAccountRequest,
  type ExportDownloadRequest,
  type ExportRequest,
  type ParanoidDisableRequest,
  type ParanoidEnableRequest,
} from '@bettertrack/contracts';

import { ApiError } from '../../errors';
import {
  PARANOID_TRANSITION_HTTP_ERRORS,
  ParanoidTransitionError,
} from '../../services/account/paranoidTransitionService';
import {
  GLOBAL_JSON_BODY_LIMIT,
  PARANOID_RESTORE_PLAINTEXT_FACTOR,
  paranoidRestoreJsonLimitBytes,
} from '../bodyLimits';
import { clearSessionCookie } from '../cookies';
import { requireUser } from '../middleware/session';
import { validateBody } from '../middleware/validate';
import type { RateLimiters } from '../middleware/rateLimit';
import type { AppContext } from '../context';

export const PARANOID_DISABLE_HTTP_PATH = '/api/v1/account/paranoid/disable';

/**
 * Plaintext allowance over the stored ciphertext bound for the one route that
 * carries a decrypted vault. The client deflates the envelope BEFORE encrypting
 * it, so the restore JSON is never smaller than the blob and is typically
 * several-fold larger. Deriving the body limit from `BT_VAULT_MAX_BYTES` alone
 * would accept a document for storage that can never be handed back — and
 * disable is the only way out of paranoid mode, so a 413 there is a trap with no
 * second exit. The factor covers the ratio deflate reaches on this JSON
 * (repeated keys, ISO dates, decimal strings) with margin; see
 * docs/paranoid-design.md §7 for the resulting practical ceiling.
 *
 * The buffered-body cost that buys is accepted: the route is session-gated and
 * rides the per-account vault rate schedule, and rehydrating a document of that
 * size already costs strictly more memory than holding its bytes.
 */
export const paranoidDisableJsonLimitBytes = (vaultMaxBytes: number): number =>
  paranoidRestoreJsonLimitBytes(vaultMaxBytes);

export { PARANOID_RESTORE_PLAINTEXT_FACTOR };

/**
 * Bound how long one download may hold the account transition lock. The transfer
 * streams inside that lock (a paranoid enable must not retire the archive
 * mid-transfer), so an abandoned client would otherwise park a lock-pool
 * connection idle-in-transaction — and block that account's enable — for as long
 * as its socket stays open. This is an IDLE bound: a slow but progressing
 * transfer keeps resetting it, only a stalled one is cut.
 *
 * Capacity consequence, spelled out where the number lives: each in-flight
 * download occupies ONE connection of the dedicated privacy-lock pool
 * (`createDatabase`, `max: 10`) for as long as it streams, so at most 10
 * concurrent guarded downloads per API process — the 11th queues on the pool, and
 * a fleet of stalled ones is released after this bound rather than never. See the
 * matching note beside the pool in `server.ts` / `scripts/worker.ts`; raising the
 * concurrent-download ceiling means raising that pool, not lengthening this.
 *
 * An inactivity bound alone is not enough: a client that reads one byte just
 * inside every window resets it forever and pins the connection indefinitely.
 * `EXPORT_DOWNLOAD_MAX_MS` (in the export service, where the lock is taken) is
 * the ABSOLUTE companion bound that ends such a transfer regardless of pacing;
 * this one exists to cut a dead-but-open socket long before that.
 */
export const EXPORT_DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

/**
 * The privacy-mode transitions are owner-browser-session work, and the global
 * bearer policy marks `/account/paranoid/*` session-only for that reason. This is
 * the second, LOCAL half of the same rule — the mirror of `/vault`'s own
 * `requireCookieSession`, and the structural answer to how these two routes got
 * bearer-reachable in the first place: they were mounted on a router whose
 * `/account/**` policy row grants `account:security`, and inherited it silently.
 * Stating the boundary in the router means a future transition route, a remount,
 * or a reshuffle of the policy table cannot quietly re-widen it, and direct-router
 * use in a test carries the same rule as production.
 *
 * The sibling `/account` routes deliberately stay bearer-callable (the mobile
 * in-app deletion and export flows, #362/#494), so this is per-route, not a
 * router-wide `use`.
 */
const requireOwnerBrowserSession: RequestHandler = (req, _res, next) => {
  if (req.apiKey || !req.sessionId) {
    next(
      new ApiError(
        403,
        'API_KEY_FORBIDDEN',
        'Privacy mode transitions are available only to the owning browser session.',
      ),
    );
    return;
  }
  next();
};

/**
 * Account-lifecycle endpoints (PROJECTPLAN.md §13.4). Two families:
 *
 * - **Self-service account deletion** (V4-P2c, #362): the shared capability
 *   behind the web deletion page and the mobile in-app flow.
 * - **Account data export** (V4-P6a, #494): re-auth-gated `POST /export`
 *   (1/day) creates an async zip job and returns the raw download token once;
 *   `GET /export` polls status; `POST /export/download` consumes the token from
 *   its body and streams the assembled zip when the job is ready and unexpired.
 *
 * User-kind only. The mutating routes ride the login rate schedule (per-IP)
 * because they re-verify a credential; each service adds its own per-account
 * throttle.
 */
export function createAccountRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  const runTransition = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ParanoidTransitionError)) throw error;
      const mapped = PARANOID_TRANSITION_HTTP_ERRORS[error.code];
      throw new ApiError(mapped.status, mapped.code, error.message);
    }
  };

  router.delete(
    '/',
    requireUser,
    limiters.login,
    validateBody(deleteAccountRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as DeleteAccountRequest;
      await ctx.accountDeletion.deleteAccount({ userId: req.authUser!.id, body, ip: req.ip });
      // The session store is already empty; clear the cookie for the web caller
      // (a bearer caller's credential rows died with the user).
      clearSessionCookie(res, ctx.config);
      res.json({ ok: true });
    },
  );

  // Both public transition directions ship as one surface. The service holds
  // the account row lock through each atomic purge/rehydration transaction.
  router.post(
    '/paranoid/enable',
    requireUser,
    requireOwnerBrowserSession,
    limiters.vault,
    validateBody(paranoidEnableRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as ParanoidEnableRequest;
      res.json(await runTransition(() => ctx.paranoidTransitions.enable(req.authUser!.id, body)));
    },
  );

  // The enable wizard's capture read (docs/paranoid-design.md §7.1). It runs
  // BEFORE enable, while `mirror_rows` still exists, and returns only the
  // caller's own severed-fork identity map — never an active membership, another
  // member's identity, or any chain metadata.
  router.get(
    '/paranoid/fork-provenance',
    requireUser,
    requireOwnerBrowserSession,
    async (req, res) => {
      res.json(await ctx.paranoidTransitions.forkProvenance(req.authUser!.id));
    },
  );

  // The other half of the capture: the CAS token the wizard reads BEFORE its
  // first row read and hands back to enable, which re-derives it under the
  // account lock. Opaque row hashes only — never portfolio content.
  // It shares `enable`'s vault budget because it costs what a write costs: one
  // aggregate per restorable table over the caller's whole dataset. The wizard
  // spends exactly one per attempt, so the 60/min steady state is invisible to
  // it and still bounds a loop that hammers the fan-out at nothing.
  // NOTE: a GET that changes state — it opens/renews this account's own enable
  // window and disposes of an already-expired one. See `normalDataRevision` in
  // `paranoidTransitionService` for why that is safe under the CSRF exemption
  // every safe method gets.
  router.get(
    '/paranoid/normal-revision',
    requireUser,
    requireOwnerBrowserSession,
    limiters.vault,
    async (req, res) => {
      res.json(await ctx.paranoidTransitions.normalDataRevision(req.authUser!.id));
    },
  );

  // The widened bound is spent ONLY on an account that can legitimately restore.
  // `app.ts` defers the global parser for this one path before any auth runs, so
  // the choice has to be made here — this handler sits after `requireUser`, which
  // is the first point `req.authUser.privacyMode` exists. A normal-mode caller
  // therefore never makes the process buffer and `JSON.parse` a multi-MiB body
  // just to be told `PARANOID_NOT_ENABLED`; it keeps the same 100 KiB bound as
  // every other route.
  const restoreJson = json({ limit: paranoidDisableJsonLimitBytes(ctx.config.vault.maxBytes) });
  const globalJson = json({ limit: GLOBAL_JSON_BODY_LIMIT });
  const restoreBodyParser: RequestHandler = (req, res, next) => {
    const parser = req.authUser?.privacyMode === 'paranoid' ? restoreJson : globalJson;
    parser(req, res, (error?: unknown) => {
      // Answer an over-bound body truthfully instead of letting body-parser's
      // error surface as an opaque 500 — the same translation `/vault`'s raw
      // parser makes. Disable is the only exit from paranoid mode, so a caller
      // that hits a bound has to be able to tell that from a server fault.
      if ((error as { type?: string } | undefined)?.type === 'entity.too.large') {
        next(
          new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The rehydration document exceeds the size cap.'),
        );
        return;
      }
      next(error);
    });
  };

  // Two shapes on one route. The restoring disable hands the decrypted rows
  // back, so `confirm` + the document is its whole gate. `discard: true`
  // destroys a vault nobody can decrypt any more, so the service re-runs the
  // account-deletion rung server-side (typed username + password/TOTP/recovery
  // behind a per-account progressive throttle) — the client-side confirmation
  // in the locked gate's fold is a UX affordance, never the gate. The route
  // keeps the per-account vault schedule; the credential counter is the
  // service's own, so a wrong password here can never buy attempts anywhere
  // else (and the restoring disable's budget is unchanged).
  router.post(
    '/paranoid/disable',
    requireUser,
    requireOwnerBrowserSession,
    limiters.vault,
    restoreBodyParser,
    validateBody(paranoidDisableRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as ParanoidDisableRequest;
      res.json(
        await runTransition(() =>
          ctx.paranoidTransitions.disable(req.authUser!.id, body, { ip: req.ip }),
        ),
      );
    },
  );

  // Request an export: re-auth (password / 2FA) + 1/day gate → async build. The
  // raw download token is returned ONCE (only its hash is persisted).
  router.post(
    '/export',
    requireUser,
    limiters.login,
    validateBody(exportRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as ExportRequest;
      const result = await ctx.dataExport.requestExport({
        userId: req.authUser!.id,
        body,
        ip: req.ip,
      });
      res.json(result);
    },
  );

  // Poll the caller's latest export job (no secret in the response).
  router.get('/export', requireUser, async (req, res) => {
    res.json(await ctx.dataExport.getStatus(req.authUser!.id));
  });

  // Stream the ready zip. Session-authenticated AND token-gated: the token was
  // minted behind the request-time re-auth and is short-lived, so it is the
  // download's fresh-re-auth proof; a foreign/expired token 404s (fails closed).
  router.post(
    '/export/download',
    requireUser,
    validateBody(exportDownloadRequestSchema),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const { token } = req.valid?.body as ExportDownloadRequest;
      try {
        await ctx.dataExport.withDownload(
          { userId: req.authUser!.id, token },
          (file, signal) =>
            new Promise<void>((resolve, reject) => {
              let settled = false;
              const finish = (error?: Error): void => {
                if (settled) return;
                settled = true;
                res.setTimeout(0);
                signal.removeEventListener('abort', onDeadline);
                if (error) reject(error);
                else resolve();
              };
              // The absolute bound (EXPORT_DOWNLOAD_MAX_MS) fires on the service
              // side, which releases the lock regardless; cutting the socket here
              // is what stops a drip-feeding reader from also holding a worker
              // slot and an open file handle past that point.
              function onDeadline(): void {
                const expired = new Error('The export download exceeded its time limit.');
                res.destroy(expired);
                finish(expired);
              }
              signal.addEventListener('abort', onDeadline, { once: true });
              // The watchdog settles the promise itself rather than relying on
              // the stream to call back after the socket dies: holding the
              // account lock forever would be far worse than a spurious error.
              res.setTimeout(EXPORT_DOWNLOAD_STALL_TIMEOUT_MS, () => {
                const stalled = new Error('The export download stalled.');
                res.destroy(stalled);
                finish(stalled);
              });
              res.download(file.filePath, file.fileName, finish);
            }),
        );
      } catch (error) {
        // Token resolution fails before anything is written, so it still becomes
        // the usual 404. Once the archive is on the wire the response is
        // committed: an abort or a cut stall can only be logged.
        if (!res.headersSent) throw error;
        ctx.logger.warn(
          { err: error instanceof Error ? error.message : 'unknown' },
          'export download did not complete',
        );
      }
    },
  );

  return router;
}
