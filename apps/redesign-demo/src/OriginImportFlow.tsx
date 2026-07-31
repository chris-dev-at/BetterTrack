import { useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import './origin-import-flow.css';

export type OriginImportSource = 'broker' | 'drive' | 'file' | 'api';

export interface OriginImportResult {
  id: string;
  portfolio: string;
  source: OriginImportSource;
  sourceLabel: string;
  importedAt: string;
  counts: {
    discovered: number;
    imported: number;
    skippedDuplicates: number;
    needsReview: number;
  };
  connection: {
    id: string;
    status: 'healthy' | 'attention';
    coverageFrom: string;
    coverageTo: string;
    syncMode: 'transactions' | 'holdings';
    nextSync: string | null;
  };
  undo: {
    available: boolean;
    token: string;
    expiresAt: string;
    operations: number;
  };
}

export interface OriginImportFlowProps {
  portfolio: string;
  onClose: () => void;
  onComplete: (result: OriginImportResult) => void;
}

type FlowStep =
  | 'source'
  | 'connect'
  | 'coverage'
  | 'mapping'
  | 'assets'
  | 'review'
  | 'dry-run'
  | 'receipt';

type MappingValue =
  | 'date'
  | 'type'
  | 'symbol'
  | 'quantity'
  | 'price'
  | 'fees'
  | 'currency'
  | 'ignore';
type ActivityKind = 'Buy' | 'Sell' | 'Dividend' | 'Deposit' | 'Fee';
type AssetDecision = 'matched' | 'custom' | 'ignored' | 'pending';
type IssueDecision = 'pending' | 'skip' | 'import' | 'estimate' | 'replace';

type AssetCandidate = {
  id: string;
  raw: string;
  details: string;
  match: string;
  confidence: number;
  decision: AssetDecision;
};

type ReviewIssue = {
  id: string;
  kind: 'duplicate' | 'basis' | 'conflict';
  title: string;
  detail: string;
  amount: string;
  recommendation: string;
  decision: IssueDecision;
};

const sourceOptions: ReadonlyArray<{
  id: OriginImportSource;
  icon: IconName;
  eyebrow: string;
  title: string;
  description: string;
  meta: string;
}> = [
  {
    id: 'broker',
    icon: 'bank',
    eyebrow: 'Continuous',
    title: 'Broker connection',
    description: 'Connect a supported institution with read-only OAuth and keep activity in sync.',
    meta: 'Trades · cash · income',
  },
  {
    id: 'drive',
    icon: 'folder',
    eyebrow: 'Watched folder',
    title: 'Google Drive',
    description: 'Scan a private statement folder now, then process new files as they appear.',
    meta: 'PDF · CSV · XLSX',
  },
  {
    id: 'file',
    icon: 'upload',
    eyebrow: 'One-time',
    title: 'Statement or CSV',
    description: 'Bring a broker export, bank statement, or your own transaction spreadsheet.',
    meta: 'Local processing preview',
  },
  {
    id: 'api',
    icon: 'code',
    eyebrow: 'Programmable',
    title: 'Import API',
    description: 'Validate a payload from your own app before committing it to this portfolio.',
    meta: 'REST · dry-run · idempotency',
  },
];

const flowSteps: ReadonlyArray<{
  id: FlowStep;
  short: string;
  label: string;
  description: string;
}> = [
  { id: 'source', short: '01', label: 'Source', description: 'Choose how data arrives' },
  { id: 'connect', short: '02', label: 'Connect', description: 'Authorize or select data' },
  { id: 'coverage', short: '03', label: 'Coverage', description: 'Confirm what was found' },
  { id: 'mapping', short: '04', label: 'Map', description: 'Teach BetterTrack the shape' },
  { id: 'assets', short: '05', label: 'Assets', description: 'Resolve security identities' },
  { id: 'review', short: '06', label: 'Review', description: 'Reconcile exceptions' },
  { id: 'dry-run', short: '07', label: 'Dry run', description: 'Preview every change' },
  { id: 'receipt', short: '08', label: 'Receipt', description: 'Audit and undo' },
];

const sourceNames: Record<OriginImportSource, string> = {
  broker: 'Trade Republic',
  drive: 'Google Drive · Finance vault',
  file: 'TR_activity_2021–2026.csv',
  api: 'Personal ledger API',
};

const mappingOptions: ReadonlyArray<{ value: MappingValue; label: string }> = [
  { value: 'date', label: 'Trade date' },
  { value: 'type', label: 'Activity type' },
  { value: 'symbol', label: 'Symbol / ISIN' },
  { value: 'quantity', label: 'Quantity' },
  { value: 'price', label: 'Unit price' },
  { value: 'fees', label: 'Fees & tax' },
  { value: 'currency', label: 'Currency' },
  { value: 'ignore', label: 'Do not import' },
];

const sampleRows = [
  ['2026-07-22', 'Savings plan', 'IE00B4L5Y983', '2.1814', '€119.97', '€0.00'],
  ['2026-07-18', 'Dividend', 'US0378331005', '—', '€21.48', '€5.37'],
  ['2026-07-11', 'Buy', 'US5949181045', '0.4231', '€182.34', '€1.00'],
];

const initialAssets: AssetCandidate[] = [
  {
    id: 'asset-1',
    raw: 'IE00B4L5Y983 · EUNL',
    details: 'iShares Core MSCI World · Xetra · EUR',
    match: 'iShares Core MSCI World UCITS ETF',
    confidence: 100,
    decision: 'matched',
  },
  {
    id: 'asset-2',
    raw: 'US0378331005 · APC',
    details: 'Apple Inc. · NASDAQ · USD',
    match: 'Apple Inc.',
    confidence: 100,
    decision: 'matched',
  },
  {
    id: 'asset-3',
    raw: 'ACME 5.10 29',
    details: 'Acme Corporate Bond · no ISIN in source',
    match: 'No safe catalog match',
    confidence: 38,
    decision: 'pending',
  },
  {
    id: 'asset-4',
    raw: 'CASH · EUR',
    details: 'Broker settlement account',
    match: 'EUR cash position',
    confidence: 100,
    decision: 'matched',
  },
];

const initialIssues: ReviewIssue[] = [
  {
    id: 'issue-1',
    kind: 'duplicate',
    title: 'Four activities already exist',
    detail: 'Same portfolio, date, security, direction, quantity, and amount.',
    amount: '€480.00',
    recommendation: 'Skip exact duplicates',
    decision: 'pending',
  },
  {
    id: 'issue-2',
    kind: 'basis',
    title: 'Opening position has no cost basis',
    detail: '12.4 shares of Microsoft predate the source coverage by 19 months.',
    amount: '€3,864.17',
    recommendation: 'Estimate from first available close',
    decision: 'pending',
  },
  {
    id: 'issue-3',
    kind: 'conflict',
    title: 'One cash balance conflicts',
    detail: 'Source closes at €6,284.19; BetterTrack currently holds €6,259.19.',
    amount: '€25.00',
    recommendation: 'Add reconciliation adjustment',
    decision: 'pending',
  },
];

function statusCopy(decision: AssetDecision) {
  if (decision === 'matched') return 'Catalog match';
  if (decision === 'custom') return 'New custom asset';
  if (decision === 'ignored') return 'Excluded';
  return 'Needs a decision';
}

function sourceActionCopy(source: OriginImportSource) {
  if (source === 'broker') return 'Connect Trade Republic';
  if (source === 'drive') return 'Authorize Google Drive';
  if (source === 'file') return 'Inspect sample statement';
  return 'Validate API payload';
}

function issueBadge(kind: ReviewIssue['kind']) {
  if (kind === 'duplicate') return 'Duplicate';
  if (kind === 'basis') return 'Missing basis';
  return 'Balance conflict';
}

export function OriginImportFlow({ portfolio, onClose, onComplete }: OriginImportFlowProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [source, setSource] = useState<OriginImportSource>('broker');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [provider, setProvider] = useState('Trade Republic');
  const [fileName, setFileName] = useState('TR_activity_2021–2026.csv');
  const [driveAccount, setDriveAccount] = useState('cwiesi@gmail.com');
  const [apiSampleCopied, setApiSampleCopied] = useState(false);
  const [syncMode, setSyncMode] = useState<'transactions' | 'holdings'>('transactions');
  const [includeCash, setIncludeCash] = useState(true);
  const [autoSync, setAutoSync] = useState(true);
  const [columnMap, setColumnMap] = useState<Record<string, MappingValue>>({
    Datum: 'date',
    Typ: 'type',
    ISIN: 'symbol',
    Anzahl: 'quantity',
    Betrag: 'price',
    Gebühren: 'fees',
  });
  const [activityMap, setActivityMap] = useState<Record<string, ActivityKind>>({
    'Savings plan': 'Buy',
    Ausschüttung: 'Dividend',
    Einzahlung: 'Deposit',
    Verkauf: 'Sell',
    Gebühr: 'Fee',
  });
  const [assets, setAssets] = useState<AssetCandidate[]>(initialAssets);
  const [issues, setIssues] = useState<ReviewIssue[]>(initialIssues);
  const [receipt, setReceipt] = useState<OriginImportResult | null>(null);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);

  const step = flowSteps[stepIndex]!;
  const unresolvedAssets = assets.filter((asset) => asset.decision === 'pending').length;
  const unresolvedIssues = issues.filter((issue) => issue.decision === 'pending').length;
  const skippedDuplicates = issues.some(
    (issue) => issue.kind === 'duplicate' && issue.decision === 'skip',
  )
    ? 4
    : 0;
  const importedCount =
    418 - skippedDuplicates - assets.filter((asset) => asset.decision === 'ignored').length;

  const canContinue = useMemo(() => {
    if (step.id === 'connect') return connected;
    if (step.id === 'mapping') {
      const mappedFields = new Set(Object.values(columnMap));
      return ['date', 'type', 'symbol', 'quantity', 'price'].every((field) =>
        mappedFields.has(field as MappingValue),
      );
    }
    if (step.id === 'assets') return unresolvedAssets === 0;
    if (step.id === 'review') return unresolvedIssues === 0;
    return true;
  }, [columnMap, connected, step.id, unresolvedAssets, unresolvedIssues]);

  const connectSource = () => {
    setConnecting(true);
    window.setTimeout(() => {
      setConnecting(false);
      setConnected(true);
    }, 850);
  };

  const selectSource = (nextSource: OriginImportSource) => {
    setSource(nextSource);
    setConnected(false);
    setProvider(nextSource === 'broker' ? 'Trade Republic' : provider);
  };

  const decideAsset = (assetId: string, decision: AssetDecision, match?: string) => {
    setAssets((current) =>
      current.map((asset) =>
        asset.id === assetId
          ? {
              ...asset,
              decision,
              match: match ?? asset.match,
              confidence: decision === 'custom' ? 100 : asset.confidence,
            }
          : asset,
      ),
    );
  };

  const decideIssue = (issueId: string, decision: IssueDecision) => {
    setIssues((current) =>
      current.map((issue) => (issue.id === issueId ? { ...issue, decision } : issue)),
    );
  };

  const applyRecommendations = () => {
    setIssues((current) =>
      current.map((issue) => ({
        ...issue,
        decision:
          issue.kind === 'duplicate' ? 'skip' : issue.kind === 'basis' ? 'estimate' : 'replace',
      })),
    );
  };

  const createReceipt = () => {
    setBusy(true);
    window.setTimeout(() => {
      const importedAt = new Date();
      const expiresAt = new Date(importedAt.getTime() + 24 * 60 * 60 * 1000);
      setReceipt({
        id: `imp_${importedAt.getTime().toString(36)}`,
        portfolio,
        source,
        sourceLabel:
          source === 'broker' ? provider : source === 'file' ? fileName : sourceNames[source],
        importedAt: importedAt.toISOString(),
        counts: {
          discovered: 418,
          imported: importedCount,
          skippedDuplicates,
          needsReview: 0,
        },
        connection: {
          id: `con_${source.slice(0, 2)}_7f2a91`,
          status: 'healthy',
          coverageFrom: '2021-01-04',
          coverageTo: '2026-07-26',
          syncMode,
          nextSync: autoSync && source !== 'file' ? 'Tomorrow, 06:00' : null,
        },
        undo: {
          available: true,
          token: `undo_${Math.random().toString(36).slice(2, 10)}`,
          expiresAt: expiresAt.toISOString(),
          operations: importedCount + 3,
        },
      });
      setBusy(false);
      setStepIndex(flowSteps.length - 1);
    }, 1050);
  };

  const goForward = () => {
    if (!canContinue) return;
    if (step.id === 'dry-run') {
      createReceipt();
      return;
    }
    if (stepIndex < flowSteps.length - 1) setStepIndex((current) => current + 1);
  };

  const goBack = () => {
    if (stepIndex > 0 && step.id !== 'receipt') setStepIndex((current) => current - 1);
  };

  const finish = () => {
    if (!receipt) return;
    onComplete({
      ...receipt,
      counts: undone ? { ...receipt.counts, imported: 0 } : receipt.counts,
      undo: { ...receipt.undo, available: !undone },
    });
  };

  const downloadReceipt = () => {
    if (!receipt) return;
    const payload = JSON.stringify(
      {
        demo: true,
        receipt: {
          ...receipt,
          counts: undone ? { ...receipt.counts, imported: 0 } : receipt.counts,
          undo: { ...receipt.undo, available: !undone },
        },
        notice: 'Fictional BetterTrack Origin import receipt.',
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${receipt.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyApiSample = async () => {
    const sample = `{
  "idempotency_key": "ledger-2026-q3",
  "mode": "transactions",
  "activities": [ /* 418 records */ ]
}`;
    try {
      await navigator.clipboard.writeText(sample);
    } catch {
      // Clipboard access can be unavailable in a local preview; the visible state still
      // demonstrates the completed copy action.
    }
    setApiSampleCopied(true);
    window.setTimeout(() => setApiSampleCopied(false), 1800);
  };

  return (
    <div className="origin-import-overlay" role="presentation">
      <section
        aria-describedby="origin-import-context"
        aria-labelledby="origin-import-title"
        aria-modal="true"
        className="origin-import-flow"
        role="dialog"
      >
        <header className="origin-import-header">
          <div className="origin-import-header__mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="origin-import-header__copy">
            <span className="origin-import-kicker">Portfolio intake</span>
            <h1 id="origin-import-title">Import into {portfolio}</h1>
            <p id="origin-import-context">
              Preview, reconcile, and account for every change before it reaches your source of
              truth.
            </p>
          </div>
          <div className="origin-import-header__actions">
            <span className="origin-import-autosave">
              <span className="origin-import-live-dot" />
              Draft saved
            </span>
            <button
              aria-label="Close import"
              className="origin-import-icon-button"
              onClick={onClose}
              type="button"
            >
              <Icon name="x" size={17} />
            </button>
          </div>
        </header>

        <div className="origin-import-workspace">
          <aside aria-label="Import progress" className="origin-import-rail">
            <div className="origin-import-rail__intro">
              <span>Import blueprint</span>
              <strong>{Math.round((stepIndex / (flowSteps.length - 1)) * 100)}%</strong>
            </div>
            <div className="origin-import-progress">
              <span style={{ width: `${(stepIndex / (flowSteps.length - 1)) * 100}%` }} />
            </div>
            <ol>
              {flowSteps.map((item, index) => {
                const state =
                  index < stepIndex ? 'complete' : index === stepIndex ? 'active' : 'upcoming';
                return (
                  <li className={`origin-import-step origin-import-step--${state}`} key={item.id}>
                    <button
                      aria-current={state === 'active' ? 'step' : undefined}
                      disabled={index > stepIndex || step.id === 'receipt'}
                      onClick={() => setStepIndex(index)}
                      type="button"
                    >
                      <span className="origin-import-step__number">
                        {state === 'complete' ? <Icon name="check" size={12} /> : item.short}
                      </span>
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="origin-import-rail__trust">
              <Icon name="shield" size={15} />
              <div>
                <strong>Nothing changes early</strong>
                <span>Only the final confirmed plan can write to your portfolio.</span>
              </div>
            </div>
          </aside>

          <main className="origin-import-stage">
            <div className="origin-import-stage__head">
              <div>
                <span className="origin-import-kicker">
                  Step {stepIndex + 1} of {flowSteps.length}
                </span>
                <h2>
                  {step.id === 'source' && 'Where is this data coming from?'}
                  {step.id === 'connect' && 'Connect the source'}
                  {step.id === 'coverage' && 'Confirm the coverage'}
                  {step.id === 'mapping' && 'Map source language to portfolio data'}
                  {step.id === 'assets' && 'Resolve asset identities'}
                  {step.id === 'review' && 'Reconcile what needs judgment'}
                  {step.id === 'dry-run' && 'Review the write plan'}
                  {step.id === 'receipt' &&
                    (undone ? 'Import reversed cleanly' : 'Import complete')}
                </h2>
              </div>
              {stepIndex > 1 && step.id !== 'receipt' ? (
                <div className="origin-import-context-chip">
                  <span className="origin-import-source-glyph">
                    <Icon
                      name={
                        sourceOptions.find((option) => option.id === source)?.icon ?? 'database'
                      }
                      size={15}
                    />
                  </span>
                  <span>
                    <small>Source</small>
                    <strong>{source === 'broker' ? provider : sourceNames[source]}</strong>
                  </span>
                </div>
              ) : null}
            </div>

            <div className="origin-import-stage__body">
              {step.id === 'source' ? (
                <section className="origin-import-source-grid">
                  {sourceOptions.map((option) => (
                    <button
                      aria-pressed={source === option.id}
                      className={`origin-import-source ${source === option.id ? 'is-selected' : ''}`}
                      key={option.id}
                      onClick={() => selectSource(option.id)}
                      type="button"
                    >
                      <span className="origin-import-source__top">
                        <span className="origin-import-source__icon">
                          <Icon name={option.icon} size={20} />
                        </span>
                        <span className="origin-import-source__check">
                          {source === option.id ? <Icon name="check" size={12} /> : null}
                        </span>
                      </span>
                      <span className="origin-import-kicker">{option.eyebrow}</span>
                      <strong>{option.title}</strong>
                      <p>{option.description}</p>
                      <small>{option.meta}</small>
                    </button>
                  ))}
                  <div className="origin-import-inline-note">
                    <Icon name="lock" size={15} />
                    <span>
                      <strong>Private by default.</strong> Imported data inherits {portfolio}’s
                      access and collaboration rules.
                    </span>
                  </div>
                </section>
              ) : null}

              {step.id === 'connect' ? (
                <section className="origin-import-connect">
                  <div className="origin-import-connect__primary">
                    <div className="origin-import-section-label">
                      <span>Source setup</span>
                      <small>Simulated connection</small>
                    </div>

                    {source === 'broker' ? (
                      <>
                        <label className="origin-import-field">
                          <span>Institution</span>
                          <select
                            value={provider}
                            onChange={(event) => setProvider(event.target.value)}
                          >
                            <option>Trade Republic</option>
                            <option>Interactive Brokers</option>
                            <option>flatex</option>
                            <option>George / Erste</option>
                          </select>
                        </label>
                        <div className="origin-import-consent">
                          <div className="origin-import-brand-avatar">TR</div>
                          <div>
                            <strong>{provider} will share read-only data</strong>
                            <p>
                              BetterTrack can read accounts, trades, cash movements, income, and
                              statement metadata. It cannot place trades or withdraw funds.
                            </p>
                          </div>
                        </div>
                      </>
                    ) : null}

                    {source === 'drive' ? (
                      <>
                        <div className="origin-import-account-row">
                          <div className="origin-import-brand-avatar origin-import-brand-avatar--google">
                            G
                          </div>
                          <div>
                            <strong>{driveAccount}</strong>
                            <span>Choose a folder; BetterTrack never scans the rest of Drive.</span>
                          </div>
                          <button
                            className="origin-import-text-button"
                            onClick={() =>
                              setDriveAccount((current) =>
                                current === 'cwiesi@gmail.com'
                                  ? 'alex.morgan@example.com'
                                  : 'cwiesi@gmail.com',
                              )
                            }
                            type="button"
                          >
                            Switch account
                          </button>
                        </div>
                        <label className="origin-import-field">
                          <span>Watched folder</span>
                          <div className="origin-import-input-with-icon">
                            <Icon name="folder" size={15} />
                            <input readOnly value="/Investing/Statements" />
                          </div>
                        </label>
                      </>
                    ) : null}

                    {source === 'file' ? (
                      <>
                        <label className="origin-import-dropzone">
                          <input
                            accept=".csv,.xlsx,.pdf"
                            onChange={(event) =>
                              setFileName(event.currentTarget.files?.[0]?.name ?? fileName)
                            }
                            type="file"
                          />
                          <span className="origin-import-dropzone__icon">
                            <Icon name="upload" size={22} />
                          </span>
                          <strong>Drop a statement here or choose a file</strong>
                          <span>CSV, XLSX, and searchable PDF · up to 50 MB</span>
                          <small>Demo ready: {fileName}</small>
                        </label>
                        <div className="origin-import-file-row">
                          <Icon name="document" size={17} />
                          <div>
                            <strong>{fileName}</strong>
                            <span>
                              482 rows · modified 26 Jul 2026 · SHA verified after selection
                            </span>
                          </div>
                          <span className="origin-import-state origin-import-state--blue">
                            Ready
                          </span>
                        </div>
                      </>
                    ) : null}

                    {source === 'api' ? (
                      <>
                        <label className="origin-import-field">
                          <span>Preview endpoint</span>
                          <div className="origin-import-code-input">
                            <em>POST</em>
                            <input readOnly value="/v1/portfolios/pf_personal/imports/preview" />
                          </div>
                        </label>
                        <div className="origin-import-code-sample">
                          <div>
                            <span>request.json</span>
                            <button onClick={copyApiSample} type="button">
                              <Icon name={apiSampleCopied ? 'check' : 'copy'} size={13} />
                              {apiSampleCopied ? 'Copied' : 'Copy'}
                            </button>
                          </div>
                          <pre>{`{
  "idempotency_key": "ledger-2026-q3",
  "mode": "transactions",
  "activities": [ /* 418 records */ ]
}`}</pre>
                        </div>
                      </>
                    ) : null}

                    <button
                      className="origin-import-button origin-import-button--primary origin-import-connect-button"
                      disabled={connecting || connected}
                      onClick={connectSource}
                      type="button"
                    >
                      {connecting ? (
                        <>
                          <span className="origin-import-spinner" /> Checking source…
                        </>
                      ) : connected ? (
                        <>
                          <Icon name="check" size={15} /> Source connected
                        </>
                      ) : (
                        <>
                          <Icon name={source === 'file' ? 'search' : 'link'} size={15} />
                          {sourceActionCopy(source)}
                        </>
                      )}
                    </button>
                  </div>

                  <aside className="origin-import-connect__aside">
                    <div className="origin-import-section-label">
                      <span>Before you continue</span>
                    </div>
                    <ul className="origin-import-check-list">
                      <li>
                        <Icon name="check" size={13} />
                        Source remains the original record
                      </li>
                      <li>
                        <Icon name="check" size={13} />
                        Duplicate protection is always on
                      </li>
                      <li>
                        <Icon name="check" size={13} />
                        You approve ambiguous data manually
                      </li>
                      <li>
                        <Icon name="check" size={13} />
                        Final write receives an undo token
                      </li>
                    </ul>
                    <div className={`origin-import-scan ${connected ? 'is-complete' : ''}`}>
                      <span className="origin-import-scan__pulse">
                        <Icon name={connected ? 'check' : 'shield'} size={16} />
                      </span>
                      <div>
                        <strong>
                          {connected ? 'Source verified' : 'Waiting for authorization'}
                        </strong>
                        <span>
                          {connected
                            ? 'Identity, schema, and file integrity checks passed.'
                            : 'No data has been transferred yet.'}
                        </span>
                      </div>
                    </div>
                  </aside>
                </section>
              ) : null}

              {step.id === 'coverage' ? (
                <section className="origin-import-coverage">
                  <div className="origin-import-health-banner">
                    <span className="origin-import-health-banner__icon">
                      <Icon name="check" size={17} />
                    </span>
                    <div>
                      <span className="origin-import-kicker">Connection health</span>
                      <h3>Complete source, healthy chronology</h3>
                      <p>
                        418 activities form a continuous ledger from 4 Jan 2021 through 26 Jul 2026.
                        Timestamps, currencies, and identifiers parsed successfully.
                      </p>
                    </div>
                    <span className="origin-import-state origin-import-state--green">
                      <span /> Healthy
                    </span>
                  </div>

                  <div className="origin-import-metrics">
                    <div>
                      <span>Activities found</span>
                      <strong>418</strong>
                      <small>+39 since last snapshot</small>
                    </div>
                    <div>
                      <span>Coverage</span>
                      <strong>5y 6m</strong>
                      <small>04 Jan 2021 → 26 Jul 2026</small>
                    </div>
                    <div>
                      <span>Assets referenced</span>
                      <strong>27</strong>
                      <small>4 asset classes · 3 currencies</small>
                    </div>
                    <div>
                      <span>Source closing value</span>
                      <strong>€184,628.41</strong>
                      <small>As of 26 Jul, 22:00 CEST</small>
                    </div>
                  </div>

                  <div className="origin-import-coverage-grid">
                    <div className="origin-import-coverage-main">
                      <div className="origin-import-section-label">
                        <span>Coverage timeline</span>
                        <small>What is present and what is not</small>
                      </div>
                      <div className="origin-import-timeline">
                        <div className="origin-import-timeline__labels">
                          <span>Jan ’21</span>
                          <span>Jan ’22</span>
                          <span>Jan ’23</span>
                          <span>Jan ’24</span>
                          <span>Jan ’25</span>
                          <span>Jul ’26</span>
                        </div>
                        <div className="origin-import-timeline__track">
                          <span className="origin-import-timeline__complete" />
                          <i style={{ left: '9%' }} />
                          <i style={{ left: '28%' }} />
                          <i style={{ left: '51%' }} />
                          <i style={{ left: '76%' }} />
                          <i style={{ left: '94%' }} />
                        </div>
                        <div className="origin-import-timeline__legend">
                          <span>
                            <i /> Transaction coverage
                          </span>
                          <span>
                            <b /> Statement boundary
                          </span>
                        </div>
                      </div>
                      <div className="origin-import-breakdown">
                        {[
                          ['Trades', '196', '46.9%'],
                          ['Cash transfers', '92', '22.0%'],
                          ['Income', '71', '17.0%'],
                          ['Fees & tax', '59', '14.1%'],
                        ].map(([label, count, width]) => (
                          <div key={label}>
                            <span>{label}</span>
                            <span className="origin-import-breakdown__bar">
                              <i style={{ width }} />
                            </span>
                            <strong>{count}</strong>
                          </div>
                        ))}
                      </div>
                    </div>
                    <aside className="origin-import-options">
                      <div className="origin-import-section-label">
                        <span>Import behavior</span>
                      </div>
                      <label
                        className={`origin-import-choice ${syncMode === 'transactions' ? 'is-selected' : ''}`}
                      >
                        <input
                          checked={syncMode === 'transactions'}
                          name="sync-mode"
                          onChange={() => setSyncMode('transactions')}
                          type="radio"
                        />
                        <span>
                          <strong>Build full ledger</strong>
                          <small>Best history, performance, tax lots, and scenario accuracy.</small>
                        </span>
                      </label>
                      <label
                        className={`origin-import-choice ${syncMode === 'holdings' ? 'is-selected' : ''}`}
                      >
                        <input
                          checked={syncMode === 'holdings'}
                          name="sync-mode"
                          onChange={() => setSyncMode('holdings')}
                          type="radio"
                        />
                        <span>
                          <strong>Current holdings only</strong>
                          <small>Faster start, but historical returns remain partial.</small>
                        </span>
                      </label>
                      <label className="origin-import-toggle-row">
                        <span>
                          <strong>Include cash activity</strong>
                          <small>Deposits, withdrawals, fees, and taxes</small>
                        </span>
                        <input
                          checked={includeCash}
                          onChange={(event) => setIncludeCash(event.target.checked)}
                          type="checkbox"
                        />
                      </label>
                      {source !== 'file' ? (
                        <label className="origin-import-toggle-row">
                          <span>
                            <strong>Keep connection active</strong>
                            <small>Sync changes daily at 06:00</small>
                          </span>
                          <input
                            checked={autoSync}
                            onChange={(event) => setAutoSync(event.target.checked)}
                            type="checkbox"
                          />
                        </label>
                      ) : null}
                    </aside>
                  </div>
                </section>
              ) : null}

              {step.id === 'mapping' ? (
                <section className="origin-import-mapping">
                  <div className="origin-import-saved-map">
                    <span className="origin-import-saved-map__icon">
                      <Icon name="sparkles" size={16} />
                    </span>
                    <div>
                      <strong>Recognized: Trade Republic activity export v4</strong>
                      <span>Saved mapping last used 18 Jun 2026 · 98.7% confidence</span>
                    </div>
                    <button
                      className="origin-import-text-button"
                      onClick={() =>
                        setColumnMap(
                          (current) =>
                            Object.fromEntries(
                              Object.keys(current).map((column) => [column, 'ignore']),
                            ) as Record<string, MappingValue>,
                        )
                      }
                      type="button"
                    >
                      Start blank
                    </button>
                  </div>

                  <div className="origin-import-mapping-grid">
                    <div className="origin-import-map-table-wrap">
                      <div className="origin-import-section-label">
                        <span>Column mapping</span>
                        <small>6 of 6 required fields mapped</small>
                      </div>
                      <div className="origin-import-map-table">
                        <div className="origin-import-map-row origin-import-map-row--head">
                          <span>Source column</span>
                          <span>Example</span>
                          <span>BetterTrack field</span>
                        </div>
                        {(
                          [
                            ['Datum', '22.07.2026'],
                            ['Typ', 'Sparplan'],
                            ['ISIN', 'IE00B4L5Y983'],
                            ['Anzahl', '2,1814'],
                            ['Betrag', '119,97'],
                            ['Gebühren', '0,00'],
                          ] as ReadonlyArray<readonly [string, string]>
                        ).map(([column, example]) => (
                          <label className="origin-import-map-row" key={column}>
                            <strong>{column}</strong>
                            <code>{example}</code>
                            <select
                              onChange={(event) =>
                                setColumnMap((current) => ({
                                  ...current,
                                  [column]: event.target.value as MappingValue,
                                }))
                              }
                              value={columnMap[column]}
                            >
                              {mappingOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                    </div>

                    <aside className="origin-import-activity-map">
                      <div className="origin-import-section-label">
                        <span>Activity language</span>
                        <small>5 source values</small>
                      </div>
                      {Object.entries(activityMap).map(([raw, mapped]) => (
                        <label key={raw}>
                          <span>
                            <code>{raw}</code>
                            <Icon name="arrow-right" size={12} />
                          </span>
                          <select
                            onChange={(event) =>
                              setActivityMap((current) => ({
                                ...current,
                                [raw]: event.target.value as ActivityKind,
                              }))
                            }
                            value={mapped}
                          >
                            {(['Buy', 'Sell', 'Dividend', 'Deposit', 'Fee'] as ActivityKind[]).map(
                              (kind) => (
                                <option key={kind}>{kind}</option>
                              ),
                            )}
                          </select>
                        </label>
                      ))}
                      <div className="origin-import-locale">
                        <span>
                          <small>Date & number locale</small>
                          <strong>German (Austria)</strong>
                        </span>
                        <span>
                          <small>Default currency</small>
                          <strong>EUR</strong>
                        </span>
                      </div>
                    </aside>
                  </div>

                  <div className="origin-import-preview-table">
                    <div className="origin-import-section-label">
                      <span>Normalized preview</span>
                      <small>First 3 of 418 activities</small>
                    </div>
                    <div className="origin-import-preview-table__scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Activity</th>
                            <th>Security</th>
                            <th>Quantity</th>
                            <th>Gross</th>
                            <th>Fees / tax</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sampleRows.map((row) => (
                            <tr key={`${row[0]}-${row[1]}`}>
                              {row.map((value) => (
                                <td key={value}>{value}</td>
                              ))}
                              <td>
                                <span className="origin-import-state origin-import-state--green">
                                  Valid
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              ) : null}

              {step.id === 'assets' ? (
                <section className="origin-import-assets">
                  <div className="origin-import-resolution-summary">
                    <div>
                      <span className="origin-import-resolution-ring">26</span>
                      <span>
                        <strong>26 of 27 assets resolved automatically</strong>
                        <small>
                          Identifiers, venue, currency, and instrument type were cross-checked.
                        </small>
                      </span>
                    </div>
                    <div>
                      <strong>{unresolvedAssets}</strong>
                      <span>decision remaining</span>
                    </div>
                  </div>
                  <div className="origin-import-asset-list">
                    <div className="origin-import-asset-row origin-import-asset-row--head">
                      <span>Source identity</span>
                      <span>BetterTrack identity</span>
                      <span>Confidence</span>
                      <span>Decision</span>
                    </div>
                    {assets.map((asset) => (
                      <div
                        className={`origin-import-asset-row ${asset.decision === 'pending' ? 'is-attention' : ''}`}
                        key={asset.id}
                      >
                        <div>
                          <strong>{asset.raw}</strong>
                          <span>{asset.details}</span>
                        </div>
                        <div className="origin-import-asset-match">
                          <span className="origin-import-asset-avatar">
                            {asset.decision === 'custom' ? 'AB' : asset.raw.slice(0, 2)}
                          </span>
                          <span>
                            <strong>{asset.match}</strong>
                            <small>{statusCopy(asset.decision)}</small>
                          </span>
                        </div>
                        <div className="origin-import-confidence">
                          <span>
                            <i style={{ width: `${asset.confidence}%` }} />
                          </span>
                          <strong>{asset.confidence}%</strong>
                        </div>
                        <div>
                          {asset.decision === 'pending' ? (
                            <div className="origin-import-asset-actions">
                              <button
                                onClick={() =>
                                  decideAsset(asset.id, 'custom', 'Acme Corporate Bond 5.10% 2029')
                                }
                                type="button"
                              >
                                Create asset
                              </button>
                              <button
                                onClick={() => decideAsset(asset.id, 'ignored')}
                                type="button"
                              >
                                Exclude
                              </button>
                            </div>
                          ) : (
                            <button
                              className="origin-import-decision"
                              onClick={() =>
                                decideAsset(asset.id, 'pending', 'No safe catalog match')
                              }
                              type="button"
                            >
                              <Icon
                                name={asset.decision === 'ignored' ? 'minus' : 'check'}
                                size={12}
                              />
                              {statusCopy(asset.decision)}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="origin-import-inline-note origin-import-inline-note--wide">
                    <Icon name="database" size={15} />
                    <span>
                      Asset decisions become reusable aliases. Future files containing{' '}
                      <code>ACME 5.10 29</code> will resolve the same way, and you can edit the
                      alias later.
                    </span>
                  </div>
                </section>
              ) : null}

              {step.id === 'review' ? (
                <section className="origin-import-review">
                  <div className="origin-import-review-head">
                    <div>
                      <strong>{unresolvedIssues} reconciliation decisions</strong>
                      <span>Recommendations preserve the ledger and avoid silent overwrites.</span>
                    </div>
                    <button
                      className="origin-import-button origin-import-button--secondary"
                      onClick={applyRecommendations}
                      type="button"
                    >
                      <Icon name="sparkles" size={14} /> Apply recommendations
                    </button>
                  </div>
                  <div className="origin-import-issue-list">
                    {issues.map((issue) => (
                      <article
                        className={`origin-import-issue ${issue.decision !== 'pending' ? 'is-resolved' : ''}`}
                        key={issue.id}
                      >
                        <div
                          className={`origin-import-issue__signal origin-import-issue__signal--${issue.kind}`}
                        >
                          <Icon
                            name={
                              issue.kind === 'duplicate'
                                ? 'copy'
                                : issue.kind === 'basis'
                                  ? 'pie'
                                  : 'refresh'
                            }
                            size={16}
                          />
                        </div>
                        <div className="origin-import-issue__copy">
                          <span className="origin-import-kicker">{issueBadge(issue.kind)}</span>
                          <h3>{issue.title}</h3>
                          <p>{issue.detail}</p>
                          <span className="origin-import-recommendation">
                            <Icon name="sparkles" size={12} /> Recommended: {issue.recommendation}
                          </span>
                        </div>
                        <strong className="origin-import-issue__amount">{issue.amount}</strong>
                        <div className="origin-import-issue__actions">
                          {issue.kind === 'duplicate' ? (
                            <>
                              <button
                                className={issue.decision === 'skip' ? 'is-selected' : ''}
                                onClick={() => decideIssue(issue.id, 'skip')}
                                type="button"
                              >
                                Skip 4
                              </button>
                              <button
                                className={issue.decision === 'import' ? 'is-selected' : ''}
                                onClick={() => decideIssue(issue.id, 'import')}
                                type="button"
                              >
                                Import anyway
                              </button>
                            </>
                          ) : issue.kind === 'basis' ? (
                            <>
                              <button
                                className={issue.decision === 'estimate' ? 'is-selected' : ''}
                                onClick={() => decideIssue(issue.id, 'estimate')}
                                type="button"
                              >
                                Estimate basis
                              </button>
                              <button
                                className={issue.decision === 'import' ? 'is-selected' : ''}
                                onClick={() => decideIssue(issue.id, 'import')}
                                type="button"
                              >
                                Mark unknown
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className={issue.decision === 'replace' ? 'is-selected' : ''}
                                onClick={() => decideIssue(issue.id, 'replace')}
                                type="button"
                              >
                                Add adjustment
                              </button>
                              <button
                                className={issue.decision === 'skip' ? 'is-selected' : ''}
                                onClick={() => decideIssue(issue.id, 'skip')}
                                type="button"
                              >
                                Keep existing
                              </button>
                            </>
                          )}
                        </div>
                        {issue.decision !== 'pending' ? (
                          <span className="origin-import-issue__resolved">
                            <Icon name="check" size={11} /> Resolved
                          </span>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {step.id === 'dry-run' ? (
                <section className="origin-import-dry-run">
                  <div className="origin-import-plan-hero">
                    <div>
                      <span className="origin-import-plan-hero__icon">
                        <Icon name="shield" size={20} />
                      </span>
                      <div>
                        <span className="origin-import-kicker">Dry run passed</span>
                        <h3>The portfolio reconciles after {importedCount} new activities</h3>
                        <p>
                          No existing activity will be overwritten. Every created object shares one
                          undo token.
                        </p>
                      </div>
                    </div>
                    <span className="origin-import-state origin-import-state--green">
                      Ready to write
                    </span>
                  </div>
                  <div className="origin-import-plan-layout">
                    <div className="origin-import-write-plan">
                      <div className="origin-import-section-label">
                        <span>Write plan</span>
                        <small>Exact operations</small>
                      </div>
                      {[
                        [
                          'Create activities',
                          `${importedCount}`,
                          'Trades, cash, income, fees, and tax',
                        ],
                        ['Create custom assets', '1', 'Acme Corporate Bond 5.10% 2029'],
                        ['Create aliases', '1', 'Reusable source identity mapping'],
                        ['Add cash adjustment', '1', '+€25.00 on 26 Jul 2026'],
                        [
                          'Skip duplicates',
                          `${skippedDuplicates}`,
                          'Existing activities remain untouched',
                        ],
                      ].map(([label, count, detail], index) => (
                        <div className="origin-import-operation" key={label}>
                          <span className={index === 4 ? 'is-muted' : ''}>
                            {index === 4 ? (
                              <Icon name="minus" size={13} />
                            ) : (
                              <Icon name="plus" size={13} />
                            )}
                          </span>
                          <div>
                            <strong>{label}</strong>
                            <small>{detail}</small>
                          </div>
                          <strong>{count}</strong>
                        </div>
                      ))}
                    </div>
                    <aside className="origin-import-reconcile">
                      <div className="origin-import-section-label">
                        <span>Closing reconciliation</span>
                        <small>26 Jul 2026 · EUR</small>
                      </div>
                      <div>
                        <span>Source value</span>
                        <strong>€184,628.41</strong>
                      </div>
                      <div>
                        <span>Portfolio after import</span>
                        <strong>€184,628.41</strong>
                      </div>
                      <div className="origin-import-reconcile__difference">
                        <span>Difference</span>
                        <strong>€0.00</strong>
                      </div>
                      <div className="origin-import-reconcile__check">
                        <Icon name="check" size={14} />
                        Cash, positions, and currencies reconcile
                      </div>
                    </aside>
                  </div>
                  <div className="origin-import-final-notice">
                    <Icon name="lock" size={14} />
                    <span>
                      <strong>One deliberate write.</strong> Running the import creates an audit
                      event and a 24-hour undo window. Connected sources can sync only after this
                      first import succeeds.
                    </span>
                  </div>
                </section>
              ) : null}

              {step.id === 'receipt' && receipt ? (
                <section className={`origin-import-receipt ${undone ? 'is-undone' : ''}`}>
                  <div className="origin-import-receipt-hero">
                    <span className="origin-import-receipt-hero__mark">
                      <Icon name={undone ? 'refresh' : 'check'} size={26} />
                    </span>
                    <span className="origin-import-kicker">
                      {undone ? 'Undo confirmed' : 'Import receipt'}
                    </span>
                    <h3>
                      {undone
                        ? 'The portfolio is back where it started'
                        : `${receipt.counts.imported} activities joined ${portfolio}`}
                    </h3>
                    <p>
                      {undone
                        ? 'Created activities, aliases, and the cash adjustment were removed as one atomic operation.'
                        : 'Your source, decisions, and write results are bundled into a permanent audit record.'}
                    </p>
                  </div>

                  <div className="origin-import-receipt-grid">
                    <div className="origin-import-receipt-details">
                      <div className="origin-import-section-label">
                        <span>Receipt detail</span>
                        <small>{receipt.id}</small>
                      </div>
                      <dl>
                        <div>
                          <dt>Portfolio</dt>
                          <dd>{portfolio}</dd>
                        </div>
                        <div>
                          <dt>Source</dt>
                          <dd>{receipt.sourceLabel}</dd>
                        </div>
                        <div>
                          <dt>Imported</dt>
                          <dd>{undone ? '0 (reversed)' : receipt.counts.imported}</dd>
                        </div>
                        <div>
                          <dt>Skipped duplicates</dt>
                          <dd>{receipt.counts.skippedDuplicates}</dd>
                        </div>
                        <div>
                          <dt>Coverage</dt>
                          <dd>04 Jan 2021 → 26 Jul 2026</dd>
                        </div>
                        <div>
                          <dt>Reconciliation</dt>
                          <dd className="is-positive">Passed · €0.00 difference</dd>
                        </div>
                      </dl>
                      <button
                        className="origin-import-text-button"
                        onClick={downloadReceipt}
                        type="button"
                      >
                        <Icon name="download" size={13} /> Download JSON receipt
                      </button>
                    </div>
                    <aside className="origin-import-undo">
                      <div className="origin-import-section-label">
                        <span>Undo metadata</span>
                        <small>{undone ? 'Consumed' : 'Available for 24 hours'}</small>
                      </div>
                      <div className="origin-import-undo__token">
                        <span>Atomic token</span>
                        <code>{receipt.undo.token}</code>
                      </div>
                      <div className="origin-import-undo__meta">
                        <span>
                          <small>Operations covered</small>
                          <strong>{receipt.undo.operations}</strong>
                        </span>
                        <span>
                          <small>Expires</small>
                          <strong>
                            Tomorrow,{' '}
                            {new Date(receipt.undo.expiresAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </strong>
                        </span>
                      </div>
                      <button
                        className="origin-import-button origin-import-button--danger"
                        disabled={undone}
                        onClick={() => setUndone(true)}
                        type="button"
                      >
                        <Icon name="refresh" size={14} />
                        {undone ? 'Import reversed' : 'Undo entire import'}
                      </button>
                      <p>
                        Undo affects only objects created by this receipt. Later manual edits stay
                        protected.
                      </p>
                    </aside>
                  </div>

                  {!undone && receipt.connection.nextSync ? (
                    <div className="origin-import-next-sync">
                      <span className="origin-import-source-glyph">
                        <Icon name="repeat" size={15} />
                      </span>
                      <div>
                        <strong>Connection is active</strong>
                        <span>
                          Next incremental sync {receipt.connection.nextSync}. New records will use
                          this mapping and still pass duplicate checks.
                        </span>
                      </div>
                      <span className="origin-import-state origin-import-state--green">
                        Healthy
                      </span>
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>

            <footer className="origin-import-footer">
              <div>
                {stepIndex > 0 && step.id !== 'receipt' ? (
                  <button
                    className="origin-import-button origin-import-button--quiet"
                    onClick={goBack}
                    type="button"
                  >
                    <Icon name="arrow-right" size={14} className="origin-import-back-icon" />
                    Back
                  </button>
                ) : (
                  <span className="origin-import-footer__hint">
                    <Icon name="lock" size={12} /> Local demo · no real data leaves this device
                  </span>
                )}
              </div>
              <div>
                {step.id === 'receipt' ? (
                  <>
                    <button
                      className="origin-import-button origin-import-button--secondary"
                      onClick={onClose}
                      type="button"
                    >
                      Close
                    </button>
                    <button
                      className="origin-import-button origin-import-button--primary"
                      onClick={finish}
                      type="button"
                    >
                      {undone ? 'Return to portfolio' : 'View imported portfolio'}
                      <Icon name="arrow-right" size={14} />
                    </button>
                  </>
                ) : (
                  <button
                    className="origin-import-button origin-import-button--primary"
                    disabled={!canContinue || busy}
                    onClick={goForward}
                    type="button"
                  >
                    {busy ? (
                      <>
                        <span className="origin-import-spinner" /> Writing atomic import…
                      </>
                    ) : (
                      <>
                        {step.id === 'dry-run'
                          ? `Run import · ${importedCount} activities`
                          : step.id === 'source'
                            ? 'Set up source'
                            : 'Continue'}
                        <Icon name="arrow-right" size={14} />
                      </>
                    )}
                  </button>
                )}
              </div>
            </footer>
          </main>
        </div>
      </section>
    </div>
  );
}
