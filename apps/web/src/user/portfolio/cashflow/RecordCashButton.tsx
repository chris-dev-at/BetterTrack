import { useState } from 'react';

import { useT } from '../../../i18n';
import { RecordCashDialog } from './RecordCashDialog';

/**
 * The Cash area's primary action, as a SPLIT button (owner, 2026-07-31).
 *
 * The middle press opens the dialog on its default direction; the − and + ends
 * open it already pointed at money out or money in. That is one press saved on
 * the two things people do constantly, without hiding the neutral entry point
 * for everything else.
 *
 * The ends carry `aria-label`s naming the direction rather than the glyph,
 * because "minus" is not what the control does — "record money out" is.
 */
export interface RecordCashButtonProps {
  portfolioId: string;
}

export function RecordCashButton({ portfolioId }: RecordCashButtonProps) {
  const t = useT();
  const [open, setOpen] = useState<null | { direction?: 'in' | 'out' }>(null);

  return (
    <>
      <span className="bt-splitbtn">
        <button
          aria-label={t('cashflow.record.quickOut')}
          className="bt-splitbtn__end bt-splitbtn__end--neg"
          onClick={() => setOpen({ direction: 'out' })}
          title={t('cashflow.record.quickOut')}
          type="button"
        >
          −
        </button>
        <button className="bt-splitbtn__main" onClick={() => setOpen({})} type="button">
          {t('cashflow.record.action')}
        </button>
        <button
          aria-label={t('cashflow.record.quickIn')}
          className="bt-splitbtn__end bt-splitbtn__end--pos"
          onClick={() => setOpen({ direction: 'in' })}
          title={t('cashflow.record.quickIn')}
          type="button"
        >
          +
        </button>
      </span>

      {open ? (
        <RecordCashDialog
          direction={open.direction}
          onClose={() => setOpen(null)}
          portfolioId={portfolioId}
        />
      ) : null}
    </>
  );
}
