import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { EndpointVaultState } from '../keystore';

import { useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import { vaultStateAffordance, vaultStateActionHref } from '../vaultStateAffordance';
import { VaultUnlockDialog } from './VaultUnlockDialog';

/**
 * The state action every vault surface renders — and, with `inPlace`, the one
 * the owner actually asked for.
 *
 * `inPlace` upgrades exactly ONE affordance: `unlock`, which becomes a button
 * opening {@link VaultUnlockDialog} where the user already stands. It is
 * deliberately not "in-place everything":
 *
 *   • `provide-phrase` / `scan-qr` need twelve words or a camera — settings-sized
 *     flows with their own surfaces;
 *   • `reset-endpoint` destroys the stored words for EVERY vault on this device,
 *     which belongs behind the settings surface's acknowledgment, not one click
 *     from a portfolio page;
 *   • `open` needs the vault's header envelope, which only the manager holds.
 *
 * Everything else keeps the settings deep link it had, so this change can only
 * shorten a journey, never invent one.
 */
export function VaultStateAction({
  state,
  vaultId,
  vaultName,
  onAction,
  inPlace = false,
  onUnlocked,
}: {
  state: EndpointVaultState;
  vaultId: string;
  /** Cleartext vault alias, when the caller has it, for the dialog title. */
  vaultName?: string | undefined;
  onAction?: () => void;
  /** Prompt for the device password here instead of linking into settings. */
  inPlace?: boolean;
  onUnlocked?: (() => void) | undefined;
}) {
  const t = useT();
  const affordance = vaultStateAffordance(state);
  const [unlockOpen, setUnlockOpen] = useState(false);

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

  if (onAction) {
    return (
      <Button onClick={onAction} size="sm" type="button" variant="quiet">
        {t(affordance.labelKey)}
      </Button>
    );
  }

  if (inPlace && affordance.action === 'unlock') {
    return (
      <>
        <Button onClick={() => setUnlockOpen(true)} size="sm" type="button" variant="quiet">
          {t(affordance.labelKey)}
        </Button>
        {/* Mounted only while open. The dialog is the one piece of this
            component that needs a query client and a router, and
            `VaultStateAction` renders on surfaces (the shield chip) that hold
            neither until something actually asks to unlock. It also means the
            typed device password lives exactly as long as the dialog does. */}
        {unlockOpen ? (
          <VaultUnlockDialog
            onClose={() => setUnlockOpen(false)}
            onUnlocked={onUnlocked}
            vaultId={vaultId}
            vaultName={vaultName}
          />
        ) : null}
      </>
    );
  }

  return (
    <Link className="bt-link text-sm" to={vaultStateActionHref(vaultId, affordance.action)}>
      {t(affordance.labelKey)}
    </Link>
  );
}
