import { useEffect } from 'react';

import { useT } from '../../../i18n';
import { useAuth } from '../../AuthContext';
import { TextField } from '../../components/ui';
import type { FirstRunStepProps } from '../types';

/**
 * Step 1 — who you are. Registration already collected both values and there is
 * no rename endpoint today (nothing in `PATCH /settings/account` or
 * `PUT /social/profile` carries a name), so this is a confirmation rather than a
 * form: both fields render disabled with the values the account was created
 * with. When a rename endpoint lands, this step becomes editable in place — the
 * frame contract does not change.
 */
export function ProfileStep({ report }: FirstRunStepProps) {
  const t = useT();
  const { user } = useAuth();

  // Nothing to save and nothing to skip: seeing your identity is the step.
  useEffect(() => {
    report({ status: 'complete' });
  }, [report]);

  return (
    <div className="flex flex-col gap-4">
      <TextField
        label={t('firstrun.profile.nameLabel')}
        name="displayName"
        value={user?.username ?? ''}
        readOnly
        disabled
        hint={t('firstrun.profile.nameParked')}
      />
      <TextField
        label={t('firstrun.profile.emailLabel')}
        name="email"
        type="email"
        value={user?.email ?? ''}
        readOnly
        disabled
      />
    </div>
  );
}
