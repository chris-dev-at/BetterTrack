import { useEffect, useState } from 'react';

import { Icon, type IconName } from './Icons';
import './origin-analytics.css';

type AnalyticsTab = 'xray' | 'risk' | 'fees' | 'income' | 'reports';
type AnalyticsPeriod = '1Y' | '3Y' | '5Y' | 'MAX';

export type OriginAnalyticsProps = {
  privateMode: boolean;
  scopeName: string;
  onOpenWorkbench?: (context: string) => void;
  onToast?: (message: string) => void;
};

const tabs: Array<{
  id: AnalyticsTab;
  label: string;
  description: string;
  icon: IconName;
}> = [
  { id: 'xray', label: 'X-Ray', description: 'True exposure', icon: 'pie' },
  { id: 'risk', label: 'Risk', description: 'Portfolio risk & stress', icon: 'activity' },
  { id: 'fees', label: 'Fees', description: 'Cost & drag', icon: 'cash' },
  { id: 'income', label: 'Income', description: 'Cash forecast', icon: 'calendar' },
  { id: 'reports', label: 'Reports', description: 'Studio & access', icon: 'document' },
];

const euro = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

const euroPrecise = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function Money({
  value,
  privateMode,
  precise = false,
}: {
  value: number;
  privateMode: boolean;
  precise?: boolean;
}) {
  if (privateMode) return <span aria-label="Hidden value">••••••</span>;
  return <>{precise ? euroPrecise.format(value) : euro.format(value)}</>;
}

function Segment<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div aria-label={ariaLabel} className="oa-segment" role="group">
      {options.map((option) => (
        <button
          aria-pressed={value === option.id}
          className={value === option.id ? 'is-active' : undefined}
          key={option.id}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type ExposureDimension = 'sectors' | 'countries' | 'currencies' | 'issuers';
type ExposureMode = 'direct' | 'lookthrough';

const exposureSets: Record<
  ExposureDimension,
  Array<{
    label: string;
    direct: number;
    lookthrough: number;
    delta: number;
    source: string;
    tone: string;
  }>
> = {
  sectors: [
    {
      label: 'Technology',
      direct: 14.2,
      lookthrough: 26.8,
      delta: 12.6,
      source: '312 underlying positions',
      tone: 'blue',
    },
    {
      label: 'Financials',
      direct: 3.8,
      lookthrough: 14.1,
      delta: 10.3,
      source: '184 underlying positions',
      tone: 'green',
    },
    {
      label: 'Industrials',
      direct: 7.6,
      lookthrough: 12.4,
      delta: 4.8,
      source: '146 underlying positions',
      tone: 'gold',
    },
    {
      label: 'Consumer',
      direct: 6.1,
      lookthrough: 11.8,
      delta: 5.7,
      source: '193 underlying positions',
      tone: 'rose',
    },
    {
      label: 'Healthcare',
      direct: 2.2,
      lookthrough: 10.7,
      delta: 8.5,
      source: '127 underlying positions',
      tone: 'violet',
    },
    {
      label: 'Other',
      direct: 66.1,
      lookthrough: 24.2,
      delta: -41.9,
      source: 'Cash, property, and 8 sectors',
      tone: 'muted',
    },
  ],
  countries: [
    {
      label: 'United States',
      direct: 21.4,
      lookthrough: 54.8,
      delta: 33.4,
      source: '1,042 underlying positions',
      tone: 'blue',
    },
    {
      label: 'Austria',
      direct: 27.8,
      lookthrough: 18.2,
      delta: -9.6,
      source: 'Property, cash, and 11 issuers',
      tone: 'gold',
    },
    {
      label: 'Eurozone ex AT',
      direct: 13.9,
      lookthrough: 10.6,
      delta: -3.3,
      source: '298 underlying positions',
      tone: 'green',
    },
    {
      label: 'Japan',
      direct: 0,
      lookthrough: 5.9,
      delta: 5.9,
      source: '164 underlying positions',
      tone: 'rose',
    },
    {
      label: 'United Kingdom',
      direct: 1.8,
      lookthrough: 4.7,
      delta: 2.9,
      source: '94 underlying positions',
      tone: 'violet',
    },
    {
      label: 'Other',
      direct: 35.1,
      lookthrough: 5.8,
      delta: -29.3,
      source: '37 countries',
      tone: 'muted',
    },
  ],
  currencies: [
    {
      label: 'EUR',
      direct: 72.8,
      lookthrough: 43.6,
      delta: -29.2,
      source: 'Base and reporting currency',
      tone: 'gold',
    },
    {
      label: 'USD',
      direct: 22.1,
      lookthrough: 42.9,
      delta: 20.8,
      source: 'Economic exposure, unhedged',
      tone: 'blue',
    },
    {
      label: 'JPY',
      direct: 0,
      lookthrough: 4.9,
      delta: 4.9,
      source: 'ETF underlying exposure',
      tone: 'rose',
    },
    {
      label: 'GBP',
      direct: 1.4,
      lookthrough: 3.8,
      delta: 2.4,
      source: 'ETF and direct holdings',
      tone: 'green',
    },
    {
      label: 'CHF',
      direct: 0.9,
      lookthrough: 2.7,
      delta: 1.8,
      source: 'ETF underlying exposure',
      tone: 'violet',
    },
    {
      label: 'Other',
      direct: 2.8,
      lookthrough: 2.1,
      delta: -0.7,
      source: '13 currencies',
      tone: 'muted',
    },
  ],
  issuers: [
    {
      label: 'Vanguard',
      direct: 38.4,
      lookthrough: 38.4,
      delta: 0,
      source: 'VWCE · 1 fund',
      tone: 'gold',
    },
    {
      label: 'Apple',
      direct: 13.6,
      lookthrough: 15.2,
      delta: 1.6,
      source: 'Direct + 4 funds',
      tone: 'blue',
    },
    {
      label: 'Microsoft',
      direct: 8.6,
      lookthrough: 10.1,
      delta: 1.5,
      source: 'Direct + 5 funds',
      tone: 'green',
    },
    {
      label: 'BlackRock',
      direct: 5.2,
      lookthrough: 5.2,
      delta: 0,
      source: '2 iShares funds',
      tone: 'rose',
    },
    {
      label: 'Bitcoin',
      direct: 10,
      lookthrough: 10,
      delta: 0,
      source: 'Direct crypto position',
      tone: 'violet',
    },
    {
      label: 'Other',
      direct: 24.2,
      lookthrough: 21.1,
      delta: -3.1,
      source: '2,184 underlying issuers',
      tone: 'muted',
    },
  ],
};

const overlapPairs = [
  {
    left: 'VWCE',
    right: 'IWDA',
    direct: 0,
    underlying: 83.7,
    duplicateValue: 21840,
    note: '1,278 shared companies',
  },
  {
    left: 'VWCE',
    right: 'AAPL',
    direct: 0,
    underlying: 4.2,
    duplicateValue: 11964,
    note: 'Direct position plus 4.2% fund weight',
  },
  {
    left: 'VWCE',
    right: 'MSFT',
    direct: 0,
    underlying: 3.9,
    duplicateValue: 11112,
    note: 'Direct position plus 3.9% fund weight',
  },
  {
    left: 'IWDA',
    right: 'S&P 500',
    direct: 0,
    underlying: 67.4,
    duplicateValue: 13720,
    note: '413 shared companies',
  },
];

function XRayTab({ privateMode }: { privateMode: boolean }) {
  const [mode, setMode] = useState<ExposureMode>('lookthrough');
  const [dimension, setDimension] = useState<ExposureDimension>('sectors');
  const [selectedOverlap, setSelectedOverlap] = useState(0);
  const rows = exposureSets[dimension];
  const overlap = overlapPairs[selectedOverlap]!;
  const concentrated = rows[0]!;

  return (
    <div className="oa-tab-panel oa-xray">
      <section className="oa-kpi-strip">
        <article>
          <small>Visible holdings</small>
          <strong>18</strong>
          <span>4 funds · 5 asset classes</span>
        </article>
        <article>
          <small>Underlying positions</small>
          <strong>2,418</strong>
          <span className="is-positive">97.8% resolved</span>
        </article>
        <article>
          <small>Largest true exposure</small>
          <strong>{concentrated.lookthrough}%</strong>
          <span>{concentrated.label}</span>
        </article>
        <article>
          <small>Hidden overlap</small>
          <strong>€46.7K</strong>
          <span className="is-warning">Across 4 relationships</span>
        </article>
      </section>

      <section className="oa-module oa-exposure">
        <header className="oa-module-heading">
          <div>
            <small>PORTFOLIO X-RAY</small>
            <h2>What you actually own</h2>
            <p>
              Resolve funds, ETFs, and nested portfolios into their underlying economic exposure.
            </p>
          </div>
          <Segment
            ariaLabel="Exposure depth"
            onChange={setMode}
            options={[
              { id: 'direct', label: 'Direct' },
              { id: 'lookthrough', label: 'Look-through' },
            ]}
            value={mode}
          />
        </header>
        <div className="oa-dimension-tabs" role="tablist" aria-label="Exposure dimension">
          {(
            [
              ['sectors', 'Sectors'],
              ['countries', 'Countries'],
              ['currencies', 'Currencies'],
              ['issuers', 'Issuers'],
            ] as Array<[ExposureDimension, string]>
          ).map(([id, label]) => (
            <button
              aria-selected={dimension === id}
              className={dimension === id ? 'is-active' : undefined}
              key={id}
              onClick={() => setDimension(id)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="oa-exposure-layout">
          <div className="oa-exposure-bars">
            {rows.map((row) => {
              const value = mode === 'direct' ? row.direct : row.lookthrough;
              return (
                <div className="oa-exposure-row" key={row.label}>
                  <span>
                    <strong>{row.label}</strong>
                    <small>{row.source}</small>
                  </span>
                  <div>
                    <i
                      className={`is-${row.tone}`}
                      style={{ '--oa-width': `${Math.max(value, 1)}%` } as React.CSSProperties}
                    />
                    {mode === 'lookthrough' && row.direct > 0 ? (
                      <em style={{ '--oa-marker': `${row.direct}%` } as React.CSSProperties} />
                    ) : null}
                  </div>
                  <strong>{value.toFixed(1)}%</strong>
                  <span className={row.delta > 0 ? 'is-warning' : row.delta < 0 ? 'is-muted' : ''}>
                    {mode === 'lookthrough'
                      ? `${row.delta > 0 ? '+' : ''}${row.delta.toFixed(1)} pp`
                      : 'direct'}
                  </span>
                </div>
              );
            })}
          </div>
          <aside className="oa-xray-explainer">
            <span className="oa-xray-orbit" aria-hidden="true">
              <i />
              <i />
              <i />
              <strong>{concentrated.lookthrough}%</strong>
            </span>
            <small>LOOK-THROUGH FINDING</small>
            <h3>{concentrated.label} is larger than it first appears.</h3>
            <p>
              Direct holdings show {concentrated.direct.toFixed(1)}%. Resolving fund constituents
              increases the economic exposure by {concentrated.delta.toFixed(1)} percentage points.
            </p>
            <dl>
              <div>
                <dt>Covered market value</dt>
                <dd>
                  <Money privateMode={privateMode} value={278610} />
                </dd>
              </div>
              <div>
                <dt>As-of dates</dt>
                <dd>24–27 Jul</dd>
              </div>
              <div>
                <dt>Stale constituents</dt>
                <dd className="is-warning">1 fund · 3d</dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>

      <div className="oa-two-column">
        <section className="oa-module oa-overlap">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>DIRECT + INDIRECT</small>
              <h2>Overlap map</h2>
              <p>Pairs that create more concentration than their labels suggest.</p>
            </div>
            <span className="oa-data-badge">
              <Icon name="layers" size={13} /> Full constituent match
            </span>
          </header>
          <div className="oa-overlap-list">
            {overlapPairs.map((pair, index) => (
              <button
                className={selectedOverlap === index ? 'is-active' : undefined}
                key={`${pair.left}-${pair.right}`}
                onClick={() => setSelectedOverlap(index)}
                type="button"
              >
                <span>
                  <i>{pair.left.slice(0, 2)}</i>
                  <i>{pair.right.slice(0, 2)}</i>
                </span>
                <span>
                  <strong>
                    {pair.left} ↔ {pair.right}
                  </strong>
                  <small>{pair.note}</small>
                </span>
                <span>
                  <strong>{pair.underlying}%</strong>
                  <small>overlap</small>
                </span>
                <Icon name="chevron-right" size={13} />
              </button>
            ))}
          </div>
          <footer className="oa-overlap-detail">
            <span>
              <small>SELECTED RELATIONSHIP</small>
              <strong>
                {overlap.left} and {overlap.right}
              </strong>
            </span>
            <span>
              <small>Direct overlap</small>
              <strong>{overlap.direct}%</strong>
            </span>
            <span>
              <small>Underlying overlap</small>
              <strong>{overlap.underlying}%</strong>
            </span>
            <span>
              <small>Duplicate exposure</small>
              <strong>
                <Money privateMode={privateMode} value={overlap.duplicateValue} />
              </strong>
            </span>
          </footer>
        </section>

        <section className="oa-module oa-coverage">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>DATA CONFIDENCE</small>
              <h2>Coverage & freshness</h2>
              <p>Every calculated exposure stays attached to its source and date.</p>
            </div>
            <strong className="oa-coverage-score">97.8%</strong>
          </header>
          <div className="oa-coverage-meter">
            <i />
            <span>
              <em style={{ width: '97.8%' }} />
            </span>
            <strong>Resolved</strong>
          </div>
          {[
            ['VWCE constituents', '2,136 rows', '27 Jul · verified', 'green'],
            ['IWDA constituents', '1,309 rows', '24 Jul · 3 days old', 'amber'],
            ['Property valuation', '1 record', '12 Jul · owner supplied', 'blue'],
            ['Private asset mapping', '2 records', 'Classification needed', 'red'],
          ].map(([name, count, status, tone]) => (
            <button className="oa-coverage-row" key={name} type="button">
              <i className={`is-${tone}`} />
              <span>
                <strong>{name}</strong>
                <small>{count}</small>
              </span>
              <span>{status}</span>
              <Icon name="chevron-right" size={12} />
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}

const stressScenarios = [
  {
    id: 'rates',
    name: 'Rates +200 bps',
    description: 'Parallel yield-curve shift with equity repricing',
    impact: -8.4,
    recovery: '14–22 months',
    factors: [
      ['Equities', -12840],
      ['Bonds', -4920],
      ['Property', -6130],
      ['Cash', 720],
    ],
  },
  {
    id: 'equity',
    name: 'Global equities −30%',
    description: 'Broad risk-off shock using observed portfolio beta',
    impact: -17.9,
    recovery: '19–31 months',
    factors: [
      ['Equities', -48920],
      ['Crypto', -8540],
      ['Property', -2010],
      ['Cash', 0],
    ],
  },
  {
    id: 'eur',
    name: 'EUR strengthens 15%',
    description: 'Unhedged foreign exposure translated to EUR',
    impact: -6.1,
    recovery: 'Currency dependent',
    factors: [
      ['USD exposure', -14210],
      ['JPY exposure', -1820],
      ['GBP exposure', -740],
      ['EUR assets', 0],
    ],
  },
  {
    id: 'property',
    name: 'Property −20%',
    description: 'Illiquid valuation shock with mortgage unchanged',
    impact: -8.7,
    recovery: '5+ years',
    factors: [
      ['Property', -27680],
      ['Mortgage LTV', -8120],
      ['Equities', 0],
      ['Cash', 0],
    ],
  },
];

const correlationLabels = ['Portfolio', 'VWCE', 'Property', 'BTC', 'Cash'];
const correlations = [
  [1, 0.84, 0.22, 0.39, 0.03],
  [0.84, 1, 0.17, 0.45, 0.01],
  [0.22, 0.17, 1, 0.09, 0.04],
  [0.39, 0.45, 0.09, 1, -0.02],
  [0.03, 0.01, 0.04, -0.02, 1],
];

function RiskTab({
  privateMode,
  period,
  openWorkbench,
}: {
  privateMode: boolean;
  period: AnalyticsPeriod;
  openWorkbench: (context: string) => void;
}) {
  const [riskMode, setRiskMode] = useState<'absolute' | 'relative'>('absolute');
  const [scenarioId, setScenarioId] = useState(stressScenarios[1]!.id);
  const [intensity, setIntensity] = useState(100);
  const [selectedCorrelation, setSelectedCorrelation] = useState<[number, number]>([0, 1]);
  const scenario = stressScenarios.find((item) => item.id === scenarioId) ?? stressScenarios[0]!;
  const scaledImpact = scenario.impact * (intensity / 100);
  const selectedCorrelationValue = correlations[selectedCorrelation[0]]![selectedCorrelation[1]]!;

  return (
    <div className="oa-tab-panel oa-risk">
      <section className="oa-kpi-strip oa-kpi-strip--risk">
        {[
          [
            'Volatility',
            riskMode === 'absolute' ? '8.42%' : '−3.18 pp',
            '5Y annualized',
            'activity',
          ],
          ['Beta', '0.78', 'vs MSCI ACWI', 'layers'],
          ['Max drawdown', '−8.91%', 'Recovered in 7 mo', 'arrow-down'],
          ['95% daily VaR', '−1.72%', '≈ €4,900', 'shield'],
        ].map(([label, value, detail, icon], index) => (
          <article key={label}>
            <span>
              <Icon name={icon as IconName} size={14} />
            </span>
            <small>{label}</small>
            <strong className={index > 1 ? 'is-negative' : ''}>{value}</strong>
            <em>{privateMode && detail?.includes('€') ? 'Hidden value' : detail}</em>
          </article>
        ))}
      </section>

      <section className="oa-module oa-risk-history">
        <header className="oa-module-heading">
          <div>
            <small>RISK THROUGH TIME</small>
            <h2>Drawdown and rolling volatility</h2>
            <p>{period} observation · daily portfolio snapshots · MSCI ACWI comparison</p>
          </div>
          <Segment
            ariaLabel="Risk display"
            onChange={setRiskMode}
            options={[
              { id: 'absolute', label: 'Absolute' },
              { id: 'relative', label: 'vs benchmark' },
            ]}
            value={riskMode}
          />
        </header>
        <div className="oa-risk-chart">
          <div className="oa-risk-chart__legend">
            <span>
              <i /> Portfolio drawdown
            </span>
            <span>
              <i /> Rolling volatility
            </span>
            <span>
              <i /> Benchmark drawdown
            </span>
          </div>
          <svg
            aria-label="Drawdown and volatility history"
            preserveAspectRatio="none"
            viewBox="0 0 1000 290"
          >
            <defs>
              <linearGradient id="oa-drawdown-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#fb7185" stopOpacity=".03" />
                <stop offset="1" stopColor="#fb7185" stopOpacity=".2" />
              </linearGradient>
            </defs>
            <g className="oa-chart-grid">
              {[40, 95, 150, 205, 260].map((y) => (
                <line key={y} x1="0" x2="1000" y1={y} y2={y} />
              ))}
            </g>
            <path
              className="oa-risk-chart__area"
              d="M0 42 L34 48 L68 45 L102 67 L136 52 L170 91 L204 72 L238 112 L272 78 L306 139 L340 166 L374 116 L408 104 L442 183 L476 207 L510 161 L544 131 L578 92 L612 120 L646 79 L680 86 L714 61 L748 96 L782 70 L816 54 L850 76 L884 49 L918 58 L952 44 L1000 47 L1000 42 L0 42Z"
            />
            <path
              className="oa-risk-chart__drawdown"
              d="M0 42 L34 48 L68 45 L102 67 L136 52 L170 91 L204 72 L238 112 L272 78 L306 139 L340 166 L374 116 L408 104 L442 183 L476 207 L510 161 L544 131 L578 92 L612 120 L646 79 L680 86 L714 61 L748 96 L782 70 L816 54 L850 76 L884 49 L918 58 L952 44 L1000 47"
            />
            <path
              className="oa-risk-chart__benchmark"
              d="M0 44 L68 50 L136 59 L204 83 L272 91 L340 181 L408 132 L476 226 L544 148 L612 138 L680 94 L748 112 L816 69 L884 63 L952 52 L1000 49"
            />
            <path
              className="oa-risk-chart__volatility"
              d="M0 215 C80 212 110 185 170 202 S260 193 320 146 S410 176 470 105 S570 145 630 184 S730 192 790 166 S900 204 1000 178"
            />
            <circle cx="476" cy="207" r="4" className="oa-risk-chart__event" />
          </svg>
          <div className="oa-chart-axis">
            <span>Aug 2021</span>
            <span>Jul 2022</span>
            <span>Jul 2023</span>
            <span>Jul 2024</span>
            <span>Jul 2025</span>
            <span>Today</span>
          </div>
          <footer>
            <span>
              <small>Worst period</small>
              <strong>11 Apr–18 May 2024 · −8.91%</strong>
            </span>
            <span>
              <small>Recovery</small>
              <strong>7 months · 146 trading days</strong>
            </span>
            <span>
              <small>Current drawdown</small>
              <strong className="is-positive">−0.42% · near high</strong>
            </span>
          </footer>
        </div>
      </section>

      <div className="oa-two-column oa-two-column--risk">
        <section className="oa-module oa-correlation">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>DIVERSIFICATION</small>
              <h2>Correlation matrix</h2>
              <p>Weekly returns over the current five-year observation window.</p>
            </div>
            <span className="oa-data-badge">Pearson · EUR</span>
          </header>
          <div className="oa-correlation-grid">
            <span />
            {correlationLabels.map((label) => (
              <strong key={`head-${label}`}>{label.slice(0, 4)}</strong>
            ))}
            {correlationLabels.map((rowLabel, rowIndex) => (
              <div className="oa-correlation-row" key={rowLabel}>
                <strong>{rowLabel}</strong>
                {correlations[rowIndex]!.map((value, columnIndex) => (
                  <button
                    aria-label={`${rowLabel} and ${correlationLabels[columnIndex]} correlation ${value.toFixed(2)}`}
                    className={cx(
                      selectedCorrelation[0] === rowIndex &&
                        selectedCorrelation[1] === columnIndex &&
                        'is-selected',
                    )}
                    key={`${rowLabel}-${correlationLabels[columnIndex]}`}
                    onClick={() => setSelectedCorrelation([rowIndex, columnIndex])}
                    style={{ '--oa-correlation': Math.abs(value) } as React.CSSProperties}
                    type="button"
                  >
                    {value.toFixed(2)}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <footer className="oa-correlation-detail">
            <span>
              <small>SELECTED PAIR</small>
              <strong>
                {correlationLabels[selectedCorrelation[0]]} ↔{' '}
                {correlationLabels[selectedCorrelation[1]]}
              </strong>
            </span>
            <span>
              <strong>{selectedCorrelationValue.toFixed(2)}</strong>
              <small>
                {Math.abs(selectedCorrelationValue) > 0.7
                  ? 'Strong relationship'
                  : Math.abs(selectedCorrelationValue) > 0.3
                    ? 'Moderate relationship'
                    : 'Low relationship'}
              </small>
            </span>
          </footer>
        </section>

        <section className="oa-module oa-stress">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>FORWARD-LOOKING</small>
              <h2>Stress laboratory</h2>
              <p>Apply transparent shocks without changing the portfolio.</p>
            </div>
            <button
              className="oa-workbench-link"
              onClick={() => openWorkbench(`stress:${scenario.id}:${intensity}`)}
              type="button"
            >
              Open in Workbench <Icon name="arrow-right" size={12} />
            </button>
          </header>
          <div className="oa-stress-layout">
            <div className="oa-stress-list">
              {stressScenarios.map((item) => (
                <button
                  className={scenario.id === item.id ? 'is-active' : undefined}
                  key={item.id}
                  onClick={() => setScenarioId(item.id)}
                  type="button"
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.description}</small>
                  </span>
                  <strong>{item.impact}%</strong>
                </button>
              ))}
            </div>
            <aside className="oa-stress-result">
              <span>
                <small>SIMULATED IMPACT</small>
                <strong>{scaledImpact.toFixed(1)}%</strong>
                <em>
                  <Money privateMode={privateMode} value={284920 * (scaledImpact / 100)} />
                </em>
              </span>
              <label>
                <span>
                  Shock intensity <strong>{intensity}%</strong>
                </span>
                <input
                  max="150"
                  min="50"
                  onChange={(event) => setIntensity(Number(event.target.value))}
                  step="10"
                  type="range"
                  value={intensity}
                />
              </label>
              <dl>
                {scenario.factors.map(([label, value]) => (
                  <div key={String(label)}>
                    <dt>{label}</dt>
                    <dd className={Number(value) < 0 ? 'is-negative' : 'is-positive'}>
                      <Money privateMode={privateMode} value={Number(value) * (intensity / 100)} />
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                <Icon name="clock" size={12} /> Historical recovery analogue: {scenario.recovery}
              </p>
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}

const feeRows = [
  {
    id: 'fund',
    label: 'Fund TER',
    rate: 0.22,
    annual: 626.82,
    source: 'VWCE, IWDA · issuer factsheets',
    kind: 'Ongoing',
    avoidable: false,
  },
  {
    id: 'advisory',
    label: 'Advisory / platform',
    rate: 0.12,
    annual: 341.9,
    source: 'Northstar advisory agreement',
    kind: 'Service',
    avoidable: true,
  },
  {
    id: 'trading',
    label: 'Trading fees',
    rate: 0.04,
    annual: 113.47,
    source: '46 portfolio transactions',
    kind: 'Explicit',
    avoidable: true,
  },
  {
    id: 'fx',
    label: 'FX conversion',
    rate: 0.03,
    annual: 86.12,
    source: 'Broker activity · 8 conversions',
    kind: 'Explicit',
    avoidable: true,
  },
  {
    id: 'custody',
    label: 'Custody',
    rate: 0,
    annual: 0,
    source: 'Connected broker schedules',
    kind: 'Service',
    avoidable: false,
  },
];

function FeesTab({
  privateMode,
  openWorkbench,
  announce,
}: {
  privateMode: boolean;
  openWorkbench: (context: string) => void;
  announce: (message: string) => void;
}) {
  const [years, setYears] = useState(10);
  const [feeFilter, setFeeFilter] = useState<'all' | 'ongoing' | 'explicit'>('all');
  const [replacement, setReplacement] = useState('SPYI · 0.17% TER');
  const startingValue = 284920;
  const grossReturn = 0.058;
  const currentFeeRate = 0.0041;
  const replacementFeeRate = replacement.startsWith('SPYI') ? 0.0021 : 0.0019;
  const grossFuture = startingValue * (1 + grossReturn) ** years;
  const currentFuture = startingValue * (1 + grossReturn - currentFeeRate) ** years;
  const replacementFuture = startingValue * (1 + grossReturn - replacementFeeRate) ** years;
  const drag = grossFuture - currentFuture;
  const filteredFees = feeRows.filter((fee) => {
    if (feeFilter === 'all') return true;
    if (feeFilter === 'ongoing') return fee.kind !== 'Explicit';
    return fee.kind === 'Explicit';
  });

  return (
    <div className="oa-tab-panel oa-fees">
      <section className="oa-kpi-strip">
        <article>
          <small>Annual cost</small>
          <strong>
            <Money privateMode={privateMode} precise value={1168.31} />
          </strong>
          <span>0.41% of portfolio</span>
        </article>
        <article>
          <small>Weighted TER</small>
          <strong>0.22%</strong>
          <span>4 funds resolved</span>
        </article>
        <article>
          <small>{years}-year modeled drag</small>
          <strong>
            <Money privateMode={privateMode} value={drag} />
          </strong>
          <span className="is-warning">Fees plus lost compounding</span>
        </article>
        <article>
          <small>Traceability</small>
          <strong>100%</strong>
          <span className="is-positive">Every cost sourced</span>
        </article>
      </section>

      <section className="oa-module oa-fee-ledger">
        <header className="oa-module-heading">
          <div>
            <small>COST LEDGER</small>
            <h2>Every fee, with its source</h2>
            <p>Explicit charges and embedded product costs use the same traceable view.</p>
          </div>
          <Segment
            ariaLabel="Fee type"
            onChange={setFeeFilter}
            options={[
              { id: 'all', label: 'All costs' },
              { id: 'ongoing', label: 'Ongoing' },
              { id: 'explicit', label: 'Explicit' },
            ]}
            value={feeFilter}
          />
        </header>
        <div className="oa-fee-table">
          <div className="oa-fee-table__head">
            <span>Cost</span>
            <span>Type</span>
            <span>Rate</span>
            <span>Annualized</span>
            <span>Evidence</span>
            <span />
          </div>
          {filteredFees.map((fee) => (
            <button
              className="oa-fee-row"
              key={fee.id}
              onClick={() => announce(`${fee.label} source evidence opened`)}
              type="button"
            >
              <span>
                <i className={fee.avoidable ? 'is-reviewable' : ''}>
                  <Icon name={fee.kind === 'Explicit' ? 'cash' : 'document'} size={14} />
                </i>
                <span>
                  <strong>{fee.label}</strong>
                  <small>
                    {fee.avoidable ? 'Potentially optimizable' : 'Expected product cost'}
                  </small>
                </span>
              </span>
              <span>{fee.kind}</span>
              <strong>{fee.rate.toFixed(2)}%</strong>
              <strong>
                <Money privateMode={privateMode} precise value={fee.annual} />
              </strong>
              <span>
                <Icon name="link" size={11} /> {fee.source}
              </span>
              <Icon name="chevron-right" size={12} />
            </button>
          ))}
        </div>
      </section>

      <div className="oa-two-column oa-two-column--fees">
        <section className="oa-module oa-fee-drag">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>COMPOUNDING</small>
              <h2>Long-term fee drag</h2>
              <p>Same gross return and contributions; only cost assumptions change.</p>
            </div>
            <span className="oa-data-badge">5.8% gross return</span>
          </header>
          <div className="oa-fee-horizon">
            <label>
              <span>
                Horizon <strong>{years} years</strong>
              </span>
              <input
                aria-label="Fee drag horizon"
                max="20"
                min="5"
                onChange={(event) => setYears(Number(event.target.value))}
                step="5"
                type="range"
                value={years}
              />
              <span>
                <small>5 years</small>
                <small>10 years</small>
                <small>15 years</small>
                <small>20 years</small>
              </span>
            </label>
            <div className="oa-fee-bars">
              {[
                ['Before fees', grossFuture, 100, 'gross'],
                [
                  'Current portfolio',
                  currentFuture,
                  (currentFuture / grossFuture) * 100,
                  'current',
                ],
                [
                  'Lower-cost model',
                  replacementFuture,
                  (replacementFuture / grossFuture) * 100,
                  'model',
                ],
              ].map(([label, value, width, tone]) => (
                <div key={String(label)}>
                  <span>
                    <strong>{label}</strong>
                    <em>
                      <Money privateMode={privateMode} value={Number(value)} />
                    </em>
                  </span>
                  <i>
                    <em className={`is-${tone}`} style={{ width: `${Number(width)}%` }} />
                  </i>
                </div>
              ))}
            </div>
            <footer>
              <span>
                <small>Direct fees paid</small>
                <strong>
                  <Money privateMode={privateMode} value={1168.31 * years} />
                </strong>
              </span>
              <span>
                <small>Lost compounding</small>
                <strong>
                  <Money privateMode={privateMode} value={Math.max(0, drag - 1168.31 * years)} />
                </strong>
              </span>
              <span>
                <small>Total drag</small>
                <strong className="is-negative">
                  <Money privateMode={privateMode} value={drag} />
                </strong>
              </span>
            </footer>
          </div>
        </section>

        <section className="oa-module oa-fee-model">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>MODEL REPLACEMENT</small>
              <h2>Test a cheaper implementation</h2>
              <p>This comparison stays hypothetical until opened and reviewed in Workbench.</p>
            </div>
            <span className="oa-model-badge">DRAFT</span>
          </header>
          <div className="oa-model-swap">
            <span>
              <small>CURRENT CORE</small>
              <strong>VWCE · Vanguard All-World</strong>
              <em>0.22% TER · 3,653 constituents</em>
            </span>
            <Icon name="arrow-right" size={17} />
            <label>
              <small>REPLACEMENT</small>
              <select onChange={(event) => setReplacement(event.target.value)} value={replacement}>
                <option>SPYI · 0.17% TER</option>
                <option>FWRA · 0.15% TER</option>
              </select>
              <em>
                {replacement.startsWith('SPYI')
                  ? '3,400 constituents · sampling'
                  : '2,100 constituents · sampling'}
              </em>
            </label>
          </div>
          <dl className="oa-model-diff">
            <div>
              <dt>Annual cost difference</dt>
              <dd className="is-positive">
                −<Money privateMode={privateMode} precise value={142.46} />
              </dd>
            </div>
            <div>
              <dt>{years}-year projected benefit</dt>
              <dd className="is-positive">
                +<Money privateMode={privateMode} value={replacementFuture - currentFuture} />
              </dd>
            </div>
            <div>
              <dt>Estimated overlap</dt>
              <dd>92.4%</dd>
            </div>
            <div>
              <dt>Realization / tax</dt>
              <dd className="is-warning">Review required</dd>
            </div>
          </dl>
          <button
            className="oa-primary-action"
            onClick={() => openWorkbench(`fee-replacement:${replacement}`)}
            type="button"
          >
            <Icon name="workbench" size={14} />
            Model replacement in Workbench
            <Icon name="arrow-right" size={12} />
          </button>
        </section>
      </div>
    </div>
  );
}

const monthlyIncome = [
  { month: 'Aug', received: 0, announced: 128, estimated: 92, events: 3 },
  { month: 'Sep', received: 0, announced: 184, estimated: 146, events: 4 },
  { month: 'Oct', received: 0, announced: 72, estimated: 178, events: 3 },
  { month: 'Nov', received: 0, announced: 64, estimated: 94, events: 2 },
  { month: 'Dec', received: 0, announced: 118, estimated: 326, events: 5 },
  { month: 'Jan', received: 214, announced: 0, estimated: 0, events: 4 },
  { month: 'Feb', received: 92, announced: 0, estimated: 0, events: 2 },
  { month: 'Mar', received: 448, announced: 0, estimated: 0, events: 7 },
  { month: 'Apr', received: 136, announced: 0, estimated: 0, events: 3 },
  { month: 'May', received: 188, announced: 0, estimated: 0, events: 4 },
  { month: 'Jun', received: 512, announced: 0, estimated: 0, events: 8 },
  { month: 'Jul', received: 244, announced: 67, estimated: 0, events: 5 },
];

const incomeCalendar = [
  ['05 Aug', 'Microsoft', 'Dividend', 'Announced', 67.84, 'Personal wealth'],
  ['12 Aug', 'Vanguard FTSE All-World', 'Distribution', 'Estimated', 42.18, 'Personal wealth'],
  ['19 Aug', 'Northstar loan note', 'Interest', 'Contracted', 18.42, 'Northstar Studio'],
  ['04 Sep', 'Apple', 'Dividend', 'Estimated', 54.06, 'Personal wealth'],
  ['26 Sep', 'iShares Core MSCI World', 'Distribution', 'Announced', 129.88, 'Family reserve'],
  ['01 Oct', 'Cash reserve', 'Interest', 'Estimated', 22.34, 'Personal wealth'],
];

function IncomeTab({
  privateMode,
  announce,
}: {
  privateMode: boolean;
  announce: (message: string) => void;
}) {
  const [horizon, setHorizon] = useState<'12m' | '5y'>('12m');
  const [incomeType, setIncomeType] = useState<'all' | 'dividends' | 'interest'>('all');
  const [selectedMonth, setSelectedMonth] = useState(0);
  const factor = incomeType === 'interest' ? 0.16 : incomeType === 'dividends' ? 0.84 : 1;
  const maxIncome = Math.max(
    ...monthlyIncome.map((item) => (item.received + item.announced + item.estimated) * factor),
  );

  return (
    <div className="oa-tab-panel oa-income">
      <section className="oa-kpi-strip">
        <article>
          <small>Received YTD</small>
          <strong>
            <Money privateMode={privateMode} value={1834} />
          </strong>
          <span className="is-positive">+8.7% vs last year</span>
        </article>
        <article>
          <small>Next 12 months</small>
          <strong>
            <Money privateMode={privateMode} value={2946} />
          </strong>
          <span>€633 announced · €2,313 estimated</span>
        </article>
        <article>
          <small>Forward yield</small>
          <strong>1.86%</strong>
          <span>2.41% yield on cost</span>
        </article>
        <article>
          <small>Withholding YTD</small>
          <strong>
            <Money privateMode={privateMode} value={412} />
          </strong>
          <span>22.5% effective · 3 countries</span>
        </article>
      </section>

      <section className="oa-module oa-income-forecast">
        <header className="oa-module-heading">
          <div>
            <small>RECEIVED + EXPECTED</small>
            <h2>Portfolio income forecast</h2>
            <p>Separate cash already received from announced and model-estimated income.</p>
          </div>
          <div className="oa-inline-controls">
            <Segment
              ariaLabel="Income horizon"
              onChange={setHorizon}
              options={[
                { id: '12m', label: '12 months' },
                { id: '5y', label: '5 years' },
              ]}
              value={horizon}
            />
            <select
              aria-label="Income type"
              onChange={(event) => setIncomeType(event.target.value as typeof incomeType)}
              value={incomeType}
            >
              <option value="all">All income</option>
              <option value="dividends">Dividends</option>
              <option value="interest">Interest</option>
            </select>
          </div>
        </header>
        <div className="oa-income-chart">
          <div className="oa-income-chart__legend">
            <span>
              <i className="is-received" /> Received
            </span>
            <span>
              <i className="is-announced" /> Announced
            </span>
            <span>
              <i className="is-estimated" /> Estimated
            </span>
            <em>{horizon === '12m' ? 'Aug 2025–Jul 2026' : '2026–2030 modeled'}</em>
          </div>
          <div className="oa-income-bars">
            {monthlyIncome.map((item, index) => {
              const total = (item.received + item.announced + item.estimated) * factor;
              return (
                <button
                  aria-label={`${item.month}, ${euroPrecise.format(total)} forecast income`}
                  className={selectedMonth === index ? 'is-active' : undefined}
                  key={item.month}
                  onClick={() => setSelectedMonth(index)}
                  type="button"
                >
                  <span>
                    <i
                      className="is-estimated"
                      style={{
                        height: `${((item.estimated * factor) / maxIncome) * 100}%`,
                      }}
                    />
                    <i
                      className="is-announced"
                      style={{
                        height: `${((item.announced * factor) / maxIncome) * 100}%`,
                      }}
                    />
                    <i
                      className="is-received"
                      style={{
                        height: `${((item.received * factor) / maxIncome) * 100}%`,
                      }}
                    />
                  </span>
                  <small>{item.month}</small>
                </button>
              );
            })}
          </div>
          <footer>
            <span>
              <small>{monthlyIncome[selectedMonth]!.month} total</small>
              <strong>
                <Money
                  privateMode={privateMode}
                  precise
                  value={
                    (monthlyIncome[selectedMonth]!.received +
                      monthlyIncome[selectedMonth]!.announced +
                      monthlyIncome[selectedMonth]!.estimated) *
                    factor
                  }
                />
              </strong>
            </span>
            <span>
              <small>Confidence</small>
              <strong>
                {monthlyIncome[selectedMonth]!.received > 0
                  ? 'Received'
                  : monthlyIncome[selectedMonth]!.announced > 0
                    ? 'Announced + modeled'
                    : 'Modeled'}
              </strong>
            </span>
            <span>
              <small>Events</small>
              <strong>{monthlyIncome[selectedMonth]!.events}</strong>
            </span>
            <button onClick={() => announce('Income assumptions opened')} type="button">
              Inspect assumptions <Icon name="arrow-right" size={12} />
            </button>
          </footer>
        </div>
      </section>

      <div className="oa-two-column oa-two-column--income">
        <section className="oa-module oa-income-quality">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>INCOME QUALITY</small>
              <h2>Yield, growth, and withholding</h2>
              <p>Understand how much reaches cash and what drives the estimate.</p>
            </div>
            <span className="oa-data-badge">18 income assets</span>
          </header>
          <div className="oa-income-quality-grid">
            <article>
              <span className="oa-ring" style={{ '--oa-ring': '73%' } as React.CSSProperties}>
                <strong>73%</strong>
              </span>
              <span>
                <small>Dividend coverage</small>
                <strong>Announced or historically stable</strong>
                <em>11 of 15 dividend-paying holdings</em>
              </span>
            </article>
            <article>
              <small>Yield on market value</small>
              <strong>1.86%</strong>
              <span>Current forward income / value</span>
            </article>
            <article>
              <small>Yield on cost</small>
              <strong>2.41%</strong>
              <span>Forward income / invested basis</span>
            </article>
            <article>
              <small>5Y income growth</small>
              <strong className="is-positive">+6.8% p.a.</strong>
              <span>Like-for-like holdings</span>
            </article>
            <article>
              <small>Gross forecast</small>
              <strong>
                <Money privateMode={privateMode} value={3358} />
              </strong>
              <span>Before withholding</span>
            </article>
            <article>
              <small>Net forecast</small>
              <strong>
                <Money privateMode={privateMode} value={2946} />
              </strong>
              <span>After estimated withholding</span>
            </article>
          </div>
        </section>

        <section className="oa-module oa-income-calendar">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>NEXT 90 DAYS</small>
              <h2>Income calendar</h2>
              <p>Payment dates, confidence, and destination portfolio.</p>
            </div>
            <button
              className="oa-workbench-link"
              onClick={() => announce('Income calendar exported')}
              type="button"
            >
              <Icon name="download" size={12} /> Export
            </button>
          </header>
          <div className="oa-calendar-list">
            {incomeCalendar.map(([date, asset, kind, status, amount, portfolio]) => (
              <button key={`${date}-${asset}`} type="button">
                <time>{date}</time>
                <span>
                  <strong>{asset}</strong>
                  <small>
                    {kind} · {portfolio}
                  </small>
                </span>
                <span className={`is-${String(status).toLowerCase()}`}>{status}</span>
                <strong>
                  <Money privateMode={privateMode} precise value={Number(amount)} />
                </strong>
                <Icon name="chevron-right" size={12} />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

type ReportModuleId =
  | 'performance'
  | 'contribution'
  | 'exposure'
  | 'income'
  | 'fees'
  | 'wealth'
  | 'tax';

const reportModules: Array<{
  id: ReportModuleId;
  label: string;
  description: string;
  icon: IconName;
}> = [
  {
    id: 'performance',
    label: 'Performance',
    description: 'Value, return, drawdown, benchmark',
    icon: 'activity',
  },
  {
    id: 'contribution',
    label: 'Contribution',
    description: 'Assets and decisions that moved value',
    icon: 'layers',
  },
  {
    id: 'exposure',
    label: 'Exposure',
    description: 'Allocation and look-through X-Ray',
    icon: 'pie',
  },
  {
    id: 'income',
    label: 'Income',
    description: 'Received, forecast, withholding',
    icon: 'calendar',
  },
  {
    id: 'fees',
    label: 'Fees',
    description: 'Cost ledger and long-term drag',
    icon: 'cash',
  },
  {
    id: 'wealth',
    label: 'Wealth statement',
    description: 'Assets, liabilities, ownership',
    icon: 'portfolio',
  },
  {
    id: 'tax',
    label: 'Tax appendix',
    description: 'Realized lots, dividends, missing basis',
    icon: 'document',
  },
];

function ReportsTab({
  privateMode,
  defaultScope,
  announce,
}: {
  privateMode: boolean;
  defaultScope: string;
  announce: (message: string) => void;
}) {
  const [selectedModules, setSelectedModules] = useState<Set<ReportModuleId>>(
    new Set(['performance', 'contribution', 'exposure', 'income', 'fees']),
  );
  const [reportPeriod, setReportPeriod] = useState('YTD · 2026');
  const [reportScope, setReportScope] = useState(defaultScope);
  const [format, setFormat] = useState<'PDF' | 'CSV'>('PDF');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [cadence, setCadence] = useState('Quarterly');
  const [accountantEmail, setAccountantEmail] = useState('lena@steuerkanzlei.at');
  const [accountantState, setAccountantState] = useState<'none' | 'pending' | 'active'>('none');
  const [lastExport, setLastExport] = useState<string | null>(null);

  useEffect(() => {
    setReportScope(defaultScope);
  }, [defaultScope]);

  function toggleModule(id: ReportModuleId) {
    setSelectedModules((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function useTemplate(template: 'investor' | 'accountant' | 'wealth') {
    const next: Record<typeof template, ReportModuleId[]> = {
      investor: ['performance', 'contribution', 'exposure', 'income', 'fees'],
      accountant: ['performance', 'income', 'fees', 'tax'],
      wealth: ['performance', 'exposure', 'wealth', 'income'],
    };
    setSelectedModules(new Set(next[template]));
    announce(
      `${template === 'investor' ? 'Investor update' : template === 'accountant' ? 'Tax package' : 'Wealth statement'} template applied`,
    );
  }

  function exportReport() {
    const stamp = new Intl.DateTimeFormat('en-IE', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
    setLastExport(`BT-REPORT-2026-0727 · ${stamp}`);
    announce(`${format} report generated locally`);
  }

  function shareWithAccountant() {
    if (!accountantEmail.trim()) return;
    setAccountantState('pending');
    announce(`Accountant access invitation sent to ${accountantEmail}`);
  }

  return (
    <div className="oa-tab-panel oa-reports">
      <section className="oa-report-hero">
        <span>
          <small>REPORT STUDIO</small>
          <h2>Build one accountable view for any audience.</h2>
          <p>
            Select modules, scope, period, and delivery. Every reported figure keeps its calculation
            and source lineage.
          </p>
        </span>
        <div>
          {[
            ['investor', 'Investor update', 'Performance + exposure', 'activity'],
            ['accountant', 'Tax package', 'Income + lots + fees', 'document'],
            ['wealth', 'Wealth statement', 'Assets + liabilities', 'portfolio'],
          ].map(([id, label, description, icon]) => (
            <button
              key={id}
              onClick={() => useTemplate(id as 'investor' | 'accountant' | 'wealth')}
              type="button"
            >
              <Icon name={icon as IconName} size={16} />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              <Icon name="arrow-right" size={12} />
            </button>
          ))}
        </div>
      </section>

      <div className="oa-report-studio">
        <aside className="oa-report-builder">
          <section>
            <header>
              <small>01 · CONTENT</small>
              <strong>Report modules</strong>
              <em>{selectedModules.size} selected</em>
            </header>
            <div className="oa-report-modules">
              {reportModules.map((module) => {
                const active = selectedModules.has(module.id);
                return (
                  <button
                    aria-pressed={active}
                    className={active ? 'is-active' : undefined}
                    key={module.id}
                    onClick={() => toggleModule(module.id)}
                    type="button"
                  >
                    <i>
                      <Icon name={module.icon} size={14} />
                    </i>
                    <span>
                      <strong>{module.label}</strong>
                      <small>{module.description}</small>
                    </span>
                    <em>{active ? <Icon name="check" size={11} /> : null}</em>
                  </button>
                );
              })}
            </div>
          </section>
          <section>
            <header>
              <small>02 · BOUNDARY</small>
              <strong>Scope & period</strong>
            </header>
            <div className="oa-report-fields">
              <label>
                Portfolio scope
                <select
                  onChange={(event) => setReportScope(event.target.value)}
                  value={reportScope}
                >
                  <option>Personal wealth</option>
                  <option>All wealth</option>
                  <option>Northstar Studio</option>
                  <option>Riverside property</option>
                </select>
              </label>
              <label>
                Reporting period
                <select
                  onChange={(event) => setReportPeriod(event.target.value)}
                  value={reportPeriod}
                >
                  <option>YTD · 2026</option>
                  <option>Full year · 2025</option>
                  <option>Trailing 12 months</option>
                  <option>Since inception</option>
                </select>
              </label>
              <label>
                Output
                <Segment
                  ariaLabel="Report output format"
                  onChange={setFormat}
                  options={[
                    { id: 'PDF', label: 'PDF' },
                    { id: 'CSV', label: 'CSV pack' },
                  ]}
                  value={format}
                />
              </label>
            </div>
          </section>
        </aside>

        <main className="oa-report-preview">
          <header>
            <span>
              <small>LIVE PREVIEW</small>
              <strong>{reportScope}</strong>
              <em>{reportPeriod}</em>
            </span>
            <span>
              <Icon name="shield" size={12} /> Source-checked snapshot · not independently attested
            </span>
          </header>
          <div className="oa-report-paper">
            <header>
              <span className="oa-report-logo">
                <i>B</i>
                <i>T</i>
              </span>
              <span>
                <small>BETTERTRACK WEALTH WORKSPACE</small>
                <strong>{reportScope}</strong>
                <em>{reportPeriod} · EUR · Generated 27 July 2026</em>
              </span>
              <span>
                <small>REPORT VALUE</small>
                <strong>
                  <Money privateMode={privateMode} value={284920} />
                </strong>
              </span>
            </header>
            <div className="oa-report-summary">
              <span>
                <small>Performance</small>
                <strong className="is-positive">+8.42%</strong>
              </span>
              <span>
                <small>Net contributions</small>
                <strong>
                  <Money privateMode={privateMode} value={12400} />
                </strong>
              </span>
              <span>
                <small>Income</small>
                <strong>
                  <Money privateMode={privateMode} value={1834} />
                </strong>
              </span>
              <span>
                <small>Annualized fees</small>
                <strong>0.41%</strong>
              </span>
            </div>
            {selectedModules.has('performance') ? (
              <section className="oa-report-chart">
                <span>
                  <small>PORTFOLIO PERFORMANCE</small>
                  <strong>Value and net invested</strong>
                </span>
                <svg preserveAspectRatio="none" viewBox="0 0 700 150">
                  <g className="oa-chart-grid">
                    {[20, 60, 100, 140].map((y) => (
                      <line key={y} x1="0" x2="700" y1={y} y2={y} />
                    ))}
                  </g>
                  <path d="M0 132 L35 127 L70 129 L105 119 L140 112 L175 115 L210 101 L245 95 L280 99 L315 83 L350 77 L385 81 L420 65 L455 69 L490 49 L525 55 L560 39 L595 43 L630 27 L665 31 L700 18" />
                  <path d="M0 138 L140 126 L280 109 L420 89 L560 67 L700 47" />
                </svg>
              </section>
            ) : null}
            <div className="oa-report-mini-modules">
              {reportModules
                .filter((module) => selectedModules.has(module.id) && module.id !== 'performance')
                .slice(0, 4)
                .map((module, index) => (
                  <section key={module.id}>
                    <Icon name={module.icon} size={13} />
                    <small>{module.label}</small>
                    <strong>
                      {index === 0
                        ? '26.8% Technology'
                        : index === 1
                          ? '€2,946 forecast'
                          : index === 2
                            ? '0.41% annual'
                            : '7 verified sections'}
                    </strong>
                    <span>
                      <i style={{ width: `${76 - index * 11}%` }} />
                    </span>
                  </section>
                ))}
            </div>
            <footer>
              <span>Private financial report · BetterTrack</span>
              <span>
                Sources and methodology attached · Page 1 of {Math.max(2, selectedModules.size)}
              </span>
            </footer>
          </div>
          <footer className="oa-report-export">
            <span>
              {lastExport ? (
                <>
                  <Icon name="check" size={13} />
                  <span>
                    <strong>Report ready</strong>
                    <small>{lastExport}</small>
                  </span>
                </>
              ) : (
                <>
                  <Icon name="document" size={13} />
                  <span>
                    <strong>{selectedModules.size} modules</strong>
                    <small>
                      Approx. {Math.max(2, selectedModules.size)} pages · source appendix included
                    </small>
                  </span>
                </>
              )}
            </span>
            <button disabled={selectedModules.size === 0} onClick={exportReport} type="button">
              <Icon name="download" size={13} />
              Generate {format}
            </button>
          </footer>
        </main>
      </div>

      <div className="oa-two-column oa-two-column--delivery">
        <section className="oa-module oa-report-schedule">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>DELIVERY</small>
              <h2>Scheduled reporting</h2>
              <p>Generate the current studio configuration on a recurring cadence.</p>
            </div>
            <button
              aria-pressed={scheduleEnabled}
              className={cx('oa-toggle', scheduleEnabled && 'is-on')}
              onClick={() => {
                setScheduleEnabled(!scheduleEnabled);
                announce(
                  scheduleEnabled ? 'Report schedule paused' : 'Quarterly report schedule enabled',
                );
              }}
              type="button"
            >
              <i />
            </button>
          </header>
          <div className={cx('oa-schedule-settings', !scheduleEnabled && 'is-disabled')}>
            <label>
              Cadence
              <select
                disabled={!scheduleEnabled}
                onChange={(event) => setCadence(event.target.value)}
                value={cadence}
              >
                <option>Monthly</option>
                <option>Quarterly</option>
                <option>Yearly</option>
              </select>
            </label>
            <label>
              Delivery
              <select disabled={!scheduleEnabled}>
                <option>In-app + email</option>
                <option>In-app only</option>
                <option>Google Drive</option>
              </select>
            </label>
            <span>
              <Icon name="calendar" size={14} />
              <span>
                <small>NEXT RUN</small>
                <strong>{scheduleEnabled ? `01 Oct 2026 · ${cadence}` : 'Schedule is off'}</strong>
              </span>
            </span>
          </div>
        </section>

        <section className="oa-module oa-accountant-access">
          <header className="oa-module-heading oa-module-heading--compact">
            <div>
              <small>CONTROLLED ACCESS</small>
              <h2>Accountant workspace</h2>
              <p>Share reports and tax evidence without granting portfolio write access.</p>
            </div>
            <span
              className={cx(
                'oa-access-status',
                accountantState === 'active' && 'is-active',
                accountantState === 'pending' && 'is-pending',
              )}
            >
              {accountantState === 'none'
                ? 'Not shared'
                : accountantState === 'pending'
                  ? 'Invitation pending'
                  : 'Active'}
            </span>
          </header>
          {accountantState === 'none' ? (
            <div className="oa-access-form">
              <label>
                Accountant email
                <input
                  onChange={(event) => setAccountantEmail(event.target.value)}
                  type="email"
                  value={accountantEmail}
                />
              </label>
              <div>
                <span>
                  <Icon name="eye" size={13} />
                  View reports and attached evidence
                </span>
                <span>
                  <Icon name="lock" size={13} />
                  No trades, cash, settings, or sharing
                </span>
              </div>
              <button
                disabled={!accountantEmail.trim()}
                onClick={shareWithAccountant}
                type="button"
              >
                <Icon name="user-plus" size={13} /> Invite accountant
              </button>
            </div>
          ) : (
            <div className="oa-access-person">
              <span>LB</span>
              <span>
                <strong>{accountantEmail}</strong>
                <small>
                  {accountantState === 'pending'
                    ? 'Invitation sent · expires in 7 days'
                    : 'Report viewer · last active today'}
                </small>
              </span>
              <button
                onClick={() => {
                  setAccountantState(accountantState === 'pending' ? 'active' : 'none');
                  announce(
                    accountantState === 'pending'
                      ? 'Accountant acceptance simulated'
                      : 'Accountant access revoked',
                  );
                }}
                type="button"
              >
                {accountantState === 'pending' ? 'Simulate acceptance' : 'Revoke'}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function OriginAnalytics({
  privateMode,
  scopeName,
  onOpenWorkbench,
  onToast,
}: OriginAnalyticsProps) {
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('xray');
  const [period, setPeriod] = useState<AnalyticsPeriod>('5Y');
  const [benchmark, setBenchmark] = useState('MSCI ACWI');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function announce(message: string) {
    setNotice(message);
    onToast?.(message);
  }

  function openWorkbench(context: string) {
    onOpenWorkbench?.(context);
    announce('Scenario opened as an editable Workbench draft');
  }

  const activeMeta = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]!;

  return (
    <div className="origin-analytics">
      <header className="oa-page-header">
        <h1>Analytics</h1>
        <div className="oa-page-header__actions">
          <button
            className="oa-source-health"
            onClick={() => announce('Analytics source lineage opened')}
            type="button"
          >
            <i />
            <span>
              <small>DATA COVERAGE</small>
              <strong>98.7% · 2 notes</strong>
            </span>
            <Icon name="chevron-right" size={12} />
          </button>
          <button
            className="oa-header-button"
            onClick={() => announce('Analytics view exported')}
            type="button"
          >
            <Icon name="download" size={14} /> Export view
          </button>
        </div>
      </header>

      <section className="oa-context-bar">
        <label>
          <span>Benchmark</span>
          <select onChange={(event) => setBenchmark(event.target.value)} value={benchmark}>
            <option>MSCI ACWI</option>
            <option>FTSE All-World</option>
            <option>Euro Stoxx 600</option>
            <option>None</option>
          </select>
        </label>
        <span className="oa-context-divider" />
        <div className="oa-periods" aria-label="Analytics period">
          {(['1Y', '3Y', '5Y', 'MAX'] as AnalyticsPeriod[]).map((range) => (
            <button
              aria-pressed={period === range}
              className={period === range ? 'is-active' : undefined}
              key={range}
              onClick={() => setPeriod(range)}
              type="button"
            >
              {range}
            </button>
          ))}
        </div>
        <span className="oa-context-status">
          <Icon name="refresh" size={12} />
          Snapshot 27 Jul · market close
        </span>
      </section>

      <nav aria-label="Analytics sections" className="oa-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            aria-controls={`oa-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'is-active' : undefined}
            id={`oa-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            <Icon name={tab.icon} size={15} />
            <span>
              <strong>{tab.label}</strong>
              <small>{tab.description}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="oa-active-context">
        <span>
          <Icon name={activeMeta.icon} size={13} />
          <strong>{activeMeta.label}</strong>
          <em>{activeMeta.description}</em>
        </span>
        <span>
          {scopeName} · {period} · {benchmark}
        </span>
      </div>

      <div
        aria-labelledby="oa-tab-xray"
        hidden={activeTab !== 'xray'}
        id="oa-panel-xray"
        role="tabpanel"
      >
        <XRayTab privateMode={privateMode} />
      </div>
      <div
        aria-labelledby="oa-tab-risk"
        hidden={activeTab !== 'risk'}
        id="oa-panel-risk"
        role="tabpanel"
      >
        <RiskTab openWorkbench={openWorkbench} period={period} privateMode={privateMode} />
      </div>
      <div
        aria-labelledby="oa-tab-fees"
        hidden={activeTab !== 'fees'}
        id="oa-panel-fees"
        role="tabpanel"
      >
        <FeesTab announce={announce} openWorkbench={openWorkbench} privateMode={privateMode} />
      </div>
      <div
        aria-labelledby="oa-tab-income"
        hidden={activeTab !== 'income'}
        id="oa-panel-income"
        role="tabpanel"
      >
        <IncomeTab announce={announce} privateMode={privateMode} />
      </div>
      <div
        aria-labelledby="oa-tab-reports"
        hidden={activeTab !== 'reports'}
        id="oa-panel-reports"
        role="tabpanel"
      >
        <ReportsTab announce={announce} defaultScope={scopeName} privateMode={privateMode} />
      </div>

      {notice ? (
        <div className="oa-toast" role="status">
          <Icon name="check" size={13} /> {notice}
        </div>
      ) : null}
    </div>
  );
}
