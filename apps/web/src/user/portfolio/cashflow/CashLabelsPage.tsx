import { Link } from 'react-router-dom';

import { useT } from '../../../i18n';
import { PageHead } from '../../../ui/origin';
import { CashRulesPage } from './CashRulesPage';
import { CashTagsPage } from './CashTagsPage';
import { usePreservedSearch } from '../../components/LocalNav';
import { ACTIVE_PORTFOLIO_PARAM } from '../PortfolioSwitcher';

/**
 * LABELS — tags and the rules that apply them, on one page (owner, 2026-07-31).
 *
 * They were two tabs, and that was the wrong seam: a tag on its own labels
 * nothing until you attach it, and a rule cannot exist without a tag to
 * assign — the Rules page even disables "New rule" until a tag exists. Two
 * tabs made a reader navigate between the two halves of a single thought,
 * and made the empty state ("no rules yet") unactionable from where it
 * appeared.
 *
 * Order is deliberate: tags first, because a rule needs one.
 *
 * This is SETUP, so it is not in the tab strip — Movements links to it, which
 * is where you are standing when you notice something is labelled wrong.
 */
export function CashLabelsPage() {
  const t = useT();
  const search = usePreservedSearch([ACTIVE_PORTFOLIO_PARAM]);
  const movements = search
    ? { pathname: '/portfolio/cash/movements', search }
    : '/portfolio/cash/movements';

  return (
    <div className="flex flex-col gap-8">
      <PageHead
        actions={
          <Link className="bt-btn" to={movements}>
            {t('cashflow.labels.backToMovements')}
          </Link>
        }
        title={t('cashflow.labels.title')}
      />
      <CashTagsPage embedded />
      <CashRulesPage embedded />
    </div>
  );
}
