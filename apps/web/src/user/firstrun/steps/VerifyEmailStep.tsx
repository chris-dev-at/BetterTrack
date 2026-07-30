import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useT } from '../../../i18n';
import { getGoogleLinkStatus } from '../../../lib/userApi';
import { Badge } from '../../../ui/origin';
import { PinInput } from '../../components/PinInput';
import type { FirstRunStepProps } from '../types';

/** Digits in the (not-yet-delivered) email verification code. */
const CODE_LENGTH = 6;

const GOOGLE_LINK_KEY = ['auth', 'google', 'linkStatus'] as const;

/**
 * Step 2 — email verification. Two honest states, no invented backend:
 *
 *  - **Verified.** Only a Google identity arrives already verified (the API sets
 *    `emailVerified` from the ID token — see `googleAuthService`), so the real
 *    `GET /auth/google/link-status` is what decides this. A linked account sees
 *    a confirmation and the step counts as complete.
 *  - **Parked.** A password account has nothing to verify against: there is no
 *    verification-email delivery and no `POST /auth/email/verify` endpoint. The
 *    code entry is therefore rendered fully designed but disabled, flagged with
 *    the parked badge, and the step records itself as skipped.
 *
 * The step contract is already the one a real endpoint needs: when delivery
 * lands, enable the input, send the code on completion, and report `complete` on
 * a 2xx. Nothing in the frame or the registry moves.
 */
export function VerifyEmailStep({ report }: FirstRunStepProps) {
  const t = useT();

  // Best-effort: a deployment without Google configured 404s here, which reads
  // exactly like "not linked". Only a 401 ever triggers a session bounce, so an
  // error on this query is safe to swallow.
  const link = useQuery({
    queryKey: GOOGLE_LINK_KEY,
    queryFn: ({ signal }) => getGoogleLinkStatus(signal),
    staleTime: 30_000,
    retry: false,
  });
  const verified = link.data?.linked === true;

  useEffect(() => {
    report({ status: verified ? 'complete' : 'skipped' });
  }, [report, verified]);

  // The figure above already shows the address and its state, so the words here
  // are only what a screen reader needs — the figure is aria-hidden.
  if (verified) {
    return <p className="bt-soft text-sm">{t('firstrun.verifyEmail.verified')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <Badge outline>{t('firstrun.parkedFlag')}</Badge>
        <span className="bt-muted text-xs">{t('firstrun.verifyEmail.parkedNote')}</span>
      </div>
      <PinInput
        label={t('firstrun.verifyEmail.codeLabel')}
        length={CODE_LENGTH}
        value=""
        onChange={() => {
          // Parked: there is no code to accept until delivery ships.
        }}
        disabled
      />
    </div>
  );
}
