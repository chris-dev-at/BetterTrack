import { VAULT2_NAME_MAX_LENGTH } from '@bettertrack/contracts';
import { useState } from 'react';

import { useT } from '../../../../i18n';
import { Button, Field, Input, ODialog } from '../../../../ui/origin';
import { CHECKBOX_STYLE } from '../../../components/ui';
import { useAuth } from '../../../AuthContext';
import { setPortfolioAlias } from '../api';
import { captureNormalVault } from '../../ui/migration';
import type { VaultKeyring } from '../keyring';
import { movePortfolioIntoVault, type JoinStage } from '../join';
import type { VaultKnowledge } from '../sectionState';

/**
 * "Move into vault" (`docs/VAULTS_V2_DESIGN.md` §4).
 *
 * The copy leads with irreversibility because the server purge happens inside
 * the join transaction. The flow refuses to start unless the target vault is
 * unlocked — a join needs the content key, and asking for it after the purge
 * would be far too late.
 */

const STAGE_PROGRESS: Record<JoinStage, number> = {
  capture: 20,
  encrypt: 45,
  verify: 65,
  join: 85,
  index: 95,
  done: 100,
};

export interface MoveIntoVaultDialogProps {
  open: boolean;
  onClose: () => void;
  portfolioId: string;
  portfolioName: string;
  knowledge: VaultKnowledge | null;
  keyring: VaultKeyring;
  onMoved: () => void;
}

export function MoveIntoVaultDialog({
  open,
  onClose,
  portfolioId,
  portfolioName,
  knowledge,
  keyring,
  onMoved,
}: MoveIntoVaultDialogProps) {
  const t = useT();
  const { user } = useAuth();
  const [alias, setAlias] = useState(portfolioName);
  const [understood, setUnderstood] = useState(false);
  const [stage, setStage] = useState<JoinStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unlocked = knowledge != null && knowledge.unlocked && knowledge.header != null;
  const busy = stage != null && stage !== 'done';

  async function move() {
    if (knowledge?.header == null || user == null) return;
    setError(null);
    try {
      const chosenAlias = alias.trim() || portfolioName;
      const capture = await captureNormalVault({ userId: user.id });
      await keyring.withContentKey(knowledge.summary.id, async (contentKey) => {
        await movePortfolioIntoVault({
          portfolioId,
          vaultId: knowledge.summary.id,
          header: knowledge.header!,
          headerVersion: knowledge.header!.headerVersion,
          contentKey,
          alias: chosenAlias,
          capture: capture.document,
          onStage: setStage,
        });
      });
      // The alias also lives server-side (PATCH /portfolios/{id}/alias) so a
      // locked row still has a label before the header doc has been fetched.
      // The move already succeeded, so a failure here must not undo it.
      await setPortfolioAlias(portfolioId, chosenAlias).catch(() => undefined);
      onMoved();
      onClose();
    } catch {
      setStage(null);
      setError(t('vault.v2.move.errors.failed'));
    }
  }

  return (
    <ODialog
      foot={
        <div className="flex w-full items-center justify-between gap-3">
          <Button disabled={busy} onClick={onClose} variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!unlocked || !understood || busy}
            loading={busy}
            onClick={() => void move()}
            variant="primary"
          >
            {t('vault.v2.move.actions.move')}
          </Button>
        </div>
      }
      onClose={busy ? () => undefined : onClose}
      open={open}
      title={t('vault.v2.move.title', { name: knowledge?.summary.name ?? '' })}
    >
      <div className="flex flex-col gap-4">
        <p className="bt-soft text-sm">{t('vault.v2.move.body', { portfolio: portfolioName })}</p>

        <ul className="bt-band">
          {(['irreversible', 'serverBlind', 'featuresOff', 'lostWords'] as const).map((point) => (
            <li className="bt-band__row bt-row-sub" key={point}>
              {t(`vault.v2.move.points.${point}`)}
            </li>
          ))}
        </ul>

        <Field
          hint={t('vault.v2.move.aliasHint')}
          htmlFor="vault-move-alias"
          label={t('vault.v2.move.alias')}
        >
          <Input
            id="vault-move-alias"
            maxLength={VAULT2_NAME_MAX_LENGTH}
            onChange={(event) => setAlias(event.target.value)}
            value={alias}
          />
        </Field>

        {!unlocked ? (
          <p className="bt-field__error" role="note">
            {t('vault.v2.move.mustUnlock')}
          </p>
        ) : null}

        <label className="bt-settings-row items-start gap-3">
          <input
            checked={understood}
            onChange={(event) => setUnderstood(event.target.checked)}
            style={CHECKBOX_STYLE}
            type="checkbox"
          />
          <span className="bt-row-sub">{t('vault.v2.move.understood')}</span>
        </label>

        {stage != null ? (
          <div aria-live="polite" role="status">
            <p className="bt-meta">{t(`vault.v2.move.stages.${stage}`)}</p>
            <progress max={100} value={STAGE_PROGRESS[stage]} />
          </div>
        ) : null}

        {error ? (
          <p className="bt-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ODialog>
  );
}
