import { useEffect, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-data-management.css';

type DataTab = 'overview' | 'backups' | 'exports' | 'retention';
type DataHome = 'hosted' | 'drive' | 'local';
type BackupDestination = 'bettertrack' | 'drive' | 'device';
type ExportFormat = 'json' | 'csv' | 'portable';
type ExportDestination = 'device' | 'drive';

type Snapshot = {
  id: string;
  at: string;
  reason: string;
  destination: BackupDestination;
  size: string;
  records: number;
  status: 'verified' | 'creating';
};

type ExportReceipt = {
  id: string;
  at: string;
  format: ExportFormat;
  destination: ExportDestination;
  modules: string[];
  size: string;
};

type DataState = {
  automaticBackups: boolean;
  backupCadence: 'daily' | 'weekly' | 'monthly';
  backupDestination: BackupDestination;
  snapshots: Snapshot[];
  exports: ExportReceipt[];
  retention: {
    audit: 'forever' | '10-years' | '7-years' | '3-years';
    deletedFiles: '30-days' | '90-days' | '1-year';
    requestLogs: '30-days' | '90-days' | '1-year';
    keepLocalManifest: boolean;
  };
};

export type OriginDataManagementProps = {
  portfolio: { id: string; name: string };
  dataHome: DataHome;
  driveConnected: boolean;
  onClose: () => void;
  onOpenConnections: () => void;
  onOpenImport: () => void;
  onToast?: (message: string) => void;
};

const tabs: Array<{ id: DataTab; label: string; description: string; icon: IconName }> = [
  { id: 'overview', label: 'Overview', description: 'Health and ownership', icon: 'activity' },
  { id: 'backups', label: 'Backups', description: 'Snapshots and restore', icon: 'database' },
  { id: 'exports', label: 'Exports', description: 'Portable copies', icon: 'download' },
  { id: 'retention', label: 'Retention', description: 'Lifecycle policies', icon: 'clock' },
];

const backupLabels: Record<BackupDestination, string> = {
  bettertrack: 'BetterTrack encrypted vault',
  drive: 'Google Drive',
  device: 'This device',
};

function safeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function storageKey(portfolioId: string) {
  return `bt-origin-data-management-v1-${safeKey(portfolioId) || 'portfolio'}`;
}

function initialState(dataHome: DataHome): DataState {
  return {
    automaticBackups: true,
    backupCadence: 'daily',
    backupDestination: dataHome === 'drive' ? 'drive' : 'bettertrack',
    snapshots: [
      {
        id: 'BT-SNAP-0727-0415',
        at: '27 Jul 2026 · 04:15',
        reason: 'Automatic daily checkpoint',
        destination: dataHome === 'drive' ? 'drive' : 'bettertrack',
        size: '18.4 MB',
        records: 2847,
        status: 'verified',
      },
      {
        id: 'BT-SNAP-0726-0415',
        at: '26 Jul 2026 · 04:15',
        reason: 'Automatic daily checkpoint',
        destination: dataHome === 'drive' ? 'drive' : 'bettertrack',
        size: '18.2 MB',
        records: 2839,
        status: 'verified',
      },
      {
        id: 'BT-SNAP-0724-1842',
        at: '24 Jul 2026 · 18:42',
        reason: 'Before Parqet reconciliation',
        destination: 'device',
        size: '17.9 MB',
        records: 2811,
        status: 'verified',
      },
    ],
    exports: [],
    retention: {
      audit: 'forever',
      deletedFiles: '90-days',
      requestLogs: '90-days',
      keepLocalManifest: true,
    },
  };
}

function readState(portfolioId: string, dataHome: DataHome): DataState {
  const fallback = initialState(dataHome);
  try {
    const stored = window.localStorage.getItem(storageKey(portfolioId));
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) as Partial<DataState>;
    return {
      ...fallback,
      ...parsed,
      retention: { ...fallback.retention, ...parsed.retention },
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : fallback.snapshots,
      exports: Array.isArray(parsed.exports) ? parsed.exports : fallback.exports,
    };
  } catch {
    return fallback;
  }
}

function Pill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'warning';
}) {
  return <span className={`odm-pill odm-pill--${tone}`}>{children}</span>;
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={`odm-toggle ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <i />
    </button>
  );
}

export function OriginDataManagement({
  portfolio,
  dataHome,
  driveConnected,
  onClose,
  onOpenConnections,
  onOpenImport,
  onToast,
}: OriginDataManagementProps) {
  const [activeTab, setActiveTab] = useState<DataTab>('overview');
  const [state, setState] = useState<DataState>(() => readState(portfolio.id, dataHome));
  const [notice, setNotice] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreReceipt, setRestoreReceipt] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('portable');
  const [exportDestination, setExportDestination] = useState<ExportDestination>('device');
  const [exportModules, setExportModules] = useState([
    'Portfolio structure',
    'Holdings and valuations',
    'Activity ledger',
    'Documents and evidence',
  ]);
  const [exportBusy, setExportBusy] = useState(false);
  const [lastExport, setLastExport] = useState<ExportReceipt | null>(null);
  const workspaceDialogRef = useAccessibleDialog<HTMLDivElement>({
    open: true,
    onClose,
  });
  const restoreDialogRef = useAccessibleDialog<HTMLElement>({
    open: restoreId !== null,
    onClose: () => setRestoreId(null),
  });

  useEffect(() => {
    const next = readState(portfolio.id, dataHome);
    setState(next);
    setRestoreId(null);
    setRestoreReceipt(null);
  }, [dataHome, portfolio.id]);

  useEffect(() => {
    window.localStorage.setItem(storageKey(portfolio.id), JSON.stringify(state));
  }, [portfolio.id, state]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const announce = (message: string) => {
    setNotice(message);
    onToast?.(message);
  };

  const selectedSnapshot = state.snapshots.find((snapshot) => snapshot.id === restoreId);
  const protectedRecords = useMemo(
    () => state.snapshots.reduce((maximum, snapshot) => Math.max(maximum, snapshot.records), 0),
    [state.snapshots],
  );

  const createSnapshot = () => {
    if (snapshotBusy) return;
    setSnapshotBusy(true);
    window.setTimeout(() => {
      const snapshot: Snapshot = {
        id: `BT-SNAP-0727-${String(530 + state.snapshots.length).padStart(4, '0')}`,
        at: '27 Jul 2026 · just now',
        reason: 'Manual safety checkpoint',
        destination: state.backupDestination,
        size: '18.5 MB',
        records: 2854,
        status: 'verified',
      };
      setState((current) => ({ ...current, snapshots: [snapshot, ...current.snapshots] }));
      setSnapshotBusy(false);
      announce('Encrypted snapshot created and verified.');
    }, 850);
  };

  const completeRestore = () => {
    if (!selectedSnapshot || !restoreConfirmed) return;
    const receipt = `BT-RESTORE-${selectedSnapshot.id.slice(-4)}-0727`;
    setRestoreReceipt(receipt);
    setRestoreConfirmed(false);
    announce('Restore simulation completed without changing live portfolio data.');
  };

  const toggleExportModule = (module: string) => {
    setExportModules((current) =>
      current.includes(module) ? current.filter((item) => item !== module) : [...current, module],
    );
  };

  const buildExport = () => {
    if (!exportModules.length || exportBusy) return;
    if (exportDestination === 'drive' && !driveConnected) {
      announce('Connect Google Drive before choosing it as an export destination.');
      return;
    }
    setExportBusy(true);
    window.setTimeout(() => {
      const receipt: ExportReceipt = {
        id: `BT-EXPORT-2026-${String(state.exports.length + 1042).padStart(4, '0')}`,
        at: '27 Jul 2026 · just now',
        format: exportFormat,
        destination: exportDestination,
        modules: exportModules,
        size: exportFormat === 'csv' ? '3.8 MB' : '18.7 MB',
      };
      setState((current) => ({ ...current, exports: [receipt, ...current.exports].slice(0, 12) }));
      setLastExport(receipt);
      setExportBusy(false);
      announce('Portable portfolio export prepared.');
    }, 900);
  };

  const downloadManifest = (receipt: ExportReceipt) => {
    const payload = {
      product: 'BetterTrack Origin demo',
      portfolio,
      receipt,
      generatedAt: '2026-07-27T05:30:00+02:00',
      note: 'This demo manifest contains no real financial data.',
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeKey(portfolio.name)}-${receipt.id.toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    announce('Demo export manifest downloaded.');
  };

  const dataHomeLabel =
    dataHome === 'hosted'
      ? 'BetterTrack hosted'
      : dataHome === 'drive'
        ? 'Google Drive data home'
        : 'Local-first workspace';

  return (
    <div
      aria-label="Data management"
      aria-modal="true"
      className="odm-shell"
      data-accessible-dialog-layer
      ref={workspaceDialogRef}
      role="dialog"
      tabIndex={-1}
    >
      {notice ? (
        <div className="odm-notice" role="status">
          <Icon name="check" size={14} />
          {notice}
        </div>
      ) : null}

      <header className="odm-topbar">
        <div className="odm-brand">
          <span>
            <Icon name="database" size={17} />
          </span>
          <div>
            <strong>Data management</strong>
            <small>{portfolio.name}</small>
          </div>
        </div>
        <div className="odm-topbar__status">
          <Pill tone="positive">
            <i />
            Protected
          </Pill>
          <button aria-label="Close data management" onClick={onClose} type="button">
            <Icon name="x" size={18} />
          </button>
        </div>
      </header>

      <div className="odm-layout">
        <aside className="odm-navigation">
          <div>
            <span>Portfolio data</span>
            <strong>{portfolio.name}</strong>
            <small>{dataHomeLabel}</small>
          </div>
          <nav aria-label="Data management sections" role="tablist">
            {tabs.map((tab) => (
              <button
                aria-controls={`odm-panel-${tab.id}`}
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? 'is-active' : undefined}
                id={`odm-tab-${tab.id}`}
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
          <section>
            <Icon name="shield" size={15} />
            <p>
              Every snapshot, export, and restore attempt creates an attributable portfolio audit
              event.
            </p>
          </section>
        </aside>

        <main className="odm-main">
          <section
            aria-labelledby="odm-tab-overview"
            hidden={activeTab !== 'overview'}
            id="odm-panel-overview"
            role="tabpanel"
          >
            <header className="odm-page-header">
              <div>
                <span className="odm-eyebrow">Ownership and resilience</span>
                <h1>Your data has one understandable lifecycle.</h1>
                <p>
                  See what owns the source of truth, where recoverable copies live, and which
                  decisions still need attention.
                </p>
              </div>
              <button
                className="odm-button odm-button--primary"
                onClick={createSnapshot}
                type="button"
              >
                <Icon name={snapshotBusy ? 'refresh' : 'plus'} size={14} />
                {snapshotBusy ? 'Creating…' : 'Create snapshot'}
              </button>
            </header>

            <div className="odm-summary">
              <div>
                <span>Data home</span>
                <strong>{dataHomeLabel}</strong>
                <small>Primary writable source</small>
              </div>
              <div>
                <span>Protected records</span>
                <strong>{protectedRecords.toLocaleString('en-IE')}</strong>
                <small>Across holdings, activity, and files</small>
              </div>
              <div>
                <span>Last checkpoint</span>
                <strong>Today, 04:15</strong>
                <small>Verified automatically</small>
              </div>
              <div>
                <span>Recovery target</span>
                <strong>&lt; 15 minutes</strong>
                <small>Preview before every restore</small>
              </div>
            </div>

            <section className="odm-health">
              <header className="odm-section-header">
                <div>
                  <span>System map</span>
                  <h2>Four layers, one portfolio</h2>
                </div>
                <Pill tone="positive">All critical layers healthy</Pill>
              </header>
              <div className="odm-health-table">
                {[
                  {
                    icon: 'portfolio' as IconName,
                    name: 'Portfolio ledger',
                    description: 'Holdings, cash, activities, nesting, and calculation history',
                    owner: dataHomeLabel,
                    coverage: '2,146 records',
                    status: 'Current',
                    action: onOpenImport,
                    actionLabel: 'Reconcile',
                  },
                  {
                    icon: 'document' as IconName,
                    name: 'Evidence library',
                    description: 'Statements, contracts, tax files, links, and versions',
                    owner: driveConnected ? 'Drive + BetterTrack index' : dataHomeLabel,
                    coverage: '6 files · 15 links',
                    status: '3 reviews',
                    action: () =>
                      announce('Open the portfolio Files tab to resolve evidence reviews.'),
                    actionLabel: 'Review',
                  },
                  {
                    icon: 'link' as IconName,
                    name: 'Connected sources',
                    description: 'Banks, brokers, Drive, Parqet, and application access',
                    owner: 'Portfolio-scoped permissions',
                    coverage: '4 healthy · 1 offline',
                    status: 'Attention',
                    action: onOpenConnections,
                    actionLabel: 'Manage',
                  },
                  {
                    icon: 'database' as IconName,
                    name: 'Recovery copies',
                    description: 'Encrypted checkpoints with checksum verification',
                    owner: backupLabels[state.backupDestination],
                    coverage: `${state.snapshots.length} retained`,
                    status: 'Protected',
                    action: () => setActiveTab('backups'),
                    actionLabel: 'Inspect',
                  },
                ].map((item) => (
                  <article key={item.name}>
                    <span className="odm-health-table__icon">
                      <Icon name={item.icon} size={16} />
                    </span>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.description}</small>
                    </div>
                    <div>
                      <span>Owner</span>
                      <strong>{item.owner}</strong>
                    </div>
                    <div>
                      <span>Coverage</span>
                      <strong>{item.coverage}</strong>
                    </div>
                    <Pill
                      tone={
                        item.status === 'Attention' || item.status.includes('review')
                          ? 'warning'
                          : 'positive'
                      }
                    >
                      {item.status}
                    </Pill>
                    <button onClick={item.action} type="button">
                      {item.actionLabel}
                      <Icon name="arrow-right" size={12} />
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <div className="odm-two-column">
              <section className="odm-module">
                <header className="odm-section-header">
                  <div>
                    <span>Recent protection</span>
                    <h2>Latest checkpoints</h2>
                  </div>
                  <button onClick={() => setActiveTab('backups')} type="button">
                    View all
                  </button>
                </header>
                <div className="odm-compact-list">
                  {state.snapshots.slice(0, 3).map((snapshot) => (
                    <button
                      key={snapshot.id}
                      onClick={() => {
                        setRestoreId(snapshot.id);
                        setActiveTab('backups');
                      }}
                      type="button"
                    >
                      <Icon name="check" size={13} />
                      <span>
                        <strong>{snapshot.at}</strong>
                        <small>{snapshot.reason}</small>
                      </span>
                      <em>{snapshot.size}</em>
                      <Icon name="chevron-right" size={13} />
                    </button>
                  ))}
                </div>
              </section>
              <section className="odm-module odm-portability">
                <span className="odm-eyebrow">No lock-in</span>
                <h2>Take a complete, documented copy whenever you want.</h2>
                <p>
                  Portable bundles preserve IDs, portfolio nesting, calculations, links, and a
                  human-readable manifest.
                </p>
                <button
                  className="odm-button"
                  onClick={() => setActiveTab('exports')}
                  type="button"
                >
                  Build an export
                  <Icon name="arrow-right" size={13} />
                </button>
              </section>
            </div>
          </section>

          <section
            aria-labelledby="odm-tab-backups"
            hidden={activeTab !== 'backups'}
            id="odm-panel-backups"
            role="tabpanel"
          >
            <header className="odm-page-header">
              <div>
                <span className="odm-eyebrow">Recoverability</span>
                <h1>Backups you can understand before you need them.</h1>
                <p>
                  Checkpoint the portfolio, verify integrity, and preview exactly what a restore
                  would replace.
                </p>
              </div>
              <button
                className="odm-button odm-button--primary"
                onClick={createSnapshot}
                type="button"
              >
                <Icon name={snapshotBusy ? 'refresh' : 'plus'} size={14} />
                {snapshotBusy ? 'Creating…' : 'Create snapshot'}
              </button>
            </header>

            <section className="odm-policy-strip">
              <div>
                <span>
                  <Icon name="repeat" size={15} />
                </span>
                <div>
                  <strong>Automatic backups</strong>
                  <small>After verified writes and on the configured schedule</small>
                </div>
                <Toggle
                  checked={state.automaticBackups}
                  label="Automatic backups"
                  onChange={(automaticBackups) =>
                    setState((current) => ({ ...current, automaticBackups }))
                  }
                />
              </div>
              <label>
                <span>Cadence</span>
                <select
                  disabled={!state.automaticBackups}
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      backupCadence: event.target.value as DataState['backupCadence'],
                    }))
                  }
                  value={state.backupCadence}
                >
                  <option value="daily">Daily · 04:15</option>
                  <option value="weekly">Weekly · Sunday</option>
                  <option value="monthly">Monthly · first day</option>
                </select>
              </label>
              <label>
                <span>Destination</span>
                <select
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      backupDestination: event.target.value as BackupDestination,
                    }))
                  }
                  value={state.backupDestination}
                >
                  <option value="bettertrack">BetterTrack encrypted vault</option>
                  <option value="drive">Google Drive</option>
                  <option value="device">This device</option>
                </select>
              </label>
            </section>

            {state.backupDestination === 'drive' && !driveConnected ? (
              <section className="odm-inline-warning">
                <Icon name="link" size={15} />
                <div>
                  <strong>Google Drive is not connected.</strong>
                  <small>The schedule is saved, but checkpoints cannot be written there yet.</small>
                </div>
                <button onClick={onOpenConnections} type="button">
                  Connect Drive
                </button>
              </section>
            ) : null}

            <section className="odm-module odm-snapshots">
              <header className="odm-section-header">
                <div>
                  <span>Recovery points</span>
                  <h2>{state.snapshots.length} retained snapshots</h2>
                </div>
                <small>Checksums verified after every write</small>
              </header>
              <div className="odm-snapshot-table">
                <div className="odm-snapshot-table__head">
                  <span>Checkpoint</span>
                  <span>Destination</span>
                  <span>Coverage</span>
                  <span>Status</span>
                  <span />
                </div>
                {state.snapshots.map((snapshot) => (
                  <article key={snapshot.id}>
                    <div>
                      <span className="odm-snapshot-icon">
                        <Icon name="database" size={15} />
                      </span>
                      <span>
                        <strong>{snapshot.at}</strong>
                        <small>
                          {snapshot.reason} · {snapshot.id}
                        </small>
                      </span>
                    </div>
                    <span>{backupLabels[snapshot.destination]}</span>
                    <span>
                      {snapshot.records.toLocaleString('en-IE')} records · {snapshot.size}
                    </span>
                    <Pill tone="positive">
                      <i />
                      Verified
                    </Pill>
                    <button
                      onClick={() => {
                        setRestoreId(snapshot.id);
                        setRestoreReceipt(null);
                        setRestoreConfirmed(false);
                      }}
                      type="button"
                    >
                      Preview restore
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </section>

          <section
            aria-labelledby="odm-tab-exports"
            hidden={activeTab !== 'exports'}
            id="odm-panel-exports"
            role="tabpanel"
          >
            <header className="odm-page-header">
              <div>
                <span className="odm-eyebrow">Portability</span>
                <h1>Your portfolio should never be trapped here.</h1>
                <p>
                  Create an attributable copy for analysis, migration, accounting, or long-term
                  safekeeping.
                </p>
              </div>
            </header>

            <div className="odm-export-layout">
              <section className="odm-module odm-export-builder">
                <header className="odm-section-header">
                  <div>
                    <span>Export builder</span>
                    <h2>Choose what leaves the workspace</h2>
                  </div>
                </header>
                <fieldset>
                  <legend>Included data</legend>
                  {[
                    ['Portfolio structure', 'Names, nesting, ownership, and base currencies'],
                    ['Holdings and valuations', 'Lots, prices, cost basis, and valuation history'],
                    ['Activity ledger', 'Trades, transfers, cash flows, imports, and audit IDs'],
                    [
                      'Documents and evidence',
                      'Files, versions, checksums, links, and annotations',
                    ],
                    ['Collaboration and access', 'People, roles, proposals, and approval receipts'],
                    ['Automation definitions', 'Rules, schedules, safeguards, and run history'],
                  ].map(([module, description]) => (
                    <label key={module}>
                      <input
                        checked={exportModules.includes(module!)}
                        onChange={() => toggleExportModule(module!)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{module}</strong>
                        <small>{description}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="odm-export-fields">
                  <label>
                    <span>Format</span>
                    <select
                      onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                      value={exportFormat}
                    >
                      <option value="portable">BetterTrack portable bundle</option>
                      <option value="json">Structured JSON</option>
                      <option value="csv">CSV workbook</option>
                    </select>
                  </label>
                  <label>
                    <span>Destination</span>
                    <select
                      onChange={(event) =>
                        setExportDestination(event.target.value as ExportDestination)
                      }
                      value={exportDestination}
                    >
                      <option value="device">Download to this device</option>
                      <option value="drive">Save to Google Drive</option>
                    </select>
                  </label>
                </div>
                <section className="odm-export-impact">
                  <Icon name="shield" size={15} />
                  <p>
                    Secrets, API credentials, and active session tokens are never included.
                    Personally identifiable collaborator fields stay excluded unless explicitly
                    selected.
                  </p>
                </section>
                <footer>
                  <span>{exportModules.length} data modules selected</span>
                  <button
                    className="odm-button odm-button--primary"
                    disabled={!exportModules.length || exportBusy}
                    onClick={buildExport}
                    type="button"
                  >
                    <Icon name={exportBusy ? 'refresh' : 'download'} size={14} />
                    {exportBusy ? 'Preparing…' : 'Prepare export'}
                  </button>
                </footer>
              </section>

              <aside className="odm-export-preview">
                {lastExport ? (
                  <>
                    <span className="odm-export-preview__success">
                      <Icon name="check" size={19} />
                    </span>
                    <small>Export ready</small>
                    <h2>{lastExport.id}</h2>
                    <p>
                      A portable copy of {portfolio.name} was prepared without changing the source
                      portfolio.
                    </p>
                    <dl>
                      <div>
                        <dt>Format</dt>
                        <dd>{lastExport.format.toUpperCase()}</dd>
                      </div>
                      <div>
                        <dt>Modules</dt>
                        <dd>{lastExport.modules.length}</dd>
                      </div>
                      <div>
                        <dt>Size</dt>
                        <dd>{lastExport.size}</dd>
                      </div>
                      <div>
                        <dt>Destination</dt>
                        <dd>
                          {lastExport.destination === 'device' ? 'This device' : 'Google Drive'}
                        </dd>
                      </div>
                    </dl>
                    <button
                      className="odm-button"
                      onClick={() => downloadManifest(lastExport)}
                      type="button"
                    >
                      <Icon name="download" size={14} />
                      Download demo manifest
                    </button>
                  </>
                ) : (
                  <>
                    <span>
                      <Icon name="download" size={21} />
                    </span>
                    <small>Portable by design</small>
                    <h2>One bundle, with context intact.</h2>
                    <p>
                      The final product would stream the generated archive. This demo prepares and
                      downloads its manifest.
                    </p>
                    <ul>
                      <li>
                        <Icon name="check" size={12} /> Stable IDs and schema version
                      </li>
                      <li>
                        <Icon name="check" size={12} /> Human-readable data dictionary
                      </li>
                      <li>
                        <Icon name="check" size={12} /> Checksums and provenance
                      </li>
                    </ul>
                  </>
                )}
              </aside>
            </div>

            {state.exports.length ? (
              <section className="odm-module odm-export-history">
                <header className="odm-section-header">
                  <div>
                    <span>Audit history</span>
                    <h2>Recent exports</h2>
                  </div>
                </header>
                {state.exports.map((receipt) => (
                  <article key={receipt.id}>
                    <Icon name="document" size={15} />
                    <span>
                      <strong>{receipt.id}</strong>
                      <small>
                        {receipt.at} · {receipt.modules.length} modules · {receipt.size}
                      </small>
                    </span>
                    <Pill>{receipt.format.toUpperCase()}</Pill>
                    <button onClick={() => downloadManifest(receipt)} type="button">
                      Manifest
                    </button>
                  </article>
                ))}
              </section>
            ) : null}
          </section>

          <section
            aria-labelledby="odm-tab-retention"
            hidden={activeTab !== 'retention'}
            id="odm-panel-retention"
            role="tabpanel"
          >
            <header className="odm-page-header">
              <div>
                <span className="odm-eyebrow">Lifecycle policy</span>
                <h1>Keep what matters. Explain every deletion.</h1>
                <p>
                  Retention applies per portfolio and never silently removes the immutable audit
                  evidence for an active financial record.
                </p>
              </div>
            </header>

            <section className="odm-module odm-retention">
              <header className="odm-section-header">
                <div>
                  <span>Portfolio policy</span>
                  <h2>Retention windows</h2>
                </div>
                <Pill>Applies to {portfolio.name}</Pill>
              </header>
              {[
                {
                  icon: 'list' as IconName,
                  title: 'Portfolio audit trail',
                  description:
                    'Confirmed writes, imports, approvals, access changes, and calculations',
                  value: state.retention.audit,
                  options: [
                    ['forever', 'Keep forever'],
                    ['10-years', '10 years'],
                    ['7-years', '7 years'],
                    ['3-years', '3 years'],
                  ],
                  set: (value: string) =>
                    setState((current) => ({
                      ...current,
                      retention: {
                        ...current.retention,
                        audit: value as DataState['retention']['audit'],
                      },
                    })),
                },
                {
                  icon: 'document' as IconName,
                  title: 'Archived and deleted files',
                  description: 'Recoverable evidence after a user archives or deletes a file',
                  value: state.retention.deletedFiles,
                  options: [
                    ['30-days', '30 days'],
                    ['90-days', '90 days'],
                    ['1-year', '1 year'],
                  ],
                  set: (value: string) =>
                    setState((current) => ({
                      ...current,
                      retention: {
                        ...current.retention,
                        deletedFiles: value as DataState['retention']['deletedFiles'],
                      },
                    })),
                },
                {
                  icon: 'code' as IconName,
                  title: 'Developer request logs',
                  description: 'API, OAuth, MCP, and webhook request metadata—never secrets',
                  value: state.retention.requestLogs,
                  options: [
                    ['30-days', '30 days'],
                    ['90-days', '90 days'],
                    ['1-year', '1 year'],
                  ],
                  set: (value: string) =>
                    setState((current) => ({
                      ...current,
                      retention: {
                        ...current.retention,
                        requestLogs: value as DataState['retention']['requestLogs'],
                      },
                    })),
                },
              ].map((policy) => (
                <article key={policy.title}>
                  <span>
                    <Icon name={policy.icon} size={16} />
                  </span>
                  <div>
                    <strong>{policy.title}</strong>
                    <small>{policy.description}</small>
                  </div>
                  <select
                    aria-label={`${policy.title} retention`}
                    onChange={(event) => policy.set(event.target.value)}
                    value={policy.value}
                  >
                    {policy.options.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </article>
              ))}
              <article>
                <span>
                  <Icon name="download" size={16} />
                </span>
                <div>
                  <strong>Keep a local manifest after export</strong>
                  <small>
                    Retain receipt ID, checksum, modules, and destination in the audit log
                  </small>
                </div>
                <Toggle
                  checked={state.retention.keepLocalManifest}
                  label="Keep a local manifest after export"
                  onChange={(keepLocalManifest) =>
                    setState((current) => ({
                      ...current,
                      retention: { ...current.retention, keepLocalManifest },
                    }))
                  }
                />
              </article>
            </section>

            <section className="odm-residency">
              <span>
                <Icon name="globe" size={18} />
              </span>
              <div>
                <small>Current data boundary</small>
                <h2>{dataHomeLabel}</h2>
                <p>
                  {dataHome === 'hosted'
                    ? 'Portfolio data is hosted in the selected EU region. Portable exports and encrypted Drive copies remain optional.'
                    : dataHome === 'drive'
                      ? 'Google Drive owns the portable data home. BetterTrack keeps the minimum encrypted index needed to operate the workspace.'
                      : 'Portfolio data stays local to this browser profile unless you explicitly export or connect a destination.'}
                </p>
              </div>
              <button onClick={onOpenConnections} type="button">
                Inspect data routes
                <Icon name="arrow-right" size={13} />
              </button>
            </section>
          </section>
        </main>
      </div>

      {selectedSnapshot ? (
        <div
          className="odm-modal-shell"
          data-accessible-dialog-layer
          onMouseDown={() => setRestoreId(null)}
          role="presentation"
        >
          <section
            aria-label="Restore preview"
            aria-modal="true"
            className="odm-modal"
            onMouseDown={(event) => event.stopPropagation()}
            ref={restoreDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div>
                <span className="odm-eyebrow">Safe restore</span>
                <h2>
                  {restoreReceipt
                    ? 'Restore simulation complete'
                    : 'Preview before replacing anything'}
                </h2>
              </div>
              <button
                aria-label="Close restore preview"
                onClick={() => setRestoreId(null)}
                type="button"
              >
                <Icon name="x" size={17} />
              </button>
            </header>
            {restoreReceipt ? (
              <div className="odm-restore-receipt">
                <span>
                  <Icon name="check" size={24} />
                </span>
                <small>Demo restore receipt</small>
                <h3>{restoreReceipt}</h3>
                <p>
                  The full workflow completed against a simulated copy. Live portfolio data was not
                  changed.
                </p>
                <dl>
                  <div>
                    <dt>Source</dt>
                    <dd>{selectedSnapshot.id}</dd>
                  </div>
                  <div>
                    <dt>Integrity</dt>
                    <dd>Checksum verified</dd>
                  </div>
                  <div>
                    <dt>Result</dt>
                    <dd>2,847 records staged</dd>
                  </div>
                </dl>
              </div>
            ) : (
              <>
                <div className="odm-modal__body">
                  <section className="odm-restore-source">
                    <Icon name="database" size={17} />
                    <div>
                      <strong>{selectedSnapshot.at}</strong>
                      <small>
                        {selectedSnapshot.reason} · {selectedSnapshot.id}
                      </small>
                    </div>
                    <Pill tone="positive">Verified</Pill>
                  </section>
                  <div className="odm-restore-comparison">
                    <section>
                      <span>Current portfolio</span>
                      <strong>2,854 records</strong>
                      <small>Includes 7 writes after this checkpoint</small>
                    </section>
                    <Icon name="arrow-right" size={16} />
                    <section>
                      <span>Restored copy</span>
                      <strong>{selectedSnapshot.records.toLocaleString('en-IE')} records</strong>
                      <small>Snapshot from {selectedSnapshot.at}</small>
                    </section>
                  </div>
                  <section className="odm-restore-impact">
                    <strong>What the final restore would do</strong>
                    <ul>
                      <li>
                        <Icon name="refresh" size={12} /> Replace holdings, activity, and portfolio
                        settings
                      </li>
                      <li>
                        <Icon name="check" size={12} /> Preserve this restore request in the audit
                        log
                      </li>
                      <li>
                        <Icon name="database" size={12} /> Create a safety snapshot of the current
                        state first
                      </li>
                    </ul>
                  </section>
                  <label className="odm-confirm">
                    <input
                      checked={restoreConfirmed}
                      onChange={(event) => setRestoreConfirmed(event.target.checked)}
                      type="checkbox"
                    />
                    <span>
                      <strong>Run the restore simulation</strong>
                      <small>I understand this demo does not alter live portfolio state.</small>
                    </span>
                  </label>
                </div>
                <footer>
                  <button className="odm-button" onClick={() => setRestoreId(null)} type="button">
                    Cancel
                  </button>
                  <button
                    className="odm-button odm-button--primary"
                    disabled={!restoreConfirmed}
                    onClick={completeRestore}
                    type="button"
                  >
                    Simulate restore
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
