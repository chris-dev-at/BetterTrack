import { useState } from 'react';

import { useT } from '../../../../i18n';
import { Button, ODialog } from '../../../../ui/origin';
import { CHECKBOX_STYLE } from '../../../components/ui';
import { clearRestoreId, restoreIdFor } from '../restoreId';

/**
 * "Move out" — the reverse of a join (`docs/VAULTS_V2_DESIGN.md` §3 leave).
 *
 * The client posts the decrypted rows back and the server repopulates them,
 * clears `vault_id` and retires the blob in one transaction. The
 * **`restoreId`** is the whole reliability story: it is minted before the
 * request, persisted (so it survives a reload or a crash), replayed verbatim on
 * every retry, and cleared only once the server acknowledges. The server keeps
 * it in `vault_leave_receipts` and answers the original receipt rather than
 * restoring twice.
 *
 * The dialog states plainly that the portfolio becomes readable server-side
 * again — that is the point of the operation, but it is also a privacy change
 * the user should choose deliberately rather than discover afterwards.
 */

export interface MoveOutOfVaultDialogProps {
  open: boolean;
  onClose: () => void;
  portfolioId: string;
  portfolioName: string;
  onMoved: () => void;
  /**
   * Performs the decrypt + leave. Injected so the dialog owns the ceremony and
   * the idempotency key while the vault plumbing stays testable on its own.
   */
  leave?: (input: { portfolioId: string; restoreId: string }) => Promise<void>;
}

export function MoveOutOfVaultDialog({
  open,
  onClose,
  portfolioId,
  portfolioName,
  onMoved,
  leave,
}: MoveOutOfVaultDialogProps) {
  const t = useT();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (leave == null) return;
    setBusy(true);
    setError(null);
    // Minted once and reused: a retry after a failure MUST carry the same id,
    // or the server has no way to recognize it as the same leave.
    const restoreId = restoreIdFor(portfolioId);
    try {
      await leave({ portfolioId, restoreId });
      clearRestoreId(portfolioId);
      onMoved();
      onClose();
    } catch {
      // The id deliberately survives the failure so the retry is recognized.
      setError(t('vault.v2.moveOut.errors.failed'));
    } finally {
      setBusy(false);
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
            disabled={!understood || busy || leave == null}
            loading={busy}
            onClick={() => void run()}
            variant="danger"
          >
            {t('vault.v2.moveOut.actions.move')}
          </Button>
        </div>
      }
      onClose={busy ? () => undefined : onClose}
      open={open}
      title={t('vault.v2.moveOut.title', { portfolio: portfolioName })}
    >
      <div className="flex flex-col gap-4">
        <p className="bt-soft text-sm">{t('vault.v2.moveOut.body')}</p>

        <ul className="bt-band">
          {(['readable', 'featuresBack', 'retry'] as const).map((point) => (
            <li className="bt-band__row bt-row-sub" key={point}>
              {t(`vault.v2.moveOut.points.${point}`)}
            </li>
          ))}
        </ul>

        <label className="bt-settings-row items-start gap-3">
          <input
            checked={understood}
            onChange={(event) => setUnderstood(event.target.checked)}
            style={CHECKBOX_STYLE}
            type="checkbox"
          />
          <span className="bt-row-sub">{t('vault.v2.moveOut.understood')}</span>
        </label>

        {leave == null ? (
          <p className="bt-field__error" role="note">
            {t('vault.v2.moveOut.unavailable')}
          </p>
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
