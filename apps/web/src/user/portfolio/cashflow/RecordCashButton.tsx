import { useState } from 'react';

import { useT } from '../../../i18n';
import { Icon } from '../../../ui/origin';
import { RecordCashDialog } from './RecordCashDialog';

/**
 * Record money, as a JOINED PAIR (owner, 2026-07-31, second pass).
 *
 * The first attempt put a `+` and a `−` on either side of a text button, which
 * was three controls pretending to be one and read as glyphs bolted onto a
 * label. This is the control the owner actually described: two halves of one
 * object, nothing else.
 *
 * ── PLUS LEFT, MINUS RIGHT ──
 *
 * Owner's call, and it matches the reading order people already carry from a
 * calculator and a number line: add on the left, take away on the right.
 *
 * ── THE TINT IS PERMANENT, NOT A HOVER REWARD ──
 *
 * A bare `+` says nothing about money. Both halves carry their direction's
 * colour at rest, so the meaning is legible before you touch anything; hover
 * only deepens what is already there. That is also why they are icons at a
 * real size rather than text characters — a typographic `+` inherits the
 * font's weight and sits off-centre, which is what made the first version look
 * slapped together.
 */
export interface RecordCashButtonProps {
  portfolioId: string;
}

export function RecordCashButton({ portfolioId }: RecordCashButtonProps) {
  const t = useT();
  const [open, setOpen] = useState<null | { direction: 'in' | 'out' }>(null);

  return (
    <>
      <span className="bt-recordpair" role="group" aria-label={t('cashflow.record.action')}>
        <button
          aria-label={t('cashflow.record.quickIn')}
          className="bt-recordpair__half bt-recordpair__half--in"
          onClick={() => setOpen({ direction: 'in' })}
          title={t('cashflow.record.quickIn')}
          type="button"
        >
          <Icon name="plus" />
        </button>
        <button
          aria-label={t('cashflow.record.quickOut')}
          className="bt-recordpair__half bt-recordpair__half--out"
          onClick={() => setOpen({ direction: 'out' })}
          title={t('cashflow.record.quickOut')}
          type="button"
        >
          <Icon name="minus" />
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
