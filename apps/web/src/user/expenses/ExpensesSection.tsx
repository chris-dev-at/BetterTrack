import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Expense-tracking section shell (PROJECTPLAN.md §13.5 V5-P9, foundation 1/3). A
 * NEW top-level product area, strictly separate from portfolio money. Two compact
 * tabs — Transactions and Categories — sit under one subnav (anti-bloat rule:
 * main things visible, nothing folded away that shouldn't be). Bank CSV import,
 * dashboards, budgets and auto-categorization arrive in the later P9 issues.
 */
export function ExpensesLayout() {
  const t = useT();
  const items: readonly SubNavItem[] = [
    { to: '/expenses', label: t('expenses.nav.transactions'), end: true },
    { to: '/expenses/categories', label: t('expenses.nav.categories') },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-neutral-100">{t('expenses.title')}</h1>
        <p className="text-sm text-neutral-500">{t('expenses.tagline')}</p>
      </div>
      <SubNav items={items} />
      <Outlet />
    </div>
  );
}
