import { useState } from 'react';

import { useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import type { RestoreCandidate } from '../restore';

export function VaultRestorePicker({
  candidates,
  onRestore,
}: {
  candidates: readonly RestoreCandidate[];
  onRestore(candidate: RestoreCandidate): Promise<void>;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <p className="bt-row-sub">{t('vault.restorePicker.hint')}</p>
      {candidates.length === 0 ? (
        <p className="bt-meta">{t('vault.restorePicker.empty')}</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {candidates.map((candidate) => (
            <li className="bt-panel p-3" key={candidate.id}>
              <label className="flex items-start gap-3">
                <input
                  checked={selected === candidate.id}
                  disabled={candidate.status !== 'available'}
                  onChange={() => setSelected(candidate.id)}
                  type="radio"
                />
                <span>
                  <span className="bt-row-title">{t(restoreSourceKey(candidate.source))}</span>
                  <span className="bt-row-sub block">
                    {t(`vault.restorePicker.status.${candidate.status}`)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {failed ? (
        <p className="bt-neg text-sm" role="alert">
          {t('vault.restorePicker.error')}
        </p>
      ) : null}
      <Button
        disabled={selected == null || working}
        onClick={() => {
          const candidate = candidates.find((entry) => entry.id === selected);
          if (!candidate || candidate.status !== 'available') return;
          setWorking(true);
          setFailed(false);
          void onRestore(candidate)
            .catch(() => setFailed(true))
            .finally(() => setWorking(false));
        }}
        size="sm"
        type="button"
      >
        {working ? t('vault.restorePicker.restoring') : t('vault.restorePicker.action')}
      </Button>
    </div>
  );
}

function restoreSourceKey(source: string): string {
  return source === 'server-history' ||
    source === 'current-server' ||
    source === 'quarantined-local'
    ? `vault.restorePicker.source.${source}`
    : 'vault.restorePicker.source.unknown';
}
