import { useState } from 'react';

import { useT } from '../../../i18n';
import { Badge, Button, Choice, ChoiceGroup, Empty, type BadgeTone } from '../../../ui/origin';
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
        <Empty icon="clock" title={t('vault.restorePicker.empty')} />
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <ChoiceGroup label={t('vault.restorePicker.hint')}>
            {candidates.map((candidate) => (
              <Choice
                // A copy that cannot be restored keeps its row and says why on
                // a badge, instead of a muted sub-line under an inert radio.
                badge={
                  <Badge tone={restoreStatusTone(candidate.status)}>
                    {t(`vault.restorePicker.status.${candidate.status}`)}
                  </Badge>
                }
                disabled={candidate.status !== 'available'}
                key={candidate.id}
                muted={candidate.status !== 'available'}
                name="vault-restore-candidate"
                onSelect={() => setSelected(candidate.id)}
                selected={selected === candidate.id}
                title={t(restoreSourceKey(candidate.source))}
              />
            ))}
          </ChoiceGroup>
        </div>
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

function restoreStatusTone(status: RestoreCandidate['status']): BadgeTone {
  if (status === 'available') return 'pos';
  return status === 'corrupt' ? 'neg' : 'neutral';
}

function restoreSourceKey(source: string): string {
  return source === 'server-history' ||
    source === 'current-server' ||
    source === 'quarantined-local'
    ? `vault.restorePicker.source.${source}`
    : 'vault.restorePicker.source.unknown';
}
