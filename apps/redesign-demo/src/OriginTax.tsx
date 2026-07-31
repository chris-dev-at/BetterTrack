import { useEffect, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry } from './OriginReviewCenter';
import './origin-tax.css';

type TaxWorkspaceTab = 'position' | 'basis' | 'reports';
type CostBasisMethod = 'fifo' | 'average' | 'specific';
type ExportFormat = 'json' | 'csv';
type ReportType = 'summary' | 'activity' | 'realized' | 'income';

export type OriginTaxPortfolio =
  | string
  | {
      id: string;
      name: string;
      currency?: string;
    };

export type OriginTaxTrade = {
  id: string;
  asset?: {
    symbol?: string;
    name?: string;
  };
  portfolio?: string;
  side?: 'Buy' | 'Sell' | string;
  units?: number;
  gross?: number;
  fees?: number;
  cashImpact?: number;
  recurring?: boolean;
  basisStatus?: 'covered' | 'missing' | string;
  executedAt?: string;
};

export type OriginTaxProps = {
  portfolio: OriginTaxPortfolio;
  privateMode: boolean;
  trades?: OriginTaxTrade[];
  onOpenReview?: () => void;
  onOpenFiles?: () => void;
  onOpenShare?: () => void;
  onSubmitReview?: (item: OriginReviewEntry) => void;
  onToast?: (message: string) => void;
};

type Resolution = {
  basis: number;
  evidence: string;
  note: string;
  resolvedAt: string;
};

type GeneratedReport = {
  id: string;
  type: ReportType;
  year: string;
  format: ExportFormat;
  status: 'ready';
  generatedAt: string;
  provisional: boolean;
  rows: number;
};

type PersistedTaxState = {
  portfolioId: string;
  year: string;
  country: string;
  profile: string;
  basisMethod: CostBasisMethod;
  selectedLots: Record<string, string>;
  resolutions: Record<string, Resolution>;
  reviewItems: Record<string, string>;
  generatedReports: GeneratedReport[];
  accountantShared: boolean;
  scenarioSale: number;
  scenarioGain: number;
  scenarioIncome: number;
};

type TaxModel = {
  id: string;
  country: string;
  profile: string;
  label: string;
  shortRule: string;
  rate: number;
  incomeRate: number;
};

type Lot = {
  id: string;
  acquired: string;
  units: number;
  cost: number | null;
  fees: number;
  source: string;
};

type DisposalSeed = {
  id: string;
  symbol: string;
  name: string;
  disposed: string;
  units: number;
  proceeds: number;
  fees: number;
  fifoBasis: number | null;
  averageBasis: number | null;
  specificBasis: number | null;
  source: string;
  lots: Lot[];
};

type Disposal = DisposalSeed & {
  basis: number | null;
  result: number | null;
  estimatedTax: number | null;
  resolution?: Resolution;
};

const models: TaxModel[] = [
  {
    id: 'at-private',
    country: 'Austria',
    profile: 'Private investor',
    label: 'Austria · private investor',
    shortRule: 'Illustrative capital-income model · 27.5%',
    rate: 0.275,
    incomeRate: 0.275,
  },
  {
    id: 'at-company',
    country: 'Austria',
    profile: 'Company',
    label: 'Austria · company',
    shortRule: 'Illustrative company estimate · 23%',
    rate: 0.23,
    incomeRate: 0.23,
  },
  {
    id: 'de-private',
    country: 'Germany',
    profile: 'Private investor',
    label: 'Germany · private investor',
    shortRule: 'Illustrative flat-rate model · 26.375%',
    rate: 0.26375,
    incomeRate: 0.26375,
  },
  {
    id: 'gb-individual',
    country: 'United Kingdom',
    profile: 'Individual',
    label: 'United Kingdom · individual',
    shortRule: 'Illustrative blended estimate · 20%',
    rate: 0.2,
    incomeRate: 0.2,
  },
  {
    id: 'custom-demo',
    country: 'Custom',
    profile: 'Demo profile',
    label: 'Custom · demo profile',
    shortRule: 'Neutral scenario rate · 25%',
    rate: 0.25,
    incomeRate: 0.25,
  },
];

const reportTypes: Array<{
  id: ReportType;
  title: string;
  description: string;
  icon: IconName;
}> = [
  {
    id: 'summary',
    title: 'Tax summary',
    description: 'Position, estimates, assumptions, and readiness',
    icon: 'document',
  },
  {
    id: 'activity',
    title: 'Activity ledger',
    description: 'All taxable portfolio activity with lineage',
    icon: 'activity',
  },
  {
    id: 'realized',
    title: 'Realized gains',
    description: 'Disposals, lots, fees, and calculated results',
    icon: 'assets',
  },
  {
    id: 'income',
    title: 'Income & withholding',
    description: 'Dividends, distributions, and withholding entries',
    icon: 'cash',
  },
];

const yearMetrics: Record<
  string,
  { dividends: number; withholding: number; fees: number; distributions: number }
> = {
  '2024': { dividends: 1138.26, withholding: 303.08, fees: 284.61, distributions: 17 },
  '2025': { dividends: 1516.4, withholding: 412.72, fees: 309.48, distributions: 21 },
  '2026': { dividends: 1844.7, withholding: 507.29, fees: 328.14, distributions: 23 },
};

const monthNames = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const incomeShape = [0.38, 0.56, 0.42, 1.08, 0.47, 1.42, 0.58, 0.73, 0.62, 1.18, 0.51, 1.05];
const withholdingShape = [0.34, 0.45, 0.39, 1.12, 0.4, 1.34, 0.52, 0.69, 0.58, 1.14, 0.48, 1.19];

const baseDisposals: DisposalSeed[] = [
  {
    id: 'vwce-jun',
    symbol: 'VWCE',
    name: 'Vanguard FTSE All-World',
    disposed: '18 Jun',
    units: 12.4,
    proceeds: 12480,
    fees: 14.82,
    fifoBasis: 10222,
    averageBasis: 10518,
    specificBasis: 10946,
    source: 'Trade Republic · order TR-4821',
    lots: [
      {
        id: 'vwce-2022',
        acquired: '14 Feb 2022',
        units: 5.2,
        cost: 4017,
        fees: 5.4,
        source: 'Trade Republic',
      },
      {
        id: 'vwce-2023',
        acquired: '07 Aug 2023',
        units: 4.8,
        cost: 4129,
        fees: 4.96,
        source: 'Trade Republic',
      },
      {
        id: 'vwce-2024',
        acquired: '12 Nov 2024',
        units: 2.4,
        cost: 2076,
        fees: 2.98,
        source: 'Manual confirmation',
      },
    ],
  },
  {
    id: 'aapl-mar',
    symbol: 'AAPL',
    name: 'Apple',
    disposed: '22 Mar',
    units: 39,
    proceeds: 8240,
    fees: 10.4,
    fifoBasis: 6904,
    averageBasis: 7062,
    specificBasis: 7288,
    source: 'Interactive Brokers · execution IB-196',
    lots: [
      {
        id: 'aapl-2021',
        acquired: '03 Sep 2021',
        units: 24,
        cost: 3981,
        fees: 4.1,
        source: 'Interactive Brokers',
      },
      {
        id: 'aapl-2024',
        acquired: '19 Jan 2024',
        units: 15,
        cost: 2923,
        fees: 3.8,
        source: 'Interactive Brokers',
      },
    ],
  },
  {
    id: 'btc-may',
    symbol: 'BTC',
    name: 'Bitcoin',
    disposed: '05 May',
    units: 0.087,
    proceeds: 6500,
    fees: 31.2,
    fifoBasis: null,
    averageBasis: null,
    specificBasis: null,
    source: 'CSV import · exchange history',
    lots: [
      {
        id: 'btc-unknown',
        acquired: 'Acquisition date missing',
        units: 0.087,
        cost: null,
        fees: 0,
        source: 'Imported without acquisition record',
      },
    ],
  },
  {
    id: 'msft-feb',
    symbol: 'MSFT',
    name: 'Microsoft',
    disposed: '08 Feb',
    units: 9.2,
    proceeds: 4200,
    fees: 6.8,
    fifoBasis: 3649,
    averageBasis: 3712,
    specificBasis: 3794,
    source: 'Flatex · execution FL-091',
    lots: [
      {
        id: 'msft-2022',
        acquired: '16 Dec 2022',
        units: 9.2,
        cost: 3649,
        fees: 4.7,
        source: 'Flatex',
      },
    ],
  },
];

function portfolioIdentity(portfolio: OriginTaxPortfolio) {
  if (typeof portfolio === 'string') {
    return {
      id: portfolio.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'portfolio',
      name: portfolio,
      currency: 'EUR',
    };
  }
  return {
    id: portfolio.id,
    name: portfolio.name,
    currency: portfolio.currency || 'EUR',
  };
}

function defaultState(portfolioId: string): PersistedTaxState {
  return {
    portfolioId,
    year: '2026',
    country: 'Austria',
    profile: 'Private investor',
    basisMethod: 'fifo',
    selectedLots: {},
    resolutions: {},
    reviewItems: {},
    generatedReports: [],
    accountantShared: false,
    scenarioSale: 10000,
    scenarioGain: 18,
    scenarioIncome: 1200,
  };
}

function readState(portfolioId: string): PersistedTaxState {
  const fallback = defaultState(portfolioId);
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(`bt-demo-origin-tax-${portfolioId}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedTaxState>;
    return {
      ...fallback,
      ...parsed,
      portfolioId,
      selectedLots: parsed.selectedLots ?? {},
      resolutions: parsed.resolutions ?? {},
      reviewItems: parsed.reviewItems ?? {},
      generatedReports: parsed.generatedReports ?? [],
    };
  } catch {
    return fallback;
  }
}

function money(value: number, currency: string, privateMode: boolean, sign = false) {
  if (privateMode) return '••••••';
  try {
    const formatted = new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(value));
    if (!sign) return value < 0 ? `−${formatted}` : formatted;
    return value > 0 ? `+${formatted}` : value < 0 ? `−${formatted}` : formatted;
  } catch {
    const formatted = Math.abs(value).toFixed(2);
    return `${value < 0 ? '−' : sign && value > 0 ? '+' : ''}${formatted} ${currency}`;
  }
}

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function yearMultiplier(year: string) {
  if (year === '2024') return 0.66;
  if (year === '2025') return 0.83;
  return 1;
}

export function OriginTax({
  portfolio,
  privateMode,
  trades = [],
  onOpenReview,
  onOpenFiles,
  onOpenShare,
  onSubmitReview,
  onToast,
}: OriginTaxProps) {
  const identity = useMemo(() => portfolioIdentity(portfolio), [portfolio]);
  const [state, setState] = useState<PersistedTaxState>(() => readState(identity.id));
  const [tab, setTab] = useState<TaxWorkspaceTab>('position');
  const [expanded, setExpanded] = useState<string>('vwce-jun');
  const [selectedMonth, setSelectedMonth] = useState(5);
  const [reportType, setReportType] = useState<ReportType>('summary');
  const [reportFormat, setReportFormat] = useState<ExportFormat>('json');
  const [reportStatus, setReportStatus] = useState<'idle' | 'preparing'>('idle');
  const [basisDrafts, setBasisDrafts] = useState<Record<string, string>>({});
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (state.portfolioId !== identity.id) {
      setState(readState(identity.id));
      setTab('position');
      setExpanded('vwce-jun');
    }
  }, [identity.id, state.portfolioId]);

  useEffect(() => {
    if (state.portfolioId !== identity.id || typeof window === 'undefined') return;
    window.localStorage.setItem(`bt-demo-origin-tax-${identity.id}`, JSON.stringify(state));
  }, [identity.id, state]);

  const countryProfiles = models.filter((item) => item.country === state.country);
  const activeModel =
    models.find((item) => item.country === state.country && item.profile === state.profile) ??
    models[0]!;
  const annual = yearMetrics[state.year] ?? yearMetrics['2026']!;
  const scale = yearMultiplier(state.year);

  const tradeDisposals = useMemo<DisposalSeed[]>(
    () =>
      trades
        .filter((trade) => trade.side?.toLowerCase() === 'sell')
        .map((trade, index) => {
          const gross = Math.max(0, trade.gross ?? Math.abs(trade.cashImpact ?? 0));
          const covered = trade.basisStatus !== 'missing';
          const estimatedBasis = covered ? gross * 0.865 : null;
          const symbol = trade.asset?.symbol || `SALE ${index + 1}`;
          return {
            id: `trade-${trade.id}`,
            symbol,
            name: trade.asset?.name || 'Portfolio disposal',
            disposed: trade.executedAt || 'Recent',
            units: trade.units ?? 0,
            proceeds: gross,
            fees: trade.fees ?? 0,
            fifoBasis: estimatedBasis,
            averageBasis: covered ? gross * 0.881 : null,
            specificBasis: covered ? gross * 0.903 : null,
            source: `BetterTrack activity · ${trade.id}`,
            lots: [
              {
                id: `${trade.id}-lot`,
                acquired: covered ? 'Matched from portfolio activity' : 'Acquisition date missing',
                units: trade.units ?? 0,
                cost: estimatedBasis,
                fees: 0,
                source: covered ? 'Portfolio lot ledger' : 'No matching acquisition',
              },
            ],
          };
        }),
    [trades],
  );

  const disposalSeeds = useMemo(
    () =>
      state.year === '2026'
        ? [...baseDisposals, ...tradeDisposals]
        : baseDisposals
            .filter((item) => item.id !== 'btc-may')
            .map((item) => ({
              ...item,
              id: `${item.id}-${state.year}`,
              proceeds: item.proceeds * scale,
              fees: item.fees * scale,
              fifoBasis: item.fifoBasis === null ? null : item.fifoBasis * scale,
              averageBasis: item.averageBasis === null ? null : item.averageBasis * scale,
              specificBasis: item.specificBasis === null ? null : item.specificBasis * scale,
            })),
    [scale, state.year, tradeDisposals],
  );

  const disposals = useMemo<Disposal[]>(
    () =>
      disposalSeeds.map((item) => {
        const resolution = state.resolutions[item.id];
        let basis: number | null = resolution?.basis ?? null;
        if (!resolution) {
          if (state.basisMethod === 'fifo') basis = item.fifoBasis;
          if (state.basisMethod === 'average') basis = item.averageBasis;
          if (state.basisMethod === 'specific') {
            const selectedLot = item.lots.find((lot) => lot.id === state.selectedLots[item.id]);
            basis = selectedLot?.cost ?? item.specificBasis;
          }
        }
        const result = basis === null ? null : item.proceeds - basis - item.fees;
        return {
          ...item,
          basis,
          result,
          estimatedTax: result === null ? null : Math.max(0, result * activeModel.rate),
          resolution,
        };
      }),
    [activeModel.rate, disposalSeeds, state.basisMethod, state.resolutions, state.selectedLots],
  );

  const missing = disposals.filter((item) => item.basis === null);
  const realizedResult = disposals.reduce((total, item) => total + (item.result ?? 0), 0);
  const realizedTax = disposals.reduce((total, item) => total + (item.estimatedTax ?? 0), 0);
  const incomeTax = annual.dividends * activeModel.incomeRate;
  const grossEstimate = realizedTax + incomeTax;
  const estimatedDue = Math.max(0, grossEstimate - annual.withholding);
  const coverage = disposals.length
    ? Math.round(((disposals.length - missing.length) / disposals.length) * 100)
    : 100;
  const readiness = Math.max(0, Math.round(88 + coverage * 0.12 - missing.length * 4));
  const isProvisional = state.year === '2026' || missing.length > 0;

  const monthly = useMemo(() => {
    const incomeSum = incomeShape.reduce((sum, value) => sum + value, 0);
    const withholdingSum = withholdingShape.reduce((sum, value) => sum + value, 0);
    let accrued = 0;
    return monthNames.map((month, index) => {
      const income = (annual.dividends * incomeShape[index]!) / incomeSum;
      const withheld = (annual.withholding * withholdingShape[index]!) / withholdingSum;
      const disposalTax =
        disposals
          .filter((_, disposalIndex) => disposalIndex % 6 === index % 6)
          .reduce((sum, item) => sum + (item.estimatedTax ?? 0), 0) / 2;
      accrued += income * activeModel.incomeRate + disposalTax - withheld;
      return {
        month,
        income,
        withheld,
        accrued: Math.max(0, accrued),
      };
    });
  }, [activeModel.incomeRate, annual.dividends, annual.withholding, disposals]);

  const chartMax = Math.max(
    1,
    ...monthly.flatMap((item) => [item.income, item.withheld, item.accrued]),
  );
  const accruedPoints = monthly
    .map((item, index) => {
      const x = 52 + index * (914 / 11);
      const y = 228 - (item.accrued / chartMax) * 184;
      return `${x},${y}`;
    })
    .join(' ');
  const monthDetail = monthly[selectedMonth] ?? monthly[0]!;

  const scenarioBasis = state.scenarioSale * (1 - state.scenarioGain / 100);
  const scenarioResult = state.scenarioSale - scenarioBasis;
  const scenarioLiability =
    Math.max(0, scenarioResult) * activeModel.rate + state.scenarioIncome * activeModel.incomeRate;
  const scenarioDue = Math.max(0, estimatedDue + scenarioLiability);

  function patchState(patch: Partial<PersistedTaxState>) {
    setState((current) => ({ ...current, ...patch }));
  }

  function changeCountry(country: string) {
    const first = models.find((item) => item.country === country) ?? models[0]!;
    patchState({ country, profile: first.profile });
  }

  function resolveBasis(item: Disposal) {
    const value = Number(basisDrafts[item.id]);
    if (!Number.isFinite(value) || value <= 0) {
      onToast?.('Enter a positive cost-basis amount before attaching the resolution.');
      return;
    }
    const evidence = evidenceDrafts[item.id] || 'User-entered assumption';
    const resolution: Resolution = {
      basis: value,
      evidence,
      note: noteDrafts[item.id]?.trim() || 'No additional note',
      resolvedAt: new Date().toISOString(),
    };
    patchState({
      resolutions: {
        ...state.resolutions,
        [item.id]: resolution,
      },
    });
    onToast?.(`${item.symbol} cost basis attached. Tax estimates were recalculated.`);
  }

  function removeResolution(item: Disposal) {
    const next = { ...state.resolutions };
    delete next[item.id];
    patchState({ resolutions: next });
    onToast?.(`${item.symbol} basis resolution removed.`);
  }

  function sendBasisToReview(item: Disposal) {
    const requestedAt = new Date().toISOString();
    const reviewId = `tax-basis-${identity.id}-${item.id}`;
    const itemToReview: OriginReviewEntry = {
      id: reviewId,
      kind: 'tax',
      title: `Resolve cost basis for ${item.symbol}`,
      summary: `${item.units.toFixed(6)} units were disposed for ${money(
        item.proceeds,
        identity.currency,
        false,
      )}, but no matching acquisition value is available.`,
      portfolio: {
        id: identity.id,
        name: identity.name,
        path: `Portfolio / Tax / ${state.year}`,
      },
      source: {
        label: item.source,
        detail: 'Generated from the portfolio tax workspace',
        actor: 'Tax workspace',
      },
      requestedAt,
      requestedBy: 'Portfolio owner',
      status: 'pending',
      priority: 'high',
      risk: 'medium',
      affectedCount: 1,
      tags: ['Tax', 'Missing basis', state.year, item.symbol],
      approveLabel: 'Accept basis',
      rejectLabel: 'Keep unresolved',
      diff: [
        {
          label: 'Cost basis',
          before: 'Missing',
          after: basisDrafts[item.id]
            ? money(Number(basisDrafts[item.id]), identity.currency, false)
            : 'Reviewer must provide a verified value',
          tone: 'warning',
          detail: evidenceDrafts[item.id] || 'No evidence selected yet',
        },
        {
          label: 'Report state',
          before: 'Provisional',
          after: 'Eligible for finalization after approval',
          tone: 'positive',
        },
      ],
      calculations: [
        {
          label: 'Disposal proceeds',
          value: money(item.proceeds, identity.currency, false),
          detail: `${item.units.toFixed(6)} ${item.symbol}`,
        },
        {
          label: 'Maximum unadjusted estimate',
          value: money(item.proceeds * activeModel.rate, identity.currency, false),
          detail: `${activeModel.label} fictional demo model`,
          tone: 'warning',
        },
      ],
      lineage: [
        {
          label: 'Disposal',
          detail: `${item.disposed} · ${item.source}`,
          state: 'external',
        },
        {
          label: 'Acquisition match',
          detail: 'No compatible portfolio lot was found',
          state: 'warning',
        },
        {
          label: 'Proposed evidence',
          detail: evidenceDrafts[item.id] || 'Not attached',
          state: evidenceDrafts[item.id] ? 'derived' : 'warning',
        },
      ],
      policies: [
        {
          title: 'Human approval required',
          description: 'A cost-basis assumption cannot become final without review.',
          status: 'warning',
        },
        {
          title: 'Source retained',
          description: 'The original disposal and imported evidence remain in the audit trail.',
          status: 'pass',
        },
      ],
    };
    onSubmitReview?.(itemToReview);
    patchState({
      reviewItems: {
        ...state.reviewItems,
        [item.id]: requestedAt,
      },
    });
    onToast?.(`${item.symbol} basis request added to Review.`);
    if (!onSubmitReview) onOpenReview?.();
  }

  function generateReport() {
    if (reportStatus === 'preparing') return;
    setReportStatus('preparing');
    window.setTimeout(() => {
      const report: GeneratedReport = {
        id: `TX-${state.year}-${String(state.generatedReports.length + 1).padStart(3, '0')}`,
        type: reportType,
        year: state.year,
        format: reportFormat,
        status: 'ready',
        generatedAt: new Date().toISOString(),
        provisional: isProvisional,
        rows:
          reportType === 'summary'
            ? 1
            : reportType === 'activity'
              ? disposals.length + annual.distributions
              : reportType === 'realized'
                ? disposals.length
                : annual.distributions,
      };
      setState((current) => ({
        ...current,
        generatedReports: [report, ...current.generatedReports].slice(0, 12),
      }));
      setReportStatus('idle');
      onToast?.(
        `${reportTypes.find((item) => item.id === reportType)?.title} is ready to download.`,
      );
    }, 650);
  }

  function reportPayload(report: GeneratedReport) {
    return {
      demo: true,
      disclaimer:
        'Fictional BetterTrack product preview. This export is not tax or legal advice and is not suitable for filing.',
      report: {
        id: report.id,
        type: report.type,
        year: report.year,
        status: report.provisional ? 'provisional' : 'final-demo',
        generatedAt: report.generatedAt,
      },
      portfolio: identity,
      model: {
        country: activeModel.country,
        profile: activeModel.profile,
        basisMethod: state.basisMethod,
      },
      summary: {
        realizedResult,
        dividends: annual.dividends,
        withholding: annual.withholding,
        fees: annual.fees,
        estimatedDue,
        readiness,
      },
      disposals: disposals.map((item) => ({
        symbol: item.symbol,
        disposed: item.disposed,
        units: item.units,
        proceeds: item.proceeds,
        basis: item.basis,
        fees: item.fees,
        result: item.result,
        estimatedTax: item.estimatedTax,
        source: item.source,
      })),
    };
  }

  function downloadReport(report: GeneratedReport) {
    const payload = reportPayload(report);
    if (report.format === 'json') {
      downloadFile(
        `bettertrack-${report.type}-${report.year}-${report.id}.json`,
        JSON.stringify(payload, null, 2),
        'application/json',
      );
    } else {
      const header =
        'symbol,disposed,units,proceeds,cost_basis,fees,result,estimated_tax,status,source';
      const rows = disposals.map((item) =>
        [
          item.symbol,
          item.disposed,
          item.units,
          item.proceeds.toFixed(2),
          item.basis?.toFixed(2) ?? '',
          item.fees.toFixed(2),
          item.result?.toFixed(2) ?? '',
          item.estimatedTax?.toFixed(2) ?? '',
          item.basis === null ? 'missing_basis' : 'calculated',
          `"${item.source.replaceAll('"', '""')}"`,
        ].join(','),
      );
      downloadFile(
        `bettertrack-${report.type}-${report.year}-${report.id}.csv`,
        [header, ...rows].join('\n'),
        'text/csv;charset=utf-8',
      );
    }
    onToast?.(`${report.id} downloaded as ${report.format.toUpperCase()}.`);
  }

  function shareWithAccountant() {
    patchState({ accountantShared: true });
    onOpenShare?.();
    onToast?.('Accountant collaboration opened with tax-only access preselected.');
  }

  return (
    <div className="origin-tax">
      <header className="otx-header">
        <h2>Tax position</h2>
        <div className="otx-header__actions">
          <button className="otx-button otx-button--quiet" onClick={onOpenFiles} type="button">
            <Icon name="folder" size={14} />
            Source files
          </button>
          <button
            className="otx-button otx-button--primary"
            onClick={() => {
              setTab('reports');
              setReportType('summary');
            }}
            type="button"
          >
            <Icon name="download" size={14} />
            Build report
          </button>
        </div>
      </header>

      <div className="otx-disclaimer" role="note">
        <Icon name="help" size={14} />
        <span>
          <strong>Demo estimate.</strong> Illustrative only · not suitable for filing.
        </span>
      </div>

      <div className="otx-control-bar">
        <label>
          <span>Year</span>
          <select
            aria-label="Tax year"
            onChange={(event) => patchState({ year: event.target.value })}
            value={state.year}
          >
            <option value="2024">2024</option>
            <option value="2025">2025</option>
            <option value="2026">2026 · year to date</option>
          </select>
        </label>
        <i />
        <label>
          <span>Country</span>
          <select
            aria-label="Tax country"
            onChange={(event) => changeCountry(event.target.value)}
            value={state.country}
          >
            {[...new Set(models.map((item) => item.country))].map((country) => (
              <option key={country}>{country}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Profile</span>
          <select
            aria-label="Tax profile"
            onChange={(event) => patchState({ profile: event.target.value })}
            value={state.profile}
          >
            {countryProfiles.map((item) => (
              <option key={item.id}>{item.profile}</option>
            ))}
          </select>
        </label>
      </div>

      <nav aria-label="Tax workspace sections" className="otx-tabs">
        <div aria-label="Tax views" className="otx-tabs__list" role="group">
          {[
            ['position', 'Position', 'Current estimate and lineage'],
            [
              'basis',
              'Cost basis',
              `${missing.length} open item${missing.length === 1 ? '' : 's'}`,
            ],
            ['reports', 'Reports', `${state.generatedReports.length} generated`],
          ].map(([id, label, meta]) => (
            <button
              aria-controls={`otx-${id}-panel`}
              aria-label={`${label} · ${meta}`}
              aria-pressed={tab === id}
              className={tab === id ? 'is-active' : undefined}
              id={`otx-${id}-tab`}
              key={id}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const tabs: TaxWorkspaceTab[] = ['position', 'basis', 'reports'];
                const current = tabs.indexOf(id as TaxWorkspaceTab);
                const next =
                  event.key === 'Home'
                    ? tabs[0]!
                    : event.key === 'End'
                      ? tabs[tabs.length - 1]!
                      : tabs[
                          (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
                            tabs.length
                        ]!;
                setTab(next);
                window.requestAnimationFrame(() =>
                  document.getElementById(`otx-${next}-tab`)?.focus(),
                );
              }}
              onClick={() => setTab(id as TaxWorkspaceTab)}
              type="button"
            >
              <strong>{label}</strong>
              <small>{meta}</small>
            </button>
          ))}
        </div>
      </nav>

      <section className="otx-summary" aria-label={`${state.year} tax summary`}>
        <div className="otx-summary__primary">
          <small>Estimated due</small>
          <strong>{money(estimatedDue, identity.currency, privateMode)}</strong>
          <span className={cx('otx-status', isProvisional ? 'is-warning' : 'is-ready')}>
            <i />
            {isProvisional ? 'Provisional · not for filing' : 'Reconciled demo snapshot'}
          </span>
        </div>
        <dl className="otx-summary__facts">
          <div>
            <dt>Realized result</dt>
            <dd>{money(realizedResult, identity.currency, privateMode, true)}</dd>
            <small>{disposals.length} disposals</small>
          </div>
          <div>
            <dt>Dividends</dt>
            <dd>{money(annual.dividends, identity.currency, privateMode)}</dd>
            <small>{annual.distributions} distributions</small>
          </div>
          <div>
            <dt>Withholding</dt>
            <dd>{money(annual.withholding, identity.currency, privateMode)}</dd>
            <small>{activeModel.country} model</small>
          </div>
        </dl>
      </section>

      {tab === 'position' ? (
        <div
          aria-labelledby="otx-position-tab"
          className="otx-position"
          id="otx-position-panel"
          role="region"
        >
          <section className="otx-chart-section">
            <div className="otx-section-heading">
              <span>
                <h3>Tax over time</h3>
              </span>
              <div className="otx-chart-legend" aria-label="Chart legend">
                <span>
                  <i className="is-income" />
                  Income
                </span>
                <span>
                  <i className="is-withheld" />
                  Withheld
                </span>
                <span>
                  <i className="is-accrued" />
                  Estimated due
                </span>
              </div>
            </div>
            <div className="otx-chart-wrap">
              <svg
                aria-label={`Monthly income and tax estimate for ${state.year}`}
                className="otx-chart"
                preserveAspectRatio="none"
                role="img"
                viewBox="0 0 1000 270"
              >
                {[44, 90, 136, 182, 228].map((y) => (
                  <line className="otx-chart__grid" key={y} x1="40" x2="982" y1={y} y2={y} />
                ))}
                {monthly.map((item, index) => {
                  const x = 38 + index * (914 / 11);
                  const incomeHeight = (item.income / chartMax) * 184;
                  const withheldHeight = (item.withheld / chartMax) * 184;
                  return (
                    <g key={item.month}>
                      <title>
                        {item.month}: income {money(item.income, identity.currency, false)},
                        withheld {money(item.withheld, identity.currency, false)}, estimated due{' '}
                        {money(item.accrued, identity.currency, false)}
                      </title>
                      <rect
                        className="otx-chart__income"
                        height={incomeHeight}
                        rx="1"
                        width="15"
                        x={x}
                        y={228 - incomeHeight}
                      />
                      <rect
                        className="otx-chart__withheld"
                        height={withheldHeight}
                        rx="1"
                        width="8"
                        x={x + 17}
                        y={228 - withheldHeight}
                      />
                    </g>
                  );
                })}
                <polyline className="otx-chart__line" points={accruedPoints} />
                {monthly.map((item, index) => (
                  <circle
                    className={cx('otx-chart__point', selectedMonth === index && 'is-selected')}
                    cx={52 + index * (914 / 11)}
                    cy={228 - (item.accrued / chartMax) * 184}
                    key={item.month}
                    r={selectedMonth === index ? 5 : 3}
                  />
                ))}
              </svg>
              <div aria-label="Select month detail" className="otx-chart-months" role="group">
                {monthly.map((item, index) => (
                  <button
                    aria-controls="otx-selected-month-detail"
                    aria-label={`Show ${item.month} detail`}
                    aria-pressed={selectedMonth === index}
                    className={selectedMonth === index ? 'is-active' : undefined}
                    key={item.month}
                    onClick={() => setSelectedMonth(index)}
                    type="button"
                  >
                    {item.month}
                  </button>
                ))}
              </div>
            </div>
            <div aria-live="polite" className="otx-chart-detail" id="otx-selected-month-detail">
              <span>
                <small>{monthDetail.month} income</small>
                <strong>{money(monthDetail.income, identity.currency, privateMode)}</strong>
              </span>
              <span>
                <small>Withheld</small>
                <strong>{money(-monthDetail.withheld, identity.currency, privateMode)}</strong>
              </span>
              <span>
                <small>Running estimated due</small>
                <strong>{money(monthDetail.accrued, identity.currency, privateMode)}</strong>
              </span>
              <span>
                <small>Fees recognized</small>
                <strong>{money(annual.fees, identity.currency, privateMode)}</strong>
              </span>
            </div>
          </section>

          <div className="otx-position__lower">
            <section className="otx-readiness">
              <div className="otx-section-heading">
                <span>
                  <h3>Data readiness · {readiness}%</h3>
                  <p>
                    {missing.length
                      ? `${missing.length} basis item${missing.length === 1 ? '' : 's'} keep this snapshot provisional.`
                      : 'Every disposal has a cost-basis path and source.'}
                  </p>
                </span>
                <button
                  className="otx-button otx-button--quiet"
                  onClick={() => setTab('basis')}
                  type="button"
                >
                  Inspect issues
                  <Icon name="arrow-right" size={13} />
                </button>
              </div>
              <div className="otx-readiness__bar">
                <i style={{ width: `${readiness}%` }} />
              </div>
              <div className="otx-lineage">
                {[
                  {
                    label: 'Trade & lot ledger',
                    value: `${coverage}%`,
                    detail: `${disposals.length} disposals · ${missing.length} unresolved`,
                    tone: missing.length ? 'warning' : 'ready',
                  },
                  {
                    label: 'Income records',
                    value: '100%',
                    detail: `${annual.distributions} distributions reconciled`,
                    tone: 'ready',
                  },
                  {
                    label: 'Withholding',
                    value: '100%',
                    detail: 'Provider records mapped to income',
                    tone: 'ready',
                  },
                  {
                    label: 'FX conversion',
                    value: 'ECB demo',
                    detail: 'Daily source retained with every conversion',
                    tone: 'external',
                  },
                ].map((item) => (
                  <div key={item.label}>
                    <i className={`is-${item.tone}`} />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <b>{item.value}</b>
                  </div>
                ))}
              </div>
              <div className="otx-readiness__actions">
                <button onClick={onOpenFiles} type="button">
                  <Icon name="folder" size={14} />
                  Open 6 source documents
                </button>
                <button onClick={onOpenReview} type="button">
                  <Icon name="inbox" size={14} />
                  Open Review
                </button>
              </div>
            </section>

            <section className="otx-scenario">
              <div className="otx-section-heading">
                <span>
                  <h3>Before another sale</h3>
                </span>
                <span className="otx-demo-pill">DEMO MODEL</span>
              </div>
              <div className="otx-scenario__inputs">
                <label>
                  <span>Additional proceeds</span>
                  <div>
                    <small>{identity.currency}</small>
                    <input
                      aria-label="Additional sale proceeds"
                      min="0"
                      onChange={(event) =>
                        patchState({ scenarioSale: Number(event.target.value) || 0 })
                      }
                      type="number"
                      value={state.scenarioSale}
                    />
                  </div>
                </label>
                <label>
                  <span>Embedded gain</span>
                  <div>
                    <input
                      aria-label="Embedded gain percentage"
                      min="0"
                      onChange={(event) =>
                        patchState({ scenarioGain: Number(event.target.value) || 0 })
                      }
                      type="number"
                      value={state.scenarioGain}
                    />
                    <small>%</small>
                  </div>
                </label>
                <label>
                  <span>Additional income</span>
                  <div>
                    <small>{identity.currency}</small>
                    <input
                      aria-label="Additional dividend income"
                      min="0"
                      onChange={(event) =>
                        patchState({ scenarioIncome: Number(event.target.value) || 0 })
                      }
                      type="number"
                      value={state.scenarioIncome}
                    />
                  </div>
                </label>
              </div>
              <div className="otx-scenario__result">
                <span>
                  <small>Scenario gain</small>
                  <strong>{money(scenarioResult, identity.currency, privateMode)}</strong>
                </span>
                <span>
                  <small>Additional estimate</small>
                  <strong>{money(scenarioLiability, identity.currency, privateMode)}</strong>
                </span>
                <span>
                  <small>New estimated due</small>
                  <strong>{money(scenarioDue, identity.currency, privateMode)}</strong>
                </span>
              </div>
              <button
                className="otx-button otx-button--primary otx-scenario__button"
                onClick={() => {
                  onToast?.('Scenario opened in Workbench as a reversible draft.');
                }}
                type="button"
              >
                <Icon name="workbench" size={14} />
                Save as Workbench context
              </button>
            </section>
          </div>
        </div>
      ) : null}

      {tab === 'basis' ? (
        <div
          aria-labelledby="otx-basis-tab"
          className="otx-basis"
          id="otx-basis-panel"
          role="region"
        >
          <section className="otx-basis-toolbar">
            <span>
              <h3>Cost basis</h3>
            </span>
            <div aria-label="Cost basis method" className="otx-segment" role="group">
              {[
                ['fifo', 'FIFO'],
                ['average', 'Average'],
                ['specific', 'Specific lot'],
              ].map(([id, label]) => (
                <button
                  aria-pressed={state.basisMethod === id}
                  className={state.basisMethod === id ? 'is-active' : undefined}
                  key={id}
                  onClick={() => patchState({ basisMethod: id as CostBasisMethod })}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          {missing.length ? (
            <section className="otx-missing">
              <div className="otx-section-heading">
                <span>
                  <small>ACTION REQUIRED</small>
                  <h3>Missing cost basis</h3>
                  <p>Attach an explicit assumption and its evidence, or send it to Review.</p>
                </span>
                <span className="otx-count">{missing.length} OPEN</span>
              </div>
              {missing.map((item) => (
                <div className="otx-missing__item" key={item.id}>
                  <div className="otx-missing__identity">
                    <i>{item.symbol.slice(0, 2)}</i>
                    <span>
                      <strong>{item.symbol}</strong>
                      <small>
                        {item.units.toFixed(6)} units · {item.disposed} ·{' '}
                        {money(item.proceeds, identity.currency, privateMode)}
                      </small>
                    </span>
                  </div>
                  <div className="otx-missing__form">
                    <label>
                      <span>Cost-basis assumption</span>
                      <div>
                        <small>{identity.currency}</small>
                        <input
                          aria-label={`${item.symbol} cost basis`}
                          onChange={(event) =>
                            setBasisDrafts((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                          placeholder="e.g. 5,772.00"
                          type="number"
                          value={basisDrafts[item.id] ?? ''}
                        />
                      </div>
                    </label>
                    <label>
                      <span>Evidence</span>
                      <select
                        aria-label={`${item.symbol} cost basis evidence`}
                        onChange={(event) =>
                          setEvidenceDrafts((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                        value={evidenceDrafts[item.id] ?? ''}
                      >
                        <option value="">Select evidence…</option>
                        <option>Broker statement</option>
                        <option>Trade confirmation</option>
                        <option>Wallet / exchange export</option>
                        <option>User-entered assumption</option>
                      </select>
                    </label>
                    <label className="otx-missing__note">
                      <span>Audit note</span>
                      <input
                        aria-label={`${item.symbol} basis note`}
                        onChange={(event) =>
                          setNoteDrafts((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                        placeholder="Why is this value appropriate?"
                        value={noteDrafts[item.id] ?? ''}
                      />
                    </label>
                  </div>
                  <div className="otx-missing__actions">
                    <button
                      className="otx-button otx-button--primary"
                      onClick={() => resolveBasis(item)}
                      type="button"
                    >
                      <Icon name="link" size={13} />
                      Attach resolution
                    </button>
                    <button
                      className="otx-button otx-button--quiet"
                      onClick={() => sendBasisToReview(item)}
                      type="button"
                    >
                      <Icon name="inbox" size={13} />
                      {state.reviewItems[item.id] ? 'Sent to Review' : 'Send to Review'}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          ) : (
            <section className="otx-resolved-banner">
              <span>
                <Icon name="check" size={15} />
              </span>
              <div>
                <strong>Every disposal has a cost-basis path</strong>
                <small>
                  {Object.keys(state.resolutions).length} manual resolution
                  {Object.keys(state.resolutions).length === 1 ? '' : 's'} retained in lineage.
                </small>
              </div>
              <button onClick={onOpenReview} type="button">
                View decision history
                <Icon name="arrow-right" size={13} />
              </button>
            </section>
          )}

          <section className="otx-ledger">
            <div className="otx-ledger__head">
              <span>Asset / disposal</span>
              <span>Proceeds</span>
              <span>Cost basis</span>
              <span>Result</span>
              <span>Estimate</span>
              <span />
            </div>
            {disposals.map((item) => (
              <div className="otx-ledger__group" key={item.id}>
                <button
                  aria-expanded={expanded === item.id}
                  className={item.basis === null ? 'has-warning' : undefined}
                  onClick={() => setExpanded(expanded === item.id ? '' : item.id)}
                  type="button"
                >
                  <span className="otx-ledger__asset">
                    <i>{item.symbol.slice(0, 2)}</i>
                    <span>
                      <strong>{item.symbol}</strong>
                      <small>
                        {item.name} · {item.disposed}
                      </small>
                    </span>
                  </span>
                  <span>{money(item.proceeds, identity.currency, privateMode)}</span>
                  <span className={item.basis === null ? 'is-missing' : undefined}>
                    {item.basis === null
                      ? 'Missing'
                      : money(item.basis, identity.currency, privateMode)}
                  </span>
                  <strong
                    className={
                      item.result === null ? undefined : item.result >= 0 ? 'positive' : 'negative'
                    }
                  >
                    {item.result === null
                      ? '—'
                      : money(item.result, identity.currency, privateMode, true)}
                  </strong>
                  <span>
                    {item.estimatedTax === null
                      ? 'Provisional'
                      : money(-item.estimatedTax, identity.currency, privateMode)}
                  </span>
                  <Icon name={expanded === item.id ? 'chevron-down' : 'chevron-right'} size={14} />
                </button>
                {expanded === item.id ? (
                  <div className="otx-lots">
                    <div className="otx-lots__context">
                      <span>
                        <small>CALCULATION</small>
                        <strong>
                          {state.basisMethod === 'fifo'
                            ? 'Oldest available lots first'
                            : state.basisMethod === 'average'
                              ? 'Weighted average acquisition value'
                              : 'Selected acquisition lot'}
                        </strong>
                      </span>
                      <span>
                        <small>SOURCE</small>
                        <strong>{item.source}</strong>
                      </span>
                      <span>
                        <small>STATUS</small>
                        <strong>
                          {item.resolution ? 'Manual evidence attached' : 'Source-derived'}
                        </strong>
                      </span>
                    </div>
                    <div className="otx-lots__table">
                      <div>
                        <span>Use</span>
                        <span>Acquired</span>
                        <span>Units</span>
                        <span>Acquisition value</span>
                        <span>Fees</span>
                        <span>Lineage</span>
                      </div>
                      {item.lots.map((lot, index) => (
                        <label key={lot.id}>
                          <span>
                            {state.basisMethod === 'specific' ? (
                              <input
                                checked={
                                  (state.selectedLots[item.id] ?? item.lots[0]?.id) === lot.id
                                }
                                name={`lot-${item.id}`}
                                onChange={() =>
                                  patchState({
                                    selectedLots: {
                                      ...state.selectedLots,
                                      [item.id]: lot.id,
                                    },
                                  })
                                }
                                type="radio"
                              />
                            ) : (
                              <i>{index + 1}</i>
                            )}
                          </span>
                          <span>{lot.acquired}</span>
                          <span>{lot.units.toFixed(4)}</span>
                          <span>
                            {lot.cost === null
                              ? 'Missing'
                              : money(lot.cost, identity.currency, privateMode)}
                          </span>
                          <span>{money(lot.fees, identity.currency, privateMode)}</span>
                          <span>{lot.source}</span>
                        </label>
                      ))}
                    </div>
                    <footer>
                      <span>
                        <Icon name="database" size={13} />
                        Original lot records remain unchanged by this simulation.
                      </span>
                      {item.resolution ? (
                        <button onClick={() => removeResolution(item)} type="button">
                          Remove manual resolution
                        </button>
                      ) : (
                        <button onClick={onOpenFiles} type="button">
                          Open supporting files
                        </button>
                      )}
                    </footer>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        </div>
      ) : null}

      {tab === 'reports' ? (
        <div
          aria-labelledby="otx-reports-tab"
          className="otx-reports"
          id="otx-reports-panel"
          role="region"
        >
          <section className="otx-report-builder">
            <div className="otx-section-heading">
              <span>
                <small>REPORT STUDIO</small>
                <h3>Create an accountable snapshot</h3>
                <p>Generated files include assumptions, source IDs, and provisional status.</p>
              </span>
              <span className={cx('otx-status', isProvisional ? 'is-warning' : 'is-ready')}>
                <i />
                {isProvisional ? 'Exports marked provisional' : 'Final demo snapshot'}
              </span>
            </div>
            <div className="otx-report-types">
              {reportTypes.map((item) => (
                <button
                  aria-pressed={reportType === item.id}
                  className={reportType === item.id ? 'is-active' : undefined}
                  key={item.id}
                  onClick={() => setReportType(item.id)}
                  type="button"
                >
                  <span>
                    <Icon name={item.icon} size={16} />
                  </span>
                  <strong>{item.title}</strong>
                  <small>{item.description}</small>
                  <Icon name="chevron-right" size={13} />
                </button>
              ))}
            </div>
            <div className="otx-report-config">
              <label>
                <span>Period</span>
                <strong>{state.year} tax year</strong>
              </label>
              <label>
                <span>Portfolio</span>
                <strong>{identity.name}</strong>
              </label>
              <label>
                <span>Output format</span>
                <select
                  aria-label="Report output format"
                  onChange={(event) => setReportFormat(event.target.value as ExportFormat)}
                  value={reportFormat}
                >
                  <option value="json">Structured JSON</option>
                  <option value="csv">Spreadsheet CSV</option>
                </select>
              </label>
              <button
                className="otx-button otx-button--primary"
                disabled={reportStatus === 'preparing'}
                onClick={generateReport}
                type="button"
              >
                <Icon name={reportStatus === 'preparing' ? 'refresh' : 'download'} size={14} />
                {reportStatus === 'preparing' ? 'Preparing…' : 'Generate export'}
              </button>
            </div>
          </section>

          <section className="otx-report-history">
            <div className="otx-section-heading">
              <span>
                <small>EXPORT HISTORY</small>
                <h3>Generated reports</h3>
              </span>
              <small>Stored only in this browser for the demo</small>
            </div>
            {state.generatedReports.length ? (
              <div className="otx-report-table">
                <div>
                  <span>Report</span>
                  <span>Period</span>
                  <span>Status</span>
                  <span>Created</span>
                  <span>Rows</span>
                  <span />
                </div>
                {state.generatedReports.map((report) => (
                  <div key={report.id}>
                    <span>
                      <i>
                        <Icon name="document" size={14} />
                      </i>
                      <span>
                        <strong>
                          {reportTypes.find((item) => item.id === report.type)?.title}
                        </strong>
                        <small>
                          {report.id} · {report.format.toUpperCase()}
                        </small>
                      </span>
                    </span>
                    <span>{report.year}</span>
                    <span>
                      <b className={report.provisional ? 'is-warning' : 'is-ready'}>
                        {report.provisional ? 'Provisional' : 'Final demo'}
                      </b>
                    </span>
                    <span>
                      {new Intl.DateTimeFormat('en-IE', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      }).format(new Date(report.generatedAt))}
                    </span>
                    <span>{report.rows}</span>
                    <button onClick={() => downloadReport(report)} type="button">
                      <Icon name="download" size={13} />
                      Download
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="otx-report-empty">
                <Icon name="document" size={19} />
                <span>
                  <strong>No reports generated for this portfolio</strong>
                  <small>
                    Choose a report above. The demo creates a real JSON or CSV download.
                  </small>
                </span>
              </div>
            )}
          </section>

          <div className="otx-report-lower">
            <section className="otx-documents">
              <div className="otx-section-heading">
                <span>
                  <small>SOURCE DOCUMENTS</small>
                  <h3>Evidence attached to this position</h3>
                </span>
                <button onClick={onOpenFiles} type="button">
                  Open all files
                  <Icon name="arrow-right" size={13} />
                </button>
              </div>
              {[
                ['Trade Republic · 2026 statement.pdf', 'Broker statement', 'Verified', 'Today'],
                ['Interactive Brokers · activity.csv', 'Execution ledger', 'Matched', '24 Jul'],
                ['Austria · withholding summary.pdf', 'Income evidence', 'Verified', '22 Jul'],
                ['BTC exchange history.csv', 'Acquisition evidence', 'Needs review', '19 Jul'],
              ].map(([name, type, status, date]) => (
                <button key={name} onClick={onOpenFiles} type="button">
                  <span>
                    <Icon name="document" size={14} />
                  </span>
                  <span>
                    <strong>{name}</strong>
                    <small>{type}</small>
                  </span>
                  <b className={status === 'Needs review' ? 'is-warning' : 'is-ready'}>{status}</b>
                  <small>{date}</small>
                  <Icon name="chevron-right" size={13} />
                </button>
              ))}
            </section>

            <section className="otx-accountant">
              <span className="otx-accountant__icon">
                <Icon name="people" size={18} />
              </span>
              <small>ACCOUNTANT COLLABORATION</small>
              <h3>
                {state.accountantShared ? 'Tax workspace shared' : 'Invite without oversharing'}
              </h3>
              <p>
                Grant tax-only access to reports, assumptions, and supporting files. Other portfolio
                tabs remain private.
              </p>
              <ul>
                <li>
                  <Icon name="check" size={12} />
                  Reports and data lineage
                </li>
                <li>
                  <Icon name="check" size={12} />
                  Comment on missing-basis items
                </li>
                <li>
                  <Icon name="lock" size={12} />
                  No trading or portfolio writes
                </li>
              </ul>
              <button
                className="otx-button otx-button--primary"
                onClick={shareWithAccountant}
                type="button"
              >
                <Icon name={state.accountantShared ? 'people' : 'user-plus'} size={14} />
                {state.accountantShared ? 'Manage tax access' : 'Invite accountant'}
              </button>
              <button className="otx-button otx-button--quiet" onClick={onOpenReview} type="button">
                View access receipts
              </button>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default OriginTax;
