import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry } from './OriginReviewCenter';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-rebalance.css';

export type OriginRebalancePortfolio = {
  id: string;
  name: string;
  value: number;
  currency?: string;
};

export type OriginRebalanceFundingMode = 'cash-only' | 'sell-and-buy' | 'mixed';
export type OriginRebalanceShareMode = 'fractional' | 'whole';
export type OriginRebalancePlanStatus = 'ready' | 'constrained' | 'infeasible';

export type OriginRebalanceSleeve = {
  id: 'core' | 'growth' | 'alternatives' | 'cash';
  name: string;
  shortName: string;
  target: number;
  driftBand: number;
  color: string;
};

export type OriginRebalanceHolding = {
  id: 'vwce' | 'aapl' | 'btc' | 'cash';
  symbol: string;
  name: string;
  sleeveId: OriginRebalanceSleeve['id'];
  price: number;
  currentValue: number;
  currentWeight: number;
  unrealizedGainPercent: number;
};

export type OriginRebalanceTrade = {
  id: string;
  holdingId: OriginRebalanceHolding['id'];
  symbol: string;
  name: string;
  sleeveId: OriginRebalanceSleeve['id'];
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  grossValue: number;
  fee: number;
  estimatedTax: number;
  reason: string;
  policyNotes: string[];
};

export type OriginRebalanceAllocation = {
  sleeveId: OriginRebalanceSleeve['id'];
  name: string;
  color: string;
  current: number;
  after: number;
  target: number;
  driftBand: number;
  withinBand: boolean;
};

export type OriginRebalancePlan = {
  id: string;
  reference: string;
  createdAt: string;
  status: OriginRebalancePlanStatus;
  inputSignature: string;
  fundingMode: OriginRebalanceFundingMode;
  shareMode: OriginRebalanceShareMode;
  trades: OriginRebalanceTrade[];
  allocations: OriginRebalanceAllocation[];
  cashBefore: number;
  cashAfter: number;
  fees: number;
  estimatedTax: number;
  turnover: number;
  targetTotal: number;
  warnings: string[];
  blockedReasons: string[];
  explanation: string[];
};

export type OriginRebalanceConfig = {
  sleeves: OriginRebalanceSleeve[];
  fundingMode: OriginRebalanceFundingMode;
  shareMode: OriginRebalanceShareMode;
  minimumTrade: number;
  turnoverCap: number;
  protectedHoldingIds: OriginRebalanceHolding['id'][];
  taxAware: boolean;
  cashFloorPercent: number;
};

export type OriginRebalanceScenario = {
  id: string;
  name: string;
  description: string;
  savedAt: string;
  config: OriginRebalanceConfig;
};

export type OriginRebalanceReceipt = {
  id: string;
  reference: string;
  planId: string;
  reviewEntryId: string;
  submittedAt: string;
  checksum: string;
  tradeCount: number;
  grossValue: number;
};

export type OriginRebalanceProps = {
  portfolio: OriginRebalancePortfolio;
  privateMode: boolean;
  onBack: () => void;
  onOpenTax: () => void;
  onOpenGoals: () => void;
  onSubmitReview: (entry: OriginReviewEntry) => void;
  onToast: (message: string) => void;
};

type PersistedState = {
  version: 1;
  config: OriginRebalanceConfig;
  scenarios: OriginRebalanceScenario[];
  history: OriginRebalancePlan[];
  activePlan: OriginRebalancePlan | null;
  receipts: OriginRebalanceReceipt[];
};

type RebalanceSetupStep = 1 | 2 | 3;

const sleeveMeta: Record<
  OriginRebalanceSleeve['id'],
  { name: string; shortName: string; color: string; icon: IconName }
> = {
  core: {
    name: 'Core equity',
    shortName: 'Core',
    color: '#7aa7ef',
    icon: 'globe',
  },
  growth: {
    name: 'Focused growth',
    shortName: 'Growth',
    color: '#aa91dc',
    icon: 'arrow-up',
  },
  alternatives: {
    name: 'Alternatives',
    shortName: 'Alternatives',
    color: '#d6a25b',
    icon: 'assets',
  },
  cash: {
    name: 'Cash reserve',
    shortName: 'Cash',
    color: '#73808c',
    icon: 'cash',
  },
};

const fundingMeta: Record<
  OriginRebalanceFundingMode,
  { label: string; short: string; description: string }
> = {
  'cash-only': {
    label: 'Cash only',
    short: 'Cash',
    description: 'Buy underweight sleeves from available cash. Never create a sale.',
  },
  'sell-and-buy': {
    label: 'Sell & buy',
    short: 'Full',
    description: 'Use both sides of the portfolio while respecting every policy below.',
  },
  mixed: {
    label: 'Mixed',
    short: 'Mixed',
    description: 'Spend excess cash first, then make only the sales required to close drift.',
  },
};

const baseWeights: Record<OriginRebalanceHolding['id'], number> = {
  vwce: 48,
  aapl: 22,
  btc: 12,
  cash: 18,
};

const holdingSeed: Array<
  Pick<
    OriginRebalanceHolding,
    'id' | 'symbol' | 'name' | 'sleeveId' | 'price' | 'unrealizedGainPercent'
  >
> = [
  {
    id: 'vwce',
    symbol: 'VWCE',
    name: 'Vanguard FTSE All-World',
    sleeveId: 'core',
    price: 123.84,
    unrealizedGainPercent: 18.4,
  },
  {
    id: 'aapl',
    symbol: 'AAPL',
    name: 'Apple',
    sleeveId: 'growth',
    price: 202.1,
    unrealizedGainPercent: 34.1,
  },
  {
    id: 'btc',
    symbol: 'BTC',
    name: 'Bitcoin',
    sleeveId: 'alternatives',
    price: 57_680,
    unrealizedGainPercent: 18.2,
  },
  {
    id: 'cash',
    symbol: 'CASH',
    name: 'Portfolio cash',
    sleeveId: 'cash',
    price: 1,
    unrealizedGainPercent: 0,
  },
];

const defaultSleeves: OriginRebalanceSleeve[] = [
  {
    id: 'core',
    ...sleeveMeta.core,
    target: 55,
    driftBand: 3,
  },
  {
    id: 'growth',
    ...sleeveMeta.growth,
    target: 18,
    driftBand: 2.5,
  },
  {
    id: 'alternatives',
    ...sleeveMeta.alternatives,
    target: 10,
    driftBand: 2,
  },
  {
    id: 'cash',
    ...sleeveMeta.cash,
    target: 17,
    driftBand: 2,
  },
];

const defaultConfig: OriginRebalanceConfig = {
  sleeves: defaultSleeves,
  fundingMode: 'mixed',
  shareMode: 'fractional',
  minimumTrade: 250,
  turnoverCap: 10,
  protectedHoldingIds: [],
  taxAware: true,
  cashFloorPercent: 8,
};

function cloneConfig(config: OriginRebalanceConfig): OriginRebalanceConfig {
  return {
    ...config,
    sleeves: config.sleeves.map((sleeve) => ({ ...sleeve })),
    protectedHoldingIds: [...config.protectedHoldingIds],
  };
}

function initialScenarios(): OriginRebalanceScenario[] {
  const balanced = cloneConfig(defaultConfig);
  const taxLight = cloneConfig(defaultConfig);
  taxLight.sleeves = taxLight.sleeves.map((sleeve) => {
    const targets: Record<OriginRebalanceSleeve['id'], number> = {
      core: 52,
      growth: 20,
      alternatives: 10,
      cash: 18,
    };
    return { ...sleeve, target: targets[sleeve.id] };
  });
  taxLight.turnoverCap = 7;
  taxLight.protectedHoldingIds = ['aapl'];

  const growthTilt = cloneConfig(defaultConfig);
  growthTilt.sleeves = growthTilt.sleeves.map((sleeve) => {
    const targets: Record<OriginRebalanceSleeve['id'], number> = {
      core: 50,
      growth: 25,
      alternatives: 10,
      cash: 15,
    };
    return { ...sleeve, target: targets[sleeve.id] };
  });
  growthTilt.taxAware = false;
  growthTilt.turnoverCap = 12;

  return [
    {
      id: 'scenario-balanced',
      name: 'Balanced reset',
      description: 'Close material drift with a 10% turnover ceiling.',
      savedAt: '2026-07-26T15:20:00.000Z',
      config: balanced,
    },
    {
      id: 'scenario-tax-light',
      name: 'Tax-light migration',
      description: 'Keep AAPL untouched and accept a wider path back to target.',
      savedAt: '2026-07-22T09:10:00.000Z',
      config: taxLight,
    },
    {
      id: 'scenario-growth',
      name: 'Growth tilt draft',
      description: 'Explore a larger focused-growth sleeve before committing.',
      savedAt: '2026-07-18T11:45:00.000Z',
      config: growthTilt,
    },
  ];
}

function initialState(): PersistedState {
  return {
    version: 1,
    config: cloneConfig(defaultConfig),
    scenarios: initialScenarios(),
    history: [],
    activePlan: null,
    receipts: [],
  };
}

function storageKey(portfolioId: string) {
  return `bt-demo-origin-rebalance-v1:${portfolioId}`;
}

function loadState(portfolioId: string): PersistedState {
  if (typeof window === 'undefined') return initialState();
  try {
    const raw = window.localStorage.getItem(storageKey(portfolioId));
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (
      parsed.version !== 1 ||
      !parsed.config ||
      !Array.isArray(parsed.config.sleeves) ||
      !Array.isArray(parsed.scenarios) ||
      !Array.isArray(parsed.history) ||
      !Array.isArray(parsed.receipts)
    ) {
      return initialState();
    }
    return {
      version: 1,
      config: cloneConfig(parsed.config),
      scenarios: parsed.scenarios,
      history: parsed.history,
      activePlan: parsed.activePlan ?? null,
      receipts: parsed.receipts,
    };
  } catch {
    return initialState();
  }
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, precision = 2) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function holdingsForPortfolio(portfolio: OriginRebalancePortfolio): OriginRebalanceHolding[] {
  return holdingSeed.map((holding) => ({
    ...holding,
    currentWeight: baseWeights[holding.id],
    currentValue: portfolio.value * (baseWeights[holding.id] / 100),
  }));
}

function configSignature(config: OriginRebalanceConfig) {
  return JSON.stringify({
    sleeves: config.sleeves.map(({ id, target, driftBand }) => ({
      id,
      target: round(target, 3),
      driftBand: round(driftBand, 3),
    })),
    fundingMode: config.fundingMode,
    shareMode: config.shareMode,
    minimumTrade: round(config.minimumTrade),
    turnoverCap: round(config.turnoverCap, 2),
    protectedHoldingIds: [...config.protectedHoldingIds].sort(),
    taxAware: config.taxAware,
    cashFloorPercent: round(config.cashFloorPercent, 2),
  });
}

function formatMoney(value: number, currency: string, privateMode: boolean, compact = false) {
  if (privateMode) return '••••••';
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatQuantity(value: number, fractional: boolean) {
  return new Intl.NumberFormat('en', {
    maximumFractionDigits: fractional ? 4 : 0,
    minimumFractionDigits: 0,
  }).format(value);
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0)
    .toString(16)
    .padStart(8, '0')
    .toUpperCase();
}

function calculatePlan(
  portfolio: OriginRebalancePortfolio,
  holdings: OriginRebalanceHolding[],
  config: OriginRebalanceConfig,
): OriginRebalancePlan {
  const inputSignature = configSignature(config);
  const reference = `REB-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.floor(
    1000 + Math.random() * 8999,
  )}`;
  const warnings: string[] = [];
  const blockedReasons: string[] = [];
  const policyNotes = new Map<OriginRebalanceHolding['id'], string[]>();
  const targetTotal = round(
    config.sleeves.reduce((sum, sleeve) => sum + sleeve.target, 0),
    2,
  );

  if (Math.abs(targetTotal - 100) > 0.01) {
    blockedReasons.push(`Targets total ${targetTotal.toFixed(1)}%; they must equal exactly 100%.`);
  }

  const targetBySleeve = Object.fromEntries(
    config.sleeves.map((sleeve) => [sleeve.id, sleeve.target]),
  ) as Record<OriginRebalanceSleeve['id'], number>;
  const cashHolding = holdings.find((holding) => holding.id === 'cash')!;
  const targetCash = portfolio.value * (targetBySleeve.cash / 100);
  const floorCash = portfolio.value * (config.cashFloorPercent / 100);
  const reserveCash = Math.max(targetCash, floorCash);
  let spendableCash = Math.max(0, cashHolding.currentValue - reserveCash);

  type DraftTrade = {
    holding: OriginRebalanceHolding;
    requestedValue: number;
    value: number;
    notes: string[];
  };

  const drafts: DraftTrade[] = holdings
    .filter((holding) => holding.id !== 'cash')
    .map((holding) => {
      const targetValue = portfolio.value * (targetBySleeve[holding.sleeveId] / 100);
      const requestedValue = targetValue - holding.currentValue;
      let value = requestedValue;
      const notes: string[] = [];

      if (requestedValue < 0 && config.fundingMode === 'cash-only') {
        value = 0;
        notes.push('Sale omitted by cash-only funding policy');
      }

      if (requestedValue < 0 && config.protectedHoldingIds.includes(holding.id)) {
        value = 0;
        notes.push('Holding protected by do-not-sell policy');
        warnings.push(`${holding.symbol} is protected, so its overweight position remains.`);
      }

      if (
        value < 0 &&
        config.taxAware &&
        holding.unrealizedGainPercent > 0 &&
        !config.protectedHoldingIds.includes(holding.id)
      ) {
        value *= 0.7;
        notes.push('Sale reduced 30% by tax-aware loss/gain policy');
      }

      policyNotes.set(holding.id, notes);
      return { holding, requestedValue, value, notes };
    });

  if (config.fundingMode === 'cash-only') {
    const desiredBuys = drafts.reduce((sum, draft) => sum + Math.max(0, draft.value), 0);
    if (desiredBuys > spendableCash && desiredBuys > 0) {
      const scale = spendableCash / desiredBuys;
      drafts.forEach((draft) => {
        if (draft.value > 0) draft.value *= scale;
      });
      warnings.push('Available cash was allocated proportionally across underweight sleeves.');
    }
  } else {
    const sellProceeds = drafts.reduce((sum, draft) => sum + Math.max(0, -draft.value), 0);
    const desiredBuys = drafts.reduce((sum, draft) => sum + Math.max(0, draft.value), 0);
    const buyBudget = spendableCash + sellProceeds;
    if (desiredBuys > buyBudget && desiredBuys > 0) {
      const scale = buyBudget / desiredBuys;
      drafts.forEach((draft) => {
        if (draft.value > 0) draft.value *= scale;
      });
      warnings.push('Buys were scaled to preserve the cash target and floor.');
    }
  }

  const grossBeforeCap = drafts.reduce((sum, draft) => sum + Math.abs(draft.value), 0);
  const maximumGross = portfolio.value * (config.turnoverCap / 100);
  if (grossBeforeCap > maximumGross && grossBeforeCap > 0) {
    const scale = maximumGross / grossBeforeCap;
    drafts.forEach((draft) => {
      draft.value *= scale;
      draft.notes.push(`Scaled to ${config.turnoverCap.toFixed(1)}% turnover cap`);
    });
    warnings.push(
      `Trade values were scaled to the ${config.turnoverCap.toFixed(1)}% turnover cap.`,
    );
  }

  const trades: OriginRebalanceTrade[] = [];
  drafts.forEach((draft) => {
    let value = draft.value;
    if (Math.abs(value) < config.minimumTrade) {
      if (Math.abs(draft.requestedValue) >= config.minimumTrade && Math.abs(value) > 0) {
        warnings.push(
          `${draft.holding.symbol} was omitted because its constrained trade fell below ${config.minimumTrade.toFixed(
            0,
          )}.`,
        );
      }
      return;
    }

    let quantity = Math.abs(value) / draft.holding.price;
    if (config.shareMode === 'whole') {
      quantity = Math.floor(quantity);
      value = Math.sign(value) * quantity * draft.holding.price;
      draft.notes.push('Quantity rounded down to whole shares');
    }
    if (quantity <= 0 || Math.abs(value) < config.minimumTrade) return;

    const grossValue = Math.abs(value);
    const fee = Math.max(0.85, grossValue * 0.0008);
    const estimatedTax =
      value < 0
        ? grossValue * (draft.holding.unrealizedGainPercent / 100) * (config.taxAware ? 0.275 : 0.3)
        : 0;

    trades.push({
      id: uid('trade'),
      holdingId: draft.holding.id,
      symbol: draft.holding.symbol,
      name: draft.holding.name,
      sleeveId: draft.holding.sleeveId,
      side: value > 0 ? 'buy' : 'sell',
      quantity,
      price: draft.holding.price,
      grossValue,
      fee,
      estimatedTax,
      reason:
        value > 0
          ? `${sleeveMeta[draft.holding.sleeveId].name} is below its target range`
          : `${sleeveMeta[draft.holding.sleeveId].name} is above its target range`,
      policyNotes: draft.notes,
    });
  });

  const fees = trades.reduce((sum, trade) => sum + trade.fee, 0);
  const estimatedTax = trades.reduce((sum, trade) => sum + trade.estimatedTax, 0);
  const buys = trades
    .filter((trade) => trade.side === 'buy')
    .reduce((sum, trade) => sum + trade.grossValue, 0);
  const sells = trades
    .filter((trade) => trade.side === 'sell')
    .reduce((sum, trade) => sum + trade.grossValue, 0);
  const cashAfter = cashHolding.currentValue + sells - buys - fees - estimatedTax;

  if (cashAfter + 0.01 < floorCash) {
    blockedReasons.push(
      `Projected cash falls below the ${config.cashFloorPercent.toFixed(1)}% floor.`,
    );
  }

  const allocations: OriginRebalanceAllocation[] = config.sleeves.map((sleeve) => {
    const holding = holdings.find((candidate) => candidate.sleeveId === sleeve.id)!;
    const trade = trades.find((candidate) => candidate.holdingId === holding.id);
    const signedTrade = trade ? (trade.side === 'buy' ? trade.grossValue : -trade.grossValue) : 0;
    const afterValue = sleeve.id === 'cash' ? cashAfter : holding.currentValue + signedTrade;
    const after = round((afterValue / portfolio.value) * 100, 2);
    return {
      sleeveId: sleeve.id,
      name: sleeve.name,
      color: sleeve.color,
      current: holding.currentWeight,
      after,
      target: sleeve.target,
      driftBand: sleeve.driftBand,
      withinBand: Math.abs(after - sleeve.target) <= sleeve.driftBand + 0.01,
    };
  });

  allocations
    .filter((allocation) => !allocation.withinBand)
    .forEach((allocation) => {
      blockedReasons.push(
        `${allocation.name} remains ${Math.abs(allocation.after - allocation.target).toFixed(
          1,
        )} points from target, outside its ±${allocation.driftBand.toFixed(1)}% band.`,
      );
    });

  if (!trades.length && !blockedReasons.length) {
    warnings.push('No trade clears the minimum size; the portfolio is already inside policy.');
  }
  if (config.taxAware && trades.some((trade) => trade.side === 'sell')) {
    warnings.push(
      'Tax estimates use current unrealized gains and are planning estimates, not tax advice.',
    );
  }
  if (config.shareMode === 'whole') {
    warnings.push('Whole-share rounding leaves small residual allocation differences.');
  }

  const turnover =
    portfolio.value > 0
      ? (trades.reduce((sum, trade) => sum + trade.grossValue, 0) / portfolio.value) * 100
      : 0;
  const status: OriginRebalancePlanStatus =
    Math.abs(targetTotal - 100) > 0.01 || cashAfter + 0.01 < floorCash
      ? 'infeasible'
      : blockedReasons.length
        ? 'constrained'
        : 'ready';

  const explanation = [
    config.fundingMode === 'mixed'
      ? 'Excess cash funds buys first; only the remaining gap creates sales.'
      : fundingMeta[config.fundingMode].description,
    config.taxAware
      ? 'Tax-aware mode reduces appreciated sales before applying the turnover ceiling.'
      : 'Tax-aware sale reduction is off; allocation accuracy takes priority.',
    `Every trade must clear ${config.minimumTrade.toFixed(
      0,
    )} and total gross turnover cannot exceed ${config.turnoverCap.toFixed(1)}%.`,
  ];

  return {
    id: uid('plan'),
    reference,
    createdAt: new Date().toISOString(),
    status,
    inputSignature,
    fundingMode: config.fundingMode,
    shareMode: config.shareMode,
    trades,
    allocations,
    cashBefore: cashHolding.currentValue,
    cashAfter,
    fees,
    estimatedTax,
    turnover: round(turnover, 2),
    targetTotal,
    warnings: Array.from(new Set(warnings)),
    blockedReasons: Array.from(new Set(blockedReasons)),
    explanation,
  };
}

function AllocationBand({
  allocations,
  mode,
  label,
}: {
  allocations: OriginRebalanceAllocation[];
  mode: 'current' | 'after' | 'target';
  label: string;
}) {
  return (
    <div className="orb-allocation-band">
      <div className="orb-allocation-band__label">
        <span>{label}</span>
        <small>
          {allocations.map((allocation) => `${allocation.name} ${allocation[mode]}%`).join(', ')}
        </small>
      </div>
      <div className="orb-allocation-band__track" aria-hidden="true">
        {allocations.map((allocation) => (
          <span
            key={allocation.sleeveId}
            style={
              {
                '--orb-band-size': `${Math.max(0, allocation[mode])}%`,
                '--orb-band-color': allocation.color,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="orb-section-heading">
      <div>
        {eyebrow ? <span>{eyebrow}</span> : null}
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action ? <div className="orb-section-heading__action">{action}</div> : null}
    </header>
  );
}

function SetupStepToggle({
  step,
  title,
  description,
  summary,
  active,
  controls,
  onToggle,
}: {
  step: RebalanceSetupStep;
  title: string;
  description: string;
  summary: string;
  active: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      aria-controls={controls}
      aria-expanded={active}
      className="orb-step-toggle"
      onClick={onToggle}
      type="button"
    >
      <span className="orb-step-toggle__index">{String(step).padStart(2, '0')}</span>
      <span className="orb-step-toggle__copy">
        <strong>{title}</strong>
        <small>{active ? description : summary}</small>
      </span>
      <Icon name="chevron-down" size={15} />
    </button>
  );
}

function StatusPill({
  status,
  children,
}: {
  status: OriginRebalancePlanStatus;
  children?: ReactNode;
}) {
  return (
    <span className={cx('orb-status-pill', `is-${status}`)}>
      <span aria-hidden="true" />
      {children ??
        (status === 'ready'
          ? 'Ready for review'
          : status === 'constrained'
            ? 'Outside policy bands'
            : 'Infeasible')}
    </span>
  );
}

export function OriginRebalance({
  portfolio,
  privateMode,
  onOpenTax,
  onOpenGoals,
  onSubmitReview,
  onToast,
}: OriginRebalanceProps) {
  const currency = portfolio.currency ?? 'EUR';
  const key = storageKey(portfolio.id);
  const [state, setState] = useState<PersistedState>(() => loadState(portfolio.id));
  const [boundKey, setBoundKey] = useState(key);
  const [activeStep, setActiveStep] = useState<RebalanceSetupStep>(1);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [runError, setRunError] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewConsent, setReviewConsent] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const timersRef = useRef<number[]>([]);
  const reviewDialogRef = useAccessibleDialog<HTMLFormElement>({
    open: reviewOpen,
    onClose: () => {
      setReviewOpen(false);
      setReviewError('');
    },
    initialFocusSelector: '[data-review-heading]',
  });

  const holdings = useMemo(() => holdingsForPortfolio(portfolio), [portfolio]);
  const targetTotal = round(
    state.config.sleeves.reduce((sum, sleeve) => sum + sleeve.target, 0),
    2,
  );
  const currentSignature = configSignature(state.config);
  const activePlan = state.activePlan;
  const planIsStale = Boolean(activePlan && activePlan.inputSignature !== currentSignature);
  const currentAllocations = useMemo<OriginRebalanceAllocation[]>(
    () =>
      state.config.sleeves.map((sleeve) => {
        const current =
          holdings.find((holding) => holding.sleeveId === sleeve.id)?.currentWeight ?? 0;
        return {
          sleeveId: sleeve.id,
          name: sleeve.name,
          color: sleeve.color,
          current,
          after: current,
          target: sleeve.target,
          driftBand: sleeve.driftBand,
          withinBand: Math.abs(current - sleeve.target) <= sleeve.driftBand,
        };
      }),
    [holdings, state.config.sleeves],
  );
  const outOfBandCount = currentAllocations.filter((allocation) => !allocation.withinBand).length;
  const latestReceipt = activePlan
    ? state.receipts.find((receipt) => receipt.planId === activePlan.id)
    : undefined;

  useEffect(() => {
    if (boundKey === key) return;
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
    setState(loadState(portfolio.id));
    setBoundKey(key);
    setActiveStep(1);
    setRunning(false);
    setProgress(0);
    setRunError('');
    setReviewOpen(false);
  }, [boundKey, key, portfolio.id]);

  useEffect(() => {
    if (boundKey !== key || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // The planner remains usable in memory when local storage is unavailable.
    }
  }, [boundKey, key, state]);

  useEffect(
    () => () => {
      timersRef.current.forEach(window.clearTimeout);
    },
    [],
  );

  const updateConfig = (patch: Partial<OriginRebalanceConfig>) => {
    setState((current) => ({
      ...current,
      config: { ...current.config, ...patch },
    }));
    setRunError('');
  };

  const updateSleeve = (
    id: OriginRebalanceSleeve['id'],
    field: 'target' | 'driftBand',
    value: number,
  ) => {
    setState((current) => ({
      ...current,
      config: {
        ...current.config,
        sleeves: current.config.sleeves.map((sleeve) =>
          sleeve.id === id
            ? {
                ...sleeve,
                [field]: Number.isFinite(value)
                  ? field === 'target'
                    ? clamp(value, 0, 100)
                    : clamp(value, 0.1, 20)
                  : 0,
              }
            : sleeve,
        ),
      },
    }));
    setRunError('');
  };

  const toggleProtected = (holdingId: OriginRebalanceHolding['id']) => {
    if (holdingId === 'cash') return;
    const protectedHoldingIds = state.config.protectedHoldingIds.includes(holdingId)
      ? state.config.protectedHoldingIds.filter((id) => id !== holdingId)
      : [...state.config.protectedHoldingIds, holdingId];
    updateConfig({ protectedHoldingIds });
  };

  const runPlan = () => {
    if (Math.abs(targetTotal - 100) > 0.01) {
      setRunError(
        `Target allocation must equal 100%. It currently totals ${targetTotal.toFixed(1)}%.`,
      );
      return;
    }
    if (state.config.cashFloorPercent > state.config.sleeves.find((s) => s.id === 'cash')!.target) {
      setRunError(
        'The cash floor cannot be higher than the cash sleeve target. Adjust either value first.',
      );
      return;
    }

    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
    setRunError('');
    setRunning(true);
    setProgress(9);

    const snapshot = cloneConfig(state.config);
    [
      { at: 150, value: 31 },
      { at: 330, value: 57 },
      { at: 520, value: 79 },
      { at: 740, value: 100 },
    ].forEach(({ at, value }) => {
      const timer = window.setTimeout(() => {
        setProgress(value);
        if (value !== 100) return;
        const plan = calculatePlan(portfolio, holdings, snapshot);
        setState((current) => ({
          ...current,
          activePlan: plan,
          history: [plan, ...current.history.filter((item) => item.id !== plan.id)].slice(0, 8),
        }));
        setRunning(false);
        onToast(
          plan.status === 'ready'
            ? 'Rebalance plan calculated and ready for review'
            : 'Plan calculated with constraints that need attention',
        );
      }, at);
      timersRef.current.push(timer);
    });
  };

  const restoreScenario = (scenario: OriginRebalanceScenario) => {
    setState((current) => ({
      ...current,
      config: cloneConfig(scenario.config),
      activePlan: null,
    }));
    setActiveStep(1);
    setRunError('');
    onToast(`${scenario.name} restored. Edit the assumptions, then calculate again.`);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('[data-first-target]')?.focus();
    });
  };

  const restoreHistory = (plan: OriginRebalancePlan) => {
    setState((current) => ({ ...current, activePlan: plan }));
    onToast(`${plan.reference} restored as the active comparison.`);
  };

  const saveScenario = () => {
    const sequence =
      state.scenarios.filter((scenario) => scenario.id.startsWith('scenario-user')).length + 1;
    const scenario: OriginRebalanceScenario = {
      id: uid('scenario-user'),
      name: `Working plan ${sequence}`,
      description: `${fundingMeta[state.config.fundingMode].label}, ${state.config.turnoverCap.toFixed(
        1,
      )}% turnover cap`,
      savedAt: new Date().toISOString(),
      config: cloneConfig(state.config),
    };
    setState((current) => ({
      ...current,
      scenarios: [scenario, ...current.scenarios].slice(0, 8),
    }));
    onToast(`${scenario.name} saved to this portfolio`);
  };

  const exportPlan = () => {
    if (!activePlan) return;
    const payload = {
      schema: 'bettertrack.origin.rebalance-plan.v1',
      exportedAt: new Date().toISOString(),
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        value: portfolio.value,
        currency,
      },
      exactPlan: activePlan,
      constraints: state.config,
      checksum: hashText(JSON.stringify(activePlan)),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${portfolio.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${activePlan.reference.toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    onToast('Exact rebalance plan exported as JSON');
  };

  const openReview = () => {
    if (!activePlan || planIsStale || activePlan.status !== 'ready') return;
    setReviewConsent(false);
    setReviewError('');
    setReviewOpen(true);
  };

  const submitReview = (event: FormEvent) => {
    event.preventDefault();
    if (!activePlan) return;
    if (!reviewConsent) {
      setReviewError('Confirm that you reviewed the exact trades and estimates.');
      return;
    }

    const grossValue = activePlan.trades.reduce((sum, trade) => sum + trade.grossValue, 0);
    const entryId = `rebalance:${activePlan.id}`;
    const reviewEntry: OriginReviewEntry = {
      id: entryId,
      kind: 'automation',
      title: 'Execute constraint-aware rebalance',
      summary: `${activePlan.trades.length} exact trades · ${activePlan.turnover.toFixed(
        2,
      )}% turnover · ${activePlan.reference}`,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        path: `Portfolio / ${portfolio.name} / Workbench / Rebalance`,
      },
      source: {
        label: 'Origin rebalance planner',
        detail: `${fundingMeta[activePlan.fundingMode].label} · ${
          activePlan.shareMode === 'fractional' ? 'fractional shares' : 'whole shares'
        }`,
        actor: 'You',
      },
      requestedAt: new Date().toISOString(),
      requestedBy: 'You',
      status: 'pending',
      priority: activePlan.estimatedTax > portfolio.value * 0.005 ? 'high' : 'normal',
      risk: activePlan.trades.some((trade) => trade.side === 'sell') ? 'medium' : 'low',
      affectedCount: activePlan.trades.length,
      tags: ['rebalance', 'exact-plan', activePlan.reference],
      approveLabel: 'Approve exact trades',
      rejectLabel: 'Return to planner',
      diff: activePlan.allocations.map((allocation) => ({
        label: allocation.name,
        before: `${allocation.current.toFixed(1)}%`,
        after: `${allocation.after.toFixed(1)}%`,
        tone: allocation.withinBand ? 'positive' : 'warning',
        detail: `Target ${allocation.target.toFixed(1)}% · allowed band ±${allocation.driftBand.toFixed(
          1,
        )}%`,
      })),
      calculations: [
        {
          label: 'Gross trade value',
          value: formatMoney(grossValue, currency, false),
          detail: `${activePlan.turnover.toFixed(2)}% of portfolio value`,
        },
        {
          label: 'Projected cash',
          value: formatMoney(activePlan.cashAfter, currency, false),
          detail: `${((activePlan.cashAfter / portfolio.value) * 100).toFixed(2)}% after fees and tax`,
          tone:
            activePlan.cashAfter >= portfolio.value * (state.config.cashFloorPercent / 100)
              ? 'positive'
              : 'negative',
        },
        {
          label: 'Estimated fees',
          value: formatMoney(activePlan.fees, currency, false),
          detail: 'Instrument-level planning estimate',
        },
        {
          label: 'Estimated realized tax',
          value: formatMoney(activePlan.estimatedTax, currency, false),
          detail: state.config.taxAware ? 'Tax-aware policy applied' : 'Tax-aware policy disabled',
          tone: activePlan.estimatedTax > 0 ? 'warning' : 'neutral',
        },
      ],
      lineage: [
        {
          label: 'Portfolio snapshot',
          detail: `${portfolio.name} · ${formatMoney(portfolio.value, currency, false)}`,
          at: activePlan.createdAt,
          state: 'verified',
        },
        {
          label: 'Market prices',
          detail: 'VWCE €123.84 · AAPL €202.10 · BTC €57,680.00',
          at: activePlan.createdAt,
          state: 'external',
        },
        {
          label: 'Constraint engine',
          detail: `Minimum trade ${formatMoney(
            state.config.minimumTrade,
            currency,
            false,
          )} · turnover ceiling ${state.config.turnoverCap.toFixed(1)}%`,
          at: activePlan.createdAt,
          state: 'derived',
        },
        {
          label: 'Exact-plan checksum',
          detail: hashText(JSON.stringify(activePlan)),
          at: activePlan.createdAt,
          state: 'verified',
        },
      ],
      permissions: [
        {
          label: 'Read portfolio positions',
          detail: 'Used to calculate current allocation and drift',
          outcome: 'allowed',
        },
        {
          label: 'Create trade proposal',
          detail: 'Adds this exact plan to Review; no trade executes yet',
          outcome: 'allowed',
        },
        {
          label: 'Execute broker orders',
          detail: 'Requires an explicit approval in Review',
          outcome: 'review',
        },
      ],
      policies: [
        {
          title: 'Target allocation',
          description: `Sleeve targets total ${activePlan.targetTotal.toFixed(1)}%.`,
          status: Math.abs(activePlan.targetTotal - 100) < 0.01 ? 'pass' : 'blocked',
        },
        {
          title: 'Turnover ceiling',
          description: `${activePlan.turnover.toFixed(2)}% projected against a ${state.config.turnoverCap.toFixed(
            1,
          )}% cap.`,
          status: activePlan.turnover <= state.config.turnoverCap + 0.01 ? 'pass' : 'blocked',
        },
        {
          title: 'Protected holdings',
          description: state.config.protectedHoldingIds.length
            ? `${state.config.protectedHoldingIds.length} do-not-sell rule(s) respected.`
            : 'No holding is protected from sale.',
          status: activePlan.blockedReasons.some((reason) => reason.includes('protected'))
            ? 'warning'
            : 'pass',
        },
        {
          title: 'Cash floor',
          description: `${state.config.cashFloorPercent.toFixed(1)}% minimum cash retained.`,
          status:
            activePlan.cashAfter >= portfolio.value * (state.config.cashFloorPercent / 100)
              ? 'pass'
              : 'blocked',
        },
      ],
    };

    const receipt: OriginRebalanceReceipt = {
      id: uid('receipt'),
      reference: `RCP-${Math.floor(100000 + Math.random() * 899999)}`,
      planId: activePlan.id,
      reviewEntryId: entryId,
      submittedAt: reviewEntry.requestedAt,
      checksum: hashText(JSON.stringify(activePlan)),
      tradeCount: activePlan.trades.length,
      grossValue,
    };

    onSubmitReview(reviewEntry);
    setState((current) => ({
      ...current,
      receipts: [
        receipt,
        ...current.receipts.filter((item) => item.planId !== activePlan.id),
      ].slice(0, 12),
    }));
    setReviewOpen(false);
    setReviewConsent(false);
    setReviewError('');
    onToast(`${activePlan.reference} submitted to Review with an immutable receipt`);
  };

  const progressLabel =
    progress < 30
      ? 'Validating policies'
      : progress < 60
        ? 'Solving trade path'
        : progress < 90
          ? 'Estimating tax and fees'
          : 'Writing plan lineage';

  return (
    <section className="origin-rebalance" aria-labelledby="orb-title">
      <header className="orb-page-header">
        <div>
          <h1 id="orb-title">Constraint-aware rebalance</h1>
        </div>
        <div className="orb-page-header__actions">
          <button className="orb-button orb-button--quiet" type="button" onClick={onOpenGoals}>
            <Icon name="target" size={14} />
            Goals
          </button>
          <button className="orb-button orb-button--secondary" type="button" onClick={onOpenTax}>
            <Icon name="document" size={14} />
            Tax settings
          </button>
        </div>
      </header>

      <div className="orb-fact-strip" aria-label="Portfolio rebalance status">
        <div>
          <span>Current drift</span>
          <strong>{outOfBandCount ? `${outOfBandCount} outside bands` : 'All inside bands'}</strong>
          <small>Across {state.config.sleeves.length} target sleeves</small>
        </div>
        <div>
          <span>Available cash</span>
          <strong>
            {formatMoney(
              holdings.find((holding) => holding.id === 'cash')!.currentValue,
              currency,
              privateMode,
              true,
            )}
          </strong>
          <small>{baseWeights.cash.toFixed(1)}% before trades</small>
        </div>
        <div>
          <span>Planning state</span>
          <strong>
            {latestReceipt
              ? 'In Review'
              : activePlan
                ? planIsStale
                  ? 'Needs rerun'
                  : 'Calculated'
                : 'Draft'}
          </strong>
          <small>
            {latestReceipt?.reference ?? activePlan?.reference ?? 'No proposal created'}
          </small>
        </div>
      </div>

      <div className="orb-workspace">
        <aside className="orb-setup" aria-label="Rebalance assumptions">
          <section className={cx('orb-setup-section', activeStep === 1 && 'is-active')}>
            <SetupStepToggle
              active={activeStep === 1}
              controls="orb-step-targets"
              description="Set the destination and acceptable drift."
              onToggle={() => setActiveStep(1)}
              step={1}
              summary={`${state.config.sleeves.length} sleeves · ${targetTotal.toFixed(1)}% total`}
              title="Target sleeves"
            />

            <div className="orb-step-content" hidden={activeStep !== 1} id="orb-step-targets">
              <div className="orb-target-table">
                <div className="orb-target-table__head" aria-hidden="true">
                  <span>Sleeve</span>
                  <span>Target</span>
                  <span>Band</span>
                </div>
                {state.config.sleeves.map((sleeve, index) => {
                  const current =
                    holdings.find((holding) => holding.sleeveId === sleeve.id)?.currentWeight ?? 0;
                  return (
                    <div className="orb-target-row" key={sleeve.id}>
                      <div className="orb-target-row__identity">
                        <span
                          className="orb-color-dot"
                          style={{ '--orb-dot': sleeve.color } as CSSProperties}
                          aria-hidden="true"
                        />
                        <div>
                          <strong>{sleeve.shortName}</strong>
                          <small>{current.toFixed(1)}% now</small>
                        </div>
                      </div>
                      <label>
                        <span className="orb-sr-only">{sleeve.name} target percent</span>
                        <span className="orb-number-input">
                          <input
                            data-first-target={index === 0 ? '' : undefined}
                            type="number"
                            min="0"
                            max="100"
                            step="0.5"
                            value={sleeve.target}
                            aria-invalid={Math.abs(targetTotal - 100) > 0.01}
                            onChange={(event) =>
                              updateSleeve(sleeve.id, 'target', event.currentTarget.valueAsNumber)
                            }
                          />
                          <span>%</span>
                        </span>
                      </label>
                      <label>
                        <span className="orb-sr-only">{sleeve.name} allowed drift band</span>
                        <span className="orb-number-input">
                          <span>±</span>
                          <input
                            type="number"
                            min="0.1"
                            max="20"
                            step="0.5"
                            value={sleeve.driftBand}
                            onChange={(event) =>
                              updateSleeve(
                                sleeve.id,
                                'driftBand',
                                event.currentTarget.valueAsNumber,
                              )
                            }
                          />
                          <span>%</span>
                        </span>
                      </label>
                    </div>
                  );
                })}
                <div
                  className={cx(
                    'orb-target-total',
                    Math.abs(targetTotal - 100) <= 0.01 ? 'is-valid' : 'is-invalid',
                  )}
                  role="status"
                >
                  <span>Target total</span>
                  <strong>{targetTotal.toFixed(1)}%</strong>
                  <small>
                    {Math.abs(targetTotal - 100) <= 0.01 ? 'Balanced' : 'Must equal 100%'}
                  </small>
                </div>
              </div>
              <div className="orb-step-footer">
                <button
                  className="orb-button orb-button--secondary"
                  disabled={Math.abs(targetTotal - 100) > 0.01}
                  onClick={() => setActiveStep(2)}
                  type="button"
                >
                  Continue to funding
                  <Icon name="arrow-right" size={13} />
                </button>
              </div>
            </div>
          </section>

          <section className={cx('orb-setup-section', activeStep === 2 && 'is-active')}>
            <SetupStepToggle
              active={activeStep === 2}
              controls="orb-step-funding"
              description="Choose which resources the planner may use."
              onToggle={() => setActiveStep(2)}
              step={2}
              summary={`${fundingMeta[state.config.fundingMode].label} · ${
                state.config.shareMode === 'fractional' ? 'Fractional shares' : 'Whole shares'
              }`}
              title="Funding path"
            />

            <div className="orb-step-content" hidden={activeStep !== 2} id="orb-step-funding">
              <div className="orb-segmented" role="tablist" aria-label="Funding mode">
                {(Object.keys(fundingMeta) as OriginRebalanceFundingMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={state.config.fundingMode === mode}
                    tabIndex={state.config.fundingMode === mode ? 0 : -1}
                    className={state.config.fundingMode === mode ? 'is-selected' : undefined}
                    onClick={() => updateConfig({ fundingMode: mode })}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const tabs = Array.from(
                        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                          '[role="tab"]',
                        ) ?? [],
                      );
                      const currentIndex = tabs.indexOf(event.currentTarget);
                      const nextIndex =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? tabs.length - 1
                            : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
                              tabs.length;
                      tabs[nextIndex]?.focus();
                      tabs[nextIndex]?.click();
                    }}
                  >
                    {fundingMeta[mode].short}
                  </button>
                ))}
              </div>
              <p className="orb-helper">{fundingMeta[state.config.fundingMode].description}</p>

              <div className="orb-choice-row">
                <span>
                  <strong>Trade quantities</strong>
                  <small>How orders may be sized</small>
                </span>
                <div className="orb-inline-choice" aria-label="Trade quantity mode">
                  <button
                    type="button"
                    aria-pressed={state.config.shareMode === 'fractional'}
                    onClick={() => updateConfig({ shareMode: 'fractional' })}
                  >
                    Fractional
                  </button>
                  <button
                    type="button"
                    aria-pressed={state.config.shareMode === 'whole'}
                    onClick={() => updateConfig({ shareMode: 'whole' })}
                  >
                    Whole
                  </button>
                </div>
              </div>
              <div className="orb-step-footer">
                <button
                  className="orb-button orb-button--secondary"
                  onClick={() => setActiveStep(3)}
                  type="button"
                >
                  Continue to policies
                  <Icon name="arrow-right" size={13} />
                </button>
              </div>
            </div>
          </section>

          <section className={cx('orb-setup-section', activeStep === 3 && 'is-active')}>
            <SetupStepToggle
              active={activeStep === 3}
              controls="orb-step-policy"
              description="Set the limits applied before Review."
              onToggle={() => setActiveStep(3)}
              step={3}
              summary={`${state.config.turnoverCap.toFixed(1)}% turnover · ${
                state.config.protectedHoldingIds.length
              } protected`}
              title="Execution policy"
            />

            <div className="orb-step-content" hidden={activeStep !== 3} id="orb-step-policy">
              <div className="orb-field-grid">
                <label>
                  <span>Minimum trade</span>
                  <small>Ignore smaller orders</small>
                  <span className="orb-number-input orb-number-input--wide">
                    <span>{currency === 'EUR' ? '€' : currency}</span>
                    <input
                      type="number"
                      min="0"
                      max={portfolio.value}
                      step="50"
                      value={state.config.minimumTrade}
                      onChange={(event) =>
                        updateConfig({
                          minimumTrade: clamp(
                            event.currentTarget.valueAsNumber || 0,
                            0,
                            portfolio.value,
                          ),
                        })
                      }
                    />
                  </span>
                </label>
                <label>
                  <span>Turnover cap</span>
                  <small>Gross traded value</small>
                  <span className="orb-number-input orb-number-input--wide">
                    <input
                      type="number"
                      min="0.5"
                      max="100"
                      step="0.5"
                      value={state.config.turnoverCap}
                      onChange={(event) =>
                        updateConfig({
                          turnoverCap: clamp(event.currentTarget.valueAsNumber || 0.5, 0.5, 100),
                        })
                      }
                    />
                    <span>%</span>
                  </span>
                </label>
                <label>
                  <span>Cash floor</span>
                  <small>Never plan below</small>
                  <span className="orb-number-input orb-number-input--wide">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      value={state.config.cashFloorPercent}
                      onChange={(event) =>
                        updateConfig({
                          cashFloorPercent: clamp(event.currentTarget.valueAsNumber || 0, 0, 100),
                        })
                      }
                    />
                    <span>%</span>
                  </span>
                </label>
              </div>

              <label className="orb-policy-toggle">
                <span>
                  <Icon name="shield" size={15} />
                  <span>
                    <strong>Tax-aware sales</strong>
                    <small>Reduce appreciated disposals before scaling trades.</small>
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={state.config.taxAware}
                  onChange={(event) => updateConfig({ taxAware: event.currentTarget.checked })}
                />
                <i aria-hidden="true" />
              </label>

              <div className="orb-protected">
                <div className="orb-protected__heading">
                  <span>
                    <strong>Protected holdings</strong>
                    <small>Do not sell, even when overweight</small>
                  </span>
                  <span>{state.config.protectedHoldingIds.length} protected</span>
                </div>
                {holdings
                  .filter((holding) => holding.id !== 'cash')
                  .map((holding) => (
                    <label key={holding.id}>
                      <span className="orb-symbol">{holding.symbol.slice(0, 2)}</span>
                      <span>
                        <strong>{holding.symbol}</strong>
                        <small>{holding.name}</small>
                      </span>
                      <span>
                        <strong>{holding.currentWeight.toFixed(1)}%</strong>
                        <small>
                          {formatMoney(holding.currentValue, currency, privateMode, true)}
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        checked={state.config.protectedHoldingIds.includes(holding.id)}
                        onChange={() => toggleProtected(holding.id)}
                        aria-label={`Protect ${holding.symbol} from sale`}
                      />
                    </label>
                  ))}
              </div>
            </div>
          </section>

          <div className="orb-run">
            {runError ? (
              <p className="orb-error" role="alert">
                <Icon name="help" size={14} />
                {runError}
              </p>
            ) : null}
            {running ? (
              <div
                className="orb-progress"
                role="progressbar"
                aria-label="Calculating rebalance plan"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                aria-valuetext={`${progressLabel}, ${progress}%`}
              >
                <div>
                  <span>{progressLabel}</span>
                  <strong>{progress}%</strong>
                </div>
                <span>
                  <i style={{ '--orb-progress': `${progress}%` } as CSSProperties} />
                </span>
              </div>
            ) : (
              <button
                className="orb-button orb-button--primary orb-button--wide"
                type="button"
                onClick={runPlan}
              >
                <Icon name="sparkles" size={15} />
                Calculate exact plan
              </button>
            )}
            <div className="orb-run__footer">
              <button className="orb-text-button" type="button" onClick={saveScenario}>
                <Icon name="plus" size={12} />
                Save snapshot
              </button>
              <span>Nothing executes here</span>
            </div>
          </div>
        </aside>

        <main className={cx('orb-results', !activePlan && 'orb-results--preview')}>
          {!activePlan ? (
            <div className="orb-empty-plan">
              <SectionHeading
                eyebrow="Live comparison"
                title="Current allocation and target"
                description="The comparison updates as you change the setup."
              />
              <div className="orb-allocation-preview">
                <AllocationBand allocations={currentAllocations} mode="current" label="Current" />
                <AllocationBand allocations={currentAllocations} mode="target" label="Target" />
              </div>
              <details className="orb-current-positions orb-disclosure">
                <summary>
                  <span className="orb-disclosure__leading">
                    <Icon name="portfolio" size={15} />
                    <span>
                      <strong>Current positions</strong>
                      <small>{holdings.length} holdings · prices at 05:54 CEST</small>
                    </span>
                  </span>
                  <Icon name="chevron-down" size={14} />
                </summary>
                {holdings.map((holding) => (
                  <div key={holding.id}>
                    <span className="orb-symbol">{holding.symbol.slice(0, 2)}</span>
                    <span>
                      <strong>{holding.symbol}</strong>
                      <small>{holding.name}</small>
                    </span>
                    <span>
                      <strong>{holding.currentWeight.toFixed(1)}%</strong>
                      <small>{formatMoney(holding.currentValue, currency, privateMode)}</small>
                    </span>
                    <span className="orb-price">
                      {holding.id === 'cash'
                        ? 'Available balance'
                        : `${formatMoney(holding.price, currency, privateMode)} / unit`}
                    </span>
                  </div>
                ))}
              </details>
            </div>
          ) : (
            <div className="orb-plan">
              <header className="orb-plan-header">
                <div>
                  <div className="orb-plan-header__status">
                    <StatusPill status={activePlan.status} />
                    {planIsStale ? <span className="orb-stale">Assumptions changed</span> : null}
                  </div>
                  <h2>{activePlan.reference}</h2>
                  <p>
                    Calculated {formatDate(activePlan.createdAt)} ·{' '}
                    {fundingMeta[activePlan.fundingMode].label} ·{' '}
                    {activePlan.shareMode === 'fractional' ? 'Fractional shares' : 'Whole shares'}
                  </p>
                </div>
                <div className="orb-plan-header__actions">
                  <button
                    className="orb-button orb-button--secondary"
                    type="button"
                    onClick={exportPlan}
                  >
                    <Icon name="download" size={14} />
                    Export JSON
                  </button>
                  <button
                    className="orb-button orb-button--primary"
                    type="button"
                    disabled={
                      planIsStale || activePlan.status !== 'ready' || Boolean(latestReceipt)
                    }
                    onClick={openReview}
                  >
                    <Icon name={latestReceipt ? 'check' : 'inbox'} size={14} />
                    {latestReceipt ? 'Submitted to Review' : 'Submit exact plan'}
                  </button>
                </div>
              </header>

              {planIsStale ? (
                <div className="orb-banner is-warning" role="status">
                  <Icon name="refresh" size={15} />
                  <div>
                    <strong>This result no longer matches the controls.</strong>
                    <span>Calculate again before it can be submitted to Review.</span>
                  </div>
                  <button type="button" onClick={runPlan}>
                    Rerun plan
                  </button>
                </div>
              ) : null}

              {activePlan.status !== 'ready' ? (
                <div className="orb-banner is-danger" role="status">
                  <Icon name="shield" size={15} />
                  <div>
                    <strong>
                      {activePlan.status === 'infeasible'
                        ? 'No compliant path exists with these rules.'
                        : 'The closest plan still sits outside policy.'}
                    </strong>
                    <span>
                      Adjust a protected holding, funding mode, drift band or cash constraint.
                    </span>
                  </div>
                </div>
              ) : null}

              {latestReceipt ? (
                <div className="orb-receipt-strip">
                  <Icon name="check" size={15} />
                  <div>
                    <strong>Exact plan recorded in Review</strong>
                    <span>
                      {latestReceipt.reference} · checksum {latestReceipt.checksum} ·{' '}
                      {formatDate(latestReceipt.submittedAt)}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="orb-plan-metrics" aria-label="Plan summary">
                <div>
                  <span>Trades</span>
                  <strong>{activePlan.trades.length}</strong>
                  <small>
                    {activePlan.trades.filter((trade) => trade.side === 'buy').length} buys ·{' '}
                    {activePlan.trades.filter((trade) => trade.side === 'sell').length} sells
                  </small>
                </div>
                <div>
                  <span>Turnover</span>
                  <strong>{activePlan.turnover.toFixed(2)}%</strong>
                  <small>{state.config.turnoverCap.toFixed(1)}% policy cap</small>
                </div>
                <div>
                  <span>Projected cash</span>
                  <strong>{formatMoney(activePlan.cashAfter, currency, privateMode, true)}</strong>
                  <small>
                    {((activePlan.cashAfter / portfolio.value) * 100).toFixed(2)}% after plan
                  </small>
                </div>
                <div>
                  <span>Fees + estimated tax</span>
                  <strong>
                    {formatMoney(
                      activePlan.fees + activePlan.estimatedTax,
                      currency,
                      privateMode,
                      true,
                    )}
                  </strong>
                  <small>
                    {formatMoney(activePlan.fees, currency, privateMode)} fees ·{' '}
                    {formatMoney(activePlan.estimatedTax, currency, privateMode)} tax
                  </small>
                </div>
              </div>

              <section className="orb-plan-section">
                <SectionHeading
                  eyebrow="Allocation path"
                  title="Before, after, target"
                  description="The result is judged against each sleeve’s drift band, not visual perfection."
                />
                <div className="orb-allocation-comparison">
                  <AllocationBand
                    allocations={activePlan.allocations}
                    mode="current"
                    label="Before"
                  />
                  <AllocationBand
                    allocations={activePlan.allocations}
                    mode="after"
                    label="After plan"
                  />
                  <AllocationBand
                    allocations={activePlan.allocations}
                    mode="target"
                    label="Target"
                  />
                </div>
                <div
                  className="orb-allocation-table"
                  role="table"
                  aria-label="Allocation comparison"
                >
                  <div role="row" className="orb-allocation-table__head">
                    <span role="columnheader">Sleeve</span>
                    <span role="columnheader">Before</span>
                    <span role="columnheader">After</span>
                    <span role="columnheader">Target range</span>
                    <span role="columnheader">Policy</span>
                  </div>
                  {activePlan.allocations.map((allocation) => (
                    <div role="row" key={allocation.sleeveId}>
                      <span role="cell">
                        <i
                          className="orb-color-dot"
                          style={{ '--orb-dot': allocation.color } as CSSProperties}
                          aria-hidden="true"
                        />
                        <strong>{allocation.name}</strong>
                      </span>
                      <span role="cell">{allocation.current.toFixed(1)}%</span>
                      <span role="cell">
                        <strong>{allocation.after.toFixed(1)}%</strong>
                      </span>
                      <span role="cell">
                        {(allocation.target - allocation.driftBand).toFixed(1)}–
                        {(allocation.target + allocation.driftBand).toFixed(1)}%
                      </span>
                      <span role="cell">
                        <span
                          className={cx(
                            'orb-policy-state',
                            allocation.withinBand ? 'is-pass' : 'is-warning',
                          )}
                        >
                          <Icon name={allocation.withinBand ? 'check' : 'help'} size={11} />
                          {allocation.withinBand ? 'Inside band' : 'Outside band'}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="orb-plan-section">
                <SectionHeading
                  eyebrow="Proposed orders"
                  title="Exact trade plan"
                  description="Indicative quantities and estimates are frozen into the Review proposal."
                  action={
                    <span className="orb-pricing-time">
                      <Icon name="clock" size={12} />
                      Prices at 05:54 CEST
                    </span>
                  }
                />
                {activePlan.trades.length ? (
                  <div className="orb-trade-table" role="table" aria-label="Proposed trades">
                    <div role="row" className="orb-trade-table__head">
                      <span role="columnheader">Instrument</span>
                      <span role="columnheader">Action</span>
                      <span role="columnheader">Quantity</span>
                      <span role="columnheader">Gross value</span>
                      <span role="columnheader">Cost estimate</span>
                    </div>
                    {activePlan.trades.map((trade) => (
                      <div role="row" key={trade.id} className="orb-trade-row">
                        <span role="cell">
                          <i className="orb-symbol">{trade.symbol.slice(0, 2)}</i>
                          <span>
                            <strong>{trade.symbol}</strong>
                            <small>{trade.reason}</small>
                          </span>
                        </span>
                        <span role="cell">
                          <span className={cx('orb-side', `is-${trade.side}`)}>{trade.side}</span>
                        </span>
                        <span role="cell">
                          <strong>
                            {formatQuantity(trade.quantity, activePlan.shareMode === 'fractional')}
                          </strong>
                          <small>@ {formatMoney(trade.price, currency, privateMode)}</small>
                        </span>
                        <span role="cell">
                          <strong>{formatMoney(trade.grossValue, currency, privateMode)}</strong>
                          <small>
                            {((trade.grossValue / portfolio.value) * 100).toFixed(2)}% of portfolio
                          </small>
                        </span>
                        <span role="cell">
                          <strong>
                            {formatMoney(trade.fee + trade.estimatedTax, currency, privateMode)}
                          </strong>
                          <small>
                            {formatMoney(trade.fee, currency, privateMode)} fee
                            {trade.estimatedTax
                              ? ` · ${formatMoney(trade.estimatedTax, currency, privateMode)} tax`
                              : ''}
                          </small>
                        </span>
                        <div className="orb-trade-explain">
                          <Icon name="shield" size={12} />
                          <span>
                            {trade.policyNotes.length
                              ? trade.policyNotes.join(' · ')
                              : 'No policy adjustment required'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="orb-no-trades">
                    <Icon name="check" size={18} />
                    <div>
                      <strong>No executable trades in this path</strong>
                      <span>
                        Current constraints either block or make every required trade immaterial.
                      </span>
                    </div>
                  </div>
                )}
              </section>

              <details className="orb-plan-disclosure orb-disclosure">
                <summary>
                  <span className="orb-disclosure__leading">
                    <Icon name="shield" size={15} />
                    <span>
                      <strong>Decision details</strong>
                      <small>
                        {activePlan.explanation.length} solver steps ·{' '}
                        {activePlan.blockedReasons.length + activePlan.warnings.length} notes
                      </small>
                    </span>
                  </span>
                  <Icon name="chevron-down" size={14} />
                </summary>
                <div className="orb-plan-section orb-plan-section--split">
                  <div>
                    <SectionHeading
                      eyebrow="Why this plan"
                      title="Decision path"
                      description="The order in which the solver applied your rules."
                    />
                    <ol className="orb-explanation">
                      {activePlan.explanation.map((item, index) => (
                        <li key={item}>
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <p>{item}</p>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <SectionHeading
                      eyebrow="Exceptions"
                      title={
                        activePlan.blockedReasons.length
                          ? `${activePlan.blockedReasons.length} policy conflicts`
                          : `${activePlan.warnings.length} planning notes`
                      }
                      description="Resolve blockers before submission; verify estimates during review."
                    />
                    <div className="orb-notes">
                      {activePlan.blockedReasons.map((item) => (
                        <div className="is-blocked" key={item}>
                          <Icon name="x" size={13} />
                          <span>{item}</span>
                        </div>
                      ))}
                      {activePlan.warnings.map((item) => (
                        <div key={item}>
                          <Icon name="help" size={13} />
                          <span>{item}</span>
                        </div>
                      ))}
                      {!activePlan.blockedReasons.length && !activePlan.warnings.length ? (
                        <div className="is-clear">
                          <Icon name="check" size={13} />
                          <span>No exceptions. Every configured policy passes.</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </details>
            </div>
          )}
        </main>
      </div>

      <details className="orb-scenarios orb-disclosure">
        <summary>
          <span className="orb-disclosure__leading">
            <Icon name="clock" size={15} />
            <span>
              <strong>Saved setups & history</strong>
              <small>
                {state.scenarios.length} saved · {state.history.length} calculations
              </small>
            </span>
          </span>
          <Icon name="chevron-down" size={14} />
        </summary>
        <div className="orb-scenarios__content">
          <div className="orb-scenarios__toolbar">
            <p>Restore an earlier setup or compare a previous exact result.</p>
            <button
              className="orb-button orb-button--secondary"
              type="button"
              onClick={saveScenario}
            >
              <Icon name="plus" size={13} />
              Save current setup
            </button>
          </div>
          <div className="orb-scenario-grid">
            <div>
              <h3 id="orb-scenarios-title">Saved setups</h3>
              <div className="orb-scenario-list">
                {state.scenarios.map((scenario) => (
                  <article key={scenario.id}>
                    <span className="orb-scenario-icon">
                      <Icon name="layers" size={15} />
                    </span>
                    <div>
                      <strong>{scenario.name}</strong>
                      <p>{scenario.description}</p>
                      <small>
                        {formatDate(scenario.savedAt)} ·{' '}
                        {fundingMeta[scenario.config.fundingMode].label}
                      </small>
                    </div>
                    <button type="button" onClick={() => restoreScenario(scenario)}>
                      Restore & edit
                      <Icon name="arrow-right" size={12} />
                    </button>
                  </article>
                ))}
              </div>
            </div>
            <div>
              <h3>Calculation history</h3>
              {state.history.length ? (
                <div className="orb-history-list">
                  {state.history.map((plan) => (
                    <button
                      type="button"
                      key={plan.id}
                      className={activePlan?.id === plan.id ? 'is-active' : undefined}
                      aria-pressed={activePlan?.id === plan.id}
                      onClick={() => restoreHistory(plan)}
                    >
                      <span>
                        <StatusPill status={plan.status}>
                          {plan.status === 'ready' ? 'Ready' : plan.status}
                        </StatusPill>
                        <strong>{plan.reference}</strong>
                        <small>{formatDate(plan.createdAt)}</small>
                      </span>
                      <span>
                        <strong>{plan.trades.length} trades</strong>
                        <small>{plan.turnover.toFixed(2)}% turnover</small>
                      </span>
                      <Icon name="chevron-right" size={13} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="orb-history-empty">
                  <Icon name="clock" size={17} />
                  <strong>No calculations yet</strong>
                  <span>Your first exact result will be recorded here.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </details>

      {reviewOpen && activePlan ? (
        <div className="orb-dialog-layer" data-accessible-dialog-layer>
          <button
            className="orb-dialog-backdrop"
            type="button"
            aria-label="Close review proposal"
            onClick={() => setReviewOpen(false)}
          />
          <form
            ref={reviewDialogRef}
            className="orb-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="orb-review-title"
            aria-describedby="orb-review-description"
            tabIndex={-1}
            onSubmit={submitReview}
          >
            <header className="orb-dialog__header">
              <div>
                <span>Review boundary</span>
                <h2 id="orb-review-title" data-review-heading tabIndex={-1}>
                  Submit this exact plan?
                </h2>
                <p id="orb-review-description">
                  This creates a proposal with immutable calculations and lineage. It does not place
                  broker orders.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close review proposal"
                onClick={() => setReviewOpen(false)}
              >
                <Icon name="x" size={15} />
              </button>
            </header>

            <div className="orb-dialog__identity">
              <span className="orb-dialog__mark">
                <Icon name="repeat" size={18} />
              </span>
              <div>
                <strong>{activePlan.reference}</strong>
                <span>{portfolio.name}</span>
              </div>
              <StatusPill status={activePlan.status} />
            </div>

            <div className="orb-dialog__summary">
              <div>
                <span>Exact trades</span>
                <strong>{activePlan.trades.length}</strong>
              </div>
              <div>
                <span>Gross turnover</span>
                <strong>{activePlan.turnover.toFixed(2)}%</strong>
              </div>
              <div>
                <span>Projected cash</span>
                <strong>{formatMoney(activePlan.cashAfter, currency, privateMode, true)}</strong>
              </div>
              <div>
                <span>Fees + tax</span>
                <strong>
                  {formatMoney(
                    activePlan.fees + activePlan.estimatedTax,
                    currency,
                    privateMode,
                    true,
                  )}
                </strong>
              </div>
            </div>

            <div className="orb-dialog__trades">
              {activePlan.trades.map((trade) => (
                <div key={trade.id}>
                  <span className={cx('orb-side', `is-${trade.side}`)}>{trade.side}</span>
                  <strong>
                    {formatQuantity(trade.quantity, activePlan.shareMode === 'fractional')}{' '}
                    {trade.symbol}
                  </strong>
                  <span>{formatMoney(trade.grossValue, currency, privateMode)}</span>
                </div>
              ))}
            </div>

            <div className="orb-dialog__policy">
              <div>
                <Icon name="shield" size={14} />
                <span>
                  <strong>Approval remains required</strong>
                  <small>
                    Review can approve or return this exact checksum. Editing creates a new plan.
                  </small>
                </span>
              </div>
              <code>{hashText(JSON.stringify(activePlan))}</code>
            </div>

            <label className="orb-consent">
              <input
                type="checkbox"
                checked={reviewConsent}
                onChange={(event) => {
                  setReviewConsent(event.currentTarget.checked);
                  setReviewError('');
                }}
              />
              <span>
                I reviewed the exact quantities, planning estimates and portfolio constraints above.
              </span>
            </label>
            {reviewError ? (
              <p className="orb-error" role="alert">
                <Icon name="help" size={13} />
                {reviewError}
              </p>
            ) : null}

            <footer className="orb-dialog__footer">
              <button
                className="orb-button orb-button--secondary"
                type="button"
                onClick={() => setReviewOpen(false)}
              >
                Keep editing
              </button>
              <button className="orb-button orb-button--primary" type="submit">
                <Icon name="inbox" size={14} />
                Submit exact plan
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}
