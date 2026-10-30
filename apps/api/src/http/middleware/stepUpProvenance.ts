import type { RequestHandler } from 'express';

import { unauthorized } from '../../errors';
import { stepUpCredentialKey } from '../../services/auth/factorProvenance';
import type { ReauthService } from '../../services/auth/reauthService';

/** The credential members an in-body step-up may carry (validated upstream). */
export interface StepUpCredentialFields {
  password?: unknown;
  code?: unknown;
  recoveryCode?: unknown;
}

/** `{ password | code | recoveryCode }` at the top level of the body (account / passkey routes). */
export const topLevelStepUp = (body: unknown): StepUpCredentialFields | undefined =>
  body && typeof body === 'object' ? (body as StepUpCredentialFields) : undefined;

/** The nested `stepUp` member (2FA management, vault and portfolio-vault routes). */
export const nestedStepUp = (body: unknown): StepUpCredentialFields | undefined => {
  const stepUp = (body as { stepUp?: unknown } | undefined)?.stepUp;
  return stepUp && typeof stepUp === 'object' ? (stepUp as StepUpCredentialFields) : undefined;
};

/**
 * R-05 rule 2 on every route whose step-up accepts a TOTP or recovery code:
 * a credential that issued second-factor material inside the hold window must
 * present the password (`401 STEP_UP_PASSWORD_REQUIRED`). Mount it AFTER
 * `validateBody`, so it reads the parsed credential. A password in the body
 * skips it — the services verify the password first whenever one is sent.
 *
 * Cookie sessions can never trip it today (every factor mint destroys every
 * session), so on cookie-only routes it is a guard against a future change to
 * that, not a behaviour change.
 */
export function refuseSelfIssuedStepUpFactor(
  ctx: { reauth: Pick<ReauthService, 'refuseSelfIssuedFactor'> },
  purpose: string,
  pick: (body: unknown) => StepUpCredentialFields | undefined,
): RequestHandler {
  return async (req, _res, next) => {
    try {
      const credential = pick(req.valid?.body);
      const factorOnly =
        credential !== undefined &&
        credential.password === undefined &&
        (credential.code !== undefined || credential.recoveryCode !== undefined);
      if (factorOnly) {
        // Every mount sits behind an authenticated-user gate; fail closed anyway.
        if (!req.authUser) throw unauthorized();
        await ctx.reauth.refuseSelfIssuedFactor({
          userId: req.authUser.id,
          credentialKey: stepUpCredentialKey({ sessionId: req.sessionId, apiKey: req.apiKey }),
          purpose,
          ip: req.ip,
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
