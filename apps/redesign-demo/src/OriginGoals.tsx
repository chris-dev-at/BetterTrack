import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry } from './OriginReviewCenter';
import { useAccessibleDialog, useDialogStepFocus } from './useAccessibleDialog';
import './origin-goals.css';

type GoalType =
  | 'financial-independence'
  | 'reserve'
  | 'property'
  | 'education'
  | 'retirement'
  | 'custom';
type GoalPriority = 'essential' | 'important' | 'flexible';
type GoalState = 'active' | 'paused' | 'completed' | 'archived';
type GoalHealth = 'ahead' | 'on-track' | 'at-risk' | 'complete' | 'paused' | 'archived';
type RuleState = 'none' | 'pending-review' | 'active';
type ContributionType = 'deposit' | 'transfer' | 'dividend' | 'sale' | 'adjustment';

type PortfolioContext = {
  id: string;
  name: string;
  value: number;
  currency: string;
};

type GoalContribution = {
  id: string;
  amount: number;
  date: string;
  type: ContributionType;
  source: string;
  note?: string;
  activityReference: string;
};

type GoalBalanceLink = {
  id: string;
  label: string;
  type: 'portfolio' | 'account' | 'manual';
  value: number;
  included: boolean;
};

type AllocationTarget = {
  id: string;
  label: string;
  target: number;
  actual: number;
  tone: 'gold' | 'blue' | 'green' | 'violet' | 'muted';
};

export type OriginGoal = {
  id: string;
  name: string;
  type: GoalType;
  target: number;
  currentValue: number;
  deadline: string;
  monthlyContribution: number;
  expectedReturn: number;
  inflation: number;
  priority: GoalPriority;
  state: GoalState;
  createdAt: string;
  links: GoalBalanceLink[];
  contributions: GoalContribution[];
  allocation: AllocationTarget[];
  ruleState: RuleState;
  note: string;
};

type GoalReceipt = {
  id: string;
  goalId: string;
  kind: 'goal.created' | 'goal.updated' | 'contribution.recorded' | 'rule.proposed';
  at: string;
  summary: string;
  reference: string;
};

type GoalStore = {
  version: 1;
  goals: OriginGoal[];
  receipts: GoalReceipt[];
};

export type OriginGoalsProps = {
  portfolio:
    | string
    | {
        id: string;
        name: string;
        value: number;
        currency?: string;
      };
  privateMode: boolean;
  onAssistant?: (context: string) => void;
  onOpenWorkbench?: (context: string) => void;
  onSubmitProposal?: (proposal: OriginReviewEntry) => void;
  onToast?: (message: string) => void;
};

const goalTypeMeta: Record<GoalType, { label: string; description: string; icon: IconName }> = {
  'financial-independence': {
    label: 'Financial independence',
    description: 'Fund life from invested wealth on your terms.',
    icon: 'sparkles',
  },
  reserve: {
    label: 'Cash reserve',
    description: 'Keep essential spending covered and liquid.',
    icon: 'shield',
  },
  property: {
    label: 'Property or purchase',
    description: 'Build toward a deposit or another major purchase.',
    icon: 'house',
  },
  education: {
    label: 'Education',
    description: 'Plan a known education cost and its timing.',
    icon: 'document',
  },
  retirement: {
    label: 'Retirement',
    description: 'Set a long-range retirement capital target.',
    icon: 'calendar',
  },
  custom: {
    label: 'Custom milestone',
    description: 'Define a target that is specific to your life.',
    icon: 'target',
  },
};

const contributionLabels: Record<ContributionType, string> = {
  deposit: 'Cash deposit',
  transfer: 'Portfolio transfer',
  dividend: 'Dividend assigned',
  sale: 'Sale proceeds',
  adjustment: 'Balance adjustment',
};

const today = '2026-07-27';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function portfolioContext(portfolio: OriginGoalsProps['portfolio']): PortfolioContext {
  if (typeof portfolio === 'string') {
    return {
      id: portfolio.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'portfolio',
      name: portfolio,
      value: 327_420,
      currency: 'EUR',
    };
  }
  return {
    id: portfolio.id,
    name: portfolio.name,
    value: portfolio.value,
    currency: portfolio.currency ?? 'EUR',
  };
}

function formatMoney(value: number, currency: string, privateMode = false) {
  if (privateMode) return '••••••';
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(value) < 10_000 ? 0 : 0,
  }).format(value);
}

function compactMoney(value: number, currency: string, privateMode = false) {
  if (privateMode) return '••••';
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function seedGoals(portfolio: PortfolioContext): OriginGoal[] {
  const portfolioLink: GoalBalanceLink = {
    id: `portfolio_${portfolio.id}`,
    label: portfolio.name,
    type: 'portfolio',
    value: portfolio.value,
    included: true,
  };
  return [
    {
      id: 'goal_financial_independence',
      name: 'Financial independence',
      type: 'financial-independence',
      target: 1_200_000,
      currentValue: Math.min(portfolio.value, 327_420),
      deadline: '2048-12-31',
      monthlyContribution: 1_250,
      expectedReturn: 6.4,
      inflation: 2,
      priority: 'essential',
      state: 'active',
      createdAt: '2025-01-06T08:18:00.000Z',
      links: [
        portfolioLink,
        {
          id: 'account_pension',
          label: 'Employer pension estimate',
          type: 'manual',
          value: 64_000,
          included: false,
        },
      ],
      contributions: [
        {
          id: 'contribution_fi_1',
          amount: 1_250,
          date: '2026-07-02',
          type: 'transfer',
          source: 'Monthly investing activity',
          note: 'July portfolio contribution',
          activityReference: 'ACT-2026-0702-018',
        },
        {
          id: 'contribution_fi_2',
          amount: 412,
          date: '2026-06-24',
          type: 'dividend',
          source: 'Portfolio income',
          note: 'Quarterly distributions assigned to goal',
          activityReference: 'ACT-2026-0624-044',
        },
      ],
      allocation: [
        { id: 'equity', label: 'Global equity', target: 70, actual: 75.8, tone: 'gold' },
        { id: 'bonds', label: 'Bonds', target: 20, actual: 13.9, tone: 'blue' },
        { id: 'cash', label: 'Cash', target: 10, actual: 10.3, tone: 'green' },
      ],
      ruleState: 'active',
      note: 'Maintain optionality and fund core living costs without forced asset sales.',
    },
    {
      id: 'goal_cash_reserve',
      name: 'Six-month cash reserve',
      type: 'reserve',
      target: 18_000,
      currentValue: 13_840,
      deadline: '2027-07-01',
      monthlyContribution: 400,
      expectedReturn: 2.2,
      inflation: 2,
      priority: 'essential',
      state: 'active',
      createdAt: '2025-10-11T10:42:00.000Z',
      links: [
        {
          id: 'account_reserve',
          label: 'Reserve account · 2081',
          type: 'account',
          value: 13_840,
          included: true,
        },
        { ...portfolioLink, included: false },
      ],
      contributions: [
        {
          id: 'contribution_reserve_1',
          amount: 400,
          date: '2026-07-05',
          type: 'deposit',
          source: 'Reserve account · 2081',
          activityReference: 'ACT-2026-0705-003',
        },
      ],
      allocation: [
        { id: 'cash', label: 'Instant access cash', target: 75, actual: 72, tone: 'green' },
        { id: 'money-market', label: 'Money market', target: 25, actual: 28, tone: 'blue' },
      ],
      ruleState: 'active',
      note: 'Keep six months of baseline expenses outside market risk.',
    },
    {
      id: 'goal_property',
      name: 'Property deposit',
      type: 'property',
      target: 160_000,
      currentValue: 42_100,
      deadline: '2032-09-01',
      monthlyContribution: 950,
      expectedReturn: 4.1,
      inflation: 2.3,
      priority: 'important',
      state: 'active',
      createdAt: '2026-02-16T13:10:00.000Z',
      links: [
        {
          id: 'account_property',
          label: 'Property sleeve',
          type: 'account',
          value: 42_100,
          included: true,
        },
        { ...portfolioLink, included: false },
      ],
      contributions: [
        {
          id: 'contribution_property_1',
          amount: 2_500,
          date: '2026-05-18',
          type: 'transfer',
          source: 'Annual bonus allocation',
          activityReference: 'ACT-2026-0518-011',
        },
      ],
      allocation: [
        { id: 'equity', label: 'Global equity', target: 35, actual: 41, tone: 'gold' },
        { id: 'bonds', label: 'Short-duration bonds', target: 35, actual: 31, tone: 'blue' },
        { id: 'cash', label: 'Cash', target: 30, actual: 28, tone: 'green' },
      ],
      ruleState: 'none',
      note: 'Preserve a flexible purchase window while progressively reducing risk.',
    },
  ];
}

function loadStore(key: string, portfolio: PortfolioContext): GoalStore {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GoalStore>;
      if (parsed.version === 1 && Array.isArray(parsed.goals) && parsed.goals.length > 0) {
        return {
          version: 1,
          goals: parsed.goals,
          receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
        };
      }
    }
  } catch {
    // A private or locked-down browser can reject storage. The workspace remains usable in-memory.
  }
  return { version: 1, goals: seedGoals(portfolio), receipts: [] };
}

function monthsUntil(deadline: string) {
  const start = new Date(today);
  const end = new Date(deadline);
  if (Number.isNaN(end.getTime())) return 12;
  return Math.max(
    1,
    Math.round(
      (end.getFullYear() - start.getFullYear()) * 12 +
        end.getMonth() -
        start.getMonth() +
        (end.getDate() - start.getDate()) / 30,
    ),
  );
}

type ProjectionPoint = {
  index: number;
  date: Date;
  low: number;
  baseline: number;
  high: number;
};

function projection(goal: OriginGoal) {
  const totalMonths = Math.min(480, Math.max(12, monthsUntil(goal.deadline)));
  const start = new Date(today);
  const monthlyRate = (annual: number) =>
    Math.pow((1 + annual / 100) / (1 + goal.inflation / 100), 1 / 12) - 1;
  const rates: [number, number, number] = [
    monthlyRate(Math.max(0.2, goal.expectedReturn - 2.4)),
    monthlyRate(goal.expectedReturn),
    monthlyRate(goal.expectedReturn + 2.2),
  ];
  const values: [number, number, number] = [
    goal.currentValue,
    goal.currentValue,
    goal.currentValue,
  ];
  const points: ProjectionPoint[] = [];
  for (let index = 0; index <= totalMonths; index += 1) {
    const date = new Date(start);
    date.setMonth(date.getMonth() + index);
    points.push({
      index,
      date,
      low: values[0],
      baseline: values[1],
      high: values[2],
    });
    values[0] = values[0] * (1 + rates[0]) + goal.monthlyContribution;
    values[1] = values[1] * (1 + rates[1]) + goal.monthlyContribution;
    values[2] = values[2] * (1 + rates[2]) + goal.monthlyContribution;
  }
  return points;
}

function goalHealth(goal: OriginGoal, points: ProjectionPoint[]): GoalHealth {
  if (goal.state === 'archived') return 'archived';
  if (goal.state === 'paused') return 'paused';
  if (goal.state === 'completed' || goal.currentValue >= goal.target) return 'complete';
  const ending = points.at(-1)?.baseline ?? goal.currentValue;
  if (ending >= goal.target * 1.08) return 'ahead';
  if (ending >= goal.target * 0.92) return 'on-track';
  return 'at-risk';
}

function healthLabel(health: GoalHealth) {
  return {
    ahead: 'Ahead',
    'on-track': 'On track',
    'at-risk': 'Needs attention',
    complete: 'Complete',
    paused: 'Paused',
    archived: 'Archived',
  }[health];
}

function makePath(points: ProjectionPoint[], field: 'low' | 'baseline' | 'high', maximum: number) {
  const left = 68;
  const top = 24;
  const width = 906;
  const height = 258;
  return points
    .map((point, index) => {
      const x = left + (index / Math.max(1, points.length - 1)) * width;
      const y = top + height - (point[field] / maximum) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function ProjectionChart({
  goal,
  privateMode,
  currency,
}: {
  goal: OriginGoal;
  privateMode: boolean;
  currency: string;
}) {
  const points = useMemo(() => projection(goal), [goal]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const maximum = Math.max(goal.target, ...points.map((point) => point.high)) * 1.08;
  const targetY = 24 + 258 - (goal.target / maximum) * 258;
  const activeIndex = hoverIndex ?? points.length - 1;
  const activePoint = points[activeIndex] ?? points[points.length - 1]!;
  const activePointLabel = `${activePoint.date.toLocaleDateString('en-IE', {
    month: 'long',
    year: 'numeric',
  })}. Low ${formatMoney(activePoint.low, currency, privateMode)}, baseline ${formatMoney(
    activePoint.baseline,
    currency,
    privateMode,
  )}, high ${formatMoney(activePoint.high, currency, privateMode)}.`;
  const x = 68 + (activeIndex / Math.max(1, points.length - 1)) * 906;
  const tooltipX = x > 760 ? x - 182 : x + 12;
  const yearTicks = [0, 0.25, 0.5, 0.75, 1];
  const targetIndex = points.findIndex((point) => point.baseline >= goal.target);
  const contributionDates = goal.contributions.slice(0, 8).map((item) => {
    const contributionDate = new Date(item.date);
    const start = new Date(today);
    const month =
      (contributionDate.getFullYear() - start.getFullYear()) * 12 +
      contributionDate.getMonth() -
      start.getMonth();
    return {
      ...item,
      plotIndex: Math.max(0, Math.min(points.length - 1, month)),
    };
  });
  const plannedContributionMarkers =
    goal.monthlyContribution > 0
      ? Array.from(
          { length: Math.min(12, Math.floor((points.length - 1) / 12)) },
          (_, markerIndex) => Math.min(points.length - 1, (markerIndex + 1) * 12),
        )
      : [];

  return (
    <div className="og-chart-wrap">
      <svg
        aria-label={`${goal.name} projection. Baseline, lower, and upper estimates through ${new Date(
          goal.deadline,
        ).getFullYear()}. Use Left and Right Arrow to inspect monthly points; Home and End jump to the first and last point.`}
        aria-valuemax={Math.max(0, points.length - 1)}
        aria-valuemin={0}
        aria-valuenow={activeIndex}
        aria-valuetext={activePointLabel}
        aria-orientation="horizontal"
        className="og-chart"
        onBlur={() => setHoverIndex(null)}
        onFocus={() => setHoverIndex((current) => current ?? points.length - 1)}
        onKeyDown={(event) => {
          let nextIndex: number | null = null;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            nextIndex = Math.max(0, activeIndex - 1);
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            nextIndex = Math.min(points.length - 1, activeIndex + 1);
          } else if (event.key === 'Home') {
            nextIndex = 0;
          } else if (event.key === 'End') {
            nextIndex = points.length - 1;
          }
          if (nextIndex === null) return;
          event.preventDefault();
          setHoverIndex(nextIndex);
        }}
        onPointerLeave={() => setHoverIndex(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const chartX = ((event.clientX - rect.left) / rect.width) * 1000;
          const ratio = Math.max(0, Math.min(1, (chartX - 68) / 906));
          setHoverIndex(Math.round(ratio * (points.length - 1)));
        }}
        role="slider"
        tabIndex={0}
        viewBox="0 0 1000 330"
      >
        <defs>
          <linearGradient id={`og-fill-${goal.id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity=".13" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const gridY = 24 + tick * 258;
          const value = maximum * (1 - tick);
          return (
            <g key={tick}>
              <line className="og-chart__grid" x1="68" x2="974" y1={gridY} y2={gridY} />
              <text className="og-chart__axis" textAnchor="end" x="58" y={gridY + 3}>
                {compactMoney(value, currency, privateMode)}
              </text>
            </g>
          );
        })}
        {yearTicks.map((tick) => {
          const index = Math.round(tick * (points.length - 1));
          const tickX = 68 + tick * 906;
          return (
            <text
              className="og-chart__axis"
              key={tick}
              textAnchor={tick === 0 ? 'start' : tick === 1 ? 'end' : 'middle'}
              x={tickX}
              y="309"
            >
              {points[index]!.date.toLocaleDateString('en-IE', {
                month: points.length < 30 ? 'short' : undefined,
                year: 'numeric',
              })}
            </text>
          );
        })}
        <line className="og-chart__target" x1="68" x2="974" y1={targetY} y2={targetY} />
        <text className="og-chart__target-label" textAnchor="end" x="970" y={targetY - 7}>
          TARGET · {compactMoney(goal.target, currency, privateMode)}
        </text>
        <path
          className="og-chart__range"
          d={`${makePath(points, 'high', maximum)} ${points
            .slice()
            .reverse()
            .map((point, reverseIndex) => {
              const originalIndex = points.length - 1 - reverseIndex;
              const pathX = 68 + (originalIndex / Math.max(1, points.length - 1)) * 906;
              const pathY = 24 + 258 - (point.low / maximum) * 258;
              return `L${pathX.toFixed(2)} ${pathY.toFixed(2)}`;
            })
            .join(' ')} Z`}
          fill={`url(#og-fill-${goal.id})`}
        />
        <path className="og-chart__line og-chart__line--low" d={makePath(points, 'low', maximum)} />
        <path
          className="og-chart__line og-chart__line--high"
          d={makePath(points, 'high', maximum)}
        />
        <path
          className="og-chart__line og-chart__line--baseline"
          d={makePath(points, 'baseline', maximum)}
        />
        {targetIndex >= 0 ? (
          <g>
            <circle
              className="og-chart__milestone"
              cx={68 + (targetIndex / Math.max(1, points.length - 1)) * 906}
              cy={24 + 258 - ((points[targetIndex]?.baseline ?? goal.target) / maximum) * 258}
              r="4"
            />
          </g>
        ) : null}
        {contributionDates.map((item) => {
          const markerX = 68 + (item.plotIndex / Math.max(1, points.length - 1)) * 906;
          return (
            <path
              className="og-chart__contribution"
              d={`M${markerX - 3} 288h6l-3 -6Z`}
              key={item.id}
            >
              <title>
                {contributionLabels[item.type]} · {formatMoney(item.amount, currency, privateMode)}
              </title>
            </path>
          );
        })}
        {plannedContributionMarkers.map((plotIndex) => {
          const markerX = 68 + (plotIndex / Math.max(1, points.length - 1)) * 906;
          return (
            <line
              className="og-chart__planned-contribution"
              key={plotIndex}
              x1={markerX}
              x2={markerX}
              y1="284"
              y2="290"
            >
              <title>
                Twelve planned contributions ·{' '}
                {formatMoney(goal.monthlyContribution * 12, currency, privateMode)}
              </title>
            </line>
          );
        })}
        {hoverIndex !== null ? (
          <g className="og-chart__inspect">
            <line x1={x} x2={x} y1="24" y2="282" />
            <circle cx={x} cy={24 + 258 - (activePoint.baseline / maximum) * 258} r="4" />
            <rect height="88" rx="5" width="170" x={tooltipX} y="36" />
            <text x={tooltipX + 12} y="55">
              {activePoint.date.toLocaleDateString('en-IE', {
                month: 'short',
                year: 'numeric',
              })}
            </text>
            <text className="is-muted" x={tooltipX + 12} y="75">
              HIGH
            </text>
            <text textAnchor="end" x={tooltipX + 158} y="75">
              {compactMoney(activePoint.high, currency, privateMode)}
            </text>
            <text className="is-accent" x={tooltipX + 12} y="94">
              BASE
            </text>
            <text className="is-accent" textAnchor="end" x={tooltipX + 158} y="94">
              {compactMoney(activePoint.baseline, currency, privateMode)}
            </text>
            <text className="is-muted" x={tooltipX + 12} y="113">
              LOW
            </text>
            <text textAnchor="end" x={tooltipX + 158} y="113">
              {compactMoney(activePoint.low, currency, privateMode)}
            </text>
          </g>
        ) : null}
      </svg>
      <p aria-live="polite" className="og-sr-only">
        {hoverIndex === null ? '' : activePointLabel}
      </p>
      <div aria-label="Projection legend" className="og-chart-legend" role="list">
        <span role="listitem">
          <i className="is-baseline" /> Baseline
        </span>
        <span role="listitem">
          <i className="is-range" /> Planning range
        </span>
        <span role="listitem">
          <i className="is-target" /> Target
        </span>
        <span role="listitem">
          <i className="is-contribution" /> Recorded contribution
        </span>
        <span role="listitem">
          <i className="is-planned" /> Annual plan marker
        </span>
      </div>
    </div>
  );
}

type GoalDraft = Pick<
  OriginGoal,
  | 'target'
  | 'deadline'
  | 'monthlyContribution'
  | 'expectedReturn'
  | 'inflation'
  | 'priority'
  | 'state'
  | 'note'
  | 'links'
>;

type NewGoalDraft = {
  type: GoalType;
  name: string;
  target: number;
  deadline: string;
  monthlyContribution: number;
  expectedReturn: number;
  inflation: number;
  priority: GoalPriority;
  links: GoalBalanceLink[];
  fundingSource: string;
  contributionDay: number;
};

function defaultNewGoal(portfolio: PortfolioContext): NewGoalDraft {
  return {
    type: 'property',
    name: 'Next milestone',
    target: 100_000,
    deadline: '2032-12-31',
    monthlyContribution: 750,
    expectedReturn: 4.5,
    inflation: 2,
    priority: 'important',
    links: [
      {
        id: `portfolio_${portfolio.id}`,
        label: portfolio.name,
        type: 'portfolio',
        value: portfolio.value,
        included: false,
      },
      {
        id: 'account_goal_cash',
        label: 'Goal cash account · 4712',
        type: 'account',
        value: 12_400,
        included: true,
      },
      {
        id: 'manual_other_balance',
        label: 'Other starting balance',
        type: 'manual',
        value: 0,
        included: false,
      },
    ],
    fundingSource: 'EUR cash',
    contributionDay: 2,
  };
}

function buildAllocation(type: GoalType): AllocationTarget[] {
  if (type === 'reserve') {
    return [
      { id: 'cash', label: 'Instant access cash', target: 80, actual: 80, tone: 'green' },
      { id: 'money-market', label: 'Money market', target: 20, actual: 20, tone: 'blue' },
    ];
  }
  if (type === 'property' || type === 'education') {
    return [
      { id: 'equity', label: 'Global equity', target: 35, actual: 35, tone: 'gold' },
      { id: 'bonds', label: 'Short-duration bonds', target: 35, actual: 35, tone: 'blue' },
      { id: 'cash', label: 'Cash', target: 30, actual: 30, tone: 'green' },
    ];
  }
  return [
    { id: 'equity', label: 'Global equity', target: 70, actual: 70, tone: 'gold' },
    { id: 'bonds', label: 'Bonds', target: 20, actual: 20, tone: 'blue' },
    { id: 'cash', label: 'Cash', target: 10, actual: 10, tone: 'green' },
  ];
}

export function OriginGoals({
  portfolio,
  privateMode,
  onAssistant,
  onOpenWorkbench,
  onSubmitProposal,
  onToast,
}: OriginGoalsProps) {
  const context = useMemo(() => portfolioContext(portfolio), [portfolio]);
  const storageKey = `bt-demo-origin-goals-v1:${context.id}`;
  const [store, setStore] = useState<GoalStore>(() => loadStore(storageKey, context));
  const [boundStorageKey, setBoundStorageKey] = useState(storageKey);
  const [selectedId, setSelectedId] = useState(
    () => store.goals.find((goal) => goal.state !== 'archived')?.id ?? store.goals[0]?.id,
  );
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<GoalDraft | null>(null);
  const [contributionOpen, setContributionOpen] = useState(false);
  const [contributionDraft, setContributionDraft] = useState({
    amount: 500,
    date: today,
    type: 'deposit' as ContributionType,
    source: `${context.name} activity`,
    note: '',
  });
  const [allocationDraft, setAllocationDraft] = useState<Record<string, number> | null>(null);
  const [allocationError, setAllocationError] = useState('');
  const [confirmAction, setConfirmAction] = useState<{
    action: 'archive' | 'restore';
    goalId: string;
  } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [newGoal, setNewGoal] = useState<NewGoalDraft>(() => defaultNewGoal(context));
  const [createdReceipt, setCreatedReceipt] = useState<GoalReceipt | null>(null);
  const wizardHeadingRef = useRef<HTMLHeadingElement>(null);
  const editDialogRef = useAccessibleDialog<HTMLFormElement>({
    open: editing && editDraft !== null,
    onClose: () => setEditing(false),
  });
  const contributionDialogRef = useAccessibleDialog<HTMLFormElement>({
    open: contributionOpen,
    onClose: () => setContributionOpen(false),
  });
  const wizardDialogRef = useAccessibleDialog<HTMLDivElement>({
    open: wizardOpen,
    onClose: closeWizard,
  });
  const confirmDialogRef = useAccessibleDialog<HTMLDivElement>({
    open: confirmAction !== null,
    onClose: () => setConfirmAction(null),
  });

  useDialogStepFocus(wizardOpen, wizardStep, wizardHeadingRef);

  useEffect(() => {
    if (boundStorageKey === storageKey) return;
    const nextStore = loadStore(storageKey, context);
    setStore(nextStore);
    setSelectedId(
      nextStore.goals.find((goal) => goal.state !== 'archived')?.id ?? nextStore.goals[0]?.id,
    );
    setBoundStorageKey(storageKey);
    setEditing(false);
    setContributionOpen(false);
    setAllocationDraft(null);
  }, [boundStorageKey, context, storageKey]);

  useEffect(() => {
    if (boundStorageKey !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(store));
    } catch {
      // The full interaction still works in-memory when persistence is unavailable.
    }
  }, [boundStorageKey, storageKey, store]);

  const selected =
    store.goals.find((goal) => goal.id === selectedId) ??
    store.goals.find((goal) => goal.state !== 'archived') ??
    store.goals[0];

  const visibleGoals = store.goals.filter((goal) => goal.state !== 'archived' || showArchived);

  const goalModels = useMemo(
    () =>
      store.goals.map((goal) => {
        const points = projection(goal);
        return { goal, points, health: goalHealth(goal, points) };
      }),
    [store.goals],
  );

  if (!selected) return null;

  const selectedPoints = projection(selected);
  const selectedHealth = goalHealth(selected, selectedPoints);
  const endPoint = selectedPoints.at(-1) ?? {
    low: selected.currentValue,
    baseline: selected.currentValue,
    high: selected.currentValue,
  };
  const progress = Math.min(100, (selected.currentValue / selected.target) * 100);
  const gap = Math.max(0, selected.target - endPoint.baseline);
  const targetMonth = selectedPoints.find((point) => point.baseline >= selected.target);
  const latestReceipts = store.receipts
    .filter((receipt) => receipt.goalId === selected.id)
    .slice(0, 4);

  const patchGoal = (goalId: string, change: (goal: OriginGoal) => OriginGoal) => {
    setStore((current) => ({
      ...current,
      goals: current.goals.map((goal) => (goal.id === goalId ? change(goal) : goal)),
    }));
  };

  const addReceipt = (receipt: GoalReceipt) => {
    setStore((current) => ({
      ...current,
      receipts: [receipt, ...current.receipts].slice(0, 100),
    }));
  };

  const beginEdit = () => {
    setEditDraft({
      target: selected.target,
      deadline: selected.deadline,
      monthlyContribution: selected.monthlyContribution,
      expectedReturn: selected.expectedReturn,
      inflation: selected.inflation,
      priority: selected.priority,
      state: selected.state,
      note: selected.note,
      links: selected.links.map((link) => ({ ...link })),
    });
    setEditing(true);
  };

  const saveEdit = () => {
    if (!editDraft || editDraft.target <= 0 || editDraft.monthlyContribution < 0) return;
    patchGoal(selected.id, (goal) => ({ ...goal, ...editDraft }));
    const receipt: GoalReceipt = {
      id: uid('receipt'),
      goalId: selected.id,
      kind: 'goal.updated',
      at: isoNow(),
      summary: 'Planning assumptions and linked balances updated',
      reference: `GOAL-${selected.id.slice(-6).toUpperCase()}-${Date.now().toString().slice(-5)}`,
    };
    addReceipt(receipt);
    setEditing(false);
    setEditDraft(null);
    onToast?.('Goal plan updated with a persistent receipt.');
  };

  const recordContribution = () => {
    if (contributionDraft.amount <= 0 || !contributionDraft.source.trim()) return;
    const activityReference = `ACT-${contributionDraft.date.replaceAll('-', '')}-${String(
      selected.contributions.length + 1,
    ).padStart(3, '0')}`;
    const contribution: GoalContribution = {
      id: uid('contribution'),
      amount: contributionDraft.amount,
      date: contributionDraft.date,
      type: contributionDraft.type,
      source: contributionDraft.source.trim(),
      note: contributionDraft.note.trim() || undefined,
      activityReference,
    };
    patchGoal(selected.id, (goal) => ({
      ...goal,
      currentValue: goal.currentValue + contribution.amount,
      contributions: [contribution, ...goal.contributions],
    }));
    addReceipt({
      id: uid('receipt'),
      goalId: selected.id,
      kind: 'contribution.recorded',
      at: isoNow(),
      summary: `${contributionLabels[contribution.type]} linked to ${activityReference}`,
      reference: activityReference,
    });
    setContributionOpen(false);
    setContributionDraft((draft) => ({ ...draft, amount: 500, note: '' }));
    onToast?.('Contribution linked to the goal and portfolio activity.');
  };

  const submitRuleProposal = (goal: OriginGoal) => {
    if (goal.monthlyContribution <= 0) {
      onToast?.('Set a monthly contribution before proposing a rule.');
      return;
    }
    const proposalId = uid('review_goal_rule');
    const proposal: OriginReviewEntry = {
      id: proposalId,
      kind: 'automation',
      title: `Activate contribution plan · ${goal.name}`,
      summary: `Propose ${formatMoney(
        goal.monthlyContribution,
        context.currency,
      )} each month toward ${goal.name}. No money moves until this Review item is approved.`,
      portfolio: {
        id: context.id,
        name: context.name,
        path: `${context.name} / Goals / ${goal.name}`,
      },
      source: {
        label: 'Goals & Plan',
        detail: 'User-authored recurring contribution rule',
        actor: 'You',
      },
      requestedAt: isoNow(),
      requestedBy: 'You',
      status: 'pending',
      priority: goal.priority === 'essential' ? 'high' : 'normal',
      risk: 'medium',
      affectedCount: 1,
      tags: ['goal', 'recurring', 'cash'],
      approveLabel: 'Approve rule',
      rejectLabel: 'Keep as plan only',
      diff: [
        {
          label: 'Automation state',
          before: 'Plan assumption only',
          after: 'Pending approval',
          tone: 'warning',
        },
        {
          label: 'Monthly proposal',
          before: 'None',
          after: formatMoney(goal.monthlyContribution, context.currency),
        },
        {
          label: 'Funding source',
          before: 'No account access',
          after: goal.links.find((link) => link.included)?.label ?? `${context.name} cash`,
        },
      ],
      calculations: [
        {
          label: 'Annual planned amount',
          value: formatMoney(goal.monthlyContribution * 12, context.currency),
          detail:
            'Twelve proposed contributions; execution still requires the chosen review policy.',
        },
        {
          label: 'Cash guardrail',
          value: '€1,000 minimum',
          detail: 'A run is blocked when available cash would fall below the floor.',
          tone: 'warning',
        },
      ],
      lineage: [
        {
          label: 'Goal assumption',
          detail: `${goal.name} · ${formatMoney(goal.target, context.currency)} by ${goal.deadline}`,
          at: isoNow(),
          state: 'derived',
        },
        {
          label: 'Portfolio scope',
          detail: context.name,
          state: 'verified',
        },
      ],
      permissions: [
        {
          label: 'Read goal progress',
          detail: 'Target, deadline, and planned contribution',
          outcome: 'allowed',
        },
        {
          label: 'Read portfolio cash',
          detail: 'Used only to evaluate the cash floor',
          outcome: 'review',
        },
        {
          label: 'Write activity',
          detail: 'Blocked until this proposal is approved',
          outcome: 'blocked',
        },
      ],
      policies: [
        {
          title: 'No silent writes',
          description: 'Every proposed contribution enters Review before changing portfolio truth.',
          status: 'pass',
        },
        {
          title: 'Scoped access',
          description: `The rule can only read and propose changes inside ${context.name}.`,
          status: 'pass',
        },
      ],
    };
    onSubmitProposal?.(proposal);
    patchGoal(goal.id, (current) => ({ ...current, ruleState: 'pending-review' }));
    addReceipt({
      id: uid('receipt'),
      goalId: goal.id,
      kind: 'rule.proposed',
      at: isoNow(),
      summary: 'Recurring contribution rule sent to Review',
      reference: proposalId,
    });
    onToast?.('Contribution rule sent to Review. Nothing was activated yet.');
  };

  const saveAllocation = () => {
    if (!allocationDraft) return;
    const total = Object.values(allocationDraft).reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 100) > 0.05) {
      setAllocationError(`Targets total ${total.toFixed(1)}%. They must total 100%.`);
      return;
    }
    patchGoal(selected.id, (goal) => ({
      ...goal,
      allocation: goal.allocation.map((row) => ({
        ...row,
        target: allocationDraft[row.id] ?? row.target,
      })),
    }));
    setAllocationDraft(null);
    setAllocationError('');
    addReceipt({
      id: uid('receipt'),
      goalId: selected.id,
      kind: 'goal.updated',
      at: isoNow(),
      summary: 'Target allocation updated',
      reference: `ALLOC-${Date.now().toString().slice(-7)}`,
    });
    onToast?.('Target allocation saved.');
  };

  const finishWizard = () => {
    const startingBalance = newGoal.links
      .filter((link) => link.included)
      .reduce((sum, link) => sum + link.value, 0);
    const goalId = uid('goal');
    const goal: OriginGoal = {
      id: goalId,
      name: newGoal.name.trim() || goalTypeMeta[newGoal.type].label,
      type: newGoal.type,
      target: Math.max(1, newGoal.target),
      currentValue: startingBalance,
      deadline: newGoal.deadline,
      monthlyContribution: Math.max(0, newGoal.monthlyContribution),
      expectedReturn: newGoal.expectedReturn,
      inflation: newGoal.inflation,
      priority: newGoal.priority,
      state: 'active',
      createdAt: isoNow(),
      links: newGoal.links,
      contributions: [],
      allocation: buildAllocation(newGoal.type),
      ruleState: newGoal.monthlyContribution > 0 ? 'pending-review' : 'none',
      note: `Created from ${goalTypeMeta[newGoal.type].label.toLowerCase()} template.`,
    };
    const receipt: GoalReceipt = {
      id: uid('receipt'),
      goalId,
      kind: 'goal.created',
      at: isoNow(),
      summary: `Created ${goal.name} with ${formatMoney(
        startingBalance,
        context.currency,
      )} linked opening balance`,
      reference: `GOAL-${Date.now().toString().slice(-8)}`,
    };
    setStore((current) => ({
      ...current,
      goals: [...current.goals, goal],
      receipts: [receipt, ...current.receipts],
    }));
    setSelectedId(goalId);
    setCreatedReceipt(receipt);
    setWizardStep(5);
    if (goal.monthlyContribution > 0) {
      const proposal: OriginReviewEntry = {
        id: uid('review_goal_rule'),
        kind: 'automation',
        title: `Review monthly plan · ${goal.name}`,
        summary: `${formatMoney(
          goal.monthlyContribution,
          context.currency,
        )} monthly from ${newGoal.fundingSource}; proposed only, never silently activated.`,
        portfolio: { id: context.id, name: context.name, path: `${context.name} / Goals` },
        source: { label: 'Goal creation', detail: 'Recurring rule draft', actor: 'You' },
        requestedAt: isoNow(),
        requestedBy: 'You',
        status: 'pending',
        priority: goal.priority === 'essential' ? 'high' : 'normal',
        risk: 'medium',
        tags: ['goal', 'recurring'],
        approveLabel: 'Approve monthly rule',
        rejectLabel: 'Keep goal without rule',
        diff: [
          {
            label: 'Monthly contribution',
            before: 'Plan assumption',
            after: `${formatMoney(goal.monthlyContribution, context.currency)} on day ${
              newGoal.contributionDay
            }`,
          },
          {
            label: 'Funding source',
            before: 'None',
            after: newGoal.fundingSource,
          },
        ],
        calculations: [
          {
            label: 'Annual planned amount',
            value: formatMoney(goal.monthlyContribution * 12, context.currency),
          },
        ],
        lineage: [
          {
            label: 'Created goal',
            detail: `${goal.name} · ${receipt.reference}`,
            at: receipt.at,
            state: 'verified',
          },
        ],
        permissions: [
          {
            label: 'Read available cash',
            detail: newGoal.fundingSource,
            outcome: 'review',
          },
          {
            label: 'Create proposed contribution',
            detail: 'No direct execution permission',
            outcome: 'blocked',
          },
        ],
        policies: [
          {
            title: 'Review gate',
            description: 'Activation and future writes remain blocked pending explicit approval.',
            status: 'pass',
          },
        ],
      };
      onSubmitProposal?.(proposal);
      addReceipt({
        id: uid('receipt'),
        goalId,
        kind: 'rule.proposed',
        at: isoNow(),
        summary: 'Monthly goal rule sent to Review',
        reference: proposal.id,
      });
    }
    onToast?.(
      goal.monthlyContribution > 0
        ? 'Goal created. Its recurring rule is waiting in Review.'
        : 'Goal created without a recurring rule.',
    );
  };

  function closeWizard() {
    setWizardOpen(false);
    setWizardStep(0);
    setCreatedReceipt(null);
    setNewGoal(defaultNewGoal(context));
  }

  const confirmLifecycle = () => {
    if (!confirmAction) return;
    patchGoal(confirmAction.goalId, (goal) => ({
      ...goal,
      state: confirmAction.action === 'archive' ? 'archived' : 'active',
    }));
    const next =
      confirmAction.action === 'archive'
        ? store.goals.find((goal) => goal.id !== confirmAction.goalId && goal.state !== 'archived')
        : store.goals.find((goal) => goal.id === confirmAction.goalId);
    if (next) setSelectedId(next.id);
    if (confirmAction.action === 'restore') setShowArchived(true);
    onToast?.(
      confirmAction.action === 'archive'
        ? 'Goal archived. Its history and receipts were preserved.'
        : 'Goal restored to the active plan.',
    );
    setConfirmAction(null);
  };

  return (
    <section className="origin-goals">
      <header className="og-page-header">
        <h1 className="og-sr-only">Goals &amp; Plan</h1>
        <div className="og-page-header__actions">
          {onAssistant ? (
            <button
              className="og-button og-button--secondary"
              onClick={() =>
                onAssistant(`Review my goals, assumptions, and funding gaps for ${context.name}`)
              }
              type="button"
            >
              <Icon name="sparkles" size={14} /> Ask about this plan
            </button>
          ) : null}
          <button
            className="og-button og-button--primary"
            onClick={() => setWizardOpen(true)}
            type="button"
          >
            <Icon name="plus" size={14} /> New goal
          </button>
        </div>
      </header>

      <div className="og-workspace">
        <aside className="og-goal-rail">
          <div className="og-rail-heading">
            <div>
              <strong>Goals</strong>
              <span>{visibleGoals.length}</span>
            </div>
          </div>
          <div className="og-goal-list">
            {visibleGoals.map((goal) => {
              const model = goalModels.find((item) => item.goal.id === goal.id);
              const health = model?.health ?? 'at-risk';
              const itemProgress = Math.min(100, (goal.currentValue / goal.target) * 100);
              return (
                <button
                  aria-current={selected.id === goal.id ? 'page' : undefined}
                  className={cx(
                    'og-goal-row',
                    selected.id === goal.id && 'is-active',
                    goal.state === 'archived' && 'is-archived',
                  )}
                  key={goal.id}
                  onClick={() => {
                    setSelectedId(goal.id);
                    setEditing(false);
                    setContributionOpen(false);
                    setAllocationDraft(null);
                  }}
                  type="button"
                >
                  <span className="og-goal-row__top">
                    <i className={`is-${health}`}>
                      <Icon name={goalTypeMeta[goal.type].icon} size={13} />
                    </i>
                    <span>
                      <strong>{goal.name}</strong>
                      <small>
                        {healthLabel(health)} · {new Date(goal.deadline).getFullYear()}
                      </small>
                    </span>
                    <Icon name="chevron-right" size={12} />
                  </span>
                  <span className="og-goal-row__money">
                    <b>{formatMoney(goal.currentValue, context.currency, privateMode)}</b>
                    <small>of {formatMoney(goal.target, context.currency, privateMode)}</small>
                  </span>
                  <span className="og-progress">
                    <i style={{ width: `${itemProgress}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
          {store.goals.some((goal) => goal.state === 'archived') ? (
            <button
              className="og-archived-toggle"
              onClick={() => setShowArchived((current) => !current)}
              type="button"
            >
              <Icon name={showArchived ? 'eye-off' : 'eye'} size={12} />
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          ) : null}
        </aside>

        <main className="og-detail">
          <div className="og-detail-header">
            <div>
              <span className={`og-status is-${selectedHealth}`}>
                <i /> {healthLabel(selectedHealth)}
              </span>
              <h2>{selected.name}</h2>
              <p>{selected.note}</p>
            </div>
            <div className="og-detail-header__actions">
              {selected.state !== 'archived' ? (
                <>
                  <button
                    className="og-button og-button--secondary"
                    onClick={() => setContributionOpen(true)}
                    type="button"
                  >
                    <Icon name="plus" size={13} /> Add contribution
                  </button>
                  <button className="og-button og-button--quiet" onClick={beginEdit} type="button">
                    <Icon name="sliders" size={13} /> Edit plan
                  </button>
                </>
              ) : (
                <button
                  className="og-button og-button--primary"
                  onClick={() => setConfirmAction({ action: 'restore', goalId: selected.id })}
                  type="button"
                >
                  <Icon name="refresh" size={13} /> Restore goal
                </button>
              )}
              <button
                aria-label="More goal actions"
                className="og-icon-button"
                onClick={() =>
                  setConfirmAction({
                    action: selected.state === 'archived' ? 'restore' : 'archive',
                    goalId: selected.id,
                  })
                }
                type="button"
              >
                <Icon name="more" size={15} />
              </button>
            </div>
          </div>

          <div className="og-plan-focus" aria-label={`${selected.name} progress`}>
            <div className="og-plan-focus__primary">
              <span>Current</span>
              <div>
                <strong>{formatMoney(selected.currentValue, context.currency, privateMode)}</strong>
                <small>of {formatMoney(selected.target, context.currency, privateMode)}</small>
              </div>
              <span
                aria-label={`${progress.toFixed(1)}% funded`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.round(progress)}
                className="og-plan-focus__bar"
                role="progressbar"
              >
                <i style={{ width: `${progress}%` }} />
              </span>
              <small>{progress.toFixed(1)}% funded</small>
            </div>
            <div className="og-plan-focus__projection">
              <span>Projected at deadline</span>
              <strong>{formatMoney(endPoint.baseline, context.currency, privateMode)}</strong>
              <small className={gap > 0 ? 'is-warning' : 'is-positive'}>
                {gap > 0
                  ? `${formatMoney(gap, context.currency, privateMode)} short`
                  : `${formatMoney(
                      endPoint.baseline - selected.target,
                      context.currency,
                      privateMode,
                    )} above target`}
              </small>
              <small>
                {selected.ruleState === 'active'
                  ? 'Approved rule active'
                  : selected.ruleState === 'pending-review'
                    ? 'Rule pending in Review'
                    : 'Plan only · no automation'}
              </small>
            </div>
          </div>

          <section className="og-projection-section">
            <div className="og-section-heading">
              <div>
                <h3>Projection</h3>
              </div>
            </div>
            <ProjectionChart
              currency={context.currency}
              goal={selected}
              privateMode={privateMode}
            />
            <details className="og-assumptions-disclosure">
              <summary>
                <span>
                  <strong>Assumptions &amp; timing</strong>
                  <small>
                    {formatMoney(selected.monthlyContribution, context.currency, privateMode)} /
                    month · {selected.expectedReturn.toFixed(1)}% return
                  </small>
                </span>
                <Icon name="chevron-down" size={13} />
              </summary>
              <div className="og-assumptions">
                <div>
                  <span>Monthly contribution</span>
                  <strong>
                    {formatMoney(selected.monthlyContribution, context.currency, privateMode)}
                  </strong>
                  <small>Applied at month end</small>
                </div>
                <div>
                  <span>Deadline</span>
                  <strong>{new Date(selected.deadline).toLocaleDateString('en-IE')}</strong>
                  <small>
                    Target reached{' '}
                    {targetMonth
                      ? targetMonth.date.toLocaleDateString('en-IE', {
                          month: 'short',
                          year: 'numeric',
                        })
                      : 'after the planning range'}
                  </small>
                </div>
                <div>
                  <span>Expected return</span>
                  <strong>{selected.expectedReturn.toFixed(1)}% / year</strong>
                  <small>Before inflation</small>
                </div>
                <div>
                  <span>Inflation</span>
                  <strong>{selected.inflation.toFixed(1)}% / year</strong>
                  <small>Values shown in today&apos;s money</small>
                </div>
                <div>
                  <span>Planning range</span>
                  <strong>
                    {Math.max(0.2, selected.expectedReturn - 2.4).toFixed(1)}–
                    {(selected.expectedReturn + 2.2).toFixed(1)}%
                  </strong>
                  <small>Illustrative, not guaranteed</small>
                </div>
                <div>
                  <span>Model scope</span>
                  <strong>Returns &amp; contributions</strong>
                  <small>Taxes, fees, and income shocks excluded</small>
                </div>
              </div>
            </details>
          </section>

          <div className="og-detail-grid">
            <section className="og-ruled-section">
              <div className="og-section-heading">
                <div>
                  <span>Portfolio linkage</span>
                  <h3>Balances funding this goal</h3>
                </div>
              </div>
              <div className="og-linked-list">
                {selected.links.map((link) => (
                  <div className={link.included ? undefined : 'is-excluded'} key={link.id}>
                    <i>
                      <Icon
                        name={
                          link.type === 'portfolio'
                            ? 'portfolio'
                            : link.type === 'account'
                              ? 'bank'
                              : 'database'
                        }
                        size={13}
                      />
                    </i>
                    <span>
                      <strong>{link.label}</strong>
                      <small>
                        {link.type} ·{' '}
                        {link.included ? 'Included in progress' : 'Available, excluded'}
                      </small>
                    </span>
                    <b>{formatMoney(link.value, context.currency, privateMode)}</b>
                  </div>
                ))}
              </div>
            </section>

            <section className="og-ruled-section">
              <div className="og-section-heading">
                <div>
                  <span>Contribution rule</span>
                  <h3>
                    {selected.ruleState === 'active'
                      ? 'Approved and active'
                      : selected.ruleState === 'pending-review'
                        ? 'Waiting in Review'
                        : 'Plan assumption only'}
                  </h3>
                </div>
                {selected.ruleState === 'none' ? (
                  <button
                    className="og-button og-button--secondary"
                    onClick={() => submitRuleProposal(selected)}
                    type="button"
                  >
                    Propose rule
                  </button>
                ) : null}
              </div>
              <div className="og-rule-copy">
                <Icon name={selected.ruleState === 'active' ? 'check' : 'shield'} size={16} />
                <p>
                  <strong>
                    {formatMoney(selected.monthlyContribution, context.currency, privateMode)}{' '}
                    monthly
                  </strong>
                  {selected.ruleState === 'active'
                    ? 'The approved rule creates a proposed portfolio activity each month.'
                    : selected.ruleState === 'pending-review'
                      ? 'Review must approve the rule before it can propose portfolio activity.'
                      : 'This amount affects projections only. It does not create activity or move cash.'}
                </p>
              </div>
            </section>
          </div>

          <section className="og-allocation-section">
            <div className="og-section-heading">
              <div>
                <span>Target allocation</span>
                <h3>Risk should match the deadline</h3>
              </div>
              <div className="og-heading-actions">
                {allocationDraft ? (
                  <>
                    <button
                      className="og-button og-button--quiet"
                      onClick={() => {
                        setAllocationDraft(null);
                        setAllocationError('');
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="og-button og-button--secondary"
                      onClick={saveAllocation}
                      type="button"
                    >
                      Save targets
                    </button>
                  </>
                ) : (
                  <button
                    className="og-button og-button--quiet"
                    onClick={() =>
                      setAllocationDraft(
                        Object.fromEntries(selected.allocation.map((row) => [row.id, row.target])),
                      )
                    }
                    type="button"
                  >
                    Edit targets
                  </button>
                )}
                <button
                  className="og-button og-button--secondary"
                  onClick={() =>
                    onOpenWorkbench?.(
                      `goal:${selected.id}:rebalance:${selected.allocation
                        .map((row) => `${row.id}-${row.target}`)
                        .join(',')}`,
                    )
                  }
                  type="button"
                >
                  <Icon name="workbench" size={13} /> Build rebalance scenario
                </button>
              </div>
            </div>
            {allocationError ? <p className="og-form-error">{allocationError}</p> : null}
            <div className="og-allocation-table">
              <div className="og-allocation-table__head">
                <span>Sleeve</span>
                <span>Actual</span>
                <span>Target</span>
                <span>Drift</span>
                <span>Position</span>
              </div>
              {selected.allocation.map((row) => {
                const target = allocationDraft?.[row.id] ?? row.target;
                const drift = row.actual - target;
                return (
                  <div className="og-allocation-row" key={row.id}>
                    <span>
                      <i className={`is-${row.tone}`} /> {row.label}
                    </span>
                    <strong>{row.actual.toFixed(1)}%</strong>
                    <span>
                      {allocationDraft ? (
                        <label>
                          <span className="og-sr-only">Target for {row.label}</span>
                          <input
                            max="100"
                            min="0"
                            onChange={(event) =>
                              setAllocationDraft((current) => ({
                                ...(current ?? {}),
                                [row.id]: Number(event.target.value),
                              }))
                            }
                            step="0.5"
                            type="number"
                            value={target}
                          />
                          %
                        </label>
                      ) : (
                        <strong>{target.toFixed(1)}%</strong>
                      )}
                    </span>
                    <span className={Math.abs(drift) > 4 ? 'is-warning' : undefined}>
                      {drift > 0 ? '+' : ''}
                      {drift.toFixed(1)}%
                    </span>
                    <span className="og-allocation-bar">
                      <i className={`is-${row.tone}`} style={{ width: `${row.actual}%` }} />
                      <b style={{ left: `${target}%` }} />
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="og-history-grid">
            <section className="og-ruled-section">
              <div className="og-section-heading">
                <div>
                  <span>Contribution history</span>
                  <h3>{selected.contributions.length} linked activities</h3>
                </div>
                <button
                  className="og-button og-button--quiet"
                  onClick={() => setContributionOpen(true)}
                  type="button"
                >
                  Add
                </button>
              </div>
              <div className="og-history-list">
                {selected.contributions.length ? (
                  selected.contributions.slice(0, 5).map((item) => (
                    <div key={item.id}>
                      <i>
                        <Icon name={item.type === 'dividend' ? 'cash' : 'arrow-down'} size={12} />
                      </i>
                      <span>
                        <strong>{contributionLabels[item.type]}</strong>
                        <small>
                          {item.source} · {item.date}
                        </small>
                      </span>
                      <span>
                        <b>+{formatMoney(item.amount, context.currency, privateMode)}</b>
                        <small>{item.activityReference}</small>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="og-empty-row">No contribution activities are linked yet.</p>
                )}
              </div>
            </section>
            <section className="og-ruled-section">
              <div className="og-section-heading">
                <div>
                  <span>Write receipts</span>
                  <h3>Plan lineage</h3>
                </div>
              </div>
              <div className="og-receipt-list">
                {latestReceipts.length ? (
                  latestReceipts.map((receipt) => (
                    <div key={receipt.id}>
                      <Icon name="check" size={11} />
                      <span>
                        <strong>{receipt.summary}</strong>
                        <small>
                          {new Date(receipt.at).toLocaleString('en-IE')} · {receipt.reference}
                        </small>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="og-empty-row">
                    Seeded plan · future edits create persistent receipts here.
                  </p>
                )}
              </div>
            </section>
          </div>
        </main>
      </div>

      {editing && editDraft ? (
        <div className="og-overlay" data-accessible-dialog-layer role="presentation">
          <form
            aria-labelledby="og-edit-title"
            aria-modal="true"
            className="og-dialog og-dialog--wide"
            onSubmit={(event) => {
              event.preventDefault();
              saveEdit();
            }}
            ref={editDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="og-dialog__header">
              <div>
                <span>Planning assumptions</span>
                <h2 id="og-edit-title">Edit {selected.name}</h2>
              </div>
              <button
                aria-label="Close edit plan"
                className="og-icon-button"
                onClick={() => setEditing(false)}
                type="button"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="og-form-grid">
              <label>
                <span>Target amount</span>
                <div className="og-input-prefix">
                  <i>{context.currency}</i>
                  <input
                    min="1"
                    onChange={(event) =>
                      setEditDraft({ ...editDraft, target: Number(event.target.value) })
                    }
                    step="1000"
                    type="number"
                    value={editDraft.target}
                  />
                </div>
              </label>
              <label>
                <span>Deadline</span>
                <input
                  min={today}
                  onChange={(event) => setEditDraft({ ...editDraft, deadline: event.target.value })}
                  type="date"
                  value={editDraft.deadline}
                />
              </label>
              <label>
                <span>Monthly plan</span>
                <div className="og-input-prefix">
                  <i>{context.currency}</i>
                  <input
                    min="0"
                    onChange={(event) =>
                      setEditDraft({
                        ...editDraft,
                        monthlyContribution: Number(event.target.value),
                      })
                    }
                    step="50"
                    type="number"
                    value={editDraft.monthlyContribution}
                  />
                </div>
                <small>Changing this affects projection only, not automation.</small>
              </label>
              <label>
                <span>Expected return</span>
                <div className="og-input-suffix">
                  <input
                    max="20"
                    min="-10"
                    onChange={(event) =>
                      setEditDraft({
                        ...editDraft,
                        expectedReturn: Number(event.target.value),
                      })
                    }
                    step="0.1"
                    type="number"
                    value={editDraft.expectedReturn}
                  />
                  <i>% / year</i>
                </div>
              </label>
              <label>
                <span>Inflation</span>
                <div className="og-input-suffix">
                  <input
                    max="15"
                    min="0"
                    onChange={(event) =>
                      setEditDraft({ ...editDraft, inflation: Number(event.target.value) })
                    }
                    step="0.1"
                    type="number"
                    value={editDraft.inflation}
                  />
                  <i>% / year</i>
                </div>
              </label>
              <label>
                <span>Priority</span>
                <select
                  onChange={(event) =>
                    setEditDraft({
                      ...editDraft,
                      priority: event.target.value as GoalPriority,
                    })
                  }
                  value={editDraft.priority}
                >
                  <option value="essential">Essential</option>
                  <option value="important">Important</option>
                  <option value="flexible">Flexible</option>
                </select>
              </label>
              <label>
                <span>Goal status</span>
                <select
                  onChange={(event) =>
                    setEditDraft({ ...editDraft, state: event.target.value as GoalState })
                  }
                  value={editDraft.state}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="completed">Completed</option>
                </select>
              </label>
              <label className="og-form-grid__wide">
                <span>Planning note</span>
                <textarea
                  onChange={(event) => setEditDraft({ ...editDraft, note: event.target.value })}
                  rows={3}
                  value={editDraft.note}
                />
              </label>
            </div>
            <fieldset className="og-link-fieldset">
              <legend>Linked balances</legend>
              <p>
                Select which balances count toward progress. This does not move or merge assets.
              </p>
              {editDraft.links.map((link, index) => (
                <label key={link.id}>
                  <input
                    checked={link.included}
                    onChange={(event) => {
                      const links = editDraft.links.map((current, currentIndex) =>
                        currentIndex === index
                          ? { ...current, included: event.target.checked }
                          : current,
                      );
                      setEditDraft({ ...editDraft, links });
                    }}
                    type="checkbox"
                  />
                  <span>
                    <strong>{link.label}</strong>
                    <small>{formatMoney(link.value, context.currency, privateMode)}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="og-dialog__footer">
              <p>
                <Icon name="shield" size={12} /> Saving assumptions does not activate or change a
                recurring rule.
              </p>
              <button
                className="og-button og-button--quiet"
                onClick={() => setEditing(false)}
                type="button"
              >
                Cancel
              </button>
              <button className="og-button og-button--primary" type="submit">
                Save plan
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {contributionOpen ? (
        <div className="og-overlay" data-accessible-dialog-layer role="presentation">
          <form
            aria-labelledby="og-contribution-title"
            aria-modal="true"
            className="og-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              recordContribution();
            }}
            ref={contributionDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="og-dialog__header">
              <div>
                <span>Portfolio-linked activity</span>
                <h2 id="og-contribution-title">Record a contribution</h2>
              </div>
              <button
                aria-label="Close contribution"
                className="og-icon-button"
                onClick={() => setContributionOpen(false)}
                type="button"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <p className="og-dialog__intro">
              This adds an attributed activity to goal progress. It does not create a bank
              transaction or broker order.
            </p>
            <div className="og-form-stack">
              <label>
                <span>Contribution type</span>
                <select
                  onChange={(event) =>
                    setContributionDraft({
                      ...contributionDraft,
                      type: event.target.value as ContributionType,
                    })
                  }
                  value={contributionDraft.type}
                >
                  {Object.entries(contributionLabels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Amount</span>
                <div className="og-input-prefix">
                  <i>{context.currency}</i>
                  <input
                    min="0.01"
                    onChange={(event) =>
                      setContributionDraft({
                        ...contributionDraft,
                        amount: Number(event.target.value),
                      })
                    }
                    step="0.01"
                    type="number"
                    value={contributionDraft.amount}
                  />
                </div>
              </label>
              <label>
                <span>Activity date</span>
                <input
                  max={today}
                  onChange={(event) =>
                    setContributionDraft({ ...contributionDraft, date: event.target.value })
                  }
                  type="date"
                  value={contributionDraft.date}
                />
              </label>
              <label>
                <span>Portfolio activity or source</span>
                <input
                  onChange={(event) =>
                    setContributionDraft({ ...contributionDraft, source: event.target.value })
                  }
                  placeholder="e.g. July cash deposit"
                  required
                  type="text"
                  value={contributionDraft.source}
                />
              </label>
              <label>
                <span>Note (optional)</span>
                <textarea
                  onChange={(event) =>
                    setContributionDraft({ ...contributionDraft, note: event.target.value })
                  }
                  rows={2}
                  value={contributionDraft.note}
                />
              </label>
            </div>
            <div className="og-preview-line">
              <span>Goal balance after receipt</span>
              <strong>
                {formatMoney(
                  selected.currentValue + Math.max(0, contributionDraft.amount),
                  context.currency,
                  privateMode,
                )}
              </strong>
            </div>
            <div className="og-dialog__footer">
              <p>A persistent activity reference and plan receipt will be created.</p>
              <button
                className="og-button og-button--quiet"
                onClick={() => setContributionOpen(false)}
                type="button"
              >
                Cancel
              </button>
              <button className="og-button og-button--primary" type="submit">
                Record contribution
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {wizardOpen ? (
        <div className="og-overlay" data-accessible-dialog-layer role="presentation">
          <div
            aria-labelledby="og-wizard-title"
            aria-modal="true"
            className="og-dialog og-dialog--wizard"
            ref={wizardDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="og-dialog__header">
              <div>
                <span>{wizardStep < 5 ? `Step ${wizardStep + 1} of 5` : 'Persistent receipt'}</span>
                <h2 id="og-wizard-title" ref={wizardHeadingRef} tabIndex={-1}>
                  {wizardStep === 0 && 'What are you planning for?'}
                  {wizardStep === 1 && 'Define the finish line'}
                  {wizardStep === 2 && 'Link existing balances'}
                  {wizardStep === 3 && 'Draft a monthly rule'}
                  {wizardStep === 4 && 'Review the complete plan'}
                  {wizardStep === 5 && 'Goal created'}
                </h2>
              </div>
              <button
                aria-label="Close new goal"
                className="og-icon-button"
                onClick={closeWizard}
                type="button"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            {wizardStep < 5 ? (
              <div className="og-wizard-progress">
                {[0, 1, 2, 3, 4].map((step) => (
                  <i className={step <= wizardStep ? 'is-active' : undefined} key={step} />
                ))}
              </div>
            ) : null}

            <div className="og-wizard-body">
              {wizardStep === 0 ? (
                <div className="og-goal-types">
                  {(
                    Object.entries(goalTypeMeta) as Array<
                      [GoalType, (typeof goalTypeMeta)[GoalType]]
                    >
                  ).map(([id, meta]) => (
                    <button
                      aria-pressed={newGoal.type === id}
                      className={newGoal.type === id ? 'is-active' : undefined}
                      key={id}
                      onClick={() =>
                        setNewGoal({
                          ...newGoal,
                          type: id,
                          name: id === 'custom' ? '' : meta.label,
                        })
                      }
                      type="button"
                    >
                      <i>
                        <Icon name={meta.icon} size={15} />
                      </i>
                      <span>
                        <strong>{meta.label}</strong>
                        <small>{meta.description}</small>
                      </span>
                      <Icon name="chevron-right" size={12} />
                    </button>
                  ))}
                </div>
              ) : null}

              {wizardStep === 1 ? (
                <div className="og-form-stack">
                  <label>
                    <span>Goal name</span>
                    <input
                      autoFocus
                      onChange={(event) => setNewGoal({ ...newGoal, name: event.target.value })}
                      placeholder="A name you will recognize"
                      type="text"
                      value={newGoal.name}
                    />
                  </label>
                  <label>
                    <span>Target in today&apos;s money</span>
                    <div className="og-input-prefix">
                      <i>{context.currency}</i>
                      <input
                        min="1"
                        onChange={(event) =>
                          setNewGoal({ ...newGoal, target: Number(event.target.value) })
                        }
                        step="1000"
                        type="number"
                        value={newGoal.target}
                      />
                    </div>
                  </label>
                  <label>
                    <span>Target date</span>
                    <input
                      min={today}
                      onChange={(event) => setNewGoal({ ...newGoal, deadline: event.target.value })}
                      type="date"
                      value={newGoal.deadline}
                    />
                  </label>
                  <label>
                    <span>Priority</span>
                    <select
                      onChange={(event) =>
                        setNewGoal({
                          ...newGoal,
                          priority: event.target.value as GoalPriority,
                        })
                      }
                      value={newGoal.priority}
                    >
                      <option value="essential">Essential · protect first</option>
                      <option value="important">Important · balance with other goals</option>
                      <option value="flexible">Flexible · timing can move</option>
                    </select>
                  </label>
                </div>
              ) : null}

              {wizardStep === 2 ? (
                <div>
                  <p className="og-dialog__intro">
                    Included balances establish today&apos;s progress. Linking is read-only and does
                    not move assets between portfolios.
                  </p>
                  <div className="og-wizard-links">
                    {newGoal.links.map((link, index) => (
                      <label key={link.id}>
                        <input
                          checked={link.included}
                          onChange={(event) =>
                            setNewGoal({
                              ...newGoal,
                              links: newGoal.links.map((row, rowIndex) =>
                                rowIndex === index
                                  ? { ...row, included: event.target.checked }
                                  : row,
                              ),
                            })
                          }
                          type="checkbox"
                        />
                        <i>
                          <Icon
                            name={
                              link.type === 'portfolio'
                                ? 'portfolio'
                                : link.type === 'account'
                                  ? 'bank'
                                  : 'database'
                            }
                            size={14}
                          />
                        </i>
                        <span>
                          <strong>{link.label}</strong>
                          <small>
                            {link.type === 'manual'
                              ? 'Enter a tracked opening balance'
                              : 'Read linked balance'}
                          </small>
                        </span>
                        {link.type === 'manual' ? (
                          <div className="og-inline-amount">
                            <small>{context.currency}</small>
                            <input
                              aria-label={`${link.label} value`}
                              min="0"
                              onChange={(event) =>
                                setNewGoal({
                                  ...newGoal,
                                  links: newGoal.links.map((row, rowIndex) =>
                                    rowIndex === index
                                      ? { ...row, value: Number(event.target.value) }
                                      : row,
                                  ),
                                })
                              }
                              step="100"
                              type="number"
                              value={link.value}
                            />
                          </div>
                        ) : (
                          <b>{formatMoney(link.value, context.currency, privateMode)}</b>
                        )}
                      </label>
                    ))}
                  </div>
                  <div className="og-preview-line">
                    <span>Linked opening balance</span>
                    <strong>
                      {formatMoney(
                        newGoal.links
                          .filter((link) => link.included)
                          .reduce((sum, link) => sum + link.value, 0),
                        context.currency,
                        privateMode,
                      )}
                    </strong>
                  </div>
                </div>
              ) : null}

              {wizardStep === 3 ? (
                <div>
                  <div className="og-form-grid">
                    <label>
                      <span>Monthly contribution</span>
                      <div className="og-input-prefix">
                        <i>{context.currency}</i>
                        <input
                          min="0"
                          onChange={(event) =>
                            setNewGoal({
                              ...newGoal,
                              monthlyContribution: Number(event.target.value),
                            })
                          }
                          step="50"
                          type="number"
                          value={newGoal.monthlyContribution}
                        />
                      </div>
                    </label>
                    <label>
                      <span>Proposal day</span>
                      <select
                        onChange={(event) =>
                          setNewGoal({
                            ...newGoal,
                            contributionDay: Number(event.target.value),
                          })
                        }
                        value={newGoal.contributionDay}
                      >
                        {[1, 2, 5, 10, 15, 20, 25, 28].map((day) => (
                          <option key={day} value={day}>
                            Day {day} each month
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Funding source</span>
                      <select
                        onChange={(event) =>
                          setNewGoal({ ...newGoal, fundingSource: event.target.value })
                        }
                        value={newGoal.fundingSource}
                      >
                        <option>EUR cash</option>
                        <option>Reserve account · 2081</option>
                        <option>External bank · 4712</option>
                      </select>
                    </label>
                    <label>
                      <span>Expected return</span>
                      <div className="og-input-suffix">
                        <input
                          max="20"
                          min="-10"
                          onChange={(event) =>
                            setNewGoal({
                              ...newGoal,
                              expectedReturn: Number(event.target.value),
                            })
                          }
                          step="0.1"
                          type="number"
                          value={newGoal.expectedReturn}
                        />
                        <i>% / year</i>
                      </div>
                    </label>
                    <label>
                      <span>Inflation</span>
                      <div className="og-input-suffix">
                        <input
                          max="15"
                          min="0"
                          onChange={(event) =>
                            setNewGoal({
                              ...newGoal,
                              inflation: Number(event.target.value),
                            })
                          }
                          step="0.1"
                          type="number"
                          value={newGoal.inflation}
                        />
                        <i>% / year</i>
                      </div>
                    </label>
                  </div>
                  <div className="og-policy-callout">
                    <Icon name="shield" size={17} />
                    <p>
                      <strong>Review is mandatory.</strong>
                      Completing the wizard creates a pending automation proposal. It does not
                      activate a transfer, trade, or portfolio write.
                    </p>
                  </div>
                </div>
              ) : null}

              {wizardStep === 4 ? (
                <div className="og-plan-review">
                  <div className="og-review-hero">
                    <i>
                      <Icon name={goalTypeMeta[newGoal.type].icon} size={19} />
                    </i>
                    <span>
                      <small>{goalTypeMeta[newGoal.type].label}</small>
                      <strong>{newGoal.name || goalTypeMeta[newGoal.type].label}</strong>
                    </span>
                    <b>{formatMoney(newGoal.target, context.currency, privateMode)}</b>
                  </div>
                  <dl>
                    <div>
                      <dt>Deadline</dt>
                      <dd>{new Date(newGoal.deadline).toLocaleDateString('en-IE')}</dd>
                    </div>
                    <div>
                      <dt>Opening balance</dt>
                      <dd>
                        {formatMoney(
                          newGoal.links
                            .filter((link) => link.included)
                            .reduce((sum, link) => sum + link.value, 0),
                          context.currency,
                          privateMode,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Monthly plan</dt>
                      <dd>
                        {formatMoney(newGoal.monthlyContribution, context.currency, privateMode)} on
                        day {newGoal.contributionDay}
                      </dd>
                    </div>
                    <div>
                      <dt>Return / inflation</dt>
                      <dd>
                        {newGoal.expectedReturn.toFixed(1)}% / {newGoal.inflation.toFixed(1)}%
                      </dd>
                    </div>
                    <div>
                      <dt>Linked balances</dt>
                      <dd>{newGoal.links.filter((link) => link.included).length} included</dd>
                    </div>
                    <div>
                      <dt>Rule state after creation</dt>
                      <dd className="is-warning">
                        {newGoal.monthlyContribution > 0 ? 'Pending Review' : 'No recurring rule'}
                      </dd>
                    </div>
                  </dl>
                  <div className="og-policy-callout">
                    <Icon name="inbox" size={17} />
                    <p>
                      <strong>One plan, two explicit records.</strong>
                      The goal is stored immediately with a receipt. Its monthly rule is a separate
                      Review item and stays inactive until approved.
                    </p>
                  </div>
                </div>
              ) : null}

              {wizardStep === 5 && createdReceipt ? (
                <div className="og-created-state">
                  <i>
                    <Icon name="check" size={24} />
                  </i>
                  <span>Stored in {context.name}</span>
                  <h3>{newGoal.name || goalTypeMeta[newGoal.type].label} is ready</h3>
                  <p>
                    The plan is live. The monthly contribution remains a pending proposal in Review,
                    so no cash or activity changed.
                  </p>
                  <dl>
                    <div>
                      <dt>Receipt</dt>
                      <dd>{createdReceipt.reference}</dd>
                    </div>
                    <div>
                      <dt>Recorded</dt>
                      <dd>{new Date(createdReceipt.at).toLocaleString('en-IE')}</dd>
                    </div>
                    <div>
                      <dt>Portfolio</dt>
                      <dd>{context.name}</dd>
                    </div>
                    <div>
                      <dt>Rule</dt>
                      <dd>{newGoal.monthlyContribution > 0 ? 'Pending Review' : 'Not created'}</dd>
                    </div>
                  </dl>
                </div>
              ) : null}
            </div>

            <div className="og-dialog__footer og-wizard-footer">
              {wizardStep === 5 ? (
                <>
                  <p>
                    <Icon name="check" size={12} /> Goal and receipt persist across reloads.
                  </p>
                  <button
                    className="og-button og-button--primary"
                    onClick={closeWizard}
                    type="button"
                  >
                    View goal
                  </button>
                </>
              ) : (
                <>
                  <p>
                    {wizardStep === 0 && 'Choose a starting template; every field stays editable.'}
                    {wizardStep === 1 && 'Targets are modeled in today’s purchasing power.'}
                    {wizardStep === 2 && 'Linking is read-only and reversible.'}
                    {wizardStep === 3 && 'Rules always go through Review.'}
                    {wizardStep === 4 && 'Confirm the plan and create its persistent receipt.'}
                  </p>
                  {wizardStep > 0 ? (
                    <button
                      className="og-button og-button--quiet"
                      onClick={() => setWizardStep((step) => step - 1)}
                      type="button"
                    >
                      Back
                    </button>
                  ) : null}
                  <button
                    className="og-button og-button--primary"
                    disabled={
                      (wizardStep === 1 &&
                        (!newGoal.name.trim() ||
                          newGoal.target <= 0 ||
                          newGoal.deadline <= today)) ||
                      (wizardStep === 2 && !newGoal.links.some((link) => link.included)) ||
                      (wizardStep === 3 && newGoal.monthlyContribution < 0)
                    }
                    onClick={() =>
                      wizardStep === 4 ? finishWizard() : setWizardStep((step) => step + 1)
                    }
                    type="button"
                  >
                    {wizardStep === 4 ? 'Create goal' : 'Continue'}
                    <Icon name="arrow-right" size={12} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {confirmAction ? (
        <div className="og-overlay" data-accessible-dialog-layer role="presentation">
          <div
            aria-labelledby="og-confirm-title"
            aria-modal="true"
            className="og-dialog og-dialog--confirm"
            ref={confirmDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <i className="og-confirm-icon">
              <Icon name={confirmAction.action === 'archive' ? 'folder' : 'refresh'} size={20} />
            </i>
            <span>Goal lifecycle</span>
            <h2 id="og-confirm-title">
              {confirmAction.action === 'archive' ? 'Archive this goal?' : 'Restore this goal?'}
            </h2>
            <p>
              {confirmAction.action === 'archive'
                ? 'The goal leaves the active plan. Its history, contributions, and write receipts stay intact.'
                : 'The goal returns to the active plan with its previous assumptions and complete history.'}
            </p>
            <div className="og-confirm-summary">
              <strong>{store.goals.find((goal) => goal.id === confirmAction.goalId)?.name}</strong>
              <small>
                {formatMoney(
                  store.goals.find((goal) => goal.id === confirmAction.goalId)?.currentValue ?? 0,
                  context.currency,
                  privateMode,
                )}{' '}
                assigned
              </small>
            </div>
            <div className="og-dialog__footer">
              <span />
              <button
                className="og-button og-button--quiet"
                onClick={() => setConfirmAction(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="og-button og-button--primary"
                onClick={confirmLifecycle}
                type="button"
              >
                {confirmAction.action === 'archive' ? 'Archive goal' : 'Restore goal'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
