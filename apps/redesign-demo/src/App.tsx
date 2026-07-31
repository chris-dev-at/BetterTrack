import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  activities,
  assetRows,
  destinationItems,
  holdings,
  portfolioTabs,
  scopes,
  upcomingItems,
  type Destination,
  type PortfolioTab,
  type Scope,
} from './demoData';
import { Icon, type IconName } from './Icons';
import { DeveloperPage } from './OriginDeveloper';
import {
  OriginAutomation,
  type OriginAutomationActivity,
  type OriginAutomationProposal,
} from './OriginAutomation';
import { OriginAnalytics } from './OriginAnalytics';
import { OriginCollaboration, type OriginCollaborationProposal } from './OriginCollaboration';
import { OriginContinuity } from './OriginContinuity';
import {
  createOriginSeedConnections,
  OriginConnections,
  type OriginConnectionChange,
  type OriginConnectionRecord,
} from './OriginConnections';
import { OriginDataHealth } from './OriginDataHealth';
import { OriginDataManagement } from './OriginDataManagement';
import { OriginDocuments } from './OriginDocuments';
import { OriginFirstRun, type OriginFirstRunResult } from './OriginFirstRun';
import { OriginImportFlow, type OriginImportResult } from './OriginImportFlow';
import {
  OriginCashFlowFlow,
  type OriginCashFlowResult,
  OriginPortfolioCreateFlow,
  type OriginPortfolioResult,
  type OriginAsset,
  OriginTradeFlow,
  type OriginTradeResult,
} from './OriginFlows';
import { OriginGoals } from './OriginGoals';
import {
  applyOriginPrivateMarketsReviewDecision,
  OriginPrivateMarkets,
} from './OriginPrivateMarkets';
import { OriginPortfolioEvents } from './OriginPortfolioEvents';
import {
  applyOriginPortfolioSettingsReviewDecision,
  OriginPortfolioSettings,
} from './OriginPortfolioSettings';
import { OriginRebalance } from './OriginRebalance';
import {
  applyOriginStructureMutation,
  createOriginStructureSeedGraph,
  OriginPortfolioStructure,
  type OriginStructureMutation,
} from './OriginPortfolioStructure';
import {
  OriginReviewCenter,
  type OriginReviewEntry,
  type OriginReviewKind,
  type OriginReviewReceipt,
} from './OriginReviewCenter';
import { OriginSecurity, type OriginSecurityDeletedReceipt } from './OriginSecurity';
import { OriginShareFlow, type OriginShareResult } from './OriginShareFlow';
import { OriginTax } from './OriginTax';
import { rememberAccessibleDialogTrigger, useAccessibleDialog } from './useAccessibleDialog';
import './origin-share-flow.css';
import {
  AdminSurface,
  AdvisorSurface,
  AuthSurface,
  DemoMenu,
  type DesignDirection,
  OnboardingSurface,
  PreviewDock,
  PublicShareSurface,
  SettingsSurface,
  type ProductSurface,
} from './SecondarySurfaces';
import './origin-first-run.css';

type Theme = 'system' | 'dark' | 'light';
type Density = 'comfortable' | 'compact';
type Overlay =
  | 'create'
  | 'customize'
  | 'connections'
  | 'assistant'
  | 'command'
  | 'invite'
  | 'platform'
  | 'demo'
  | 'trade'
  | 'cashflow'
  | 'portfolio-create'
  | 'import'
  | 'review'
  | 'notifications'
  | 'share'
  | 'structure'
  | 'portfolio-settings'
  | 'private-markets'
  | 'events'
  | 'data-health'
  | 'data-management'
  | null;
type CreateKind = 'expense' | 'income' | 'trade' | 'transfer' | 'portfolio' | 'import';
type InviteRole = 'Viewer' | 'Editor' | 'Can propose';
type PendingInvite = {
  email: string;
  role: InviteRole;
  portfolio: string;
};
type DemoActivity = {
  id: string;
  portfolioId?: string;
  portfolioName?: string;
  title: string;
  amount: number;
  detail: string;
  source: string;
  status: string;
  icon: IconName;
  date: string;
};
type DemoNotification = {
  id: string;
  title: string;
  copy: string;
  time: string;
  read: boolean;
  icon: IconName;
};
type WorkbenchView =
  | 'Studio'
  | 'Rebalance'
  | 'Forecasts'
  | 'Blueprints'
  | 'Backtests'
  | 'Compare'
  | 'Ideas'
  | 'Calculators'
  | 'Alerts';
type WorkbenchSecondaryViewName = Exclude<WorkbenchView, 'Studio' | 'Rebalance'>;
type AssetView = 'Overview' | 'Watchlists' | 'Discover' | 'Screener' | 'News' | 'Calendar';
type PeopleView = 'Together' | 'Clients' | 'Teams' | 'Shared with me' | 'Updates';

const moneyFormatter = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
});

const compactMoneyFormatter = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

const numberFormatter = new Intl.NumberFormat('en-IE', {
  maximumFractionDigits: 2,
});

const originEventCashDeltaById: Record<string, number> = {
  event_msft_div_2026q2: 111.29,
  event_unilever_spinoff_2026: 6.33,
  event_vw_capital_2026: 437.86,
};

const initialOriginReviews: OriginReviewEntry[] = [
  {
    id: 'origin-import-july',
    kind: 'import',
    title: 'Approve July Drive import',
    summary: '12 clean activities, one duplicate skipped, and one missing cost basis assumption.',
    portfolio: { id: 'personal', name: 'Personal wealth', path: 'All wealth / Personal wealth' },
    source: {
      label: 'Google Drive · Finance vault',
      detail: 'TR_activity_July.csv · checksum verified',
      actor: 'Import worker',
    },
    requestedAt: '2026-07-27T08:48:00+02:00',
    priority: 'high',
    risk: 'medium',
    affectedCount: 13,
    tags: ['Import', 'Cost basis', 'Drive'],
    diff: [
      {
        label: 'Portfolio activities',
        before: '2,148 records',
        after: '2,160 records',
        tone: 'positive',
      },
      { label: 'Duplicates', before: '1 candidate', after: 'Skip exact match', tone: 'neutral' },
      {
        label: 'Microsoft cost basis',
        before: 'Missing',
        after: '€364.18 from statement',
        tone: 'warning',
      },
    ],
    calculations: [
      { label: 'Cash impact', value: '−€482.16', detail: 'Buys, income, and fees netted' },
      { label: 'Portfolio impact', value: '+€16.74', detail: 'Income less explicit fees' },
      { label: 'Tax records', value: '3 lots', detail: 'One assumption highlighted' },
    ],
    lineage: [
      {
        label: 'File received',
        detail: 'Private Drive folder · content hash f9a8…31c',
        at: '08:47',
        state: 'external',
      },
      {
        label: 'Dry run completed',
        detail: '13 rows mapped against existing activity',
        at: '08:48',
        state: 'verified',
      },
    ],
    permissions: [
      { label: 'Read Drive file', detail: 'Granted to import connection', outcome: 'allowed' },
      { label: 'Write portfolio activity', detail: 'Owner review required', outcome: 'review' },
    ],
    policies: [
      {
        title: 'No silent external writes',
        description: 'The import is staged until an owner approves the exact diff.',
        status: 'pass',
      },
      {
        title: 'Cost basis completeness',
        description: 'One statement-derived basis should be verified.',
        status: 'warning',
      },
    ],
  },
  {
    id: 'origin-ai-dca',
    kind: 'ai',
    title: 'Start a €200 monthly VWCE proposal',
    summary: 'Ask BetterTrack drafted a reviewed automation from the ten-year scenario.',
    portfolio: 'Personal wealth',
    source: { label: 'Ask BetterTrack', actor: 'Alex Morgan', detail: 'Read + propose access' },
    requestedAt: '2026-07-27T07:54:00+02:00',
    priority: 'normal',
    risk: 'medium',
    tags: ['AI proposal', 'DCA', 'Automation'],
    diff: [
      { label: 'Automation', before: 'None', after: '€200 monthly into VWCE' },
      { label: 'Funding', before: 'Unallocated cash', after: 'Cash · Personal wealth' },
      { label: 'Review mode', before: '—', after: 'Approve each run' },
    ],
    calculations: [
      { label: 'Ten-year contributions', value: '€24,000' },
      { label: 'Median modeled value', value: '€33,840', tone: 'positive' },
      { label: 'Lowest cash buffer', value: '4.7 months', tone: 'warning' },
    ],
    lineage: [
      {
        label: 'Scenario source',
        detail: 'Workbench · DCA comparison v3',
        state: 'derived',
      },
      { label: 'AI scope', detail: 'Personal wealth only · no direct write', state: 'verified' },
    ],
    permissions: [
      { label: 'Read holdings and cash', outcome: 'allowed' },
      { label: 'Create a proposal', outcome: 'allowed' },
      { label: 'Activate automation', outcome: 'review' },
    ],
    policies: [
      {
        title: 'Cash buffer',
        description: 'The modeled minimum remains above the four-month policy.',
        status: 'pass',
      },
    ],
  },
  {
    id: 'origin-property-proposal',
    kind: 'collaboration',
    title: 'Mia proposed a property value update',
    summary: 'Replace the Riverside valuation using an attached independent assessment.',
    portfolio: 'Riverside property',
    source: { label: 'Collaborator proposal', actor: 'Mia Keller', detail: 'Can propose role' },
    requestedAt: '2026-07-27T06:42:00+02:00',
    priority: 'normal',
    risk: 'low',
    tags: ['Shared', 'Valuation', 'Document'],
    diff: [
      {
        label: 'Property value',
        before: '€138,400',
        after: '€144,900',
        tone: 'positive',
        detail: '+4.70%',
      },
    ],
    calculations: [
      { label: 'All wealth impact', value: '+€6,500', tone: 'positive' },
      { label: 'Mia ownership view', value: '+€3,250' },
    ],
    lineage: [{ label: 'Evidence', detail: 'Valuation_July_2026.pdf · signed', state: 'external' }],
    permissions: [
      { label: 'Propose valuation', outcome: 'allowed' },
      { label: 'Apply owner change', outcome: 'review' },
    ],
    policies: [
      {
        title: 'Independent evidence',
        description: 'A signed valuation is attached.',
        status: 'pass',
      },
    ],
  },
  {
    id: 'origin-oauth-expiry',
    kind: 'oauth',
    title: 'Portfolio Lens requests write access',
    summary: 'A connected analysis app wants to propose activities in one portfolio.',
    portfolio: 'Personal wealth',
    source: {
      label: 'OAuth consent',
      detail: 'client_7d21 · PKCE · verified redirect',
      actor: 'Portfolio Lens',
    },
    requestedAt: '2026-07-26T21:12:00+02:00',
    priority: 'high',
    risk: 'high',
    tags: ['OAuth', 'Developer', 'Permission'],
    diff: [
      { label: 'Current scope', before: 'portfolio:read', after: 'portfolio:read' },
      {
        label: 'Requested scope',
        before: 'None',
        after: 'activity:propose',
        tone: 'warning',
      },
    ],
    permissions: [
      { label: 'Read portfolio summary', outcome: 'allowed' },
      { label: 'Propose activity', outcome: 'review' },
      { label: 'Execute trades', outcome: 'blocked' },
    ],
    policies: [
      {
        title: 'Redirect URI verified',
        description: 'The request matches the registered HTTPS callback.',
        status: 'pass',
      },
      {
        title: 'Elevated permission',
        description: 'Proposal access requires explicit owner consent.',
        status: 'warning',
      },
    ],
  },
  {
    id: 'origin-tax-basis',
    kind: 'tax',
    title: 'Resolve missing Bitcoin cost basis',
    summary: 'A 2021 inbound transfer has no acquisition price and blocks the final tax report.',
    portfolio: 'Personal wealth',
    source: 'Tax Center · Austria 2026',
    requestedAt: '2026-07-26T16:32:00+02:00',
    priority: 'urgent',
    risk: 'high',
    tags: ['Tax', 'Missing basis', 'Report blocker'],
    diff: [{ label: 'BTC lot basis', before: 'Unknown', after: 'Needs document', tone: 'warning' }],
    calculations: [
      { label: 'Affected units', value: '0.1842 BTC' },
      { label: 'Provisional gain', value: '€7,840', tone: 'warning' },
    ],
    lineage: [{ label: 'Transfer', detail: 'External wallet · 18 Oct 2021', state: 'external' }],
    permissions: [{ label: 'Finalize tax report', outcome: 'blocked' }],
    policies: [
      {
        title: 'Basis evidence required',
        description: 'Attach a statement or explicitly accept a documented estimate.',
        status: 'blocked',
      },
    ],
  },
];

function originAssetFromRow(asset: (typeof assetRows)[number]): OriginAsset {
  const currency = asset.price.startsWith('$') ? 'USD' : 'EUR';
  return {
    symbol: asset.symbol,
    name: asset.name,
    price: Number(asset.price.replace(/[^\d.]/g, '').replaceAll(',', '')) || 100,
    currency,
    venue: asset.symbol === 'BTC' ? 'CRYPTO' : currency === 'USD' ? 'NASDAQ' : 'XETRA',
    change: asset.change,
  };
}

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const stored = window.localStorage.getItem(key);
    if (!stored) return initial;
    try {
      return JSON.parse(stored) as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn('brand', compact && 'brand--compact')} aria-label="BetterTrack Web">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact && (
        <span className="brand-name">
          Better<span>Track</span>
          <small className="brand-edition">Web</small>
        </span>
      )}
    </div>
  );
}

function Money({
  value,
  privateMode,
  compact = false,
  showPlus = false,
}: {
  value: number;
  privateMode: boolean;
  compact?: boolean;
  showPlus?: boolean;
}) {
  if (privateMode) return <span className="redacted-value">••••••</span>;
  const formatted = (compact ? compactMoneyFormatter : moneyFormatter).format(Math.abs(value));
  return (
    <>
      {value < 0 ? '−' : showPlus && value > 0 ? '+' : ''}
      {formatted}
    </>
  );
}

function Avatar({
  initials,
  tone = 'sand',
  size = 'md',
}: {
  initials: string;
  tone?: 'sand' | 'sage' | 'blue' | 'rose' | 'ink';
  size?: 'sm' | 'md' | 'lg';
}) {
  return <span className={cn('avatar', `avatar--${tone}`, `avatar--${size}`)}>{initials}</span>;
}

function AvatarStack({ extra }: { extra?: number }) {
  return (
    <span className="avatar-stack" aria-label="Portfolio collaborators">
      <Avatar initials="AM" tone="sand" size="sm" />
      <Avatar initials="MK" tone="sage" size="sm" />
      <Avatar initials="JL" tone="blue" size="sm" />
      {extra ? <span className="avatar avatar--sm avatar--ink">+{extra}</span> : null}
    </span>
  );
}

function Button({
  children,
  icon,
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}) {
  return (
    <button
      className={cn('button', `button--${variant}`, `button--${size}`, className)}
      type="button"
      {...props}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} /> : null}
      {children}
    </button>
  );
}

function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="section-heading__action">{action}</div> : null}
    </div>
  );
}

function StatusDot({ tone = 'green' }: { tone?: 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={cn('status-dot', `status-dot--${tone}`)} />;
}

function MiniSparkline({
  values,
  positive = true,
  width = 94,
  height = 32,
}: {
  values: number[];
  positive?: boolean;
  width?: number;
  height?: number;
}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 3 - ((value - min) / span) * (height - 6);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg className="mini-sparkline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        fill="none"
        points={points}
        stroke={positive ? 'var(--positive)' : 'var(--negative)'}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function expandChartSeries(values: number[], density = 9) {
  if (values.length < 2) return values;
  const expanded: number[] = [];
  const range = Math.max(...values) - Math.min(...values);
  const noiseScale = Math.max(range * 0.016, values[0]! * 0.0012);

  for (let segment = 0; segment < values.length - 1; segment += 1) {
    const start = values[segment]!;
    const end = values[segment + 1]!;
    for (let step = 0; step < density; step += 1) {
      const progress = step / density;
      const trend = start + (end - start) * progress;
      const envelope = Math.sin(progress * Math.PI);
      const microMove =
        Math.sin((segment * density + step) * 1.73) * 0.52 +
        Math.sin((segment * density + step) * 0.47) * 0.31 +
        Math.cos((segment * density + step) * 2.61) * 0.17;
      expanded.push(trend + microMove * noiseScale * envelope);
    }
  }
  expanded.push(values[values.length - 1]!);
  return expanded;
}

function chartSeriesForRange(values: number[], range: string) {
  const factorByRange: Record<string, number> = {
    '1W': 0.24,
    '1M': 0.42,
    '3M': 0.7,
    '1Y': 1,
    ALL: 1.32,
  };
  const factor = factorByRange[range] ?? 0.42;
  const last = values[values.length - 1] ?? 0;
  return values.map((value, index) => {
    const progress = index / Math.max(1, values.length - 1);
    const periodTexture = Math.sin(index * 1.91) * last * 0.002 * factor * (1 - progress);
    return last + (value - last) * factor + periodTexture;
  });
}

function buildProjectionSeries(
  startingValue: number,
  annualReturn: number,
  monthlyContribution: number,
  months = 120,
) {
  const values = [startingValue];
  for (let month = 1; month <= months; month += 1) {
    const previous = values[month - 1]!;
    const texture = Math.sin(month * 1.83) * previous * 0.0007;
    values.push(previous * (1 + annualReturn / 12) + monthlyContribution + texture);
  }
  return values;
}

function WealthChart({
  values,
  color = 'var(--chart-neutral)',
  privateMode,
  height = 246,
  detailed = false,
  range = '1M',
}: {
  values: number[];
  color?: string;
  privateMode: boolean;
  height?: number;
  detailed?: boolean;
  range?: string;
}) {
  const gradientId = useId();
  const rangedValues = chartSeriesForRange(values, range);
  const chartValues = detailed ? expandChartSeries(rangedValues) : rangedValues;
  const svgRef = useRef<SVGSVGElement>(null);
  const [activeIndex, setActiveIndex] = useState(chartValues.length - 1);
  const width = 960;
  const padX = detailed ? 18 : 8;
  const padY = detailed ? 24 : 18;
  const min = Math.min(...chartValues);
  const max = Math.max(...chartValues);
  const span = max - min || 1;
  const chartHeight = detailed ? 320 : 250;
  const points = chartValues.map((value, index) => ({
    x: padX + (index / (chartValues.length - 1)) * (width - padX * 2),
    y: chartHeight - padY - ((value - min) / span) * (chartHeight - padY * 2),
    value,
  }));
  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
  const area = `${padX},${chartHeight - padY} ${polyline} ${width - padX},${chartHeight - padY}`;
  const active = points[activeIndex] ?? points[points.length - 1]!;

  function handleMove(event: ReactMouseEvent<SVGSVGElement>) {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setActiveIndex(Math.round(ratio * (chartValues.length - 1)));
  }

  const intervalByRange: Record<string, number> = {
    '1W': 45,
    '1M': 180,
    '3M': 720,
    '1Y': 2880,
    ALL: 28800,
  };
  const date = new Date(2026, 6, 27);
  date.setMinutes(
    date.getMinutes() -
      (chartValues.length - 1 - activeIndex) * (detailed ? (intervalByRange[range] ?? 180) : 1440),
  );
  const investedPoints = points.map((point, index) => {
    const progress = index / (points.length - 1);
    const investedValue = min + span * (0.08 + progress * 0.55);
    const y = chartHeight - padY - ((investedValue - min) / span) * (chartHeight - padY * 2);
    return `${point.x},${Math.max(padY, Math.min(chartHeight - padY, y))}`;
  });
  const eventIndexes = detailed
    ? [
        [Math.round(chartValues.length * 0.22), 'Deposit'],
        [Math.round(chartValues.length * 0.57), 'Dividend'],
        [Math.round(chartValues.length * 0.82), 'Valuation'],
      ]
    : [];

  return (
    <div className={cn('wealth-chart', detailed && 'wealth-chart--detailed')} style={{ height }}>
      <div
        className={cn(
          'chart-tooltip',
          activeIndex === chartValues.length - 1 && 'chart-tooltip--end',
        )}
        style={{ left: `${(active.x / width) * 100}%` }}
      >
        <span>
          {date.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            ...(detailed ? { hour: '2-digit', minute: '2-digit' } : {}),
          })}
        </span>
        <strong>
          {privateMode ? '••••••' : compactMoneyFormatter.format(active.value * 1000)}
        </strong>
      </div>
      <svg
        ref={svgRef}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${chartHeight}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setActiveIndex(chartValues.length - 1)}
        aria-label="Portfolio value over the selected period"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity=".24" />
            <stop offset="72%" stopColor={color} stopOpacity=".04" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="chart-grid">
          {(detailed
            ? Array.from({ length: 6 }, (_, index) => padY + index * ((chartHeight - padY * 2) / 5))
            : [45, 110, 175, 232]
          ).map((y) => (
            <line key={`h-${y}`} x1="0" x2={width} y1={y} y2={y} />
          ))}
          {detailed
            ? [160, 320, 480, 640, 800].map((x) => (
                <line key={`v-${x}`} x1={x} x2={x} y1={padY} y2={chartHeight - padY} />
              ))
            : null}
        </g>
        {detailed ? (
          <g className="chart-volume">
            {points
              .filter((_, index) => index % 3 === 0)
              .map((point, index) => {
                const barHeight = 4 + ((index * 17) % 16);
                return (
                  <rect
                    height={barHeight}
                    key={`volume-${point.x}`}
                    width="2"
                    x={point.x}
                    y={chartHeight - padY - barHeight}
                  />
                );
              })}
          </g>
        ) : null}
        <polygon fill={`url(#${gradientId})`} points={area} />
        {detailed ? (
          <polyline
            className="chart-invested-line"
            fill="none"
            points={investedPoints.join(' ')}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <polyline
          fill="none"
          points={polyline}
          stroke={color}
          strokeLinecap={detailed ? 'butt' : 'round'}
          strokeLinejoin={detailed ? 'miter' : 'round'}
          strokeWidth={detailed ? '1.7' : '3'}
          vectorEffect="non-scaling-stroke"
        />
        {eventIndexes.map(([index, label]) => {
          const point = points[Number(index)]!;
          return (
            <g className="chart-event" key={label}>
              <line x1={point.x} x2={point.x} y1={point.y + 7} y2={chartHeight - padY} />
              <circle cx={point.x} cy={point.y} r="3.5" />
              <text x={point.x + 6} y={Math.max(19, point.y - 8)}>
                {label}
              </text>
            </g>
          );
        })}
        {detailed
          ? [max, max - span * 0.25, max - span * 0.5, max - span * 0.75, min].map(
              (value, index) => (
                <text
                  className="chart-y-label"
                  key={`axis-${value}`}
                  textAnchor="end"
                  x={width - 5}
                  y={padY + index * ((chartHeight - padY * 2) / 4)}
                >
                  {privateMode ? '•••' : compactMoneyFormatter.format(value * 1000)}
                </text>
              ),
            )
          : null}
        <line className="chart-cursor" x1={active.x} x2={active.x} y1="18" y2={chartHeight - 18} />
        <circle
          cx={active.x}
          cy={active.y}
          fill="var(--surface-strong)"
          r={detailed ? 3.5 : 6}
          stroke={color}
        />
      </svg>
      <div className="chart-axis">
        {(detailed
          ? ({
              '1W': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Today'],
              '1M': ['27 Jun', '04 Jul', '11 Jul', '18 Jul', '24 Jul', 'Today'],
              '3M': ['May', '01 Jun', '21 Jun', '08 Jul', '21 Jul', 'Today'],
              '1Y': ['Aug', 'Oct', 'Jan', 'Mar', 'May', 'Today'],
              ALL: ['2019', '2020', '2022', '2024', '2025', 'Today'],
            }[range] ?? ['27 Jun', '04 Jul', '11 Jul', '18 Jul', '24 Jul', 'Today'])
          : ['04 Jul', '11 Jul', '18 Jul', 'Today']
        ).map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function DetailedAssetChart({
  values,
  price,
  change,
  positive,
  privateMode,
  range,
}: {
  values: number[];
  price: string;
  change: number;
  positive: boolean;
  privateMode: boolean;
  range: string;
}) {
  const gradientId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const numericPrice = Number(price.replace(/[^\d.]/g, '').replaceAll(',', '')) || 100;
  const currency = price.trim().startsWith('$') ? '$' : '€';
  const scaleByRange: Record<string, number> = {
    '1D': 0.1,
    '1W': 0.18,
    '1M': 0.34,
    '1Y': 0.78,
    ALL: 1.12,
  };
  const chartValues = useMemo(() => {
    const last = values[values.length - 1] ?? 1;
    const scale = scaleByRange[range] ?? 0.34;
    const anchors = values.map((value) => numericPrice * (1 + ((value - last) / last) * scale));
    return expandChartSeries(anchors, 26);
  }, [numericPrice, range, values]);
  const [activeIndex, setActiveIndex] = useState(chartValues.length - 1);
  const width = 940;
  const height = 258;
  const pad = { top: 21, right: 64, bottom: 24, left: 12 };
  const minValue = Math.min(...chartValues);
  const maxValue = Math.max(...chartValues);
  const valueSpan = maxValue - minValue || 1;
  const points = chartValues.map((value, index) => ({
    value,
    x: pad.left + (index / (chartValues.length - 1)) * (width - pad.left - pad.right),
    y: pad.top + ((maxValue - value) / valueSpan) * (height - pad.top - pad.bottom),
  }));
  const active = points[activeIndex] ?? points[points.length - 1]!;
  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
  const baseline = numericPrice / (1 + change / 100);
  const baselineY = Math.max(
    pad.top,
    Math.min(
      height - pad.bottom,
      pad.top + ((maxValue - baseline) / valueSpan) * (height - pad.top - pad.bottom),
    ),
  );
  const rangeLabels: Record<string, string[]> = {
    '1D': ['09:00', '10:30', '12:00', '13:30', '15:00', 'Now'],
    '1W': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Now'],
    '1M': ['27 Jun', '04 Jul', '11 Jul', '18 Jul', '24 Jul', 'Today'],
    '1Y': ['Aug', 'Oct', 'Jan', 'Mar', 'May', 'Today'],
    ALL: ['2019', '2020', '2022', '2024', '2025', 'Today'],
  };

  function formatPrice(value: number) {
    if (privateMode) return '••••';
    return `${currency}${value.toLocaleString('en-IE', {
      maximumFractionDigits: numericPrice > 1000 ? 0 : 2,
      minimumFractionDigits: numericPrice > 1000 ? 0 : 2,
    })}`;
  }

  function handleMove(event: ReactMouseEvent<SVGSVGElement>) {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setActiveIndex(Math.round(ratio * (chartValues.length - 1)));
  }

  return (
    <div className={cn('asset-chart-detailed', positive ? 'is-positive' : 'is-negative')}>
      <div
        className={cn(
          'asset-chart-tooltip',
          activeIndex > chartValues.length * 0.82 && 'asset-chart-tooltip--end',
        )}
        style={{ left: `${(active.x / width) * 100}%` }}
      >
        <span>{range === '1D' ? 'Today, 14:42' : '18 Jul 2026'}</span>
        <strong>{formatPrice(active.value)}</strong>
        <em>{active.value >= baseline ? '+' : '−'}1.08%</em>
      </div>
      <svg
        aria-label={`Detailed ${range} asset price chart with ${chartValues.length} data points`}
        onMouseLeave={() => setActiveIndex(chartValues.length - 1)}
        onMouseMove={handleMove}
        preserveAspectRatio="none"
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop
              offset="0"
              stopColor={positive ? 'var(--positive)' : 'var(--negative)'}
              stopOpacity=".2"
            />
            <stop
              offset="1"
              stopColor={positive ? 'var(--positive)' : 'var(--negative)'}
              stopOpacity="0"
            />
          </linearGradient>
        </defs>
        <g className="asset-chart-grid">
          {[21, 63, 105, 147, 189, 231].map((y) => (
            <line key={`y-${y}`} x1={pad.left} x2={width - pad.right} y1={y} y2={y} />
          ))}
          {[157, 302, 447, 592, 737].map((x) => (
            <line key={`x-${x}`} x1={x} x2={x} y1={pad.top} y2={height - pad.bottom} />
          ))}
        </g>
        <g className="asset-chart-volume">
          {points
            .filter((_, index) => index % 3 === 0)
            .map((point, index) => {
              const barHeight = 3 + ((index * 11) % 15);
              return (
                <rect
                  height={barHeight}
                  key={`volume-${point.x}`}
                  width="2"
                  x={point.x}
                  y={height - pad.bottom - barHeight}
                />
              );
            })}
        </g>
        <polygon
          fill={`url(#${gradientId})`}
          points={`${pad.left},${height - pad.bottom} ${polyline} ${width - pad.right},${
            height - pad.bottom
          }`}
        />
        <line
          className="asset-chart-baseline"
          x1={pad.left}
          x2={width - pad.right}
          y1={baselineY}
          y2={baselineY}
        />
        <polyline
          className="asset-chart-line"
          fill="none"
          points={polyline}
          vectorEffect="non-scaling-stroke"
        />
        {[0.36, 0.71].map((position, index) => {
          const point = points[Math.round((points.length - 1) * position)]!;
          return (
            <g className="asset-chart-event" key={position}>
              <circle cx={point.x} cy={point.y} r="3.5" />
              <text x={point.x + 6} y={Math.max(17, point.y - 8)}>
                {index === 0 ? 'D' : 'E'}
              </text>
            </g>
          );
        })}
        {[
          maxValue,
          maxValue - valueSpan * 0.25,
          maxValue - valueSpan * 0.5,
          maxValue - valueSpan * 0.75,
          minValue,
        ].map((value, index) => (
          <text
            className="asset-chart-price-label"
            key={`${value}-${index}`}
            textAnchor="end"
            x={width - 4}
            y={pad.top + index * ((height - pad.top - pad.bottom) / 4) + 3}
          >
            {formatPrice(value)}
          </text>
        ))}
        <line
          className="asset-chart-cursor"
          x1={active.x}
          x2={active.x}
          y1={pad.top}
          y2={height - pad.bottom}
        />
        <circle
          className="asset-chart-point"
          cx={active.x}
          cy={active.y}
          r="3.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="asset-chart-axis">
        {(rangeLabels[range] ?? rangeLabels['1M']!).map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function ScenarioProjectionChart({
  startingValue,
  monthly,
  privateMode,
  annualReturn,
  durationYears,
}: {
  startingValue: number;
  monthly: number;
  privateMode: boolean;
  annualReturn: number;
  durationYears: number;
}) {
  const gradientId = useId();
  const width = 900;
  const height = 300;
  const pad = { top: 24, right: 70, bottom: 28, left: 8 };
  const months = durationYears * 12;
  const base = buildProjectionSeries(startingValue, 0.045, 0, months);
  const scenario = buildProjectionSeries(startingValue, annualReturn, monthly, months);
  const low = buildProjectionSeries(
    startingValue,
    Math.max(0.005, annualReturn - 0.03),
    monthly,
    months,
  );
  const high = buildProjectionSeries(startingValue, annualReturn + 0.025, monthly, months);
  const max = Math.max(...high) * 1.02;
  const min = startingValue * 0.97;
  const span = max - min;
  const toPoints = (series: number[]) =>
    series.map((value, index) => ({
      value,
      x: pad.left + (index / months) * (width - pad.left - pad.right),
      y: pad.top + ((max - value) / span) * (height - pad.top - pad.bottom),
    }));
  const basePoints = toPoints(base);
  const scenarioPoints = toPoints(scenario);
  const lowPoints = toPoints(low);
  const highPoints = toPoints(high);
  const line = (points: Array<{ x: number; y: number }>) =>
    points.map((point) => `${point.x},${point.y}`).join(' ');
  const uncertaintyArea = `${line(highPoints)} ${[...lowPoints]
    .reverse()
    .map((point) => `${point.x},${point.y}`)
    .join(' ')}`;

  return (
    <div className="projection-chart projection-chart--detailed">
      <svg
        aria-label={`Detailed ${durationYears} year scenario projection with ${months + 1} monthly data points`}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity=".16" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity=".015" />
          </linearGradient>
        </defs>
        <g className="chart-grid">
          {[40, 92, 144, 196, 248].map((y) => (
            <line key={`h-${y}`} x1={pad.left} x2={width - pad.right} y1={y} y2={y} />
          ))}
          {[164, 328, 492, 656, 820].map((x) => (
            <line key={`v-${x}`} x1={x} x2={x} y1={pad.top} y2={height - pad.bottom} />
          ))}
        </g>
        <polygon
          className="projection-range"
          fill={`url(#${gradientId})`}
          points={uncertaintyArea}
        />
        <polyline
          className="projection-low"
          fill="none"
          points={line(lowPoints)}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          className="projection-high"
          fill="none"
          points={line(highPoints)}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          className="projection-base"
          fill="none"
          points={line(basePoints)}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          className="projection-new"
          fill="none"
          points={line(scenarioPoints)}
          vectorEffect="non-scaling-stroke"
        />
        {scenarioPoints
          .filter((_, index) => index % 12 === 0)
          .map((point, index) => (
            <circle
              className="projection-year-point"
              cx={point.x}
              cy={point.y}
              key={`year-${index}`}
              r="2.5"
            />
          ))}
        {[max, max - span * 0.25, max - span * 0.5, max - span * 0.75, min].map((value, index) => (
          <text
            className="chart-y-label"
            key={`scenario-axis-${value}`}
            textAnchor="end"
            x={width - 3}
            y={pad.top + index * ((height - pad.top - pad.bottom) / 4)}
          >
            {privateMode ? '•••' : compactMoneyFormatter.format(value)}
          </text>
        ))}
      </svg>
      <div>
        {Array.from({ length: 6 }, (_, index) =>
          index === 0 ? 'Today' : String(2026 + Math.round((durationYears * index) / 5)),
        ).map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function Sidebar({
  destination,
  direction,
  onDestination,
  reviewCount,
  privateMode,
  onPrivateMode,
  onOverlay,
  onAccount,
}: {
  destination: Destination;
  direction: DesignDirection;
  onDestination: (destination: Destination) => void;
  reviewCount: number;
  privateMode: boolean;
  onPrivateMode: () => void;
  onOverlay: (overlay: Overlay) => void;
  onAccount: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <Brand />
        {direction !== 'origin' ? <span className="concept-badge">{direction}</span> : null}
      </div>

      <nav className="suite-nav" aria-label="Suite navigation">
        {direction !== 'origin' ? <span className="suite-nav__group">Workspace</span> : null}
        {destinationItems
          .filter((item) => item.id !== 'developer' && item.id !== 'people')
          .map((item) => (
            <button
              className={cn('suite-nav__item', destination === item.id && 'is-active')}
              key={item.id}
              onClick={() => onDestination(item.id)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>
                <strong>{item.label}</strong>
                {direction !== 'origin' ? <small>{item.hint}</small> : null}
              </span>
            </button>
          ))}
        {direction !== 'origin' ? <span className="suite-nav__group">Collaboration</span> : null}
        {destinationItems
          .filter((item) => item.id === 'people')
          .map((item) => (
            <button
              className={cn('suite-nav__item', destination === item.id && 'is-active')}
              key={item.id}
              onClick={() => onDestination(item.id)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>
                <strong>{item.label}</strong>
                {direction !== 'origin' ? <small>{item.hint}</small> : null}
              </span>
            </button>
          ))}
      </nav>

      <div className="sidebar__rule" />

      <div className="sidebar__utilities">
        <button type="button" onClick={() => onOverlay('assistant')}>
          <Icon name="ai" />
          <span>Ask BetterTrack</span>
          <kbd>⌘J</kbd>
        </button>
        <button type="button" onClick={() => onOverlay('review')}>
          <Icon name="inbox" />
          <span>Review</span>
          {reviewCount ? <em>{reviewCount}</em> : <Icon name="check" size={15} />}
        </button>
        {direction === 'origin' ? (
          <button type="button" onClick={() => onOverlay('platform')}>
            <Icon name="grid" />
            <span>Control center</span>
            <Icon name="chevron-right" size={14} />
          </button>
        ) : (
          <button type="button" onClick={() => onOverlay('connections')}>
            <Icon name="link" />
            <span>Connections</span>
            <StatusDot />
          </button>
        )}
      </div>

      {direction !== 'origin' ? (
        <button className="assistant-callout" type="button" onClick={() => onOverlay('assistant')}>
          <span className="assistant-callout__icon">
            <Icon name="sparkles" size={17} />
          </span>
          <span>
            <small>Portfolio brief</small>
            <strong>Why did I gain €5,284?</strong>
          </span>
          <Icon name="arrow-right" size={15} />
        </button>
      ) : null}

      <div className="sidebar__bottom">
        <button
          className="privacy-button"
          type="button"
          onClick={onPrivateMode}
          aria-pressed={privateMode}
        >
          <Icon name={privateMode ? 'eye-off' : 'eye'} />
          <span>{privateMode ? 'Reveal values' : 'Discreet mode'}</span>
        </button>
        <button className="account-button" type="button" onClick={onAccount}>
          <Avatar initials="AM" tone="sand" />
          <span>
            <strong>Alex Morgan</strong>
            {direction !== 'origin' ? <small>Personal workspace</small> : null}
          </span>
          <Icon name="more" />
        </button>
      </div>
    </aside>
  );
}

function ScopeMenu({
  scope,
  options,
  onScope,
  open,
  onOpen,
  privateMode,
  onCreate,
  onSettings,
}: {
  scope: Scope;
  options: Scope[];
  onScope: (scope: Scope) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  privateMode: boolean;
  onCreate: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="scope-control">
      <button
        className={cn('scope-button', open && 'is-open')}
        type="button"
        onClick={() => onOpen(!open)}
        aria-expanded={open}
      >
        <span className="scope-button__icon" style={{ '--scope-color': scope.accent } as never}>
          <Icon name={scope.icon} size={16} />
        </span>
        <span>
          <strong>{scope.name}</strong>
        </span>
        <Icon name="chevron-down" size={15} />
      </button>
      {open ? (
        <>
          <button
            aria-label="Close portfolio scope"
            className="popover-scrim"
            onClick={() => onOpen(false)}
            type="button"
          />
          <div className="scope-popover">
            <div className="scope-popover__header">
              <span>
                <strong>Portfolios</strong>
              </span>
              <Button
                variant="quiet"
                size="icon"
                aria-label="Scope settings"
                onClick={() => {
                  onOpen(false);
                  onSettings();
                }}
              >
                <Icon name="sliders" size={16} />
              </Button>
            </div>
            <div className="scope-popover__search">
              <Icon name="search" size={15} />
              <input aria-label="Find a portfolio" placeholder="Find portfolio or saved scope…" />
            </div>
            <div className="scope-popover__list">
              {options.map((item, index) => (
                <button
                  className={cn('scope-option', scope.id === item.id && 'is-active')}
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onScope(item);
                    onOpen(false);
                  }}
                >
                  <span
                    className="scope-option__icon"
                    style={{ '--scope-color': item.accent } as never}
                  >
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.eyebrow}</small>
                  </span>
                  <span className="scope-option__value">
                    <strong>
                      <Money value={item.value} privateMode={privateMode} compact />
                    </strong>
                    {scope.id === item.id ? <Icon name="check" size={15} /> : null}
                  </span>
                  {index === 0 ? <span className="scope-divider" /> : null}
                </button>
              ))}
            </div>
            <button
              className="scope-popover__create"
              onClick={() => {
                onOpen(false);
                onCreate();
              }}
              type="button"
            >
              <Icon name="plus" size={15} />
              Create or combine portfolios
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Topbar({
  scope,
  scopes: scopeOptions,
  onScope,
  onOverlay,
  reviewCount,
  privateMode,
  onPrivateMode,
}: {
  scope: Scope;
  scopes: Scope[];
  onScope: (scope: Scope) => void;
  onOverlay: (overlay: Overlay) => void;
  reviewCount: number;
  privateMode: boolean;
  onPrivateMode: () => void;
}) {
  const [scopeOpen, setScopeOpen] = useState(false);
  return (
    <header className="topbar">
      <button
        className="mobile-brand"
        type="button"
        onClick={() => onOverlay('demo')}
        aria-label="Open demo preview modes"
      >
        <Brand compact />
      </button>
      <ScopeMenu
        scope={scope}
        options={scopeOptions}
        onScope={onScope}
        open={scopeOpen}
        onOpen={setScopeOpen}
        privateMode={privateMode}
        onCreate={() => onOverlay('portfolio-create')}
        onSettings={() => onOverlay('structure')}
      />
      <div className="topbar__actions">
        <button
          className="command-search"
          type="button"
          onClick={(event) => {
            rememberAccessibleDialogTrigger(event.currentTarget);
            onOverlay('command');
          }}
        >
          <Icon name="search" size={16} />
          <span>Search anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <Button
          className="mobile-privacy"
          variant="quiet"
          size="icon"
          onClick={onPrivateMode}
          aria-label="Toggle discreet mode"
        >
          <Icon name={privateMode ? 'eye-off' : 'eye'} />
        </Button>
        <Button
          className="review-button"
          variant="quiet"
          size="icon"
          onClick={() => onOverlay('review')}
          aria-label={`${reviewCount} items need review`}
        >
          <Icon name="inbox" />
          {reviewCount ? <span>{reviewCount}</span> : null}
        </Button>
        <Button
          variant="quiet"
          size="icon"
          aria-label="Notifications"
          onClick={() => onOverlay('notifications')}
        >
          <Icon name="bell" />
          <span className="notification-dot" />
        </Button>
        <Button
          className="global-create"
          variant="primary"
          icon="plus"
          onClick={() => onOverlay('create')}
        >
          Create
        </Button>
      </div>
    </header>
  );
}

function HomePage({
  scope,
  direction,
  privateMode,
  reviewItems,
  onOpenReview,
  onOpenPortfolio,
  onOpenPortfolioTab,
  onOpenWorkbench,
  onOverlay,
  visibleWidgets,
}: {
  scope: Scope;
  direction: DesignDirection;
  privateMode: boolean;
  reviewItems: OriginReviewEntry[];
  onOpenReview: (id?: string) => void;
  onOpenPortfolio: (scope: Scope) => void;
  onOpenPortfolioTab: (tab: PortfolioTab) => void;
  onOpenWorkbench: () => void;
  onOverlay: (overlay: Overlay) => void;
  visibleWidgets: string[];
}) {
  const [range, setRange] = useState('1M');
  const show = (widget: string) => visibleWidgets.includes(widget);
  const detailed = direction === 'origin';
  return (
    <div className="page home-page">
      {detailed ? (
        <h1 className="visually-hidden">Home</h1>
      ) : (
        <div className="page-intro page-intro--home">
          <h1 className="visually-hidden">Home</h1>
          <div className="page-intro__actions">
            <Button variant="quiet" icon="sliders" onClick={() => onOverlay('customize')}>
              Customize
            </Button>
          </div>
        </div>
      )}

      <div className="home-hero-grid">
        <section className={cn('card wealth-card', detailed && 'wealth-card--detailed')}>
          <div className="wealth-card__header">
            <div>
              <span className="metric-label">Net worth</span>
              <div className="hero-value">
                <Money value={scope.value} privateMode={privateMode} />
              </div>
              <div className="hero-change">
                <span className="change-pill change-pill--positive">
                  <Icon name="arrow-up" size={13} />
                  <Money value={scope.change} privateMode={privateMode} compact showPlus />
                  <span>+{numberFormatter.format(scope.changePct)}%</span>
                </span>
                <span>in the last month</span>
              </div>
              {detailed ? (
                <div className="wealth-chart-metrics">
                  <span>
                    <small>Day move</small>
                    <strong className="positive">+0.31%</strong>
                  </span>
                  <span>
                    <small>Net invested</small>
                    <strong>
                      <Money value={514820} privateMode={privateMode} compact />
                    </strong>
                  </span>
                  <span>
                    <small>Total return</small>
                    <strong className="positive">+24.79%</strong>
                  </span>
                  <span>
                    <small>Cash</small>
                    <strong>
                      <Money value={57214} privateMode={privateMode} compact />
                    </strong>
                  </span>
                </div>
              ) : null}
            </div>
            <div className="wealth-chart-controls">
              <div className="range-switcher" aria-label="Chart range">
                {['1W', '1M', '3M', '1Y', 'ALL'].map((item) => (
                  <button
                    className={range === item ? 'is-active' : ''}
                    key={item}
                    type="button"
                    onClick={() => setRange(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              {detailed ? (
                <Button
                  aria-label="Customize dashboard"
                  className="wealth-chart-customize"
                  variant="quiet"
                  size="sm"
                  icon="sliders"
                  onClick={() => onOverlay('customize')}
                >
                  <span>Customize</span>
                </Button>
              ) : null}
            </div>
          </div>
          <WealthChart
            detailed={detailed}
            height={detailed ? 336 : 246}
            values={scope.chart}
            privateMode={privateMode}
            range={range}
          />
          {!detailed ? (
            <div className="wealth-card__footer">
              <span className="metric-label">What moved it</span>
              <button type="button">
                <span className="asset-dot asset-dot--world">V</span>
                Global equity
                <strong>+€2,140</strong>
              </button>
              <button type="button">
                <span className="asset-dot asset-dot--apple">A</span>
                Apple
                <strong>+€906</strong>
              </button>
              <button type="button">
                <Icon name="house" size={14} />
                Property update
                <strong>+€750</strong>
              </button>
              <button className="explain-link" type="button" onClick={() => onOverlay('assistant')}>
                Explain change
                <Icon name="arrow-right" size={13} />
              </button>
            </div>
          ) : null}
        </section>

        {!detailed ? (
          <section className="card portfolio-map-card">
            <div className="card-title-row">
              <div>
                <h2>Portfolio map</h2>
              </div>
              <Button
                variant="quiet"
                size="icon"
                aria-label="Portfolio map options"
                onClick={() => onOverlay('structure')}
              >
                <Icon name="more" />
              </Button>
            </div>
            <button
              className="portfolio-root"
              type="button"
              onClick={() => onOpenPortfolio(scopes[0]!)}
            >
              <span className="portfolio-root__mark">
                <Icon name="layers" />
              </span>
              <span>
                <small>All wealth</small>
                <strong>
                  <Money value={642480.62} privateMode={privateMode} compact />
                </strong>
              </span>
              <span className="tree-connector" />
            </button>
            <div className="portfolio-tree">
              {scopes.slice(1).map((item) => (
                <button key={item.id} type="button" onClick={() => onOpenPortfolio(item)}>
                  <span
                    className="portfolio-tree__icon"
                    style={{ '--scope-color': item.accent } as never}
                  >
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.eyebrow}</small>
                  </span>
                  <span className="portfolio-tree__value">
                    <strong>
                      <Money value={item.value} privateMode={privateMode} compact />
                    </strong>
                    <small className="positive">+{item.changePct}%</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="portfolio-map-card__footer">
              <span>
                <Icon name="layers" size={14} />2 nested portfolios
              </span>
              <button type="button" onClick={() => onOverlay('structure')}>
                Manage structure
                <Icon name="arrow-right" size={13} />
              </button>
            </div>
          </section>
        ) : null}
      </div>

      {show('review') ? (
        <div className="home-middle-grid">
          <section className="card review-card">
            <SectionHeading
              title="Needs your attention"
              action={
                <button className="text-link" onClick={() => onOpenReview()} type="button">
                  Review all ({reviewItems.length}) <Icon name="arrow-right" size={13} />
                </button>
              }
            />
            {reviewItems.length ? (
              <div className="review-list">
                {reviewItems.slice(0, 3).map((item) => (
                  <div className="review-item" key={item.id}>
                    <span
                      className={cn(
                        'review-item__icon',
                        `tone-${item.priority === 'urgent' ? 'red' : item.priority === 'high' ? 'amber' : item.kind === 'collaboration' ? 'green' : 'blue'}`,
                      )}
                    >
                      <Icon
                        name={
                          (
                            {
                              import: 'upload',
                              automation: 'repeat',
                              collaboration: 'people',
                              sync: 'refresh',
                              tax: 'document',
                              oauth: 'link',
                              ai: 'sparkles',
                            } satisfies Record<OriginReviewKind, IconName>
                          )[item.kind]
                        }
                        size={17}
                      />
                    </span>
                    <span className="review-item__content">
                      <strong>{item.title}</strong>
                      <small className="review-item__summary">{item.summary}</small>
                      <em>
                        {typeof item.portfolio === 'string' ? item.portfolio : item.portfolio.name}
                      </em>
                    </span>
                    <Button
                      aria-label="Inspect"
                      className="review-item__open"
                      variant="quiet"
                      size="icon"
                      onClick={() => onOpenReview(item.id)}
                    >
                      <Icon name="chevron-right" size={15} />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="review-empty">
                <span>
                  <Icon name="check" />
                </span>
                <strong>You are all caught up.</strong>
                <p>New imports, approvals, and data issues will appear here.</p>
              </div>
            )}
          </section>

          <section className="card upcoming-card">
            <SectionHeading
              title="Coming up"
              action={
                <button
                  className="icon-text-button"
                  onClick={() => onOverlay('events')}
                  type="button"
                >
                  <Icon name="calendar" size={15} />
                  Calendar
                </button>
              }
            />
            <div className="timeline">
              {upcomingItems.slice(0, 3).map((item) => (
                <div className="timeline__item" key={`${item.date}-${item.title}`}>
                  <span className="timeline__date">{item.date}</span>
                  <span className="timeline__marker">
                    <Icon name={item.icon} size={14} />
                  </span>
                  <span className="timeline__content">
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <strong className={item.amount > 0 ? 'positive' : ''}>
                    <Money
                      value={item.amount}
                      privateMode={privateMode}
                      compact={Math.abs(item.amount) >= 1000}
                      showPlus
                    />
                  </strong>
                </div>
              ))}
            </div>
            <div className="cash-runway">
              <span>
                <small>30-day expected net flow</small>
                <strong>
                  <Money value={1984.66} privateMode={privateMode} showPlus />
                </strong>
              </span>
              <div className="cash-runway__bar">
                <i />
              </div>
              <span className="cash-runway__status">Healthy buffer</span>
            </div>
          </section>
        </div>
      ) : null}

      {show('allocation') || show('cashflow') || show('brief') ? (
        <div className="home-bottom-grid">
          {show('allocation') ? (
            <section className="card allocation-card">
              <SectionHeading
                title="Allocation"
                action={
                  <button
                    className="icon-text-button"
                    onClick={() => onOpenPortfolioTab('analysis')}
                    type="button"
                  >
                    <Icon name="filter" size={14} />
                    Asset class
                  </button>
                }
              />
              <div className="allocation-content">
                <div className="donut" aria-label="Portfolio allocation chart">
                  <div>
                    <small>Invested</small>
                    <strong>88.4%</strong>
                  </div>
                </div>
                <div className="allocation-legend">
                  {[
                    ['Public markets', '46.8%', '#d1b57f'],
                    ['Private business', '24.2%', '#7e9d91'],
                    ['Property', '17.5%', '#8492aa'],
                    ['Cash', '8.9%', '#d9d0bc'],
                    ['Other', '2.6%', '#6e6961'],
                  ].map(([label, value, color]) => (
                    <div key={label}>
                      <span>
                        <i style={{ background: color }} />
                        {label}
                      </span>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <button
                className="card-footer-link"
                onClick={() => onOpenPortfolioTab('analysis')}
                type="button"
              >
                Explore exposure
                <span>Includes nested portfolios and ETF look-through</span>
                <Icon name="arrow-right" size={14} />
              </button>
            </section>
          ) : null}

          {show('cashflow') ? (
            <section className="card cashflow-card">
              <SectionHeading
                title="Cash flow"
                action={
                  <button
                    className="text-link"
                    onClick={() => onOpenPortfolioTab('cash-flow')}
                    type="button"
                  >
                    View activity <Icon name="arrow-right" size={13} />
                  </button>
                }
              />
              <div className="cashflow-summary">
                <div>
                  <small>Income</small>
                  <strong className="positive">
                    <Money value={7240} privateMode={privateMode} />
                  </strong>
                </div>
                <div>
                  <small>Outflow</small>
                  <strong>
                    <Money value={-4981} privateMode={privateMode} />
                  </strong>
                </div>
                <div>
                  <small>Net</small>
                  <strong>
                    <Money value={2259} privateMode={privateMode} showPlus />
                  </strong>
                </div>
              </div>
              <div className="cashflow-bars" aria-label="Monthly cash flow">
                {[46, 65, 52, 78, 58, 86, 69, 92, 73, 81, 67, 89].map((height, index) => (
                  <span key={height + index}>
                    <i style={{ height: `${height}%` }} />
                    <em style={{ height: `${Math.max(18, height - 33)}%` }} />
                  </span>
                ))}
              </div>
              <div className="cashflow-axis">
                <span>Aug</span>
                <span>Nov</span>
                <span>Feb</span>
                <span>May</span>
                <span>Jul</span>
              </div>
            </section>
          ) : null}

          {show('brief') ? (
            <button
              className="card insight-card"
              type="button"
              onClick={() => onOverlay('assistant')}
            >
              <span className="insight-card__glow" />
              <span className="insight-card__header">
                <span className="insight-card__mark">
                  <Icon name="sparkles" />
                </span>
                <span>
                  <small>BETTERTRACK BRIEF</small>
                  <strong>Your month, explained</strong>
                </span>
                <Icon name="arrow-right" />
              </span>
              <span className="insight-card__copy">
                Your net worth rose mostly from global equities and a property valuation. Cash flow
                stayed positive despite higher travel spending.
              </span>
              <span className="insight-card__meta">
                <span>
                  <StatusDot />
                  Grounded in 38 activities
                </span>
                <span>2 min read</span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {show('actions') ? (
        <section className="quick-actions">
          <span className="metric-label">Quick actions</span>
          <div>
            {[
              ['Add activity', 'plus'],
              ['Import statement', 'upload'],
              ['Build a scenario', 'workbench'],
              ['Invite someone', 'user-plus'],
            ].map(([label, icon]) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  if (label === 'Build a scenario') {
                    onOpenWorkbench();
                    return;
                  }
                  onOverlay(
                    label === 'Import statement'
                      ? 'import'
                      : label === 'Invite someone'
                        ? 'invite'
                        : 'create',
                  );
                }}
              >
                <Icon name={icon as IconName} />
                {label}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PortfolioDirectory({
  privateMode,
  portfolios,
  onOpenPortfolio,
  onCreate,
  onImport,
  onStructure,
}: {
  privateMode: boolean;
  portfolios: Scope[];
  onOpenPortfolio: (scope: Scope) => void;
  onCreate: () => void;
  onImport: () => void;
  onStructure: () => void;
}) {
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  return (
    <div className="page portfolio-directory">
      <div className="page-intro">
        <h1>Portfolios</h1>
        <div className="page-intro__actions">
          <Button variant="secondary" icon="layers" onClick={onStructure}>
            Structure
          </Button>
          <Button variant="secondary" icon="upload" onClick={onImport}>
            Import
          </Button>
          <Button variant="primary" icon="plus" onClick={onCreate}>
            New portfolio
          </Button>
        </div>
      </div>

      <section className="portfolio-directory-summary">
        <span>
          <small>Total value</small>
          <strong>
            <Money
              value={portfolios.find((portfolio) => portfolio.id === 'all')?.value ?? 0}
              privateMode={privateMode}
            />
          </strong>
        </span>
        <span>
          <small>Portfolios</small>
          <strong>{portfolios.length - 1}</strong>
        </span>
        <span>
          <small>Nested</small>
          <strong>
            {portfolios
              .slice(1)
              .reduce((total, portfolio) => total + (portfolio.childCount ?? 0), 0)}
          </strong>
        </span>
        <button onClick={onStructure} type="button">
          View structure
          <Icon name="arrow-right" size={14} />
        </button>
      </section>

      <div className="portfolio-list-header">
        <span className="portfolio-list-count">{portfolios.length - 1} portfolios</span>
        <div className="segmented-control">
          <button
            className={layout === 'list' ? 'is-active' : ''}
            onClick={() => setLayout('list')}
            type="button"
          >
            <Icon name="list" size={14} />
            List
          </button>
          <button
            className={layout === 'grid' ? 'is-active' : ''}
            onClick={() => setLayout('grid')}
            type="button"
          >
            <Icon name="grid" size={14} />
            Grid
          </button>
        </div>
      </div>
      {layout === 'list' ? (
        <section className="card portfolio-table">
          <div className="portfolio-table__head">
            <span>Portfolio</span>
            <span>Structure</span>
            <span>Access</span>
            <span>Value</span>
            <span>1 month</span>
            <span />
          </div>
          {portfolios.slice(1).map((item, index) => (
            <button
              className="portfolio-table__row"
              key={item.id}
              type="button"
              onClick={() => onOpenPortfolio(item)}
            >
              <span className="portfolio-cell">
                <i style={{ '--scope-color': item.accent } as never}>
                  <Icon name={item.icon} size={17} />
                </i>
                <span>
                  <strong>{item.name}</strong>
                  <small>Updated {index === 2 ? 'yesterday' : 'just now'}</small>
                </span>
              </span>
              <span>
                {item.childCount
                  ? `${item.childCount} nested`
                  : index === 2
                    ? 'Property'
                    : 'Direct'}
              </span>
              <span>
                {index > 1 ? <AvatarStack extra={index === 3 ? 0 : undefined} /> : 'Only you'}
              </span>
              <strong>
                <Money value={item.value} privateMode={privateMode} />
              </strong>
              <span className="positive">+{item.changePct}%</span>
              <Icon name="chevron-right" size={15} />
            </button>
          ))}
        </section>
      ) : (
        <section className="portfolio-card-grid">
          {portfolios.slice(1).map((item, index) => (
            <button
              className="card portfolio-grid-card"
              key={item.id}
              onClick={() => onOpenPortfolio(item)}
              type="button"
            >
              <span
                className="portfolio-grid-card__mark"
                style={{ '--scope-color': item.accent } as never}
              >
                <Icon name={item.icon} />
              </span>
              <span className="portfolio-grid-card__status">
                <StatusDot /> Synced
              </span>
              <div>
                <small>{item.eyebrow}</small>
                <h3>{item.name}</h3>
              </div>
              <strong>
                <Money value={item.value} privateMode={privateMode} />
              </strong>
              <span className="portfolio-grid-card__change">+{item.changePct}% this month</span>
              <footer>
                <span>
                  {item.childCount
                    ? `${item.childCount} portfolios inside`
                    : index === 2
                      ? 'Shared ownership'
                      : 'Direct portfolio'}
                </span>
                <Icon name="arrow-right" size={14} />
              </footer>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function PortfolioHeader({
  scope,
  tab,
  onTab,
  onCreate,
  onShare,
  onStructure,
  onSettings,
}: {
  scope: Scope;
  tab: PortfolioTab;
  onTab: (tab: PortfolioTab) => void;
  onCreate: () => void;
  onShare: () => void;
  onStructure: () => void;
  onSettings: () => void;
}) {
  const tabsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const tabs = tabsRef.current;
    const activeTab = tabs?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!tabs || !activeTab) return;
    tabs.scrollLeft = activeTab.offsetLeft - (tabs.clientWidth - activeTab.offsetWidth) / 2;
  }, [tab]);

  return (
    <div className="portfolio-context-bar">
      <nav className="portfolio-tabs" aria-label={`${scope.name} sections`} ref={tabsRef}>
        {portfolioTabs.map((item) => (
          <button
            aria-current={tab === item.id ? 'page' : undefined}
            className={tab === item.id ? 'is-active' : ''}
            key={item.id}
            type="button"
            onClick={() => onTab(item.id)}
          >
            {item.label}
            {item.id === 'activity' ? <span>3</span> : null}
          </button>
        ))}
      </nav>
      <div className="portfolio-header-actions">
        <Button variant="secondary" icon="share" onClick={onShare}>
          Share
        </Button>
        {tab === 'overview' ? (
          <Button aria-label="Create" variant="primary" icon="plus" onClick={onCreate}>
            Add
          </Button>
        ) : null}
        <Button variant="quiet" size="icon" aria-label="Portfolio structure" onClick={onStructure}>
          <Icon name="layers" />
        </Button>
        <Button variant="quiet" size="icon" aria-label="Portfolio settings" onClick={onSettings}>
          <Icon name="more" />
        </Button>
      </div>
    </div>
  );
}

function HoldingsTable({
  privateMode,
  expanded = false,
  trades = [],
  query = '',
  onSelect,
}: {
  privateMode: boolean;
  expanded?: boolean;
  trades?: OriginTradeResult[];
  query?: string;
  onSelect?: (symbol: string) => void;
}) {
  const adjusted = holdings.map((holding) => ({ ...holding }));
  trades
    .slice()
    .reverse()
    .forEach((trade) => {
      const existing = adjusted.find((holding) => holding.symbol === trade.asset.symbol);
      const signedValue = trade.side === 'Buy' ? trade.gross : -trade.gross;
      if (existing) {
        existing.value = Math.max(0, existing.value + signedValue);
      } else if (trade.side === 'Buy') {
        adjusted.push({
          symbol: trade.asset.symbol,
          name: trade.asset.name,
          type: 'Stock',
          value: trade.gross,
          allocation: 0,
          change: trade.asset.change,
          color: '#f6b82e',
        });
      }
    });
  const total = adjusted.reduce((sum, holding) => sum + holding.value, 0);
  adjusted.forEach((holding) => {
    holding.allocation = total ? Number(((holding.value / total) * 100).toFixed(2)) : 0;
  });
  const matching = adjusted.filter((holding) =>
    `${holding.symbol} ${holding.name} ${holding.type}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const rows = expanded ? matching : matching.slice(0, 4);
  return (
    <div className="holdings-table">
      <div className="holdings-table__head">
        <span>Holding</span>
        <span>Type</span>
        <span>Allocation</span>
        <span>Today</span>
        <span>Value</span>
        <span />
      </div>
      {rows.map((holding) => (
        <button
          className="holdings-table__row"
          key={holding.symbol}
          onClick={() => onSelect?.(holding.symbol)}
          type="button"
        >
          <span className="holding-name">
            <i style={{ background: `${holding.color}22`, color: holding.color }}>
              {holding.symbol.slice(0, 2)}
            </i>
            <span>
              <strong>{holding.symbol}</strong>
              <small>{holding.name}</small>
            </span>
          </span>
          <span>{holding.type}</span>
          <span className="allocation-inline">
            <i>
              <em style={{ width: `${Math.min(100, holding.allocation * 2)}%` }} />
            </i>
            {holding.allocation}%
          </span>
          <span className={holding.change >= 0 ? 'positive' : 'negative'}>
            {holding.change >= 0 ? '+' : ''}
            {holding.change}%
          </span>
          <strong>
            <Money value={holding.value} privateMode={privateMode} />
          </strong>
          <Icon name="chevron-right" size={14} />
        </button>
      ))}
      {rows.length === 0 ? (
        <div className="table-empty-state">
          <Icon name="search" size={17} />
          <span>
            <strong>No holdings match “{query}”</strong>
            <small>Try a ticker, asset name, or asset class.</small>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PortfolioOverview({
  scope,
  detailed,
  privateMode,
  onTab,
  onDataHealth,
  onToast,
  availableCash,
  latestTrade,
  trades,
}: {
  scope: Scope;
  detailed: boolean;
  privateMode: boolean;
  onTab: (tab: PortfolioTab) => void;
  onDataHealth: () => void;
  onToast: (message: string) => void;
  availableCash: number;
  latestTrade?: OriginTradeResult;
  trades: OriginTradeResult[];
}) {
  const [range, setRange] = useState('1M');
  return (
    <div className="portfolio-overview">
      <div className="portfolio-overview__hero">
        <section
          className={cn(
            'card portfolio-performance-card',
            detailed && 'portfolio-performance-card--detailed',
          )}
        >
          <div className="performance-header">
            <div>
              <span className="metric-label">Portfolio value</span>
              <div className="portfolio-value">
                <Money value={scope.value} privateMode={privateMode} />
              </div>
              <div className="performance-metrics">
                <span>
                  <small>Performance</small>
                  <strong className="positive">
                    <Money value={scope.change} privateMode={privateMode} compact showPlus />
                    <em>+{scope.changePct}%</em>
                  </strong>
                </span>
                <span>
                  <small>Net invested</small>
                  <strong>
                    <Money value={231200} privateMode={privateMode} compact />
                  </strong>
                </span>
                <span>
                  <small>Cash available</small>
                  <strong>
                    <Money value={availableCash} privateMode={privateMode} compact />
                  </strong>
                </span>
              </div>
            </div>
            <div className="chart-controls">
              <div className="range-switcher">
                {['1W', '1M', '3M', '1Y', 'ALL'].map((item) => (
                  <button
                    className={range === item ? 'is-active' : ''}
                    key={item}
                    type="button"
                    onClick={() => setRange(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <Button
                variant="quiet"
                size="icon"
                aria-label="Chart settings"
                onClick={() => onToast('Chart display and benchmark settings opened')}
              >
                <Icon name="sliders" size={16} />
              </Button>
              <Button
                aria-label="Open data health, current quality 96 percent"
                onClick={onDataHealth}
                size="icon"
                variant="quiet"
              >
                <Icon name="check" size={16} />
              </Button>
            </div>
          </div>
          <WealthChart
            detailed={detailed}
            values={scope.chart}
            privateMode={privateMode}
            height={detailed ? 390 : 282}
            range={range}
          />
          <div className="performance-footer">
            <span>
              <i className="legend-line legend-line--value" />
              Portfolio value
            </span>
            <span>
              <i className="legend-line legend-line--invested" />
              Net invested
            </span>
            <button
              onClick={() => onToast('FTSE All-World benchmark added to this chart')}
              type="button"
            >
              <Icon name="plus" size={13} />
              Compare benchmark
            </button>
            {detailed ? (
              <>
                <span className="performance-detail">
                  Volatility <strong>8.42%</strong>
                </span>
                <span className="performance-detail">
                  Max drawdown <strong>−6.18%</strong>
                </span>
              </>
            ) : null}
          </div>
          {latestTrade ? (
            <button
              className="portfolio-write-receipt"
              onClick={() => onTab('activity')}
              type="button"
            >
              <span>
                <Icon name="check" />
              </span>
              <span>
                <small>LATEST PORTFOLIO WRITE</small>
                <strong>
                  {latestTrade.side} {latestTrade.asset.symbol} ·{' '}
                  {latestTrade.units.toLocaleString('en-IE', { maximumFractionDigits: 6 })} units
                </strong>
              </span>
              <span>
                <small>CASH AFTER</small>
                <strong>
                  <Money value={availableCash} privateMode={privateMode} compact />
                </strong>
              </span>
              <Icon name="arrow-right" size={14} />
            </button>
          ) : null}
        </section>
      </div>

      <div className="portfolio-overview__middle">
        <section className="card holdings-card">
          <SectionHeading
            title="Holdings"
            action={
              <button className="text-link" type="button" onClick={() => onTab('holdings')}>
                All holdings <Icon name="arrow-right" size={13} />
              </button>
            }
          />
          <HoldingsTable
            privateMode={privateMode}
            trades={trades}
            onSelect={(symbol) => onToast(`${symbol} holding detail opened`)}
          />
        </section>

        <section className="card allocation-detail">
          <SectionHeading
            title="Allocation"
            action={
              <Button
                variant="quiet"
                size="icon"
                aria-label="Allocation filters"
                onClick={() => onToast('Allocation dimension picker opened')}
              >
                <Icon name="sliders" size={15} />
              </Button>
            }
          />
          <div className="treemap">
            <button className="treemap__public" onClick={() => onTab('holdings')} type="button">
              <span>Public markets</span>
              <strong>62.4%</strong>
            </button>
            <button className="treemap__cash" onClick={() => onTab('holdings')} type="button">
              <span>Cash</span>
              <strong>12.5%</strong>
            </button>
            <button className="treemap__crypto" onClick={() => onTab('holdings')} type="button">
              <span>Crypto</span>
              <strong>10.0%</strong>
            </button>
            <button className="treemap__other" onClick={() => onTab('holdings')} type="button">
              <span>Other</span>
              <strong>15.1%</strong>
            </button>
          </div>
          <div className="allocation-callout">
            <Icon name="layers" size={15} />
            <strong>ETF look-through on</strong>
          </div>
        </section>
      </div>

      <div className="portfolio-overview__bottom">
        <section className="card mini-cashflow">
          <SectionHeading
            title="Cash flow"
            action={
              <button className="text-link" type="button" onClick={() => onTab('cash-flow')}>
                Details <Icon name="arrow-right" size={13} />
              </button>
            }
          />
          <div className="mini-cashflow__value">
            <span>
              <small>Net this month</small>
              <strong>
                <Money value={2259} privateMode={privateMode} showPlus />
              </strong>
            </span>
            <span className="positive">+12% vs plan</span>
          </div>
          <div className="mini-cashflow__track">
            <span style={{ width: '68%' }}>
              <em>Income €7.2k</em>
            </span>
            <i style={{ width: '47%' }}>
              <em>Outflow €5.0k</em>
            </i>
          </div>
          <div className="recurring-row">
            <span>
              <Icon name="repeat" size={15} />7 recurring items
            </span>
            <span>Next: €500 VWCE on 29 Jul</span>
          </div>
        </section>

        <section className="card goal-card">
          <SectionHeading
            title="Financial independence"
            action={<span className="goal-date">June 2041</span>}
          />
          <div className="goal-progress">
            <div>
              <strong>31%</strong>
              <small>
                <Money value={284920} privateMode={privateMode} compact /> of €920k
              </small>
            </div>
            <span>
              <i style={{ width: '31%' }} />
              <em style={{ left: '38%' }} />
            </span>
          </div>
          <div className="goal-forecast">
            <span>
              <Icon name="target" size={15} />
              At your current pace
            </span>
            <strong className="positive">14 months ahead</strong>
          </div>
        </section>
      </div>
    </div>
  );
}

function ActivityTab({
  privateMode,
  customActivities,
  onCreate,
  onEvents,
  onOpenActivity,
}: {
  privateMode: boolean;
  customActivities: DemoActivity[];
  onCreate: () => void;
  onEvents: () => void;
  onOpenActivity: (title: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'ledger' | 'timeline' | 'calendar'>('ledger');
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [period, setPeriod] = useState<'This month' | 'All history'>('This month');
  const rows = [...customActivities, ...activities].filter((item) => {
    const matchesQuery = `${item.title} ${item.detail} ${item.source} ${item.status}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    const matchesStatus = !confirmedOnly || /confirmed|filled|imported|recorded/i.test(item.status);
    return matchesQuery && matchesStatus;
  });
  return (
    <div className="tab-page">
      <div className="tab-page__intro">
        <div>
          <h2>Activity</h2>
          <p>Every trade, expense, transfer, import, and change in one explainable ledger.</p>
        </div>
      </div>
      <div className="activity-toolbar card">
        <div className="activity-search">
          <Icon name="search" size={15} />
          <input
            aria-label="Search activity"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search activity…"
            value={query}
          />
        </div>
        <Button
          aria-pressed={confirmedOnly}
          variant="secondary"
          icon="filter"
          onClick={() => setConfirmedOnly((current) => !current)}
        >
          {confirmedOnly ? 'Confirmed only' : 'All statuses'}
        </Button>
        <Button
          variant="secondary"
          icon="calendar"
          onClick={() =>
            setPeriod((current) => (current === 'This month' ? 'All history' : 'This month'))
          }
        >
          {period}
        </Button>
        <Button variant="quiet" icon="calendar" onClick={onEvents}>
          Portfolio events
        </Button>
        <div className="view-switch">
          <button
            className={view === 'ledger' ? 'is-active' : ''}
            onClick={() => setView('ledger')}
            type="button"
            aria-label="Ledger view"
          >
            <Icon name="list" size={15} />
          </button>
          <button
            className={view === 'timeline' ? 'is-active' : ''}
            onClick={() => setView('timeline')}
            type="button"
            aria-label="Timeline view"
          >
            <Icon name="activity" size={15} />
          </button>
          <button
            className={view === 'calendar' ? 'is-active' : ''}
            onClick={() => setView('calendar')}
            type="button"
            aria-label="Calendar view"
          >
            <Icon name="calendar" size={15} />
          </button>
        </div>
        <Button variant="primary" icon="plus" onClick={onCreate}>
          Add activity
        </Button>
      </div>
      <section className={cn('card activity-ledger', `activity-ledger--${view}`)}>
        <div className="activity-ledger__head">
          <span>Activity</span>
          <span>Source</span>
          <span>Status</span>
          <span>Amount</span>
          <span />
        </div>
        {rows.map((item) => (
          <button
            className="activity-ledger__row"
            key={item.id}
            onClick={() => onOpenActivity(item.title)}
            type="button"
          >
            <span className="activity-name">
              <i>
                <Icon name={item.icon} size={16} />
              </i>
              <span>
                <strong>{item.title}</strong>
                <small>
                  {item.date} · {item.detail}
                </small>
              </span>
            </span>
            <span>{item.source}</span>
            <span className="activity-status">
              <StatusDot />
              {item.status}
            </span>
            <strong className={item.amount > 0 ? 'positive' : ''}>
              <Money value={item.amount} privateMode={privateMode} showPlus />
            </strong>
            <Icon name="chevron-right" size={14} />
          </button>
        ))}
        {rows.length === 0 ? (
          <div className="table-empty-state">
            <Icon name="search" size={17} />
            <span>
              <strong>No activity matches this view</strong>
              <small>Clear the search or show every status.</small>
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function HoldingsTab({
  privateMode,
  onCreate,
  onToast,
  trades,
}: {
  privateMode: boolean;
  onCreate: () => void;
  onToast: (message: string) => void;
  trades: OriginTradeResult[];
}) {
  const [query, setQuery] = useState('');
  const [lookThrough, setLookThrough] = useState(true);
  return (
    <div className="tab-page">
      <div className="tab-page__intro">
        <div>
          <h2>Holdings</h2>
          <p>Securities, cash, real assets, liabilities, and nested portfolios.</p>
        </div>
      </div>
      <div className="summary-strip holdings-summary-strip">
        {[
          ['Net value', 284920, '+1.24%'],
          ['Gross assets', 319442, '+1.2%'],
          ['Liabilities', -34522, '−0.4%'],
          ['Positions', 18, '5 asset classes'],
        ].map(([label, value, meta]) => (
          <div className={label === 'Net value' ? 'is-primary' : undefined} key={label}>
            <small>{label}</small>
            <strong>
              {label === 'Positions' ? (
                value
              ) : (
                <Money value={Number(value)} privateMode={privateMode} />
              )}
            </strong>
            <span>{meta}</span>
          </div>
        ))}
      </div>
      <section className="card holdings-full">
        <div className="table-toolbar">
          <div className="activity-search">
            <Icon name="search" size={15} />
            <input
              aria-label="Search holdings"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search holdings…"
              value={query}
            />
          </div>
          <Button
            variant="secondary"
            icon="filter"
            onClick={() => onToast('Asset-class filter opened for this portfolio')}
          >
            All asset classes
          </Button>
          <Button
            aria-pressed={lookThrough}
            variant="secondary"
            icon="layers"
            onClick={() => setLookThrough((current) => !current)}
          >
            Look-through {lookThrough ? 'on' : 'off'}
          </Button>
          <Button
            variant="quiet"
            size="icon"
            aria-label="Table columns"
            onClick={() => onToast('Holding table columns opened')}
          >
            <Icon name="sliders" />
          </Button>
          <Button variant="primary" icon="plus" onClick={onCreate}>
            Add holding
          </Button>
        </div>
        <HoldingsTable
          privateMode={privateMode}
          expanded
          query={query}
          trades={trades}
          onSelect={(symbol) => onToast(`${symbol} holding detail opened`)}
        />
      </section>
    </div>
  );
}

function CashFlowTab({
  privateMode,
  onCreate,
  onReview,
  onOpenRecurring,
  customCashFlows,
}: {
  privateMode: boolean;
  onCreate: () => void;
  onReview: () => void;
  onOpenRecurring: (title: string) => void;
  customCashFlows: OriginCashFlowResult[];
}) {
  const [range, setRange] = useState<'3M' | '1Y' | 'ALL'>('1Y');
  const addedIncome = customCashFlows
    .filter((item) => item.kind === 'Income')
    .reduce((sum, item) => sum + item.amount, 0);
  const addedSpending = customCashFlows
    .filter((item) => item.kind === 'Expense')
    .reduce((sum, item) => sum + item.amount, 0);
  const income = 7240 + addedIncome;
  const spending = 4981 + addedSpending;
  const saved = income - spending;
  return (
    <div className="tab-page">
      <div className="tab-page__intro">
        <div>
          <h2>Cash flow</h2>
          <p>Income, spending, budgets, and recurring plans live with the portfolio they affect.</p>
        </div>
        <Button variant="primary" icon="plus" onClick={onCreate}>
          Add cash activity
        </Button>
      </div>
      <div className="cashflow-page-grid">
        <section className="card cashflow-main">
          <SectionHeading
            title={
              range === '3M'
                ? 'Quarter cash flow'
                : range === '1Y'
                  ? 'Year cash flow'
                  : 'All cash flow'
            }
            description={`${range} view · actual through 27 July · projected periods are marked`}
            action={
              <div className="range-switcher">
                {(['3M', '1Y', 'ALL'] as const).map((item) => (
                  <button
                    className={range === item ? 'is-active' : ''}
                    key={item}
                    onClick={() => setRange(item)}
                    type="button"
                  >
                    {item}
                  </button>
                ))}
              </div>
            }
          />
          <div className="cashflow-large-summary">
            <span>
              <small>Income</small>
              <strong className="positive">
                <Money value={income} privateMode={privateMode} />
              </strong>
            </span>
            <span>
              <small>Spending</small>
              <strong>
                <Money value={-spending} privateMode={privateMode} />
              </strong>
            </span>
            <span>
              <small>Saved</small>
              <strong>
                <Money value={saved} privateMode={privateMode} showPlus />
              </strong>
            </span>
            <span>
              <small>Savings rate</small>
              <strong>{income ? ((saved / income) * 100).toFixed(1) : '0.0'}%</strong>
            </span>
          </div>
          <div className="cashflow-chart-large">
            {[62, 74, 55, 82, 67, 92, 73, 86, 65, 79, 70, 88].map((height, index) => (
              <div key={height + index}>
                <span style={{ height: `${height}%` }} />
                <i style={{ height: `${Math.max(24, height - (index % 3) * 8 - 22)}%` }} />
                <small>
                  {['Aug', '', 'Oct', '', 'Dec', '', 'Feb', '', 'Apr', '', 'Jun', 'Jul'][index]}
                </small>
              </div>
            ))}
          </div>
        </section>
        <section className="card spending-card">
          <SectionHeading title="Where money went" description="€4,981 total outflow" />
          <div className="category-list">
            {[
              ['Housing', '€1,760', 35, '#8b96ac'],
              ['Investing', '€1,200', 24, '#c6aa77'],
              ['Living', '€984', 20, '#7d9c90'],
              ['Travel', '€621', 13, '#a98b9d'],
              ['Other', '€416', 8, '#716d65'],
            ].map(([label, value, width, color]) => (
              <div key={label}>
                <span>
                  <i style={{ background: color }} />
                  {label}
                </span>
                <em>
                  <i style={{ width: `${Number(width) * 2.2}%`, background: color }} />
                </em>
                <strong>{privateMode ? '•••' : value}</strong>
              </div>
            ))}
          </div>
          <button className="card-footer-link" onClick={onReview} type="button">
            Review categories
            <span>3 activities need attention</span>
            <Icon name="arrow-right" size={14} />
          </button>
        </section>
      </div>
      <section className="card recurring-section">
        <SectionHeading
          title="Recurring and planned"
          description="Automations, subscriptions, contributions, and expected income"
          action={
            <Button variant="secondary" icon="plus" onClick={onCreate}>
              New recurring item
            </Button>
          }
        />
        <div className="recurring-grid">
          {customCashFlows
            .filter((item) => item.recurring)
            .map((item) => (
              <button key={item.id} onClick={() => onOpenRecurring(item.title)} type="button">
                <span>
                  <Icon
                    name={
                      item.kind === 'Income'
                        ? 'arrow-down'
                        : item.kind === 'Expense'
                          ? 'arrow-up'
                          : 'repeat'
                    }
                  />
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.schedule}</small>
                </span>
                <span>
                  <strong className={item.cashImpact > 0 ? 'positive' : ''}>
                    <Money
                      value={item.cashImpact}
                      privateMode={privateMode}
                      showPlus={item.cashImpact > 0}
                    />
                  </strong>
                  <small>{item.category}</small>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            ))}
          {[
            ['VWCE savings plan', '29 Jul · monthly', '−€500', 'Investing', 'repeat'],
            ['Salary', '31 Jul · monthly', '+€4,280', 'Income', 'arrow-down'],
            ['Rent & utilities', '01 Aug · monthly', '−€1,430', 'Housing', 'house'],
            ['Microsoft dividend', '05 Aug · quarterly', '+€67.84', 'Dividend', 'calendar'],
          ].map(([title, date, amount, category, icon]) => (
            <button key={title} onClick={() => onOpenRecurring(String(title))} type="button">
              <span>
                <Icon name={icon as IconName} />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{date}</small>
              </span>
              <span>
                <strong className={String(amount).startsWith('+') ? 'positive' : ''}>
                  {privateMode ? '••••' : amount}
                </strong>
                <small>{category}</small>
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function AnalysisTab({ privateMode }: { privateMode: boolean }) {
  return (
    <div className="tab-page">
      <div className="tab-page__intro">
        <div>
          <h2>Analysis</h2>
          <p>Performance, risk, exposure, income, and tax—each calculation explainable.</p>
        </div>
        <Button variant="secondary" icon="download">
          Export report
        </Button>
      </div>
      <div className="analysis-metrics">
        {[
          ['TTWROR', '+11.84%', '1 year', 'positive'],
          ['IRR', '+10.92%', 'Since inception', 'positive'],
          ['Max drawdown', '−8.42%', '14 Mar 2026', 'negative'],
          ['Volatility', '12.31%', 'Annualized', 'neutral'],
          ['Sharpe ratio', '0.91', 'Risk-free 2.1%', 'neutral'],
        ].map(([label, value, meta, tone]) => (
          <button className="card" key={label} type="button">
            <span>
              {label}
              <Icon name="help" size={13} />
            </span>
            <strong className={tone}>
              {privateMode && label !== 'Sharpe ratio' ? '••••' : value}
            </strong>
            <small>{meta}</small>
          </button>
        ))}
      </div>
      <div className="analysis-grid">
        <section className="card risk-chart">
          <SectionHeading
            title="Risk and return"
            description="Holdings compared by contribution"
            action={
              <button className="text-link" type="button">
                1 year <Icon name="chevron-down" size={13} />
              </button>
            }
          />
          <div className="scatter-plot">
            <span className="scatter-axis scatter-axis--x">Risk →</span>
            <span className="scatter-axis scatter-axis--y">Return →</span>
            <i className="scatter-dot scatter-dot--1">VWCE</i>
            <i className="scatter-dot scatter-dot--2">AAPL</i>
            <i className="scatter-dot scatter-dot--3">BTC</i>
            <i className="scatter-dot scatter-dot--4">MSFT</i>
          </div>
        </section>
        <section className="card exposure-card">
          <SectionHeading title="True exposure" description="Direct + fund look-through" />
          {[
            ['United States', 48.2, '+1.8%'],
            ['Europe', 23.8, '−0.4%'],
            ['Emerging markets', 12.4, '+0.2%'],
            ['Japan', 6.9, '−0.1%'],
            ['Other', 8.7, ''],
          ].map(([label, share, delta]) => (
            <div className="exposure-row" key={label}>
              <span>{label}</span>
              <i>
                <em style={{ width: `${Number(share) * 1.8}%` }} />
              </i>
              <strong>{share}%</strong>
              <small>{delta}</small>
            </div>
          ))}
        </section>
      </div>
      <div className="calculation-note">
        <Icon name="shield" size={17} />
        <span>
          <strong>Transparent by design.</strong>
          Values use end-of-day prices through 26 Jul, ECB FX rates, and your selected Austrian tax
          profile.
        </span>
        <button type="button">See calculation details</button>
      </div>
    </div>
  );
}

function PlanTab({ privateMode, onAssistant }: { privateMode: boolean; onAssistant: () => void }) {
  return (
    <div className="tab-page">
      <div className="tab-page__intro">
        <div>
          <h2>Plan</h2>
          <p>Goals and target allocations connect directly to forecasts and automations.</p>
        </div>
        <Button variant="primary" icon="plus">
          New goal
        </Button>
      </div>
      <div className="plan-grid">
        <section className="card plan-hero">
          <span className="metric-label">Primary goal</span>
          <h3>Financial independence</h3>
          <p>Target €920,000 in today's money by June 2041.</p>
          <div className="plan-hero__numbers">
            <span>
              <small>Current</small>
              <strong>
                <Money value={284920} privateMode={privateMode} compact />
              </strong>
            </span>
            <Icon name="arrow-right" />
            <span>
              <small>Projected</small>
              <strong>
                <Money value={1036000} privateMode={privateMode} compact />
              </strong>
            </span>
          </div>
          <div className="forecast-band">
            <span className="forecast-band__low" />
            <span className="forecast-band__mid" />
            <span className="forecast-band__high" />
            <i style={{ left: '31%' }}>
              <em>Today</em>
            </i>
            <b style={{ left: '78%' }}>
              <em>Goal</em>
            </b>
          </div>
          <div className="forecast-axis">
            <span>2026</span>
            <span>2031</span>
            <span>2036</span>
            <span>2041</span>
          </div>
          <div className="plan-verdict">
            <Icon name="check" />
            <span>
              <strong>On track, 14 months ahead.</strong>
              <small>Based on €700 monthly contributions and a 5.8% expected return.</small>
            </span>
          </div>
        </section>
        <section className="card target-allocation">
          <SectionHeading title="Global Core target" description="Review quarterly" />
          <div className="target-visual">
            <div className="target-ring">
              <span>4.8%</span>
              <small>drift</small>
            </div>
          </div>
          <div className="target-rows">
            {[
              ['Equities', '70%', '74.8%', '4.8'],
              ['Cash', '15%', '12.5%', '-2.5'],
              ['Alternatives', '15%', '12.7%', '-2.3'],
            ].map(([label, target, actual, drift]) => (
              <div key={label}>
                <span>{label}</span>
                <small>Target {target}</small>
                <strong>{actual}</strong>
                <em className={Number(drift) > 0 ? 'negative' : ''}>
                  {Number(drift) > 0 ? '+' : ''}
                  {drift}
                </em>
              </div>
            ))}
          </div>
          <Button variant="secondary" icon="workbench">
            Build rebalance scenario
          </Button>
        </section>
      </div>
      <button className="ai-plan-banner" type="button" onClick={onAssistant}>
        <span>
          <Icon name="sparkles" />
        </span>
        <span>
          <strong>Ask about this plan</strong>
          <small>Try “What if I invest €200 more each month?”</small>
        </span>
        <Icon name="arrow-right" />
      </button>
    </div>
  );
}

function AutomateTab({
  privateMode,
  onConnections,
}: {
  privateMode: boolean;
  onConnections: () => void;
}) {
  return (
    <div className="tab-page">
      <div className="tab-page__intro">
        <div>
          <h2>Automate</h2>
          <p>Standing orders, rules, syncs, and approved AI actions—with a visible audit trail.</p>
        </div>
        <Button variant="primary" icon="plus">
          New automation
        </Button>
      </div>
      <div className="automation-summary">
        <section className="card">
          <span className="automation-status">
            <StatusDot />4 active
          </span>
          <strong>€1,340</strong>
          <small>scheduled monthly</small>
        </section>
        <section className="card">
          <span className="automation-status">
            <Icon name="check" size={14} />
            12 successful
          </span>
          <strong>0 failed</strong>
          <small>in the last 30 days</small>
        </section>
        <section className="card">
          <span className="automation-status">
            <Icon name="shield" size={14} />
            Confirmation
          </span>
          <strong>Always</strong>
          <small>for writes and transfers</small>
        </section>
      </div>
      <section className="card automation-list">
        {[
          [
            'VWCE monthly contribution',
            'Buy €500 on the last business day',
            'Next 29 Jul',
            'repeat',
            true,
          ],
          ['Categorize groceries', 'Merchant contains BILLA → Food', 'Ran today', 'cash', true],
          [
            'Drive statement import',
            'Review new PDFs from BetterTrack folder',
            'Checks daily',
            'document',
            true,
          ],
          ['Cash buffer alert', 'Notify below €8,000', 'Watching', 'bell', false],
        ].map(([title, copy, meta, icon, active]) => (
          <button key={String(title)} type="button">
            <span className="automation-icon">
              <Icon name={icon as IconName} />
            </span>
            <span>
              <strong>{title}</strong>
              <small>{copy}</small>
            </span>
            <span>
              <small>{meta}</small>
              {title === 'VWCE monthly contribution' ? (
                <strong>{privateMode ? '•••' : '€500'}</strong>
              ) : null}
            </span>
            <i className={cn('toggle', active && 'is-on')}>
              <em />
            </i>
            <Icon name="chevron-right" size={14} />
          </button>
        ))}
      </section>
      <button className="connection-inline" type="button" onClick={onConnections}>
        <span>
          <Icon name="link" />
        </span>
        <span>
          <strong>Automation starts with connected data</strong>
          <small>Manage bank, broker, Parqet, Drive, API, and webhook sources.</small>
        </span>
        <AvatarStack />
        <Icon name="arrow-right" />
      </button>
    </div>
  );
}

function FilesTab({
  driveConnected,
  onConnections,
}: {
  driveConnected: boolean;
  onConnections: () => void;
}) {
  return (
    <div className="tab-page">
      <div className="tab-page__intro">
        <div>
          <h2>Files</h2>
          <p>Statements, receipts, contracts, and valuation evidence in portfolio context.</p>
        </div>
        <Button variant="primary" icon="upload">
          Upload
        </Button>
      </div>
      {!driveConnected ? (
        <section className="drive-banner">
          <span className="drive-mark">G</span>
          <span>
            <strong>Bring portfolio documents in from Google Drive</strong>
            <small>Pick a folder, review detected statements, and control what syncs.</small>
          </span>
          <Button variant="secondary" onClick={onConnections}>
            Connect Drive
          </Button>
        </section>
      ) : (
        <section className="drive-banner drive-banner--connected">
          <span className="drive-mark">G</span>
          <span>
            <strong>Google Drive is connected</strong>
            <small>BetterTrack / Personal wealth · checked 4 minutes ago</small>
          </span>
          <span className="connected-badge">
            <Icon name="check" size={13} />
            Synced
          </span>
        </section>
      )}
      <section className="card files-table">
        <div className="table-toolbar">
          <div className="activity-search">
            <Icon name="search" size={15} />
            <input aria-label="Search files" placeholder="Search files…" />
          </div>
          <Button variant="secondary" icon="filter">
            All files
          </Button>
          <Button variant="secondary" icon="folder">
            Folders
          </Button>
        </div>
        {[
          ['Trade Republic · July statement.pdf', 'Statement', 'Drive', 'Today, 08:12', '42 KB'],
          ['Property valuation 2026.pdf', 'Valuation', 'Uploaded by Mia', 'Yesterday', '2.4 MB'],
          ['VWCE tax report.pdf', 'Tax', 'Parqet', '24 Jul', '188 KB'],
          ['Riverside mortgage agreement.pdf', 'Contract', 'Manual', '12 Jul', '1.1 MB'],
        ].map(([name, type, source, date, size]) => (
          <button key={name} type="button">
            <span>
              <Icon name="document" />
            </span>
            <span>
              <strong>{name}</strong>
              <small>{type}</small>
            </span>
            <span>{source}</span>
            <span>{date}</span>
            <span>{size}</span>
            <Icon name="more" size={15} />
          </button>
        ))}
      </section>
    </div>
  );
}

function PortfolioTaxTab({ privateMode }: { privateMode: boolean }) {
  const [year, setYear] = useState('2026');
  const [expanded, setExpanded] = useState('VWCE');
  return (
    <div className="tab-page tax-tab">
      <div className="tab-page__intro">
        <div>
          <h2>Tax position</h2>
          <p>Realized activity, income, withholding, and cost basis in this portfolio.</p>
        </div>
        <div className="tax-actions">
          <div className="segmented-control" aria-label="Tax year">
            {['2024', '2025', '2026'].map((item) => (
              <button
                className={year === item ? 'is-active' : ''}
                key={item}
                onClick={() => setYear(item)}
                type="button"
              >
                {item}
              </button>
            ))}
          </div>
          <Button variant="secondary" icon="download">
            Tax report
          </Button>
        </div>
      </div>
      <div className="tax-summary-strip">
        {[
          ['Realized result', 4872.42, '+18.4% year over year', 'positive'],
          ['Dividends', 1844.7, '23 distributions', 'positive'],
          ['Tax withheld', -1126.34, 'Austria · KESt', 'negative'],
          ['Estimated due', -487.62, 'Next filing estimate', 'neutral'],
        ].map(([label, value, meta, tone]) => (
          <div key={String(label)}>
            <small>{label}</small>
            <strong
              className={tone === 'positive' ? 'positive' : tone === 'negative' ? 'negative' : ''}
            >
              <Money value={Number(value)} privateMode={privateMode} showPlus />
            </strong>
            <span>{meta}</span>
          </div>
        ))}
      </div>
      <div className="tax-workspace">
        <section className="tax-ledger">
          <div className="feature-card-heading">
            <span>
              <small>REALIZED ACTIVITY</small>
              <h3>Tax lots and disposals</h3>
            </span>
            <button type="button">
              Cost basis: FIFO <Icon name="chevron-down" size={13} />
            </button>
          </div>
          <div className="tax-ledger__head">
            <span>Asset</span>
            <span>Proceeds</span>
            <span>Cost basis</span>
            <span>Result</span>
            <span>Tax</span>
            <span />
          </div>
          {[
            ['VWCE', 'Vanguard FTSE All-World', 12480, 10222, 2258, 621, '3 disposals'],
            ['AAPL', 'Apple', 8240, 6904, 1336, 367, '2 disposals'],
            ['BTC', 'Bitcoin', 6500, 5772, 728, 0, '1 disposal'],
            ['MSFT', 'Microsoft', 4200, 3649, 551, 138, '1 disposal'],
          ].map(([symbol, name, proceeds, basis, result, tax, lots]) => (
            <div className="tax-ledger__group" key={String(symbol)}>
              <button
                type="button"
                onClick={() => setExpanded(expanded === symbol ? '' : String(symbol))}
              >
                <span>
                  <i>{String(symbol).slice(0, 2)}</i>
                  <span>
                    <strong>{symbol}</strong>
                    <small>
                      {name} · {lots}
                    </small>
                  </span>
                </span>
                <span>
                  <Money value={Number(proceeds)} privateMode={privateMode} />
                </span>
                <span>
                  <Money value={Number(basis)} privateMode={privateMode} />
                </span>
                <strong className="positive">
                  <Money value={Number(result)} privateMode={privateMode} showPlus />
                </strong>
                <span>
                  <Money value={-Number(tax)} privateMode={privateMode} />
                </span>
                <Icon name={expanded === symbol ? 'chevron-down' : 'chevron-right'} size={14} />
              </button>
              {expanded === symbol ? (
                <div className="tax-lot-detail">
                  <span>
                    <small>Sold</small>
                    <strong>18 Jun 2026 · 12.40 units</strong>
                  </span>
                  <span>
                    <small>Acquired</small>
                    <strong>4 lots · oldest 14 Feb 2022</strong>
                  </span>
                  <span>
                    <small>Holding period</small>
                    <strong>1,585 days weighted</strong>
                  </span>
                  <button type="button">Open lot breakdown</button>
                </div>
              ) : null}
            </div>
          ))}
        </section>
        <aside className="tax-rail">
          <div>
            <span className="metric-label">Tax readiness</span>
            <strong>94%</strong>
            <i>
              <em style={{ width: '94%' }} />
            </i>
            <p>One disposal is missing acquisition fees. Everything else reconciles.</p>
          </div>
          <button type="button">
            <span>
              <Icon name="inbox" />
            </span>
            <span>
              <strong>Review missing cost basis</strong>
              <small>Bitcoin · €64.20 estimated impact</small>
            </span>
            <Icon name="arrow-right" size={14} />
          </button>
          <button type="button">
            <span>
              <Icon name="document" />
            </span>
            <span>
              <strong>6 source documents</strong>
              <small>Broker statements and confirmations</small>
            </span>
            <Icon name="arrow-right" size={14} />
          </button>
          <div className="tax-mode">
            <small>TAX MODEL</small>
            <strong>Austria · private investor</strong>
            <span>KESt 27.5% · FIFO cost basis</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PortfolioPeopleTab({ onInvite }: { onInvite: () => void }) {
  return (
    <div className="tab-page">
      <div className="tab-page__intro">
        <div>
          <h2>People and access</h2>
          <p>Ownership, permissions, approvals, and activity belong to this portfolio.</p>
        </div>
        <Button variant="primary" icon="user-plus" onClick={onInvite}>
          Invite
        </Button>
      </div>
      <div className="people-access-grid">
        <section className="card access-list">
          <SectionHeading title="Portfolio access" description="3 people · 1 pending invitation" />
          {[
            ['AM', 'Alex Morgan', 'Owner', 'Full access', 'sand'],
            ['MK', 'Mia Keller', 'Co-owner', 'Can edit and approve', 'sage'],
            ['JL', 'Jonas Leitner', 'Advisor', 'View and comment', 'blue'],
          ].map(([initials, name, role, access, tone]) => (
            <button key={name} type="button">
              <Avatar initials={initials!} tone={tone as 'sand' | 'sage' | 'blue'} />
              <span>
                <strong>{name}</strong>
                <small>{access}</small>
              </span>
              <span className="role-badge">{role}</span>
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
          <div className="pending-invite">
            <span className="avatar avatar--md avatar--ink">LW</span>
            <span>
              <strong>lea.wagner@example.com</strong>
              <small>Viewer invitation sent yesterday</small>
            </span>
            <Button variant="quiet" size="sm">
              Resend
            </Button>
          </div>
        </section>
        <section className="card permission-card">
          <SectionHeading title="How collaboration works" />
          {[
            ['Ownership is explicit', 'Record legal or beneficial ownership percentages.', 'pie'],
            [
              'Sensitive actions need review',
              'Configure approval rules for edits and automations.',
              'shield',
            ],
            [
              'Everything is traceable',
              'See who changed what, with comments and provenance.',
              'activity',
            ],
          ].map(([title, copy, icon]) => (
            <div key={title}>
              <span>
                <Icon name={icon as IconName} />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </span>
            </div>
          ))}
          <Button variant="secondary" icon="settings">
            Permission settings
          </Button>
        </section>
      </div>
      <section className="card collaboration-activity">
        <SectionHeading
          title="Collaboration activity"
          description="Comments, proposals, and approvals"
        />
        {[
          [
            'MK',
            'Mia proposed a property value update',
            '€138,400 → €144,900',
            '2 hours ago',
            'sage',
          ],
          [
            'JL',
            'Jonas commented on the Global Core target',
            '“I would keep the cash band at 15%.”',
            'Yesterday',
            'blue',
          ],
          [
            'AM',
            'You approved the July Drive import',
            '12 activities added · 1 duplicate skipped',
            '25 Jul',
            'sand',
          ],
        ].map(([initials, title, copy, time, tone]) => (
          <button key={title} type="button">
            <Avatar initials={initials!} tone={tone as 'sand' | 'sage' | 'blue'} size="sm" />
            <span>
              <strong>{title}</strong>
              <small>{copy}</small>
            </span>
            <small>{time}</small>
            <Icon name="chevron-right" size={14} />
          </button>
        ))}
      </section>
    </div>
  );
}

function PortfolioDetail({
  scope,
  direction,
  tab,
  onTab,
  privateMode,
  customActivities,
  driveConnected,
  onOverlay,
  onDataHealth,
  onSecurity,
  availableCash,
  latestTrade,
  cashFlows,
  portfolioTrades,
  portfolioShares,
  onAutomationProposal,
  onCollaborationProposal,
  onReviewProposal,
  onAutomationActivity,
  onToast,
  onOpenWorkbench,
}: {
  scope: Scope;
  direction: DesignDirection;
  tab: PortfolioTab;
  onTab: (tab: PortfolioTab) => void;
  privateMode: boolean;
  customActivities: DemoActivity[];
  driveConnected: boolean;
  onOverlay: (overlay: Overlay) => void;
  onDataHealth: () => void;
  onSecurity: () => void;
  availableCash: number;
  latestTrade?: OriginTradeResult;
  cashFlows: OriginCashFlowResult[];
  portfolioTrades: OriginTradeResult[];
  portfolioShares: OriginShareResult[];
  onAutomationProposal: (proposal: OriginAutomationProposal) => void;
  onCollaborationProposal: (proposal: OriginCollaborationProposal) => void;
  onReviewProposal: (proposal: OriginReviewEntry, openReview?: boolean) => void;
  onAutomationActivity: (activity: OriginAutomationActivity) => void;
  onToast: (message: string) => void;
  onOpenWorkbench: (context: string) => void;
}) {
  const [originPlanSection, setOriginPlanSection] = useState<'goals' | 'continuity'>('goals');
  let content: ReactNode;
  switch (tab) {
    case 'activity':
      content = (
        <ActivityTab
          privateMode={privateMode}
          customActivities={customActivities}
          onCreate={() => onOverlay('create')}
          onEvents={() => onOverlay('events')}
          onOpenActivity={(title) => onToast(`${title} receipt and lineage opened`)}
        />
      );
      break;
    case 'holdings':
      content = (
        <HoldingsTab
          privateMode={privateMode}
          onCreate={() => onOverlay('create')}
          onToast={onToast}
          trades={portfolioTrades}
        />
      );
      break;
    case 'cash-flow':
      content = (
        <CashFlowTab
          customCashFlows={cashFlows}
          privateMode={privateMode}
          onCreate={() => onOverlay('cashflow')}
          onOpenRecurring={(title) => onToast(`${title} recurring rule opened`)}
          onReview={() => onOverlay('review')}
        />
      );
      break;
    case 'analysis':
      content =
        direction === 'origin' ? (
          <OriginAnalytics
            onOpenWorkbench={onOpenWorkbench}
            onToast={onToast}
            privateMode={privateMode}
            scopeName={scope.name}
          />
        ) : (
          <AnalysisTab privateMode={privateMode} />
        );
      break;
    case 'plan':
      content =
        direction === 'origin' ? (
          <div className="origin-plan-workspace">
            <nav aria-label="Plan sections" className="origin-plan-switcher" role="tablist">
              <button
                aria-controls="origin-plan-goals-panel"
                aria-selected={originPlanSection === 'goals'}
                className={originPlanSection === 'goals' ? 'is-active' : undefined}
                id="origin-plan-goals"
                onClick={() => setOriginPlanSection('goals')}
                role="tab"
                type="button"
              >
                <Icon name="target" size={15} />
                <span>
                  <strong>Goals</strong>
                  <small>Targets, funding, and projections</small>
                </span>
              </button>
              <button
                aria-controls="origin-plan-continuity-panel"
                aria-selected={originPlanSection === 'continuity'}
                className={originPlanSection === 'continuity' ? 'is-active' : undefined}
                id="origin-plan-continuity"
                onClick={() => setOriginPlanSection('continuity')}
                role="tab"
                type="button"
              >
                <Icon name="shield" size={15} />
                <span>
                  <strong>Protection & continuity</strong>
                  <small>Coverage, beneficiaries, and handoff</small>
                </span>
              </button>
            </nav>
            <div
              aria-labelledby="origin-plan-goals"
              hidden={originPlanSection !== 'goals'}
              id="origin-plan-goals-panel"
              role="tabpanel"
            >
              <OriginGoals
                onAssistant={(context) => {
                  onToast(`BetterTrack opened with ${context}`);
                  onOverlay('assistant');
                }}
                onOpenWorkbench={onOpenWorkbench}
                onSubmitProposal={onReviewProposal}
                onToast={onToast}
                portfolio={{
                  id: scope.id,
                  name: scope.name,
                  value: scope.value,
                  currency: 'EUR',
                }}
                privateMode={privateMode}
              />
            </div>
            <div
              aria-labelledby="origin-plan-continuity"
              hidden={originPlanSection !== 'continuity'}
              id="origin-plan-continuity-panel"
              role="tabpanel"
            >
              <OriginContinuity
                onOpenFiles={() => onTab('files')}
                onOpenReview={() => onOverlay('review')}
                onOpenSecurity={onSecurity}
                onOpenWorkbench={onOpenWorkbench}
                onSubmitProposal={(proposal) => onReviewProposal(proposal, false)}
                onToast={onToast}
                portfolio={{
                  id: scope.id,
                  name: scope.name,
                  value: scope.value,
                  currency: 'EUR',
                }}
                privateMode={privateMode}
              />
            </div>
          </div>
        ) : (
          <PlanTab privateMode={privateMode} onAssistant={() => onOverlay('assistant')} />
        );
      break;
    case 'automate':
      content =
        direction === 'origin' ? (
          <OriginAutomation
            availableCash={availableCash}
            onRecordActivity={onAutomationActivity}
            onSubmitProposal={onAutomationProposal}
            onToast={onToast}
            portfolio={scope.name}
          />
        ) : (
          <AutomateTab privateMode={privateMode} onConnections={() => onOverlay('connections')} />
        );
      break;
    case 'files':
      content =
        direction === 'origin' ? (
          <OriginDocuments
            driveConnected={driveConnected}
            onConnections={() => onOverlay('connections')}
            onImport={() => onOverlay('import')}
            onToast={onToast}
            portfolio={scope.name}
          />
        ) : (
          <FilesTab
            driveConnected={driveConnected}
            onConnections={() => onOverlay('connections')}
          />
        );
      break;
    case 'people':
      content =
        direction === 'origin' ? (
          <OriginCollaboration
            externalShares={portfolioShares}
            onOpenShare={(context) => {
              onToast(
                context.source === 'group'
                  ? `${context.group?.name ?? 'Group'} prepared for scoped sharing`
                  : 'Collaboration access builder opened',
              );
              onOverlay('share');
            }}
            onSubmitProposal={onCollaborationProposal}
            onToast={onToast}
            portfolio={{
              id: scope.id,
              name: scope.name,
              owner: 'Alex Morgan',
              value: scope.value,
              currency: 'EUR',
            }}
          />
        ) : (
          <PortfolioPeopleTab onInvite={() => onOverlay('invite')} />
        );
      break;
    case 'tax':
      content =
        direction === 'origin' ? (
          <OriginTax
            onOpenFiles={() => onTab('files')}
            onOpenReview={() => onOverlay('review')}
            onOpenShare={() => onOverlay('share')}
            onSubmitReview={onReviewProposal}
            onToast={onToast}
            portfolio={{ id: scope.id, name: scope.name, currency: 'EUR' }}
            privateMode={privateMode}
            trades={portfolioTrades}
          />
        ) : (
          <PortfolioTaxTab privateMode={privateMode} />
        );
      break;
    case 'overview':
    default:
      content = (
        <PortfolioOverview
          scope={scope}
          detailed={direction === 'origin'}
          privateMode={privateMode}
          onTab={onTab}
          onDataHealth={onDataHealth}
          onToast={onToast}
          availableCash={availableCash}
          latestTrade={latestTrade}
          trades={portfolioTrades}
        />
      );
  }
  return (
    <div className="portfolio-detail">
      <PortfolioHeader
        scope={scope}
        tab={tab}
        onTab={onTab}
        onCreate={() => onOverlay('create')}
        onShare={() => onOverlay('share')}
        onStructure={() => onOverlay('structure')}
        onSettings={() => onOverlay('portfolio-settings')}
      />
      <div className="page portfolio-detail__content">{content}</div>
    </div>
  );
}

function WorkbenchPage({
  scope,
  availableScopes,
  direction,
  privateMode,
  activeView,
  onView,
  onAssistant,
  onCollaborate,
  onOpenGoals,
  onOpenTax,
  onSubmitProposal,
  onToast,
  onScope,
}: {
  scope: Scope;
  availableScopes: Scope[];
  direction: DesignDirection;
  privateMode: boolean;
  activeView: WorkbenchView;
  onView: (view: WorkbenchView) => void;
  onAssistant: () => void;
  onCollaborate: () => void;
  onOpenGoals: () => void;
  onOpenTax: () => void;
  onSubmitProposal: (entry: OriginReviewEntry) => void;
  onToast: (message: string) => void;
  onScope: (scope: Scope) => void;
}) {
  const [monthly, setMonthly] = useState(200);
  const [assetSymbol, setAssetSymbol] = useState<'VWCE' | 'VAGF' | 'CASH'>('VWCE');
  const [durationYears, setDurationYears] = useState(10);
  const [reviewing, setReviewing] = useState(false);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const scenarioAssets = {
    VWCE: { name: 'Vanguard All-World', annualReturn: 0.058 },
    VAGF: { name: 'Vanguard Global Bond', annualReturn: 0.032 },
    CASH: { name: 'Cash reserve', annualReturn: 0.018 },
  } as const;
  const selectedAsset = scenarioAssets[assetSymbol];
  const projectionMonths = durationYears * 12;
  const baseProjected = Math.round(
    buildProjectionSeries(scope.value, 0.045, 0, projectionMonths).at(-1) ?? scope.value,
  );
  const projected = Math.round(
    buildProjectionSeries(scope.value, selectedAsset.annualReturn, monthly, projectionMonths).at(
      -1,
    ) ?? scope.value,
  );
  const estimatedGrowth = projected - scope.value - monthly * projectionMonths;
  const workbenchViews: WorkbenchView[] = [
    'Studio',
    'Rebalance',
    'Forecasts',
    'Blueprints',
    'Backtests',
    'Compare',
    'Ideas',
    'Calculators',
    'Alerts',
  ];
  const secondaryAction =
    activeView !== 'Studio' && activeView !== 'Rebalance'
      ? (
          {
            Forecasts: { label: 'New forecast', icon: 'activity' },
            Blueprints: { label: 'New Blueprint', icon: 'layers' },
            Backtests: { label: 'New backtest', icon: 'activity' },
            Compare: { label: 'Add comparison', icon: 'grid' },
            Ideas: { label: 'Capture idea', icon: 'sparkles' },
            Calculators: { label: 'Open calculator', icon: 'workbench' },
            Alerts: { label: 'New alert', icon: 'bell' },
          } satisfies Record<WorkbenchSecondaryViewName, { label: string; icon: IconName }>
        )[activeView]
      : null;
  return (
    <div className="page workbench-page">
      <div className="page-intro">
        <h1>Workbench</h1>
        <div className="page-intro__actions">
          {activeView === 'Studio' ? (
            <>
              <Button variant="secondary" icon="folder" onClick={() => onView('Ideas')}>
                Open saved
              </Button>
              <Button
                variant="primary"
                icon="plus"
                onClick={() => {
                  setMonthly(200);
                  onView('Studio');
                }}
              >
                New scenario
              </Button>
            </>
          ) : secondaryAction ? (
            <Button
              variant="primary"
              icon={secondaryAction.icon}
              onClick={() => {
                if (activeView === 'Calculators') onView('Studio');
                else onToast(`${secondaryAction.label} opened as a local ${scope.name} draft`);
              }}
            >
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      </div>
      <nav className="workbench-tabs">
        {workbenchViews.map((item) => (
          <button
            aria-current={activeView === item ? 'page' : undefined}
            className={activeView === item ? 'is-active' : ''}
            key={item}
            onClick={() => onView(item)}
            type="button"
          >
            {item}
          </button>
        ))}
      </nav>

      {activeView === 'Rebalance' && scope.id === 'all' ? (
        <section className="workbench-scope-guard">
          <span>
            <Icon name="portfolio" />
          </span>
          <div>
            <p className="eyebrow">PORTFOLIO-SCOPED DECISION</p>
            <h2>Choose one portfolio to rebalance.</h2>
            <p>
              All wealth is an aggregate view. Rebalancing needs one authoritative ledger, cash
              balance, tax profile, and approval policy.
            </p>
            <div>
              {availableScopes
                .filter((candidate) => candidate.id !== 'all')
                .slice(0, 5)
                .map((candidate) => (
                  <button key={candidate.id} onClick={() => onScope(candidate)} type="button">
                    <span>
                      <strong>{candidate.name}</strong>
                      <small>{candidate.eyebrow}</small>
                    </span>
                    <Money value={candidate.value} privateMode={privateMode} compact />
                    <Icon name="arrow-right" size={13} />
                  </button>
                ))}
            </div>
          </div>
        </section>
      ) : activeView === 'Rebalance' ? (
        <OriginRebalance
          onBack={() => onView('Studio')}
          onOpenGoals={onOpenGoals}
          onOpenTax={onOpenTax}
          onSubmitReview={onSubmitProposal}
          onToast={onToast}
          portfolio={{
            id: scope.id === 'all' ? 'personal' : scope.id,
            name: scope.id === 'all' ? 'Personal wealth' : scope.name,
            value: scope.id === 'all' ? scopes[1]!.value : scope.value,
            currency: 'EUR',
          }}
          privateMode={privateMode}
        />
      ) : activeView === 'Studio' ? (
        <>
          <div className="studio-header">
            <div>
              <span className="draft-badge">DRAFT</span>
              <h2>Build wealth with a monthly index plan</h2>
            </div>
            <div>
              <AvatarStack />
              <Button variant="secondary" icon="share" onClick={onCollaborate}>
                Collaborate
              </Button>
              <Button variant="primary" icon="check" onClick={() => setReviewing(true)}>
                Review to apply
              </Button>
            </div>
          </div>

          <div className="studio-grid">
            <aside className="card studio-controls">
              <div className="studio-step is-active">
                <span>1</span>
                <div>
                  <strong>Monthly contribution</strong>
                </div>
              </div>
              <div className="scenario-control">
                <label htmlFor="monthly-contribution">
                  Monthly amount
                  <strong>{moneyFormatter.format(monthly)}</strong>
                </label>
                <input
                  id="monthly-contribution"
                  type="range"
                  min="0"
                  max="1000"
                  step="50"
                  value={monthly}
                  onChange={(event) => setMonthly(Number(event.target.value))}
                />
                <div>
                  <button type="button" onClick={() => setMonthly(100)}>
                    €100
                  </button>
                  <button type="button" onClick={() => setMonthly(200)}>
                    €200
                  </button>
                  <button type="button" onClick={() => setMonthly(500)}>
                    €500
                  </button>
                </div>
                <label>
                  Buy
                  <select
                    aria-label="Scenario asset"
                    onChange={(event) =>
                      setAssetSymbol(event.target.value as 'VWCE' | 'VAGF' | 'CASH')
                    }
                    value={assetSymbol}
                  >
                    {Object.entries(scenarioAssets).map(([symbol, asset]) => (
                      <option key={symbol} value={symbol}>
                        {symbol} · {asset.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Duration
                  <select
                    aria-label="Scenario duration"
                    onChange={(event) => setDurationYears(Number(event.target.value))}
                    value={durationYears}
                  >
                    {[5, 10, 15, 20, 30].map((years) => (
                      <option key={years} value={years}>
                        {years} years
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="studio-step">
                <span>2</span>
                <div>
                  <strong>Assumptions</strong>
                </div>
                <Icon name="chevron-down" size={14} />
              </div>
              <button className="ai-draft-button" type="button" onClick={onAssistant}>
                <Icon name="sparkles" size={16} />
                Describe a different scenario
              </button>
            </aside>

            <section className="card studio-output">
              <div className="studio-output__header">
                <div>
                  <span className="metric-label">Projected portfolio value</span>
                  <div className="hero-value">
                    <Money value={projected} privateMode={privateMode} />
                  </div>
                  <span className="projection-delta">
                    <strong>
                      +<Money value={projected - baseProjected} privateMode={privateMode} compact />
                    </strong>{' '}
                    versus doing nothing
                  </span>
                </div>
                <div className="scenario-legend">
                  <span>
                    <i className="scenario-legend__base" />
                    Current path
                  </span>
                  <span>
                    <i className="scenario-legend__new" />
                    This scenario
                  </span>
                </div>
              </div>
              {direction === 'origin' ? (
                <ScenarioProjectionChart
                  monthly={monthly}
                  privateMode={privateMode}
                  startingValue={scope.value}
                  annualReturn={selectedAsset.annualReturn}
                  durationYears={durationYears}
                />
              ) : (
                <div className="projection-chart">
                  <svg
                    preserveAspectRatio="none"
                    viewBox="0 0 900 300"
                    aria-label="Scenario projection"
                  >
                    <defs>
                      <linearGradient id="scenario-area" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0" stopColor="#d9b778" stopOpacity=".24" />
                        <stop offset="1" stopColor="#d9b778" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <g className="chart-grid">
                      <line x1="0" x2="900" y1="35" y2="35" />
                      <line x1="0" x2="900" y1="110" y2="110" />
                      <line x1="0" x2="900" y1="185" y2="185" />
                      <line x1="0" x2="900" y1="260" y2="260" />
                    </g>
                    <path
                      d="M10 260 C120 245,180 225,260 205 S420 160,520 130 S700 75,890 28 L890 265 L10 265Z"
                      fill="url(#scenario-area)"
                    />
                    <path
                      className="projection-base"
                      d="M10 260 C150 250,250 230,360 214 S610 175,890 125"
                    />
                    <path
                      className="projection-new"
                      d="M10 260 C120 245,180 225,260 205 S420 160,520 130 S700 75,890 28"
                    />
                    <circle cx="890" cy="28" r="6" className="projection-dot" />
                  </svg>
                  <div>
                    <span>Today</span>
                    <span>2029</span>
                    <span>2032</span>
                    <span>2036</span>
                  </div>
                </div>
              )}
              <div className="projection-summary">
                <span>
                  <small>Total contributions</small>
                  <strong>
                    <Money value={monthly * projectionMonths} privateMode={privateMode} />
                  </strong>
                </span>
                <span>
                  <small>Estimated growth</small>
                  <strong className="positive">
                    <Money value={estimatedGrowth} privateMode={privateMode} showPlus />
                  </strong>
                </span>
                <span>
                  <small>Expected return</small>
                  <strong>{(selectedAsset.annualReturn * 100).toFixed(1)}% p.a.</strong>
                </span>
                <span>
                  <small>Estimated fees</small>
                  <strong>0.22% p.a.</strong>
                </span>
              </div>
              <div className="assumption-note">
                <Icon name="help" size={15} />
                <span>
                  Projection, not a promise. Range uses historical volatility, 2% inflation, and
                  your Austrian tax profile.
                </span>
                <button
                  aria-expanded={assumptionsOpen}
                  onClick={() => setAssumptionsOpen((current) => !current)}
                  type="button"
                >
                  {assumptionsOpen ? 'Hide assumptions' : 'Assumptions'}
                </button>
              </div>
              {assumptionsOpen ? (
                <dl className="scenario-assumptions">
                  <div>
                    <dt>Nominal return</dt>
                    <dd>{(selectedAsset.annualReturn * 100).toFixed(1)}% p.a.</dd>
                  </div>
                  <div>
                    <dt>Inflation</dt>
                    <dd>2.0% p.a.</dd>
                  </div>
                  <div>
                    <dt>Product fee</dt>
                    <dd>{assetSymbol === 'CASH' ? '0.00%' : '0.22%'} p.a.</dd>
                  </div>
                  <div>
                    <dt>Tax model</dt>
                    <dd>Austria · 27.5% KESt</dd>
                  </div>
                  <div>
                    <dt>Contribution timing</dt>
                    <dd>Last business day monthly</dd>
                  </div>
                </dl>
              ) : null}
            </section>
          </div>
        </>
      ) : (
        <WorkbenchSecondaryView
          privateMode={privateMode}
          scope={scope}
          view={activeView}
          onOpenStudio={() => onView('Studio')}
          onToast={onToast}
        />
      )}
      {reviewing ? (
        <ScenarioReview
          assetName={selectedAsset.name}
          assetSymbol={assetSymbol}
          durationYears={durationYears}
          monthly={monthly}
          projected={projected}
          scope={scope}
          privateMode={privateMode}
          onClose={() => setReviewing(false)}
          onConfirm={() => {
            onSubmitProposal({
              id: `workbench_dca_${assetSymbol}_${durationYears}_${monthly}`,
              kind: 'automation',
              title: `Review €${monthly} monthly ${assetSymbol} automation`,
              summary:
                'A saved Workbench scenario is ready to become a proposal-controlled automation.',
              portfolio: scope.name,
              source: {
                label: 'Workbench scenario',
                actor: 'Alex Morgan',
                detail: 'Build wealth with a monthly index plan',
              },
              requestedAt: '2026-07-27T10:42:00+02:00',
              priority: 'normal',
              risk: 'medium',
              tags: ['Workbench', assetSymbol, `${durationYears}Y`, 'Automation'],
              diff: [
                {
                  label: 'Automation',
                  before: 'None',
                  after: `€${monthly} monthly into ${assetSymbol} for ${durationYears} years`,
                },
                { label: 'First run', before: '—', after: '31 August 2026' },
                { label: 'Approval', before: '—', after: 'Review each run' },
              ],
              calculations: [
                {
                  label: `Projected value in ${2026 + durationYears}`,
                  value: moneyFormatter.format(projected),
                },
                {
                  label: 'Contributions',
                  value: moneyFormatter.format(monthly * projectionMonths),
                },
                { label: 'Cash floor', value: '4.7 months', tone: 'warning' },
              ],
              lineage: [
                {
                  label: 'Scenario v3',
                  detail: `${scope.name} · current holdings and Austrian tax profile`,
                  state: 'derived',
                },
              ],
              permissions: [
                { label: 'Read portfolio inputs', outcome: 'allowed' },
                { label: 'Create automation', outcome: 'review' },
              ],
              policies: [
                {
                  title: 'No scenario writes directly',
                  description: 'The proposal remains pending until an owner decides.',
                  status: 'pass',
                },
              ],
            });
            setReviewing(false);
          }}
        />
      ) : null}
    </div>
  );
}

function ScenarioReview({
  assetName,
  assetSymbol,
  durationYears,
  monthly,
  projected,
  scope,
  privateMode,
  onClose,
  onConfirm,
}: {
  assetName: string;
  assetSymbol: string;
  durationYears: number;
  monthly: number;
  projected: number;
  scope: Scope;
  privateMode: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <OverlayShell
      title="Review scenario"
      description="Nothing changes until you approve the final proposal."
      onClose={onClose}
      wide
    >
      <div className="scenario-review">
        <div className="scenario-review__status">
          <span>
            <Icon name="shield" />
          </span>
          <span>
            <small>READY FOR REVIEW</small>
            <strong>Build wealth with a monthly index plan</strong>
            <p>The scenario is internally consistent and uses your current tax profile.</p>
          </span>
        </div>
        <div className="scenario-review__flow">
          <span>
            <small>FROM</small>
            <strong>{scope.name}</strong>
            <em>Cash & equivalents</em>
          </span>
          <Icon name="arrow-right" />
          <span>
            <small>EVERY MONTH</small>
            <strong>
              <Money value={monthly} privateMode={privateMode} />
            </strong>
            <em>Last business day</em>
          </span>
          <Icon name="arrow-right" />
          <span>
            <small>INTO</small>
            <strong>{assetSymbol}</strong>
            <em>{assetName}</em>
          </span>
        </div>
        <dl className="scenario-review__facts">
          <div>
            <dt>Projected value in {2026 + durationYears}</dt>
            <dd>
              <Money value={projected} privateMode={privateMode} />
            </dd>
          </div>
          <div>
            <dt>Total contribution</dt>
            <dd>
              <Money value={monthly * durationYears * 12} privateMode={privateMode} />
            </dd>
          </div>
          <div>
            <dt>Permission</dt>
            <dd>Proposal only</dd>
          </div>
          <div>
            <dt>First run</dt>
            <dd>31 August 2026</dd>
          </div>
        </dl>
        <div className="scenario-review__warning">
          <Icon name="help" />
          <span>
            <strong>This demo will not place a trade.</strong>
            <small>
              In production, final approval creates a scoped automation and every run appears in
              Review before execution.
            </small>
          </span>
        </div>
        <div className="modal__footer">
          <Button variant="ghost" onClick={onClose}>
            Keep editing
          </Button>
          <Button variant="primary" icon="check" onClick={onConfirm}>
            Send to Review
          </Button>
        </div>
      </div>
    </OverlayShell>
  );
}

function WorkbenchSecondaryView({
  view,
  scope,
  privateMode,
  onOpenStudio,
  onToast,
}: {
  view: WorkbenchSecondaryViewName;
  scope: Scope;
  privateMode: boolean;
  onOpenStudio: () => void;
  onToast: (message: string) => void;
}) {
  const [forecastRange, setForecastRange] = useState<'10Y' | '25Y' | 'ALL'>('25Y');
  const [blueprintFilter, setBlueprintFilter] = useState<'Yours' | 'Shared' | 'Discover'>('Yours');

  return (
    <section className="workbench-secondary">
      {view === 'Forecasts' ? (
        <div className="forecast-workspace">
          <section className="card forecast-chart-card">
            <div className="feature-card-heading">
              <span>
                <small>BASE FORECAST · {scope.name.toUpperCase()}</small>
                <h3>Freedom at 57</h3>
              </span>
              <div className="range-switcher">
                {(['10Y', '25Y', 'ALL'] as const).map((range) => (
                  <button
                    className={forecastRange === range ? 'is-active' : undefined}
                    key={range}
                    onClick={() => setForecastRange(range)}
                    type="button"
                  >
                    {range}
                  </button>
                ))}
              </div>
            </div>
            <div className="forecast-kpis">
              <span>
                <small>Projected net worth</small>
                <strong>
                  <Money value={1_482_000} privateMode={privateMode} compact />
                </strong>
              </span>
              <span>
                <small>Plan confidence</small>
                <strong className="positive">82%</strong>
              </span>
              <span>
                <small>Lowest cash buffer</small>
                <strong>4.6 mo</strong>
              </span>
            </div>
            <div className="forecast-visual">
              <svg viewBox="0 0 900 260" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="forecast-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="var(--chart-neutral)" stopOpacity=".25" />
                    <stop offset="1" stopColor="var(--chart-neutral)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <g className="chart-grid">
                  <line x1="0" x2="900" y1="45" y2="45" />
                  <line x1="0" x2="900" y1="125" y2="125" />
                  <line x1="0" x2="900" y1="205" y2="205" />
                </g>
                <path
                  d="M5 223 C110 215 150 192 220 183 S340 145 420 152 S540 112 620 91 S750 68 895 27 L895 245 L5 245Z"
                  fill="url(#forecast-fill)"
                />
                <path
                  className="feature-chart-line"
                  d="M5 223 C110 215 150 192 220 183 S340 145 420 152 S540 112 620 91 S750 68 895 27"
                />
                <line className="forecast-goal-line" x1="610" x2="610" y1="25" y2="240" />
              </svg>
              <span className="forecast-goal-label">Financial freedom · 2043</span>
              <div>
                <span>Today</span>
                <span>2032</span>
                <span>2040</span>
                <span>2050</span>
              </div>
            </div>
          </section>
          <aside className="card forecast-events">
            <div className="feature-card-heading">
              <span>
                <small>ASSUMPTIONS & EVENTS</small>
                <h3>What shapes this path</h3>
              </span>
              <button
                onClick={() => onToast('Forecast assumptions opened in a safe local draft')}
                type="button"
              >
                <Icon name="sliders" size={14} /> Edit
              </button>
            </div>
            {[
              ['2028', 'Increase monthly investing', '+€300 / month', 'arrow-up'],
              ['2031', 'Mortgage repricing', '3.2% estimated', 'house'],
              ['2036', 'Northstar Studio exit', '€210K net estimate', 'briefcase'],
              ['2043', 'Target freedom date', '€3,800 monthly income', 'target'],
            ].map(([date, title, meta, icon]) => (
              <button
                key={title}
                onClick={() => onToast(`${title} opened in the forecast timeline`)}
                type="button"
              >
                <em>{date}</em>
                <span>
                  <Icon name={icon as IconName} />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{meta}</small>
                </span>
                <Icon name="chevron-right" size={13} />
              </button>
            ))}
            <button
              className="feature-add-row"
              onClick={() => onToast('New life-event draft added to the forecast')}
              type="button"
            >
              <Icon name="plus" size={14} /> Add life event
            </button>
          </aside>
        </div>
      ) : null}

      {view === 'Blueprints' ? (
        <div className="blueprint-library">
          <div className="library-toolbar">
            <div className="search-field">
              <Icon name="search" size={15} />
              <input aria-label="Search Blueprints" placeholder="Search Blueprints…" />
            </div>
            {(['Yours', 'Shared', 'Discover'] as const).map((filter) => (
              <button
                className={blueprintFilter === filter ? 'filter-chip is-active' : 'filter-chip'}
                key={filter}
                onClick={() => setBlueprintFilter(filter)}
                type="button"
              >
                {filter}
              </button>
            ))}
          </div>
          <div className="blueprint-library__grid">
            {[
              [
                'Global Core',
                '70 / 15 / 10 / 5',
                '4 building blocks',
                'Used by 3 portfolios',
                'sand',
              ],
              [
                'Income Builder',
                'Dividend + quality',
                '8 building blocks',
                'Used by Personal wealth',
                'sage',
              ],
              [
                'Company Reserve',
                'Capital preservation',
                'Cash + bonds + gold',
                'Draft · updated today',
                'blue',
              ],
              [
                'Climate Tilt',
                'Global equity overlay',
                '6 building blocks',
                'Shared by Jonas',
                'rose',
              ],
            ].map(([title, allocation, assets, usage, tone], index) => (
              <button
                className="card blueprint-library-card"
                key={title}
                onClick={onOpenStudio}
                type="button"
              >
                <div className={`blueprint-orbit blueprint-orbit--${tone}`}>
                  <span>{index + 2}</span>
                  <i />
                  <i />
                  <i />
                </div>
                <span className="status-pill">{index === 2 ? 'DRAFT' : 'ACTIVE'}</span>
                <h3>{title}</h3>
                <p>{allocation}</p>
                <dl>
                  <div>
                    <dt>Composition</dt>
                    <dd>{assets}</dd>
                  </div>
                  <div>
                    <dt>Usage</dt>
                    <dd>{usage}</dd>
                  </div>
                </dl>
                <span className="blueprint-library-card__footer">
                  Open Blueprint <Icon name="arrow-right" size={13} />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {view === 'Backtests' ? (
        <div className="backtest-workspace">
          <aside className="card backtest-controls">
            <div className="feature-card-heading">
              <span>
                <small>TEST DEFINITION</small>
                <h3>Global Core vs benchmark</h3>
              </span>
            </div>
            {[
              ['Strategy', 'Global Core v3'],
              ['Benchmark', 'FTSE All-World'],
              ['Period', 'Jan 2008 – Today'],
              ['Starting value', '€10,000'],
              ['Contribution', '€500 monthly'],
              ['Rebalance', '5% drift bands'],
            ].map(([label, value]) => (
              <button
                key={label}
                onClick={() => onToast(`${label} backtest input opened for editing`)}
                type="button"
              >
                <span>
                  <small>{label}</small>
                  <strong>{value}</strong>
                </span>
                <Icon name="chevron-down" size={13} />
              </button>
            ))}
            <Button
              variant="primary"
              icon="activity"
              onClick={() => onToast('Backtest recalculated locally with fees and contributions')}
            >
              Run backtest
            </Button>
          </aside>
          <section className="card backtest-result">
            <div className="feature-card-heading">
              <span>
                <small>RESULT · EUR · FEES INCLUDED</small>
                <h3>Growth of contributions</h3>
              </span>
              <span className="result-ready">
                <StatusDot /> Calculated locally
              </span>
            </div>
            <div className="backtest-metrics">
              {[
                ['Ending value', '€182,440', '+€7,920 vs benchmark'],
                ['Annual return', '8.42%', '+0.48 pp'],
                ['Max drawdown', '−31.8%', 'Recovered in 19 mo'],
                ['Volatility', '14.2%', 'Similar risk'],
              ].map(([label, value, meta], index) => (
                <span key={label}>
                  <small>{label}</small>
                  <strong className={index === 1 ? 'positive' : ''}>{value}</strong>
                  <em>{meta}</em>
                </span>
              ))}
            </div>
            <div className="backtest-chart">
              <svg viewBox="0 0 900 250" preserveAspectRatio="none">
                <g className="chart-grid">
                  <line x1="0" x2="900" y1="45" y2="45" />
                  <line x1="0" x2="900" y1="125" y2="125" />
                  <line x1="0" x2="900" y1="205" y2="205" />
                </g>
                <path
                  className="backtest-benchmark"
                  d="M5 225 C120 215 150 190 245 183 S350 156 405 163 S500 122 570 134 S660 84 735 91 S825 49 895 38"
                />
                <path
                  className="feature-chart-line"
                  d="M5 225 C100 216 160 182 245 176 S350 143 405 153 S500 105 570 122 S660 67 735 78 S825 37 895 22"
                />
              </svg>
              <div>
                <span>2008</span>
                <span>2014</span>
                <span>2020</span>
                <span>Today</span>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {view === 'Compare' ? (
        <div className="compare-workspace">
          <div className="compare-header-row">
            <span>Metric</span>
            {[
              ['Personal wealth', 'ACTUAL', 'sand'],
              ['Monthly index plan', 'SCENARIO', 'sage'],
              ['Global Core', 'BLUEPRINT', 'blue'],
            ].map(([title, type, tone]) => (
              <button
                key={title}
                onClick={() => onToast(`${title} comparison source opened`)}
                type="button"
              >
                <span className={`compare-mark compare-mark--${tone}`}>
                  <Icon
                    name={
                      type === 'ACTUAL' ? 'portfolio' : type === 'SCENARIO' ? 'workbench' : 'layers'
                    }
                  />
                </span>
                <span>
                  <small>{type}</small>
                  <strong>{title}</strong>
                </span>
                <Icon name="chevron-down" size={13} />
              </button>
            ))}
            <button
              className="compare-add"
              onClick={() => onToast('Comparison picker opened with portfolio-scoped sources')}
              type="button"
            >
              <Icon name="plus" /> Add
            </button>
          </div>
          <section className="card compare-chart-card">
            <div className="feature-card-heading">
              <span>
                <small>COMMON PERIOD · 1 YEAR</small>
                <h3>Performance comparison</h3>
              </span>
              <button
                onClick={() => onToast('Comparison normalized to a shared EUR start value')}
                type="button"
              >
                <Icon name="sliders" size={14} /> Normalize
              </button>
            </div>
            <div className="compare-chart">
              <svg viewBox="0 0 900 240" preserveAspectRatio="none">
                <g className="chart-grid">
                  <line x1="0" x2="900" y1="40" y2="40" />
                  <line x1="0" x2="900" y1="120" y2="120" />
                  <line x1="0" x2="900" y1="200" y2="200" />
                </g>
                <path
                  className="compare-line compare-line--one"
                  d="M5 190 C130 173 180 181 260 145 S390 159 470 115 S610 123 700 80 S820 72 895 42"
                />
                <path
                  className="compare-line compare-line--two"
                  d="M5 190 C110 180 185 165 260 154 S390 125 470 110 S610 88 700 70 S820 45 895 30"
                />
                <path
                  className="compare-line compare-line--three"
                  d="M5 190 C110 190 185 170 260 161 S390 147 470 124 S610 130 700 95 S820 102 895 61"
                />
              </svg>
              <div>
                <span>Jul 2025</span>
                <span>Oct</span>
                <span>Jan</span>
                <span>Apr</span>
                <span>Today</span>
              </div>
            </div>
          </section>
          <div className="compare-matrix card">
            {[
              ['Return', '+12.48%', '+13.82%', '+10.91%'],
              ['Volatility', '13.6%', '12.1%', '11.8%'],
              ['Max drawdown', '−8.9%', '−7.4%', '−6.8%'],
              ['Fees', '0.31%', '0.22%', '0.28%'],
              ['Sustainability coverage', '78%', '91%', '84%'],
            ].map((row) => (
              <div key={row[0]}>
                {row.map((cell, index) => (
                  <span className={index === 2 && row[0] === 'Return' ? 'positive' : ''} key={cell}>
                    {cell}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {view === 'Ideas' ? (
        <div className="ideas-board">
          {[
            ['CAPTURED', ['Reduce single-stock exposure', 'Test inflation-linked bonds']],
            ['RESEARCHING', ['Replace two overlapping ETFs', 'Northstar Studio exit allocation']],
            ['READY TO TEST', ['Increase VWCE to €500 monthly', 'Riverside early repayment']],
            ['DECIDED', ['Global Core v3', 'Keep six-month company reserve']],
          ].map(([column, rawItems], columnIndex) => {
            const items = rawItems as string[];
            return (
              <section key={column as string}>
                <header>
                  <span>{column as string}</span>
                  <em>{items.length}</em>
                </header>
                {items.map((item, index) => (
                  <button
                    className="card idea-card"
                    key={item}
                    onClick={() => onToast(`${item} opened with its notes, sources, and decisions`)}
                    type="button"
                  >
                    <span className={`idea-kind idea-kind--${columnIndex}`}>
                      <Icon
                        name={
                          columnIndex === 3 ? 'check' : columnIndex === 2 ? 'workbench' : 'document'
                        }
                      />
                    </span>
                    <strong>{item}</strong>
                    <p>
                      {index === 0
                        ? 'Attached to Personal wealth'
                        : '2 sources · updated this week'}
                    </p>
                    <span>
                      <Avatar
                        initials={index === 0 ? 'AM' : 'JL'}
                        tone={index === 0 ? 'sand' : 'blue'}
                        size="sm"
                      />
                      <em>
                        {columnIndex === 2
                          ? 'Scenario ready'
                          : columnIndex === 3
                            ? 'Applied'
                            : 'Open note'}
                      </em>
                    </span>
                  </button>
                ))}
                <button
                  className="idea-add"
                  onClick={() => onToast(`New ${String(column).toLowerCase()} idea captured`)}
                  type="button"
                >
                  <Icon name="plus" size={13} /> Add here
                </button>
              </section>
            );
          })}
        </div>
      ) : null}

      {view === 'Calculators' ? (
        <div className="calculator-library">
          <section className="card calculator-context">
            <span>
              <Icon name="portfolio" />
            </span>
            <span>
              <small>CALCULATOR CONTEXT</small>
              <strong>{scope.name}</strong>
              <p>Balances, tax profile, holdings, and cash flow can prefill every calculation.</p>
            </span>
            <button type="button">
              Change <Icon name="chevron-down" size={13} />
            </button>
          </section>
          <div className="calculator-grid">
            {[
              [
                'Contribution planner',
                'Find the monthly amount for a target value and date.',
                'target',
                'Most used',
              ],
              [
                'Safe withdrawal',
                'Explore income ranges, sequence risk, and longevity.',
                'cash',
                'Retirement',
              ],
              [
                'Rebalance impact',
                'Compare taxes, fees, drift, and expected exposure.',
                'repeat',
                'Portfolio',
              ],
              [
                'Mortgage vs invest',
                'Model repayments against market contributions.',
                'house',
                'Decision',
              ],
              [
                'Dividend forecast',
                'Estimate distributions from current and planned holdings.',
                'calendar',
                'Income',
              ],
              [
                'Tax realization',
                'Preview gains, losses, allowances, and lot selection.',
                'document',
                'Austria',
              ],
            ].map(([title, description, icon, tag]) => (
              <button
                className="card calculator-card"
                key={title}
                onClick={onOpenStudio}
                type="button"
              >
                <span>
                  <Icon name={icon as IconName} />
                </span>
                <em>{tag}</em>
                <h3>{title}</h3>
                <p>{description}</p>
                <strong>
                  Open in context <Icon name="arrow-right" size={13} />
                </strong>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {view === 'Alerts' ? (
        <div className="alerts-workspace">
          <div className="alerts-summary-strip">
            {[
              ['12', 'Active rules', 'Across 4 portfolios', 'bell'],
              ['3', 'Triggered this week', '2 resolved', 'activity'],
              ['4', 'Delivery channels', 'All healthy', 'link'],
              ['0', 'Muted critical alerts', 'Coverage complete', 'shield'],
            ].map(([value, label, meta, icon]) => (
              <div key={label}>
                <span>
                  <Icon name={icon as IconName} />
                </span>
                <strong>{value}</strong>
                <small>{label}</small>
                <em>{meta}</em>
              </div>
            ))}
          </div>
          <div className="alerts-main">
            <section className="alerts-rules">
              <div className="feature-card-heading">
                <span>
                  <small>LIVE RULES</small>
                  <h3>Conditions worth your attention</h3>
                </span>
                <button onClick={() => onToast('Alert portfolio filter opened')} type="button">
                  All portfolios <Icon name="chevron-down" size={13} />
                </button>
              </div>
              <div className="alerts-rules__head">
                <span>Rule</span>
                <span>Scope</span>
                <span>Condition</span>
                <span>Last event</span>
                <span>Status</span>
                <span />
              </div>
              {[
                [
                  'Allocation drift',
                  'Personal wealth',
                  'Global equity > 52%',
                  '18 min ago',
                  'Triggered',
                  'amber',
                ],
                [
                  'VWCE price level',
                  'Global Core',
                  'Below €124.00',
                  '2 days ago',
                  'Watching',
                  'green',
                ],
                ['Cash runway', 'Northstar Studio', 'Below 4 months', 'Never', 'Watching', 'green'],
                [
                  'Connection stale',
                  'All wealth',
                  'No sync for 48 hours',
                  '5 days ago',
                  'Resolved',
                  'blue',
                ],
                [
                  'Riverside valuation',
                  'Riverside property',
                  'Change above 4%',
                  '12 Jul',
                  'Watching',
                  'green',
                ],
              ].map(([name, portfolio, condition, event, status, tone]) => (
                <button
                  key={name}
                  onClick={() => onToast(`${name} alert rule opened with its event history`)}
                  type="button"
                >
                  <span>
                    <i className={`admin-state admin-state--${tone}`} />
                    <strong>{name}</strong>
                  </span>
                  <span>{portfolio}</span>
                  <span>{condition}</span>
                  <span>{event}</span>
                  <em className={status === 'Triggered' ? 'review-state' : 'clear-state'}>
                    {status}
                  </em>
                  <Icon name="chevron-right" size={13} />
                </button>
              ))}
            </section>
            <aside className="alerts-delivery">
              <div className="feature-card-heading">
                <span>
                  <small>DELIVERY</small>
                  <h3>Where alerts go</h3>
                </span>
              </div>
              {[
                ['In-app inbox', 'Immediate', 'inbox', true],
                ['Push notification', 'Critical and portfolio', 'bell', true],
                ['Email digest', 'Daily at 18:00', 'document', true],
                ['Discord', '#bettertrack-alerts', 'message', false],
              ].map(([name, meta, icon, enabled]) => (
                <button
                  key={String(name)}
                  onClick={() => onToast(`${name} delivery preference updated locally`)}
                  type="button"
                >
                  <span>
                    <Icon name={icon as IconName} />
                  </span>
                  <span>
                    <strong>{name}</strong>
                    <small>{meta}</small>
                  </span>
                  <i className={cn('toggle', Boolean(enabled) && 'is-on')}>
                    <em />
                  </i>
                </button>
              ))}
              <button
                className="feature-add-row"
                onClick={() => onToast('New alert delivery channel draft opened')}
                type="button"
              >
                <Icon name="plus" size={14} /> Add channel
              </button>
            </aside>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AssetsPage({
  privateMode,
  direction,
  onTrade,
  onToast,
}: {
  privateMode: boolean;
  direction: DesignDirection;
  onTrade: (asset: OriginAsset) => void;
  onToast: (message: string) => void;
}) {
  const [selected, setSelected] = useState(assetRows[0]!);
  const [activeView, setActiveView] = useState<AssetView>('Overview');
  const [activeRange, setActiveRange] = useState('1D');
  const [search, setSearch] = useState('');
  const positive = selected.change >= 0;
  const detailed = direction === 'origin';
  const quoteValue = Number(selected.price.replace(/[^\d.]/g, '').replaceAll(',', '')) || 100;
  const quoteSymbol = selected.price.startsWith('$') ? '$' : '€';
  const quoteCurrency = quoteSymbol === '$' ? 'USD' : 'EUR';
  const venue = selected.symbol === 'BTC' ? 'CRYPTO' : quoteCurrency === 'USD' ? 'NASDAQ' : 'XETRA';
  const formatQuote = (value: number) =>
    `${quoteSymbol}${value.toLocaleString('en-IE', {
      maximumFractionDigits: quoteValue > 1000 ? 0 : 2,
      minimumFractionDigits: quoteValue > 1000 ? 0 : 2,
    })}`;
  const assetViews: AssetView[] = [
    'Overview',
    'Watchlists',
    'Discover',
    'Screener',
    'News',
    'Calendar',
  ];
  const assetAction =
    activeView === 'Overview'
      ? null
      : activeView === 'Watchlists'
        ? { label: 'New watchlist', icon: 'plus' as IconName }
        : activeView === 'Screener'
          ? { label: 'Save screen', icon: 'filter' as IconName }
          : activeView === 'Calendar'
            ? { label: 'New alert', icon: 'bell' as IconName }
            : { label: 'Customize', icon: 'sliders' as IconName };
  return (
    <div className="page assets-page">
      <div className="page-intro">
        <h1>Assets</h1>
        <div className="page-intro__actions">
          {activeView === 'Overview' ? (
            <Button variant="secondary" icon="bell" onClick={() => setActiveView('Calendar')}>
              Events & alerts
            </Button>
          ) : assetAction ? (
            <Button
              variant="primary"
              icon={assetAction.icon}
              onClick={() =>
                onToast(
                  activeView === 'Watchlists'
                    ? 'New watchlist editor opened'
                    : activeView === 'Screener'
                      ? 'Screen saved with its current explainable filters'
                      : activeView === 'Calendar'
                        ? 'New portfolio-aware alert draft opened'
                        : `${activeView} preferences opened`,
                )
              }
            >
              {assetAction.label}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="asset-global-search">
        <Icon name="search" />
        <input
          aria-label="Search assets"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search stocks, ETFs, crypto, funds, or ISIN…"
          value={search}
        />
        {search.trim() ? (
          <div className="origin-asset-search-results">
            <span>
              <small>ASSETS</small>
              <em>
                {
                  assetRows.filter((asset) =>
                    `${asset.symbol} ${asset.name}`.toLowerCase().includes(search.toLowerCase()),
                  ).length
                }{' '}
                matches
              </em>
            </span>
            {assetRows
              .filter((asset) =>
                `${asset.symbol} ${asset.name}`.toLowerCase().includes(search.toLowerCase()),
              )
              .map((asset) => (
                <button
                  key={asset.symbol}
                  onClick={() => {
                    setSelected(asset);
                    setActiveView('Overview');
                    setSearch('');
                  }}
                  type="button"
                >
                  <span className="asset-symbol">{asset.symbol.slice(0, 2)}</span>
                  <span>
                    <strong>{asset.symbol}</strong>
                    <small>{asset.name}</small>
                  </span>
                  <span>
                    <strong>{privateMode ? '••••' : asset.price}</strong>
                    <small className={asset.change >= 0 ? 'positive' : 'negative'}>
                      {asset.change >= 0 ? '+' : ''}
                      {asset.change}%
                    </small>
                  </span>
                  <Icon name="arrow-right" size={14} />
                </button>
              ))}
            {!assetRows.some((asset) =>
              `${asset.symbol} ${asset.name}`.toLowerCase().includes(search.toLowerCase()),
            ) ? (
              <p>No exact demo asset yet. Try VWCE, Microsoft, Apple, Bitcoin, or iShares.</p>
            ) : null}
          </div>
        ) : null}
      </div>
      <nav className="asset-tabs">
        {assetViews.map((item) => (
          <button
            aria-current={activeView === item ? 'page' : undefined}
            className={activeView === item ? 'is-active' : ''}
            key={item}
            onClick={() => setActiveView(item)}
            type="button"
          >
            {item}
          </button>
        ))}
      </nav>
      {activeView === 'Overview' ? (
        <>
          <div className="asset-workspace">
            <section className="card market-list">
              <div className="market-list__header">
                <div>
                  <strong>Watchlist</strong>
                  <small>18 assets</small>
                </div>
                <Button variant="quiet" size="icon" aria-label="Watchlist options">
                  <Icon name="more" />
                </Button>
              </div>
              {assetRows.map((asset) => (
                <button
                  className={selected.symbol === asset.symbol ? 'is-active' : ''}
                  key={asset.symbol}
                  type="button"
                  onClick={() => setSelected(asset)}
                >
                  <span className="asset-symbol">{asset.symbol.slice(0, 2)}</span>
                  <span>
                    <strong>{asset.symbol}</strong>
                    <small>{asset.name}</small>
                  </span>
                  <MiniSparkline
                    values={asset.spark}
                    positive={asset.change >= 0}
                    width={64}
                    height={24}
                  />
                  <span>
                    <strong>{privateMode ? '••••' : asset.price}</strong>
                    <small className={asset.change >= 0 ? 'positive' : 'negative'}>
                      {asset.change >= 0 ? '+' : ''}
                      {asset.change}%
                    </small>
                  </span>
                </button>
              ))}
              <button className="market-list__footer" type="button">
                View watchlist <Icon name="arrow-right" size={13} />
              </button>
            </section>
            <section className="card asset-detail-card">
              <div className="asset-detail-header">
                <span className="asset-detail-symbol">{selected.symbol.slice(0, 2)}</span>
                <div>
                  <span>
                    <strong>{selected.name}</strong>
                    <em>
                      {selected.symbol} · {venue}
                    </em>
                  </span>
                  <span className="owned-badge">
                    <Icon name={selected.owned === 'Watchlist' ? 'eye' : 'portfolio'} size={13} />
                    {selected.owned === 'Watchlist' ? 'Watchlist' : `Owned in ${selected.owned}`}
                  </span>
                </div>
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => onTrade(originAssetFromRow(selected))}
                >
                  Add to portfolio
                </Button>
                <Button variant="quiet" size="icon" aria-label="Asset options">
                  <Icon name="more" />
                </Button>
              </div>
              <div className="asset-price-row">
                <span>
                  <strong>{privateMode ? '••••••' : selected.price}</strong>
                  <em className={positive ? 'positive' : 'negative'}>
                    {positive ? '+' : ''}
                    {selected.change}% today
                  </em>
                </span>
                <div className="range-switcher">
                  {['1D', '1W', '1M', '1Y', 'ALL'].map((item) => (
                    <button
                      className={activeRange === item ? 'is-active' : ''}
                      key={item}
                      onClick={() => setActiveRange(item)}
                      type="button"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
              {detailed ? (
                <div className="asset-analysis-layout">
                  <DetailedAssetChart
                    change={selected.change}
                    positive={positive}
                    price={selected.price}
                    privateMode={privateMode}
                    range={activeRange}
                    values={selected.spark}
                  />
                  <aside className="asset-inspector">
                    <header>
                      <span>
                        <strong>
                          {venue} · {quoteCurrency}
                        </strong>
                      </span>
                      <em>
                        <StatusDot /> Open
                      </em>
                    </header>
                    <dl>
                      {[
                        ['Open', formatQuote(quoteValue * 0.989)],
                        ['Day high', formatQuote(quoteValue * 1.002)],
                        ['Day low', formatQuote(quoteValue * 0.986)],
                        ['Prev. close', formatQuote(quoteValue / (1 + selected.change / 100))],
                        ['Volume', '1.84M'],
                        [
                          'Bid / ask',
                          `${formatQuote(quoteValue - quoteValue * 0.00012)} / ${formatQuote(
                            quoteValue + quoteValue * 0.00012,
                          )}`,
                        ],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{privateMode && label !== 'Volume' ? '••••' : value}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="asset-inspector__context">
                      <small>POSITION</small>
                      <strong>€42,740 position · +18.4%</strong>
                      <span>6.7% of All wealth · 2.1% look-through overlap</span>
                      <button type="button">
                        Inspect exposure <Icon name="arrow-right" size={13} />
                      </button>
                    </div>
                    <footer>
                      <span>D Dividend</span>
                      <span>E Earnings</span>
                    </footer>
                  </aside>
                </div>
              ) : (
                <div className={cn('asset-chart', positive ? 'is-positive' : 'is-negative')}>
                  <MiniSparkline
                    values={selected.spark}
                    positive={positive}
                    width={900}
                    height={210}
                  />
                  <div>
                    <span>09:00</span>
                    <span>11:00</span>
                    <span>13:00</span>
                    <span>15:00</span>
                    <span>Now</span>
                  </div>
                </div>
              )}
              <div className="asset-stat-grid">
                {[
                  ['Market cap', '€1.42T'],
                  ['P/E ratio', '24.8'],
                  ['Yield', '1.72%'],
                  ['52W range', '€108–€146'],
                  ['Your return', '+18.4%'],
                ].map(([label, value]) => (
                  <span key={label}>
                    <small>{label}</small>
                    <strong>{privateMode && label === 'Your return' ? '••••' : value}</strong>
                  </span>
                ))}
              </div>
            </section>
          </div>
          <div className="asset-bottom-grid">
            <section className="card news-card">
              <SectionHeading
                title="Relevant news"
                action={
                  <button className="text-link" onClick={() => setActiveView('News')} type="button">
                    All news <Icon name="arrow-right" size={13} />
                  </button>
                }
              />
              {[
                [
                  'Markets price in a calmer path for European rates',
                  '22 min ago',
                  'Macro · impacts 38% of your exposure',
                ],
                ['Vanguard updates FTSE All-World fund report', '2 hr ago', 'VWCE · owned'],
                [
                  'Apple services growth outpaces expectations',
                  '4 hr ago',
                  'AAPL · owned in 2 portfolios',
                ],
              ].map(([title, time, meta]) => (
                <button key={title} onClick={() => setActiveView('News')} type="button">
                  <span className="news-thumbnail" />
                  <span>
                    <strong>{title}</strong>
                    <small>{meta}</small>
                  </span>
                  <em>{time}</em>
                </button>
              ))}
            </section>
            <section className="card events-card">
              <SectionHeading title="Next events" />
              {[
                ['29 Jul', 'ECB rate decision', 'Macro'],
                ['31 Jul', 'Apple earnings', 'AAPL'],
                ['05 Aug', 'Microsoft ex-dividend', 'MSFT'],
              ].map(([date, title, tag]) => (
                <button key={title} onClick={() => setActiveView('Calendar')} type="button">
                  <span>{date}</span>
                  <span>
                    <strong>{title}</strong>
                    <small>{tag}</small>
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
              ))}
            </section>
          </div>
        </>
      ) : (
        <AssetSecondaryView
          privateMode={privateMode}
          view={activeView}
          onAction={onToast}
          onSelectAsset={(symbol) => {
            const next = assetRows.find((asset) => asset.symbol === symbol);
            if (next) setSelected(next);
            setActiveView('Overview');
          }}
        />
      )}
    </div>
  );
}

function AssetSecondaryView({
  view,
  privateMode,
  onSelectAsset,
  onAction,
}: {
  view: Exclude<AssetView, 'Overview'>;
  privateMode: boolean;
  onSelectAsset: (symbol: string) => void;
  onAction: (message: string) => void;
}) {
  return (
    <section className="asset-secondary">
      {view === 'Watchlists' ? (
        <>
          <div className="watchlist-cards">
            {[
              ['Core candidates', '8 assets', '+1.42%', 'Updated today', 'sand'],
              ['Quality compounders', '12 assets', '+0.88%', '2 notes', 'sage'],
              ['Income watch', '7 assets', '3.84% yield', '1 alert', 'blue'],
              ['High conviction', '4 assets', '€14.8K owned', 'Shared with Jonas', 'rose'],
            ].map(([name, count, metric, meta, tone], index) => (
              <button
                className="card watchlist-card"
                key={name}
                onClick={() => onAction(`${name} watchlist opened with ${count}`)}
                type="button"
              >
                <span className={`watchlist-stack watchlist-stack--${tone}`}>
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <small>WATCHLIST {String(index + 1).padStart(2, '0')}</small>
                  <strong>{name}</strong>
                  <em>{count}</em>
                </span>
                <span>
                  <strong>{privateMode ? '••••' : metric}</strong>
                  <small>{meta}</small>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            ))}
          </div>
          <section className="card research-table">
            <div className="feature-card-heading">
              <span>
                <small>CORE CANDIDATES</small>
                <h3>Assets under consideration</h3>
              </span>
              <button type="button">
                Updated <Icon name="refresh" size={13} />
              </button>
            </div>
            <div className="research-table__head">
              <span>Asset</span>
              <span>Thesis</span>
              <span>Price</span>
              <span>1M</span>
              <span>Overlap</span>
              <span />
            </div>
            {(
              [
                ['MSFT', 'Microsoft', 'Cloud quality', '€412.18', '+6.8%', '2.4%'],
                ['VWCE', 'Vanguard All-World', 'Core simplification', '€129.44', '+2.1%', 'Owned'],
                ['ASML', 'ASML Holding', 'Semiconductor moat', '€844.20', '−1.8%', '1.1%'],
                ['NESN', 'Nestlé', 'Defensive income', 'CHF 83.40', '+0.6%', '0.7%'],
              ] as const
            ).map(([symbol, name, thesis, price, change, overlap]) => (
              <button key={symbol} onClick={() => onSelectAsset(symbol)} type="button">
                <span className="asset-symbol">{symbol.slice(0, 2)}</span>
                <span>
                  <strong>{symbol}</strong>
                  <small>{name}</small>
                </span>
                <span>{thesis}</span>
                <strong>{privateMode ? '••••' : price}</strong>
                <em className={change.startsWith('+') ? 'positive' : 'negative'}>{change}</em>
                <span>{overlap}</span>
                <Icon name="chevron-right" size={13} />
              </button>
            ))}
          </section>
        </>
      ) : null}

      {view === 'Discover' ? (
        <div className="discover-layout">
          <section className="discover-feature card">
            <span className="discover-feature__tag">BECAUSE YOU OWN GLOBAL EQUITY</span>
            <h3>Quality without adding the same exposure twice.</h3>
            <p>
              A focused collection of businesses with strong cash generation and less overlap with
              your largest ETF positions.
            </p>
            <div className="discover-constellation">
              {['MS', 'AS', 'NE', 'NO', 'AD'].map((symbol, index) => (
                <span key={symbol} style={{ '--orbit-index': index } as never}>
                  {symbol}
                </span>
              ))}
              <i />
              <i />
              <i />
            </div>
            <button
              onClick={() => onAction('Contextual discovery list opened with 18 matching assets')}
              type="button"
            >
              Explore 18 assets <Icon name="arrow-right" size={14} />
            </button>
          </section>
          <section className="card discover-themes">
            <div className="feature-card-heading">
              <span>
                <small>CURATED THEMES</small>
                <h3>Explore with context</h3>
              </span>
            </div>
            {[
              ['Cash-flow resilient', '26 assets', '12% portfolio overlap', 'cash'],
              ['European quality', '34 assets', '8% portfolio overlap', 'assets'],
              ['Lower-carbon broad market', '9 funds', 'Compare methodology', 'layers'],
              ['Income above inflation', '18 assets', '3.7% median yield', 'arrow-up'],
            ].map(([title, count, meta, icon]) => (
              <button
                key={title}
                onClick={() => onAction(`${title} discovery theme opened`)}
                type="button"
              >
                <span>
                  <Icon name={icon as IconName} />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{count}</small>
                </span>
                <em>{meta}</em>
                <Icon name="chevron-right" size={13} />
              </button>
            ))}
          </section>
          <section className="card market-pulse">
            <div className="feature-card-heading">
              <span>
                <small>MARKET PULSE</small>
                <h3>Movers relevant to you</h3>
              </span>
              <button onClick={() => onAction('Market region picker opened')} type="button">
                Europe
              </button>
            </div>
            {assetRows.slice(0, 5).map((asset) => (
              <button key={asset.symbol} onClick={() => onSelectAsset(asset.symbol)} type="button">
                <span className="asset-symbol">{asset.symbol.slice(0, 2)}</span>
                <span>
                  <strong>{asset.symbol}</strong>
                  <small>{asset.owned}</small>
                </span>
                <MiniSparkline
                  values={asset.spark}
                  positive={asset.change >= 0}
                  width={75}
                  height={25}
                />
                <strong className={asset.change >= 0 ? 'positive' : 'negative'}>
                  {asset.change >= 0 ? '+' : ''}
                  {asset.change}%
                </strong>
              </button>
            ))}
          </section>
        </div>
      ) : null}

      {view === 'Screener' ? (
        <div className="screener-layout">
          <aside className="card screener-filters">
            <div className="feature-card-heading">
              <span>
                <small>FILTERS</small>
                <h3>Quality at a fair price</h3>
              </span>
              <button onClick={() => onAction('Screener filters reset to defaults')} type="button">
                Reset
              </button>
            </div>
            {[
              ['Universe', 'Developed markets'],
              ['Market cap', '> €10B'],
              ['Return on equity', '> 15%'],
              ['Net debt / EBITDA', '< 2.0×'],
              ['Free cash-flow growth', '> 5%'],
              ['Forward P/E', '10× – 28×'],
            ].map(([label, value], index) => (
              <button
                className={index < 5 ? 'is-set' : ''}
                key={label}
                onClick={() => onAction(`${label} screener filter opened`)}
                type="button"
              >
                <span>
                  <small>{label}</small>
                  <strong>{value}</strong>
                </span>
                <Icon name="chevron-down" size={13} />
              </button>
            ))}
            <div className="screener-overlap-toggle">
              <span>
                <strong>Show portfolio overlap</strong>
                <small>ETF look-through included</small>
              </span>
              <i className="toggle is-on">
                <em />
              </i>
            </div>
          </aside>
          <section className="card screener-results">
            <div className="feature-card-heading">
              <span>
                <small>42 MATCHES · UPDATED NOW</small>
                <h3>Ranked by quality composite</h3>
              </span>
              <button
                onClick={() => onAction('Current explainable screen exported locally')}
                type="button"
              >
                <Icon name="download" size={13} /> Export
              </button>
            </div>
            <div className="screener-results__head">
              <span>Company</span>
              <span>Score</span>
              <span>ROE</span>
              <span>Fwd P/E</span>
              <span>Overlap</span>
              <span>1Y</span>
            </div>
            {(
              [
                ['MSFT', 'Microsoft', '94', '34.1%', '28.0×', '2.4%', '+18.1%'],
                ['NOVO', 'Novo Nordisk', '91', '72.4%', '23.8×', '0.6%', '+4.2%'],
                ['ASML', 'ASML Holding', '90', '51.2%', '26.4×', '1.1%', '+11.8%'],
                ['AIR', 'Airbus', '87', '28.9%', '21.1×', '0.4%', '+24.6%'],
                ['MUV2', 'Munich Re', '85', '19.4%', '12.7×', '0.3%', '+15.3%'],
              ] as const
            ).map(([symbol, name, score, roe, pe, overlap, change]) => (
              <button key={symbol} onClick={() => onSelectAsset(symbol)} type="button">
                <span>
                  <span className="asset-symbol">{symbol.slice(0, 2)}</span>
                  <span>
                    <strong>{symbol}</strong>
                    <small>{name}</small>
                  </span>
                </span>
                <em>{score}</em>
                <span>{roe}</span>
                <span>{pe}</span>
                <span>{overlap}</span>
                <strong className="positive">{change}</strong>
              </button>
            ))}
          </section>
        </div>
      ) : null}

      {view === 'News' ? (
        <div className="news-workspace">
          <section className="card lead-story">
            <span className="lead-story__visual">
              <i />
              <Icon name="activity" />
            </span>
            <div>
              <span className="news-impact">HIGH PORTFOLIO RELEVANCE · 38% EXPOSURE</span>
              <h3>Markets price in a calmer path for European rates</h3>
              <p>
                The move touches your bond allocation, Riverside refinancing assumptions, and
                several European equity holdings.
              </p>
              <span>Reuters · 22 min ago · 4 min read</span>
              <button
                onClick={() => onAction('Lead story opened with portfolio exposure context')}
                type="button"
              >
                Read with portfolio context <Icon name="arrow-right" size={14} />
              </button>
            </div>
          </section>
          <section className="card news-feed">
            <div className="feature-card-heading">
              <span>
                <small>YOUR FEED</small>
                <h3>Ranked by financial impact</h3>
              </span>
              <button onClick={() => onAction('News relevance settings opened')} type="button">
                <Icon name="sliders" size={13} /> Tune
              </button>
            </div>
            {[
              ['Vanguard updates FTSE All-World fund report', 'VWCE · owned', '2 hr', 'Medium'],
              [
                'Apple services growth outpaces expectations',
                'AAPL · owned in 2 portfolios',
                '4 hr',
                'High',
              ],
              [
                'Microsoft announces next cloud infrastructure region',
                'MSFT · watchlist',
                '6 hr',
                'Low',
              ],
              [
                'Austria confirms 2027 capital-gains allowance review',
                'Tax profile · Austria',
                'Yesterday',
                'High',
              ],
            ].map(([title, meta, time, impact]) => (
              <button
                key={title}
                onClick={() => onAction(`${title} opened with affected holdings`)}
                type="button"
              >
                <span className="news-feed__visual" />
                <span>
                  <em>{impact} impact</em>
                  <strong>{title}</strong>
                  <small>{meta}</small>
                </span>
                <time>{time}</time>
                <Icon name="chevron-right" size={13} />
              </button>
            ))}
          </section>
          <aside className="card daily-brief">
            <span>
              <Icon name="sparkles" />
            </span>
            <small>BETTERTRACK BRIEF · 08:00</small>
            <h3>Your five-minute market context</h3>
            <p>Six relevant changes across 18 owned or watched assets.</p>
            <button
              onClick={() => onAction('Today’s grounded portfolio brief opened')}
              type="button"
            >
              Open today’s brief
            </button>
          </aside>
        </div>
      ) : null}

      {view === 'Calendar' ? (
        <div className="market-calendar">
          <section className="card market-calendar__main">
            <div className="feature-card-heading">
              <span>
                <small>27 JULY – 2 AUGUST</small>
                <h3>This week</h3>
              </span>
              <div>
                <button type="button">
                  <Icon name="chevron-right" size={13} />
                </button>
                <button type="button">Today</button>
                <button type="button">
                  <Icon name="chevron-right" size={13} />
                </button>
              </div>
            </div>
            <div className="calendar-days">
              {[
                ['MON 27', ['Salary expected', 'US durable goods']],
                ['TUE 28', ['VWCE contribution', 'EU sentiment']],
                ['WED 29', ['ECB rate decision']],
                ['THU 30', ['Microsoft dividend']],
                ['FRI 31', ['Apple earnings', 'Northwind capital call']],
              ].map(([day, rawEvents], dayIndex) => (
                <section className={dayIndex === 2 ? 'is-today' : ''} key={day as string}>
                  <header>{day as string}</header>
                  {(rawEvents as string[]).map((event, index) => (
                    <button
                      className={`calendar-event calendar-event--${(dayIndex + index) % 4}`}
                      key={event}
                      onClick={() => onAction(`${event} opened with portfolio impact`)}
                      type="button"
                    >
                      <small>{index === 0 ? '09:00' : '16:30'}</small>
                      <strong>{event}</strong>
                      <em>
                        {event.includes('Apple')
                          ? 'AAPL'
                          : event.includes('VWCE')
                            ? 'Automation'
                            : 'Portfolio impact'}
                      </em>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </section>
          <aside className="card calendar-agenda">
            <div className="feature-card-heading">
              <span>
                <small>WATCHING</small>
                <h3>Alerts & estimates</h3>
              </span>
            </div>
            {[
              ['29 Jul', 'ECB rate decision', '38% of wealth'],
              ['31 Jul', 'Apple earnings', '€24.6K position'],
              ['05 Aug', 'Microsoft ex-dividend', '€67.84 estimated'],
              ['12 Aug', 'Riverside mortgage', '−€1,240 expected'],
            ].map(([date, title, meta]) => (
              <button
                key={title}
                onClick={() => onAction(`${title} alert estimate opened`)}
                type="button"
              >
                <span>{date}</span>
                <span>
                  <strong>{title}</strong>
                  <small>{privateMode ? 'Portfolio context hidden' : meta}</small>
                </span>
                <Icon name="bell" size={13} />
              </button>
            ))}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

function PeoplePage({
  onInvite,
  onAccessOverview,
  onOpenPortfolio,
  onOpenReview,
  pendingInvite,
}: {
  onInvite: () => void;
  onAccessOverview: () => void;
  onOpenPortfolio: (name: string) => void;
  onOpenReview: (id: string) => void;
  pendingInvite: PendingInvite | null;
}) {
  const [activeView, setActiveView] = useState<PeopleView>('Together');
  const peopleViews: PeopleView[] = ['Together', 'Clients', 'Teams', 'Shared with me', 'Updates'];
  return (
    <div className="page people-page">
      <div className="page-intro">
        <h1>People</h1>
        <div className="page-intro__actions">
          <Button variant="secondary" icon="shield" onClick={onAccessOverview}>
            Access overview
          </Button>
          <Button variant="primary" icon="user-plus" onClick={onInvite}>
            Invite
          </Button>
        </div>
      </div>
      <div className="people-tabs">
        {peopleViews.map((item) => (
          <button
            aria-current={activeView === item ? 'page' : undefined}
            className={activeView === item ? 'is-active' : ''}
            key={item}
            onClick={() => setActiveView(item)}
            type="button"
          >
            {item}
            {item === 'Updates' ? <span>3</span> : null}
          </button>
        ))}
      </div>
      {pendingInvite ? (
        <div className="pending-collaborator" role="status">
          <span>
            <Icon name="message" size={17} />
          </span>
          <div>
            <strong>Invitation sent to {pendingInvite.email}</strong>
            <small>
              {pendingInvite.role} access to {pendingInvite.portfolio} · awaiting acceptance
            </small>
          </div>
          <span className="role-badge">Pending</span>
          <button type="button" onClick={onAccessOverview}>
            Manage
          </button>
        </div>
      ) : null}
      {activeView === 'Together' ? (
        <>
          <div className="people-main-grid">
            <section className="card together-card">
              <SectionHeading title="Portfolios you work on together" />
              {[
                [
                  'Riverside property',
                  'Property · 50 / 50 ownership',
                  'AM,MK',
                  '1 proposal',
                  '#8998ad',
                ],
                ['Family reserve', 'Shared · 3 members', 'AM,MK,JL', 'All clear', '#ae91a3'],
                [
                  'Northstar Studio / Operations',
                  'Company child portfolio',
                  'AM,JL',
                  '2 comments',
                  '#7e9c91',
                ],
              ].map(([name, meta, people, state, color]) => (
                <button
                  key={name}
                  onClick={() =>
                    onOpenPortfolio(
                      name === 'Northstar Studio / Operations' ? 'Northstar Studio' : String(name),
                    )
                  }
                  type="button"
                >
                  <span
                    className="shared-portfolio-mark"
                    style={{ '--scope-color': color } as never}
                  >
                    <Icon name="portfolio" />
                  </span>
                  <span>
                    <strong>{name}</strong>
                    <small>{meta}</small>
                  </span>
                  <span className="mini-avatar-stack">
                    {String(people)
                      .split(',')
                      .map((initials, index) => (
                        <Avatar
                          key={initials}
                          initials={initials}
                          tone={index === 0 ? 'sand' : index === 1 ? 'sage' : 'blue'}
                          size="sm"
                        />
                      ))}
                  </span>
                  <span className={state === 'All clear' ? 'clear-state' : 'review-state'}>
                    {state}
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
              ))}
            </section>
            <section className="card proposal-card">
              <span className="proposal-card__eyebrow">
                <StatusDot tone="amber" />
                NEEDS YOUR REVIEW
              </span>
              <div className="proposal-person">
                <Avatar initials="MK" tone="sage" />
                <span>
                  <strong>Mia Keller</strong>
                  <small>2 hours ago · Riverside property</small>
                </span>
              </div>
              <h3>Update the property value to €144,900?</h3>
              <p>Appraisal attached · not applied</p>
              <div className="proposal-diff">
                <span>
                  <small>Current</small>
                  <strong>€138,400</strong>
                </span>
                <Icon name="arrow-right" />
                <span>
                  <small>Proposed</small>
                  <strong>€144,900</strong>
                </span>
              </div>
              <div className="proposal-actions">
                <Button variant="quiet" onClick={() => onOpenReview('origin-property-proposal')}>
                  Open details
                </Button>
                <Button
                  variant="primary"
                  icon="check"
                  onClick={() => onOpenReview('origin-property-proposal')}
                >
                  Review approval
                </Button>
              </div>
            </section>
          </div>
        </>
      ) : (
        <PeopleSecondaryView
          view={activeView}
          onInvite={onInvite}
          onOpenPortfolio={onOpenPortfolio}
          onOpenReview={onOpenReview}
        />
      )}
    </div>
  );
}

function PeopleSecondaryView({
  view,
  onInvite,
  onOpenPortfolio,
  onOpenReview,
}: {
  view: Exclude<PeopleView, 'Together'>;
  onInvite: () => void;
  onOpenPortfolio: (name: string) => void;
  onOpenReview: (id: string) => void;
}) {
  return (
    <section className="people-secondary">
      {view === 'Clients' ? (
        <div className="client-workspace">
          <section className="card client-list">
            <div className="feature-card-heading">
              <span>
                <small>6 CLIENT WORKSPACES</small>
                <h3>Managed relationships</h3>
              </span>
              <div className="search-field">
                <Icon name="search" size={14} />
                <input aria-label="Search clients" placeholder="Search…" />
              </div>
            </div>
            <div className="client-list__head">
              <span>Client</span>
              <span>Value</span>
              <span>Status</span>
              <span>Next</span>
            </div>
            {(
              [
                ['MH', 'Morgan household', '3 portfolios', '€1.84M', '2 reviews', 'Today'],
                ['KB', 'Keller family', '2 portfolios', '€982K', 'All clear', '05 Aug'],
                ['JL', 'Leitner GmbH', '4 portfolios', '€2.46M', '1 review', '31 Jul'],
                ['LW', 'Wagner family', '2 portfolios', '€724K', 'Meeting', 'Today'],
                ['NW', 'Northwind Stiftung', '5 portfolios', '€4.18M', 'Capital call', '31 Jul'],
              ] as const
            ).map(([initials, name, scope, value, status, next], index) => (
              <button key={name} type="button">
                <span>
                  <Avatar
                    initials={initials}
                    tone={index % 3 === 0 ? 'sand' : index % 3 === 1 ? 'sage' : 'blue'}
                  />
                  <span>
                    <strong>{name}</strong>
                    <small>{scope}</small>
                  </span>
                </span>
                <strong>{value}</strong>
                <em className={status === 'All clear' ? 'clear-state' : 'review-state'}>
                  {status}
                </em>
                <span>{next}</span>
                <Icon name="chevron-right" size={13} />
              </button>
            ))}
          </section>
          <aside className="card client-review">
            <div className="feature-card-heading">
              <span>
                <small>PRIORITY QUEUE</small>
                <h3>Needs your review</h3>
              </span>
              <em>7</em>
            </div>
            {[
              ['Missing cost basis', 'Leitner GmbH · 3 holdings', 'red'],
              ['Allocation drift above 5%', 'Morgan household · Growth', 'amber'],
              ['Proposal ready to share', 'Wagner family · pension plan', 'blue'],
            ].map(([title, meta, tone]) => (
              <button key={title} type="button">
                <i className={`admin-state admin-state--${tone}`} />
                <span>
                  <strong>{title}</strong>
                  <small>{meta}</small>
                </span>
                <Icon name="chevron-right" size={13} />
              </button>
            ))}
          </aside>
        </div>
      ) : null}

      {view === 'Teams' ? (
        <div className="teams-workspace">
          <div className="team-cards">
            {(
              [
                ['Household', '3 members', '4 portfolios', 'AM,MK,JL', 'sand'],
                ['Northstar finance', '4 members', '3 portfolios', 'AM,JL,SK', 'sage'],
                ['External advisors', '2 members', '2 portfolios', 'RS,LB', 'blue'],
              ] as const
            ).map(([name, people, portfolios, initials, tone]) => (
              <button
                className={cn('card team-card', name === 'Northstar finance' && 'is-selected')}
                key={name}
                type="button"
              >
                <span className={`team-mark team-mark--${tone}`}>
                  <Icon name="people" />
                </span>
                <span>
                  <small>TEAM</small>
                  <strong>{name}</strong>
                  <em>
                    {people} · {portfolios}
                  </em>
                </span>
                <span className="mini-avatar-stack">
                  {initials.split(',').map((item, index) => (
                    <Avatar
                      initials={item}
                      key={item}
                      size="sm"
                      tone={index === 0 ? 'sand' : index === 1 ? 'sage' : 'blue'}
                    />
                  ))}
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            ))}
            <button className="card team-card team-card--new" onClick={onInvite} type="button">
              <span>
                <Icon name="plus" />
              </span>
              <strong>Create a team</strong>
              <small>Reuse roles across portfolios</small>
            </button>
          </div>
          <section className="card permission-matrix">
            <div className="feature-card-heading">
              <span>
                <small>NORTHSTAR FINANCE</small>
                <h3>Permission matrix</h3>
              </span>
              <button type="button">
                Edit roles <Icon name="arrow-right" size={13} />
              </button>
            </div>
            <div className="permission-matrix__head">
              <span>Member</span>
              <span>View</span>
              <span>Edit</span>
              <span>Propose</span>
              <span>Approve</span>
              <span>Share</span>
            </div>
            {[
              ['AM', 'Alex Morgan', 'Owner', [true, true, true, true, true]],
              ['JL', 'Jonas Leitner', 'Finance lead', [true, true, true, false, false]],
              ['SK', 'Sofia Kern', 'Bookkeeper', [true, true, false, false, false]],
              ['LB', 'Lena Bauer', 'Tax advisor', [true, false, true, false, false]],
            ].map(([initials, name, role, permissions], index) => (
              <div key={name as string}>
                <span>
                  <Avatar
                    initials={initials as string}
                    size="sm"
                    tone={index === 0 ? 'sand' : index === 1 ? 'blue' : 'sage'}
                  />
                  <span>
                    <strong>{name as string}</strong>
                    <small>{role as string}</small>
                  </span>
                </span>
                {(permissions as boolean[]).map((allowed, permissionIndex) => (
                  <i className={allowed ? 'is-allowed' : ''} key={`${name}-${permissionIndex}`}>
                    {allowed ? <Icon name="check" size={12} /> : '—'}
                  </i>
                ))}
              </div>
            ))}
          </section>
        </div>
      ) : null}

      {view === 'Shared with me' ? (
        <div className="shared-incoming">
          <div className="shared-toolbar">
            <strong>5 shared portfolios</strong>
            <span>2 editable · 2 proposal access · 1 read-only</span>
            <button type="button">
              Access guide <Icon name="arrow-right" size={13} />
            </button>
          </div>
          <div className="shared-portfolio-grid">
            {[
              ['Leitner retirement', 'Jonas Leitner', 'Can propose', '€468.2K', 'blue'],
              ['Riverside property', 'Mia Keller', 'Co-owner', '€138.4K', 'sage'],
              ['Family reserve', 'Mia Keller', 'Can edit', '€27.7K', 'rose'],
              ['Northwind model', 'Northwind Stiftung', 'View only', 'Values hidden', 'sand'],
              ['Climate Tilt', 'Jonas Leitner', 'Can comment', 'Blueprint', 'blue'],
            ].map(([name, owner, access, value, tone]) => (
              <button
                className="card shared-incoming-card"
                key={name}
                onClick={() => onOpenPortfolio(String(name))}
                type="button"
              >
                <span className={`shared-incoming-card__mark shared-incoming-card__mark--${tone}`}>
                  <Icon name={value === 'Blueprint' ? 'layers' : 'portfolio'} />
                </span>
                <span>
                  <small>{access}</small>
                  <strong>{name}</strong>
                  <em>Shared by {owner}</em>
                </span>
                <strong>{value}</strong>
                <Icon name="chevron-right" size={14} />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {view === 'Updates' ? (
        <div className="updates-workspace">
          <aside className="card update-filters">
            <div className="feature-card-heading">
              <span>
                <small>FILTER</small>
                <h3>Collaboration activity</h3>
              </span>
            </div>
            {[
              ['Everything', '3 new', 'activity'],
              ['Needs me', '2', 'inbox'],
              ['Comments', '1', 'message'],
              ['Proposals', '2', 'document'],
              ['Access', '0', 'shield'],
              ['Imports', '1', 'upload'],
            ].map(([label, count, icon], index) => (
              <button className={index === 0 ? 'is-active' : ''} key={label} type="button">
                <Icon name={icon as IconName} />
                <span>{label}</span>
                <em>{count}</em>
              </button>
            ))}
          </aside>
          <section className="card update-timeline">
            <div className="feature-card-heading">
              <span>
                <small>TODAY</small>
                <h3>What changed around your portfolios</h3>
              </span>
              <button type="button">
                Mark all read <Icon name="check" size={13} />
              </button>
            </div>
            {(
              [
                [
                  'MK',
                  'Mia proposed a new Riverside value',
                  '€138,400 → €144,900 · appraisal attached',
                  '12 min',
                  'proposal',
                  'sage',
                ],
                [
                  'JL',
                  'Jonas commented on Global Core',
                  '“The bond sleeve could absorb the next contribution.”',
                  '42 min',
                  'comment',
                  'blue',
                ],
                [
                  'AM',
                  'You approved 12 imported activities',
                  'Personal wealth · Google Drive import',
                  '2 hr',
                  'approved',
                  'sand',
                ],
                [
                  'SK',
                  'Sofia categorized three company expenses',
                  'Northstar Studio / Operations',
                  '4 hr',
                  'activity',
                  'rose',
                ],
                [
                  'LB',
                  'Lena requested the 2025 tax statement',
                  'Personal wealth · Files',
                  'Yesterday',
                  'request',
                  'blue',
                ],
              ] as const
            ).map(([initials, title, meta, time, kind, tone], index) => (
              <article className={index < 2 ? 'is-new' : ''} key={title}>
                <Avatar initials={initials} tone={tone as 'sand' | 'sage' | 'blue' | 'rose'} />
                <span className={`update-kind update-kind--${kind}`}>
                  <Icon
                    name={
                      kind === 'comment'
                        ? 'message'
                        : kind === 'approved'
                          ? 'check'
                          : kind === 'request'
                            ? 'document'
                            : 'activity'
                    }
                    size={13}
                  />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{meta}</p>
                  {index < 2 ? (
                    <button
                      onClick={() =>
                        index === 0
                          ? onOpenReview('origin-property-proposal')
                          : onOpenPortfolio(
                              meta.includes('Personal wealth')
                                ? 'Personal wealth'
                                : meta.includes('Northstar')
                                  ? 'Northstar Studio'
                                  : meta.includes('Riverside')
                                    ? 'Riverside property'
                                    : 'Family reserve',
                            )
                      }
                      type="button"
                    >
                      {index === 0 ? 'Review' : 'Open'}
                    </button>
                  ) : null}
                </div>
                <time>{time}</time>
              </article>
            ))}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function OverlayShell({
  children,
  title,
  description,
  onClose,
  wide = false,
}: {
  children: ReactNode;
  title: string;
  description?: string;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialogRef = useAccessibleDialog<HTMLElement>({
    open: true,
    onClose,
  });
  return (
    <div className="overlay" data-accessible-dialog-layer role="presentation" onMouseDown={onClose}>
      <section
        aria-label={title}
        aria-modal="true"
        className={cn('modal', wide && 'modal--wide')}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="modal__header">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <Button variant="quiet" size="icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </Button>
        </header>
        {children}
      </section>
    </div>
  );
}

function QuickCreateModal({
  scope,
  onClose,
  onSave,
  onDeepCreate,
}: {
  scope: Scope;
  onClose: () => void;
  onSave: (activity: {
    title: string;
    amount: number;
    kind: 'expense' | 'income' | 'transfer';
    grossAmount: number;
    destination?: string;
  }) => void;
  onDeepCreate: (kind: 'trade' | 'portfolio' | 'import' | 'cashflow') => void;
}) {
  const [kind, setKind] = useState<CreateKind>('expense');
  const [title, setTitle] = useState('Grocery store');
  const [amount, setAmount] = useState('84.26');
  const [transferDestination, setTransferDestination] = useState('Family reserve');
  const kinds: Array<{ id: CreateKind; label: string; icon: IconName }> = [
    { id: 'expense', label: 'Expense', icon: 'arrow-up' },
    { id: 'income', label: 'Income', icon: 'arrow-down' },
    { id: 'trade', label: 'Trade', icon: 'assets' },
    { id: 'transfer', label: 'Transfer', icon: 'repeat' },
    { id: 'portfolio', label: 'Portfolio', icon: 'portfolio' },
    { id: 'import', label: 'Import', icon: 'upload' },
  ];

  function handleKind(next: CreateKind) {
    setKind(next);
    const defaults: Record<CreateKind, [string, string]> = {
      expense: ['Grocery store', '84.26'],
      income: ['Consulting income', '1200'],
      trade: ['Buy VWCE', '500'],
      transfer: ['Transfer to reserve', '250'],
      portfolio: ['New portfolio', '0'],
      import: ['Statement import', '0'],
    };
    setTitle(defaults[next][0]);
    setAmount(defaults[next][1]);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (kind === 'trade' || kind === 'portfolio' || kind === 'import') {
      onDeepCreate(kind);
      return;
    }
    const numericAmount = Number(amount) || 0;
    onSave({
      title,
      amount:
        kind === 'transfer' ? 0 : kind === 'expense' ? -Math.abs(numericAmount) : numericAmount,
      kind,
      grossAmount: Math.abs(numericAmount),
      ...(kind === 'transfer' ? { destination: transferDestination } : {}),
    });
  }

  return (
    <OverlayShell
      title="Create"
      description={`Add something to ${scope.name}`}
      onClose={onClose}
      wide
    >
      <div className="create-layout">
        <div className="create-kinds">
          {kinds.map((item) => (
            <button
              className={kind === item.id ? 'is-active' : ''}
              key={item.id}
              type="button"
              onClick={() => handleKind(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
        </div>
        <form className="create-form" onSubmit={handleSubmit}>
          <div className="create-form__scope">
            <span className="scope-option__icon" style={{ '--scope-color': scope.accent } as never}>
              <Icon name={scope.icon} size={16} />
            </span>
            <span>
              <small>{kind === 'transfer' ? 'Source portfolio' : 'Target portfolio'}</small>
              <strong>{scope.name}</strong>
            </span>
            <button type="button">Change</button>
          </div>
          {kind === 'portfolio' ? (
            <>
              <label>
                What does this portfolio represent?
                <div className="select-field">
                  Personal investing <Icon name="chevron-down" size={14} />
                </div>
              </label>
              <label>
                Portfolio name
                <input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <div className="form-note">
                <Icon name="layers" size={16} />
                This can hold assets, cash flow, plans, people, and other portfolios.
              </div>
            </>
          ) : kind === 'import' ? (
            <div className="import-dropzone">
              <span>
                <Icon name="upload" />
              </span>
              <strong>Drop a PDF or CSV here</strong>
              <small>BetterTrack will stage detected activity for review before saving.</small>
              <Button variant="secondary">Choose file</Button>
            </div>
          ) : (
            <>
              <label>
                {kind === 'trade' ? 'Order' : kind === 'transfer' ? 'Description' : 'Name'}
                <input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <div className="form-row">
                <label>
                  Amount
                  <div className="amount-field">
                    <span>€</span>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                  </div>
                </label>
                <label>
                  Date
                  <div className="select-field">
                    Today <Icon name="calendar" size={14} />
                  </div>
                </label>
              </div>
              <label>
                Category
                {kind === 'transfer' ? (
                  <div className="select-field">
                    <select
                      aria-label="Destination portfolio"
                      onChange={(event) => setTransferDestination(event.target.value)}
                      value={transferDestination}
                    >
                      {scopes
                        .filter((candidate) => candidate.id !== 'all' && candidate.id !== scope.id)
                        .map((candidate) => (
                          <option key={candidate.id} value={candidate.name}>
                            {candidate.name}
                          </option>
                        ))}
                    </select>
                    <Icon name="chevron-down" size={14} />
                  </div>
                ) : (
                  <div className="select-field">
                    {kind === 'expense'
                      ? 'Food & household'
                      : kind === 'income'
                        ? 'Income'
                        : 'Investment'}
                    <Icon name="chevron-down" size={14} />
                  </div>
                )}
              </label>
              <div className="form-note">
                <Icon name="link" size={16} />
                This activity will update value, cash flow, analysis, plans, and the shared audit
                trail.
              </div>
            </>
          )}
          {kind === 'expense' || kind === 'income' || kind === 'transfer' ? (
            <button
              className="create-advanced-link"
              onClick={() => onDeepCreate('cashflow')}
              type="button"
            >
              <Icon name="sliders" size={15} />
              <span>
                <strong>Open full cash-flow details</strong>
                <small>Account, recurrence, forecast, counterparty, and evidence</small>
              </span>
              <Icon name="arrow-right" size={14} />
            </button>
          ) : null}
          <div className="modal__footer">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" icon="check">
              {kind === 'import'
                ? 'Open Import Hub'
                : kind === 'portfolio'
                  ? 'Configure portfolio'
                  : kind === 'trade'
                    ? 'Build order'
                    : `Add ${kind}`}
            </Button>
          </div>
        </form>
      </div>
    </OverlayShell>
  );
}

function InviteModal({
  scope,
  onClose,
  onSend,
}: {
  scope: Scope;
  onClose: () => void;
  onSend: (invite: PendingInvite) => void;
}) {
  const [email, setEmail] = useState('lea@example.com');
  const [role, setRole] = useState<InviteRole>('Can propose');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSend({ email, role, portfolio: scope.name });
  }

  return (
    <OverlayShell
      title="Invite a collaborator"
      description="Access is scoped, explicit, and visible to every portfolio owner."
      onClose={onClose}
    >
      <form className="invite-form" onSubmit={handleSubmit}>
        <div className="invite-scope">
          <span className="scope-option__icon" style={{ '--scope-color': scope.accent } as never}>
            <Icon name={scope.icon} size={16} />
          </span>
          <span>
            <small>PORTFOLIO ACCESS</small>
            <strong>{scope.name}</strong>
          </span>
          <span className="role-badge">Scoped</span>
        </div>
        <label>
          Email address
          <input
            aria-label="Collaborator email address"
            autoFocus
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
        </label>
        <label>
          Role
          <select
            aria-label="Collaborator role"
            onChange={(event) => setRole(event.target.value as InviteRole)}
            value={role}
          >
            <option>Viewer</option>
            <option>Editor</option>
            <option>Can propose</option>
          </select>
        </label>
        <section className="invite-permission-preview">
          <span>
            <Icon name="shield" size={17} />
          </span>
          <div>
            <strong>
              {role === 'Viewer'
                ? 'Can view this portfolio'
                : role === 'Editor'
                  ? 'Can view and edit portfolio data'
                  : 'Can model and propose changes'}
            </strong>
            <small>
              {role === 'Editor'
                ? 'Sensitive changes still follow your approval rules.'
                : role === 'Can propose'
                  ? 'Proposals enter your review queue before changing live data.'
                  : 'Private notes, credentials, and other portfolios stay hidden.'}
            </small>
          </div>
        </section>
        <label className="invite-message">
          Personal message
          <textarea defaultValue="I’d like to work with you on this portfolio in BetterTrack." />
        </label>
        <div className="modal__footer">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="user-plus" type="submit">
            Send invitation
          </Button>
        </div>
      </form>
    </OverlayShell>
  );
}

function CustomizePanel({
  theme,
  density,
  visibleWidgets,
  mobileDestinations,
  onTheme,
  onDensity,
  onWidgets,
  onMobileDestinations,
  onClose,
}: {
  theme: Theme;
  density: Density;
  visibleWidgets: string[];
  mobileDestinations: Destination[];
  onTheme: (theme: Theme) => void;
  onDensity: (density: Density) => void;
  onWidgets: (widgets: string[]) => void;
  onMobileDestinations: (destinations: Destination[]) => void;
  onClose: () => void;
}) {
  const widgets = [
    ['review', 'Needs attention', 'Review queue across the current scope'],
    ['allocation', 'Allocation', 'Look-through across nested portfolios'],
    ['cashflow', 'Cash flow', 'Income, spending, and net flow'],
    ['brief', 'BetterTrack brief', 'Concise portfolio explanation'],
    ['actions', 'Quick actions', 'Your frequent create shortcuts'],
  ];
  function toggleWidget(id: string) {
    onWidgets(
      visibleWidgets.includes(id)
        ? visibleWidgets.filter((widget) => widget !== id)
        : [...visibleWidgets, id],
    );
  }
  return (
    <div className="drawer-shell" role="presentation" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Customize BetterTrack"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer__header">
          <div>
            <span className="eyebrow">Make it yours</span>
            <h2>Customize Home</h2>
          </div>
          <Button variant="quiet" size="icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </Button>
        </header>
        <div className="drawer__content">
          <section className="customize-section">
            <h3>Appearance</h3>
            <div className="theme-options">
              {(
                [
                  ['system', 'monitor', 'System'],
                  ['dark', 'moon', 'Dark'],
                  ['light', 'sun', 'Light'],
                ] as Array<[Theme, IconName, string]>
              ).map(([id, icon, label]) => (
                <button
                  className={theme === id ? 'is-active' : ''}
                  key={id}
                  type="button"
                  onClick={() => onTheme(id)}
                >
                  <Icon name={icon} />
                  {label}
                  {theme === id ? <Icon name="check" size={13} /> : null}
                </button>
              ))}
            </div>
            <div className="setting-row">
              <span>
                <strong>Information density</strong>
                <small>Changes spacing without hiding capability.</small>
              </span>
              <div className="segmented-control">
                <button
                  className={density === 'comfortable' ? 'is-active' : ''}
                  type="button"
                  onClick={() => onDensity('comfortable')}
                >
                  Comfortable
                </button>
                <button
                  className={density === 'compact' ? 'is-active' : ''}
                  type="button"
                  onClick={() => onDensity('compact')}
                >
                  Compact
                </button>
              </div>
            </div>
          </section>
          <section className="customize-section">
            <div className="customize-section__title">
              <h3>Home widgets</h3>
              <button
                onClick={() => onWidgets(['review', 'allocation', 'cashflow', 'brief', 'actions'])}
                type="button"
              >
                Reset
              </button>
            </div>
            <div className="widget-list">
              {widgets.map(([id, label, copy]) => {
                const active = visibleWidgets.includes(id!);
                return (
                  <button key={id} type="button" onClick={() => toggleWidget(id!)}>
                    <span className="widget-drag">
                      <Icon name="menu" size={15} />
                    </span>
                    <span>
                      <strong>{label}</strong>
                      <small>{copy}</small>
                    </span>
                    <i className={cn('toggle', active && 'is-on')}>
                      <em />
                    </i>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="customize-section">
            <h3>Mobile navigation</h3>
            <p>
              Keep the three core jobs close, then choose research, collaboration, or developer
              tools for the final shortcut.
            </p>
            <div className="mobile-nav-preview">
              {[
                ...mobileDestinations.slice(0, 2),
                'create' as const,
                ...mobileDestinations.slice(2),
              ].map((id) => {
                const item =
                  id === 'create'
                    ? { id, label: 'Create', icon: 'plus' as IconName }
                    : destinationItems.find((destinationItem) => destinationItem.id === id)!;
                return (
                  <span key={item.id} className={item.id === 'home' ? 'is-active' : ''}>
                    <Icon name={item.icon} size={16} />
                    <small>{item.label}</small>
                  </span>
                );
              })}
            </div>
            <div className="mobile-destination-picker">
              <span>
                <strong>Fourth destination</strong>
                <small>Saved to this device</small>
              </span>
              <div className="segmented-control">
                {(['assets', 'people', 'developer'] as Destination[]).map((id) => (
                  <button
                    className={mobileDestinations.includes(id) ? 'is-active' : ''}
                    key={id}
                    onClick={() => onMobileDestinations(['home', 'portfolios', 'workbench', id])}
                    type="button"
                  >
                    {id === 'assets' ? 'Assets' : id === 'people' ? 'People' : 'Develop'}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
        <footer className="drawer__footer">
          <span>
            <Icon name="check" size={14} />
            Changes save automatically
          </span>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function PlatformPanel({
  onDeveloper,
  onConnections,
  onImport,
  onDataManagement,
  onSettings,
  onClose,
}: {
  onDeveloper: () => void;
  onConnections: () => void;
  onImport: () => void;
  onDataManagement: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const groups: Array<{
    label: string;
    items: Array<{
      title: string;
      description: string;
      icon: IconName;
      badge?: string;
      action: () => void;
    }>;
  }> = [
    {
      label: 'Data and access',
      items: [
        {
          title: 'Connections',
          description: 'Banks, brokers, storage, and apps',
          icon: 'link',
          badge: '4 healthy',
          action: onConnections,
        },
        {
          title: 'Imports and exports',
          description: 'Files and portable data',
          icon: 'upload',
          action: onImport,
        },
        {
          title: 'Backups',
          description: 'Snapshots and restore',
          icon: 'database',
          badge: 'Verified',
          action: onDataManagement,
        },
      ],
    },
    {
      label: '',
      items: [
        {
          title: 'Developer Platform',
          description: 'API, OAuth, webhooks, and MCP',
          icon: 'code',
          action: onDeveloper,
        },
      ],
    },
    {
      label: '',
      items: [
        {
          title: 'Settings and security',
          description: 'Account, privacy, security, and billing',
          icon: 'settings',
          action: onSettings,
        },
      ],
    },
  ];

  return (
    <div className="drawer-shell" role="presentation" onMouseDown={onClose}>
      <aside
        className="drawer platform-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Control center"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer__header">
          <h2>Control center</h2>
          <Button variant="quiet" size="icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </Button>
        </header>
        <div className="drawer__content platform-panel__content">
          {groups.map((group) => (
            <section key={`${group.label}-${group.items[0]?.title}`}>
              {group.label ? <span>{group.label}</span> : null}
              {group.items.map((item) => (
                <button key={item.title} onClick={item.action} type="button">
                  <span>
                    <Icon name={item.icon} />
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </span>
                  {item.badge ? <em>{item.badge}</em> : null}
                  <Icon name="chevron-right" size={14} />
                </button>
              ))}
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}

function ConnectionsPanel({
  connections,
  onToggle,
  onDeveloper,
  onClose,
}: {
  connections: Record<string, boolean>;
  onToggle: (id: string, name: string) => void;
  onDeveloper: () => void;
  onClose: () => void;
}) {
  const items = [
    ['drive', 'Google Drive', 'Import statements and store portfolio documents', 'G', 'blue'],
    ['parqet', 'Parqet', 'Two-way portfolios, holdings, and activity sync', 'P', 'green'],
    ['sparkasse', 'Sparkasse', 'Bank balances, income, and expenses', 'S', 'red'],
    ['trade', 'Trade Republic', 'Broker activity and holdings', 'TR', 'black'],
  ];
  return (
    <div className="drawer-shell" role="presentation" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Connections"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer__header">
          <div>
            <span className="eyebrow">Your data, under your control</span>
            <h2>Connections</h2>
          </div>
          <Button variant="quiet" size="icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </Button>
        </header>
        <div className="drawer__content">
          <div className="connection-health">
            <span className="connection-health__ring">
              <Icon name="check" />
            </span>
            <span>
              <strong>{Object.values(connections).filter(Boolean).length} sources healthy</strong>
              <small>Last checked 2 minutes ago</small>
            </span>
            <Button variant="secondary" size="sm" icon="refresh">
              Sync all
            </Button>
          </div>
          <section className="connection-section">
            <div className="customize-section__title">
              <h3>Connected and available</h3>
              <button type="button">Connection log</button>
            </div>
            <div className="connection-list">
              {items.map(([id, name, copy, mark, tone]) => {
                const connected = connections[id!] ?? false;
                return (
                  <div key={id}>
                    <span className={cn('connection-mark', `connection-mark--${tone}`)}>
                      {mark}
                    </span>
                    <span>
                      <strong>{name}</strong>
                      <small>{copy}</small>
                      {connected ? (
                        <em>
                          <StatusDot />
                          Connected · scoped to 1 portfolio
                        </em>
                      ) : null}
                    </span>
                    <Button
                      variant={connected ? 'quiet' : 'secondary'}
                      size="sm"
                      onClick={() => onToggle(id!, name!)}
                    >
                      {connected ? 'Manage' : 'Connect'}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="permission-summary">
            <Icon name="shield" />
            <span>
              <strong>Connections are portfolio-scoped.</strong>
              <small>
                Each source shows what it can read, write, and sync. BetterTrack never broadens
                access silently.
              </small>
            </span>
          </section>
          <section className="developer-connections">
            <h3>Build on your data</h3>
            <div>
              {[
                ['API keys', 'Programmatic portfolio access', 'command'],
                ['OAuth apps', 'Connect third-party products', 'link'],
                ['Webhooks', 'React to portfolio changes', 'activity'],
                ['MCP', 'Give an AI selected read context', 'ai'],
              ].map(([title, copy, icon]) => (
                <button key={title} onClick={onDeveloper} type="button">
                  <Icon name={icon as IconName} />
                  <span>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </span>
                  <Icon name="chevron-right" size={13} />
                </button>
              ))}
            </div>
            <button className="developer-platform-link" onClick={onDeveloper} type="button">
              Open Developer Platform
              <Icon name="arrow-right" size={13} />
            </button>
          </section>
        </div>
      </aside>
    </div>
  );
}

function AssistantPanel({
  scope,
  privateMode,
  onClose,
  onOpenWorkbench,
  onSubmitProposal,
}: {
  scope: Scope;
  privateMode: boolean;
  onClose: () => void;
  onOpenWorkbench: () => void;
  onSubmitProposal: (entry: OriginReviewEntry) => void;
}) {
  const [question, setQuestion] = useState('');
  const [answered, setAnswered] = useState(false);
  const [proposed, setProposed] = useState(false);

  function ask(prompt?: string) {
    if (prompt) setQuestion(prompt);
    setAnswered(true);
  }

  return (
    <div className="assistant-shell" role="presentation" onMouseDown={onClose}>
      <aside
        className="assistant-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Ask BetterTrack"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="assistant-panel__header">
          <div className="assistant-title">
            <span>
              <Icon name="sparkles" />
            </span>
            <span>
              <small>Portfolio intelligence</small>
              <strong>Ask BetterTrack</strong>
            </span>
          </div>
          <Button variant="quiet" size="icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </Button>
        </header>
        <div className="assistant-scope">
          <span className="scope-option__icon" style={{ '--scope-color': scope.accent } as never}>
            <Icon name={scope.icon} size={15} />
          </span>
          <span>
            <small>CONTEXT</small>
            <strong>{scope.name}</strong>
          </span>
          <button type="button">Change</button>
          <span className="permission-pill">
            <Icon name="eye" size={12} />
            Read
          </span>
          <span className="permission-pill">
            <Icon name="document" size={12} />
            Propose
          </span>
        </div>
        <div className="assistant-conversation">
          {!answered ? (
            <div className="assistant-empty">
              <span className="assistant-orbit">
                <i />
                <i />
                <Icon name="sparkles" />
              </span>
              <h2>What do you want to understand or test?</h2>
              <p>
                I can explain your data, build a scenario, or prepare an action for review. I will
                never change a portfolio without confirmation.
              </p>
              <div className="prompt-suggestions">
                {[
                  'Why did my wealth change this month?',
                  'What if I invest €200 monthly into VWCE for 10 years?',
                  'Where am I most concentrated?',
                  'Show expenses that grew faster than income.',
                ].map((prompt) => (
                  <button key={prompt} type="button" onClick={() => ask(prompt)}>
                    {prompt}
                    <Icon name="arrow-right" size={13} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="assistant-answer">
              <div className="user-message">
                {question || 'What if I invest €200 monthly into VWCE for 10 years?'}
              </div>
              <div className="assistant-message">
                <span className="assistant-message__mark">
                  <Icon name="sparkles" size={16} />
                </span>
                <div>
                  <p>
                    Using your current <strong>{scope.name}</strong> as the starting point, a €200
                    monthly VWCE contribution could add roughly <strong>€33,000–€39,000</strong>{' '}
                    over ten years under a balanced return range.
                  </p>
                  <div className="answer-metrics">
                    <span>
                      <small>Contributed</small>
                      <strong>{privateMode ? '••••' : '€24,000'}</strong>
                    </span>
                    <span>
                      <small>Estimated growth</small>
                      <strong className="positive">{privateMode ? '••••' : '+€8,980'}</strong>
                    </span>
                    <span>
                      <small>Midpoint in 2036</small>
                      <strong>{privateMode ? '••••' : '€332,140'}</strong>
                    </span>
                  </div>
                  <button className="answer-scenario" onClick={onOpenWorkbench} type="button">
                    <span>
                      <Icon name="workbench" />
                    </span>
                    <span>
                      <strong>Open as an editable Workbench scenario</strong>
                      <small>Return, inflation, fees, tax, timing, and asset are adjustable.</small>
                    </span>
                    <Icon name="arrow-right" />
                  </button>
                  <div className="answer-sources">
                    <Icon name="link" size={14} />
                    Based on 18 holdings, 4,281 activities, your AT tax profile, and stated
                    assumptions.
                  </div>
                  {!proposed ? (
                    <button
                      className="propose-action"
                      type="button"
                      onClick={() => setProposed(true)}
                    >
                      <Icon name="repeat" size={15} />
                      Prepare a €200 monthly automation
                    </button>
                  ) : (
                    <div className="action-proposal">
                      <span className="action-proposal__header">
                        <span>
                          <Icon name="document" />
                        </span>
                        <span>
                          <small>ACTION PROPOSAL · NOT APPLIED</small>
                          <strong>Invest €200 into VWCE monthly</strong>
                        </span>
                      </span>
                      <dl>
                        <div>
                          <dt>Portfolio</dt>
                          <dd>{scope.name}</dd>
                        </div>
                        <div>
                          <dt>Funding source</dt>
                          <dd>Cash & equivalents</dd>
                        </div>
                        <div>
                          <dt>Schedule</dt>
                          <dd>Last business day</dd>
                        </div>
                      </dl>
                      <div>
                        <Button variant="ghost" onClick={() => setProposed(false)}>
                          Discard
                        </Button>
                        <Button
                          variant="primary"
                          icon="shield"
                          onClick={() =>
                            onSubmitProposal({
                              id: 'assistant_vwce_dca',
                              kind: 'ai',
                              title: 'Review AI-drafted €200 monthly VWCE plan',
                              summary:
                                'Ask BetterTrack prepared a proposal from the selected portfolio and stated assumptions.',
                              portfolio: scope.name,
                              source: {
                                label: 'Ask BetterTrack',
                                actor: 'Alex Morgan',
                                detail: 'Read + propose permission',
                              },
                              requestedAt: '2026-07-27T10:42:00+02:00',
                              priority: 'normal',
                              risk: 'medium',
                              tags: ['AI proposal', 'DCA', 'Automation'],
                              diff: [
                                {
                                  label: 'Automation',
                                  before: 'None',
                                  after: '€200 monthly into VWCE',
                                },
                                {
                                  label: 'Funding',
                                  before: 'Unallocated cash',
                                  after: 'Cash & equivalents',
                                },
                                { label: 'Write mode', before: 'None', after: 'Proposal only' },
                              ],
                              calculations: [
                                { label: 'Ten-year contributions', value: '€24,000' },
                                {
                                  label: 'Modeled range',
                                  value: '€33,000–€39,000',
                                  tone: 'positive',
                                },
                              ],
                              lineage: [
                                {
                                  label: 'Grounded portfolio context',
                                  detail: '18 holdings · 4,281 activities · AT tax profile',
                                  state: 'verified',
                                },
                              ],
                              permissions: [
                                { label: 'Read portfolio', outcome: 'allowed' },
                                { label: 'Submit proposal', outcome: 'allowed' },
                                { label: 'Activate writes', outcome: 'review' },
                              ],
                              policies: [
                                {
                                  title: 'AI never silently writes',
                                  description: 'An owner must inspect and approve the exact diff.',
                                  status: 'pass',
                                },
                              ],
                            })
                          }
                        >
                          Review permissions
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <form
          className="assistant-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim()) ask();
          }}
        >
          <textarea
            aria-label="Ask BetterTrack"
            placeholder="Ask about this portfolio…"
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div>
            <span>
              <Icon name="shield" size={13} />
              No writes without review
            </span>
            <Button variant="primary" size="icon" type="submit" aria-label="Send">
              <Icon name="arrow-up" />
            </Button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function CommandPalette({
  onClose,
  onDestination,
  onScope,
  onOverlay,
  onWorkbenchView,
}: {
  onClose: () => void;
  onDestination: (destination: Destination) => void;
  onScope: (scope: Scope) => void;
  onOverlay: (overlay: Overlay) => void;
  onWorkbenchView: (view: WorkbenchView) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useAccessibleDialog<HTMLElement>({
    open: true,
    onClose,
    initialFocusSelector: '[aria-label="Search anything"]',
  });
  const actions: Array<{
    label: string;
    hint: string;
    icon: IconName;
    run: () => void;
  }> = [
    {
      label: 'Open Personal wealth',
      hint: 'Portfolio',
      icon: 'wallet',
      run: () => {
        onScope(scopes[1]!);
        onDestination('portfolios');
      },
    },
    {
      label: 'Add an expense',
      hint: 'Create',
      icon: 'cash',
      run: () => onOverlay('create'),
    },
    {
      label: 'Search assets and build an order',
      hint: 'Assets',
      icon: 'search',
      run: () => onDestination('assets'),
    },
    {
      label: 'Import and reconcile portfolio data',
      hint: 'Import Hub',
      icon: 'upload',
      run: () => onOverlay('import'),
    },
    {
      label: 'Review portfolio events and corporate actions',
      hint: 'Dividends, splits, rights, mergers, and issuer notices',
      icon: 'calendar',
      run: () => onOverlay('events'),
    },
    {
      label: 'Create or nest a portfolio',
      hint: 'Portfolio structure',
      icon: 'layers',
      run: () => onOverlay('portfolio-create'),
    },
    {
      label: 'Manage portfolio structure and ownership',
      hint: 'Nesting, effective ownership, linked debt, and lifecycle',
      icon: 'layers',
      run: () => onOverlay('structure'),
    },
    {
      label: 'Configure portfolio settings and lifecycle',
      hint: 'Identity, calculation, data, access, approvals, split, and archive',
      icon: 'settings',
      run: () => onOverlay('portfolio-settings'),
    },
    {
      label: 'Manage private-market commitments',
      hint: 'Capital calls, valuations, liquidity, evidence, and returns',
      icon: 'layers',
      run: () => onOverlay('private-markets'),
    },
    {
      label: 'Build a monthly investment scenario',
      hint: 'Workbench',
      icon: 'workbench',
      run: () => {
        onWorkbenchView('Studio');
        onDestination('workbench');
      },
    },
    {
      label: 'Calculate a constraint-aware rebalance',
      hint: 'Workbench · exact trades, tax, cash, and policy limits',
      icon: 'repeat',
      run: () => {
        onWorkbenchView('Rebalance');
        onDestination('workbench');
      },
    },
    {
      label: 'Open collaboration workspace',
      hint: 'People',
      icon: 'people',
      run: () => onDestination('people'),
    },
    {
      label: 'Ask BetterTrack',
      hint: 'Portfolio intelligence',
      icon: 'sparkles',
      run: () => onOverlay('assistant'),
    },
    {
      label: 'Review uncategorized activity',
      hint: '3 items',
      icon: 'inbox',
      run: () => onOverlay('review'),
    },
    {
      label: 'Manage connections',
      hint: 'Data sources',
      icon: 'link',
      run: () => onOverlay('connections'),
    },
    {
      label: 'Inspect portfolio data health',
      hint: 'Field-level checks, lineage, and evidence',
      icon: 'activity',
      run: () => onOverlay('data-health'),
    },
    {
      label: 'Manage backups, exports, and retention',
      hint: 'Data management',
      icon: 'database',
      run: () => onOverlay('data-management'),
    },
    {
      label: 'Open Developer Platform',
      hint: 'API keys, OAuth, webhooks, MCP, and logs',
      icon: 'code',
      run: () => onDestination('developer'),
    },
  ];
  const filtered = actions.filter((action) =>
    `${action.label} ${action.hint}`.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function executeAction(index: number) {
    const action = filtered[index];
    if (!action) return;
    onClose();
    action.run();
  }

  function handleCommandKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (!filtered.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % filtered.length);
      inputRef.current?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + filtered.length) % filtered.length);
      inputRef.current?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      inputRef.current?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(filtered.length - 1);
      inputRef.current?.focus();
    } else if (event.key === 'Enter' && document.activeElement === inputRef.current) {
      event.preventDefault();
      executeAction(activeIndex);
    }
  }

  return (
    <div className="command-overlay" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Search BetterTrack"
        aria-modal="true"
        className="command-palette"
        onKeyDown={handleCommandKey}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="command-palette__input">
          <Icon name="search" />
          <input
            autoFocus
            aria-activedescendant={
              filtered[activeIndex] ? `command-action-${activeIndex}` : undefined
            }
            aria-label="Search anything"
            aria-controls="command-results"
            placeholder="Search portfolios, assets, activity, or commands…"
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-palette__body" id="command-results">
          <span className="command-section-label">{query ? 'Best matches' : 'Suggested'}</span>
          {filtered.map((action, index) => (
            <button
              aria-current={index === activeIndex ? 'true' : undefined}
              className={index === activeIndex ? 'is-active' : ''}
              id={`command-action-${index}`}
              key={action.label}
              type="button"
              onClick={() => executeAction(index)}
              onMouseMove={() => setActiveIndex(index)}
            >
              <span>
                <Icon name={action.icon} />
              </span>
              <strong>{action.label}</strong>
              <small>{action.hint}</small>
              <Icon name="arrow-right" size={14} />
            </button>
          ))}
          {!filtered.length ? (
            <div className="command-empty">
              <Icon name="search" />
              <strong>No demo result for “{query}”</strong>
              <small>The production search will cover the entire workspace.</small>
            </div>
          ) : null}
        </div>
        <footer className="command-palette__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            Navigate
          </span>
          <span>
            <kbd>↵</kbd>
            Open
          </span>
          <span>
            <Icon name="command" size={12} />K Anywhere
          </span>
        </footer>
      </section>
    </div>
  );
}

function MobileNav({
  destination,
  destinations,
  onDestination,
  onCreate,
}: {
  destination: Destination;
  destinations: Destination[];
  onDestination: (destination: Destination) => void;
  onCreate: () => void;
}) {
  const configured = destinations.map((id) => destinationItems.find((item) => item.id === id)!);
  const items: Array<{ id: Destination | 'create'; label: string; icon: IconName }> = [
    ...configured.slice(0, 2),
    { id: 'create', label: 'Create', icon: 'plus' },
    ...configured.slice(2),
  ];
  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {items.map((item) => (
        <button
          className={cn(
            destination === item.id && 'is-active',
            item.id === 'create' && 'mobile-nav__create',
          )}
          key={item.id}
          type="button"
          onClick={() => (item.id === 'create' ? onCreate() : onDestination(item.id))}
        >
          <span>
            <Icon name={item.icon} />
          </span>
          <small>{item.label}</small>
        </button>
      ))}
    </nav>
  );
}

function NotificationsPanel({
  items,
  onClose,
  onRead,
  onOpenItem,
  onOpenReview,
}: {
  items: DemoNotification[];
  onClose: () => void;
  onRead: (id: string) => void;
  onOpenItem: (item: DemoNotification) => void;
  onOpenReview: () => void;
}) {
  const [filter, setFilter] = useState<'All' | 'Unread'>('All');
  const visible = filter === 'Unread' ? items.filter((item) => !item.read) : items;
  return (
    <OverlayShell
      description="Changes, decisions, and events across the portfolios you can access."
      onClose={onClose}
      title="Notifications"
    >
      <div className="origin-notifications">
        <div className="origin-notifications__toolbar">
          <div>
            {(['All', 'Unread'] as const).map((item) => (
              <button
                className={filter === item ? 'is-active' : ''}
                key={item}
                onClick={() => setFilter(item)}
                type="button"
              >
                {item}
                {item === 'Unread' ? (
                  <span>{items.filter((entry) => !entry.read).length}</span>
                ) : null}
              </button>
            ))}
          </div>
          <button
            onClick={() => items.filter((item) => !item.read).forEach((item) => onRead(item.id))}
            type="button"
          >
            Mark all read
          </button>
        </div>
        <div className="origin-notification-day">
          <small>TODAY</small>
          {visible.map((item) => (
            <button
              className={item.read ? '' : 'is-unread'}
              key={item.id}
              onClick={() => {
                onRead(item.id);
                onOpenItem(item);
              }}
              type="button"
            >
              <span>
                <Icon name={item.icon} />
              </span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.copy}</small>
                <em>{item.time}</em>
              </span>
              {!item.read ? <i /> : <Icon name="chevron-right" size={13} />}
            </button>
          ))}
          {!visible.length ? (
            <div className="origin-notifications__empty">
              <Icon name="check" />
              <strong>You are caught up.</strong>
              <small>Important portfolio events will appear here.</small>
            </div>
          ) : null}
        </div>
        <section className="origin-notification-review">
          <Icon name="inbox" />
          <span>
            <strong>Notifications tell you. Review lets you decide.</strong>
            <small>Open proposed writes, conflicts, and permission requests in one queue.</small>
          </span>
          <Button variant="secondary" onClick={onOpenReview}>
            Open Review
          </Button>
        </section>
      </div>
    </OverlayShell>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <div className="toast" role="status">
      <span>
        <Icon name="check" />
      </span>
      {message}
    </div>
  );
}

export function App() {
  const [surface, setSurface] = useState<ProductSurface>('app');
  const [direction, setDirection] = usePersistentState<DesignDirection>(
    'bt-demo-direction-v2',
    'origin',
  );
  const [destination, setDestination] = usePersistentState<Destination>(
    'bt-demo-destination',
    'home',
  );
  const [workbenchView, setWorkbenchView] = usePersistentState<WorkbenchView>(
    'bt-demo-workbench-view',
    'Studio',
  );
  const [scopeId, setScopeId] = usePersistentState('bt-demo-scope', 'all');
  const [portfolioTab, setPortfolioTab] = useState<PortfolioTab>('overview');
  const [privateMode, setPrivateMode] = usePersistentState('bt-demo-private', false);
  const [theme, setTheme] = usePersistentState<Theme>('bt-demo-theme', 'system');
  const [density, setDensity] = usePersistentState<Density>('bt-demo-density', 'comfortable');
  const [visibleWidgets, setVisibleWidgets] = usePersistentState<string[]>(
    'bt-demo-widgets-calm-v1',
    ['review'],
  );
  const [mobileDestinations, setMobileDestinations] = usePersistentState<Destination[]>(
    'bt-demo-mobile-nav',
    ['home', 'portfolios', 'workbench', 'assets'],
  );
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [reviewFocusId, setReviewFocusId] = useState<string | null>(null);
  const [connections, setConnections] = usePersistentState<Record<string, boolean>>(
    'bt-demo-connections',
    { trade: true, parqet: true, sparkasse: true, drive: false },
  );
  const [originConnections, setOriginConnections] = usePersistentState<OriginConnectionRecord[]>(
    'bt-demo-origin-connections',
    createOriginSeedConnections({ id: 'personal', name: 'Personal wealth', currency: 'EUR' }),
  );
  const [customActivities, setCustomActivities] = usePersistentState<DemoActivity[]>(
    'bt-demo-activities',
    [],
  );
  const [trades, setTrades] = usePersistentState<OriginTradeResult[]>('bt-demo-trades', []);
  const [cashFlows, setCashFlows] = usePersistentState<OriginCashFlowResult[]>(
    'bt-demo-cash-flows',
    [],
  );
  const [imports, setImports] = usePersistentState<OriginImportResult[]>('bt-demo-imports', []);
  const [originReviews, setOriginReviews] = usePersistentState<OriginReviewEntry[]>(
    'bt-demo-origin-reviews',
    initialOriginReviews,
  );
  const [originStructureGraph, setOriginStructureGraph] = usePersistentState(
    'bt-demo-origin-portfolio-graph-v2',
    createOriginStructureSeedGraph(),
  );
  const [pendingStructureMutations, setPendingStructureMutations] = usePersistentState<
    Record<string, OriginStructureMutation>
  >('bt-demo-origin-structure-mutations-v1', {});
  const [shares, setShares] = usePersistentState<OriginShareResult[]>('bt-demo-shares', []);
  const [availableCash, setAvailableCash] = usePersistentState('bt-demo-available-cash', 35492.87);
  const [createdPortfolios, setCreatedPortfolios] = usePersistentState<OriginPortfolioResult[]>(
    'bt-demo-created-portfolios',
    [],
  );
  const [, setFirstRun] = usePersistentState<OriginFirstRunResult | null>(
    'bt-demo-first-run',
    null,
  );
  const [dataHome, setDataHome] = usePersistentState<'hosted' | 'drive' | 'local'>(
    'bt-demo-data-home',
    'hosted',
  );
  const [notifications, setNotifications] = usePersistentState<DemoNotification[]>(
    'bt-demo-notifications',
    [
      {
        id: 'daily-brief',
        title: 'Your daily portfolio brief is ready',
        copy: 'Global equities added €1,184; EUR/USD reduced the gain by €126.',
        time: '8 min ago',
        read: false,
        icon: 'sparkles',
      },
      {
        id: 'import-review',
        title: 'Drive import needs one decision',
        copy: '12 activities mapped. One duplicate is waiting in Review.',
        time: '34 min ago',
        read: false,
        icon: 'upload',
      },
      {
        id: 'collaborator',
        title: 'Mia proposed a value update',
        copy: 'Riverside property · €138,400 → €144,900.',
        time: '2 hr ago',
        read: true,
        icon: 'people',
      },
    ],
  );
  const [tradeAsset, setTradeAsset] = useState<OriginAsset>(() =>
    originAssetFromRow(assetRows[0]!),
  );
  const [portfolioCreateParent, setPortfolioCreateParent] = useState<string | null>(null);
  const [pendingInvite, setPendingInvite] = usePersistentState<PendingInvite | null>(
    'bt-demo-invited',
    null,
  );
  const [toast, setToast] = useState('');
  const allScopes = useMemo<Scope[]>(() => {
    const tradeValueImpactFor = (portfolioName: string) =>
      trades
        .filter((trade) => trade.portfolio === portfolioName)
        .reduce(
          (sum, trade) =>
            sum + (trade.side === 'Buy' ? -trade.fees : trade.cashImpact - trade.gross),
          0,
        );
    const cashFlowImpactFor = (portfolioName: string) =>
      cashFlows
        .filter((entry) => entry.portfolio === portfolioName)
        .reduce((sum, entry) => sum + entry.cashImpact, 0);
    const totalTradeValueImpact = trades.reduce(
      (sum, trade) => sum + (trade.side === 'Buy' ? -trade.fees : trade.cashImpact - trade.gross),
      0,
    );
    const totalCashFlowImpact = cashFlows.reduce((sum, entry) => sum + entry.cashImpact, 0);
    const seededScopes = scopes.map((item) => {
      const valueImpact =
        item.id === 'all'
          ? totalCashFlowImpact + totalTradeValueImpact
          : cashFlowImpactFor(item.name) + tradeValueImpactFor(item.name);
      if (valueImpact === 0) return item;
      const adjustedChart = [...item.chart];
      const lastIndex = adjustedChart.length - 1;
      adjustedChart[lastIndex] = (adjustedChart[lastIndex] ?? 0) + valueImpact / 1000;
      return { ...item, value: item.value + valueImpact, chart: adjustedChart };
    });
    return [
      ...seededScopes,
      ...createdPortfolios.map((portfolio, index) => {
        const value = cashFlowImpactFor(portfolio.name) + tradeValueImpactFor(portfolio.name);
        return {
          id: portfolio.id,
          name: portfolio.name,
          eyebrow: `${portfolio.kind} · ${portfolio.privacy.toLowerCase()}`,
          value,
          change: value,
          changePct: 0,
          icon: 'portfolio' as IconName,
          accent: index % 2 === 0 ? '#f6b82e' : '#8cb6a8',
          childCount: 0,
          chart: Array.from({ length: 23 }, () => 0).concat(value / 1000),
        };
      }),
    ];
  }, [cashFlows, createdPortfolios, trades]);
  const scope = useMemo(
    () => allScopes.find((item) => item.id === scopeId) ?? allScopes[0]!,
    [allScopes, scopeId],
  );
  const displayedOriginStructureGraph = useMemo(
    () => ({
      ...originStructureGraph,
      nodes: originStructureGraph.nodes.map((node) => {
        const connectedScope =
          node.id === originStructureGraph.rootId
            ? allScopes.find((item) => item.id === 'all')
            : node.id === 'global-core'
              ? allScopes.find((item) => item.id === 'personal')
              : allScopes.find((item) => item.id === node.id || item.name === node.name);
        if (!connectedScope || node.id === 'riverside-property') return node;
        return { ...node, value: connectedScope.value };
      }),
    }),
    [allScopes, originStructureGraph],
  );
  const totalReviewCount = originReviews.filter(
    (item) => (item.status ?? 'pending') === 'pending',
  ).length;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const applyTheme = () => {
      const resolved = theme === 'system' ? (media.matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  useEffect(() => {
    document.documentElement.dataset.direction = direction;
  }, [direction]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOverlay('command');
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setOverlay('assistant');
      }
      if (event.key === 'Escape') setOverlay(null);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function chooseScope(next: Scope) {
    setScopeId(next.id);
  }

  function openPortfolio(next: Scope) {
    chooseScope(next.id === 'all' ? scopes[1]! : next);
    setDestination('portfolios');
    setPortfolioTab('overview');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function navigate(next: Destination) {
    setDestination(next);
    if (next === 'portfolios' && scope.id === 'all') {
      setPortfolioTab('overview');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleConnection(id: string, name: string) {
    const connected = connections[id] ?? false;
    if (connected) {
      setToast(`${name} settings opened`);
      return;
    }
    setConnections({ ...connections, [id]: true });
    setToast(`${name} connected to ${scope.name}`);
  }

  function updateOriginConnection(change: OriginConnectionChange) {
    setOriginConnections((current) => {
      const exists = current.some((item) => item.id === change.connection.id);
      return exists
        ? current.map((item) => (item.id === change.connection.id ? change.connection : item))
        : [change.connection, ...current];
    });
    const legacyKey =
      change.connection.provider.id === 'google-drive'
        ? 'drive'
        : change.connection.provider.id === 'trade-republic'
          ? 'trade'
          : change.connection.provider.id === 'erste'
            ? 'sparkasse'
            : change.connection.provider.id;
    setConnections((current) => ({
      ...current,
      [legacyKey]: change.connection.status !== 'disconnected',
    }));
    setToast(`${change.connection.provider.name} · ${change.type.replaceAll('-', ' ')}`);
  }

  function saveActivity(activity: {
    title: string;
    amount: number;
    kind: 'expense' | 'income' | 'transfer';
    grossAmount: number;
    destination?: string;
  }) {
    const id = `activity_${customActivities.length + 1}`;
    const activityScope = scope.id === 'all' ? scopes[1]! : scope;
    setCustomActivities([
      {
        id,
        portfolioId: activityScope.id,
        portfolioName: activityScope.name,
        title: activity.title,
        amount: activity.amount,
        detail:
          activity.kind === 'transfer'
            ? `Internal transfer · ${activityScope.name} → ${activity.destination ?? 'Another portfolio'} · ${moneyFormatter.format(activity.grossAmount)} · net zero`
            : `Manual ${activity.kind} · Demo`,
        source: 'Added by you',
        status: 'Confirmed',
        icon:
          activity.kind === 'transfer' ? 'repeat' : activity.amount < 0 ? 'arrow-up' : 'arrow-down',
        date: 'Just now',
      },
      ...customActivities,
    ]);
    if (activity.kind !== 'transfer') setAvailableCash(availableCash + activity.amount);
    setOverlay(null);
    setDestination('portfolios');
    if (scope.id === 'all') chooseScope(scopes[1]!);
    setPortfolioTab('activity');
    setToast(
      activity.kind === 'transfer'
        ? `${moneyFormatter.format(activity.grossAmount)} moved internally · all wealth unchanged`
        : `${activity.title} added to the portfolio activity`,
    );
  }

  function openTrade(asset: OriginAsset) {
    setTradeAsset(asset);
    setOverlay('trade');
  }

  function completeTrade(trade: OriginTradeResult) {
    setTrades([trade, ...trades]);
    setAvailableCash(availableCash + trade.cashImpact);
    setCustomActivities([
      {
        id: trade.id,
        portfolioId: allScopes.find((item) => item.name === trade.portfolio)?.id,
        portfolioName: trade.portfolio,
        title: `${trade.side} ${trade.asset.symbol}`,
        amount: trade.cashImpact,
        detail: `${trade.units.toLocaleString('en-IE', {
          maximumFractionDigits: 6,
        })} units · ${trade.orderType} · ${trade.asset.venue}`,
        source: trade.recurring ? 'Manual order · automation proposed' : 'Manual order',
        status: 'Filled · Demo',
        icon: 'assets',
        date: 'Just now',
      },
      ...customActivities,
    ]);
    if (trade.basisStatus === 'missing') {
      setOriginReviews([
        {
          id: `basis_${trade.id}`,
          kind: 'tax',
          title: `Resolve uncovered ${trade.asset.symbol} sell`,
          summary:
            'The sale is recorded for portfolio continuity, but missing acquisition history keeps tax results provisional.',
          portfolio: trade.portfolio,
          source: { label: 'Manual trade', detail: trade.id, actor: 'Alex Morgan' },
          requestedAt: '2026-07-27T10:42:00+02:00',
          priority: 'urgent',
          risk: 'high',
          tags: ['Sell', 'Missing basis', trade.asset.symbol],
          diff: [
            {
              label: 'Cost basis',
              before: 'Partially covered',
              after: 'Attach evidence or accept an estimate',
              tone: 'warning',
            },
          ],
          calculations: [
            { label: 'Sale value', value: moneyFormatter.format(trade.gross) },
            { label: 'Provisional tax', value: moneyFormatter.format(trade.gross * 0.031) },
          ],
          lineage: [
            { label: 'Recorded sale', detail: trade.id, state: 'verified' },
            {
              label: 'Position check',
              detail: 'Requested units exceeded the recorded position',
              state: 'warning',
            },
          ],
          permissions: [{ label: 'Finalize tax lot', outcome: 'blocked' }],
          policies: [
            {
              title: 'Evidence required',
              description: 'Tax reports stay provisional until the missing lot is resolved.',
              status: 'blocked',
            },
          ],
        },
        ...originReviews,
      ]);
    }
    setNotifications([
      {
        id: `notification_${trade.id}`,
        title: `${trade.side} simulated and recorded`,
        copy: `${trade.asset.symbol} updated cash, holdings context, activity, tax lots, and audit lineage.`,
        time: 'Just now',
        read: false,
        icon: 'assets',
      },
      ...notifications,
    ]);
    setOverlay(null);
    setDestination('portfolios');
    if (scope.id === 'all') chooseScope(scopes[1]!);
    setPortfolioTab('activity');
    setToast(`${trade.asset.symbol} order recorded across the portfolio`);
  }

  function handleTradeReceiptAction(
    action: 'download' | 'compare' | 'share',
    trade: OriginTradeResult,
  ) {
    if (action === 'download') {
      const payload = JSON.stringify(
        {
          demo: true,
          receipt: trade,
          notice: 'Fictional BetterTrack Origin execution receipt.',
        },
        null,
        2,
      );
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${trade.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setToast('Demo execution receipt downloaded');
      return;
    }
    completeTrade(trade);
    if (action === 'compare') {
      setOverlay(null);
      setDestination('workbench');
      setToast(`${trade.asset.symbol} fill opened as a Workbench comparison`);
    } else {
      setOverlay('share');
      setToast(`${trade.asset.symbol} fill recorded · choose collaboration access`);
    }
  }

  function completeCashFlow(result: OriginCashFlowResult) {
    setCashFlows([result, ...cashFlows.filter((item) => item.id !== result.id)]);
    setAvailableCash(availableCash + result.cashImpact);
    setCustomActivities([
      {
        id: result.id,
        portfolioId: allScopes.find((item) => item.name === result.portfolio)?.id,
        portfolioName: result.portfolio,
        title: result.title,
        amount: result.cashImpact,
        detail: `${result.kind} · ${result.category}${result.recurring ? ' · recurring' : ''}`,
        source: `${result.account} · ${result.document ?? 'Manual entry'}`,
        status: 'Confirmed',
        icon:
          result.kind === 'Income'
            ? 'arrow-down'
            : result.kind === 'Expense'
              ? 'arrow-up'
              : 'repeat',
        date: 'Just now',
      },
      ...customActivities,
    ]);
    setNotifications([
      {
        id: `notification_${result.id}`,
        title: `${result.kind} added to ${result.portfolio}`,
        copy: result.recurring
          ? `${result.schedule} now appears in cash flow, forecasts, plans, and reports.`
          : 'Cash, activity, reports, and audit lineage were updated together.',
        time: 'Just now',
        read: false,
        icon: 'cash',
      },
      ...notifications,
    ]);
    setOverlay(null);
    setDestination('portfolios');
    if (scope.id === 'all') chooseScope(scopes[1]!);
    setPortfolioTab('cash-flow');
    setToast(`${result.title} connected to the portfolio cash-flow ledger`);
  }

  function completePortfolio(portfolio: OriginPortfolioResult) {
    setCreatedPortfolios([...createdPortfolios, portfolio]);
    setOriginStructureGraph((current) => {
      if (current.nodes.some((node) => node.id === portfolio.id)) return current;
      const parent =
        current.nodes.find((node) => node.name === portfolio.parent) ??
        current.nodes.find((node) => node.id === current.rootId)!;
      const createdAt = new Date().toISOString();
      const normalizedKind = portfolio.kind.toLowerCase();
      const kind = normalizedKind.includes('company')
        ? ('business' as const)
        : normalizedKind.includes('property')
          ? ('property' as const)
          : normalizedKind.includes('reserve')
            ? ('reserve' as const)
            : ('portfolio' as const);
      return {
        ...current,
        nodes: [
          ...current.nodes,
          {
            id: portfolio.id,
            name: portfolio.name,
            kind,
            value: 0,
            currency: portfolio.currency,
            description: `${portfolio.kind} · ${portfolio.privacy.toLowerCase()} · ${portfolio.modules.length} capabilities`,
            reference: `PORT-${portfolio.id.toUpperCase().slice(-12)}`,
            status: 'active' as const,
            updatedAt: createdAt,
          },
        ],
        edges: [
          ...current.edges,
          {
            id: `contains-${parent.id}-${portfolio.id}`,
            kind: 'contains' as const,
            from: parent.id,
            to: portfolio.id,
            label: 'Contains',
            createdAt,
          },
          {
            id: `owns-${parent.id}-${portfolio.id}`,
            kind: 'owns' as const,
            from: parent.id,
            to: portfolio.id,
            percentage: 100,
            label: 'Direct ownership',
            createdAt,
          },
        ],
        audit: [
          {
            id: `structure-audit-${portfolio.id}`,
            at: createdAt,
            actor: 'You',
            action: 'Portfolio added to structure',
            detail: `${portfolio.name} created under ${parent.name}.`,
            objectId: portfolio.id,
            tone: 'positive' as const,
          },
          ...current.audit,
        ],
        updatedAt: createdAt,
      };
    });
    setPortfolioCreateParent(null);
    setScopeId(portfolio.id);
    setOverlay(null);
    setDestination('portfolios');
    setPortfolioTab('overview');
    setNotifications([
      {
        id: `notification_${portfolio.id}`,
        title: `${portfolio.name} is ready`,
        copy: `Nested inside ${portfolio.parent} with ${portfolio.modules.length} connected capabilities.`,
        time: 'Just now',
        read: false,
        icon: 'portfolio',
      },
      ...notifications,
    ]);
    setToast(`${portfolio.name} created as one connected portfolio`);
  }

  function completeImport(result: OriginImportResult) {
    const reversed = result.counts.imported === 0 && !result.undo.available;
    setImports([result, ...imports.filter((item) => item.id !== result.id)]);
    setCustomActivities([
      {
        id: result.id,
        portfolioId: allScopes.find((item) => item.name === result.portfolio)?.id,
        portfolioName: result.portfolio,
        title: reversed
          ? `Reversed ${result.sourceLabel} import`
          : `Imported ${result.counts.imported} activities`,
        amount: reversed ? 0 : 16.74,
        detail: reversed
          ? `${result.undo.operations} atomic operations reversed`
          : `${result.sourceLabel} · ${result.counts.skippedDuplicates} duplicate skipped`,
        source: `Import receipt ${result.id}`,
        status: reversed
          ? 'Reversed'
          : result.counts.needsReview
            ? 'Imported · follow-up review'
            : 'Imported',
        icon: 'upload',
        date: 'Just now',
      },
      ...customActivities,
    ]);
    if (!reversed) {
      setConnections({
        ...connections,
        [result.source]: true,
        drive: result.source === 'drive' ? true : (connections.drive ?? false),
      });
      if (result.source === 'broker' || result.source === 'drive') {
        const providerId =
          result.source === 'drive'
            ? 'google-drive'
            : result.sourceLabel.toLowerCase().includes('flatex')
              ? 'flatex'
              : result.sourceLabel.toLowerCase().includes('interactive')
                ? 'ibkr'
                : 'trade-republic';
        setOriginConnections((current) =>
          current.map((connection) =>
            connection.provider.id === providerId
              ? {
                  ...connection,
                  portfolio: { name: result.portfolio },
                  status: result.connection.status,
                  lastSyncAt: result.importedAt,
                  nextSyncAt: result.connection.nextSync
                    ? new Date(
                        new Date(result.importedAt).getTime() + 24 * 60 * 60 * 1000,
                      ).toISOString()
                    : connection.nextSyncAt,
                  health: {
                    ...connection.health,
                    records: connection.health.records + result.counts.imported,
                    coverage: 100,
                    openConflicts: result.counts.needsReview,
                  },
                  logs: [
                    {
                      id: `log_${result.id}`,
                      timestamp: result.importedAt,
                      event: 'Reviewed import applied',
                      detail: `${result.counts.imported} imported · ${result.counts.skippedDuplicates} duplicates skipped · receipt ${result.id}`,
                      status: result.counts.needsReview ? 'warning' : 'success',
                      records: result.counts.imported,
                    },
                    ...connection.logs,
                  ],
                }
              : connection,
          ),
        );
      }
    }
    if (!reversed && result.counts.needsReview > 0) {
      setOriginReviews([
        {
          id: `review_${result.id}`,
          kind: 'tax',
          title: `Resolve ${result.counts.needsReview} imported basis decision`,
          summary: `${result.sourceLabel} was applied atomically; one documented assumption remains visible.`,
          portfolio: result.portfolio,
          source: {
            label: result.sourceLabel,
            detail: `${result.id} · undo available until ${result.undo.expiresAt}`,
          },
          requestedAt: result.importedAt,
          priority: 'high',
          risk: 'medium',
          tags: ['Import', 'Cost basis'],
          diff: [
            {
              label: 'Cost basis',
              before: 'Missing',
              after: 'Needs evidence or explicit estimate',
              tone: 'warning',
            },
          ],
          lineage: [
            {
              label: 'Atomic import',
              detail: `${result.counts.imported} records · receipt ${result.id}`,
              state: 'verified',
            },
          ],
          permissions: [{ label: 'Finalize tax basis', outcome: 'review' }],
          policies: [
            {
              title: 'Basis completeness',
              description: 'Tax exports stay marked provisional until resolved.',
              status: 'warning',
            },
          ],
        },
        ...originReviews.filter((item) => item.id !== `review_${result.id}`),
      ]);
    }
    setNotifications([
      {
        id: `notification_${result.id}`,
        title: reversed
          ? `${result.sourceLabel} import reversed`
          : `${result.counts.imported} activities imported`,
        copy: reversed
          ? 'Objects covered by the atomic receipt were removed; later portfolio edits were preserved.'
          : `${result.sourceLabel} updated activity, holdings, cash, tax lineage, and the audit trail.`,
        time: 'Just now',
        read: false,
        icon: 'upload',
      },
      ...notifications,
    ]);
    setOverlay(null);
    setDestination('portfolios');
    if (scope.id === 'all') chooseScope(scopes[1]!);
    setPortfolioTab('activity');
    setToast(
      reversed
        ? `${result.sourceLabel} import reversed with an audit receipt`
        : `${result.sourceLabel} import applied with an undo receipt`,
    );
  }

  function decideOriginReview(
    item: OriginReviewEntry,
    receipt: OriginReviewReceipt,
    decision: 'approved' | 'rejected',
  ) {
    setOriginReviews(
      originReviews.map((entry) =>
        entry.id === item.id ? { ...entry, status: decision, receipt } : entry,
      ),
    );
    const structureMutation = pendingStructureMutations[item.id];
    if (structureMutation) {
      if (decision === 'approved') {
        setOriginStructureGraph((current) =>
          applyOriginStructureMutation(current, structureMutation, receipt),
        );
      }
      setPendingStructureMutations((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== item.id)),
      );
    }
    const reviewPortfolioId =
      typeof item.portfolio === 'string'
        ? (allScopes.find((candidate) => candidate.name === item.portfolio)?.id ?? scope.id)
        : (item.portfolio.id ?? scope.id);
    if (item.tags?.includes('portfolio-settings')) {
      applyOriginPortfolioSettingsReviewDecision(
        reviewPortfolioId,
        item.id,
        decision,
        receipt.reference,
      );
    }
    if (item.tags?.includes('Capital call') || item.tags?.includes('Valuation')) {
      const privateMarketDecision = applyOriginPrivateMarketsReviewDecision(
        reviewPortfolioId,
        item.id,
        decision,
        receipt.reference,
      );
      if (privateMarketDecision.cashDelta) {
        setAvailableCash((current) => current + privateMarketDecision.cashDelta);
      }
    }
    setNotifications([
      {
        id: `notification_${item.id}_${decision}`,
        title: `${decision === 'approved' ? 'Approved' : 'Rejected'}: ${item.title}`,
        copy: `Decision ${receipt.reference} is recorded with the exact diff and actor.`,
        time: 'Just now',
        read: false,
        icon: decision === 'approved' ? 'check' : 'x',
      },
      ...notifications,
    ]);
    setToast(`${item.title} ${decision}`);
  }

  function submitOriginProposal(entry: OriginReviewEntry, openReview = true) {
    setOriginReviews([entry, ...originReviews.filter((item) => item.id !== entry.id)]);
    setNotifications([
      {
        id: `notification_${entry.id}`,
        title: 'Proposal added to Review',
        copy: `${entry.title} is pending; no portfolio data changed.`,
        time: 'Just now',
        read: false,
        icon: 'inbox',
      },
      ...notifications,
    ]);
    if (openReview) setOverlay('review');
    setToast('Proposal staged safely in Review');
  }

  function submitAutomationProposal(proposal: OriginAutomationProposal) {
    submitOriginProposal({
      id: proposal.id,
      kind: 'automation',
      title: proposal.name,
      summary: proposal.plainEnglishRule,
      portfolio: proposal.portfolio,
      source: {
        label: 'Automation Builder',
        actor: 'Alex Morgan',
        detail: `Dry run ${proposal.dryRun.periodFrom}–${proposal.dryRun.periodTo}`,
      },
      requestedAt: proposal.createdAt,
      priority: proposal.dryRun.estimatedCashImpact < -1000 ? 'high' : 'normal',
      risk: proposal.reviewPolicy === 'approve-every-run' ? 'low' : 'medium',
      affectedCount: proposal.dryRun.wouldRun,
      tags: ['Automation', proposal.reviewPolicy],
      diff: [
        { label: 'Rule', before: 'Not configured', after: proposal.plainEnglishRule },
        { label: 'Next evaluation', before: '—', after: proposal.nextEvaluation },
        {
          label: 'Review policy',
          before: '—',
          after: proposal.reviewPolicy.replaceAll('-', ' '),
        },
      ],
      calculations: [
        { label: 'Historical evaluations', value: String(proposal.dryRun.evaluated) },
        { label: 'Would run', value: String(proposal.dryRun.wouldRun), tone: 'positive' },
        {
          label: 'Estimated cash impact',
          value: moneyFormatter.format(proposal.dryRun.estimatedCashImpact),
          tone: proposal.dryRun.estimatedCashImpact < 0 ? 'warning' : 'neutral',
        },
      ],
      lineage: [
        {
          label: 'Historical dry run',
          detail: proposal.dryRun.notes.join(' · '),
          state: 'derived',
        },
      ],
      permissions: proposal.permissions.map((permission) => ({
        label: permission,
        outcome: permission.toLowerCase().includes('proposed') ? 'review' : 'allowed',
      })),
      policies: [
        {
          title: 'Proposal before activation',
          description: 'Submitting this builder never activates or runs the automation.',
          status: 'pass',
        },
      ],
    });
  }

  function recordAutomationActivity(activity: OriginAutomationActivity) {
    setCustomActivities([
      {
        id: activity.id,
        portfolioId: allScopes.find((item) => item.name === activity.portfolio)?.id,
        portfolioName: activity.portfolio,
        title: activity.summary,
        amount: 0,
        detail: activity.type.replaceAll('.', ' · '),
        source: activity.receiptId ?? activity.proposalId ?? 'Automation workspace',
        status: 'Recorded',
        icon: 'repeat',
        date: 'Just now',
      },
      ...customActivities,
    ]);
    setNotifications([
      {
        id: `notification_${activity.id}`,
        title: activity.summary,
        copy: `${activity.portfolio} · full decision trace is available in the automation run log.`,
        time: 'Just now',
        read: false,
        icon: 'repeat',
      },
      ...notifications,
    ]);
  }

  function completeShare(result: OriginShareResult) {
    setShares([result, ...shares.filter((item) => item.id !== result.id)]);
    setNotifications([
      {
        id: `notification_${result.id}`,
        title:
          result.status === 'revoked'
            ? `Access to ${result.portfolio.name} revoked`
            : `${result.portfolio.name} shared safely`,
        copy:
          result.kind === 'collaboration'
            ? `${result.access.role} access · ${result.access.approvalPolicy}`
            : `Private view · ${result.security.expiresAt ?? 'no expiry'}`,
        time: 'Just now',
        read: false,
        icon: 'share',
      },
      ...notifications,
    ]);
    setOverlay(null);
    setDestination('people');
    setToast(result.status === 'revoked' ? 'Share access revoked' : 'Portfolio access created');
  }

  function finishFirstRun(result: OriginFirstRunResult) {
    setFirstRun(result);
    setDataHome(result.data.home);
    setConnections({
      ...connections,
      drive: result.data.home === 'drive' || (connections.drive ?? false),
      [result.data.source]: result.data.source !== 'skip',
    });
    setOriginConnections((current) => {
      let next = current;
      const upsert = (connection: OriginConnectionRecord) => {
        next = next.some((item) => item.id === connection.id)
          ? next.map((item) => (item.id === connection.id ? connection : item))
          : [connection, ...next];
      };
      if (result.data.home === 'drive') {
        const existing = next.find((item) => item.provider.id === 'google-drive');
        if (existing) {
          upsert({
            ...existing,
            portfolio: {
              id: result.portfolio.id,
              name: result.portfolio.name,
            },
            status: 'healthy',
            syncMode: 'data-home',
            driveRole: 'data-home',
            sourceAccount: result.account.email || existing.sourceAccount,
            sourceWorkspace: '/BetterTrack/Data Home',
            lastSyncAt: result.activatedAt,
            logs: [
              {
                id: `log_first_run_drive_${result.portfolio.id}`,
                timestamp: result.activatedAt,
                event: 'Drive selected as data home',
                detail: `${result.portfolio.name} activated with a portable Drive source of truth.`,
                status: 'success',
              },
              ...existing.logs,
            ],
          });
        }
      }
      if (
        result.data.source !== 'skip' &&
        result.data.source !== 'manual' &&
        result.data.provider
      ) {
        const providerIds = {
          'Trade Republic': 'trade-republic',
          Flatex: 'flatex',
          'Interactive Brokers': 'ibkr',
          George: 'erste',
          'Parqet workspace': 'parqet',
          'Erste / Sparkasse': 'erste',
          N26: 'n26',
          Revolut: 'revolut',
          Wise: 'wise',
        } as const;
        const providerId = providerIds[result.data.provider as keyof typeof providerIds];
        if (providerId) {
          const existing = next.find((item) => item.provider.id === providerId);
          const category =
            result.data.source === 'broker'
              ? 'broker'
              : result.data.source === 'parqet'
                ? 'portfolio-service'
                : 'bank';
          const syncMode =
            result.data.source === 'broker'
              ? 'continuous-import'
              : result.data.source === 'parqet'
                ? result.data.syncMode === 'two-way'
                  ? 'two-way'
                  : 'manual-import'
                : 'read-only-cash';
          const base: OriginConnectionRecord =
            existing ??
            ({
              id: `conn_first_run_${providerId}`,
              provider: {
                id: providerId,
                name: result.data.provider,
                category,
              },
              portfolio: {
                id: result.portfolio.id,
                name: result.portfolio.name,
              },
              status: 'healthy',
              syncMode,
              sourceAccount: `${result.data.provider} · first-run account`,
              permissions: [
                'Read selected account balances and positions',
                'Read booked transactions and related fees',
                'Refresh only while consent remains active',
              ],
              createdAt: result.activatedAt,
              lastSyncAt: result.activatedAt,
              nextSyncAt: null,
              health: {
                score: 98,
                records: result.data.importedRecords,
                coverage: 99,
                costBasisCoverage: 97,
                reconciledValue: result.portfolio.openingCash,
                sourceValue: result.portfolio.openingCash,
                unsupportedFields: [],
                missingCostBasis: result.data.importedRecords ? 1 : 0,
                openConflicts: 0,
              },
              logs: [],
              conflicts: [],
            } satisfies OriginConnectionRecord);
          upsert({
            ...base,
            portfolio: {
              id: result.portfolio.id,
              name: result.portfolio.name,
            },
            status: 'healthy',
            syncMode,
            lastSyncAt: result.activatedAt,
            health: {
              ...base.health,
              records: Math.max(base.health.records, result.data.importedRecords),
            },
            logs: [
              {
                id: `log_first_run_${providerId}_${result.portfolio.id}`,
                timestamp: result.activatedAt,
                event: 'Initial source approved',
                detail: `${result.data.importedRecords.toLocaleString()} records mapped during first run.`,
                status: 'success',
                records: result.data.importedRecords,
              },
              ...base.logs,
            ],
          });
        }
      }
      return next;
    });
    const portfolio: OriginPortfolioResult = {
      id: result.portfolio.id,
      name: result.portfolio.name,
      kind: result.portfolio.type,
      parent: result.portfolio.structure === 'single' ? 'All wealth' : 'All wealth',
      privacy: result.collaboration.mode === 'private' ? 'Private' : 'Shared',
      currency: result.region.currency,
      target: 'No target yet',
      modules: [
        'Holdings & performance',
        'Cash flow & recurring items',
        'Plans & targets',
        'Tax workspace',
      ],
    };
    if (!createdPortfolios.some((item) => item.id === portfolio.id)) {
      setCreatedPortfolios([...createdPortfolios, portfolio]);
    }
    setAvailableCash(result.portfolio.openingCash);
    setOriginReviews((current) => [
      {
        id: 'first-run-source',
        kind: 'import',
        title:
          result.data.importedRecords > 0
            ? `Review ${result.data.importedRecords} imported activities`
            : 'Complete your first data source',
        summary: `${result.data.source} · ${result.portfolio.name}`,
        portfolio: {
          id: result.portfolio.id,
          name: result.portfolio.name,
          path: `All wealth / ${result.portfolio.name}`,
        },
        source: {
          label: 'First-run setup',
          detail:
            result.data.importedRecords > 0
              ? `${result.data.importedRecords} records staged`
              : 'No source selected during setup',
          actor: result.account.displayName || 'Workspace owner',
        },
        requestedAt: result.activatedAt,
        priority: 'high',
        risk: result.data.importedRecords > 0 ? 'medium' : 'low',
        tags: ['First run', 'Import'],
        diff: [
          {
            label: 'Portfolio activity',
            before: 'Empty',
            after:
              result.data.importedRecords > 0
                ? `${result.data.importedRecords} staged records`
                : 'Add a source when ready',
            tone: result.data.importedRecords > 0 ? 'warning' : 'neutral',
          },
        ],
      },
      ...current.filter((item) => item.id !== 'first-run-source'),
    ]);
    setSurface('app');
    setScopeId(portfolio.id);
    setDestination('portfolios');
    setPortfolioTab('overview');
    setToast(`Welcome, ${result.account.displayName || 'Alex'} — your workspace is live`);
  }

  function sendInvite(invite: PendingInvite) {
    setPendingInvite(invite);
    setOverlay(null);
    setDestination('people');
    setToast(`Invitation sent to ${invite.email}`);
  }

  function selectSurface(next: ProductSurface) {
    setOverlay(null);
    setSurface(next);
    window.scrollTo({ top: 0 });
  }

  function resetDemo() {
    Object.keys(window.localStorage)
      .filter(
        (key) =>
          key.startsWith('bt-demo-') ||
          key.startsWith('bt-origin-') ||
          key.startsWith('bettertrack-origin-'),
      )
      .forEach((key) => window.localStorage.removeItem(key));
    window.location.reload();
  }

  if (surface !== 'app') {
    let secondarySurface: ReactNode;
    if (surface === 'auth') {
      secondarySurface = (
        <AuthSurface
          onBack={() => selectSurface('app')}
          onRegister={() => selectSurface('onboarding')}
          onSuccess={() => selectSurface('app')}
        />
      );
    } else if (surface === 'onboarding') {
      secondarySurface =
        direction === 'origin' ? (
          <OriginFirstRun onExit={() => selectSurface('app')} onFinish={finishFirstRun} />
        ) : (
          <OnboardingSurface
            onBack={() => selectSurface('app')}
            onFinish={() => selectSurface('app')}
          />
        );
    } else if (surface === 'settings') {
      secondarySurface =
        direction === 'origin' ? (
          <OriginSecurity
            dataHome={dataHome}
            onBack={() => selectSurface('app')}
            onSignedOut={(receipt: OriginSecurityDeletedReceipt) => {
              setToast(`Account deletion recorded · ${receipt.id}`);
              selectSurface('auth');
            }}
            onToast={setToast}
          />
        ) : (
          <SettingsSurface onBack={() => selectSurface('app')} />
        );
    } else if (surface === 'public') {
      secondarySurface = (
        <PublicShareSurface
          onBack={() => selectSurface('app')}
          onSignIn={() => selectSurface('auth')}
        />
      );
    } else if (surface === 'advisor') {
      secondarySurface = <AdvisorSurface onBack={() => selectSurface('app')} />;
    } else {
      secondarySurface = <AdminSurface onBack={() => selectSurface('app')} />;
    }
    return (
      <>
        {secondarySurface}
        <PreviewDock surface={surface} onSelect={selectSurface} />
      </>
    );
  }

  let page: ReactNode;
  switch (destination) {
    case 'portfolios':
      page =
        scope.id === 'all' ? (
          <PortfolioDirectory
            privateMode={privateMode}
            portfolios={allScopes}
            onOpenPortfolio={openPortfolio}
            onCreate={() => setOverlay('portfolio-create')}
            onImport={() => setOverlay('import')}
            onStructure={() => setOverlay('structure')}
          />
        ) : (
          <PortfolioDetail
            scope={scope}
            direction={direction}
            tab={portfolioTab}
            onTab={setPortfolioTab}
            privateMode={privateMode}
            customActivities={customActivities.filter(
              (activity) =>
                (!activity.portfolioId && !activity.portfolioName) ||
                activity.portfolioId === scope.id ||
                activity.portfolioName === scope.name,
            )}
            driveConnected={connections.drive ?? false}
            onOverlay={setOverlay}
            onDataHealth={() => setOverlay('data-health')}
            onSecurity={() => selectSurface('settings')}
            availableCash={availableCash}
            latestTrade={trades.find((trade) => trade.portfolio === scope.name)}
            cashFlows={cashFlows.filter((item) => item.portfolio === scope.name)}
            portfolioTrades={trades.filter((trade) => trade.portfolio === scope.name)}
            portfolioShares={shares.filter(
              (share) => share.portfolio.id === scope.id || share.portfolio.name === scope.name,
            )}
            onAutomationActivity={recordAutomationActivity}
            onAutomationProposal={submitAutomationProposal}
            onCollaborationProposal={(proposal) => submitOriginProposal(proposal)}
            onReviewProposal={submitOriginProposal}
            onToast={setToast}
            onOpenWorkbench={(context) => {
              navigate('workbench');
              setToast(
                context.startsWith('fee-replacement:')
                  ? 'Fee replacement scenario opened in Workbench'
                  : 'Stress scenario opened in Workbench',
              );
            }}
          />
        );
      break;
    case 'workbench':
      page = (
        <WorkbenchPage
          scope={scope}
          availableScopes={allScopes}
          direction={direction}
          privateMode={privateMode}
          activeView={workbenchView}
          onView={setWorkbenchView}
          onAssistant={() => setOverlay('assistant')}
          onCollaborate={() => navigate('people')}
          onOpenGoals={() => {
            navigate('portfolios');
            if (scope.id === 'all') chooseScope(allScopes[1]!);
            setPortfolioTab('plan');
          }}
          onOpenTax={() => {
            navigate('portfolios');
            if (scope.id === 'all') chooseScope(allScopes[1]!);
            setPortfolioTab('tax');
          }}
          onSubmitProposal={submitOriginProposal}
          onToast={setToast}
          onScope={chooseScope}
        />
      );
      break;
    case 'assets':
      page = (
        <AssetsPage
          direction={direction}
          privateMode={privateMode}
          onTrade={openTrade}
          onToast={setToast}
        />
      );
      break;
    case 'people':
      page = (
        <PeoplePage
          onAccessOverview={() => {
            navigate('portfolios');
            if (scope.id === 'all') chooseScope(allScopes[1]!);
            setPortfolioTab('people');
          }}
          onInvite={() => setOverlay('invite')}
          onOpenPortfolio={(name) => {
            const nextScope = allScopes.find((item) => item.name === name);
            if (nextScope) openPortfolio(nextScope);
            else setToast(`${name} is available from its parent portfolio`);
          }}
          onOpenReview={(id) => {
            setReviewFocusId(id);
            setOverlay('review');
          }}
          pendingInvite={pendingInvite}
        />
      );
      break;
    case 'developer':
      page = (
        <DeveloperPage onOpenConnections={() => setOverlay('connections')} onToast={setToast} />
      );
      break;
    case 'home':
    default:
      page = (
        <HomePage
          scope={scope}
          direction={direction}
          privateMode={privateMode}
          reviewItems={originReviews.filter((item) => (item.status ?? 'pending') === 'pending')}
          onOpenReview={(id) => {
            setReviewFocusId(id ?? null);
            setOverlay('review');
          }}
          onOpenPortfolio={openPortfolio}
          onOpenPortfolioTab={(tab) => {
            if (scope.id === 'all') chooseScope(scopes[1]!);
            setDestination('portfolios');
            setPortfolioTab(tab);
          }}
          onOpenWorkbench={() => {
            setWorkbenchView('Studio');
            navigate('workbench');
          }}
          onOverlay={setOverlay}
          visibleWidgets={visibleWidgets}
        />
      );
  }

  return (
    <div className="app-shell">
      <Sidebar
        destination={destination}
        direction={direction}
        onDestination={navigate}
        reviewCount={totalReviewCount}
        privateMode={privateMode}
        onPrivateMode={() => setPrivateMode(!privateMode)}
        onOverlay={setOverlay}
        onAccount={() => setOverlay('demo')}
      />
      <main className="main-shell">
        <Topbar
          scope={scope}
          scopes={allScopes}
          onScope={chooseScope}
          onOverlay={setOverlay}
          reviewCount={totalReviewCount}
          privateMode={privateMode}
          onPrivateMode={() => setPrivateMode(!privateMode)}
        />
        {page}
      </main>
      <MobileNav
        destination={destination}
        destinations={mobileDestinations}
        onDestination={navigate}
        onCreate={() => setOverlay('create')}
      />

      {overlay === 'create' ? (
        <QuickCreateModal
          scope={scope.id === 'all' ? scopes[1]! : scope}
          onClose={() => setOverlay(null)}
          onSave={saveActivity}
          onDeepCreate={(kind) => {
            if (kind === 'trade') setTradeAsset(originAssetFromRow(assetRows[0]!));
            setOverlay(
              kind === 'trade'
                ? 'trade'
                : kind === 'portfolio'
                  ? 'portfolio-create'
                  : kind === 'cashflow'
                    ? 'cashflow'
                    : 'import',
            );
          }}
        />
      ) : null}
      {overlay === 'trade' ? (
        <OriginTradeFlow
          asset={tradeAsset}
          availableCash={availableCash}
          heldUnits={
            (holdings.find((holding) => holding.symbol === tradeAsset.symbol)?.value ?? 0) /
            tradeAsset.price
          }
          onClose={() => setOverlay(null)}
          onComplete={completeTrade}
          onReceiptAction={handleTradeReceiptAction}
          portfolio={scope.id === 'all' ? 'Personal wealth' : scope.name}
          receiptNumber={1042 + trades.length}
        />
      ) : null}
      {overlay === 'cashflow' ? (
        <OriginCashFlowFlow
          availableCash={availableCash}
          onClose={() => setOverlay(null)}
          onComplete={completeCashFlow}
          portfolio={scope.id === 'all' ? 'Personal wealth' : scope.name}
        />
      ) : null}
      {overlay === 'portfolio-create' ? (
        <OriginPortfolioCreateFlow
          onClose={() => {
            setPortfolioCreateParent(null);
            setOverlay(null);
          }}
          onComplete={completePortfolio}
          onNextAction={(action, portfolio) => {
            completePortfolio(portfolio);
            setOverlay(action);
          }}
          parentPortfolio={portfolioCreateParent ?? scope.name}
        />
      ) : null}
      {overlay === 'import' ? (
        <OriginImportFlow
          onClose={() => setOverlay(null)}
          onComplete={completeImport}
          portfolio={scope.id === 'all' ? 'Personal wealth' : scope.name}
        />
      ) : null}
      {overlay === 'review' ? (
        <OriginReviewCenter
          initialSelectedId={reviewFocusId}
          items={originReviews}
          onApprove={(item, receipt) => decideOriginReview(item, receipt, 'approved')}
          onClose={() => {
            setReviewFocusId(null);
            setOverlay(null);
          }}
          onReject={(item, receipt) => decideOriginReview(item, receipt, 'rejected')}
        />
      ) : null}
      {overlay === 'share' ? (
        <OriginShareFlow
          dataHome={dataHome}
          onClose={() => setOverlay(null)}
          onComplete={completeShare}
          portfolio={{
            id: scope.id,
            name: scope.name,
            value: scope.value,
            currency: 'EUR',
            owner: 'Alex Morgan',
          }}
        />
      ) : null}
      {overlay === 'notifications' ? (
        <NotificationsPanel
          items={notifications}
          onClose={() => setOverlay(null)}
          onOpenItem={(item) => {
            if (item.id === 'daily-brief') {
              setOverlay('assistant');
            } else if (item.id === 'import-review') {
              setReviewFocusId('origin-import-july');
              setOverlay('review');
            } else if (item.id === 'collaborator') {
              setReviewFocusId('origin-property-proposal');
              setOverlay('review');
            } else if (item.id.startsWith('notification_EVT')) {
              setOverlay('events');
            } else {
              setOverlay(null);
              navigate('portfolios');
              if (scope.id === 'all') chooseScope(allScopes[1]!);
              setPortfolioTab('activity');
            }
          }}
          onOpenReview={() => setOverlay('review')}
          onRead={(id) =>
            setNotifications(
              notifications.map((item) => (item.id === id ? { ...item, read: true } : item)),
            )
          }
        />
      ) : null}
      {overlay === 'customize' ? (
        <CustomizePanel
          theme={theme}
          density={density}
          visibleWidgets={visibleWidgets}
          mobileDestinations={mobileDestinations}
          onTheme={setTheme}
          onDensity={setDensity}
          onWidgets={setVisibleWidgets}
          onMobileDestinations={setMobileDestinations}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === 'invite' ? (
        <InviteModal scope={scope} onClose={() => setOverlay(null)} onSend={sendInvite} />
      ) : null}
      {overlay === 'connections' ? (
        direction === 'origin' ? (
          <OriginConnections
            connections={originConnections}
            onChange={updateOriginConnection}
            onClose={() => setOverlay(null)}
            onOpenDeveloper={() => {
              setOverlay(null);
              navigate('developer');
            }}
            portfolio={{ id: scope.id, name: scope.name, currency: 'EUR' }}
          />
        ) : (
          <ConnectionsPanel
            connections={connections}
            onToggle={toggleConnection}
            onDeveloper={() => {
              setOverlay(null);
              navigate('developer');
            }}
            onClose={() => setOverlay(null)}
          />
        )
      ) : null}
      {overlay === 'platform' ? (
        <PlatformPanel
          onDeveloper={() => {
            setOverlay(null);
            navigate('developer');
          }}
          onConnections={() => setOverlay('connections')}
          onImport={() => setOverlay('import')}
          onDataManagement={() => setOverlay('data-management')}
          onSettings={() => selectSurface('settings')}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === 'data-management' ? (
        <OriginDataManagement
          dataHome={dataHome}
          driveConnected={connections.drive ?? false}
          onClose={() => setOverlay(null)}
          onOpenConnections={() => setOverlay('connections')}
          onOpenImport={() => setOverlay('import')}
          onToast={setToast}
          portfolio={{ id: scope.id, name: scope.name }}
        />
      ) : null}
      {overlay === 'data-health' ? (
        <OriginDataHealth
          onClose={() => setOverlay(null)}
          onOpenConnections={() => setOverlay('connections')}
          onOpenFiles={() => {
            setOverlay(null);
            setDestination('portfolios');
            setPortfolioTab('files');
          }}
          onOpenImport={() => setOverlay('import')}
          onOpenReview={() => setOverlay('review')}
          onOpenTax={() => {
            setOverlay(null);
            setDestination('portfolios');
            setPortfolioTab('tax');
          }}
          onSubmitReview={(entry) => submitOriginProposal(entry, false)}
          onToast={setToast}
          portfolio={{ id: scope.id, name: scope.name }}
        />
      ) : null}
      {overlay === 'events' ? (
        <OriginPortfolioEvents
          onClose={() => setOverlay(null)}
          onOpenFiles={() => {
            setOverlay(null);
            setDestination('portfolios');
            if (scope.id === 'all') chooseScope(scopes[1]!);
            setPortfolioTab('files');
          }}
          onOpenReview={() => setOverlay('review')}
          onOpenTax={() => {
            setOverlay(null);
            setDestination('portfolios');
            if (scope.id === 'all') chooseScope(scopes[1]!);
            setPortfolioTab('tax');
          }}
          onConfirmed={(items, receipt) => {
            const portfolio =
              scope.id === 'all'
                ? { id: 'personal', name: 'Personal wealth' }
                : { id: scope.id, name: scope.name };
            const cashImpact = items.reduce(
              (total, item) => total + (originEventCashDeltaById[item.id] ?? 0),
              0,
            );
            if (cashImpact) setAvailableCash((current) => current + cashImpact);
            setCustomActivities((current) => [
              ...items.map((item) => ({
                id: `activity_${receipt.id}_${item.id}`,
                portfolioId: portfolio.id,
                portfolioName: portfolio.name,
                title: `${item.ticker} · ${item.title}`,
                amount: originEventCashDeltaById[item.id] ?? 0,
                detail: `${item.impact.difference} · ${item.impact.holdingAfter}`,
                source: `${item.source.connection} · ${item.source.notice}`,
                status: `Confirmed · ${receipt.id}`,
                icon: 'calendar' as IconName,
                date: 'Just now',
              })),
              ...current,
            ]);
            setNotifications((current) => [
              {
                id: `notification_${receipt.id}`,
                title:
                  items.length === 1
                    ? `${items[0]!.ticker} event joined portfolio truth`
                    : `${items.length} portfolio events were confirmed`,
                copy: `${portfolio.name} activity, holdings context, cash, tax lineage, and receipt are connected.`,
                time: 'Just now',
                read: false,
                icon: 'calendar',
              },
              ...current,
            ]);
          }}
          onSubmitReview={(entry) => submitOriginProposal(entry, false)}
          onToast={setToast}
          portfolio={{
            id: scope.id === 'all' ? 'personal' : scope.id,
            name: scope.id === 'all' ? 'Personal wealth' : scope.name,
            currency: 'EUR',
          }}
          privateMode={privateMode}
        />
      ) : null}
      {overlay === 'structure' ? (
        <OriginPortfolioStructure
          graph={displayedOriginStructureGraph}
          onClose={() => setOverlay(null)}
          onCreateChild={(parentName) => {
            setPortfolioCreateParent(parentName);
            setOverlay('portfolio-create');
          }}
          onOpenPeople={() => {
            setOverlay(null);
            setDestination('portfolios');
            if (scope.id === 'all') chooseScope(scopes[1]!);
            setPortfolioTab('people');
          }}
          onOpenReview={() => setOverlay('review')}
          onOpenWorkbench={(context) => {
            setOverlay(null);
            setDestination('workbench');
            setToast(`Structure scenario opened · ${context}`);
          }}
          onPropose={(entry, mutation) => {
            setPendingStructureMutations((current) => ({
              ...current,
              [entry.id]: mutation,
            }));
            submitOriginProposal(entry, false);
          }}
          onSelectPortfolio={(id) => {
            const graphNode = displayedOriginStructureGraph.nodes.find((node) => node.id === id);
            const nextScope = allScopes.find(
              (candidate) => candidate.id === id || candidate.name === graphNode?.name,
            );
            if (nextScope) {
              setOverlay(null);
              openPortfolio(nextScope);
            } else {
              setToast(`${graphNode?.name ?? 'This object'} opens inside the structure workspace`);
            }
          }}
          onToast={setToast}
          portfolio={{
            id:
              displayedOriginStructureGraph.nodes.find((node) => node.name === scope.name)?.id ??
              (scope.id === 'all' ? displayedOriginStructureGraph.rootId : scope.id),
            name: scope.name,
            value: scope.value,
            currency: 'EUR',
          }}
          privateMode={privateMode}
        />
      ) : null}
      {overlay === 'portfolio-settings' ? (
        <OriginPortfolioSettings
          onClose={() => setOverlay(null)}
          onOpenConnections={() => setOverlay('connections')}
          onOpenPeople={() => {
            setOverlay(null);
            setDestination('portfolios');
            if (scope.id === 'all') chooseScope(scopes[1]!);
            setPortfolioTab('people');
          }}
          onOpenReview={() => setOverlay('review')}
          onOpenTax={() => {
            setOverlay(null);
            setDestination('portfolios');
            if (scope.id === 'all') chooseScope(scopes[1]!);
            setPortfolioTab('tax');
          }}
          onSubmitReview={(entry) => submitOriginProposal(entry, false)}
          onToast={setToast}
          portfolio={{
            id: scope.id === 'all' ? 'personal' : scope.id,
            name: scope.id === 'all' ? 'Personal wealth' : scope.name,
            reference:
              displayedOriginStructureGraph.nodes.find(
                (node) =>
                  node.id === (scope.id === 'all' ? 'personal' : scope.id) ||
                  node.name === (scope.id === 'all' ? 'Personal wealth' : scope.name),
              )?.reference ?? `PORT-${scope.id.toUpperCase()}`,
            baseCurrency: 'EUR',
            reportingTimezone: 'Europe/Vienna',
          }}
          privateMode={privateMode}
        />
      ) : null}
      {overlay === 'private-markets' ? (
        <OriginPrivateMarkets
          availableCash={availableCash}
          onClose={() => setOverlay(null)}
          onOpenCashFlow={() => {
            setOverlay(null);
            setDestination('portfolios');
            if (scope.id === 'all') chooseScope(scopes[1]!);
            setPortfolioTab('cash-flow');
          }}
          onOpenFiles={() => {
            setOverlay(null);
            setDestination('portfolios');
            if (scope.id === 'all') chooseScope(scopes[1]!);
            setPortfolioTab('files');
          }}
          onOpenReview={() => setOverlay('review')}
          onSubmitReview={(entry) => submitOriginProposal(entry, false)}
          onToast={setToast}
          portfolio={{
            id: scope.id === 'all' ? 'personal' : scope.id,
            name: scope.id === 'all' ? 'Personal wealth' : scope.name,
            currency: 'EUR',
          }}
          privateMode={privateMode}
        />
      ) : null}
      {overlay === 'assistant' ? (
        <AssistantPanel
          scope={scope}
          privateMode={privateMode}
          onClose={() => setOverlay(null)}
          onOpenWorkbench={() => {
            setOverlay(null);
            navigate('workbench');
          }}
          onSubmitProposal={submitOriginProposal}
        />
      ) : null}
      {overlay === 'command' ? (
        <CommandPalette
          onClose={() => setOverlay(null)}
          onDestination={navigate}
          onScope={chooseScope}
          onOverlay={setOverlay}
          onWorkbenchView={setWorkbenchView}
        />
      ) : null}
      {overlay === 'demo' ? (
        <DemoMenu
          current={surface}
          direction={direction}
          onSelect={selectSurface}
          onDirection={(next) => {
            setDirection(next);
            setOverlay(null);
          }}
          onClose={() => setOverlay(null)}
          onReset={resetDemo}
        />
      ) : null}
      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}
