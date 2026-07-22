import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Expense-tracking section shell (PROJECTPLAN.md §13.5 V5-P9). A NEW top-level
 * product area, strictly separate from portfolio money. Compact tabs —
 * Dashboard, Transactions, Budgets, Categories, Rules and bank-statement Import —
 * sit under one subnav (anti-bloat rule: main things visible, nothing folded
 * away that shouldn't be). The Dashboard is the landing surface (spend by
 * category, income-vs-spend, trends); Budgets sets per-category monthly targets.
 */
export function ExpensesLayout() {
  const t = useT();
  const items: readonly SubNavItem[] = [
    { to: '/expenses', label: t('expenses.nav.dashboard'), end: true },
    { to: '/expenses/transactions', label: t('expenses.nav.transactions') },
    { to: '/expenses/budgets', label: t('expenses.nav.budgets') },
    { to: '/expenses/categories', label: t('expenses.nav.categories') },
    { to: '/expenses/rules', label: t('expenses.nav.rules') },
    { to: '/expenses/import', label: t('expenses.nav.import') },
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
