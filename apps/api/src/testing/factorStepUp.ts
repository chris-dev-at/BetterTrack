import type { FactorStepUpAuthorization } from '../services/auth/twoFactorService';

/**
 * The R-05 step-up a user route hands the 2FA service, for tests that arm a
 * factor directly through the service as a FIXTURE. It names a synthetic cookie
 * credential, so the issuance record it leaves can never match a test's real
 * session or bearer and change what a later step-up route answers.
 */
export const passwordStepUp = (password: string): FactorStepUpAuthorization => ({
  kind: 'step-up',
  stepUp: { password },
  credentialKey: 'session:test-fixture',
});
