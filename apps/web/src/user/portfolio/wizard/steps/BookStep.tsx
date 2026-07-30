import { useEffect } from 'react';

import { useT } from '../../../../i18n';
import { Icon } from '../../../../ui/origin';
import { cx } from '../../../components/ui';
import type { PortfolioBook, PortfolioWizardStepProps } from '../types';
import type { IconName } from '../../../../ui/origin';

/**
 * Step 3 — who keeps the book. Two real options, no third invented one:
 *
 *   • `solo` — a plain portfolio. The frame creates it on Continue.
 *   • `shared` — a MIRRORCHAIN group book (§11). Continue hands off to the
 *     existing create-chain → invite-a-friend flow, which creates the group
 *     portfolio itself; the wizard creates nothing on this branch, so the user
 *     never ends up with an orphan plain portfolio beside the group one.
 *
 * A group book carries the group icon rather than the icon picked one step back
 * — the shared option says so rather than letting the choice quietly evaporate.
 */
const OPTIONS: ReadonlyArray<{ book: PortfolioBook; icon: IconName }> = [
  { book: 'solo', icon: 'user-lock' },
  { book: 'shared', icon: 'users' },
];

export function BookStep({ draft, patch, report }: PortfolioWizardStepProps) {
  const t = useT();

  useEffect(() => {
    report({ ready: true });
  }, [report]);

  return (
    <div
      aria-label={t('portfolio.wizard.book.title')}
      className="bt-pfw__choices"
      role="radiogroup"
    >
      {OPTIONS.map(({ book, icon }) => {
        const selected = draft.book === book;
        return (
          <button
            aria-checked={selected}
            className={cx('bt-pfw__choice', selected && 'is-active')}
            key={book}
            onClick={() => patch({ book })}
            role="radio"
            type="button"
          >
            <Icon className="bt-pfw__choice-icon" name={icon} size={17} />
            <span className="bt-pfw__choice-text">
              <strong>{t(`portfolio.wizard.book.${book}.title`)}</strong>
              <small>{t(`portfolio.wizard.book.${book}.hint`)}</small>
            </span>
            {selected ? (
              <Icon className="bt-gold bt-pfw__choice-check" name="check" size={15} />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
