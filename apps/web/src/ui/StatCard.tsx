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

/**
 * Single-stat display card (PROJECTPLAN.md §7.3 StatCard), on the Origin
 * surface tokens: a flat panel with the shared label/value/delta hierarchy.
 */
export function StatCard({ label, value, subValue, className }: StatCardProps) {
  return (
    <div className={cx('bt-panel p-4', className)}>
      <p className="bt-stat__label">{label}</p>
      <p className="bt-num" style={{ fontSize: 20, fontWeight: 630, marginTop: 2 }}>
        {value}
      </p>
      {subValue != null ? (
        <p className="bt-meta" style={{ marginTop: 2 }}>
          {subValue}
        </p>
      ) : null}
    </div>
  );
}
