import { Link } from 'react-router-dom';

import type { EndpointVaultState } from '../keystore';

import { useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import { vaultStateAffordance, vaultStateActionHref } from '../vaultStateAffordance';

export function VaultStateAction({
  state,
  vaultId,
  onAction,
}: {
  state: EndpointVaultState;
  vaultId: string;
  onAction?: () => void;
}) {
  const t = useT();
  const affordance = vaultStateAffordance(state);

  if (!onAction && affordance.action === 'provide-phrase') {
    return (
      <span className="flex flex-wrap gap-3">
        <Link className="bt-link text-sm" to={vaultStateActionHref(vaultId, 'provide-phrase')}>
          {t(affordance.labelKey)}
        </Link>
        <Link className="bt-link text-sm" to={vaultStateActionHref(vaultId, 'scan-qr')}>
          {t('vault.manager.action.scanQr')}
        </Link>
      </span>
    );
  }

  return onAction ? (
    <Button onClick={onAction} size="sm" type="button" variant="quiet">
      {t(affordance.labelKey)}
    </Button>
  ) : (
    <Link className="bt-link text-sm" to={vaultStateActionHref(vaultId, affordance.action)}>
      {t(affordance.labelKey)}
    </Link>
  );
}
