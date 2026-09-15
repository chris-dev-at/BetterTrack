import { useState } from 'react';

import type { EndpointVaultState } from '../keystore';

import { useT } from '../../../i18n';
import { Button, LinkButton } from '../../../ui/origin';
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
  emphasis = 'quiet',
  onUnlocked,
}: {
  state: EndpointVaultState;
  vaultId: string;
  /** Cleartext vault alias, when the caller has it, for the dialog title. */
  vaultName?: string | undefined;
  onAction?: () => void;
  /** Prompt for the device password here instead of linking into settings. */
  inPlace?: boolean;
  /**
   * `'primary'` where this IS the row's headline act — the vault manager, where
   * everything else on the row is maintenance. Purely visual: the affordance,
   * the target and the element type are identical either way, so a row can have
   * exactly one primary without any surface changing what it does.
   */
  emphasis?: 'quiet' | 'primary';
  onUnlocked?: (() => void) | undefined;
}) {
  const t = useT();
  const affordance = vaultStateAffordance(state);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const variant = emphasis === 'primary' ? 'primary' : 'quiet';

  if (!onAction && affordance.action === 'provide-phrase') {
    return (
      <span className="flex flex-wrap gap-2">
        <LinkButton
          size="sm"
          to={vaultStateActionHref(vaultId, 'provide-phrase')}
          variant={variant}
        >
          {t(affordance.labelKey)}
        </LinkButton>
        <LinkButton size="sm" to={vaultStateActionHref(vaultId, 'scan-qr')} variant="quiet">
          {t('vault.manager.action.scanQr')}
        </LinkButton>
      </span>
    );
  }

  if (onAction) {
    return (
      <Button onClick={onAction} size="sm" type="button" variant={variant}>
        {t(affordance.labelKey)}
      </Button>
    );
  }

  if (inPlace && affordance.action === 'unlock') {
    return (
      <>
        <Button onClick={() => setUnlockOpen(true)} size="sm" type="button" variant={variant}>
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

  // The settings-sized flows keep their deep link, because they ARE navigation:
  // a `<button onClick={navigate}>` would cost middle-click, open-in-new-tab
  // and the `link` role these targets are asserted by. What changes is that it
  // stops being bare underlined text and wears the quiet button skin the rest
  // of the app gives a secondary action.
  return (
    <LinkButton size="sm" to={vaultStateActionHref(vaultId, affordance.action)} variant={variant}>
      {t(affordance.labelKey)}
    </LinkButton>
  );
}
