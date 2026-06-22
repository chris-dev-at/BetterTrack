import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface StatCardProps {
  /** Short, uppercased caption — e.g. "Portfolio value". */
  label: string;
  /** The headline figure. Accepts a node so callers can pass a `MoneyText`. */
  value: ReactNode;
  /** Optional secondary line under the value — e.g. a day-change delta. */
  subValue?: ReactNode;
  className?: string;
}

/** Single-stat display card (PROJECTPLAN.md §7.3 StatCard). */
export function StatCard({ label, value, subValue, className }: StatCardProps) {
  return (
    <div className={cx('rounded-lg bg-neutral-900 p-4', className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-neutral-100">{value}</p>
      {subValue != null ? <p className="mt-0.5 text-sm text-neutral-400">{subValue}</p> : null}
    </div>
  );
}
