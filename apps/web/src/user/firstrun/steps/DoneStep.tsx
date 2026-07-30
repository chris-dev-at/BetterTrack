import { useEffect, useState } from 'react';

import { useT } from '../../../i18n';
import { Icon } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { readFirstRun } from '../firstRunStorage';
import { FIRST_RUN_STEP_META } from '../stepMeta';
import type { FirstRunStepProps } from '../types';

/**
 * Step 7 — what you just set, and what is still waiting.
 *
 * Read once on mount from the persisted run rather than from live state: by the
 * time this renders every earlier step has been recorded, and a snapshot keeps
 * the list from shifting under the user.
 */
export function DoneStep({ report }: FirstRunStepProps) {
  const t = useT();
  const { user } = useAuth();
  const [summary] = useState(() => readFirstRun(user?.id).steps);

  useEffect(() => {
    report({ status: 'complete' });
  }, [report]);

  return (
    <ul>
      {FIRST_RUN_STEP_META.filter((meta) => !meta.terminal).map((meta) => {
        const complete = summary[meta.id] === 'complete';
        return (
          <li key={meta.id} className="bt-fr__row">
            <span className="bt-fr__rowlabel">{t(meta.labelKey)}</span>
            <span
              className="flex items-center gap-1.5 text-xs"
              style={{ color: complete ? 'var(--bt-pos)' : 'var(--bt-muted)' }}
            >
              <Icon name={complete ? 'check' : 'clock'} size={14} />
              {complete ? t('firstrun.done.set') : t('firstrun.done.later')}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
