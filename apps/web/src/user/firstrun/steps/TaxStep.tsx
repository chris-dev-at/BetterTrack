import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { TaxSettingsResponse, UpdateTaxSettingsRequest } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getTaxSettings, updateTaxSettings } from '../../../lib/settingsApi';
import { TaxModePicker } from '../../settings/taxModePicker';
import { Alert } from '../../components/ui';
import type { FirstRunStepProps } from '../types';

const TAX_SETTINGS_KEY = ['settings', 'taxes'] as const;

/**
 * Step 5 — tax handling. The real {@link TaxModePicker} against the real
 * `GET`/`PATCH /settings/taxes`, wired exactly as Settings → New-portfolio
 * defaults wires it, so whatever is chosen here is the same account-level
 * default the rest of the app reads.
 *
 * Only a save made during this run counts as complete: the stored default has a
 * value from the moment the account exists, so "it is set" cannot by itself
 * distinguish a choice from an untouched default.
 */
export function TaxStep({ report }: FirstRunStepProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState(false);

  const settings = useQuery({
    queryKey: TAX_SETTINGS_KEY,
    queryFn: ({ signal }) => getTaxSettings(signal),
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: (body: UpdateTaxSettingsRequest) => updateTaxSettings(body),
    onSuccess: (res: TaxSettingsResponse) => {
      queryClient.setQueryData(TAX_SETTINGS_KEY, res);
      void queryClient.invalidateQueries({ queryKey: ['portfolio', 'taxSettings'] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio', 'taxYears'] });
      setChosen(true);
    },
  });

  const busy = save.isPending;
  useEffect(() => {
    report({ status: chosen ? 'complete' : 'skipped', busy });
  }, [report, chosen, busy]);

  return (
    <div className="flex flex-col gap-4">
      {save.isError ? <Alert tone="error">{t('common.genericError')}</Alert> : null}
      <TaxModePicker
        value={settings.data}
        name="firstrun-tax"
        busy={busy}
        ariaLabel={t('firstrun.tax.groupAria')}
        onSelect={(body) => save.mutate(body)}
      />
    </div>
  );
}
