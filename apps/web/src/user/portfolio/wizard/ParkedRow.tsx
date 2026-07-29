import { Icon } from '../../../ui/origin';
import { useT } from '../../../i18n';

/**
 * One parked capability inside a wizard step: named, flagged, and deliberately
 * NOT a control. The wizard only ships switches the API can honour today
 * (§6.8 — a portfolio has a name, and locally an icon); base currency per
 * portfolio, opening balances, broker imports and templates are real plans with
 * no endpoint yet, so they are stated in the `bt-parked` language instead of
 * being faked as a toggle that silently does nothing.
 */
export function ParkedRow({ label }: { label: string }) {
  const t = useT();
  return (
    <p className="bt-pfw__parked">
      <Icon name="clock" size={13} />
      <span>{label}</span>
      <span className="bt-pfw__parked-flag">{t('common.comingSoon')}</span>
    </p>
  );
}
