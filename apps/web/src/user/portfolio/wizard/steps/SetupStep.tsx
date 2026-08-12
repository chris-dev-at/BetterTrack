import { useEffect } from 'react';

import { useT } from '../../../../i18n';
import { Field, Icon, Input } from '../../../../ui/origin';
import type { IconName } from '../../../../ui/origin';
import { Alert, cx } from '../../../components/ui';
import { PortfolioIconChip } from '../../PortfolioIconChip';
import { PORTFOLIO_KINDS, PORTFOLIO_KIND_ICONS } from '../../portfolioKinds';
import { ParkedRow } from '../ParkedRow';
import type { PortfolioBook, PortfolioWizardStepProps } from '../types';

/**
 * MAKING A PORTFOLIO, ON ONE SCREEN (owner, 2026-07-31).
 *
 * This was four screens — name, then icon, then who keeps the book, then a
 * read-back — which is four presses of Continue to answer three questions,
 * two of which have a perfectly good default. A wizard earns its steps when a
 * later question depends on an earlier answer; none of these do. So they are one
 * panel: type a name, optionally pick an icon and who keeps it, press Create.
 *
 * The name is the only required answer and the only one without a sensible
 * default, so it leads and takes focus. Icon and book follow as quiet rows with
 * their defaults already selected — visible, so nobody has to guess what they
 * are, but never in the way of the one press that makes the thing.
 *
 * The step registry survives the collapse: a future question that genuinely
 * DOES depend on an earlier answer (opening balances differ by book, a broker
 * import needs the currency) is still one row in `stepMeta.ts` plus one
 * component, and the frame regains its stepper the moment there is more than
 * one step to show.
 */

/** §6.8 portfolio-name rule, unchanged from the dialog this replaces. */
const NAME_MAX = 120;

/**
 * Who keeps the book. Two real options, no third invented one:
 *
 *   • `solo` — a plain portfolio, created here.
 *   • `shared` — a MIRRORCHAIN group book (§11). Create hands off to the
 *     existing create-chain → invite-a-friend flow, which creates the group
 *     portfolio itself, so the user never ends up with an orphan plain
 *     portfolio beside the group one.
 */
const BOOKS: ReadonlyArray<{ book: PortfolioBook; icon: IconName }> = [
  { book: 'solo', icon: 'user-lock' },
  { book: 'shared', icon: 'users' },
];

export function SetupStep({ allowShared, draft, error, patch, report }: PortfolioWizardStepProps) {
  const t = useT();
  const trimmed = draft.name.trim();
  const ready = trimmed.length > 0 && trimmed.length <= NAME_MAX;

  useEffect(() => {
    report({ ready });
  }, [report, ready]);

  return (
    <>
      <Field htmlFor="bt-pfw-name" label={t('portfolio.switcher.nameLabel')}>
        <Input
          aria-label={t('portfolio.switcher.nameAriaLabel')}
          id="bt-pfw-name"
          maxLength={NAME_MAX}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder={t('portfolio.switcher.namePlaceholder')}
          value={draft.name}
        />
      </Field>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {/* The same picker as the Settings tab, and it persists the same way: the
          frame carries the pick in the create body (board #69), so there is one
          code path for "this portfolio's icon" and no window in which a fresh
          portfolio wears an icon nobody chose. */}
      <div className="bt-pfw__section">
        <p className="bt-pfw__sectionlabel">{t('portfolio.wizard.icon.title')}</p>
        <div
          aria-label={t('portfolio.settings.iconPickerAriaLabel')}
          className="bt-kind-picker"
          role="radiogroup"
        >
          {PORTFOLIO_KINDS.map((option) => (
            <button
              aria-checked={option === draft.kind}
              className={cx('bt-kind-option', option === draft.kind && 'is-active')}
              key={option}
              onClick={() => patch({ kind: option })}
              role="radio"
              type="button"
            >
              <PortfolioIconChip icon={PORTFOLIO_KIND_ICONS[option]} tint={option} />
              <span>{t(`portfolio.kinds.${option}`)}</span>
            </button>
          ))}
        </div>
      </div>

      {allowShared ? (
        <div className="bt-pfw__section">
          <p className="bt-pfw__sectionlabel">{t('portfolio.wizard.book.title')}</p>
          <div
            aria-label={t('portfolio.wizard.book.title')}
            className="bt-pfw__choices"
            role="radiogroup"
          >
            {BOOKS.map(({ book, icon }) => {
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
        </div>
      ) : null}

      {/* What the API cannot do yet, stated as prose — never as a control that
          silently does nothing. */}
      <div className="bt-pfw__parkedset">
        <ParkedRow label={t('portfolio.wizard.parked.currency')} />
        <ParkedRow label={t('portfolio.wizard.parked.template')} />
        <ParkedRow label={t('portfolio.wizard.parked.balances')} />
        <ParkedRow label={t('portfolio.wizard.parked.import')} />
      </div>
    </>
  );
}
