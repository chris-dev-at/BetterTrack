import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { BASE_CURRENCIES, type BaseCurrency } from '@bettertrack/contracts';

import { SUPPORTED_LOCALES, useI18n, useT } from '../../../i18n';
import { setMoneyCurrency } from '../../../lib/format';
import { getAccountSettings, updateAccountSettings } from '../../../lib/settingsApi';
import { Seg } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import type { FirstRunStepProps } from '../types';

const ACCOUNT_SETTINGS_KEY = ['settings', 'account'] as const;

/**
 * Step 4 — language and money. Both write through the real
 * `PATCH /settings/account`, exactly as Settings → Account does; the language
 * additionally flips the i18n runtime first so the switch is instant rather than
 * waiting on the round-trip.
 *
 * Saving on change (rather than on Continue) is what keeps the frame's Continue
 * a pure "next" — the step never has unsaved state to lose.
 */
export function PreferencesStep({ report }: FirstRunStepProps) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: ACCOUNT_SETTINGS_KEY,
    queryFn: ({ signal }) => getAccountSettings(signal),
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: updateAccountSettings,
    onSuccess: (res) => {
      queryClient.setQueryData(ACCOUNT_SETTINGS_KEY, res);
      setMoneyCurrency(res.baseCurrency);
      // Every money figure in the app is now denominated differently — refetch
      // the lot rather than enumerating the affected queries (mirrors Settings).
      void queryClient.invalidateQueries();
    },
  });

  // A language and a currency are always in effect — there is no unset state to
  // skip — so seeing and accepting them is what completes this step. Only a
  // failed load leaves it unresolved.
  const loaded = settings.isSuccess;
  const busy = save.isPending;
  useEffect(() => {
    report({ status: loaded ? 'complete' : 'skipped', busy });
  }, [report, loaded, busy]);

  const baseCurrency = settings.data?.baseCurrency;

  return (
    <div>
      <div className="bt-fr__row">
        <div className="bt-fr__rowlabel">{t('firstrun.preferences.languageLabel')}</div>
        <Seg
          ariaLabel={t('firstrun.preferences.languageLabel')}
          value={locale}
          options={SUPPORTED_LOCALES.map((definition) => ({
            value: definition.code,
            label: definition.label,
          }))}
          onChange={(next) => {
            setLocale(next);
            save.mutate({ locale: next });
          }}
        />
      </div>
      <div className="bt-fr__row">
        <div>
          <div className="bt-fr__rowlabel">{t('firstrun.preferences.currencyLabel')}</div>
          <p className="bt-fr__rowsub">{t('firstrun.preferences.currencyHint')}</p>
        </div>
        <Seg
          ariaLabel={t('firstrun.preferences.currencyLabel')}
          value={baseCurrency ?? ''}
          options={BASE_CURRENCIES.map((code) => ({ value: code as string, label: code }))}
          onChange={(next) => save.mutate({ baseCurrency: next as BaseCurrency })}
        />
      </div>
      {save.isError ? (
        <div className="mt-4">
          <Alert tone="error">{t('common.genericError')}</Alert>
        </div>
      ) : null}
    </div>
  );
}
