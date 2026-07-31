import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry } from './OriginReviewCenter';
import { useAccessibleDialog, useDialogStepFocus } from './useAccessibleDialog';
import './origin-private-markets.css';

export type OriginPrivateMarketKind = 'fund' | 'private-company' | 'real-estate';
export type OriginPrivateMarketStatus = 'active' | 'harvesting' | 'fully-funded';
export type OriginPrivateMarketCurrency = 'EUR' | 'USD' | 'GBP' | 'CHF';

export type OriginPrivateMarketDocument = {
  id: string;
  name: string;
  kind: 'notice' | 'statement' | 'valuation' | 'agreement' | 'report';
  state: 'verified' | 'linked' | 'missing';
  date: string;
  source: string;
};

export type OriginPrivateMarketValuation = {
  amount: number;
  asOf: string;
  receivedAt: string;
  source: string;
  method: string;
  confidence: 'verified' | 'manager-reported' | 'estimated';
  freshnessDays: number;
  documents: OriginPrivateMarketDocument[];
  lineage: Array<{
    label: string;
    detail: string;
    at: string;
    state: 'verified' | 'external' | 'derived' | 'warning';
  }>;
  proposalStatus?: 'in-review';
};

export type OriginPrivateMarketCommitment = {
  id: string;
  name: string;
  legalName: string;
  kind: OriginPrivateMarketKind;
  strategy: string;
  geography: string;
  vintage: number;
  status: OriginPrivateMarketStatus;
  currency: OriginPrivateMarketCurrency;
  fxToPortfolio: number;
  committed: number;
  contributed: number;
  distributed: number;
  nav: number;
  ownership: number;
  manager: string;
  account: string;
  valuation: OriginPrivateMarketValuation;
};

export type OriginPrivateMarketCall = {
  id: string;
  commitmentId: string;
  title: string;
  amount: number;
  currency: OriginPrivateMarketCurrency;
  dueDate: string;
  noticeDate: string;
  purpose: string;
  sourceDocument: string;
  status: 'scheduled' | 'forecast' | 'in-review' | 'funded';
  confidence: 'confirmed' | 'manager-guidance' | 'estimated';
};

export type OriginPrivateMarketsProps = {
  portfolio: {
    id: string;
    name: string;
    currency?: OriginPrivateMarketCurrency;
  };
  availableCash?: number;
  privateMode: boolean;
  onClose: () => void;
  onOpenFiles: () => void;
  onOpenCashFlow: () => void;
  onOpenReview: () => void;
  onSubmitReview: (entry: OriginReviewEntry) => void;
  onToast: (message: string) => void;
};

type WorkspaceView = 'overview' | 'commitments' | 'cash-plan' | 'evidence' | 'audit';
type KindFilter = OriginPrivateMarketKind | 'all';
type ReceiptKind = 'commitment-created' | 'capital-call-proposed' | 'valuation-proposed';

type PrivateMarketReceipt = {
  id: string;
  kind: ReceiptKind;
  at: string;
  actor: string;
  title: string;
  detail: string;
  objectId: string;
  reviewId?: string;
};

type PrivateMarketAudit = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  object: string;
  receiptId?: string;
  tone: 'neutral' | 'success' | 'attention';
};

type PrivateMarketStore = {
  version: 1;
  portfolioId: string;
  availableCash: number;
  commitments: OriginPrivateMarketCommitment[];
  calls: OriginPrivateMarketCall[];
  receipts: PrivateMarketReceipt[];
  audit: PrivateMarketAudit[];
  pendingActions?: Record<string, PrivateMarketPendingAction>;
};

type PrivateMarketPendingAction =
  | {
      kind: 'capital-call';
      callId: string;
      commitmentId: string;
      amount: number;
      translatedAmount: number;
    }
  | {
      kind: 'valuation';
      commitmentId: string;
      amount: number;
      asOf: string;
      source: string;
      method: string;
      evidence: string;
    };

type CreateDraft = {
  name: string;
  legalName: string;
  kind: OriginPrivateMarketKind;
  strategy: string;
  geography: string;
  vintage: string;
  manager: string;
  account: string;
  currency: OriginPrivateMarketCurrency;
  committed: string;
  contributed: string;
  nav: string;
  fxToPortfolio: string;
  ownership: string;
};

type CallDraft = {
  source: string;
  amount: string;
  dueDate: string;
  reason: string;
  acknowledged: boolean;
};

type ValuationDraft = {
  amount: string;
  asOf: string;
  source: string;
  method: string;
  evidence: string;
  reason: string;
  acknowledged: boolean;
};

type ActiveWorkflow =
  | { kind: 'create' }
  | { kind: 'capital-call'; callId: string }
  | { kind: 'valuation'; commitmentId: string }
  | null;

const kindMeta: Record<
  OriginPrivateMarketKind,
  { label: string; short: string; icon: IconName; description: string }
> = {
  fund: {
    label: 'Private fund',
    short: 'Fund',
    icon: 'layers',
    description: 'Drawdown funds, venture funds, and limited partnerships',
  },
  'private-company': {
    label: 'Private company',
    short: 'Company',
    icon: 'briefcase',
    description: 'Direct equity, employee shares, and private placements',
  },
  'real-estate': {
    label: 'Private real estate',
    short: 'Property',
    icon: 'house',
    description: 'Direct property and private real-estate vehicles',
  },
};

const views: Array<{ id: WorkspaceView; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'commitments', label: 'Commitments', icon: 'layers' },
  { id: 'cash-plan', label: 'Cash plan', icon: 'calendar' },
  { id: 'evidence', label: 'Evidence', icon: 'document' },
  { id: 'audit', label: 'Audit', icon: 'activity' },
];

const today = '2026-07-27';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function nowLabel() {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function relativeDue(value: string) {
  const due = new Date(`${value}T12:00:00`).getTime();
  const base = new Date(`${today}T12:00:00`).getTime();
  const days = Math.ceil((due - base) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Due today';
  return `Due in ${days}d`;
}

function storageKey(portfolioId: string) {
  const safe =
    portfolioId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'portfolio';
  return `bt-origin-private-markets-v1-${safe}`;
}

function money(
  value: number,
  currency: OriginPrivateMarketCurrency,
  privateMode = false,
  compact = false,
) {
  if (privateMode) return compact ? '••••' : '••••••';
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value);
}

function percent(value: number) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function multiple(value: number) {
  return `${value.toFixed(2)}×`;
}

function toPortfolioCurrency(
  amount: number,
  currency: OriginPrivateMarketCurrency,
  portfolioCurrency: OriginPrivateMarketCurrency,
  fx: number,
) {
  return currency === portfolioCurrency ? amount : amount * fx;
}

function performance(commitment: OriginPrivateMarketCommitment) {
  const paidIn = Math.max(commitment.contributed, 1);
  return {
    tvpi: (commitment.nav + commitment.distributed) / paidIn,
    dpi: commitment.distributed / paidIn,
    rvpi: commitment.nav / paidIn,
    irr:
      commitment.kind === 'fund'
        ? commitment.name.includes('Horizon')
          ? 18.4
          : 13.7
        : commitment.kind === 'real-estate'
          ? 11.2
          : 24.6,
  };
}

function seedStore(portfolioId: string): PrivateMarketStore {
  const commitments: OriginPrivateMarketCommitment[] = [
    {
      id: 'pm_horizon_growth_iii',
      name: 'Horizon Growth III',
      legalName: 'Horizon Growth Partners III, L.P.',
      kind: 'fund',
      strategy: 'Growth equity',
      geography: 'North America · Europe',
      vintage: 2023,
      status: 'active',
      currency: 'USD',
      fxToPortfolio: 0.867,
      committed: 400_000,
      contributed: 235_000,
      distributed: 58_000,
      nav: 282_400,
      ownership: 0.18,
      manager: 'Horizon Partners',
      account: 'Personal wealth · Private markets',
      valuation: {
        amount: 282_400,
        asOf: '2026-06-30',
        receivedAt: '2026-07-18',
        source: 'Horizon Partners · Q2 capital account statement',
        method: 'Manager-reported NAV',
        confidence: 'verified',
        freshnessDays: 27,
        documents: [
          {
            id: 'doc_horizon_q2',
            name: 'Horizon III · Q2 2026 statement.pdf',
            kind: 'statement',
            state: 'verified',
            date: '2026-06-30',
            source: 'Manager portal',
          },
          {
            id: 'doc_horizon_lpa',
            name: 'Horizon III · executed LPA.pdf',
            kind: 'agreement',
            state: 'linked',
            date: '2023-04-12',
            source: 'Portfolio files',
          },
        ],
        lineage: [
          {
            label: 'Manager statement',
            detail: 'Ending NAV USD 282,400; LP account HG3-0184',
            at: '30 Jun 2026',
            state: 'external',
          },
          {
            label: 'Document verification',
            detail: 'Statement totals reconcile to contribution and distribution ledger',
            at: '18 Jul 2026',
            state: 'verified',
          },
          {
            label: 'Portfolio conversion',
            detail: 'Translated at 0.867 EUR per USD for consolidated reporting',
            at: '26 Jul 2026',
            state: 'derived',
          },
        ],
      },
    },
    {
      id: 'pm_alpine_climate',
      name: 'Alpine Climate Ventures',
      legalName: 'Alpine Climate Ventures I GmbH & Co. KG',
      kind: 'fund',
      strategy: 'Climate venture',
      geography: 'DACH · Nordics',
      vintage: 2022,
      status: 'active',
      currency: 'EUR',
      fxToPortfolio: 1,
      committed: 220_000,
      contributed: 176_000,
      distributed: 32_000,
      nav: 201_800,
      ownership: 0.42,
      manager: 'Alpine Ventures',
      account: 'Personal wealth · Private markets',
      valuation: {
        amount: 201_800,
        asOf: '2026-03-31',
        receivedAt: '2026-05-04',
        source: 'Alpine Ventures · Q1 investor report',
        method: 'Manager-reported NAV',
        confidence: 'manager-reported',
        freshnessDays: 118,
        documents: [
          {
            id: 'doc_alpine_q1',
            name: 'ACV I · Q1 2026 investor report.pdf',
            kind: 'report',
            state: 'linked',
            date: '2026-03-31',
            source: 'Email import',
          },
          {
            id: 'doc_alpine_q2',
            name: 'ACV I · Q2 2026 statement.pdf',
            kind: 'statement',
            state: 'missing',
            date: '2026-06-30',
            source: 'Expected from manager',
          },
        ],
        lineage: [
          {
            label: 'Investor report',
            detail: 'Q1 NAV EUR 201,800; no audited statement attached',
            at: '31 Mar 2026',
            state: 'external',
          },
          {
            label: 'Freshness policy',
            detail: '118 days old; portfolio policy allows 90 days',
            at: '27 Jul 2026',
            state: 'warning',
          },
          {
            label: 'Portfolio carry',
            detail: 'Last reported NAV retained until an approved valuation supersedes it',
            at: '27 Jul 2026',
            state: 'derived',
          },
        ],
      },
    },
    {
      id: 'pm_riverside_logistics',
      name: 'Riverside Logistics',
      legalName: 'Riverside Logistics Objekt GmbH',
      kind: 'real-estate',
      strategy: 'Income property',
      geography: 'Vienna, Austria',
      vintage: 2021,
      status: 'fully-funded',
      currency: 'EUR',
      fxToPortfolio: 1,
      committed: 310_000,
      contributed: 310_000,
      distributed: 42_600,
      nav: 348_000,
      ownership: 38,
      manager: 'Direct holding',
      account: 'Personal wealth · Real assets',
      valuation: {
        amount: 348_000,
        asOf: '2026-05-31',
        receivedAt: '2026-06-06',
        source: 'Independent desktop valuation',
        method: 'Income capitalisation',
        confidence: 'verified',
        freshnessDays: 57,
        documents: [
          {
            id: 'doc_riverside_value',
            name: 'Riverside · valuation May 2026.pdf',
            kind: 'valuation',
            state: 'verified',
            date: '2026-05-31',
            source: 'Portfolio files',
          },
          {
            id: 'doc_riverside_registry',
            name: 'Riverside · land registry extract.pdf',
            kind: 'agreement',
            state: 'verified',
            date: '2026-02-18',
            source: 'Portfolio files',
          },
        ],
        lineage: [
          {
            label: 'Independent valuation',
            detail: 'Property EUR 915,790; portfolio share 38.0%',
            at: '31 May 2026',
            state: 'external',
          },
          {
            label: 'Ownership calculation',
            detail: 'EUR 915,790 × 38.0% = EUR 348,000',
            at: '06 Jun 2026',
            state: 'derived',
          },
          {
            label: 'Evidence review',
            detail: 'Signed report and ownership record both verified',
            at: '06 Jun 2026',
            state: 'verified',
          },
        ],
      },
    },
    {
      id: 'pm_helio_systems',
      name: 'Helio Systems',
      legalName: 'Helio Systems Ltd.',
      kind: 'private-company',
      strategy: 'Direct equity',
      geography: 'United Kingdom',
      vintage: 2024,
      status: 'active',
      currency: 'GBP',
      fxToPortfolio: 1.156,
      committed: 120_000,
      contributed: 120_000,
      distributed: 0,
      nav: 154_000,
      ownership: 1.7,
      manager: 'Direct holding',
      account: 'Personal wealth · Private companies',
      valuation: {
        amount: 154_000,
        asOf: '2026-04-15',
        receivedAt: '2026-04-22',
        source: 'Series C financing round',
        method: 'Last preferred round · 22% haircut',
        confidence: 'estimated',
        freshnessDays: 103,
        documents: [
          {
            id: 'doc_helio_round',
            name: 'Helio · Series C completion notice.pdf',
            kind: 'notice',
            state: 'linked',
            date: '2026-04-15',
            source: 'Company counsel',
          },
          {
            id: 'doc_helio_cap',
            name: 'Helio · current cap table.xlsx',
            kind: 'report',
            state: 'missing',
            date: '2026-06-30',
            source: 'Requested from company',
          },
        ],
        lineage: [
          {
            label: 'Financing round',
            detail: 'Preferred share price GBP 18.42',
            at: '15 Apr 2026',
            state: 'external',
          },
          {
            label: 'Liquidity adjustment',
            detail: '22% haircut applied to reflect ordinary-share and liquidity terms',
            at: '22 Apr 2026',
            state: 'derived',
          },
          {
            label: 'Evidence gap',
            detail: 'Updated cap table requested; ownership remains estimated',
            at: '24 Jul 2026',
            state: 'warning',
          },
        ],
      },
    },
  ];

  return {
    version: 1,
    portfolioId,
    availableCash: 126_400,
    commitments,
    calls: [
      {
        id: 'call_horizon_aug',
        commitmentId: 'pm_horizon_growth_iii',
        title: 'Capital call 08',
        amount: 50_000,
        currency: 'USD',
        dueDate: '2026-08-12',
        noticeDate: '2026-07-22',
        purpose: 'Follow-on investments and management fees',
        sourceDocument: 'Horizon III · capital call 08.pdf',
        status: 'scheduled',
        confidence: 'confirmed',
      },
      {
        id: 'call_alpine_sep',
        commitmentId: 'pm_alpine_climate',
        title: 'Expected Q3 drawdown',
        amount: 22_000,
        currency: 'EUR',
        dueDate: '2026-09-05',
        noticeDate: '2026-07-03',
        purpose: 'Manager guidance · two planned investments',
        sourceDocument: 'ACV I · Q2 portfolio update.pdf',
        status: 'forecast',
        confidence: 'manager-guidance',
      },
      {
        id: 'call_horizon_oct',
        commitmentId: 'pm_horizon_growth_iii',
        title: 'Expected Q4 drawdown',
        amount: 40_000,
        currency: 'USD',
        dueDate: '2026-10-14',
        noticeDate: '2026-06-30',
        purpose: 'Forecast from annual pacing guidance',
        sourceDocument: 'Horizon III · 2026 pacing guidance.pdf',
        status: 'forecast',
        confidence: 'estimated',
      },
    ],
    receipts: [],
    audit: [
      {
        id: 'audit_seed_1',
        at: '27 Jul 2026 · 05:42',
        actor: 'BetterTrack data health',
        action: 'Freshness policy evaluated',
        detail: 'Alpine Climate Ventures and Helio Systems exceed the 90-day valuation policy.',
        object: '2 valuations',
        tone: 'attention',
      },
      {
        id: 'audit_seed_2',
        at: '26 Jul 2026 · 22:10',
        actor: 'ECB reference rates',
        action: 'FX translation refreshed',
        detail: 'USD/EUR 0.867 and GBP/EUR 1.156 applied to consolidated private-market totals.',
        object: 'Portfolio currency layer',
        tone: 'success',
      },
      {
        id: 'audit_seed_3',
        at: '22 Jul 2026 · 14:18',
        actor: 'Manager portal import',
        action: 'Capital call detected',
        detail: 'Horizon Growth III capital call 08 was linked to its source notice.',
        object: 'Capital call 08',
        tone: 'neutral',
      },
    ],
  };
}

function readStore(portfolioId: string) {
  const seeded = seedStore(portfolioId);
  if (typeof window === 'undefined') return seeded;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey(portfolioId)) ?? 'null',
    ) as PrivateMarketStore | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      parsed.portfolioId !== portfolioId ||
      !Array.isArray(parsed.commitments) ||
      !Array.isArray(parsed.calls)
    ) {
      return seeded;
    }
    return parsed;
  } catch {
    return seeded;
  }
}

export function applyOriginPrivateMarketsReviewDecision(
  portfolioId: string,
  reviewId: string,
  decision: 'approved' | 'rejected',
  reference: string,
) {
  if (typeof window === 'undefined') return { applied: false, cashDelta: 0 };
  try {
    const key = storageKey(portfolioId);
    const store = JSON.parse(
      window.localStorage.getItem(key) ?? 'null',
    ) as PrivateMarketStore | null;
    const action = store?.pendingActions?.[reviewId];
    if (!store || !action) return { applied: false, cashDelta: 0 };
    let cashDelta = 0;
    let commitments = store.commitments;
    let calls = store.calls;
    if (action.kind === 'capital-call') {
      calls = calls.map((call) =>
        call.id === action.callId
          ? { ...call, status: decision === 'approved' ? 'funded' : 'scheduled' }
          : call,
      );
      if (decision === 'approved') {
        cashDelta = -action.translatedAmount;
        commitments = commitments.map((commitment) =>
          commitment.id === action.commitmentId
            ? {
                ...commitment,
                contributed: commitment.contributed + action.amount,
              }
            : commitment,
        );
      }
    } else {
      commitments = commitments.map((commitment) =>
        commitment.id === action.commitmentId
          ? {
              ...commitment,
              ...(decision === 'approved' ? { nav: action.amount } : {}),
              valuation:
                decision === 'approved'
                  ? {
                      ...commitment.valuation,
                      amount: action.amount,
                      asOf: action.asOf,
                      receivedAt: new Date().toISOString(),
                      source: action.source,
                      method: action.method,
                      confidence: action.evidence ? 'verified' : 'manager-reported',
                      freshnessDays: 0,
                      proposalStatus: undefined,
                    }
                  : { ...commitment.valuation, proposalStatus: undefined },
            }
          : commitment,
      );
    }
    const pendingActions = { ...(store.pendingActions ?? {}) };
    delete pendingActions[reviewId];
    const at = nowLabel();
    const next: PrivateMarketStore = {
      ...store,
      commitments,
      calls,
      pendingActions,
      audit: [
        {
          id: makeId('audit'),
          at,
          actor: 'You',
          action: `Review decision ${decision}`,
          detail:
            decision === 'approved'
              ? `The exact proposal is now portfolio truth · ${reference}.`
              : `The proposal was closed without changing portfolio truth · ${reference}.`,
          object: action.kind === 'capital-call' ? action.callId : action.commitmentId,
          tone: decision === 'approved' ? 'success' : 'neutral',
        },
        ...store.audit,
      ],
    };
    window.localStorage.setItem(key, JSON.stringify(next));
    return { applied: true, cashDelta };
  } catch {
    return { applied: false, cashDelta: 0 };
  }
}

function emptyCreateDraft(): CreateDraft {
  return {
    name: '',
    legalName: '',
    kind: 'fund',
    strategy: 'Growth equity',
    geography: 'Europe',
    vintage: '2026',
    manager: '',
    account: 'Personal wealth · Private markets',
    currency: 'EUR',
    committed: '250000',
    contributed: '0',
    nav: '0',
    fxToPortfolio: '1',
    ownership: '0.25',
  };
}

function navSparkline(seed: number) {
  return Array.from({ length: 28 }, (_, index) => {
    const progress = index / 27;
    const drift = progress * 28;
    const wave = Math.sin((index + seed) * 0.72) * 4.6 + Math.cos(index * 0.31) * 2.2;
    return 68 + drift + wave + (index > 19 ? 5 : 0);
  });
}

function MiniNavChart({
  commitment,
  privateMode,
}: {
  commitment: OriginPrivateMarketCommitment;
  privateMode: boolean;
}) {
  const values = useMemo(
    () => navSparkline(commitment.name.length + commitment.vintage),
    [commitment.name, commitment.vintage],
  );
  const width = 430;
  const height = 126;
  const min = Math.min(...values) - 4;
  const max = Math.max(...values) + 4;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / (max - min)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <figure className="opm-nav-chart" aria-label={`${commitment.name} reported NAV history`}>
      <div className="opm-nav-chart__heading">
        <div>
          <span>Reported NAV</span>
          <strong>{money(commitment.nav, commitment.currency, privateMode)}</strong>
        </div>
        <small>8 quarters · manager reported</small>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden="true">
        <defs>
          <linearGradient id={`opm-fill-${commitment.id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--opm-accent)" stopOpacity=".2" />
            <stop offset="100%" stopColor="var(--opm-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1="0"
            x2={width}
            y1={height * ratio}
            y2={height * ratio}
            className="opm-nav-chart__grid"
          />
        ))}
        <polygon
          points={`0,${height} ${points} ${width},${height}`}
          fill={`url(#opm-fill-${commitment.id})`}
        />
        <polyline points={points} className="opm-nav-chart__line" />
      </svg>
      <figcaption>
        <span>Q3 ’24</span>
        <span>Q2 ’26</span>
      </figcaption>
    </figure>
  );
}

function Metric({
  label,
  value,
  helper,
  tone,
}: {
  label: string;
  value: string;
  helper: string;
  tone?: 'positive' | 'attention';
}) {
  return (
    <div className={cx('opm-metric', tone && `opm-metric--${tone}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status:
    | OriginPrivateMarketStatus
    | OriginPrivateMarketCall['status']
    | OriginPrivateMarketValuation['confidence'];
}) {
  const label = status.replaceAll('-', ' ');
  return <span className={`opm-status opm-status--${status}`}>{label}</span>;
}

export function OriginPrivateMarkets({
  portfolio,
  availableCash,
  privateMode,
  onClose,
  onOpenFiles,
  onOpenCashFlow,
  onOpenReview,
  onSubmitReview,
  onToast,
}: OriginPrivateMarketsProps) {
  const portfolioCurrency = portfolio.currency ?? 'EUR';
  const [store, setStore] = useState<PrivateMarketStore>(() => readStore(portfolio.id));
  const [view, setView] = useState<WorkspaceView>('overview');
  const [selectedId, setSelectedId] = useState('pm_horizon_growth_iii');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const [workflow, setWorkflow] = useState<ActiveWorkflow>(null);
  const [workflowStep, setWorkflowStep] = useState(1);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(emptyCreateDraft);
  const [callDraft, setCallDraft] = useState<CallDraft>({
    source: 'Portfolio cash · EUR',
    amount: '',
    dueDate: '',
    reason: '',
    acknowledged: false,
  });
  const [valuationDraft, setValuationDraft] = useState<ValuationDraft>({
    amount: '',
    asOf: today,
    source: '',
    method: 'Manager-reported NAV',
    evidence: '',
    reason: '',
    acknowledged: false,
  });
  const [activeReceipt, setActiveReceipt] = useState<PrivateMarketReceipt | null>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const rootDialogRef = useAccessibleDialog<HTMLElement>({
    open: true,
    onClose,
    initialFocusSelector: '[data-opm-initial-focus]',
  });
  const workflowDialogRef = useAccessibleDialog<HTMLDivElement>({
    open: workflow !== null,
    onClose: () => setWorkflow(null),
    initialFocusSelector: '[data-opm-workflow-focus]',
  });
  const receiptDialogRef = useAccessibleDialog<HTMLDivElement>({
    open: activeReceipt !== null,
    onClose: () => setActiveReceipt(null),
    initialFocusSelector: '[data-opm-receipt-focus]',
  });

  useDialogStepFocus(workflow !== null, workflowStep, stepHeadingRef);

  useEffect(() => {
    setStore(readStore(portfolio.id));
    setView('overview');
    setSelectedId('pm_horizon_growth_iii');
  }, [portfolio.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey(portfolio.id), JSON.stringify(store));
  }, [portfolio.id, store]);

  const selected =
    store.commitments.find((commitment) => commitment.id === selectedId) ??
    store.commitments[0] ??
    null;
  const portfolioAvailableCash = availableCash ?? store.availableCash;

  const totals = useMemo(() => {
    return store.commitments.reduce(
      (summary, commitment) => {
        const convert = (value: number) =>
          toPortfolioCurrency(
            value,
            commitment.currency,
            portfolioCurrency,
            commitment.fxToPortfolio,
          );
        summary.committed += convert(commitment.committed);
        summary.contributed += convert(commitment.contributed);
        summary.distributed += convert(commitment.distributed);
        summary.nav += convert(commitment.nav);
        summary.unfunded += convert(Math.max(commitment.committed - commitment.contributed, 0));
        return summary;
      },
      { committed: 0, contributed: 0, distributed: 0, nav: 0, unfunded: 0 },
    );
  }, [portfolioCurrency, store.commitments]);

  const aggregate = {
    tvpi: (totals.nav + totals.distributed) / Math.max(totals.contributed, 1),
    dpi: totals.distributed / Math.max(totals.contributed, 1),
    irr: 16.8,
  };

  const upcomingCalls = useMemo(
    () =>
      store.calls
        .filter((call) => call.status !== 'funded')
        .sort((left, right) => left.dueDate.localeCompare(right.dueDate)),
    [store.calls],
  );

  const callExposure = useMemo(
    () =>
      upcomingCalls.reduce((sum, call) => {
        const commitment = store.commitments.find((item) => item.id === call.commitmentId);
        if (!commitment) return sum;
        return (
          sum +
          toPortfolioCurrency(
            call.amount,
            call.currency,
            portfolioCurrency,
            commitment.fxToPortfolio,
          )
        );
      }, 0),
    [portfolioCurrency, store.commitments, upcomingCalls],
  );

  const cashCoverage = portfolioAvailableCash / Math.max(callExposure, 1);
  const staleCount = store.commitments.filter(
    (commitment) => commitment.valuation.freshnessDays > 90,
  ).length;

  const visibleCommitments = useMemo(() => {
    const query = search.trim().toLowerCase();
    return store.commitments.filter((commitment) => {
      if (kindFilter !== 'all' && commitment.kind !== kindFilter) return false;
      if (!query) return true;
      return [
        commitment.name,
        commitment.legalName,
        commitment.manager,
        commitment.strategy,
        commitment.geography,
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [kindFilter, search, store.commitments]);

  const allDocuments = useMemo(
    () =>
      store.commitments.flatMap((commitment) =>
        commitment.valuation.documents.map((document) => ({
          ...document,
          commitmentId: commitment.id,
          commitmentName: commitment.name,
        })),
      ),
    [store.commitments],
  );

  const activeCall =
    workflow?.kind === 'capital-call'
      ? (store.calls.find((call) => call.id === workflow.callId) ?? null)
      : null;
  const activeCallCommitment = activeCall
    ? (store.commitments.find((commitment) => commitment.id === activeCall.commitmentId) ?? null)
    : null;
  const activeValuationCommitment =
    workflow?.kind === 'valuation'
      ? (store.commitments.find((commitment) => commitment.id === workflow.commitmentId) ?? null)
      : null;

  function addReceipt(
    receipt: Omit<PrivateMarketReceipt, 'id' | 'at' | 'actor'>,
    audit: Omit<PrivateMarketAudit, 'id' | 'at' | 'actor' | 'receiptId'>,
  ) {
    const savedReceipt: PrivateMarketReceipt = {
      ...receipt,
      id: makeId('PMR'),
      at: nowLabel(),
      actor: 'You',
    };
    setStore((current) => ({
      ...current,
      receipts: [savedReceipt, ...current.receipts],
      audit: [
        {
          ...audit,
          id: makeId('audit'),
          at: savedReceipt.at,
          actor: 'You',
          receiptId: savedReceipt.id,
        },
        ...current.audit,
      ],
    }));
    setActiveReceipt(savedReceipt);
    return savedReceipt;
  }

  function openCreate() {
    setCreateDraft(emptyCreateDraft());
    setWorkflowStep(1);
    setWorkflow({ kind: 'create' });
  }

  function openCall(call: OriginPrivateMarketCall) {
    setCallDraft({
      source: 'Portfolio cash · EUR',
      amount: String(call.amount),
      dueDate: call.dueDate,
      reason: `Fund ${call.title} from available portfolio cash.`,
      acknowledged: false,
    });
    setWorkflowStep(1);
    setWorkflow({ kind: 'capital-call', callId: call.id });
  }

  function openValuation(commitment: OriginPrivateMarketCommitment) {
    setValuationDraft({
      amount: String(commitment.nav),
      asOf: today,
      source: '',
      method:
        commitment.kind === 'real-estate'
          ? 'Independent valuation'
          : commitment.kind === 'private-company'
            ? 'Last financing round'
            : 'Manager-reported NAV',
      evidence: '',
      reason: '',
      acknowledged: false,
    });
    setWorkflowStep(1);
    setWorkflow({ kind: 'valuation', commitmentId: commitment.id });
  }

  function createCommitment(event: FormEvent) {
    event.preventDefault();
    if (workflowStep < 3) {
      setWorkflowStep((step) => step + 1);
      return;
    }

    const committed = Number(createDraft.committed);
    const contributed = Number(createDraft.contributed);
    const nav = Number(createDraft.nav);
    const id = makeId('private');
    const created: OriginPrivateMarketCommitment = {
      id,
      name: createDraft.name.trim(),
      legalName: createDraft.legalName.trim() || createDraft.name.trim(),
      kind: createDraft.kind,
      strategy: createDraft.strategy.trim(),
      geography: createDraft.geography.trim(),
      vintage: Number(createDraft.vintage),
      status: contributed >= committed ? 'fully-funded' : 'active',
      currency: createDraft.currency,
      fxToPortfolio: Number(createDraft.fxToPortfolio) || 1,
      committed,
      contributed,
      distributed: 0,
      nav,
      ownership: Number(createDraft.ownership) || 0,
      manager: createDraft.manager.trim() || 'Direct holding',
      account: createDraft.account,
      valuation: {
        amount: nav,
        asOf: today,
        receivedAt: today,
        source: nav ? 'Opening balance supplied at creation' : 'Awaiting first valuation',
        method: nav ? 'Opening balance' : 'Not valued',
        confidence: 'estimated',
        freshnessDays: 0,
        documents: [
          {
            id: makeId('doc'),
            name: 'Commitment agreement',
            kind: 'agreement',
            state: 'missing',
            date: today,
            source: 'Awaiting upload',
          },
        ],
        lineage: [
          {
            label: 'Manual creation',
            detail: `${createDraft.name.trim()} added inside ${portfolio.name}`,
            at: nowLabel(),
            state: 'external',
          },
          {
            label: 'Evidence status',
            detail: 'Commitment agreement still needs to be linked',
            at: nowLabel(),
            state: 'warning',
          },
        ],
      },
    };

    setStore((current) => ({
      ...current,
      commitments: [...current.commitments, created],
    }));
    setSelectedId(id);
    setWorkflow(null);
    setView('commitments');
    addReceipt(
      {
        kind: 'commitment-created',
        title: `${created.name} created`,
        detail: `${money(created.committed, created.currency, privateMode)} commitment now belongs to ${portfolio.name}.`,
        objectId: created.id,
      },
      {
        action: 'Commitment created',
        detail: `${created.legalName} added with opening economics and an evidence request.`,
        object: created.name,
        tone: 'success',
      },
    );
    onToast(`${created.name} added to ${portfolio.name}.`);
  }

  function proposeCall(event: FormEvent) {
    event.preventDefault();
    if (!activeCall || !activeCallCommitment || !callDraft.acknowledged) return;
    const amount = Number(callDraft.amount);
    const currentUnfunded = Math.max(
      activeCallCommitment.committed - activeCallCommitment.contributed,
      0,
    );
    const translatedAmount = toPortfolioCurrency(
      amount,
      activeCall.currency,
      portfolioCurrency,
      activeCallCommitment.fxToPortfolio,
    );
    const reviewId = makeId('review_private_call');
    const entry: OriginReviewEntry = {
      id: reviewId,
      kind: 'automation',
      title: `Fund ${activeCallCommitment.name} · ${activeCall.title}`,
      summary: `${money(amount, activeCall.currency, privateMode)} will be transferred from ${callDraft.source} and recorded against the commitment only after approval.`,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        path: `${portfolio.name} / Private markets / ${activeCallCommitment.name}`,
      },
      source: {
        label: 'Private markets cash plan',
        detail: activeCall.sourceDocument,
        actor: 'You',
      },
      requestedAt: new Date().toISOString(),
      requestedBy: 'You',
      status: 'pending',
      priority: relativeDue(callDraft.dueDate).includes('overdue') ? 'urgent' : 'high',
      risk: 'medium',
      affectedCount: 3,
      tags: ['Capital call', activeCallCommitment.currency, activeCallCommitment.name],
      approveLabel: 'Approve funding',
      rejectLabel: 'Reject proposal',
      diff: [
        {
          label: callDraft.source,
          before: money(portfolioAvailableCash, portfolioCurrency, privateMode),
          after: money(portfolioAvailableCash - translatedAmount, portfolioCurrency, privateMode),
          tone: portfolioAvailableCash - translatedAmount < 0 ? 'negative' : 'neutral',
          detail: 'Portfolio cash truth changes only after approval.',
        },
        {
          label: 'Paid-in capital',
          before: money(
            activeCallCommitment.contributed,
            activeCallCommitment.currency,
            privateMode,
          ),
          after: money(
            activeCallCommitment.contributed + amount,
            activeCallCommitment.currency,
            privateMode,
          ),
          tone: 'positive',
        },
        {
          label: 'Unfunded commitment',
          before: money(currentUnfunded, activeCallCommitment.currency, privateMode),
          after: money(
            Math.max(currentUnfunded - amount, 0),
            activeCallCommitment.currency,
            privateMode,
          ),
          tone: 'positive',
        },
      ],
      calculations: [
        {
          label: 'Translated cash requirement',
          value: money(translatedAmount, portfolioCurrency, privateMode),
          detail: `${money(amount, activeCall.currency, privateMode)} × ${activeCallCommitment.fxToPortfolio.toFixed(3)} ${portfolioCurrency}/${activeCall.currency}`,
        },
        {
          label: 'Cash coverage after funding',
          value: multiple(
            Math.max(portfolioAvailableCash - translatedAmount, 0) /
              Math.max(callExposure - translatedAmount, 1),
          ),
          detail: 'Available cash divided by remaining scheduled and forecast calls.',
          tone: portfolioAvailableCash - translatedAmount < 0 ? 'negative' : 'positive',
        },
      ],
      lineage: [
        {
          label: 'Manager notice',
          detail: `${activeCall.sourceDocument} · issued ${dateLabel(activeCall.noticeDate)}`,
          at: activeCall.noticeDate,
          state: activeCall.confidence === 'confirmed' ? 'verified' : 'external',
        },
        {
          label: 'Commitment ledger',
          detail: `${money(currentUnfunded, activeCallCommitment.currency, privateMode)} currently unfunded`,
          at: nowLabel(),
          state: 'derived',
        },
        {
          label: 'User instruction',
          detail: callDraft.reason,
          at: nowLabel(),
          state: 'external',
        },
      ],
      permissions: [
        {
          label: 'Read commitment and source notice',
          detail: activeCallCommitment.name,
          outcome: 'allowed',
        },
        {
          label: 'Write cash activity and paid-in capital',
          detail: 'Requires explicit portfolio approval',
          outcome: 'review',
        },
      ],
      policies: [
        {
          title: 'Call does not exceed unfunded commitment',
          description: `${money(amount, activeCall.currency, privateMode)} proposed against ${money(currentUnfunded, activeCall.currency, privateMode)} unfunded.`,
          status: amount <= currentUnfunded ? 'pass' : 'blocked',
        },
        {
          title: 'Portfolio cash coverage',
          description: `${money(portfolioAvailableCash, portfolioCurrency, privateMode)} is currently available.`,
          status: translatedAmount <= portfolioAvailableCash ? 'pass' : 'warning',
        },
        {
          title: 'Evidence linked',
          description: activeCall.sourceDocument,
          status: activeCall.confidence === 'confirmed' ? 'pass' : 'warning',
        },
      ],
    };

    onSubmitReview(entry);
    setStore((current) => ({
      ...current,
      calls: current.calls.map((call) =>
        call.id === activeCall.id ? { ...call, status: 'in-review' } : call,
      ),
      pendingActions: {
        ...(current.pendingActions ?? {}),
        [reviewId]: {
          kind: 'capital-call',
          callId: activeCall.id,
          commitmentId: activeCallCommitment.id,
          amount,
          translatedAmount,
        },
      },
    }));
    setWorkflow(null);
    const receipt = addReceipt(
      {
        kind: 'capital-call-proposed',
        title: 'Capital call sent to Review',
        detail: `${activeCallCommitment.name} remains unchanged until proposal approval.`,
        objectId: activeCall.id,
        reviewId,
      },
      {
        action: 'Capital-call proposal created',
        detail: `${money(amount, activeCall.currency, privateMode)} from ${callDraft.source}; no portfolio truth changed.`,
        object: activeCall.title,
        tone: 'attention',
      },
    );
    onToast(`${activeCall.title} is waiting in Review.`);
    setActiveReceipt(receipt);
  }

  function proposeValuation(event: FormEvent) {
    event.preventDefault();
    if (!activeValuationCommitment || !valuationDraft.acknowledged) return;
    const nextAmount = Number(valuationDraft.amount);
    const oldMetrics = performance(activeValuationCommitment);
    const nextTvpi =
      (nextAmount + activeValuationCommitment.distributed) /
      Math.max(activeValuationCommitment.contributed, 1);
    const reviewId = makeId('review_private_valuation');
    const entry: OriginReviewEntry = {
      id: reviewId,
      kind: 'import',
      title: `Update ${activeValuationCommitment.name} valuation`,
      summary: `${valuationDraft.source || 'A new source'} proposes a ${money(nextAmount - activeValuationCommitment.nav, activeValuationCommitment.currency, privateMode)} NAV change. The current reported value remains intact until approval.`,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        path: `${portfolio.name} / Private markets / ${activeValuationCommitment.name}`,
      },
      source: {
        label: valuationDraft.source || 'Manual valuation proposal',
        detail: valuationDraft.evidence || 'No document selected',
        actor: 'You',
      },
      requestedAt: new Date().toISOString(),
      requestedBy: 'You',
      status: 'pending',
      priority: activeValuationCommitment.valuation.freshnessDays > 90 ? 'high' : 'normal',
      risk: valuationDraft.evidence ? 'low' : 'medium',
      affectedCount: 2,
      tags: ['Valuation', activeValuationCommitment.currency, valuationDraft.method],
      approveLabel: 'Approve valuation',
      rejectLabel: 'Keep current NAV',
      diff: [
        {
          label: 'Reported NAV',
          before: money(
            activeValuationCommitment.nav,
            activeValuationCommitment.currency,
            privateMode,
          ),
          after: money(nextAmount, activeValuationCommitment.currency, privateMode),
          tone: nextAmount >= activeValuationCommitment.nav ? 'positive' : 'negative',
          detail: `Effective ${dateLabel(valuationDraft.asOf)} · ${valuationDraft.method}`,
        },
        {
          label: 'Valuation source',
          before: activeValuationCommitment.valuation.source,
          after: valuationDraft.source || 'Manual valuation proposal',
          tone: 'neutral',
        },
      ],
      calculations: [
        {
          label: 'TVPI',
          value: multiple(nextTvpi),
          detail: `Previously ${multiple(oldMetrics.tvpi)}`,
          tone: nextTvpi >= oldMetrics.tvpi ? 'positive' : 'negative',
        },
        {
          label: `Impact in ${portfolioCurrency}`,
          value: money(
            toPortfolioCurrency(
              nextAmount - activeValuationCommitment.nav,
              activeValuationCommitment.currency,
              portfolioCurrency,
              activeValuationCommitment.fxToPortfolio,
            ),
            portfolioCurrency,
            privateMode,
          ),
          detail: `Translated at ${activeValuationCommitment.fxToPortfolio.toFixed(3)} ${portfolioCurrency}/${activeValuationCommitment.currency}`,
        },
      ],
      lineage: [
        {
          label: 'Current portfolio truth',
          detail: `${activeValuationCommitment.valuation.source} · ${dateLabel(activeValuationCommitment.valuation.asOf)}`,
          at: activeValuationCommitment.valuation.receivedAt,
          state: 'verified',
        },
        {
          label: 'Proposed evidence',
          detail: valuationDraft.evidence || 'No supporting document attached',
          at: valuationDraft.asOf,
          state: valuationDraft.evidence ? 'external' : 'warning',
        },
        {
          label: 'Valuation rationale',
          detail: valuationDraft.reason,
          at: nowLabel(),
          state: 'derived',
        },
      ],
      permissions: [
        {
          label: 'Read existing private-asset valuation',
          detail: activeValuationCommitment.name,
          outcome: 'allowed',
        },
        {
          label: 'Replace portfolio NAV and source lineage',
          detail: 'Requires explicit approval',
          outcome: 'review',
        },
      ],
      policies: [
        {
          title: 'Valuation date is not in the future',
          description: dateLabel(valuationDraft.asOf),
          status: valuationDraft.asOf <= today ? 'pass' : 'blocked',
        },
        {
          title: 'Supporting evidence',
          description:
            valuationDraft.evidence || 'Attach a statement, appraisal, or round document.',
          status: valuationDraft.evidence ? 'pass' : 'warning',
        },
        {
          title: 'Method disclosed',
          description: valuationDraft.method,
          status: valuationDraft.method ? 'pass' : 'blocked',
        },
      ],
    };

    onSubmitReview(entry);
    setStore((current) => ({
      ...current,
      commitments: current.commitments.map((commitment) =>
        commitment.id === activeValuationCommitment.id
          ? {
              ...commitment,
              valuation: { ...commitment.valuation, proposalStatus: 'in-review' },
            }
          : commitment,
      ),
      pendingActions: {
        ...(current.pendingActions ?? {}),
        [reviewId]: {
          kind: 'valuation',
          commitmentId: activeValuationCommitment.id,
          amount: nextAmount,
          asOf: valuationDraft.asOf,
          source: valuationDraft.source || 'Manual valuation proposal',
          method: valuationDraft.method,
          evidence: valuationDraft.evidence,
        },
      },
    }));
    setWorkflow(null);
    const receipt = addReceipt(
      {
        kind: 'valuation-proposed',
        title: 'Valuation sent to Review',
        detail: `${activeValuationCommitment.name} keeps its current NAV until approval.`,
        objectId: activeValuationCommitment.id,
        reviewId,
      },
      {
        action: 'Valuation proposal created',
        detail: `${money(nextAmount, activeValuationCommitment.currency, privateMode)} as of ${dateLabel(valuationDraft.asOf)}; no portfolio truth changed.`,
        object: activeValuationCommitment.name,
        tone: 'attention',
      },
    );
    onToast(`${activeValuationCommitment.name} valuation is waiting in Review.`);
    setActiveReceipt(receipt);
  }

  function handleTabKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const current = buttons.findIndex((button) => button === document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
    if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    buttons[next]?.focus();
    buttons[next]?.click();
  }

  function selectCommitment(id: string, nextView: WorkspaceView = 'commitments') {
    setSelectedId(id);
    setView(nextView);
  }

  return (
    <section
      ref={rootDialogRef}
      className="origin-private-markets"
      role="dialog"
      aria-modal="true"
      aria-labelledby="opm-title"
      tabIndex={-1}
      data-accessible-dialog-layer
      data-testid="origin-private-markets"
    >
      <header className="opm-global-header">
        <div className="opm-brand" aria-label="BetterTrack Origin">
          <span className="opm-brand__mark" aria-hidden="true" />
          <span>
            <strong>
              Better<span>Track</span>
            </strong>
            <small>Origin</small>
          </span>
        </div>
        <nav className="opm-breadcrumb" aria-label="Breadcrumb">
          <button type="button" onClick={onClose}>
            {portfolio.name}
          </button>
          <Icon name="chevron-right" size={12} />
          <strong>Private markets</strong>
        </nav>
        <div className="opm-global-actions">
          <span className="opm-saved">
            <i aria-hidden="true" />
            Saved locally
          </span>
          <button type="button" aria-label="Close private markets" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <main className="opm-page">
        <div className="opm-page-heading">
          <div>
            <span className="opm-kicker">Portfolio workspace · alternative assets</span>
            <h1 id="opm-title">Private markets</h1>
            <p>
              Commitments, capital activity, valuations, and their evidence—kept inside{' '}
              <strong>{portfolio.name}</strong> as one connected portfolio truth.
            </p>
          </div>
          <div className="opm-page-heading__actions">
            <button className="opm-button opm-button--ghost" type="button" onClick={onOpenFiles}>
              <Icon name="folder" size={14} />
              Portfolio files
            </button>
            <button
              className="opm-button opm-button--primary"
              type="button"
              onClick={openCreate}
              data-opm-initial-focus
              data-testid="private-markets-add"
            >
              <Icon name="plus" size={14} />
              Add commitment
            </button>
          </div>
        </div>

        <div
          className="opm-tabs"
          role="tablist"
          aria-label="Private markets views"
          onKeyDown={handleTabKeys}
        >
          {views.map((item) => (
            <button
              aria-controls={`opm-panel-${item.id}`}
              aria-selected={view === item.id}
              id={`opm-tab-${item.id}`}
              key={item.id}
              role="tab"
              tabIndex={view === item.id ? 0 : -1}
              type="button"
              className={cx(view === item.id && 'is-active')}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} size={13} />
              {item.label}
              {item.id === 'cash-plan' && upcomingCalls.length > 0 && (
                <span>{upcomingCalls.length}</span>
              )}
              {item.id === 'evidence' && staleCount > 0 && <span>{staleCount}</span>}
            </button>
          ))}
        </div>

        {view === 'overview' && (
          <div
            aria-labelledby="opm-tab-overview"
            className="opm-view"
            id="opm-panel-overview"
            role="tabpanel"
          >
            <section className="opm-summary-strip" aria-label="Private market totals">
              <Metric
                label="Reported NAV"
                value={money(totals.nav, portfolioCurrency, privateMode)}
                helper={`${store.commitments.length} portfolio positions`}
                tone="positive"
              />
              <Metric
                label="Committed"
                value={money(totals.committed, portfolioCurrency, privateMode)}
                helper={`${percent((totals.contributed / totals.committed) * 100)} called`}
              />
              <Metric
                label="Unfunded"
                value={money(totals.unfunded, portfolioCurrency, privateMode)}
                helper={`${money(callExposure, portfolioCurrency, privateMode)} currently planned`}
                tone={cashCoverage < 1.25 ? 'attention' : undefined}
              />
              <Metric
                label="Net distributions"
                value={money(totals.distributed, portfolioCurrency, privateMode)}
                helper={`DPI ${multiple(aggregate.dpi)}`}
              />
            </section>

            <div className="opm-overview-grid">
              <section className="opm-main-section">
                <div className="opm-section-heading">
                  <div>
                    <h2>Commitment map</h2>
                  </div>
                  <button
                    type="button"
                    className="opm-text-button"
                    onClick={() => setView('commitments')}
                  >
                    View all
                    <Icon name="arrow-right" size={13} />
                  </button>
                </div>
                <div className="opm-exposure-list">
                  {store.commitments.map((commitment) => {
                    const paidRatio = Math.min(
                      (commitment.contributed / commitment.committed) * 100,
                      100,
                    );
                    const convertedNav = toPortfolioCurrency(
                      commitment.nav,
                      commitment.currency,
                      portfolioCurrency,
                      commitment.fxToPortfolio,
                    );
                    return (
                      <button
                        aria-label={`${commitment.name}; committed ${money(
                          commitment.committed,
                          commitment.currency,
                          privateMode,
                        )}; paid ${money(
                          commitment.contributed,
                          commitment.currency,
                          privateMode,
                        )}; unfunded ${money(
                          Math.max(commitment.committed - commitment.contributed, 0),
                          commitment.currency,
                          privateMode,
                        )}; NAV ${money(
                          commitment.nav,
                          commitment.currency,
                          privateMode,
                        )}; TVPI ${multiple(performance(commitment).tvpi)}`}
                        aria-pressed={selected?.id === commitment.id}
                        type="button"
                        key={commitment.id}
                        className="opm-exposure-row"
                        onClick={() => selectCommitment(commitment.id)}
                      >
                        <span className={`opm-kind-icon opm-kind-icon--${commitment.kind}`}>
                          <Icon name={kindMeta[commitment.kind].icon} size={15} />
                        </span>
                        <span className="opm-exposure-row__identity">
                          <strong>{commitment.name}</strong>
                          <small>
                            {kindMeta[commitment.kind].short} · {commitment.strategy}
                          </small>
                        </span>
                        <span className="opm-exposure-row__bar" aria-hidden="true">
                          <i style={{ width: `${paidRatio}%` }} />
                        </span>
                        <span className="opm-exposure-row__paid">
                          <strong>{percent(paidRatio)}</strong>
                          <small>called</small>
                        </span>
                        <span className="opm-exposure-row__value">
                          <strong>{money(convertedNav, portfolioCurrency, privateMode)}</strong>
                          <small>
                            NAV · {commitment.currency}
                            {commitment.currency === portfolioCurrency
                              ? ''
                              : ` @ ${commitment.fxToPortfolio.toFixed(3)}`}
                          </small>
                        </span>
                        <Icon name="chevron-right" size={14} />
                      </button>
                    );
                  })}
                </div>
              </section>

              <aside className="opm-side-rail">
                <section className="opm-cash-coverage">
                  <div className="opm-section-heading opm-section-heading--compact">
                    <div>
                      <h2>Cash coverage</h2>
                    </div>
                    <span className={cx('opm-coverage-badge', cashCoverage < 1.25 && 'is-warning')}>
                      {multiple(cashCoverage)}
                    </span>
                  </div>
                  <div className="opm-coverage-visual" aria-hidden="true">
                    <span>
                      <i
                        style={{
                          width: `${Math.min(
                            (callExposure / Math.max(portfolioAvailableCash, 1)) * 100,
                            100,
                          )}%`,
                        }}
                      />
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>Available portfolio cash</dt>
                      <dd>{money(portfolioAvailableCash, portfolioCurrency, privateMode)}</dd>
                    </div>
                    <div>
                      <dt>Scheduled + forecast calls</dt>
                      <dd>{money(callExposure, portfolioCurrency, privateMode)}</dd>
                    </div>
                    <div>
                      <dt>Remaining buffer</dt>
                      <dd>
                        {money(
                          portfolioAvailableCash - callExposure,
                          portfolioCurrency,
                          privateMode,
                        )}
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="opm-button opm-button--quiet"
                    type="button"
                    onClick={() => setView('cash-plan')}
                  >
                    Inspect cash plan
                    <Icon name="arrow-right" size={13} />
                  </button>
                </section>

                <section className="opm-performance">
                  <span className="opm-object-label">Since inception</span>
                  <div className="opm-performance__grid">
                    <div>
                      <span>IRR</span>
                      <strong>{percent(aggregate.irr)}</strong>
                    </div>
                    <div>
                      <span>TVPI</span>
                      <strong>{multiple(aggregate.tvpi)}</strong>
                    </div>
                    <div>
                      <span>DPI</span>
                      <strong>{multiple(aggregate.dpi)}</strong>
                    </div>
                  </div>
                  <p>Performance uses dated cash flows and the latest approved reported NAV.</p>
                </section>
              </aside>
            </div>

            <section className="opm-next-calls">
              <div className="opm-section-heading">
                <div>
                  <h2>Upcoming funding</h2>
                </div>
                <button
                  type="button"
                  className="opm-text-button"
                  onClick={() => setView('cash-plan')}
                >
                  Full schedule
                  <Icon name="arrow-right" size={13} />
                </button>
              </div>
              <div className="opm-call-grid">
                {upcomingCalls.slice(0, 3).map((call) => {
                  const commitment = store.commitments.find(
                    (item) => item.id === call.commitmentId,
                  );
                  if (!commitment) return null;
                  return (
                    <article key={call.id} className="opm-call-card">
                      <div>
                        <StatusPill status={call.status} />
                        <span className="opm-call-card__due">{relativeDue(call.dueDate)}</span>
                      </div>
                      <h3>{commitment.name}</h3>
                      <p>{call.title}</p>
                      <strong>{money(call.amount, call.currency, privateMode)}</strong>
                      <small>
                        Due {dateLabel(call.dueDate)} · {call.confidence.replaceAll('-', ' ')}
                      </small>
                      <button
                        type="button"
                        className="opm-button opm-button--quiet"
                        onClick={() => openCall(call)}
                        disabled={call.status === 'in-review'}
                      >
                        {call.status === 'in-review' ? 'Waiting in Review' : 'Prepare funding'}
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {view === 'commitments' && (
          <div
            aria-labelledby="opm-tab-commitments"
            className="opm-view opm-view--commitments"
            id="opm-panel-commitments"
            role="tabpanel"
          >
            <div className="opm-list-toolbar">
              <div className="opm-search">
                <Icon name="search" size={14} />
                <label htmlFor="opm-search" className="opm-sr-only">
                  Search commitments
                </label>
                <input
                  id="opm-search"
                  type="search"
                  placeholder="Search commitment, manager, or strategy"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div className="opm-filter-group" aria-label="Filter by asset type">
                {(['all', 'fund', 'private-company', 'real-estate'] as KindFilter[]).map(
                  (filter) => (
                    <button
                      type="button"
                      key={filter}
                      aria-pressed={kindFilter === filter}
                      onClick={() => setKindFilter(filter)}
                    >
                      {filter === 'all' ? 'All' : kindMeta[filter].short}
                    </button>
                  ),
                )}
              </div>
            </div>

            <div className="opm-commitments-layout">
              <section className="opm-commitment-table" aria-label="Private market commitments">
                <div className="opm-table-head" aria-hidden="true">
                  <span>Position</span>
                  <span>Committed / paid</span>
                  <span>Unfunded</span>
                  <span>NAV</span>
                  <span>TVPI</span>
                </div>
                {visibleCommitments.length === 0 ? (
                  <div className="opm-empty">
                    <Icon name="search" size={19} />
                    <h3>No commitments found</h3>
                    <p>Try another name or remove the current type filter.</p>
                  </div>
                ) : (
                  visibleCommitments.map((commitment) => {
                    const metrics = performance(commitment);
                    return (
                      <button
                        aria-label={`${commitment.name}; committed ${money(
                          commitment.committed,
                          commitment.currency,
                          privateMode,
                        )}; paid ${money(
                          commitment.contributed,
                          commitment.currency,
                          privateMode,
                        )}; unfunded ${money(
                          Math.max(commitment.committed - commitment.contributed, 0),
                          commitment.currency,
                          privateMode,
                        )}; NAV ${money(
                          commitment.nav,
                          commitment.currency,
                          privateMode,
                        )}; TVPI ${multiple(metrics.tvpi)}`}
                        aria-pressed={selected?.id === commitment.id}
                        type="button"
                        key={commitment.id}
                        className={cx(
                          'opm-table-row',
                          selected?.id === commitment.id && 'is-selected',
                        )}
                        onClick={() => setSelectedId(commitment.id)}
                      >
                        <span className="opm-table-row__identity">
                          <i className={`opm-kind-icon opm-kind-icon--${commitment.kind}`}>
                            <Icon name={kindMeta[commitment.kind].icon} size={14} />
                          </i>
                          <span>
                            <strong>{commitment.name}</strong>
                            <small>
                              {commitment.manager} · {commitment.vintage}
                            </small>
                          </span>
                        </span>
                        <span>
                          <strong>
                            {money(commitment.committed, commitment.currency, privateMode)}
                          </strong>
                          <small>
                            {money(commitment.contributed, commitment.currency, privateMode)} paid
                          </small>
                        </span>
                        <span>
                          <strong>
                            {money(
                              Math.max(commitment.committed - commitment.contributed, 0),
                              commitment.currency,
                              privateMode,
                            )}
                          </strong>
                          <small>
                            {percent((commitment.contributed / commitment.committed) * 100)} called
                          </small>
                        </span>
                        <span>
                          <strong>{money(commitment.nav, commitment.currency, privateMode)}</strong>
                          <small>{dateLabel(commitment.valuation.asOf)}</small>
                        </span>
                        <span>
                          <strong>{multiple(metrics.tvpi)}</strong>
                          <small>IRR {percent(metrics.irr)}</small>
                        </span>
                      </button>
                    );
                  })
                )}
              </section>

              {selected && (
                <aside className="opm-detail-panel">
                  <div className="opm-detail-panel__heading">
                    <div>
                      <span className="opm-object-label">{kindMeta[selected.kind].label}</span>
                      <h2>{selected.name}</h2>
                      <p>{selected.legalName}</p>
                    </div>
                    <StatusPill status={selected.status} />
                  </div>
                  <MiniNavChart commitment={selected} privateMode={privateMode} />
                  <div className="opm-detail-metrics">
                    <div>
                      <span>IRR</span>
                      <strong>{percent(performance(selected).irr)}</strong>
                    </div>
                    <div>
                      <span>TVPI</span>
                      <strong>{multiple(performance(selected).tvpi)}</strong>
                    </div>
                    <div>
                      <span>DPI</span>
                      <strong>{multiple(performance(selected).dpi)}</strong>
                    </div>
                    <div>
                      <span>RVPI</span>
                      <strong>{multiple(performance(selected).rvpi)}</strong>
                    </div>
                  </div>
                  <dl className="opm-definition-list">
                    <div>
                      <dt>Strategy</dt>
                      <dd>{selected.strategy}</dd>
                    </div>
                    <div>
                      <dt>Geography</dt>
                      <dd>{selected.geography}</dd>
                    </div>
                    <div>
                      <dt>Ownership</dt>
                      <dd>{percent(selected.ownership)}</dd>
                    </div>
                    <div>
                      <dt>Portfolio account</dt>
                      <dd>{selected.account}</dd>
                    </div>
                    <div>
                      <dt>FX translation</dt>
                      <dd>
                        {selected.currency === portfolioCurrency
                          ? 'Native portfolio currency'
                          : `1 ${selected.currency} = ${selected.fxToPortfolio.toFixed(3)} ${portfolioCurrency}`}
                      </dd>
                    </div>
                  </dl>
                  <div className="opm-detail-panel__actions">
                    <button
                      type="button"
                      className="opm-button opm-button--primary"
                      onClick={() => openValuation(selected)}
                    >
                      <Icon name="refresh" size={13} />
                      Propose valuation
                    </button>
                    <button
                      type="button"
                      className="opm-button opm-button--ghost"
                      onClick={() => {
                        setSelectedId(selected.id);
                        setView('evidence');
                      }}
                    >
                      <Icon name="document" size={13} />
                      Evidence
                    </button>
                  </div>
                </aside>
              )}
            </div>
          </div>
        )}

        {view === 'cash-plan' && (
          <div
            aria-labelledby="opm-tab-cash-plan"
            className="opm-view"
            id="opm-panel-cash-plan"
            role="tabpanel"
          >
            <div className="opm-cash-heading">
              <div>
                <span className="opm-object-label">Portfolio liquidity</span>
                <h2>Capital-call coverage</h2>
                <p>
                  Plan funding without pretending forecasts are transactions. Only approved
                  proposals alter portfolio cash and paid-in capital.
                </p>
              </div>
              <button
                className="opm-button opm-button--ghost"
                type="button"
                onClick={onOpenCashFlow}
              >
                <Icon name="cash" size={14} />
                Portfolio cash flow
              </button>
            </div>

            <section className="opm-cash-strip">
              <Metric
                label="Available cash"
                value={money(portfolioAvailableCash, portfolioCurrency, privateMode)}
                helper="Across eligible portfolio cash accounts"
                tone="positive"
              />
              <Metric
                label="Known + forecast calls"
                value={money(callExposure, portfolioCurrency, privateMode)}
                helper={`${upcomingCalls.length} items through October`}
              />
              <Metric
                label="Coverage"
                value={multiple(cashCoverage)}
                helper={
                  cashCoverage >= 1.25 ? 'Above 1.25× policy floor' : 'Below 1.25× policy floor'
                }
                tone={cashCoverage < 1.25 ? 'attention' : 'positive'}
              />
            </section>

            <section className="opm-cash-timeline">
              <div className="opm-timeline-axis" aria-hidden="true">
                <span>Now</span>
                <i />
                <span>Aug</span>
                <i />
                <span>Sep</span>
                <i />
                <span>Oct</span>
              </div>
              {upcomingCalls.map((call) => {
                const commitment = store.commitments.find((item) => item.id === call.commitmentId);
                if (!commitment) return null;
                const unfunded = Math.max(commitment.committed - commitment.contributed, 0);
                return (
                  <article
                    key={call.id}
                    className="opm-call-row"
                    data-testid={`private-call-${call.id}`}
                  >
                    <div className="opm-call-row__date">
                      <strong>{dateLabel(call.dueDate).split(' ').slice(0, 2).join(' ')}</strong>
                      <small>{relativeDue(call.dueDate)}</small>
                    </div>
                    <div className="opm-call-row__body">
                      <div>
                        <span className="opm-object-label">{call.title}</span>
                        <h3>{commitment.name}</h3>
                        <p>{call.purpose}</p>
                      </div>
                      <div className="opm-call-row__amount">
                        <strong>{money(call.amount, call.currency, privateMode)}</strong>
                        <small>of {money(unfunded, call.currency, privateMode)} unfunded</small>
                      </div>
                    </div>
                    <div className="opm-call-row__evidence">
                      <StatusPill status={call.status} />
                      <span>
                        <Icon name="document" size={12} />
                        {call.sourceDocument}
                      </span>
                      <small>{call.confidence.replaceAll('-', ' ')}</small>
                    </div>
                    <button
                      type="button"
                      className="opm-button opm-button--quiet"
                      onClick={() => openCall(call)}
                      disabled={call.status === 'in-review'}
                    >
                      {call.status === 'in-review' ? (
                        <>
                          <Icon name="inbox" size={13} />
                          In Review
                        </>
                      ) : (
                        <>
                          Prepare funding
                          <Icon name="arrow-right" size={13} />
                        </>
                      )}
                    </button>
                  </article>
                );
              })}
            </section>
            <div className="opm-policy-note">
              <Icon name="shield" size={15} />
              <div>
                <strong>Cash coverage policy</strong>
                <p>
                  Keep at least 1.25× of confirmed and 90-day forecast capital calls in eligible
                  portfolio cash. Forecasts remain planning data until a notice is verified.
                </p>
              </div>
            </div>
          </div>
        )}

        {view === 'evidence' && (
          <div
            aria-labelledby="opm-tab-evidence"
            className="opm-view"
            id="opm-panel-evidence"
            role="tabpanel"
          >
            <div className="opm-evidence-layout">
              <section className="opm-evidence-list">
                <div className="opm-section-heading">
                  <div>
                    <span className="opm-object-label">Valuation control</span>
                    <h2>Freshness & evidence</h2>
                    <p>
                      Every reported value retains its source, method, document, and calculation
                      path.
                    </p>
                  </div>
                  <button
                    className="opm-button opm-button--ghost"
                    type="button"
                    onClick={onOpenFiles}
                  >
                    <Icon name="folder" size={13} />
                    Open all files
                  </button>
                </div>
                {store.commitments.map((commitment) => {
                  const isStale = commitment.valuation.freshnessDays > 90;
                  const missing = commitment.valuation.documents.filter(
                    (document) => document.state === 'missing',
                  ).length;
                  return (
                    <button
                      type="button"
                      key={commitment.id}
                      className={cx(
                        'opm-evidence-row',
                        selected?.id === commitment.id && 'is-selected',
                      )}
                      onClick={() => setSelectedId(commitment.id)}
                      aria-pressed={selected?.id === commitment.id}
                    >
                      <span
                        className={`opm-evidence-health ${isStale ? 'is-stale' : 'is-current'}`}
                      >
                        <Icon name={isStale ? 'clock' : 'check'} size={14} />
                      </span>
                      <span className="opm-evidence-row__identity">
                        <strong>{commitment.name}</strong>
                        <small>{commitment.valuation.source}</small>
                      </span>
                      <span>
                        <strong>{dateLabel(commitment.valuation.asOf)}</strong>
                        <small>
                          {commitment.valuation.freshnessDays} days old ·{' '}
                          {commitment.valuation.method}
                        </small>
                      </span>
                      <span>
                        <strong>
                          {commitment.valuation.documents.length - missing}/
                          {commitment.valuation.documents.length} linked
                        </strong>
                        <small>{missing ? `${missing} expected` : 'Evidence complete'}</small>
                      </span>
                      {commitment.valuation.proposalStatus ? (
                        <StatusPill status="in-review" />
                      ) : (
                        <StatusPill status={commitment.valuation.confidence} />
                      )}
                    </button>
                  );
                })}
              </section>

              {selected && (
                <aside className="opm-lineage-panel">
                  <div className="opm-lineage-panel__heading">
                    <span className="opm-object-label">Selected valuation</span>
                    <h2>{selected.name}</h2>
                    <strong>{money(selected.nav, selected.currency, privateMode)}</strong>
                    <small>as of {dateLabel(selected.valuation.asOf)}</small>
                  </div>
                  <div className="opm-freshness-meter">
                    <div>
                      <span>Freshness</span>
                      <strong>{selected.valuation.freshnessDays} days</strong>
                    </div>
                    <span aria-hidden="true">
                      <i
                        className={cx(selected.valuation.freshnessDays > 90 && 'is-stale')}
                        style={{
                          width: `${Math.min((selected.valuation.freshnessDays / 120) * 100, 100)}%`,
                        }}
                      />
                    </span>
                    <small>Portfolio threshold · 90 days</small>
                  </div>
                  <div className="opm-lineage">
                    <h3>Source lineage</h3>
                    {selected.valuation.lineage.map((step) => (
                      <div
                        key={`${step.label}-${step.at}`}
                        className={`opm-lineage__step is-${step.state}`}
                      >
                        <i aria-hidden="true" />
                        <div>
                          <strong>{step.label}</strong>
                          <p>{step.detail}</p>
                          <small>{step.at}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="opm-documents">
                    <h3>Linked documents</h3>
                    {selected.valuation.documents.map((document) => (
                      <button type="button" key={document.id} onClick={onOpenFiles}>
                        <Icon name={document.state === 'missing' ? 'plus' : 'document'} size={14} />
                        <span>
                          <strong>{document.name}</strong>
                          <small>
                            {document.source} · {dateLabel(document.date)}
                          </small>
                        </span>
                        <em className={`is-${document.state}`}>{document.state}</em>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="opm-button opm-button--primary"
                    onClick={() => openValuation(selected)}
                    disabled={selected.valuation.proposalStatus === 'in-review'}
                  >
                    <Icon name="refresh" size={13} />
                    {selected.valuation.proposalStatus === 'in-review'
                      ? 'Valuation in Review'
                      : 'Propose new valuation'}
                  </button>
                </aside>
              )}
            </div>
          </div>
        )}

        {view === 'audit' && (
          <div
            aria-labelledby="opm-tab-audit"
            className="opm-view"
            id="opm-panel-audit"
            role="tabpanel"
          >
            <div className="opm-audit-heading">
              <div>
                <span className="opm-object-label">Evidence-grade history</span>
                <h2>Private-market audit</h2>
                <p>
                  Created records and proposals persist locally with actor, time, object, and
                  receipt.
                </p>
              </div>
              <button type="button" className="opm-button opm-button--ghost" onClick={onOpenReview}>
                <Icon name="inbox" size={13} />
                Open Review
              </button>
            </div>
            <section className="opm-audit-log">
              {store.audit.map((item) => (
                <article key={item.id} className={`opm-audit-item opm-audit-item--${item.tone}`}>
                  <span className="opm-audit-item__rail" aria-hidden="true">
                    <i />
                  </span>
                  <div className="opm-audit-item__main">
                    <span>{item.at}</span>
                    <h3>{item.action}</h3>
                    <p>{item.detail}</p>
                    <small>
                      {item.actor} · {item.object}
                    </small>
                  </div>
                  {item.receiptId && (
                    <button
                      type="button"
                      onClick={() => {
                        const receipt = store.receipts.find(
                          (candidate) => candidate.id === item.receiptId,
                        );
                        if (receipt) setActiveReceipt(receipt);
                      }}
                    >
                      {item.receiptId}
                      <Icon name="arrow-right" size={12} />
                    </button>
                  )}
                </article>
              ))}
            </section>
          </div>
        )}
      </main>

      {workflow && (
        <div className="opm-modal-layer" data-accessible-dialog-layer>
          <div className="opm-modal-scrim" aria-hidden="true" onClick={() => setWorkflow(null)} />
          <div
            ref={workflowDialogRef}
            className={cx('opm-workflow', workflow.kind === 'create' && 'opm-workflow--wide')}
            role="dialog"
            aria-modal="true"
            aria-labelledby="opm-workflow-title"
            tabIndex={-1}
            data-testid={`private-markets-${workflow.kind}-dialog`}
          >
            <header className="opm-workflow__header">
              <div>
                <span className="opm-object-label">
                  {workflow.kind === 'create' ? `Step ${workflowStep} of 3` : 'Proposal preview'}
                </span>
                <h2
                  id="opm-workflow-title"
                  ref={stepHeadingRef}
                  tabIndex={-1}
                  data-opm-workflow-focus
                >
                  {workflow.kind === 'create'
                    ? workflowStep === 1
                      ? 'Identify the commitment'
                      : workflowStep === 2
                        ? 'Opening economics'
                        : 'Review portfolio record'
                    : workflow.kind === 'capital-call'
                      ? 'Prepare capital-call funding'
                      : 'Propose a new valuation'}
                </h2>
              </div>
              <button type="button" aria-label="Close workflow" onClick={() => setWorkflow(null)}>
                <Icon name="x" size={16} />
              </button>
            </header>

            {workflow.kind === 'create' && (
              <form className="opm-workflow__body" onSubmit={createCommitment}>
                <div className="opm-stepper" aria-label={`Step ${workflowStep} of 3`}>
                  {[1, 2, 3].map((step) => (
                    <span key={step} className={cx(step <= workflowStep && 'is-active')}>
                      <i />
                      {step === 1 ? 'Identity' : step === 2 ? 'Economics' : 'Review'}
                    </span>
                  ))}
                </div>

                {workflowStep === 1 && (
                  <div className="opm-form-grid">
                    <label className="opm-field opm-field--full">
                      <span>Display name</span>
                      <input
                        required
                        value={createDraft.name}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({ ...draft, name: event.target.value }))
                        }
                        placeholder="e.g. Northwind Ventures II"
                      />
                    </label>
                    <label className="opm-field opm-field--full">
                      <span>Legal entity name</span>
                      <input
                        value={createDraft.legalName}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            legalName: event.target.value,
                          }))
                        }
                        placeholder="Limited partnership, company, or property entity"
                      />
                    </label>
                    <fieldset className="opm-choice-grid opm-field--full">
                      <legend>Asset type</legend>
                      {(Object.keys(kindMeta) as OriginPrivateMarketKind[]).map((kind) => (
                        <label
                          key={kind}
                          className={cx(createDraft.kind === kind && 'is-selected')}
                        >
                          <input
                            type="radio"
                            name="kind"
                            value={kind}
                            checked={createDraft.kind === kind}
                            onChange={() => setCreateDraft((draft) => ({ ...draft, kind }))}
                          />
                          <Icon name={kindMeta[kind].icon} size={16} />
                          <span>
                            <strong>{kindMeta[kind].label}</strong>
                            <small>{kindMeta[kind].description}</small>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    <label className="opm-field">
                      <span>Strategy</span>
                      <input
                        required
                        value={createDraft.strategy}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            strategy: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="opm-field">
                      <span>Geography</span>
                      <input
                        required
                        value={createDraft.geography}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            geography: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="opm-field">
                      <span>Vintage year</span>
                      <input
                        type="number"
                        min="1900"
                        max="2100"
                        required
                        value={createDraft.vintage}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            vintage: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="opm-field">
                      <span>Manager / operator</span>
                      <input
                        value={createDraft.manager}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            manager: event.target.value,
                          }))
                        }
                        placeholder="Direct holding if self-managed"
                      />
                    </label>
                  </div>
                )}

                {workflowStep === 2 && (
                  <div className="opm-form-grid">
                    <label className="opm-field">
                      <span>Commitment currency</span>
                      <select
                        value={createDraft.currency}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            currency: event.target.value as OriginPrivateMarketCurrency,
                            fxToPortfolio:
                              event.target.value === portfolioCurrency
                                ? '1'
                                : event.target.value === 'USD'
                                  ? '0.867'
                                  : event.target.value === 'GBP'
                                    ? '1.156'
                                    : '1.042',
                          }))
                        }
                      >
                        <option>EUR</option>
                        <option>USD</option>
                        <option>GBP</option>
                        <option>CHF</option>
                      </select>
                    </label>
                    <label className="opm-field">
                      <span>FX to {portfolioCurrency}</span>
                      <input
                        type="number"
                        min="0.0001"
                        step="0.0001"
                        required
                        value={createDraft.fxToPortfolio}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            fxToPortfolio: event.target.value,
                          }))
                        }
                      />
                      <small>Used only for consolidated display.</small>
                    </label>
                    <label className="opm-field">
                      <span>Committed amount</span>
                      <input
                        type="number"
                        min="1"
                        required
                        value={createDraft.committed}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            committed: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="opm-field">
                      <span>Already contributed</span>
                      <input
                        type="number"
                        min="0"
                        required
                        value={createDraft.contributed}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            contributed: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="opm-field">
                      <span>Opening NAV</span>
                      <input
                        type="number"
                        min="0"
                        required
                        value={createDraft.nav}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({ ...draft, nav: event.target.value }))
                        }
                      />
                    </label>
                    <label className="opm-field">
                      <span>Ownership (%)</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={createDraft.ownership}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            ownership: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="opm-field opm-field--full">
                      <span>Portfolio account</span>
                      <select
                        value={createDraft.account}
                        onChange={(event) =>
                          setCreateDraft((draft) => ({
                            ...draft,
                            account: event.target.value,
                          }))
                        }
                      >
                        <option>Personal wealth · Private markets</option>
                        <option>Personal wealth · Private companies</option>
                        <option>Personal wealth · Real assets</option>
                        <option>Family reserve · Alternatives</option>
                      </select>
                    </label>
                  </div>
                )}

                {workflowStep === 3 && (
                  <div className="opm-create-review">
                    <div className={`opm-kind-icon opm-kind-icon--${createDraft.kind}`}>
                      <Icon name={kindMeta[createDraft.kind].icon} size={18} />
                    </div>
                    <div>
                      <span className="opm-object-label">{kindMeta[createDraft.kind].label}</span>
                      <h3>{createDraft.name}</h3>
                      <p>{createDraft.legalName || createDraft.name}</p>
                    </div>
                    <dl>
                      <div>
                        <dt>Committed</dt>
                        <dd>
                          {money(Number(createDraft.committed), createDraft.currency, privateMode)}
                        </dd>
                      </div>
                      <div>
                        <dt>Paid in</dt>
                        <dd>
                          {money(
                            Number(createDraft.contributed),
                            createDraft.currency,
                            privateMode,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Unfunded</dt>
                        <dd>
                          {money(
                            Math.max(
                              Number(createDraft.committed) - Number(createDraft.contributed),
                              0,
                            ),
                            createDraft.currency,
                            privateMode,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Opening NAV</dt>
                        <dd>{money(Number(createDraft.nav), createDraft.currency, privateMode)}</dd>
                      </div>
                    </dl>
                    <div className="opm-review-notice">
                      <Icon name="shield" size={15} />
                      <p>
                        This creates the commitment inside <strong>{portfolio.name}</strong>. No
                        bank transfer or external transaction is performed. A missing-document task
                        will be created for the agreement.
                      </p>
                    </div>
                  </div>
                )}

                <footer className="opm-workflow__footer">
                  {workflowStep > 1 ? (
                    <button
                      type="button"
                      className="opm-button opm-button--ghost"
                      onClick={() => setWorkflowStep((step) => step - 1)}
                    >
                      Back
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="opm-button opm-button--ghost"
                      onClick={() => setWorkflow(null)}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    className="opm-button opm-button--primary"
                    type="submit"
                    disabled={
                      workflowStep === 1
                        ? !createDraft.name.trim() ||
                          !createDraft.strategy.trim() ||
                          !createDraft.geography.trim()
                        : workflowStep === 2
                          ? Number(createDraft.committed) <= 0 ||
                            Number(createDraft.contributed) > Number(createDraft.committed)
                          : false
                    }
                  >
                    {workflowStep < 3 ? (
                      <>
                        Continue
                        <Icon name="arrow-right" size={13} />
                      </>
                    ) : (
                      <>
                        <Icon name="check" size={13} />
                        Create commitment
                      </>
                    )}
                  </button>
                </footer>
              </form>
            )}

            {workflow.kind === 'capital-call' && activeCall && activeCallCommitment && (
              <form className="opm-workflow__body" onSubmit={proposeCall}>
                <div className="opm-proposal-context">
                  <div>
                    <span className="opm-object-label">{activeCall.title}</span>
                    <h3>{activeCallCommitment.name}</h3>
                    <p>{activeCall.purpose}</p>
                  </div>
                  <strong>{money(activeCall.amount, activeCall.currency, privateMode)}</strong>
                  <small>Due {dateLabel(activeCall.dueDate)}</small>
                </div>
                <div className="opm-form-grid">
                  <label className="opm-field opm-field--full">
                    <span>Funding source</span>
                    <select
                      value={callDraft.source}
                      onChange={(event) =>
                        setCallDraft((draft) => ({ ...draft, source: event.target.value }))
                      }
                    >
                      <option>Portfolio cash · EUR</option>
                      <option>Broker cash · EUR</option>
                      <option>Family reserve · EUR</option>
                    </select>
                  </label>
                  <label className="opm-field">
                    <span>Call amount ({activeCall.currency})</span>
                    <input
                      type="number"
                      min="1"
                      max={Math.max(
                        activeCallCommitment.committed - activeCallCommitment.contributed,
                        0,
                      )}
                      required
                      value={callDraft.amount}
                      onChange={(event) =>
                        setCallDraft((draft) => ({ ...draft, amount: event.target.value }))
                      }
                    />
                  </label>
                  <label className="opm-field">
                    <span>Due date</span>
                    <input
                      type="date"
                      required
                      value={callDraft.dueDate}
                      onChange={(event) =>
                        setCallDraft((draft) => ({ ...draft, dueDate: event.target.value }))
                      }
                    />
                  </label>
                  <label className="opm-field opm-field--full">
                    <span>Proposal reason</span>
                    <textarea
                      rows={3}
                      required
                      value={callDraft.reason}
                      onChange={(event) =>
                        setCallDraft((draft) => ({ ...draft, reason: event.target.value }))
                      }
                    />
                  </label>
                </div>
                <div className="opm-impact-preview">
                  <span>
                    <small>Portfolio cash</small>
                    <strong>{money(portfolioAvailableCash, portfolioCurrency, privateMode)}</strong>
                  </span>
                  <Icon name="arrow-right" size={15} />
                  <span>
                    <small>After approval</small>
                    <strong>
                      {money(
                        portfolioAvailableCash -
                          toPortfolioCurrency(
                            Number(callDraft.amount),
                            activeCall.currency,
                            portfolioCurrency,
                            activeCallCommitment.fxToPortfolio,
                          ),
                        portfolioCurrency,
                        privateMode,
                      )}
                    </strong>
                  </span>
                </div>
                <label className="opm-consent">
                  <input
                    type="checkbox"
                    checked={callDraft.acknowledged}
                    onChange={(event) =>
                      setCallDraft((draft) => ({
                        ...draft,
                        acknowledged: event.target.checked,
                      }))
                    }
                  />
                  <span>
                    <strong>Send a proposal, not a transaction</strong>
                    <small>
                      I understand cash and commitment truth change only after Review approval.
                    </small>
                  </span>
                </label>
                <footer className="opm-workflow__footer">
                  <button
                    type="button"
                    className="opm-button opm-button--ghost"
                    onClick={() => setWorkflow(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="opm-button opm-button--primary"
                    disabled={
                      !callDraft.acknowledged ||
                      !callDraft.reason.trim() ||
                      Number(callDraft.amount) <= 0
                    }
                    data-testid="private-call-submit"
                  >
                    <Icon name="inbox" size={13} />
                    Send to Review
                  </button>
                </footer>
              </form>
            )}

            {workflow.kind === 'valuation' && activeValuationCommitment && (
              <form className="opm-workflow__body" onSubmit={proposeValuation}>
                <div className="opm-proposal-context">
                  <div>
                    <span className="opm-object-label">
                      Current · {activeValuationCommitment.valuation.method}
                    </span>
                    <h3>{activeValuationCommitment.name}</h3>
                    <p>{activeValuationCommitment.valuation.source}</p>
                  </div>
                  <strong>
                    {money(
                      activeValuationCommitment.nav,
                      activeValuationCommitment.currency,
                      privateMode,
                    )}
                  </strong>
                  <small>as of {dateLabel(activeValuationCommitment.valuation.asOf)}</small>
                </div>
                <div className="opm-form-grid">
                  <label className="opm-field">
                    <span>Proposed NAV ({activeValuationCommitment.currency})</span>
                    <input
                      type="number"
                      min="0"
                      required
                      value={valuationDraft.amount}
                      onChange={(event) =>
                        setValuationDraft((draft) => ({
                          ...draft,
                          amount: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="opm-field">
                    <span>Valuation date</span>
                    <input
                      type="date"
                      max={today}
                      required
                      value={valuationDraft.asOf}
                      onChange={(event) =>
                        setValuationDraft((draft) => ({ ...draft, asOf: event.target.value }))
                      }
                    />
                  </label>
                  <label className="opm-field">
                    <span>Source</span>
                    <input
                      required
                      placeholder="Manager statement, appraisal, financing round"
                      value={valuationDraft.source}
                      onChange={(event) =>
                        setValuationDraft((draft) => ({
                          ...draft,
                          source: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="opm-field">
                    <span>Method</span>
                    <select
                      value={valuationDraft.method}
                      onChange={(event) =>
                        setValuationDraft((draft) => ({
                          ...draft,
                          method: event.target.value,
                        }))
                      }
                    >
                      <option>Manager-reported NAV</option>
                      <option>Independent valuation</option>
                      <option>Last financing round</option>
                      <option>Comparable transaction</option>
                      <option>Income capitalisation</option>
                      <option>Cost less impairment</option>
                    </select>
                  </label>
                  <label className="opm-field opm-field--full">
                    <span>Evidence document</span>
                    <select
                      value={valuationDraft.evidence}
                      onChange={(event) =>
                        setValuationDraft((draft) => ({
                          ...draft,
                          evidence: event.target.value,
                        }))
                      }
                    >
                      <option value="">No document selected</option>
                      {allDocuments
                        .filter((document) => document.state !== 'missing')
                        .map((document) => (
                          <option key={document.id} value={document.name}>
                            {document.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="opm-field opm-field--full">
                    <span>Valuation rationale</span>
                    <textarea
                      rows={3}
                      required
                      placeholder="Explain the source, method, and any adjustment."
                      value={valuationDraft.reason}
                      onChange={(event) =>
                        setValuationDraft((draft) => ({
                          ...draft,
                          reason: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="opm-impact-preview">
                  <span>
                    <small>Current NAV</small>
                    <strong>
                      {money(
                        activeValuationCommitment.nav,
                        activeValuationCommitment.currency,
                        privateMode,
                      )}
                    </strong>
                  </span>
                  <Icon name="arrow-right" size={15} />
                  <span>
                    <small>Proposed NAV</small>
                    <strong>
                      {money(
                        Number(valuationDraft.amount),
                        activeValuationCommitment.currency,
                        privateMode,
                      )}
                    </strong>
                  </span>
                </div>
                <label className="opm-consent">
                  <input
                    type="checkbox"
                    checked={valuationDraft.acknowledged}
                    onChange={(event) =>
                      setValuationDraft((draft) => ({
                        ...draft,
                        acknowledged: event.target.checked,
                      }))
                    }
                  />
                  <span>
                    <strong>Preserve current truth until approval</strong>
                    <small>The new NAV, source, and evidence lineage are a Review proposal.</small>
                  </span>
                </label>
                <footer className="opm-workflow__footer">
                  <button
                    type="button"
                    className="opm-button opm-button--ghost"
                    onClick={() => setWorkflow(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="opm-button opm-button--primary"
                    disabled={
                      !valuationDraft.acknowledged ||
                      !valuationDraft.source.trim() ||
                      !valuationDraft.reason.trim() ||
                      Number(valuationDraft.amount) < 0
                    }
                    data-testid="private-valuation-submit"
                  >
                    <Icon name="inbox" size={13} />
                    Send to Review
                  </button>
                </footer>
              </form>
            )}
          </div>
        </div>
      )}

      {activeReceipt && (
        <div className="opm-modal-layer" data-accessible-dialog-layer>
          <div
            className="opm-modal-scrim"
            aria-hidden="true"
            onClick={() => setActiveReceipt(null)}
          />
          <div
            ref={receiptDialogRef}
            className="opm-receipt"
            role="dialog"
            aria-modal="true"
            aria-labelledby="opm-receipt-title"
            tabIndex={-1}
            data-testid="private-markets-receipt"
          >
            <span className="opm-receipt__icon">
              <Icon name={activeReceipt.reviewId ? 'inbox' : 'check'} size={20} />
            </span>
            <span className="opm-object-label">
              {activeReceipt.reviewId ? 'Proposal receipt' : 'Record receipt'}
            </span>
            <h2 id="opm-receipt-title">{activeReceipt.title}</h2>
            <p>{activeReceipt.detail}</p>
            <dl>
              <div>
                <dt>Receipt</dt>
                <dd>{activeReceipt.id}</dd>
              </div>
              <div>
                <dt>Recorded</dt>
                <dd>{activeReceipt.at}</dd>
              </div>
              <div>
                <dt>Actor</dt>
                <dd>{activeReceipt.actor}</dd>
              </div>
              {activeReceipt.reviewId && (
                <div>
                  <dt>Review</dt>
                  <dd>{activeReceipt.reviewId}</dd>
                </div>
              )}
            </dl>
            <div className="opm-receipt__actions">
              <button
                type="button"
                className="opm-button opm-button--ghost"
                onClick={() => {
                  setActiveReceipt(null);
                  setView('audit');
                }}
              >
                View audit
              </button>
              {activeReceipt.reviewId ? (
                <button
                  type="button"
                  className="opm-button opm-button--primary"
                  onClick={() => {
                    setActiveReceipt(null);
                    onOpenReview();
                  }}
                  data-opm-receipt-focus
                >
                  Open Review
                  <Icon name="arrow-right" size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  className="opm-button opm-button--primary"
                  onClick={() => setActiveReceipt(null)}
                  data-opm-receipt-focus
                >
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default OriginPrivateMarkets;
